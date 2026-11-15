/**
 * `FluxTtsMouth`: Deepgram's Flux TTS (the v2 speak WebSocket, voices `flux-<name>-<language>`) as a `Mouth`: the voice of today's call (`flux-hannah-en`, src/voice/config.ts), spoken the way that call speaks it.
 *
 *   wss://api.deepgram.com/v2/speak?model=flux-hannah-en&encoding=linear16&sample_rate=24000&mip_opt_out=true[&speed=1.2]    Authorization: Token <key>
 *   client:  {"type":"Speak","text":"..."}  {"type":"Flush"}  {"type":"Interrupt","playback_offset":{"type":"time_ms","value":N}}  {"type":"Configure","speed":1.15}  {"type":"Close"}
 *   server:  Connected, SpeechStarted{speech_id}, binary PCM16 frames, Flushed, SpeechMetadata{audio_duration_ms,...}, SpeechInterrupted{audio_played_ms,text_spoken,text_remaining}, Warning, Error
 *
 * WHY A SPEECH AND NOT A SENTENCE. The REST endpoint the lab's Aura mouth uses makes one independent request per sentence, and every one of them begins with the intonation of a new sentence: "every sentence
 * sounds like a new sentence" (the owner, 2026-11-15, on chain c). Flux TTS takes the text of a whole turn as it is written (`Speak` as often as you like), speaks it as ONE stream with the intonation
 * carried through (and across turns: the model keeps the conversation's state), and a `Flush` only says that the turn has ended. The owner heard the two ways on 2026-11-15 and chose the whole answer as one
 * turn (docs/LOCAL_VOICE.md 9.8, 9.9); one turn per sentence on the same socket sounded less connected to him.
 *
 * What was learnt from the service itself (probes of 2026-11-15, flux-hannah-en; the documentation says less):
 *   - the audio of a turn begins about 120 ms after its first text, before any Flush, and is made about 1.35 times faster than it plays;
 *   - the turns of a socket are served one after the other; the next turn's `SpeechStarted` follows the last one's `SpeechMetadata` at once;
 *   - `Flushed` is not the end of the audio: `SpeechMetadata` is (the audio frames come between them);
 *   - `Interrupt` while a turn has produced audio answers `SpeechInterrupted` and drops every turn queued behind it, and the socket stays usable; with no audio yet it is ignored (a Warning
 *     `NO_AUDIO_GENERATED`) and the turn goes on, so then the socket is dropped instead;
 *   - the `playback_offset` counts the audio the socket has MADE, not what was played: the offset of an interrupt is the audio received before the turn began plus what of the turn had played, and each
 *     interrupt's offset must be larger than the last (else `INVALID_INTERRUPT_OFFSET`); with that offset `text_spoken` is within a word or two of what was heard;
 *   - the session is closed after 60 s without a message from us (a WebSocket ping keeps it) and after an hour.
 *
 * One socket per call (this object is made per call), opened by `prepare` or by the first speech, and opened again by the next speech when it has gone away. The key is read at EVERY connection and goes
 * only into the Authorization header: no error message, log line or thrown value carries it, nor the text spoken, nor what the service said in an error (only its code).
 */
import { performance } from 'perf_hooks';

import { WebSocket } from 'ws';

import type { VoiceLog } from '../../types.js';
import { MouthError, type Mouth, type SpeechTurn, type SynthOptions, type TurnOptions, type TurnSplit } from '../types.js';

/** What a Flux voice looks like (it goes into a URL). */
const VOICE = /^flux-[a-z]+-[a-z]{2}$/;
/** What the key may look like: visible ASCII, no spaces (it goes into a header). */
const KEY = /^[\x21-\x7e]+$/;
/** Everything the service sends us as text is small. */
const MAX_PAYLOAD = 1024 * 1024;
const BYTES_PER_MS = 48;
const MAX_SPEAK_CHARS = 4000;

export interface FluxTtsMouthOptions {
  /** The Deepgram key, read at each connection. */
  apiKey: () => string;
  /** Default: Deepgram's API. ws or wss. */
  baseUrl?: string;
  /** The socket must be up within this long (default 3000 ms). */
  connectTimeoutMs?: number;
  /** A speech that is owed audio and hears nothing from the service for this long fails (default 8000 ms). */
  stallMs?: number;
  /** A ping this often keeps an idle socket open (the service closes one that is silent for 60 s; default 20000 ms). */
  pingMs?: number;
  /** How long an `Interrupt` may wait for its answer before the socket is dropped (default 1500 ms). */
  interruptWaitMs?: number;
  log?: VoiceLog;
}

/** The `speed` query value for a requested pace, or undefined: not set, not a number, or 1 once clamped to 0.5 to 1.5 and rounded to steps of 0.05 (Flux's default is 1). */
export function fluxSpeedParam(speed: number | undefined): string | undefined {
  if (speed === undefined || !Number.isFinite(speed)) return undefined;
  const steps = Math.round(Math.min(1.5, Math.max(0.5, speed)) * 20) / 20;
  const text = String(Number(steps.toFixed(2)));
  return text === '1' ? undefined : text;
}

class Turn implements SpeechTurn {
  readonly pieces: Buffer[] = [];
  /** `SpeechStarted` came for it: it is the turn the service is making. */
  started = false;
  /** At least one audio frame of it came. */
  audioSeen = false;
  /** It will get no more audio: complete, cut, or failed. */
  finished = false;
  /** Cut by `interrupt` or by the session going away quietly: its audio is dropped. */
  cancelled = false;
  /** Nobody reads it any more: its audio is dropped as it arrives, the service still makes it. */
  abandoned = false;
  /** Sent `Flush`. */
  ended = false;
  error: MouthError | null = null;
  /** The audio the session had received when this turn began: the start of the turn on the session's timeline, which is what `playback_offset` counts from. */
  baseMs = 0;
  durationMs: number | undefined;
  wake: (() => void) | null = null;

  constructor(private readonly session: Session) {}

  speak(text: string): string {
    return this.session.speak(this, text);
  }

  end(): void {
    this.session.end(this);
  }

  get audio(): AsyncIterable<Buffer> {
    return this.iterate();
  }

  interrupt(playedMs: number): Promise<TurnSplit | null> {
    return this.session.interrupt(this, playedMs);
  }

  abandon(): void {
    if (!this.finished) this.abandoned = true;
  }

  notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  private async *iterate(): AsyncGenerator<Buffer, void, undefined> {
    let carry: Buffer | null = null;
    try {
      for (;;) {
        const piece = this.pieces.shift();
        if (piece) {
          // PCM16: whole samples only (a frame is even in practice; one that is not is carried to the next)
          const data: Buffer = carry ? Buffer.concat([carry, piece]) : piece;
          carry = null;
          if (data.length % 2) {
            carry = data.subarray(data.length - 1);
            if (data.length === 1) continue;
            yield data.subarray(0, data.length - 1);
          } else yield data;
          continue;
        }
        if (this.finished) break;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
      if (this.error) throw this.error;
    } finally {
      // the reader stopped before the end (a `return`): what is still to come is dropped
      if (!this.finished) this.abandoned = true;
    }
  }
}

class Session {
  readonly turns: Turn[] = [];
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  /** The turn the service is making now (between its SpeechStarted and its SpeechMetadata). */
  private active: Turn | null = null;
  private socket: WebSocket | null = null;
  private outbox: string[] = [];
  /** Audio received from the service on this socket, all turns, whatever became of it: the session's timeline. */
  private receivedMs = 0;
  private lastOffset = 0;
  private interrupting: { resolve: (split: TurnSplit | null) => void; timer: NodeJS.Timeout } | null = null;
  private lastRx = performance.now();
  private watchdog: NodeJS.Timeout | null = null;
  private pinger: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  speed: string | undefined;

  constructor(
    private readonly host: { baseUrl: string; readKey(): string; ended(session: Session): void },
    readonly voice: string,
    speed: string | undefined,
    private readonly o: Required<Pick<FluxTtsMouthOptions, 'connectTimeoutMs' | 'stallMs' | 'pingMs' | 'interruptWaitMs'>>,
    private readonly log: VoiceLog | undefined,
  ) {
    this.speed = speed;
    this.connect();
  }

  // ---------------------------------------------------------------- connecting

  private connect(): void {
    let key: string;
    try {
      key = this.host.readKey();
    } catch (err) {
      this.fail(err instanceof MouthError ? err : new MouthError('down', 'the Deepgram key is not available'));
      return;
    }
    const url = `${this.host.baseUrl}/v2/speak?model=${this.voice}&encoding=linear16&sample_rate=24000&mip_opt_out=true${this.speed ? `&speed=${this.speed}` : ''}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` }, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
    } catch {
      this.fail(new MouthError('down', 'Flux TTS could not be reached'));
      return;
    }
    this.socket = ws;
    this.connectTimer = setTimeout(() => this.fail(new MouthError('down', 'Flux TTS did not answer in time')), this.o.connectTimeoutMs);
    this.connectTimer.unref?.();
    ws.on('open', () => {
      if (this.state !== 'connecting') return;
      this.state = 'open';
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.lastRx = performance.now();
      this.pinger = setInterval(() => {
        try {
          ws.ping();
        } catch {
          /* closing */
        }
      }, this.o.pingMs);
      this.pinger.unref?.();
      this.watchdog = setInterval(() => this.checkStall(), 1000);
      this.watchdog.unref?.();
      this.flushOutbox();
    });
    ws.on('unexpected-response', (_req, res) => this.fail(new MouthError('down', `Flux TTS refused the connection (HTTP ${res.statusCode ?? 0})`)));
    ws.on('error', () => this.fail(new MouthError('down', 'Flux TTS connection failed')));
    ws.on('close', () => this.fail(new MouthError('down', 'Flux TTS closed the connection')));
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
  }

  private checkStall(): void {
    if (this.state !== 'open') return;
    if (!this.turns.some((t) => !t.finished)) return;
    if (performance.now() - this.lastRx > this.o.stallMs) this.fail(new MouthError('down', 'Flux TTS stopped answering'));
  }

  // ---------------------------------------------------------------- what we send

  /** A message goes out now when the socket is up and no interrupt is waiting for its answer, else when it is. */
  private post(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    if (this.state === 'open' && !this.interrupting) this.send(text);
    else if (this.state !== 'closed') this.outbox.push(text);
  }

  private send(text: string): void {
    try {
      this.socket?.send(text);
    } catch {
      this.fail(new MouthError('down', 'Flux TTS connection failed'));
    }
  }

  private flushOutbox(): void {
    if (this.state !== 'open' || this.interrupting) return;
    for (const text of this.outbox.splice(0)) this.send(text);
  }

  newTurn(): Turn {
    const turn = new Turn(this);
    if (this.state === 'closed') {
      turn.finished = true;
      turn.error = this.closedWith ?? new MouthError('down', 'Flux TTS is not connected');
    } else this.turns.push(turn);
    return turn;
  }

  speak(turn: Turn, text: string): string {
    const clean = text.trim();
    if (!clean || turn.finished || turn.ended) return '';
    const sent = clean.slice(0, MAX_SPEAK_CHARS);
    // the service adds no whitespace between messages: one is put after every piece
    this.post({ type: 'Speak', text: `${sent} ` });
    return sent;
  }

  end(turn: Turn): void {
    if (turn.finished || turn.ended) return;
    turn.ended = true;
    this.post({ type: 'Flush' });
  }

  /** Changes the pace of the speeches that follow (`Configure`: it applies at the next segment boundary, and is answered with ConfigureSuccess or ConfigureFailure, which are not waited for). */
  configureSpeed(speed: string | undefined): void {
    if (speed === this.speed) return;
    this.speed = speed;
    this.post({ type: 'Configure', speed: speed ? Number(speed) : 1 });
  }

  // ---------------------------------------------------------------- what comes back

  private onMessage(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (this.state === 'closed') return;
    this.lastRx = performance.now();
    if (isBinary) {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.receivedMs += buf.length / BYTES_PER_MS;
      const t = this.active;
      if (!t || t.cancelled || t.abandoned) return;
      t.audioSeen = true;
      t.pieces.push(buf);
      t.notify();
      return;
    }
    let m: Record<string, unknown>;
    try {
      const raw = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      m = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.type) {
      case 'SpeechStarted': {
        const t = this.turns.find((x) => !x.started && !x.finished);
        if (!t) {
          // a speech we cancelled came back: it would hold up the next one for as long as it lasts
          this.log?.warn({}, 'voice lab: Flux TTS began a speech nobody is waiting for; the connection is dropped');
          this.reset();
          return;
        }
        t.started = true;
        t.baseMs = Math.round(this.receivedMs);
        this.active = t;
        return;
      }
      case 'SpeechMetadata': {
        const t = this.active;
        if (!t) return;
        if (typeof m.audio_duration_ms === 'number') t.durationMs = m.audio_duration_ms;
        this.finish(t);
        return;
      }
      case 'SpeechInterrupted': {
        const reply = this.interrupting;
        if (typeof m.audio_played_ms === 'number') this.lastOffset = Math.max(this.lastOffset, m.audio_played_ms);
        this.interrupting = null;
        if (reply) clearTimeout(reply.timer);
        // every speech that was outstanding is gone with it (the service drops the ones queued behind)
        for (const t of this.turns.splice(0)) this.cancel(t);
        this.active = null;
        const spoken = typeof m.text_spoken === 'string' ? m.text_spoken : null;
        const remaining = typeof m.text_remaining === 'string' ? m.text_remaining : '';
        reply?.resolve(spoken === null ? null : wholeWords(spoken, remaining));
        this.flushOutbox();
        return;
      }
      case 'Warning': {
        const code = typeof m.code === 'string' ? m.code : '?';
        if (code === 'NO_AUDIO_GENERATED' || code === 'INVALID_INTERRUPT_OFFSET') {
          this.log?.warn({ code }, 'voice lab: Flux TTS ignored an interrupt; the connection is dropped');
          this.reset();
        } else this.log?.info({ code }, 'voice lab: a Flux TTS warning');
        return;
      }
      case 'Error': {
        const code = typeof m.code === 'string' ? m.code : '?';
        this.fail(new MouthError('down', `Flux TTS refused (${code})`));
        return;
      }
      default:
        return;
    }
  }

  private finish(t: Turn): void {
    t.finished = true;
    const at = this.turns.indexOf(t);
    if (at >= 0) this.turns.splice(at, 1);
    if (this.active === t) this.active = null;
    t.notify();
  }

  private cancel(t: Turn): void {
    t.cancelled = true;
    t.finished = true;
    t.pieces.length = 0;
    t.notify();
  }

  // ---------------------------------------------------------------- interrupting

  /**
   * The student spoke. With audio made for the active speech: `Interrupt` with the offset on the session's timeline (everything received before the speech began plus what of it had played), and the
   * answer gives what was heard. Anything else (nothing made yet, a socket that is not up, an interrupt already waiting): the connection is dropped, which also drops what the service had queued.
   */
  interrupt(turn: Turn, playedMs: number): Promise<TurnSplit | null> {
    if (turn.finished) return Promise.resolve(null);
    const hadAudio = this.active === turn && turn.audioSeen;
    for (const t of this.turns.filter((x) => !x.finished)) this.cancel(t);
    if (this.state !== 'open' || this.interrupting || !hadAudio) {
      this.reset();
      return Promise.resolve(null);
    }
    const offset = Math.max(this.lastOffset + 1, Math.round(turn.baseMs + Math.max(0, playedMs)));
    this.lastOffset = offset;
    return new Promise<TurnSplit | null>((resolve) => {
      const timer = setTimeout(() => {
        this.log?.warn({}, 'voice lab: Flux TTS did not answer an interrupt; the connection is dropped');
        this.reset();
        resolve(null);
      }, this.o.interruptWaitMs);
      timer.unref?.();
      this.interrupting = { resolve, timer };
      this.send(JSON.stringify({ type: 'Interrupt', playback_offset: { type: 'time_ms', value: offset } }));
    });
  }

  // ---------------------------------------------------------------- the end of the connection

  private closedWith: MouthError | null = null;

  /** The connection is over and the speeches that were owed audio failed (after the audio that had come). */
  fail(err: MouthError): void {
    if (this.state === 'closed') return;
    this.closedWith = err;
    this.shutdown();
    for (const t of this.turns.splice(0)) {
      if (t.finished) continue;
      t.error = err;
      t.finished = true;
      t.notify();
    }
    this.resolveInterrupt(null);
  }

  /** The connection is dropped on purpose: what was owed ends quietly, and the next speech opens another. */
  reset(): void {
    if (this.state === 'closed') return;
    this.closedWith = new MouthError('down', 'Flux TTS connection was reset');
    this.shutdown();
    for (const t of this.turns.splice(0)) this.cancel(t);
    this.resolveInterrupt(null);
  }

  /** The call is over. */
  close(): void {
    if (this.state === 'closed') return;
    const socket = this.socket;
    if (this.state === 'open') {
      try {
        socket?.send(JSON.stringify({ type: 'Close' }));
      } catch {
        /* going away */
      }
    }
    this.closedWith = new MouthError('down', 'Flux TTS is closed');
    this.shutdown(1500);
    for (const t of this.turns.splice(0)) this.cancel(t);
    this.resolveInterrupt(null);
  }

  private resolveInterrupt(split: TurnSplit | null): void {
    const reply = this.interrupting;
    this.interrupting = null;
    if (reply) {
      clearTimeout(reply.timer);
      reply.resolve(split);
    }
  }

  private shutdown(graceMs = 0): void {
    this.state = 'closed';
    this.active = null;
    this.outbox.length = 0;
    for (const timer of [this.watchdog, this.pinger, this.connectTimer]) if (timer) clearTimeout(timer);
    this.watchdog = this.pinger = this.connectTimer = null;
    const socket = this.socket;
    if (!socket) return;
    const cut = (): void => {
      try {
        socket.terminate();
      } catch {
        /* gone */
      }
    };
    if (graceMs > 0) {
      const timer = setTimeout(cut, graceMs);
      timer.unref?.();
      socket.once('close', () => clearTimeout(timer));
    } else cut();
    this.host.ended(this);
  }
}

/** What the service says was spoken, cut at a whole word: its split can fall inside one, and a half word is not what the model said. */
export function wholeWords(spoken: string, remaining: string): TurnSplit {
  const insideWord = spoken.length > 0 && remaining.length > 0 && !/\s$/.test(spoken) && !/^\s/.test(remaining);
  if (!insideWord) return { spoken: spoken.trim(), remaining: remaining.trim() };
  const cut = spoken.search(/\S+$/);
  const head = cut > 0 ? spoken.slice(0, cut) : '';
  return { spoken: head.trim(), remaining: `${spoken.slice(cut)}${remaining}`.trim() };
}

export class FluxTtsMouth implements Mouth {
  readonly name = 'flux';
  readonly takesSpeed = true;
  readonly prewarm = false;
  readonly baseUrl: string;
  private readonly apiKey: () => string;
  private readonly o: Required<Pick<FluxTtsMouthOptions, 'connectTimeoutMs' | 'stallMs' | 'pingMs' | 'interruptWaitMs'>>;
  private readonly log: VoiceLog | undefined;
  private session: Session | null = null;

  constructor(options: FluxTtsMouthOptions) {
    if (typeof options.apiKey !== 'function') throw new TypeError('FluxTtsMouth: apiKey must be a function');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'wss://api.deepgram.com').replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      throw new TypeError('FluxTtsMouth: baseUrl is not a URL');
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError('FluxTtsMouth: baseUrl must be ws or wss');
    this.o = { connectTimeoutMs: options.connectTimeoutMs ?? 3000, stallMs: options.stallMs ?? 8000, pingMs: options.pingMs ?? 20_000, interruptWaitMs: options.interruptWaitMs ?? 1500 };
    for (const [name, value] of Object.entries(this.o)) if (!Number.isFinite(value) || value <= 0) throw new RangeError(`FluxTtsMouth: ${name} must be a positive number`);
    this.log = options.log;
  }

  /** The key, or a MouthError with fixed words: whatever `apiKey` threw or returned is never repeated. */
  readKey(): string {
    let key: unknown;
    try {
      key = this.apiKey();
    } catch {
      throw new MouthError('down', 'the Deepgram key is not available');
    }
    if (typeof key !== 'string' || !KEY.test(key)) throw new MouthError('down', 'the Deepgram key is not available');
    return key;
  }

  private sessionFor(opts: TurnOptions): Session {
    if (typeof opts.voice !== 'string' || !VOICE.test(opts.voice)) throw new Error('Flux TTS: the voice must look like flux-hannah-en');
    const speed = fluxSpeedParam(opts.speed);
    const have = this.session;
    if (have && have.state !== 'closed' && have.voice === opts.voice) {
      have.configureSpeed(speed);
      return have;
    }
    have?.close();
    // a session that has ended makes the next speech open another
    const host = { baseUrl: this.baseUrl, readKey: () => this.readKey(), ended: (s: Session) => void (this.session === s ? (this.session = null) : undefined) };
    this.session = new Session(host, opts.voice, speed, this.o, this.log);
    return this.session;
  }

  prepare(opts: TurnOptions): void {
    try {
      this.sessionFor(opts);
    } catch {
      /* a bad voice shows when the first speech is opened */
    }
  }

  openTurn(opts: TurnOptions): SpeechTurn {
    return this.sessionFor(opts).newTurn();
  }

  /** One sentence as a speech of its own (the engine's lines that are not an answer: the greeting, a filler). */
  synthesize(text: string, opts: SynthOptions): AsyncIterable<Buffer> {
    return this.run(text, opts);
  }

  private async *run(text: string, opts: SynthOptions): AsyncGenerator<Buffer, void, undefined> {
    if (opts.signal?.aborted || !text.trim()) return;
    const turn = this.openTurn({ voice: opts.voice, speed: opts.speed });
    const onAbort = (): void => void turn.interrupt(0);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      turn.speak(text);
      turn.end();
      for await (const piece of turn.audio) yield piece;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  close(): void {
    this.session?.close();
    this.session = null;
  }
}
