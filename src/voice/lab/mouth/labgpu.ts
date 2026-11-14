/**
 * `LabGPUMouth`: the synthesizer on LabGPU's GPU box (lab-gpu, the TTS adapter on :8805, the Supertonic engine behind it) as a `Mouth` for the lab engine.
 *
 *   POST {baseUrl}/tts  {"text": "...", "voice": "af_bella"}
 *     -> 200 application/octet-stream, raw PCM s16le mono 24 kHz, chunked (about ten chunks), first byte 110 to 280 ms after the request, the whole sentence in 140 to 300 ms
 *
 * Measured on the real adapter on 2026-11-13 (docs/VOICE_SELFBUILT.md, section 5.4). Things that matter here:
 *
 * - The adapter IGNORES a `speed` field, so none is ever sent: the engine time-stretches instead (tempo.ts).
 * - A response carrying the header `X-TTS-Fallback` means the adapter's own backend failed and it served the sentence from ElevenLabs: the text has LEFT the
 *   private network and the voice is a stranger's. That audio is thrown away unread and the sentence fails with `MouthError('fallback')`.
 * - The voice `DrBerg` is on the adapter's list and must never be used (it is somebody's voice): refused here, before any request.
 * - Nothing in an error message ever carries the text spoken or a header.
 *
 * This file also holds `streamPcm`, the HTTP-to-PCM part that `aura.ts` shares (both services answer a POST with raw 24 kHz PCM in a stream): the timeouts,
 * the abort, the regrouping into whole 16-bit samples, the WAV unwrapping and the translation of every failure into a MouthError.
 */
import { MouthError, OUT_RATE, type Mouth, type SynthOptions } from '../types.js';

// ---------------------------------------------------------------- the part both mouths share

export interface PcmRequest {
  /** What the messages call the service: 'the TTS adapter', 'Aura'. */
  label: string;
  /** Starts the HTTP request. `signal` drops it. */
  send: (signal: AbortSignal) => Promise<Response>;
  /** A mouth's own look at the head of the answer, before the status is read. Returns the error to throw, if any. */
  checkHead?: (res: Response) => MouthError | undefined;
  /** How long the head (the status line and headers) may take, from the start of the request. `fetch` hides the TCP connect, so this covers it too. */
  connectTimeoutMs: number;
  /** The longest silence accepted: from the start of the request to the first byte of audio, and between two chunks after that. */
  firstByteTimeoutMs: number;
  /** The most time the whole answer may take. Only time spent waiting for the service counts: a slow consumer does not eat it. */
  totalTimeoutMs: number;
  /** The caller's wish to stop (the student spoke, the call ended). Ends the iterator quietly and drops the request. */
  signal?: AbortSignal;
}

type Waiting = 'head' | 'first byte' | 'silence' | 'total';

/** What is used of a body reader (the type of `getReader()` has overloads, one of them for byte-oriented readers, which this is not). */
interface BodyReader {
  read(): Promise<{ done: boolean; value?: unknown }>;
  cancel(): Promise<void>;
}

/** Thrown into a wait when the request has been cancelled, whoever cancelled it. Never leaves this file. */
class Halted extends Error {}

/** Longest WAV header accepted before it is given up on. */
const MAX_WAV_HEADER = 64 * 1024;

const noAudio = (label: string): MouthError => new MouthError('bad-audio', `${label} sent no audio`);
const oddLength = (label: string): MouthError => new MouthError('bad-audio', `${label} sent audio that is not whole 16-bit samples`);

/** Turns the pieces of a body into pieces of whole samples, and unwraps a WAV header if the body starts with one. */
class PcmPieces {
  private state: 'sniff' | 'header' | 'audio' = 'sniff';
  /** Sniff: the first bytes. Header: the header so far. Audio: the odd byte left over from the last piece. */
  private pending: Buffer = Buffer.alloc(0);
  /** A WAV says how many bytes of audio follow; Infinity when it does not (0, 0xFFFFFFFF) or when the body is raw. */
  private dataLeft = Infinity;
  private audioBytes = 0;

  constructor(private readonly label: string) {}

  push(chunk: Buffer): Buffer[] {
    if (chunk.length === 0) return [];
    if (this.state === 'audio') return this.samples(chunk);
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    if (this.state === 'sniff') {
      if (this.pending.length < 4) return [];
      if (this.pending.toString('latin1', 0, 4) !== 'RIFF') {
        const all = this.pending;
        this.pending = Buffer.alloc(0);
        this.state = 'audio';
        return this.samples(all);
      }
      this.state = 'header';
    }
    const found = this.audioStart();
    if (!found) {
      if (this.pending.length > MAX_WAV_HEADER) throw new MouthError('bad-audio', `${this.label} sent a WAV header that never ends`);
      return [];
    }
    const rest = this.pending.subarray(found.offset);
    this.pending = Buffer.alloc(0);
    this.dataLeft = found.size;
    this.state = 'audio';
    return this.samples(rest);
  }

  /** What the end of the body leaves: pieces still to yield (a body of two bytes), and the error if the body was not audio of whole samples. */
  finish(): { pieces: Buffer[]; error?: MouthError } {
    if (this.state === 'sniff') {
      const b = this.pending;
      if (b.length === 0) return { pieces: [], error: noAudio(this.label) };
      const whole = b.subarray(0, b.length & ~1);
      return { pieces: whole.length > 0 ? [whole] : [], error: b.length & 1 ? oddLength(this.label) : undefined };
    }
    if (this.state === 'header') return { pieces: [], error: new MouthError('bad-audio', `${this.label} sent a WAV header that is cut short`) };
    if (this.pending.length > 0) return { pieces: [], error: oddLength(this.label) };
    if (this.audioBytes === 0) return { pieces: [], error: noAudio(this.label) };
    return { pieces: [] };
  }

  /** The audio of `chunk` as whole samples, with an odd last byte kept for the next chunk. Never an empty piece. */
  private samples(chunk: Buffer): Buffer[] {
    let data = chunk;
    if (this.dataLeft !== Infinity) {
      if (data.length > this.dataLeft) data = data.subarray(0, this.dataLeft); // the bytes after the audio (a trailing chunk) are not audio
      this.dataLeft -= data.length;
    }
    if (data.length === 0) return [];
    if (this.pending.length > 0) {
      data = Buffer.concat([this.pending, data]);
      this.pending = Buffer.alloc(0);
    }
    if (data.length & 1) {
      this.pending = Buffer.from(data.subarray(data.length - 1)); // a copy: the piece before it is handed out and must not be written over
      data = data.subarray(0, data.length - 1);
    }
    if (data.length === 0) return [];
    this.audioBytes += data.length;
    return [data];
  }

  /** Walks the chunks of a WAV header until the audio starts. undefined: more of the header is needed. Throws for a WAV that is not 24 kHz mono 16-bit PCM. */
  private audioStart(): { offset: number; size: number } | undefined {
    const b = this.pending;
    if (b.length < 12) return undefined;
    if (b.toString('latin1', 8, 12) !== 'WAVE') throw new MouthError('bad-audio', `${this.label} sent a RIFF that is not a WAVE`);
    let at = 12;
    let formatSeen = false;
    for (;;) {
      if (b.length < at + 8) return undefined;
      const id = b.toString('latin1', at, at + 4);
      const size = b.readUInt32LE(at + 4);
      if (id === 'data') {
        if (!formatSeen) throw new MouthError('bad-audio', `${this.label} sent WAV audio before its format`);
        return { offset: at + 8, size: size === 0 || size === 0xffffffff ? Infinity : size };
      }
      if (id === 'fmt ') {
        if (size < 16) throw new MouthError('bad-audio', `${this.label} sent a WAV format chunk that is too short`);
        if (b.length < at + 8 + 16) return undefined;
        const tag = b.readUInt16LE(at + 8);
        const channels = b.readUInt16LE(at + 10);
        const rate = b.readUInt32LE(at + 12);
        const bits = b.readUInt16LE(at + 22);
        if ((tag !== 1 && tag !== 0xfffe) || channels !== 1 || bits !== 16) throw new MouthError('bad-audio', `${this.label} sent WAV audio that is not 16-bit mono PCM`);
        if (rate !== OUT_RATE) throw new MouthError('bad-audio', `${this.label} sent WAV audio at ${rate} Hz, not ${OUT_RATE}`);
        formatSeen = true;
      }
      at += 8 + size + (size & 1); // a chunk is padded to an even length
      if (at > MAX_WAV_HEADER) throw new MouthError('bad-audio', `${this.label} sent a WAV header that never ends`);
    }
  }
}

/** The fixed part of a failure message: only an error CODE (ECONNREFUSED...) from the cause of a fetch error, never its message, which may hold a URL or a header. */
function causeCode(err: unknown): string | undefined {
  const outer = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = outer?.cause?.code ?? outer?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{3,40}$/.test(code) ? code : undefined;
}

/**
 * Sends the request and yields the audio of the answer as it arrives, in pieces of whole 16-bit samples (never empty).
 *
 * Errors surface from the first `next()` (or later, if the service breaks mid-answer; the caller may then already have audio from this very sentence):
 * `down` for a refused connection, a timeout or an HTTP status other than 200, `bad-audio` for a body that is not PCM (JSON or text, a WAV in another
 * format, no audio at all, an odd number of bytes at the end). Messages hold fixed words, the label, a status code or a number from the options, and nothing else.
 * An abort by `signal` ends the iterator quietly and drops the request at once, also while the consumer is not asking for the next piece.
 */
export async function* streamPcm(req: PcmRequest): AsyncGenerator<Buffer, void, undefined> {
  const caller = req.signal;
  if (caller?.aborted) return;

  const ctl = new AbortController();
  const stop = (): void => ctl.abort();
  caller?.addEventListener('abort', stop, { once: true });
  // Every wait is raced against this, so a cancelled request is dropped at once even if the fetch implementation never errors its body.
  const halted = new Promise<never>((_, reject) => {
    ctl.signal.addEventListener('abort', () => reject(new Halted()), { once: true });
  });
  halted.catch(() => undefined);

  // An object, not a `let`: the timers below set it, and a plain variable assigned only inside a closure is narrowed to `undefined` by the compiler.
  const timed: { out?: Waiting } = {};
  let waited = 0; // milliseconds spent waiting for the service, not for the consumer
  const wait = async <T>(p: Promise<T>, limitMs: number, what: Waiting): Promise<T> => {
    const budget = Math.max(1, req.totalTimeoutMs - waited);
    const started = performance.now();
    const timer = setTimeout(
      () => {
        timed.out ??= budget <= limitMs ? 'total' : what;
        ctl.abort();
      },
      Math.max(1, Math.min(limitMs, budget)),
    );
    try {
      return await Promise.race([p, halted]);
    } finally {
      clearTimeout(timer);
      waited += performance.now() - started;
    }
  };

  let reader: BodyReader | undefined;
  try {
    const res = await wait(req.send(ctl.signal), req.connectTimeoutMs, 'head');
    if (caller?.aborted) return;
    const refused = req.checkHead?.(res);
    if (refused) throw refused;
    if (res.status !== 200) throw new MouthError('down', `${req.label} answered HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type.startsWith('application/json') || type.startsWith('text/')) throw new MouthError('bad-audio', `${req.label} answered with text, not audio`);
    if (!res.body) throw noAudio(req.label);

    reader = res.body.getReader();
    const pieces = new PcmPieces(req.label);
    let first = true;
    for (;;) {
      const next = await wait(reader.read(), first ? Math.max(1, req.firstByteTimeoutMs - waited) : req.firstByteTimeoutMs, first ? 'first byte' : 'silence');
      if (caller?.aborted) return;
      if (next.done) break;
      first = false;
      const value = next.value as Uint8Array;
      for (const piece of pieces.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) {
        yield piece;
        if (caller?.aborted) return;
      }
    }
    const end = pieces.finish();
    for (const piece of end.pieces) {
      yield piece;
      if (caller?.aborted) return;
    }
    if (end.error) throw end.error;
  } catch (err) {
    if (caller?.aborted) return;
    if (err instanceof MouthError) throw err;
    if (timed.out === 'head') throw new MouthError('down', `${req.label} did not answer within ${req.connectTimeoutMs} ms`);
    if (timed.out === 'first byte') throw new MouthError('down', `${req.label} sent no audio within ${req.firstByteTimeoutMs} ms`);
    if (timed.out === 'silence') throw new MouthError('down', `${req.label} went silent for ${req.firstByteTimeoutMs} ms`);
    if (timed.out === 'total') throw new MouthError('down', `${req.label} took longer than ${req.totalTimeoutMs} ms`);
    const code = causeCode(err);
    throw new MouthError('down', `${req.label} is not reachable${code ? ` (${code})` : ''}`);
  } finally {
    caller?.removeEventListener('abort', stop);
    ctl.abort(); // drops the request if it is still going: an early `break` of the consumer, an error, or an abort
    reader?.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- LabGPU's adapter

export interface LabGPUMouthOptions {
  /** The adapter. Default: LabGPU's box. */
  baseUrl?: string;
  /** The head of the answer within this long (default 3000 ms). */
  connectTimeoutMs?: number;
  /** The longest silence: before the first byte, and between chunks (default 8000 ms). */
  firstByteTimeoutMs?: number;
  /** The most the service may take for one sentence, not counting the consumer's own pace (default 30000 ms). */
  totalTimeoutMs?: number;
  /** For tests: another `fetch`. */
  fetchImpl?: typeof fetch;
  /** The voices the engine is configured to ask for. Checked here, so a forbidden or misspelt voice stops the lab at startup instead of in the middle of a call. */
  voices?: readonly string[];
}

/** A voice name that may be sent. Throws a plain Error (not a MouthError: this is a mistake in the settings, not a service that is down) for `DrBerg` and for anything that is not a voice name. */
export function checkLabGPUVoice(voice: string): void {
  if (typeof voice === 'string' && voice.replace(/[^A-Za-z0-9]/g, '').toLowerCase().includes('drberg')) {
    throw new Error('LabGPU TTS: the voice DrBerg is never used');
  }
  if (typeof voice !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(voice)) throw new Error('LabGPU TTS: the voice name is not usable');
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`LabGPUMouth: ${name} must be a positive number`);
  return value;
}

function httpBase(name: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`${name}: baseUrl is not a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError(`${name}: baseUrl must be http or https`);
  return url.replace(/\/+$/, '');
}

export class LabGPUMouth implements Mouth {
  readonly name = 'labgpu';
  /** The adapter ignores `speed`; the engine stretches the audio instead (tempo.ts). */
  readonly takesSpeed = false;
  readonly baseUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly firstByteTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LabGPUMouthOptions = {}) {
    this.baseUrl = httpBase('LabGPUMouth', options.baseUrl ?? 'http://192.0.2.29:8805');
    this.connectTimeoutMs = positive('connectTimeoutMs', options.connectTimeoutMs ?? 3000);
    this.firstByteTimeoutMs = positive('firstByteTimeoutMs', options.firstByteTimeoutMs ?? 8000);
    this.totalTimeoutMs = positive('totalTimeoutMs', options.totalTimeoutMs ?? 30_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    for (const voice of options.voices ?? []) checkLabGPUVoice(voice);
  }

  /** The audio of one sentence. Everything that can go wrong (also a forbidden voice) surfaces from the first `next()`. */
  synthesize(text: string, opts: SynthOptions): AsyncIterable<Buffer> {
    return this.run(text, opts);
  }

  private async *run(text: string, opts: SynthOptions): AsyncGenerator<Buffer, void, undefined> {
    checkLabGPUVoice(opts.voice);
    if (opts.signal?.aborted || !text.trim()) return;
    // `speed` is deliberately not in the body: the adapter ignores it.
    const body = JSON.stringify({ text, voice: opts.voice });
    yield* streamPcm({
      label: 'the TTS adapter',
      send: (signal) => this.fetchImpl(`${this.baseUrl}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }),
      // Checked before the status: the adapter answers 200 with this header when it served the sentence from ElevenLabs, and the text has then left the network.
      checkHead: (res) => (res.headers.has('x-tts-fallback') ? new MouthError('fallback', 'the TTS adapter served a substituted voice') : undefined),
      connectTimeoutMs: this.connectTimeoutMs,
      firstByteTimeoutMs: this.firstByteTimeoutMs,
      totalTimeoutMs: this.totalTimeoutMs,
      signal: opts.signal,
    });
  }
}
