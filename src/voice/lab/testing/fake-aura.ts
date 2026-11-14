/**
 * A stand-in for Deepgram's REST text-to-speech (`POST /v1/speak`), for tests: an HTTP server on 127.0.0.1 that checks the request the way the real service
 * would (an `aura-2-...` model, `encoding=linear16`, `sample_rate=24000`, `container=none`, `mip_opt_out=true`, a `speed` in range if there is one, the
 * `Authorization: Token <key>` header, a JSON body with the text) and answers with a deterministic tone as raw PCM in many small chunks (the real service
 * streams about 300 of them for 14 s). A request that breaks a rule is answered with HTTP 400 and the reason is recorded in `violations`, so a test
 * can say "nothing was wrong with what the mouth sent" in one line.
 *
 * The pace follows `speed`: 2.8 words a second at speed 1, 3.36 at 1.2 (measured). Failures are scripted as in `fake-tts.ts`: 401, 429, 500 with a body that
 * holds `BODY_MARKER` (no error message of a mouth may repeat it), a stall, a late first byte, an odd byte, a held stream.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import { OUT_RATE } from '../types.js';
import { BODY_MARKER, Gate, LoopbackServer, readBody, sendJson, sleepUnless, streamChunks, tonePcm, type ChunkPlan } from './fake-tts.js';

const MODEL = /^aura-2-[a-z]+-[a-z]{2}$/;
const KNOWN_PARAMETERS = new Set(['model', 'encoding', 'sample_rate', 'container', 'mip_opt_out', 'speed']);

export interface FakeAuraBehavior extends ChunkPlan {
  /** The voice's pace at speed 1. */
  wordsPerSecond: number;
  headDelayMs: number;
  firstByteDelayMs: number;
  stallBeforeHead: boolean;
  stallAfterHead: boolean;
  /** Answer this HTTP status (401, 429, 500...); the body is JSON with `BODY_MARKER`. */
  status: number;
  oddByte: boolean;
  empty: boolean;
  contentType: string;
}

export interface FakeAuraRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  model: string;
  /** The `speed` parameter as a number, or undefined when there was none. */
  speed: number | undefined;
  /** The whole Authorization header as received. */
  authorization: string | undefined;
  headers: IncomingHttpHeaders;
  text: string;
  body: Record<string, unknown>;
  /** Every rule of the real service that this request broke. Empty for a good request. */
  violations: string[];
  bytesWritten: number;
  chunksWritten: number;
  finished: boolean;
  aborted: boolean;
  closed: Promise<void>;
}

export class FakeAura {
  behavior: FakeAuraBehavior;
  readonly requests: FakeAuraRequest[] = [];
  /** When set, a request whose Authorization header is not exactly `Token <this>` is answered 401. */
  expectedKey: string | undefined;
  private gate = new Gate();
  private readonly queue: Array<Partial<FakeAuraBehavior>> = [];
  private readonly http: LoopbackServer;

  private constructor(behavior: Partial<FakeAuraBehavior>, expectedKey: string | undefined) {
    this.expectedKey = expectedKey;
    this.behavior = {
      wordsPerSecond: 2.8,
      chunks: 300,
      chunkBytes: 2240,
      chunkDelayMs: 0,
      headDelayMs: 0,
      firstByteDelayMs: 0,
      stallBeforeHead: false,
      stallAfterHead: false,
      status: 200,
      oddByte: false,
      empty: false,
      contentType: 'application/octet-stream',
      ...behavior,
    };
    this.http = new LoopbackServer((req, res) => this.handle(req, res));
  }

  static async start(behavior: Partial<FakeAuraBehavior> = {}, expectedKey?: string): Promise<FakeAura> {
    const fake = new FakeAura(behavior, expectedKey);
    await fake.http.listen();
    return fake;
  }

  get url(): string {
    return this.http.url;
  }

  /** Every violation of every request, in one list. */
  get violations(): string[] {
    return this.requests.flatMap((r) => r.violations);
  }

  once(over: Partial<FakeAuraBehavior>, times = 1): void {
    for (let i = 0; i < times; i++) this.queue.push(over);
  }

  release(): void {
    this.gate.open();
  }

  rearm(): void {
    this.gate = new Gate();
  }

  /** The audio this fake sends for `text` at `speed` (undefined: 1). */
  pcmFor(text: string, speed: number | undefined, wordsPerSecond = this.behavior.wordsPerSecond): Buffer {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return tonePcm(Math.max(1, Math.round((words / (wordsPerSecond * (speed ?? 1))) * OUT_RATE)));
  }

  async close(): Promise<void> {
    this.gate.open();
    await this.http.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    const violations: string[] = [];
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      violations.push('body is not JSON');
    }
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;

    if (req.method !== 'POST' || url.pathname !== '/v1/speak') violations.push(`wrong route ${req.method} ${url.pathname}`);
    if (!MODEL.test(query.model ?? '')) violations.push('model is not an aura-2 voice');
    if (query.encoding !== 'linear16') violations.push('encoding is not linear16');
    if (query.sample_rate !== '24000') violations.push('sample_rate is not 24000');
    if (query.container !== 'none') violations.push('container is not none');
    if (query.mip_opt_out !== 'true') violations.push('mip_opt_out is not true');
    for (const k of Object.keys(query)) if (!KNOWN_PARAMETERS.has(k)) violations.push(`unknown parameter ${k}`);
    let speed: number | undefined;
    if ('speed' in query) {
      speed = Number(query.speed);
      if (!Number.isFinite(speed) || speed < 0.7 || speed > 1.5) violations.push(`speed ${query.speed} is out of range`);
      if (speed === 1) violations.push('speed=1 sent although it is the default');
    }
    const authorization = req.headers.authorization;
    const keyOk = typeof authorization === 'string' && /^Token \S+$/.test(authorization) && (this.expectedKey === undefined || authorization === `Token ${this.expectedKey}`);
    if (!keyOk) violations.push('Authorization is not "Token <key>"');
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) violations.push('content-type is not JSON');
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) violations.push('no text');

    let gone = false;
    let onGone: () => void = () => undefined;
    const goneSignal = new Promise<void>((resolve) => {
      onGone = resolve;
    });
    const rec: FakeAuraRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      path: url.pathname,
      query,
      model: query.model ?? '',
      speed,
      authorization,
      headers: req.headers,
      text,
      body,
      violations,
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

    const b: FakeAuraBehavior = { ...this.behavior, ...this.queue.shift() };
    if (b.stallBeforeHead) return goneSignal;
    if (b.headDelayMs > 0) await sleepUnless(b.headDelayMs, goneSignal);
    if (gone) return;
    if (b.status !== 200) return sendJson(res, b.status, { err_code: 'FAKE_ERROR', err_msg: BODY_MARKER, request_id: 'fake' });
    if (!keyOk) return sendJson(res, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.', request_id: 'fake' });
    if (violations.length > 0) return sendJson(res, 400, { err_code: 'BAD_REQUEST', err_msg: violations.join('; '), request_id: 'fake' });

    let audio = b.empty ? Buffer.alloc(0) : this.pcmFor(text, speed, b.wordsPerSecond);
    if (b.oddByte) audio = Buffer.concat([audio, Buffer.from([0x7f])]);
    res.setHeader('content-type', b.contentType);
    res.writeHead(200);
    res.flushHeaders();
    if (b.stallAfterHead) return goneSignal;
    if (b.firstByteDelayMs > 0) await sleepUnless(b.firstByteDelayMs, goneSignal);
    if (gone) return;
    await streamChunks(res, audio, b, this.gate, goneSignal, () => gone, rec);
  }
}
