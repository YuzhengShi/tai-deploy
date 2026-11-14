/**
 * A stand-in for LabGPU's TTS adapter (:8805), for tests: an HTTP server on 127.0.0.1 that answers the way the real one was measured to answer on 2026-11-13.
 *
 *   GET  /health  -> {"status":"ok","engine":"supertonic","backend":true,"fallback":"armed"}
 *   GET  /voices  -> the nine voices (the shape of this answer is a guess; nothing in the lab reads it)
 *   POST /tts {"text","voice"} -> 200 application/octet-stream, raw PCM s16le mono 24 kHz, chunked (about 10 chunks), the `speed` field ignored
 *
 * The audio is a deterministic tone whose length follows the number of words and the voice's pace, so a test can build the exact bytes it expects (`pcmFor`).
 * What goes wrong is scripted: the header that says the text went to ElevenLabs, an HTTP error, a stall (before the head, or after it), a first byte that
 * is late, an odd number of bytes, a WAV body, an empty body, the rest of the audio held back until the test lets it go. Every request is recorded.
 *
 * The small pieces at the top (the server shell, the tone, the chunk writer, the WAV builder) are exported for `fake-aura.ts`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { OUT_RATE } from '../types.js';

// ---------------------------------------------------------------- shared pieces

/** A deterministic tone: `samples` 16-bit samples of a sine, starting at sample `startSample`. */
export function tonePcm(samples: number, startSample = 0, frequency = 220, amplitude = 8000): Buffer {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * frequency * (startSample + i)) / OUT_RATE)), 2 * i);
  return out;
}

export interface WavOptions {
  rate?: number;
  channels?: number;
  bits?: number;
  /** A LIST chunk between `fmt ` and `data`, as many encoders write. */
  extraChunk?: boolean;
  /** Sizes of 0xFFFFFFFF (a WAV written to a stream before its length was known). */
  unknownSize?: boolean;
  /** A chunk after the data, which a reader must not take for audio. */
  trailingChunk?: boolean;
}

/** `pcm` inside a RIFF/WAVE header. */
export function wavBytes(pcm: Buffer, o: WavOptions = {}): Buffer {
  const rate = o.rate ?? OUT_RATE;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE((rate * channels * bits) / 8, 16);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const list = o.extraChunk ? Buffer.concat([Buffer.from('LIST', 'latin1'), u32(10), Buffer.from('INFOabcdef', 'latin1')]) : Buffer.alloc(0);
  const dataHead = Buffer.concat([Buffer.from('data', 'latin1'), u32(o.unknownSize ? 0xffffffff : pcm.length)]);
  const trailing = o.trailingChunk ? Buffer.concat([Buffer.from('LIST', 'latin1'), u32(4), Buffer.from('INFO', 'latin1')]) : Buffer.alloc(0);
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), fmt, list, dataHead, pcm, trailing]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32(o.unknownSize ? 0xffffffff : body.length), body]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/** A door that stays open once opened: a response held at it waits for `open()`. */
export class Gate {
  private release: () => void = () => undefined;
  private opened = false;
  readonly promise: Promise<void>;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.opened = true;
    this.release();
  }

  get isOpen(): boolean {
    return this.opened;
  }
}

/** Waits `ms`, or less when `until` settles first. */
export function sleepUnless(ms: number, until: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void until.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** An HTTP server on 127.0.0.1, on a port the system picks. Never a wider address: a test must not be reachable from the network, and must not reach it. */
export class LoopbackServer {
  private readonly server: http.Server;
  private port = 0;

  constructor(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) {
    this.server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Stops listening and drops every connection, also the ones a test left open (a stalled response, a keep-alive socket of the client). */
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
    await closed;
  }
}

export interface ChunkPlan {
  /** Exact size of every chunk but the last (may be odd, to cut samples in two). Otherwise about `chunks` chunks of an even size. */
  chunkBytes?: number;
  chunks: number;
  chunkDelayMs: number;
  /** Send this many chunks, then wait at `gate`. */
  holdAfterChunks?: number;
}

export function splitChunks(body: Buffer, plan: Pick<ChunkPlan, 'chunkBytes' | 'chunks'>): Buffer[] {
  if (body.length === 0) return [];
  const size = plan.chunkBytes ?? Math.max(2, 2 * Math.ceil(body.length / Math.max(1, plan.chunks) / 2));
  const out: Buffer[] = [];
  for (let at = 0; at < body.length; at += size) out.push(body.subarray(at, Math.min(body.length, at + size)));
  return out;
}

/** What `streamChunks` counts, on the request record it is given. */
export interface WriteCounts {
  bytesWritten: number;
  chunksWritten: number;
}

/** Writes the chunks one after the other, with the pause and the hold of the plan; stops when the client has gone. Ends the response when all is sent. */
export async function streamChunks(
  res: http.ServerResponse,
  body: Buffer,
  plan: ChunkPlan,
  gate: Gate,
  gone: Promise<void>,
  isGone: () => boolean,
  counts: WriteCounts,
): Promise<void> {
  const chunks = splitChunks(body, plan);
  for (let i = 0; i < chunks.length; i++) {
    if (plan.holdAfterChunks !== undefined && i === plan.holdAfterChunks) await Promise.race([gate.promise, gone]);
    if (isGone()) return;
    res.write(chunks[i]);
    counts.bytesWritten += chunks[i].length;
    counts.chunksWritten++;
    if (plan.chunkDelayMs > 0 && i < chunks.length - 1) await sleepUnless(plan.chunkDelayMs, gone);
  }
  if (!isGone()) res.end();
}

// ---------------------------------------------------------------- helpers for the tests of the mouths

/**
 * A `fetch` that refuses every address but 127.0.0.1 and records the hosts it refused. A test gives it to a mouth so that a forgotten `baseUrl` cannot
 * reach a real machine (LabGPU's box, Deepgram); the test then checks `blocked` is empty.
 */
export function loopbackOnlyFetch(): { fetchImpl: typeof fetch; blocked: string[] } {
  const blocked: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (host !== '127.0.0.1') {
      blocked.push(host);
      return Promise.reject(new TypeError('test: a request outside 127.0.0.1 was refused'));
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, blocked };
}

/** Every piece an iterable yields, and the error that ended it, if one did. */
export async function drain(source: AsyncIterable<Buffer>): Promise<{ pieces: Buffer[]; error: unknown }> {
  const pieces: Buffer[] = [];
  try {
    for await (const piece of source) pieces.push(piece);
    return { pieces, error: undefined };
  } catch (error) {
    return { pieces, error };
  }
}

/**
 * A `fetch` with no network at all: it answers 200 (or what `init` says) with a body that arrives in exactly these chunks. For the cases a real socket would
 * not keep apart (a WAV header cut at every byte, one-byte chunks), which TCP may glue together on the way.
 */
export function chunkedFetch(chunks: readonly Uint8Array[], init: ResponseInit = {}): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
          controller.close();
        },
      }),
      { status: 200, ...init },
    )) as unknown as typeof fetch;
}

// ---------------------------------------------------------------- the fake

/** How the next answers go wrong, or not. Set for all requests with `fake.behavior`, or for the next ones with `fake.once`. */
export interface FakeTtsBehavior extends ChunkPlan {
  /** The voice's pace: a sentence lasts words / wordsPerSecond. LabGPU's measured 2.69. */
  wordsPerSecond: number;
  /** Wait this long before answering at all (no head yet). */
  headDelayMs: number;
  /** Send the head at once, then wait this long before the first chunk. */
  firstByteDelayMs: number;
  /** Take the request and never answer. */
  stallBeforeHead: boolean;
  /** Send the head, then never a byte. */
  stallAfterHead: boolean;
  /** Add `X-TTS-Fallback` (true: 'elevenlabs'; a string: that value, which may be empty). The audio is still sent, so a test can tell it was thrown away. */
  fallback: boolean | string;
  /** Answer this HTTP status; the body is a JSON error that holds `BODY_MARKER`. */
  status: number;
  /** One byte more than whole samples. */
  oddByte: boolean;
  /** Status 200 and no audio. */
  empty: boolean;
  /** A WAV body instead of raw PCM. */
  wav: false | WavOptions;
  contentType: string;
}

/** Text that is in the body of an error answer; no error message of a mouth may contain it. */
export const BODY_MARKER = 'body-marker-never-repeat-me';

export interface FakeTtsRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** The JSON body as sent. */
  body: Record<string, unknown>;
  text: string;
  voice: string;
  /** Whether a `speed` field arrived: a mouth for this adapter must never send one. */
  hasSpeed: boolean;
  bytesWritten: number;
  chunksWritten: number;
  /** The answer was sent to its end. */
  finished: boolean;
  /** The client left (or the server was closed) before the answer ended. */
  aborted: boolean;
  /** Settles when the connection of this request is closed, either way. */
  closed: Promise<void>;
}

export const LABGPU_VOICES = ['DrBerg', 'af_bella', 'af_heart', 'default', 'ef_dora', 'ff_siwis', 'jf_gongitsune', 'pf_dora', 'zf_xiaobei'];

export class FakeTts {
  behavior: FakeTtsBehavior;
  readonly requests: FakeTtsRequest[] = [];
  readonly healthChecks: number[] = [];
  private gate = new Gate();
  private readonly queue: Array<Partial<FakeTtsBehavior>> = [];
  private readonly http: LoopbackServer;

  private constructor(behavior: Partial<FakeTtsBehavior>) {
    this.behavior = {
      wordsPerSecond: 2.69,
      chunks: 10,
      chunkDelayMs: 0,
      headDelayMs: 0,
      firstByteDelayMs: 0,
      stallBeforeHead: false,
      stallAfterHead: false,
      fallback: false,
      status: 200,
      oddByte: false,
      empty: false,
      wav: false,
      contentType: 'application/octet-stream',
      ...behavior,
    };
    this.http = new LoopbackServer((req, res) => this.handle(req, res));
  }

  static async start(behavior: Partial<FakeTtsBehavior> = {}): Promise<FakeTts> {
    const fake = new FakeTts(behavior);
    await fake.http.listen();
    return fake;
  }

  get url(): string {
    return this.http.url;
  }

  /** The next `times` requests go the way `over` says (on top of `behavior`). */
  once(over: Partial<FakeTtsBehavior>, times = 1): void {
    for (let i = 0; i < times; i++) this.queue.push(over);
  }

  /** Lets requests that are held (`holdAfterChunks`) go on, and any that come to the hold later. */
  release(): void {
    this.gate.open();
  }

  /** Closes the door again, for the next hold. */
  rearm(): void {
    this.gate = new Gate();
  }

  samplesFor(text: string, wordsPerSecond = this.behavior.wordsPerSecond): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round((words / wordsPerSecond) * OUT_RATE));
  }

  /** The audio this fake sends for `text`, to compare with what a mouth yields. */
  pcmFor(text: string, wordsPerSecond = this.behavior.wordsPerSecond): Buffer {
    return tonePcm(this.samplesFor(text, wordsPerSecond));
  }

  async close(): Promise<void> {
    this.gate.open(); // a held answer must be able to end, or the server cannot close
    await this.http.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://fake').pathname;
    if (req.method === 'GET' && path === '/health') {
      this.healthChecks.push(Date.now());
      return sendJson(res, 200, { status: 'ok', engine: 'supertonic', backend: true, fallback: 'armed' });
    }
    if (req.method === 'GET' && path === '/voices') return sendJson(res, 200, { voices: LABGPU_VOICES, note: 'unknown voice names pass through unchanged' });
    if (req.method !== 'POST' || path !== '/tts') return sendJson(res, 404, { error: 'not found' });

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return sendJson(res, 400, { error: 'bad json' });
    }
    let gone = false;
    let onGone: () => void = () => undefined;
    const goneSignal = new Promise<void>((resolve) => {
      onGone = resolve;
    });
    const rec: FakeTtsRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body,
      text: typeof body.text === 'string' ? body.text : '',
      voice: typeof body.voice === 'string' ? body.voice : '',
      hasSpeed: 'speed' in body,
      bytesWritten: 0,
      chunksWritten: 0,
      finished: false,
      aborted: false,
      closed: goneSignal,
    };
    this.requests.push(rec);
    res.on('close', () => {
      gone = true;
      rec.finished = res.writableFinished;
      rec.aborted = !res.writableFinished;
      onGone();
    });

    const b: FakeTtsBehavior = { ...this.behavior, ...this.queue.shift() };
    if (b.stallBeforeHead) return goneSignal;
    if (b.headDelayMs > 0) await sleepUnless(b.headDelayMs, goneSignal);
    if (gone) return;
    if (b.fallback !== false) res.setHeader('X-TTS-Fallback', typeof b.fallback === 'string' ? b.fallback : 'elevenlabs'); // on an error answer too: a mouth must see it first
    if (b.status !== 200) return sendJson(res, b.status, { error: 'synthesis failed', detail: BODY_MARKER });

    let audio = b.empty ? Buffer.alloc(0) : this.pcmFor(rec.text, b.wordsPerSecond);
    if (b.oddByte) audio = Buffer.concat([audio, Buffer.from([0x7f])]);
    if (b.wav) audio = wavBytes(audio, b.wav);

    res.setHeader('content-type', b.contentType);
    res.writeHead(200);
    res.flushHeaders(); // Node holds the head until the first write otherwise; a stall after the head must be a stall after the head
    if (b.stallAfterHead) return goneSignal;
    if (b.firstByteDelayMs > 0) await sleepUnless(b.firstByteDelayMs, goneSignal);
    if (gone) return;
    await streamChunks(res, audio, b, this.gate, goneSignal, () => gone, rec);
  }
}
