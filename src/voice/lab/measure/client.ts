/**
 * A synthetic caller over the browser protocol of docs/VOICE.md ("Browser protocol"): connects the way the smoke client does (an Origin header and
 * a signed `tai_session` cookie), sends `start`, streams a microphone in real time and records everything with timestamps from ONE clock.
 *
 * The microphone is one continuous stream of 40 ms frames, as a browser's is: from `startMic()` on, frame k is sent at (start + k * 40 ms), silence
 * when nothing is queued, so the hub's rate rules (at most 1.5x real time) and a real call's rhythm hold, and a scenario or an interruption is
 * substituted into the stream, never a second stream. The schedule is against the stream's start, not chained, so a late frame is not followed by
 * a late schedule; the wait is a coarse timer plus a short spin on the immediate queue, whose length adapts to how late timers turn out to be
 * (about 1 ms on Linux, about 16 ms on Windows).
 *
 * Times are milliseconds of the call's own clock: `now()` is performance.now() minus its value when the client was created (just before the
 * socket was opened). The cookie is only ever put in the request header; it is not stored on the instance or in an error message.
 */
import { performance } from 'node:perf_hooks';

import { WebSocket } from 'ws';

import { toFrames } from './wav.js';

export interface ClientEvent {
  /** arrival time, ms of the call's clock */
  t: number;
  /** the order of arrival among all records (events and audio frames) */
  seq: number;
  ev: Record<string, unknown>;
}

export interface AgentFrame {
  /** arrival time, ms of the call's clock */
  t: number;
  seq: number;
  /** bytes of PCM16 24 kHz */
  bytes: number;
}

export interface ConnectOptions {
  /** ws://host:port/<path> or ws+unix:<socket>:/<path> */
  url: string;
  origin: string;
  /** the tai_session cookie's value. Never printed or stored. */
  cookie: string;
  frameMs?: number;
  handshakeTimeoutMs?: number;
}

export class ConnectError extends Error {
  constructor(
    readonly kind: 'http' | 'socket' | 'timeout',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

export interface PlayHandle {
  /** the absolute number of the first frame of the clip in the microphone stream */
  firstFrame: number;
  frames: number;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

interface Waiter {
  check(): void;
}

const byteLength = (data: unknown): number => (Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? data.reduce((s: number, b: Buffer) => s + b.length, 0) : (data as ArrayBuffer).byteLength);

export class CallClient {
  /** every JSON message the server sent, with its arrival time */
  readonly events: ClientEvent[] = [];
  /** every binary frame (the agent's speech), with its arrival time and size */
  readonly audio: AgentFrame[] = [];
  /** sentTimes[i] is when microphone frame i was sent (undefined while it has not been) */
  readonly sentTimes: number[] = [];
  readonly frameMs: number;
  readonly frameBytes: number;
  readonly frameSamples: number;
  /** when the socket opened */
  openedAt = 0;
  /** when `start` was sent: the call's start for the criteria */
  startSentAt: number | null = null;
  /** when frame 0 of the microphone was due; frame i is due at micStartAt + i * frameMs */
  micStartAt: number | null = null;
  /** the socket is closed (by either side) */
  closed = false;
  closeCode = 0;
  /** the socket reported an error of its own (not a `closed` event from the server) */
  socketError: string | null = null;
  /** the server said `closed` */
  sawClosed = false;

  private readonly t0: number;
  private seq = 0;
  private readonly waiters = new Set<Waiter>();
  private readonly silenceFrame: Buffer;
  private queue: Buffer[] = [];
  private head = 0;
  private frameIndex = 0;
  private pumping = false;
  private timer: NodeJS.Timeout | null = null;
  private immediate: NodeJS.Immediate | null = null;
  /** how long before a frame is due the coarse timer is set to fire; learned from how late recent timers were */
  private margin = 2;
  private overshoots: number[] = [];

  private constructor(
    private readonly ws: WebSocket,
    t0: number,
    frameMs: number,
  ) {
    this.t0 = t0;
    this.frameMs = frameMs;
    this.frameSamples = Math.round((16_000 * frameMs) / 1000);
    this.frameBytes = this.frameSamples * 2;
    this.silenceFrame = Buffer.alloc(this.frameBytes);
    ws.on('message', (data, isBinary) => {
      const t = this.now();
      if (isBinary) {
        this.audio.push({ t, seq: this.seq++, bytes: byteLength(data) });
      } else {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'closed') this.sawClosed = true;
        this.events.push({ t, seq: this.seq++, ev });
      }
      this.notify();
    });
    ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      this.stopPump();
      this.notify();
    });
    ws.on('error', (err) => {
      this.socketError = err.message;
    });
  }

  /** Opens the socket. Rejects with a ConnectError (never with the cookie in it) when the portal refuses, the host is not there or the handshake times out. */
  static connect(opts: ConnectOptions): Promise<CallClient> {
    const t0 = performance.now();
    const frameMs = opts.frameMs ?? 40;
    return new Promise<CallClient>((resolve, reject) => {
      const ws = new WebSocket(opts.url, {
        headers: { Origin: opts.origin, Cookie: `tai_session=${opts.cookie}` },
        handshakeTimeout: opts.handshakeTimeoutMs ?? 10_000,
        perMessageDeflate: false,
      });
      const client = new CallClient(ws, t0, frameMs);
      const refuse = (error: ConnectError) => {
        try {
          ws.terminate();
        } catch {
          /* gone */
        }
        reject(error);
      };
      const onRefused = (_req: unknown, res: { statusCode?: number }) => refuse(new ConnectError('http', `the portal answered HTTP ${res.statusCode} to the WebSocket upgrade`, res.statusCode));
      const onError = (err: Error) => refuse(new ConnectError(/timed out/i.test(err.message) ? 'timeout' : 'socket', err.message));
      ws.once('unexpected-response', onRefused);
      ws.once('error', onError);
      ws.once('open', () => {
        ws.off('unexpected-response', onRefused);
        ws.off('error', onError);
        client.openedAt = client.now();
        resolve(client);
      });
    });
  }

  /** Milliseconds on the call's clock. */
  now(): number {
    return performance.now() - this.t0;
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Sends a JSON message to the server. */
  send(message: Record<string, unknown>): void {
    if (this.open) this.ws.send(JSON.stringify(message));
  }

  /** The `start` message, in the mode under test; its send time is the call's start (C0). */
  sendStart(mode: 'chat' | 'interview' | 'talk'): void {
    this.startSentAt = this.now();
    this.send({ type: 'start', mode });
  }

  // ---------------------------------------------------------------- the microphone

  /** Starts the microphone: frame 0 is due now, frame k at k * frameMs after that, silence unless a clip is queued. */
  startMic(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    this.micStartAt = this.now();
    this.loop();
  }

  /** The number of the next frame to be sent. */
  get nextFrame(): number {
    return this.frameIndex;
  }

  /** The absolute number of the first free frame: where a clip queued now would begin. */
  private get tailFrame(): number {
    return this.frameIndex + (this.queue.length - this.head);
  }

  /** Queues a clip right after what is queued (or at the next frame, when the queue is empty). Its last frame is padded with silence. */
  play(pcm: Buffer): PlayHandle {
    return this.put(pcm, this.tailFrame);
  }

  /**
   * Queues a clip so that its first frame is the first one due at or after `atT` (a time on the call's clock), with silence before it: the
   * interruption of a barge-in trial. A time already past, or a queue that is not empty yet, puts it right after what is queued.
   */
  injectAt(pcm: Buffer, atT: number): PlayHandle {
    const due = this.micStartAt === null ? this.tailFrame : Math.ceil((atT - this.micStartAt) / this.frameMs - 1e-9);
    return this.put(pcm, Math.max(due, this.tailFrame));
  }

  private put(pcm: Buffer, atFrame: number): PlayHandle {
    while (this.tailFrame < atFrame) this.queue.push(this.silenceFrame);
    const firstFrame = this.tailFrame;
    const frames = toFrames(pcm, this.frameBytes);
    for (const frame of frames) this.queue.push(frame);
    return { firstFrame, frames: frames.length };
  }

  private takeFrame(): Buffer {
    if (this.head >= this.queue.length) return this.silenceFrame;
    const frame = this.queue[this.head++];
    if (this.head >= 256 && this.head * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return frame;
  }

  private stopPump(): void {
    this.pumping = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
  }

  private noteOvershoot(late: number): void {
    this.overshoots.push(Math.max(0, late));
    if (this.overshoots.length > 8) this.overshoots.shift();
    this.margin = Math.min(20, Math.max(1.5, Math.max(...this.overshoots) + 1));
  }

  /** One step of the pacing loop: wait for the next frame's due time (timer, then spin), send it, hop to the event loop so incoming messages are stamped when they arrive. */
  private loop(): void {
    if (!this.pumping || this.micStartAt === null) return;
    if (!this.open) {
      this.stopPump();
      return;
    }
    const due = this.micStartAt + this.frameIndex * this.frameMs;
    const wait = due - this.now();
    if (wait > this.margin + 0.5) {
      const ms = wait - this.margin;
      const armedAt = this.now();
      this.timer = setTimeout(() => {
        this.timer = null;
        this.noteOvershoot(this.now() - (armedAt + ms));
        this.loop();
      }, ms);
      return;
    }
    if (wait > 0) {
      this.immediate = setImmediate(() => {
        this.immediate = null;
        this.loop();
      });
      return;
    }
    const index = this.frameIndex++;
    const frame = this.takeFrame();
    this.sentTimes[index] = this.now();
    this.ws.send(frame, { binary: true });
    this.notify();
    this.immediate = setImmediate(() => {
      this.immediate = null;
      this.loop();
    });
  }

  /** Resolves with the send time of microphone frame `index` as soon as it has been sent; null when the call closed first. */
  async frameSent(index: number): Promise<number | null> {
    await this.waitFor(() => this.sentTimes[index] !== undefined, Number.POSITIVE_INFINITY);
    return this.sentTimes[index] ?? null;
  }

  // ---------------------------------------------------------------- waiting

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter.check();
  }

  /**
   * Resolves true as soon as `predicate()` is true (checked now, after every message, after every frame sent and every `pollMs` when that is
   * given), false when `timeoutMs` pass or the socket closes first. The predicate reads `events`, `audio` and `sentTimes`; it must not throw.
   */
  waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 0): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      let poll: NodeJS.Timeout | null = null;
      const waiter: Waiter = {
        check: () => {
          if (predicate()) finish(true);
          else if (this.closed) finish(false);
        },
      };
      const finish = (ok: boolean) => {
        if (!this.waiters.delete(waiter)) return;
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        resolve(ok);
      };
      this.waiters.add(waiter);
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      if (pollMs > 0) poll = setInterval(() => waiter.check(), pollMs);
    });
  }

  /** The first event of this type (matching `match`) that arrived at or after `after`, or null after `timeoutMs` (or when the socket closed). */
  async waitForEvent(type: string, opts: { after?: number; match?: (ev: Record<string, unknown>) => boolean; timeoutMs: number }): Promise<ClientEvent | null> {
    const find = () => this.events.find((e) => e.ev.type === type && e.t >= (opts.after ?? 0) && (!opts.match || opts.match(e.ev))) ?? null;
    await this.waitFor(() => find() !== null, opts.timeoutMs);
    return find();
  }

  /** The first agent audio frame that arrived at or after `after`, or null after `timeoutMs` (or when the socket closed). */
  async waitForAudio(after: number, timeoutMs: number): Promise<AgentFrame | null> {
    const find = () => this.audio.find((a) => a.t >= after) ?? null;
    await this.waitFor(() => find() !== null, timeoutMs);
    return find();
  }

  /** Hangs up: `end`, then waits for the server's `closed` (the goodbye is in it) and drops the socket. */
  async end(closeWaitMs: number): Promise<void> {
    this.send({ type: 'end' });
    await this.waitFor(() => this.sawClosed, closeWaitMs);
    this.terminate();
  }

  /** Drops the socket and the timers now. */
  terminate(): void {
    this.stopPump();
    try {
      this.ws.terminate();
    } catch {
      /* gone */
    }
    this.closed = true;
    this.notify();
  }
}
