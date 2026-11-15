/**
 * A stand-in for Deepgram's Flux TTS (`wss://api.deepgram.com/v2/speak`, voices `flux-<name>-<language>`), for tests. It follows the documentation (developers.deepgram.com/docs/flux-tts: client
 * messages Speak, Flush, Interrupt, Configure, Close; server messages Connected, SpeechStarted, Flushed, SpeechMetadata, SpeechInterrupted, SessionMetadata, Warning, Error) and what a probe of the
 * real service showed on 2026-11-15:
 *   - a turn is the text between two Flushes; the turns of one socket are served one after the other, the next one starting the instant the one before has sent its `SpeechMetadata`;
 *   - the audio of a turn arrives between its `SpeechStarted` and its `SpeechMetadata` (a little faster than real time), and may begin before the Flush;
 *   - `Interrupt` while a turn has produced audio answers `SpeechInterrupted` and also drops the turns queued behind it; the socket stays usable. With no audio yet it answers the warning
 *     `NO_AUDIO_GENERATED` and changes nothing;
 *   - `Close` drains the queued turns, then sends `SessionMetadata` and closes.
 * The audio is a sine tone whose pitch is a function of the turn's number (200 Hz + 40 Hz per turn), so that a test can tell whose audio it holds. It records what a client sends and the request
 * (path, query, headers). Loopback only; nothing here ever reads a real key.
 */
import type http from 'http';
import { performance } from 'perf_hooks';

import type { WebSocket } from 'ws';

import { FakeConnectionBase, startFakeWsHost, type FakeHandshake, type FakeWsHost } from './fake-asr.js';
import { tonePcm } from './fake-tts.js';

export interface FakeFluxTtsOptions extends FakeHandshake {
  /** Wall-clock milliseconds the server takes to send one frame (default 20). */
  frameWallMs?: number;
  /** Milliseconds of audio in one frame (default 40: twice real time at the default wall time). */
  frameAudioMs?: number;
  /** Milliseconds of audio per character of text (default 60). */
  msPerChar?: number;
  /** Wall-clock milliseconds between a turn starting and its first frame (default 30). */
  startDelayMs?: number;
  /** Send `SpeechStarted` as soon as the first text of a turn arrives and the audio before the Flush (default false: the turn is served when it has been flushed). */
  startBeforeFlush?: boolean;
  /** The turn with this index (0 = the first one on the socket) says `SpeechStarted` and then nothing at all. */
  silentTurn?: number;
  /** Cut the connection (no close frame) after this many frames of the turn with index `dropTurn`. */
  dropAfterFrames?: number;
  dropTurn?: number;
  /** Answer the first Speak with a fatal Error message and close. */
  errorOnSpeak?: boolean;
  /** Never answer an Interrupt (for the client's own timeout). */
  ignoreInterrupt?: boolean;
  /** Authorization header the server wants (`Token <key>`); another one is refused with 401 and recorded as a violation. */
  expectedKey?: string;
  /** Only the first this-many connections obey the misbehaviour settings above (`silentTurn`, `dropAfterFrames`, `errorOnSpeak`, `ignoreInterrupt`): the ones after them are a service that has recovered. Default: all. */
  misbehaveFirst?: number;
}

interface Turn {
  index: number;
  id: string;
  text: string;
  flushed: boolean;
  startedSent: boolean;
  frames: number;
  totalFrames: number;
  done: boolean;
}

const VOICE = /^flux-[a-z]+-[a-z]{2}$/;
const hex12 = (n: number): string => (0xa1b2c3d4e5f6 + n * 0x111111).toString(16).padStart(12, '0').slice(-12);

export class FakeFluxTtsConnection extends FakeConnectionBase {
  readonly turns: Turn[] = [];
  /** What the server found wrong with the request or the client's messages (empty when the client behaved). */
  readonly violations: string[] = [];
  /** The value of the last `Configure.speed` accepted. */
  configuredSpeed: number | undefined;
  interruptCount = 0;
  interruptsAnswered = 0;
  /** What the server said was spoken for each Interrupt it answered: the played offset and the text on each side of the cut (as the service's own `text_spoken` and `text_remaining`). */
  readonly interruptReplies: Array<{ playedMs: number; spoken: string; remaining: string }> = [];
  private readonly o: FakeFluxTtsOptions;
  private timer: NodeJS.Timeout | null = null;
  private current: Turn | null = null;
  private nextIndex = 0;
  private closing = false;
  private killed = false;

  constructor(
    ws: WebSocket,
    req: http.IncomingMessage,
    options: FakeFluxTtsOptions,
    readonly index = 0,
  ) {
    super(ws, req, false);
    // a service that has recovered: the connections after the first few take none of the misbehaviour settings
    const behaves = index >= (options.misbehaveFirst ?? Infinity);
    this.o = behaves ? { ...options, silentTurn: undefined, dropAfterFrames: undefined, dropTurn: undefined, errorOnSpeak: false, ignoreInterrupt: false } : options;
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        this.violations.push('the client sent a binary message');
        return;
      }
      const raw = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString('utf8');
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.violations.push('a message that is not JSON');
        return;
      }
      this.onClient(m);
    });
    ws.on('close', () => {
      this.killed = true;
      if (this.timer) clearTimeout(this.timer);
    });
    const q = this.url.searchParams;
    if (this.url.pathname !== '/v2/speak') this.violations.push(`path ${this.url.pathname} is not /v2/speak`);
    if (!VOICE.test(q.get('model') ?? '')) this.violations.push('model is not a flux voice');
    if ((q.get('encoding') ?? 'linear16') !== 'linear16') this.violations.push('encoding is not linear16');
    if (q.get('sample_rate') !== '24000') this.violations.push('sample_rate is not 24000');
    for (const bad of ['container', 'bit_rate']) if (q.has(bad)) this.violations.push(`${bad} is a batch-only parameter`);
    if (q.has('speed')) {
      const v = Number(q.get('speed'));
      if (!(v >= 0.5 && v <= 1.5) || Math.abs(v * 20 - Math.round(v * 20)) > 1e-9) this.violations.push('speed is not 0.5 to 1.5 in steps of 0.05');
      this.configuredSpeed = v;
    }
    this.sendJson({ type: 'Connected', request_id: '550e8400-e29b-41d4-a716-446655440000', model_name: q.get('model') ?? '', model_version: 'fake', model_uuids: [] });
  }

  get authorization(): string | undefined {
    return this.req.headers.authorization;
  }

  get query(): URLSearchParams {
    return this.url.searchParams;
  }

  /** The text of every Speak the client sent, in order. */
  speaks(): string[] {
    return this.textsOfType('Speak').map((t) => String(t.json?.text ?? ''));
  }

  /** The `type` of every message the client sent, in order. */
  clientTypes(): string[] {
    return this.texts.map((t) => String(t.json?.type ?? '?'));
  }

  /** The text of the turns the server served, one per turn. */
  turnTexts(): string[] {
    return this.turns.map((t) => t.text);
  }

  private onClient(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'Speak': {
        if (typeof m.text !== 'string') {
          this.violations.push('Speak without text');
          return;
        }
        if (this.o.errorOnSpeak) {
          this.sendJson({ type: 'Error', code: 'MESSAGE-0000', description: 'fake: told to fail' });
          setTimeout(() => this.close(1011, 'error'), 5);
          return;
        }
        let t = this.turns[this.turns.length - 1];
        if (!t || t.flushed) {
          t = { index: this.nextIndex++, id: `dg_sp_${hex12(this.nextIndex)}`, text: '', flushed: false, startedSent: false, frames: 0, totalFrames: 0, done: false };
          this.turns.push(t);
        }
        t.text += m.text;
        this.pump();
        return;
      }
      case 'Flush': {
        const t = this.turns[this.turns.length - 1];
        if (!t || t.flushed || t.done) {
          this.sendJson({ type: 'Warning', code: 'NO_ACTIVE_SPEECH', description: 'There is no active turn. The request will be ignored.' });
          return;
        }
        t.flushed = true;
        this.pump();
        return;
      }
      case 'Interrupt':
        this.interruptCount++;
        if (this.o.ignoreInterrupt) return;
        this.onInterrupt(m);
        return;
      case 'Configure': {
        const v = m.speed;
        if (typeof v === 'number' && v >= 0.5 && v <= 1.5 && Math.abs(v * 20 - Math.round(v * 20)) < 1e-9) {
          this.configuredSpeed = v;
          this.sendJson({ type: 'ConfigureSuccess', speed: v });
        } else this.sendJson({ type: 'ConfigureFailure', code: 'SPEED_OUT_OF_RANGE', description: 'fake' });
        return;
      }
      case 'Close':
        this.closing = true;
        this.pump();
        return;
      default:
        this.violations.push(`unknown client message ${String(m.type)}`);
    }
  }

  private onInterrupt(m: Record<string, unknown>): void {
    const t = this.current;
    if (!t || t.frames === 0) {
      this.sendJson({ type: 'Warning', code: 'NO_AUDIO_GENERATED', description: 'No audio has been generated yet. The request will be ignored.' });
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const offset = (m.playback_offset as { value?: number } | undefined)?.value;
    const playedMs = typeof offset === 'number' ? offset : t.frames * (this.o.frameAudioMs ?? 40);
    const totalMs = Math.max(1, t.totalFrames * (this.o.frameAudioMs ?? 40));
    const cut = Math.min(t.text.length, Math.round((playedMs / totalMs) * t.text.length));
    // the turns queued behind it are dropped as well
    for (const q of this.turns) if (!q.done) q.done = true;
    this.current = null;
    this.interruptsAnswered++;
    if (typeof offset === 'number') this.interruptReplies.push({ playedMs, spoken: t.text.slice(0, cut), remaining: t.text.slice(cut) });
    this.sendJson({
      type: 'SpeechInterrupted',
      audio_played_ms: playedMs,
      ...(typeof offset === 'number' ? { text_spoken: t.text.slice(0, cut), text_remaining: t.text.slice(cut) } : {}),
      metadata: { speech_id: t.id, audio_duration_ms: playedMs, input_character_count: t.text.length, billable_character_count: t.text.length },
    });
  }

  /** Serve the next turn when none is being served. */
  private pump(): void {
    if (this.killed || this.current) return;
    const next = this.turns.find((t) => !t.done && (t.flushed || (this.o.startBeforeFlush && t.text.length > 0)));
    if (!next) {
      if (this.closing && this.turns.every((t) => t.done)) {
        this.sendJson({ type: 'SessionMetadata', total_audio_duration_ms: 0, total_input_character_count: 0, total_billable_character_count: 0 });
        setTimeout(() => this.close(1000, ''), 5);
      }
      return;
    }
    this.current = next;
    this.sendJson({ type: 'SpeechStarted', speech_id: next.id });
    if (next.flushed) this.sendJson({ type: 'Flushed', speech_id: next.id });
    if (this.o.silentTurn === next.index) return;
    this.timer = setTimeout(() => this.frame(next), this.o.startDelayMs ?? 30);
  }

  private frame(t: Turn): void {
    if (this.killed || this.current !== t) return;
    const frameMs = this.o.frameAudioMs ?? 40;
    if (!t.flushed && this.o.startBeforeFlush) {
      // not flushed yet: speak what has arrived so far, and wait for more
      t.totalFrames = Math.max(t.totalFrames, Math.ceil((t.text.length * (this.o.msPerChar ?? 60)) / frameMs));
    } else t.totalFrames = Math.max(1, Math.ceil((t.text.length * (this.o.msPerChar ?? 60)) / frameMs));
    if (t.frames >= t.totalFrames) {
      if (!t.flushed) {
        this.timer = setTimeout(() => this.frame(t), this.o.frameWallMs ?? 20);
        return;
      }
      this.finish(t);
      return;
    }
    if (this.o.dropAfterFrames !== undefined && this.o.dropTurn === t.index && t.frames >= this.o.dropAfterFrames) {
      this.terminate();
      return;
    }
    const samples = Math.round((frameMs * 24000) / 1000);
    this.sendRaw(tonePcm(samples, t.frames * samples, 200 + 40 * t.index), true);
    t.frames++;
    this.timer = setTimeout(() => this.frame(t), this.o.frameWallMs ?? 20);
  }

  private finish(t: Turn): void {
    t.done = true;
    this.current = null;
    const ms = t.frames * (this.o.frameAudioMs ?? 40);
    this.sendJson({
      type: 'SpeechMetadata',
      speech_id: t.id,
      audio_duration_ms: ms,
      input_character_count: t.text.length,
      billable_character_count: t.text.length,
      controls_applied: { pronunciations_applied: 0, breaks_applied: 0, pronunciation_warnings: 0 },
    });
    this.pump();
  }
}

export class FakeFluxTts {
  readonly connections: FakeFluxTtsConnection[] = [];
  readonly options: FakeFluxTtsOptions;
  private host: FakeWsHost | null = null;
  private readonly refused: string[] = [];

  private constructor(options: FakeFluxTtsOptions) {
    this.options = options;
  }

  static async start(options: FakeFluxTtsOptions = {}): Promise<FakeFluxTts> {
    const fake = new FakeFluxTts(options);
    fake.host = await startFakeWsHost(
      () => {
        // an Authorization header other than the expected one is a refusal at the handshake, as the real service answers a bad key
        return options;
      },
      (ws, req) => {
        if (options.expectedKey !== undefined && req.headers.authorization !== `Token ${options.expectedKey}`) {
          fake.refused.push(String(req.headers.authorization ?? 'none').slice(0, 6));
          ws.close(1008, 'unauthorized');
          return;
        }
        fake.connections.push(new FakeFluxTtsConnection(ws, req, options, fake.connections.length));
      },
    );
    return fake;
  }

  get port(): number {
    return this.host?.port ?? 0;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** How many connections the server turned away for a wrong key. */
  get refusedCount(): number {
    return this.refused.length;
  }

  /** The last connection opened. */
  get last(): FakeFluxTtsConnection {
    const c = this.connections[this.connections.length - 1];
    if (!c) throw new Error('no connection yet');
    return c;
  }

  get violations(): string[] {
    return this.connections.flatMap((c) => c.violations);
  }

  async close(): Promise<void> {
    await this.host?.close();
    this.host = null;
  }
}

/** Milliseconds since a reference, for the tests' own timing. */
export const now = (): number => performance.now();
