/**
 * A stand-in for LabGPU's recognizer adapter (Qwen3-ASR on :8803, a Deepgram-compatible `/v1/listen`), for tests: a `ws` server on loopback that takes no
 * credentials, records the audio frames it gets (counts, sizes, arrival times and the bytes) and every text message, and is scripted by the test:
 * `sendPartial`, `sendFinal`, `sendSpeechStarted`, `sendUtteranceEnd`, `closeConnection`, plus a handshake that can be refused or held back.
 * Its messages are the shape of the nemotron sidecar's (deploy/nemotron-stt/sidecar_v2.py of the distributed classroom): a partial is a `Results` with
 * `speech_final` false, the final carries `is_final` and `speech_final` true and the whole utterance's text.
 *
 * This file also holds what the two fakes of the lab's ears share: the server plumbing that decides how the handshake goes, a recording `VoiceLog`, and
 * a polling `until`. Nothing here ever leaves loopback.
 */
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import { performance } from 'perf_hooks';
import type { Duplex } from 'stream';

import { WebSocket, WebSocketServer } from 'ws';

import type { VoiceLog } from '../../types.js';
import type { EarsContext, EarsHandlers } from '../types.js';

// ---------------------------------------------------------------- small helpers for the tests

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `cond` is true (an assertion helper must not sleep for a guess): rejects after `timeoutMs` with the label. */
export async function until(cond: () => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
    await sleep(5);
  }
}

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  obj: Record<string, unknown>;
}

/** A `VoiceLog` that keeps every line, so that a test can look for what must not be in any of them. */
export function recordingLog(): { log: VoiceLog; lines: LogLine[]; dump(): string; at(level: LogLine['level']): LogLine[] } {
  const lines: LogLine[] = [];
  const add =
    (level: LogLine['level']) =>
    (obj: Record<string, unknown>, msg?: string): void => {
      lines.push({ level, msg: msg ?? '', obj });
    };
  return {
    log: { debug: add('debug'), info: add('info'), warn: add('warn'), error: add('error') },
    lines,
    dump: () => JSON.stringify(lines),
    at: (level) => lines.filter((l) => l.level === level),
  };
}

export interface SeenEvent {
  kind: 'start' | 'partial' | 'final' | 'down' | 'eager' | 'resumed';
  text?: string;
  at?: number;
  info?: { trigger?: string; confidence?: number };
  reason?: string;
}

/**
 * The engine's side of an ears client, for tests: handlers that record what they are told, an engine clock whose every reading is a new, larger number
 * (so that an `at` can be matched to the reading it came from) and a recording log. `over` replaces any handler.
 */
export function earsHarness(over: Partial<EarsHandlers> = {}) {
  const events: SeenEvent[] = [];
  const ticks: number[] = [];
  const clock = (): number => {
    const t = 1000 + ticks.length * 10;
    ticks.push(t);
    return t;
  };
  const rec = recordingLog();
  const handlers: EarsHandlers = {
    startOfTurn: (at, text) => void events.push({ kind: 'start', at, text }),
    partial: (text, at) => void events.push({ kind: 'partial', text, at }),
    final: (text, at, info) => void events.push({ kind: 'final', text, at, info }),
    eagerEndOfTurn: (text, at) => void events.push({ kind: 'eager', text, at }),
    turnResumed: (at) => void events.push({ kind: 'resumed', at }),
    down: (reason) => void events.push({ kind: 'down', reason }),
    ...over,
  };
  const ctx: EarsContext = { clock, log: rec.log };
  return {
    handlers,
    ctx,
    events,
    ticks,
    rec,
    of: (kind: SeenEvent['kind']) => events.filter((e) => e.kind === kind),
    /** One short line per event: `partial:what is`. */
    texts: () => events.map((e) => `${e.kind}:${e.text ?? ''}`),
  };
}

// ---------------------------------------------------------------- the server plumbing both fakes use

export interface FakeHandshake {
  /** Answer the upgrade with this HTTP status instead of 101 (`true`: 403). */
  refuseUpgrade?: number | boolean;
  /** Hold the handshake back this long before answering it (`Infinity`: never answer, for the client's timeout). */
  delayHandshakeMs?: number;
}

export interface FakeWsHost {
  port: number;
  /** Ends every connection and the server; waits until it is all gone. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * A loopback websocket server whose upgrade is handled by hand, so that the test decides what the handshake does (`handshake()` is read for every
 * upgrade, so changing it takes effect for the next connection). Every socket and timer is tracked: a held-back handshake must not keep `close()` waiting.
 */
export async function startFakeWsHost(handshake: () => FakeHandshake, onConnection: (ws: WebSocket, req: http.IncomingMessage) => void): Promise<FakeWsHost> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const { refuseUpgrade, delayHandshakeMs = 0 } = handshake();
    const answer = (): void => {
      // the client may have given up while the handshake was held back
      if (socket.destroyed) return;
      if (refuseUpgrade) {
        const status = refuseUpgrade === true ? 403 : refuseUpgrade;
        socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Refused'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => onConnection(ws, req));
    };
    if (delayHandshakeMs === Infinity) return;
    if (delayHandshakeMs > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        answer();
      }, delayHandshakeMs);
      timers.add(timer);
    } else answer();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    async close(): Promise<void> {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** What a connection to either fake keeps of what the client sent. */
export abstract class FakeConnectionBase {
  /** The bytes of each audio frame, in order (left empty with `recordAudio: false`). */
  readonly frames: Buffer[] = [];
  /** The size of each audio frame, in order: kept even when the bytes are not. */
  readonly frameSizes: number[] = [];
  /** `performance.now()` at the arrival of each frame, parallel to `frameSizes`. */
  readonly frameTimes: number[] = [];
  /** Every text message the client sent, parsed when it is JSON. */
  readonly texts: Array<{ at: number; raw: string; json: Record<string, unknown> | null }> = [];
  closed = false;
  closeCode = 0;
  closeReason = '';

  constructor(
    readonly ws: WebSocket,
    readonly req: http.IncomingMessage,
    recordAudio: boolean,
  ) {
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const at = performance.now();
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        if (recordAudio) this.frames.push(buf);
        this.frameSizes.push(buf.length);
        this.frameTimes.push(at);
        return;
      }
      const raw = buf.toString('utf8');
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      } catch {
        /* not JSON: kept as raw */
      }
      this.texts.push({ at, raw, json });
    });
    ws.on('close', (code: number, reason: Buffer) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason.toString('utf8');
    });
    ws.on('error', () => undefined);
  }

  get url(): URL {
    return new URL(this.req.url ?? '/', 'http://fake');
  }

  get headers(): http.IncomingHttpHeaders {
    return this.req.headers;
  }

  get audioBytes(): number {
    return this.frameSizes.reduce((sum, n) => sum + n, 0);
  }

  /** All the audio the client sent, in order (empty when not recorded). */
  received(): Buffer {
    return Buffer.concat(this.frames);
  }

  /** The client's text messages of this `type` (`KeepAlive`, `Finalize`, `Configure` ...). */
  textsOfType(type: string): Array<{ at: number; raw: string; json: Record<string, unknown> | null }> {
    return this.texts.filter((t) => t.json?.type === type);
  }

  sendJson(message: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  sendRaw(data: string | Buffer, binary = false): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data, { binary });
  }

  /** A close handshake with a code and a reason (the client sees a normal close). */
  close(code = 1000, reason = ''): void {
    try {
      this.ws.close(code, reason);
    } catch {
      /* gone */
    }
  }

  /** The connection is cut without a close frame (the client sees 1006). */
  terminate(): void {
    try {
      this.ws.terminate();
    } catch {
      /* gone */
    }
  }
}

// ---------------------------------------------------------------- LabGPU's adapter

export interface FakeAsrOptions extends FakeHandshake {
  /** Keep the bytes of the audio (default true); false keeps only the sizes, for long runs. */
  recordAudio?: boolean;
}

export class FakeAsrConnection extends FakeConnectionBase {
  /** A partial: the text so far, `speech_final` false. `isFinal` marks it final too (an adapter that does that must still be understood). */
  sendPartial(text: string, opts: { isFinal?: boolean } = {}): void {
    this.sendJson(results(text, opts.isFinal === true, false));
  }

  /** The utterance's final: `is_final` and `speech_final` true, the whole text. (The real adapter follows it with an `UtteranceEnd`: `sendUtteranceEnd`.) */
  sendFinal(text: string): void {
    this.sendJson(results(text, true, true));
  }

  sendSpeechStarted(): void {
    this.sendJson({ type: 'SpeechStarted' });
  }

  sendUtteranceEnd(): void {
    this.sendJson({ type: 'UtteranceEnd' });
  }

  /** Waits until this connection has received `n` frames. */
  async waitForFrames(n: number, timeoutMs = 2000): Promise<void> {
    await until(() => this.frameSizes.length >= n, timeoutMs, `${n} audio frames`);
  }
}

function results(text: string, isFinal: boolean, speechFinal: boolean): Record<string, unknown> {
  return { type: 'Results', channel: { alternatives: [{ transcript: text }] }, is_final: isFinal, speech_final: speechFinal };
}

export class FakeAsr {
  readonly connections: FakeAsrConnection[] = [];
  /** Read for every upgrade: change it to change what the next handshake does. */
  readonly handshake: FakeHandshake;
  private waiters: Array<{ n: number; resolve: (c: FakeAsrConnection) => void }> = [];

  private constructor(
    private readonly host: FakeWsHost,
    handshake: FakeHandshake,
  ) {
    this.handshake = handshake;
  }

  static async start(opts: FakeAsrOptions = {}): Promise<FakeAsr> {
    const handshake: FakeHandshake = { refuseUpgrade: opts.refuseUpgrade, delayHandshakeMs: opts.delayHandshakeMs };
    const recordAudio = opts.recordAudio !== false;
    // the host needs the fake that owns it for its callback, and the fake needs the host: tie them with a holder
    const holder: { fake?: FakeAsr } = {};
    const host = await startFakeWsHost(
      () => handshake,
      (ws, req) => {
        const fake = holder.fake;
        if (!fake) {
          ws.terminate();
          return;
        }
        const conn = new FakeAsrConnection(ws, req, recordAudio);
        fake.connections.push(conn);
        for (const w of [...fake.waiters]) {
          if (fake.connections.length >= w.n) {
            fake.waiters.splice(fake.waiters.indexOf(w), 1);
            w.resolve(fake.connections[w.n - 1]);
          }
        }
      },
    );
    const fake = new FakeAsr(host, handshake);
    holder.fake = fake;
    return fake;
  }

  get port(): number {
    return this.host.port;
  }

  /** The address the client uses: the same shape as LabGPU's (`language=en`, a label). */
  get url(): string {
    return `ws://127.0.0.1:${this.host.port}/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=tai-lab`;
  }

  /** The most recent connection (throws when there is none yet). */
  get latest(): FakeAsrConnection {
    const conn = this.connections[this.connections.length - 1];
    if (!conn) throw new Error('fake ASR: no connection yet');
    return conn;
  }

  /** The n-th connection (1-based), once it exists. */
  connection(n = 1, timeoutMs = 3000): Promise<FakeAsrConnection> {
    if (this.connections.length >= n) return Promise.resolve(this.connections[n - 1]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake ASR: no connection #${n} within ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        n,
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
      });
    });
  }

  // the script, on the most recent connection
  sendPartial(text: string, opts: { isFinal?: boolean } = {}): void {
    this.latest.sendPartial(text, opts);
  }
  sendFinal(text: string): void {
    this.latest.sendFinal(text);
  }
  sendSpeechStarted(): void {
    this.latest.sendSpeechStarted();
  }
  sendUtteranceEnd(): void {
    this.latest.sendUtteranceEnd();
  }
  closeConnection(code = 1000, reason = ''): void {
    this.latest.close(code, reason);
  }

  async close(): Promise<void> {
    this.waiters = [];
    await this.host.close();
  }
}
