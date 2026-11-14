/**
 * A stand-in for Deepgram's hosted listen endpoints, for tests: `/v1/listen` (nova-3: an utterance arrives as several `is_final` segments, its
 * `speech_final` carries only the LAST segment, `UtteranceEnd` follows) and `/v2/listen` (Flux: `Connected` on open, then scripted `TurnInfo` events).
 * It records what a client sends: the request path and raw query string, the headers (the `Authorization` one included), every audio frame
 * (sizes, arrival times, bytes) and every text message (KeepAlive, Finalize, CloseStream, Configure, ForceEndTurn ...). Loopback only.
 */
import type { WebSocket } from 'ws';

import { FakeConnectionBase, startFakeWsHost, until, type FakeHandshake, type FakeWsHost } from './fake-asr.js';

export interface FakeListenOptions extends FakeHandshake {
  /** Send `Connected` when a `/v2/listen` socket opens, as Flux does (default true). */
  autoConnected?: boolean;
  /** Keep the bytes of the audio (default true). */
  recordAudio?: boolean;
}

export interface TurnInfoFields {
  transcript?: string;
  turnIndex?: number;
  confidence?: number;
  trigger?: string;
  /** Send the numbers as strings, which Deepgram's documentation allows for. */
  asStrings?: boolean;
}

export class FakeListenConnection extends FakeConnectionBase {
  private sequence = 0;

  get path(): string {
    return this.url.pathname;
  }

  /** The raw query string as it arrived (without the `?`), for a test that wants to see the encoding. */
  get rawQuery(): string {
    const at = (this.req.url ?? '').indexOf('?');
    return at < 0 ? '' : (this.req.url ?? '').slice(at + 1);
  }

  get authorization(): string | undefined {
    return this.req.headers.authorization;
  }

  /** The `KeepAlive` messages the client sent. */
  get keepAlives(): Array<{ at: number }> {
    return this.textsOfType('KeepAlive');
  }

  // ---- /v1/listen

  /** An interim result: text of the current segment only, not final. */
  sendInterim(text: string): void {
    this.sendJson(this.v1Results(text, false, false, false));
  }

  /** A finalized segment of the utterance (`is_final` true), the endpointer has not fired yet. */
  sendSegment(text: string): void {
    this.sendJson(this.v1Results(text, true, false, false));
  }

  /** The endpointer fired: `speech_final` true, carrying only the LAST segment's text (that is what the hosted service does). May be empty. */
  sendSpeechFinal(text: string): void {
    this.sendJson(this.v1Results(text, true, true, false));
  }

  /** The answer to a `Finalize`: a final segment marked `from_finalize`. */
  sendFromFinalize(text: string): void {
    this.sendJson(this.v1Results(text, true, false, true));
  }

  sendUtteranceEnd(): void {
    this.sendJson({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 1.5 });
  }

  sendSpeechStarted(): void {
    this.sendJson({ type: 'SpeechStarted', channel: [0, 1], timestamp: 0.5 });
  }

  sendMetadata(): void {
    this.sendJson({ type: 'Metadata', request_id: 'req-fake', duration: 3.2, channels: 1 });
  }

  private v1Results(text: string, isFinal: boolean, speechFinal: boolean, fromFinalize: boolean): Record<string, unknown> {
    return {
      type: 'Results',
      channel_index: [0, 1],
      duration: 1.2,
      start: 0,
      is_final: isFinal,
      speech_final: speechFinal,
      from_finalize: fromFinalize,
      channel: { alternatives: [{ transcript: text, confidence: 0.98, words: [] }] },
      metadata: { request_id: 'req-fake' },
    };
  }

  // ---- /v2/listen

  sendConnected(): void {
    this.sendJson({ type: 'Connected', request_id: 'req-fake', sequence_id: this.sequence++ });
  }

  /** A Flux `TurnInfo` event (`StartOfTurn`, `Update`, `EagerEndOfTurn`, `TurnResumed`, `EndOfTurn`, or any name the test wants). */
  sendTurnInfo(event: string, fields: TurnInfoFields = {}): void {
    const text = fields.transcript ?? '';
    const num = (n: number): number | string => (fields.asStrings ? String(n) : n);
    const message: Record<string, unknown> = {
      type: 'TurnInfo',
      request_id: 'req-fake',
      sequence_id: num(this.sequence++),
      event,
      turn_index: num(fields.turnIndex ?? 0),
      audio_window_start: num(0),
      audio_window_end: num(1.6),
      transcript: text,
      words: text
        .split(/\s+/)
        .filter(Boolean)
        .map((word, i) => ({ word, confidence: fields.asStrings ? '0.99' : 0.99, start: 0.1 * i, end: 0.1 * i + 0.08 })),
      end_of_turn_confidence: num(fields.confidence ?? 0.1),
    };
    if (fields.trigger !== undefined) message.trigger = fields.trigger;
    this.sendJson(message);
  }

  sendConfigureSuccess(): void {
    this.sendJson({ type: 'ConfigureSuccess', request_id: 'req-fake', sequence_id: this.sequence++ });
  }

  sendConfigureFailure(code: string, description: string): void {
    this.sendJson({ type: 'ConfigureFailure', code, description });
  }

  sendWarning(code: string, description: string): void {
    this.sendJson({ type: 'Warning', code, description });
  }

  /** A fatal `Error`; the service closes the connection after it (`closeAfter`, default true). */
  sendError(code: string, description: string, closeAfter = true): void {
    this.sendJson({ type: 'Error', code, description });
    if (closeAfter) setTimeout(() => this.close(1011, 'error'), 20);
  }

  /** Waits until this connection has received `n` frames. */
  async waitForFrames(n: number, timeoutMs = 2000): Promise<void> {
    await until(() => this.frameSizes.length >= n, timeoutMs, `${n} audio frames`);
  }
}

export class FakeListen {
  readonly connections: FakeListenConnection[] = [];
  /** Read for every upgrade: change it to change what the next handshake does. */
  readonly handshake: FakeHandshake;
  private waiters: Array<{ n: number; resolve: (c: FakeListenConnection) => void }> = [];

  private constructor(
    private readonly host: FakeWsHost,
    handshake: FakeHandshake,
  ) {
    this.handshake = handshake;
  }

  static async start(opts: FakeListenOptions = {}): Promise<FakeListen> {
    const handshake: FakeHandshake = { refuseUpgrade: opts.refuseUpgrade, delayHandshakeMs: opts.delayHandshakeMs };
    const recordAudio = opts.recordAudio !== false;
    const autoConnected = opts.autoConnected !== false;
    const holder: { fake?: FakeListen } = {};
    const host = await startFakeWsHost(
      () => handshake,
      (ws: WebSocket, req) => {
        const fake = holder.fake;
        if (!fake) {
          ws.terminate();
          return;
        }
        const conn = new FakeListenConnection(ws, req, recordAudio);
        fake.connections.push(conn);
        if (autoConnected && conn.path === '/v2/listen') conn.sendConnected();
        for (const w of [...fake.waiters]) {
          if (fake.connections.length >= w.n) {
            fake.waiters.splice(fake.waiters.indexOf(w), 1);
            w.resolve(fake.connections[w.n - 1]);
          }
        }
      },
    );
    const fake = new FakeListen(host, handshake);
    holder.fake = fake;
    return fake;
  }

  get port(): number {
    return this.host.port;
  }

  /** `/v1/listen` (nova), with an optional query that starts with `?`. */
  v1Url(query = ''): string {
    return `ws://127.0.0.1:${this.host.port}/v1/listen${query}`;
  }

  /** `/v2/listen` (Flux) without a query: the client adds its own. */
  get v2Url(): string {
    return `ws://127.0.0.1:${this.host.port}/v2/listen`;
  }

  get latest(): FakeListenConnection {
    const conn = this.connections[this.connections.length - 1];
    if (!conn) throw new Error('fake listen: no connection yet');
    return conn;
  }

  /** The n-th connection (1-based), once it exists. */
  connection(n = 1, timeoutMs = 3000): Promise<FakeListenConnection> {
    if (this.connections.length >= n) return Promise.resolve(this.connections[n - 1]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake listen: no connection #${n} within ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        n,
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
      });
    });
  }

  async close(): Promise<void> {
    this.waiters = [];
    await this.host.close();
  }
}
