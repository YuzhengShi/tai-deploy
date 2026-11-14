/**
 * The ears for a Deepgram-compatible `/v1/listen` websocket (docs/VOICE_SELFBUILT.md 5.1): LabGPU's Qwen3-ASR adapter and hosted Deepgram nova-3 speak
 * the same protocol, so one client (`V1Ears`) serves both. The socket handling that every ears client needs lives in `WsEars`, which the Flux client
 * (flux.ts) extends too: connect with an overall timeout, one `down` for a connection that had been up, audio regrouped to the frame size the server
 * wants, no unbounded buffering, KeepAlive for a server that closes an idle socket, and the rule that no credential reaches a log line or an error.
 */
import type { ClientRequest, IncomingMessage } from 'http';

import { WebSocket } from 'ws';

import type { VoiceLog } from '../../types.js';
import type { Ears, EarsContext, EarsHandlers } from '../types.js';

const KEEP_ALIVE = JSON.stringify({ type: 'KeepAlive' });
const FINALIZE = JSON.stringify({ type: 'Finalize' });
const CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' });
/** Past this many bytes waiting in the socket the audio is dropped: a stalled network must not grow our memory, and old audio is no use to a live call. */
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long close() waits for the server's close frame before cutting the socket (ws itself waits 30 s). */
const CLOSE_GRACE_MS = 2000;
/** Everything a recognizer sends us is a small JSON message. */
const MAX_PAYLOAD = 1024 * 1024;

type State = 'idle' | 'connecting' | 'open' | 'down' | 'closed';

export interface WsEarsConfig {
  /** For the trace and the logs ('labgpu', 'nova', 'flux'). */
  name: string;
  /** Every binary message to the server has exactly this many bytes (a whole number of samples: even). LabGPU's adapter: 640 (20 ms), Deepgram: 2560 (80 ms). */
  frameBytes: number;
  /** Send a KeepAlive text message when nothing at all went out for this long. 0 or unset: never (LabGPU's adapter has no idle close; Deepgram closes a silent socket after 10 s). */
  keepAliveMs?: number;
  /** Frames are dropped while more than this many bytes wait in the socket. Default 1 MiB. */
  maxBufferedBytes?: number;
}

/** Thrown by code we trust (the Flux key reader) when its message is safe to show; any other error from a configuration callback is replaced by a generic one. */
export class EarsSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EarsSetupError';
  }
}

/**
 * The part of an ears client that does not depend on the protocol. The life of one instance is a single line: `connect()` (which may fail and be tried
 * again), then up, then at most one `down` (the socket went away by itself) or a `close()` by the engine. After either, build a new instance.
 *
 * How `down` and `connect` meet: a failure while `connect()` is pending (refused, timed out, a handshake that is not 101, `close()` called meanwhile)
 * only rejects the promise and never calls `down`; `down` is for a socket that had been up.
 */
export abstract class WsEars implements Ears {
  abstract readonly decidesTurn: boolean;
  readonly name: string;
  protected readonly log: VoiceLog;
  /** The websocket (protected so that tests can reach it; nothing else should). */
  protected socket: WebSocket | null = null;

  private state: State = 'idle';
  private readonly frameBytes: number;
  private readonly keepAliveMs: number;
  private readonly maxBuffered: number;
  /** The frame being filled: audio arrives in pieces of any size, the server gets frames of exactly `frameBytes`. */
  private frame: Buffer | null = null;
  private fill = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private abortConnect: ((message: string) => void) | null = null;
  private secrets: string[] = [];
  private congested = false;
  private droppedFrames = 0;

  protected constructor(
    cfg: WsEarsConfig,
    protected readonly handlers: EarsHandlers,
    protected readonly ctx: EarsContext,
  ) {
    if (!Number.isInteger(cfg.frameBytes) || cfg.frameBytes <= 0) throw new RangeError('ears: frameBytes must be a positive whole number');
    this.name = cfg.name;
    this.log = ctx.log;
    this.frameBytes = cfg.frameBytes;
    this.keepAliveMs = cfg.keepAliveMs && cfg.keepAliveMs > 0 ? cfg.keepAliveMs : 0;
    this.maxBuffered = cfg.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  /** The URL to open, read when `connect()` is called. It is never logged beyond its host: a query can carry course terms or, on some services, a key. */
  protected abstract connectUrl(): string;
  /** The handshake headers (credentials), read when `connect()` is called. Their values are scrubbed from every message this class writes. */
  protected abstract connectHeaders(): Record<string, string>;
  /** One JSON text message from the server, with the time (the engine's clock) at which it arrived. Binary messages never get here. */
  protected abstract onText(msg: Record<string, unknown>, at: number): void;
  /** The socket has just opened (Flux: nothing to do). */
  protected onOpen(): void {}

  get connected(): boolean {
    return this.state === 'open' && this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  connect(timeoutMs: number): Promise<void> {
    if (this.state !== 'idle') return Promise.reject(new Error(`${this.name}: cannot connect, the socket is ${this.state}`));
    let url: string;
    let headers: Record<string, string>;
    try {
      url = this.connectUrl();
      headers = this.connectHeaders();
      new URL(url);
    } catch (err) {
      // an error of our own may be shown; anything else could carry what we must not show (the URL, a key)
      return Promise.reject(new Error(err instanceof EarsSetupError ? err.message : `${this.name}: the URL or the headers could not be prepared`));
    }
    this.noteSecrets(headers);
    const host = hostOf(url);
    this.state = 'connecting';
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
      } catch {
        // ws puts the whole URL into its error message
        this.state = 'idle';
        reject(new Error(`${this.name}: the socket could not be created`));
        return;
      }
      this.socket = ws;
      // our own clock for the whole connect: ws's handshakeTimeout only starts once TCP is connected
      const timer = setTimeout(() => fail(`${this.name}: no handshake within ${timeoutMs} ms`), timeoutMs);
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortConnect = null;
        if (this.state === 'connecting') this.state = 'idle';
        if (this.socket === ws) this.socket = null;
        try {
          ws.terminate();
        } catch {
          /* gone */
        }
        this.log.debug({ ears: this.name, host, reason: message }, 'ears: connect failed');
        reject(new Error(message));
      };
      this.abortConnect = fail;

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortConnect = null;
        this.state = 'open';
        this.armKeepAlive();
        this.log.debug({ ears: this.name, host }, 'ears: connected');
        try {
          this.onOpen();
        } catch (err) {
          this.log.warn({ ears: this.name, err: this.scrubError(err) }, 'ears: the open hook threw');
        }
        resolve();
      });
      ws.on('unexpected-response', (_req: ClientRequest, res: IncomingMessage) => {
        fail(`${this.name}: the server refused the handshake (HTTP ${res.statusCode})`);
      });
      ws.on('error', (err: Error) => {
        if (!settled) fail(this.connectErrorMessage(err));
        else this.socketError(ws, err);
      });
      ws.on('close', (code: number, reason: Buffer) => {
        if (!settled) fail(`${this.name}: the socket closed during the handshake`);
        else this.socketClosed(ws, code, reason);
      });
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => this.socketMessage(ws, data, isBinary));
    });
  }

  /**
   * Audio of any piece size in, frames of `frameBytes` out, in order and without loss. The rest of a frame waits for the next call; it is sent (padded
   * with silence) only by `flushTail`. Not connected: dropped, never queued, because a call that was deaf for a moment must not hear it late.
   */
  sendAudio(pcm16: Buffer): void {
    if (this.state !== 'open' || pcm16.length === 0) return;
    let offset = 0;
    while (offset < pcm16.length) {
      if (!this.frame) {
        this.frame = Buffer.allocUnsafe(this.frameBytes);
        this.fill = 0;
      }
      const n = Math.min(this.frameBytes - this.fill, pcm16.length - offset);
      pcm16.copy(this.frame, this.fill, offset, offset + n);
      this.fill += n;
      offset += n;
      if (this.fill === this.frameBytes) {
        const frame = this.frame;
        this.frame = null;
        this.fill = 0;
        this.sendFrame(frame);
      }
    }
  }

  /**
   * Sends what is left of the frame being filled, padded with silence to a whole frame (so that the server still only ever sees `frameBytes`). Called
   * before a message that tells the server to end the turn now: otherwise up to one frame of the student's last word would still be waiting here.
   */
  protected flushTail(): void {
    if (!this.frame || this.fill === 0) return;
    this.frame.fill(0, this.fill);
    const frame = this.frame;
    this.frame = null;
    this.fill = 0;
    this.sendFrame(frame);
  }

  /** A text message to the server. False when it could not be sent (not up). */
  protected sendText(text: string): boolean {
    const ws = this.socket;
    if (!ws || this.state !== 'open' || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(text, { binary: false }, (err?: Error) => {
        if (err) this.log.debug({ ears: this.name, err: this.scrubError(err) }, 'ears: a text message could not be sent');
      });
      this.keepAliveTimer?.refresh();
      return true;
    } catch {
      return false;
    }
  }

  /** Calls one of the engine's handlers; whatever it throws is logged and does not reach the socket's event loop (where it would end the process). */
  protected safely(which: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.warn({ ears: this.name, handler: which, err: this.scrubError(err) }, 'ears: a handler threw');
    }
  }

  /** The socket is gone for good without the engine having asked: tell it once. */
  protected goDown(reason: string): void {
    if (this.state !== 'open') return;
    this.state = 'down';
    this.stopKeepAlive();
    this.frame = null;
    this.fill = 0;
    const ws = this.socket;
    this.socket = null;
    this.log.debug({ ears: this.name, reason }, 'ears: down');
    try {
      ws?.terminate();
    } catch {
      /* gone */
    }
    this.safely('down', () => this.handlers.down(reason));
  }

  /** Server-supplied or library text, with every credential we sent taken out and cut short. Use it for anything that goes into a log line or an error. */
  protected scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join('[redacted]');
    return out.length > 200 ? `${out.slice(0, 200)}...` : out;
  }

  protected scrubError(err: unknown): string {
    return this.scrub(err instanceof Error ? err.message : String(err));
  }

  /**
   * Idempotent, and silent from the first call: the engine has decided it does not want to hear this recognizer any more, so no handler is called
   * again (not even for messages already on the wire) and a `connect()` still pending is rejected.
   */
  close(): void {
    if (this.state === 'closed') return;
    const before = this.state;
    this.state = 'closed';
    this.stopKeepAlive();
    this.frame = null;
    this.fill = 0;
    const ws = this.socket;
    if (before === 'connecting') {
      this.abortConnect?.(`${this.name}: closed before it was connected`);
      return;
    }
    if (!ws) return;
    if (before === 'open' && ws.readyState === WebSocket.OPEN) {
      // CloseStream lets a hosted recognizer end the stream cleanly (LabGPU's adapter ignores it); no flush of the unfinished frame, nobody will hear the result
      try {
        ws.send(CLOSE_STREAM, { binary: false }, () => undefined);
        ws.close(1000);
      } catch {
        /* the terminate below ends it */
      }
      this.closeTimer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* gone */
        }
      }, CLOSE_GRACE_MS);
      this.closeTimer.unref?.();
    } else {
      try {
        ws.terminate();
      } catch {
        /* gone */
      }
    }
  }

  // ---------------------------------------------------------------- the socket's events

  private socketMessage(ws: WebSocket, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (this.socket !== ws || this.state !== 'open' || isBinary) return;
    const at = this.ctx.clock();
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(textOf(data));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    try {
      this.onText(msg, at);
    } catch (err) {
      this.log.warn({ ears: this.name, err: this.scrubError(err) }, 'ears: a message could not be handled');
    }
  }

  private socketError(ws: WebSocket, err: Error): void {
    if (this.socket !== ws || this.state !== 'open') return;
    const code = (err as NodeJS.ErrnoException).code;
    this.goDown(code ? `socket error (${code})` : `socket error: ${this.scrubError(err)}`);
  }

  private socketClosed(ws: WebSocket, code: number, reason: Buffer): void {
    if (this.socket !== ws) return;
    if (this.state === 'closed') {
      // we asked for it: nothing to tell
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      this.socket = null;
      return;
    }
    if (this.state !== 'open') return;
    const why = reason.length > 0 ? `: ${this.scrub(reason.toString('utf8'))}` : '';
    this.goDown(`socket closed (${code})${why}`);
  }

  // ---------------------------------------------------------------- sending

  private sendFrame(frame: Buffer): void {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > this.maxBuffered) {
      this.droppedFrames += 1;
      if (!this.congested) {
        this.congested = true;
        this.log.warn({ ears: this.name, bufferedBytes: ws.bufferedAmount }, 'ears: the socket is backed up, audio is being dropped');
      }
      return;
    }
    if (this.congested) {
      this.congested = false;
      this.log.info({ ears: this.name, droppedFrames: this.droppedFrames }, 'ears: the socket caught up');
      this.droppedFrames = 0;
    }
    try {
      ws.send(frame, { binary: true }, () => undefined);
      this.keepAliveTimer?.refresh();
    } catch {
      /* the socket is going away: its close event says so */
    }
  }

  /**
   * One timer that is pushed back by every send (`refresh`), so that it only ever fires after a whole `keepAliveMs` in which nothing at all went out,
   * never between audio frames. Firing sends a KeepAlive, and that send pushes the timer back again.
   */
  private armKeepAlive(): void {
    if (this.keepAliveMs <= 0 || this.keepAliveTimer) return;
    const timer = setTimeout(() => {
      if (this.state === 'open') this.sendText(KEEP_ALIVE);
    }, this.keepAliveMs);
    timer.unref?.();
    this.keepAliveTimer = timer;
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  // ---------------------------------------------------------------- what must not be shown

  /** Remembers every credential in the headers (the whole value and each long word of it: `Token abc123...` is shown by a server as `abc123...`). */
  private noteSecrets(headers: Record<string, string>): void {
    const found = new Set<string>();
    for (const value of Object.values(headers)) {
      if (value.length >= 6) found.add(value);
      for (const word of value.split(/\s+/)) if (word.length >= 8) found.add(word);
    }
    this.secrets = [...found].sort((a, b) => b.length - a.length);
  }

  /** A connect error in words of ours: ws's own text is not passed on (it can carry the address of the failure). */
  private connectErrorMessage(err: Error): string {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') return `${this.name}: connection refused`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${this.name}: host not found`;
    if (code === 'ETIMEDOUT') return `${this.name}: connection timed out`;
    if (code) return `${this.name}: connect failed (${code})`;
    return `${this.name}: connect failed (${this.scrubError(err)})`;
  }
}

function textOf(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------- the utterance

export interface ResultsMessage {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  fromFinalize: boolean;
}

export interface JoinedEvent {
  kind: 'partial' | 'final';
  text: string;
}

/** Letters and digits of a text, lower case, one space between words: two spellings of the same words (punctuation, case) compare equal. */
function wordsOf(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Adds a text to the pieces of the utterance so far. Deepgram's segments are separate pieces of speech and are appended. A server that repeats the
 * whole utterance so far in each message (LabGPU's adapter does in its partials and its final; whether it also marks them `is_final` is not known
 * from any recording, so both are handled) would be doubled by appending, so a text that begins with everything collected replaces it.
 * The price: a speaker whose second segment repeats the first one's words and goes on ("no" ... "no, I mean") loses the first "no". That costs a
 * repeated word; the alternative costs a garbled sentence on every turn if the adapter marks its partials final.
 */
function addPiece(pieces: string[], text: string): string[] {
  const have = wordsOf(pieces.join(' '));
  const incoming = wordsOf(text);
  if (have && (incoming === have || incoming.startsWith(`${have} `))) return [text];
  return [...pieces, text];
}

/**
 * Rebuilds one utterance from `Results` messages (the same job as `Utterance` in agent/asr.py of the distributed classroom, plus the repeat rule above).
 * Deepgram splits an utterance over several `is_final` segments and its `speech_final` message carries only the last one; LabGPU's adapter sends the
 * whole utterance in its `speech_final`. Partials are the pieces so far plus the current interim text. A final is released by `speech_final`, by
 * `from_finalize` (the answer to a Finalize) or by `UtteranceEnd` while pieces are waiting; an empty text never makes an event.
 */
export class UtteranceJoiner {
  private pieces: string[] = [];

  get pending(): boolean {
    return this.pieces.length > 0;
  }

  feed(result: ResultsMessage): JoinedEvent[] {
    const text = result.text.trim();
    if (result.speechFinal || result.fromFinalize) {
      if (text) this.pieces = addPiece(this.pieces, text);
      return this.release();
    }
    if (result.isFinal) {
      if (!text) return [];
      this.pieces = addPiece(this.pieces, text);
      return [{ kind: 'partial', text: this.pieces.join(' ') }];
    }
    return text ? [{ kind: 'partial', text: addPiece(this.pieces, text).join(' ') }] : [];
  }

  /** `UtteranceEnd`: whatever is waiting is the utterance. */
  flush(): JoinedEvent[] {
    return this.release();
  }

  private release(): JoinedEvent[] {
    const text = this.pieces.join(' ').trim();
    this.pieces = [];
    return text ? [{ kind: 'final', text }] : [];
  }
}

function flag(value: unknown): boolean {
  return value === true || value === 'true';
}

/** The fields of a Deepgram `Results` message that matter here, read defensively (a missing or odd field is an empty text and false flags). */
export function readResults(msg: Record<string, unknown>): ResultsMessage {
  const channel = msg.channel;
  const alternatives = channel && typeof channel === 'object' ? (channel as { alternatives?: unknown }).alternatives : undefined;
  const first: unknown = Array.isArray(alternatives) ? alternatives[0] : undefined;
  const transcript = first && typeof first === 'object' ? (first as { transcript?: unknown }).transcript : undefined;
  return {
    text: typeof transcript === 'string' ? transcript : '',
    isFinal: flag(msg.is_final),
    speechFinal: flag(msg.speech_final),
    fromFinalize: flag(msg.from_finalize),
  };
}

// ---------------------------------------------------------------- V1Ears

export interface V1EarsOptions {
  /** 'labgpu' or 'nova': for the trace and the logs. */
  name: string;
  /** The websocket URL with its query, or a function that makes it (read when `connect()` is called, so that nothing is fixed at construction). */
  url: string | (() => string);
  /** Handshake headers, read when `connect()` is called (hosted Deepgram: `Authorization: Token <key>`; LabGPU's adapter takes no credentials). */
  headers?: () => Record<string, string>;
  /** LabGPU's adapter: 640 (20 ms, what Nora's production code sends). Deepgram: 2560 (80 ms). */
  frameBytes: number;
  /** Hosted Deepgram wants a KeepAlive when nothing was sent for a while (the engine sets 4000); 0 or unset sends none. */
  keepAliveMs?: number;
  maxBufferedBytes?: number;
}

/**
 * The client for `/v1/listen`. It tells the engine the running text (`partial`) and the utterance's final (`final`), and nothing else: the adapter's
 * `SpeechStarted` comes about 1.1 s late and the engine has its own VAD, and which turn ends where is the engine's call (`decidesTurn` is false).
 */
export class V1Ears extends WsEars {
  readonly decidesTurn = false;
  private readonly joiner = new UtteranceJoiner();
  private readonly urlOf: () => string;
  private readonly headersOf: () => Record<string, string>;

  constructor(opts: V1EarsOptions, handlers: EarsHandlers, ctx: EarsContext) {
    super({ name: opts.name, frameBytes: opts.frameBytes, keepAliveMs: opts.keepAliveMs, maxBufferedBytes: opts.maxBufferedBytes }, handlers, ctx);
    const url = opts.url;
    this.urlOf = typeof url === 'function' ? url : () => url;
    this.headersOf = opts.headers ?? (() => ({}));
  }

  /**
   * Asks the server to answer now with what it has (`Finalize`). Hosted Deepgram does, with a `Results` marked `from_finalize`, which the joiner turns into a
   * final; LabGPU's adapter ignores the message (measured 2026-11-13), so for it this only sends the audio still waiting in the frame.
   */
  forceEndTurn(): void {
    this.flushTail();
    this.sendText(FINALIZE);
  }

  protected connectUrl(): string {
    return this.urlOf();
  }

  protected connectHeaders(): Record<string, string> {
    return this.headersOf();
  }

  protected onText(msg: Record<string, unknown>, at: number): void {
    switch (msg.type) {
      case 'Results':
        this.deliver(this.joiner.feed(readResults(msg)), at);
        return;
      case 'UtteranceEnd':
        this.deliver(this.joiner.flush(), at);
        return;
      case 'Error': {
        const what = typeof msg.description === 'string' ? msg.description : typeof msg.message === 'string' ? msg.message : 'no description';
        this.log.warn({ ears: this.name, what: this.scrub(what) }, 'ears: the recognizer reported an error');
        return;
      }
      default:
        // SpeechStarted (late on LabGPU's adapter, and the engine's VAD hears onsets), Metadata, and whatever a newer server adds
        return;
    }
  }

  private deliver(events: JoinedEvent[], at: number): void {
    for (const event of events) {
      if (event.kind === 'partial') this.safely('partial', () => this.handlers.partial(event.text, at));
      else this.safely('final', () => this.handlers.final(event.text, at, {}));
    }
  }
}
