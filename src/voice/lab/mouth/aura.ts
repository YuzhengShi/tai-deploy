/**
 * `AuraMouth`: Deepgram's hosted text-to-speech (Aura 2, the REST endpoint) as a `Mouth`. In the lab it is the control for naturalness and pace (chain C and
 * the ablations of docs/VOICE_SELFBUILT.md, section 9.1), and the voice that speaks a sentence when LabGPU's adapter cannot.
 *
 *   POST {baseUrl}/v1/speak?model=aura-2-mars-en&encoding=linear16&sample_rate=24000&container=none&mip_opt_out=true[&speed=1.2]
 *   Authorization: Token <key>      body {"text": "..."}
 *     -> raw PCM s16le mono 24 kHz, streamed (about 300 chunks for 14 s of speech), first byte 110 to 280 ms, faster than real time
 *
 * `speed` really changes the pace (3.3 words a second at 1.2 against 2.8), so this mouth `takesSpeed` and the engine does not stretch its audio.
 * `mip_opt_out=true` keeps the text out of Deepgram's model improvement programme.
 *
 * The key is read through `apiKey()` on EVERY request (it may be rotated while the process runs) and goes nowhere but the Authorization header: no error
 * message, log line or thrown value carries it, nor the text spoken, nor the body of an error answer (an HTTP error becomes the status code and nothing more).
 * The streaming itself (timeouts, abort, whole samples) is `streamPcm` of labgpu.ts.
 */
import { MouthError, type Mouth, type SynthOptions } from '../types.js';
import { streamPcm } from './labgpu.js';

export interface AuraMouthOptions {
  /** The Deepgram key, read at each request. */
  apiKey: () => string;
  /** Default: Deepgram's API. */
  baseUrl?: string;
  /** The longest silence: the head of the answer and the first byte must come within this long, and no gap between chunks may be longer (default 8000 ms). */
  firstByteTimeoutMs?: number;
  /** The most the service may take for one sentence, not counting the consumer's own pace (default 30000 ms). */
  totalTimeoutMs?: number;
  /** For tests: another `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The voice goes into a URL, so it must look like one of Deepgram's: aura-2-thalia-en, aura-2-mars-en. */
const VOICE = /^aura-2-[a-z]+-[a-z]{2}$/;
/** What the key may look like: visible ASCII, no spaces (it goes into a header, and a bad character makes `fetch` throw an error that quotes the value). */
const KEY = /^[\x21-\x7e]+$/;

/**
 * The `speed` query value for a requested pace, or undefined when none is to be sent: not set, not a number, or 1 once clamped to 0.7 to 1.5 and rounded
 * to steps of 0.05 (Aura's default is 1, and a value that equals it is not worth a parameter).
 */
export function auraSpeedParam(speed: number | undefined): string | undefined {
  if (speed === undefined || !Number.isFinite(speed)) return undefined;
  const steps = Math.round(Math.min(1.5, Math.max(0.7, speed)) * 20) / 20;
  const text = String(Number(steps.toFixed(2))); // 1.15 and not 1.1500000000000001
  return text === '1' ? undefined : text;
}

export class AuraMouth implements Mouth {
  readonly name = 'aura';
  readonly takesSpeed = true;
  private readonly apiKey: () => string;
  private readonly baseUrl: string;
  private readonly firstByteTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AuraMouthOptions) {
    if (typeof options.apiKey !== 'function') throw new TypeError('AuraMouth: apiKey must be a function');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.deepgram.com').replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      throw new TypeError('AuraMouth: baseUrl is not a URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('AuraMouth: baseUrl must be http or https');
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? 8000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
    for (const [name, value] of [['firstByteTimeoutMs', this.firstByteTimeoutMs], ['totalTimeoutMs', this.totalTimeoutMs]] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError(`AuraMouth: ${name} must be a positive number`);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The audio of one sentence. Everything that can go wrong (also a voice name that is not one of Aura's) surfaces from the first `next()`. */
  synthesize(text: string, opts: SynthOptions): AsyncIterable<Buffer> {
    return this.run(text, opts);
  }

  private async *run(text: string, opts: SynthOptions): AsyncGenerator<Buffer, void, undefined> {
    if (typeof opts.voice !== 'string' || !VOICE.test(opts.voice)) throw new Error('Aura: the voice must look like aura-2-thalia-en');
    if (opts.signal?.aborted || !text.trim()) return;
    const key = this.readKey();
    const speed = auraSpeedParam(opts.speed);
    const url = `${this.baseUrl}/v1/speak?model=${opts.voice}&encoding=linear16&sample_rate=24000&container=none&mip_opt_out=true${speed ? `&speed=${speed}` : ''}`;
    const body = JSON.stringify({ text });
    yield* streamPcm({
      label: 'Aura',
      send: (signal) => this.fetchImpl(url, { method: 'POST', headers: { Authorization: `Token ${key}`, 'content-type': 'application/json' }, body, signal }),
      // The head and the first byte share one limit: over the internet the answer's head comes with its first bytes.
      connectTimeoutMs: this.firstByteTimeoutMs,
      firstByteTimeoutMs: this.firstByteTimeoutMs,
      totalTimeoutMs: this.totalTimeoutMs,
      signal: opts.signal,
    });
  }

  /** The key, or a MouthError with fixed words: whatever `apiKey` threw or returned is never repeated. */
  private readKey(): string {
    let key: unknown;
    try {
      key = this.apiKey();
    } catch {
      throw new MouthError('down', 'the Deepgram key is not available');
    }
    if (typeof key !== 'string' || !KEY.test(key)) throw new MouthError('down', 'the Deepgram key is not available');
    return key;
  }
}
