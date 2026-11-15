/**
 * One call's stand-in for Deepgram's Voice Agent (docs/VOICE_SELFBUILT.md section 3): the socket `VoiceSession` talks to, speaking the same V1 agent protocol, with our own ears,
 * turn-taking, think step, mouth and barge-in behind it. The session is unmodified: it sends Settings, audio, UpdateThink/UpdateSpeak/UpdateListen/UpdatePrompt, InjectAgentMessage,
 * InjectUserMessage and FunctionCallResponse, and expects Welcome, SettingsApplied, UserStartedSpeaking, ConversationText, AgentThinking, FunctionCallRequest, audio, AgentAudioDone and
 * LatencyReport, and no AgentStartedSpeaking (the live service never sends it).
 *
 * Inside: audio -> VAD (onset, end of speech) and ears -> turn policy -> commit -> think (the relay, streamed, cut into sentences) -> speaker (synthesis, pacing) -> audio out; a barge-in
 * stops the speaker, aborts the model request, cancels pending functions and cuts the history to what was spoken. Every external piece is injected (ears and mouth factories, the clock,
 * fetch), so the whole of it runs against fakes in tests.
 */
import { randomBytes } from 'crypto';

import { WebSocket, type RawData } from 'ws';

import type { VoiceLog } from '../types.js';
import { lines } from '../prompts.js';
import type { LabConfig, MouthKind, EarsKind } from './config.js';
import { turnParamsFor } from './config.js';
import { LabHistory, type ToolCall } from './history.js';
import { PcmCache } from './mouth/cache.js';
import { applyGain } from './mouth/level.js';
import { spokenText } from './mouth/spoken.js';
import { stretch } from './mouth/tempo.js';
import { SentenceCutter } from './sentences.js';
import { Speaker, wordsPlayed, type SpokenReport } from './speaker.js';
import { think, ThinkError, type ToolDef } from './think.js';
import { newTurnTrace, finishDerived, type RoundTrace, type SpecTrace, type TraceSink, type TurnTrace } from './trace.js';
import { TurnTracker, judgeTurnText, wordKey, type TurnParams } from './turn.js';
import { MouthError, OUT_RATE, type Ears, type EarsHandlers, type EarsRequest, type LabClock, type Mouth, type SpeechTurn, type TurnFields, type TurnProfile, type TurnSplit } from './types.js';
import { Vad } from './vad.js';

export interface LabAgentDeps {
  ws: WebSocket;
  config: LabConfig;
  clock: LabClock;
  /** Wall clock in ms, for the trace's ISO stamp. */
  wallNow?: () => number;
  log: VoiceLog;
  /** The relay address the Settings must name (the hub's loopback listener): anything else is refused, so the stand-in is not a way to POST to an address of someone's choosing. */
  relayUrl: string;
  /** The turn-taking fields the session sends for each mode (the hub's VoiceConfig): how a Settings is told which mode it is for. */
  profiles: Record<TurnProfile, TurnFields>;
  makeEars(kind: EarsKind, handlers: EarsHandlers, ctx: EarsRequest): Ears;
  makeMouth(kind: MouthKind): Mouth;
  /** Whether the Deepgram key is there (Aura as a mouth or fallback, Flux/nova as ears). */
  haveDeepgramKey(): boolean;
  cache: PcmCache;
  trace: TraceSink;
  fetchImpl?: typeof fetch;
}

interface FunctionDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface SentenceRec {
  tag: number;
  text: string;
  state: 'queued' | 'started' | 'done';
}

/** A line added to the history's last assistant message: a sentence of the model's answer (with its record) or a line the session had said (a greeting, a filler). */
interface TailItem {
  tag: number;
  text: string;
  rec?: SentenceRec;
}

interface Run {
  id: number;
  controller: AbortController;
  trace: TurnTrace;
  commitAt: number;
  speechEndAt: number | undefined;
  latencySent: boolean;
  thinkSentAt: number;
  firstTokenAt: number | null;
  lastToolAnsweredAt: number | null;
  /** The trace time (ms from the start of the call) at which the last function of the latest round answered; null when none did. */
  lastAnswerRel: number | null;
  ttsSentAt: number | null;
  finished: boolean;
  toolsUsed: boolean;
  /** A model request is in flight: more of the answer may still come, so the speech is not over when the audio queued so far has played out. */
  thinking: boolean;
  /**
   * An eager request (docs A10) that nobody has confirmed yet: its sentences wait in `heldSentences`, no function is requested, the page is told nothing. `adoption` settles true when the
   * turn is confirmed with the same words (the held sentences go out and the run goes on as any run), false when the request is dropped.
   */
  held: boolean;
  heldSentences: string[];
  adoption: Promise<boolean> | null;
  settleAdoption: ((adopted: boolean) => void) | null;
  /** Set by the first round of a held run: puts the held sentences into the speech, in order, and ends the holding. */
  flushHeld: (() => void) | null;
  /** The model has finished the text of the round that is going: a streamed speech may be ended once nothing of it is held back any more. */
  roundTextDone: boolean;
  /** The request of a held run failed (the gateway, the relay's limits): it cannot be adopted, the turn asks again. */
  failed: boolean;
}

/** An eager request that has not been confirmed or dropped yet (at most one at a time). */
interface Speculation {
  text: string;
  key: string;
  /** The history's revision when it was asked: a conversation that has changed since is another conversation. */
  rev: number;
  askedAt: number;
  source: SpecTrace['source'];
  run: Run;
}

const MAX_ROUNDS = 8;
const FUNCTION_WAIT_MS = 150_000;
const TICK_MS = 20;
const MOUTH_DOWN_MS = 30_000;
const TOKEN_LEN = 64;

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function newToken(): string {
  return randomBytes(TOKEN_LEN / 2).toString('hex');
}

export class LabAgent {
  private readonly ws: WebSocket;
  private readonly cfg: LabConfig;
  private readonly clock: LabClock;
  private readonly log: VoiceLog;
  private readonly callStart: number;
  private readonly history = new LabHistory();
  private readonly vad: Vad;
  private readonly tracker: TurnTracker;
  private speaker: Speaker;
  private ears: Ears | null = null;
  /** A recognizer that is being connected: an UpdateListen that arrives meanwhile is for it too (it would reach no ears otherwise). */
  private connecting: Ears | null = null;
  private earsKind: EarsKind | null = null;
  /** The shadow recognizer (docs 5.1): same audio, never decides anything, its finals only go into the trace. */
  private shadow: Ears | null = null;
  private shadowFinals: Array<{ text: string; at: number }> = [];
  private shadowAttachedUntil = 0;
  private earsTried = new Set<EarsKind>();
  private mouths = new Map<MouthKind, Mouth>();
  private mouthDownUntil = new Map<MouthKind, number>();

  private applied = false;
  private closed = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private think_: { model: string; temperature?: number; url: string; headers: Record<string, string>; tools: ToolDef[] } | null = null;
  private profile: TurnProfile = 'chat';
  private turnFields: TurnFields = { eotThreshold: 0.75, eotTimeoutMs: 5000 };
  private keyterms: string[] = [];
  private voice = '';
  private speed: number | undefined;
  private mouthKind: MouthKind;

  private run: Run | null = null;
  private runId = 0;
  private turnNo = 0;
  private tag = 0;
  private recs = new Map<number, SentenceRec>();
  /** What has been added to the history's last assistant message since the student last spoke, in order, and what was added before the model's last calls: a barge-in cuts the end of the right message to what was spoken. */
  private tail: TailItem[] = [];
  private callTail: TailItem[] = [];
  private pending = new Map<string, { name: string; resolve: (content: string | null) => void }>();
  private userStartedSent = false;
  private speechStartAt: number | undefined;
  private earsFirstPartialAt: number | undefined;
  private earsFinalAt: number | undefined;
  private lastEarsAt = 0;
  /** When audio last came in from the page: a recognizer is judged silent only while the microphone is being heard (a stalled page is not a silent recognizer). */
  private lastAudioAt = 0;
  private waitingForEarsSince = 0;
  /** The VAD's voiced time (`voicedTotalMs`) when that wait began: the recognizer is given up on only when `silentEarsVoicedMs` of speech have been heard since then, as well as `silentEarsMs` of time. */
  private voicedAtWait = 0;
  private lastCommitText = '';
  private turnTrace: TurnTrace | null = null;
  /** The eager request that is waiting for its turn to be confirmed, and the notes of those that were dropped since the last turn (docs A10). */
  private spec: Speculation | null = null;
  private specNotes: SpecTrace[] = [];
  /** The first six characters of the call's session id, as the session's own log lines carry it; read from the relay token's shape, which is never logged. */
  private sid = '';

  constructor(private readonly deps: LabAgentDeps) {
    this.ws = deps.ws;
    this.cfg = deps.config;
    this.clock = deps.clock;
    this.log = deps.log;
    this.callStart = this.clock();
    this.mouthKind = this.cfg.mouth;
    this.vad = new Vad(this.clock, { onset: (at) => this.onVadOnset(at) });
    this.tracker = new TurnTracker({ completeMs: 0, incompleteMs: 1800, timeoutMs: 5000, coverAfterMs: this.cfg.coverAfterMs });
    this.speaker = this.makeSpeaker();
    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) this.onAudio(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));
        else this.onMessage(data.toString());
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'voice lab: a message from the session could not be handled');
      }
    });
    this.ws.on('close', () => this.close());
    this.ws.on('error', () => undefined);
    this.send({ type: 'Welcome', request_id: `lab-${randomBytes(6).toString('hex')}` });
  }

  // ---------------------------------------------------------------- plumbing

  private rel(t: number): number {
    return t - this.callStart;
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch {
      /* going away */
    }
  }

  private makeSpeaker(): Speaker {
    return new Speaker({
      clock: this.clock,
      leadMs: this.cfg.leadMs,
      estimateWordsPerSecond: this.cfg.livePace,
      synthesize: (text, signal) => this.synth(text, signal),
      openTurn: () => this.openSpeechTurn(),
      estimateMsPerChar: () => 60 / Math.min(1.5, Math.max(0.5, (this.speed ?? 1) * this.cfg.fluxSpeedScale)),
      hooks: {
        streamFailed: (err) => {
          const why = err instanceof MouthError ? err.kind : 'error';
          this.mouthDownUntil.set('flux', this.clock() + MOUTH_DOWN_MS);
          this.turnTrace?.fallbacks.push(`flux:${why}`);
          this.log.warn({ why }, 'voice lab: the Flux TTS speech failed');
          this.send({ type: 'Warning', code: 'LAB_SPEECH_FAILED', description: 'The synthesizer failed while speaking.' });
        },
        audio: (chunk) => {
          if (this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < 4 * 1024 * 1024) this.ws.send(chunk, { binary: true }, () => undefined);
        },
        sentenceFirstChunk: (at, _text, tag) => this.onSentenceFirstChunk(at, tag),
        sentenceStart: (text, at, tag) => this.onSentenceStart(text, at, tag),
        idle: (at) => this.onIdle(at),
        canIdle: () => !this.run?.thinking,
        failed: (text, err) => {
          this.log.warn({ words: text.split(/\s+/).length, err: err.message }, 'voice lab: a sentence could not be spoken');
          this.send({ type: 'Warning', code: 'LAB_SPEECH_FAILED', description: 'A sentence could not be spoken.' });
        },
      },
    });
  }

  // ---------------------------------------------------------------- messages from the session

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'Settings':
        void this.onSettings(msg);
        return;
      case 'KeepAlive':
        return;
      case 'UpdatePrompt': {
        const prompt = str(msg.prompt, 40_000);
        if (prompt) this.history.addSystemNote(prompt);
        this.send({ type: 'PromptUpdated' });
        return;
      }
      case 'UpdateThink':
        this.applyThink(msg.think);
        this.send({ type: 'ThinkUpdated' });
        return;
      case 'UpdateSpeak':
        this.applySpeak(msg.speak);
        this.send({ type: 'SpeakUpdated' });
        return;
      case 'UpdateListen':
        this.applyListen(msg.listen);
        this.send({ type: 'ListenUpdated' });
        return;
      case 'InjectAgentMessage':
        this.injectAgent(str(msg.message, 8000));
        return;
      case 'InjectUserMessage':
        this.injectUser(str(msg.content, 12_000));
        return;
      case 'FunctionCallResponse': {
        const id = str(msg.id, 200);
        const wait = this.pending.get(id);
        if (wait) {
          this.pending.delete(id);
          wait.resolve(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''));
        }
        return;
      }
      default:
        return;
    }
  }

  private refuseSettings(code: string, description: string): void {
    this.send({ type: 'Error', code, description });
    setTimeout(() => {
      try {
        this.ws.close(1011);
      } catch {
        /* gone */
      }
    }, 20).unref?.();
  }

  private profileOf(fields: TurnFields): TurnProfile {
    let best: TurnProfile = 'chat';
    let bestD = Infinity;
    for (const p of ['chat', 'interview', 'talk'] as const) {
      const f = this.deps.profiles[p];
      const d = Math.abs(f.eotThreshold - fields.eotThreshold) * 10_000 + Math.abs(f.eotTimeoutMs - fields.eotTimeoutMs);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private applyThink(think_: unknown): void {
    const t = (think_ ?? {}) as { provider?: { model?: unknown; temperature?: unknown }; endpoint?: { url?: unknown; headers?: unknown }; prompt?: unknown; functions?: unknown };
    if (typeof t.prompt === 'string') this.history.setPrompt(t.prompt);
    const functions = Array.isArray(t.functions) ? (t.functions as FunctionDef[]).filter((f) => f && typeof f.name === 'string') : [];
    const tools: ToolDef[] = functions.map((f) => ({ type: 'function', function: { name: f.name, ...(f.description ? { description: f.description } : {}), ...(f.parameters ? { parameters: f.parameters } : {}) } }));
    const url = str(t.endpoint?.url, 500);
    const headers: Record<string, string> = {};
    if (t.endpoint && typeof t.endpoint.headers === 'object' && t.endpoint.headers) {
      for (const [k, v] of Object.entries(t.endpoint.headers as Record<string, unknown>)) if (typeof v === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(k)) headers[k.toLowerCase()] = v;
    }
    const auth = headers.authorization ?? '';
    const sidMatch = /^Bearer v1\.([A-Za-z0-9_-]{16,64})\./.exec(auth);
    if (sidMatch) this.sid = sidMatch[1].slice(0, 6);
    this.think_ = {
      model: str(t.provider?.model, 100) || this.think_?.model || 'voice',
      temperature: num(t.provider?.temperature) ?? this.think_?.temperature,
      url: url || this.think_?.url || this.deps.relayUrl,
      headers: Object.keys(headers).length ? headers : (this.think_?.headers ?? {}),
      tools,
    };
  }

  private applySpeak(speak: unknown): void {
    const p = ((speak ?? {}) as { provider?: { model?: unknown; speed?: unknown } }).provider ?? {};
    const model = str(p.model, 100);
    if (model) this.voice = model;
    this.speed = num(p.speed);
  }

  private applyListen(listen: unknown): void {
    const p = ((listen ?? {}) as { provider?: Record<string, unknown> }).provider ?? {};
    const fields: TurnFields = { eotThreshold: num(p.eot_threshold) ?? this.turnFields.eotThreshold, eotTimeoutMs: num(p.eot_timeout_ms) ?? this.turnFields.eotTimeoutMs };
    this.turnFields = fields;
    this.profile = this.profileOf(fields);
    this.tracker.setParams(turnParamsFor(this.cfg, this.profile, fields.eotTimeoutMs));
    (this.ears ?? this.connecting)?.setTurnFields?.(fields);
  }

  private async onSettings(msg: Record<string, unknown>): Promise<void> {
    if (this.applied) return;
    try {
      const agent = (msg.agent ?? {}) as Record<string, unknown>;
      const audio = (msg.audio ?? {}) as { input?: { encoding?: unknown; sample_rate?: unknown }; output?: { encoding?: unknown; sample_rate?: unknown } };
      if ((audio.input?.encoding ?? 'linear16') !== 'linear16' || (audio.input?.sample_rate ?? 16000) !== 16000 || (audio.output?.encoding ?? 'linear16') !== 'linear16' || (audio.output?.sample_rate ?? OUT_RATE) !== OUT_RATE) {
        return this.refuseSettings('INVALID_SETTINGS', 'The stand-in takes 16 kHz linear16 in and 24 kHz linear16 out.');
      }
      const listen = ((agent.listen ?? {}) as { provider?: Record<string, unknown> }).provider ?? {};
      this.keyterms = Array.isArray(listen.keyterms) ? (listen.keyterms as unknown[]).filter((k): k is string => typeof k === 'string').slice(0, 100) : [];
      this.applyListen({ provider: listen });
      const think_ = (agent.think ?? {}) as { endpoint?: { url?: unknown } };
      if (!think_.endpoint || str(think_.endpoint.url, 500) !== this.deps.relayUrl) {
        return this.refuseSettings('INVALID_SETTINGS', 'The think endpoint is not the relay of this host.');
      }
      this.applyThink(agent.think);
      this.applySpeak(agent.speak);
      const context = ((agent.context ?? {}) as { messages?: unknown }).messages;
      if (Array.isArray(context)) this.history.loadContext(context as Array<Record<string, unknown>>);
      const greeting = str(agent.greeting, 2000).trim();
      try {
        await this.connectEars();
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'voice lab: no recognizer could be reached');
        return this.refuseSettings('FAILED_TO_START_LISTENING', 'No recognizer could be reached (listen).');
      }
      this.applied = true;
      this.send({ type: 'SettingsApplied' });
      if (this.earsKind !== this.cfg.ears) this.send({ type: 'Error', code: 'LAB_EARS_FALLBACK', description: `The recognizer is ${this.earsKind}: the first one was not reachable.` });
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
      this.tickTimer.unref?.();
      void this.connectShadow();
      this.prepareMouth();
      if (greeting) this.sayAsAgent(greeting);
      void this.warmFillers();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'voice lab: the Settings could not be applied');
      this.refuseSettings('INVALID_SETTINGS', 'The Settings could not be applied.');
    }
  }

  // ---------------------------------------------------------------- ears

  private earsHandlers(): EarsHandlers {
    return {
      startOfTurn: (at) => {
        this.lastEarsAt = at;
        this.onEarsStartOfTurn();
      },
      partial: (text, at) => {
        this.lastEarsAt = at;
        this.waitingForEarsSince = 0;
        if (this.earsFirstPartialAt === undefined) this.earsFirstPartialAt = at;
        if (!this.ears?.decidesTurn) this.tracker.onPartial(text, at, this.vadView());
      },
      final: (text, at) => {
        this.lastEarsAt = at;
        this.waitingForEarsSince = 0;
        this.earsFinalAt = at;
        if (this.ears?.decidesTurn) this.commit(text, 'ears', at);
        else this.tracker.onFinal(text, at, this.vadView());
      },
      eagerEndOfTurn: (text, at) => {
        this.lastEarsAt = at;
        if (this.cfg.eagerEot > 0) this.onEager(text, 'flux');
      },
      turnResumed: (at) => {
        this.lastEarsAt = at;
        this.dropSpec('resumed');
      },
      down: (reason) => void this.onEarsDown(reason),
    };
  }

  private vadView() {
    return { voiced: this.vad.voiced, lastVoicedEndAt: this.vad.lastVoicedEndAt, onsets: this.vad.onsets };
  }

  /** Connects the first recognizer that can be reached, the configured one first and then the fallback; `skip` is one that has just failed in a way a reconnect would not mend (it was silent). */
  private async connectEars(skip?: EarsKind): Promise<void> {
    const order: EarsKind[] = [this.cfg.ears, ...(this.cfg.earsFallback !== 'none' ? [this.cfg.earsFallback] : [])].filter((k) => k !== skip && (!this.earsTried.has(k) || k === this.cfg.ears));
    if (order.length === 0 && skip) order.push(skip);
    let lastErr: Error | null = null;
    for (const kind of order) {
      if (kind !== 'labgpu' && !this.deps.haveDeepgramKey()) {
        lastErr = new Error(`${kind} needs the Deepgram key`);
        continue;
      }
      const made = this.turnFields;
      const ears = this.deps.makeEars(kind, this.earsHandlers(), { keyterms: this.keyterms, turn: made, eagerEot: kind === 'flux' && this.cfg.eagerEot > 0 ? this.cfg.eagerEot : undefined });
      this.connecting = ears;
      try {
        await ears.connect(this.cfg.earsConnectTimeoutMs);
        this.connecting = null;
        this.ears = ears;
        this.earsKind = kind;
        if (this.turnFields !== made) ears.setTurnFields?.(this.turnFields);   // (an UpdateListen that came while it was being connected)
        if (kind !== this.cfg.ears) this.log.warn({ using: kind, wanted: this.cfg.ears }, 'voice lab: the first recognizer was not reachable; using the fallback');
        return;
      } catch (err) {
        this.connecting = null;
        lastErr = err as Error;
        this.earsTried.add(kind);
        try {
          ears.close();
        } catch {
          /* closed */
        }
        this.log.warn({ kind, err: (err as Error).message }, 'voice lab: a recognizer could not be reached');
      }
    }
    throw lastErr ?? new Error('no recognizer');
  }

  /** In the background, once: a failure of the shadow recognizer is a line in the log and nothing else. */
  private async connectShadow(): Promise<void> {
    const kind = this.cfg.shadowEars;
    if (kind === 'none' || kind === this.earsKind) return;
    if (kind !== 'labgpu' && !this.deps.haveDeepgramKey()) return;
    // beside LabGPU's ears, Flux's eager end of turn is the cue to ask the model early (chain h, docs A10); its words never decide anything else
    const eager = kind === 'flux' && this.cfg.eagerEot > 0 && !this.ears?.decidesTurn;
    const handlers: EarsHandlers = {
      partial: () => undefined,
      final: (text, at) => {
        this.shadowFinals.push({ text: text.slice(0, 400), at });
        if (this.shadowFinals.length > 40) this.shadowFinals.shift();
      },
      ...(eager ? { eagerEndOfTurn: (text: string) => this.onEager(text, 'flux-shadow'), turnResumed: () => this.dropSpec('resumed') } : {}),
      down: (reason) => {
        this.log.warn({ kind, reason }, 'voice lab: the shadow recognizer went away');
        this.shadow = null;
      },
    };
    const ears = this.deps.makeEars(kind, handlers, { keyterms: this.keyterms, turn: this.turnFields, eagerEot: eager ? this.cfg.eagerEot : undefined });
    try {
      await ears.connect(this.cfg.earsConnectTimeoutMs);
      if (this.closed) return void ears.close();
      this.shadow = ears;
    } catch (err) {
      this.log.warn({ kind, err: (err as Error).message }, 'voice lab: the shadow recognizer could not be reached');
      try {
        ears.close();
      } catch {
        /* closed */
      }
    }
  }

  private async onEarsDown(reason: string, silent = false): Promise<void> {
    if (this.closed) return;
    const dead = this.ears;
    const was = this.earsKind;
    this.ears = null;
    this.log.warn({ kind: this.earsKind, reason }, 'voice lab: the recognizer went away');
    try {
      dead?.close();
    } catch {
      /* closed */
    }
    this.earsTried.add(this.earsKind ?? this.cfg.ears);
    try {
      // a socket that closed is tried once more (the first choice, then the fallback); one that was up and said nothing is not: the fallback
      await this.connectEars(silent && was ? was : undefined);
      this.send({ type: 'Error', code: 'LAB_EARS_SWITCHED', description: `The recognizer is now ${this.earsKind}.` });
    } catch {
      this.log.error({}, 'voice lab: no recognizer left; ending the connection');
      this.send({ type: 'Error', code: 'FAILED_TO_START_LISTENING', description: 'Recognition is not available (listen).' });
      try {
        this.ws.close(1011);
      } catch {
        /* gone */
      }
    }
  }

  // ---------------------------------------------------------------- audio, VAD, the tick

  private onAudio(pcm: Buffer): void {
    if (!this.applied || this.closed) return;
    const at = this.clock();
    // a gap in the page's audio (a throttled tab, a network stall) leaves the VAD's "speaking" flag as it was: it is cleared, so that the first frames after the gap are judged on their own
    if (this.lastAudioAt && at - this.lastAudioAt > 400) {
      this.vad.reset();
      this.waitingForEarsSince = 0;
    }
    this.lastAudioAt = at;
    this.vad.feed(pcm);
    this.ears?.sendAudio(pcm);
    this.shadow?.sendAudio(pcm);
  }

  private onVadOnset(at: number): void {
    if (this.closed) return;
    this.speechStartAt = this.speechStartAt ?? at;
    // the student begins again: an eager request made for the turn that seemed to be over is not the answer to what is being said now
    this.dropSpec('speech');
    // the wait for the recognizer's first word begins with the first onset. A wait that a click or a cough started (long, and with less speech in it than a healthy recognizer always answers) is
    // dropped at the next onset, so that blips spread over minutes never add up to a silent recognizer
    const waitedFor = this.clock();
    const stale = this.waitingForEarsSince > 0 && waitedFor - this.waitingForEarsSince > 6 * this.cfg.silentEarsMs && this.vad.voicedTotalMs - this.voicedAtWait < this.cfg.silentEarsVoicedMs;
    if (!this.waitingForEarsSince || stale) {
      this.waitingForEarsSince = waitedFor;
      this.voicedAtWait = this.vad.voicedTotalMs;
    }
    // the agent is not speaking: the student's onset is Deepgram's UserStartedSpeaking (when it IS speaking, the barge-in rule decides, in the tick)
    if (!this.ears?.decidesTurn && !this.speaker.speaking && !this.userStartedSent) {
      this.userStartedSent = true;
      this.send({ type: 'UserStartedSpeaking' });
    }
  }

  private onEarsStartOfTurn(): void {
    this.dropSpec('start of turn');
    if (this.speaker.speaking) return this.bargeIn('startOfTurn');
    if (this.run && !this.run.latencySent && !this.speaker.pending) this.resume();
    if (!this.userStartedSent) {
      this.userStartedSent = true;
      this.send({ type: 'UserStartedSpeaking' });
    }
  }

  private tick(): void {
    if (this.closed || !this.applied) return;
    const now = this.clock();
    const decides = !!this.ears?.decidesTurn;
    // Barge-in on the engine's own VAD whichever recognizer is listening: with ears that decide turns (Flux) its StartOfTurn is a second cue, but it comes 0.6 s after the onset (probe of 10.2),
    // against 0.2 to 0.3 s here; the barge-in must not get slower because the ears changed (A10).
    if (this.speaker.speaking) {
      const heard = this.bargeHeardMs();
      if (heard >= this.cfg.bargeMinVoicedMs) this.bargeIn('vad');
    }
    if (!decides) {
      if (this.run && !this.run.latencySent && !this.speaker.speaking && this.vad.voicedRunMs >= this.cfg.bargeMinVoicedMs) this.resume();
      const d = this.tracker.tick(now, this.vadView());
      if (d?.kind === 'commit') {
        this.commit(d.text, d.reason, d.at, d.speechEndAt);
      } else if (d?.kind === 'discard') {
        this.userStartedSent = false;
      }
    }
    // the recognizer says nothing while the student speaks: it is given up (docs 9.4 C8) when `silentEarsMs` have passed since the wait began (so that a student who says short things with pauses
    // still gets the fallback) AND the VAD has heard `silentEarsVoicedMs` of speech since then (so that a blip, a cough, or a pause in the audio is not taken for a deaf recognizer: it gave a false
    // alarm in the owner's call of 2026-11-14, and a test of 2026-11-15 hit it: 360 ms of speech, a pause of 350 ms in the audio, and the recognizers were switched: docs/LOCAL_VOICE.md 9.10)
    if (
      this.waitingForEarsSince &&
      this.vad.voiced &&
      now - this.lastAudioAt < 250 &&
      now - this.waitingForEarsSince >= this.cfg.silentEarsMs &&
      this.vad.voicedTotalMs - this.voicedAtWait >= this.cfg.silentEarsVoicedMs
    ) {
      this.waitingForEarsSince = 0;
      void this.onEarsDown('silent while the student was speaking', true);
    }
  }

  // ---------------------------------------------------------------- committing a turn

  private commit(text: string, reason: string, at: number, speechEndAt?: number): void {
    const clean = text.trim();
    if (!clean || this.closed) return;
    if (this.speaker.speaking) this.bargeIn('startOfTurn');
    // a turn that was being answered but has not begun to be spoken is replaced: the new words are the same turn, continued
    if (this.run && !this.run.latencySent) this.resume();
    this.finishTrace('superseded');
    // an eager request (docs A10) is the answer to this turn when it was asked with these very words on this very conversation; otherwise it is dropped and the turn asks as it always did
    const spec = this.takeSpec(clean);
    const now = this.clock();
    this.turnNo++;
    this.lastCommitText = clean;
    this.userStartedSent = false;
    const stamp = new Date((this.deps.wallNow ?? Date.now)()).toISOString();
    const trace = spec ? spec.run.trace : newTurnTrace({ sid: this.sid, mode: this.profile, ears: this.earsKind ?? '', mouth: this.primaryKind(), turn: this.turnNo, at: stamp });
    trace.turn = this.turnNo;
    trace.at = stamp;
    if (this.cfg.chain) trace.chain = this.cfg.chain;
    trace.speechStart = this.speechStartAt !== undefined ? this.rel(this.speechStartAt) : undefined;
    trace.speechEnd = speechEndAt !== undefined ? this.rel(speechEndAt) : this.vad.lastVoicedEndAt > 0 ? this.rel(this.vad.lastVoicedEndAt) : undefined;
    trace.earsPartialFirst = this.earsFirstPartialAt !== undefined ? this.rel(this.earsFirstPartialAt) : undefined;
    trace.earsFinal = this.earsFinalAt !== undefined ? this.rel(this.earsFinalAt) : undefined;
    trace.commit = this.rel(now);
    trace.commitReason = reason;
    trace.userText = clean.slice(0, 80);
    const specs = this.specNotes.splice(0);
    if (spec) specs.push({ askedAt: this.rel(spec.askedAt), source: spec.source, outcome: 'adopted', endedAt: this.rel(now), ...(trace.firstSentenceReady !== undefined ? { readyAt: trace.firstSentenceReady } : {}) });
    if (specs.length) trace.specs = specs;
    this.speechStartAt = undefined;
    this.earsFirstPartialAt = undefined;
    this.earsFinalAt = undefined;
    this.turnTrace = trace;
    this.tail = [];
    this.callTail = [];
    this.history.addUser(clean);
    this.send({ type: 'ConversationText', role: 'user', content: clean });
    if (spec) this.adopt(spec, now, speechEndAt ?? (this.vad.lastVoicedEndAt || undefined));
    else void this.startRun(trace, now, speechEndAt ?? (this.vad.lastVoicedEndAt || undefined));
    void at;
  }

  private injectUser(text: string): void {
    if (!text.trim()) return;
    if (!this.applied || this.speaker.speaking || this.run || this.vad.voiced) {
      this.send({ type: 'InjectionRefused', message: 'busy' });
      return;
    }
    this.turnNo++;
    const now = this.clock();
    this.finishTrace('superseded');
    const trace = newTurnTrace({ sid: this.sid, mode: this.profile, ears: this.earsKind ?? '', mouth: this.primaryKind(), turn: this.turnNo, at: new Date((this.deps.wallNow ?? Date.now)()).toISOString() });
    trace.commit = this.rel(now);
    trace.commitReason = 'injected';
    trace.userText = text.slice(0, 80);
    this.turnTrace = trace;
    this.tail = [];
    this.callTail = [];
    this.history.addUser(text);
    this.send({ type: 'ConversationText', role: 'user', content: text });
    void this.startRun(trace, now, undefined);
  }

  private injectAgent(text: string): void {
    const t = text.trim();
    if (!t) return;
    const busy = this.vad.voiced || this.speaker.speaking || (this.userStartedSent && !this.run);
    if (!this.applied || busy) {
      this.send({ type: 'InjectionRefused', message: 'busy' });
      return;
    }
    const now = this.clock();
    const trace = this.turnTrace;
    if (trace) trace.fillers.push({ text: t.slice(0, 60), injectedAt: this.rel(now) });
    this.sayAsAgent(t);
  }

  /** A line the session has the agent say (the greeting, a filler, an opener): spoken as it is, and remembered as the agent's. */
  private sayAsAgent(text: string): void {
    const tag = this.nextTag(false);
    // said while a function runs (a filler): the history puts it into the message that holds the calls, so it belongs to the words before the calls, not to the answer after them
    (this.pending.size > 0 ? this.callTail : this.tail).push({ tag, text });
    this.history.addAssistant(text);
    this.speaker.say(text, tag);
    this.speaker.endText();                          // a line of its own is a speech of its own (a streaming mouth is told that no more text follows)
  }

  private nextTag(rec: boolean, text = ''): number {
    const tag = ++this.tag;
    if (rec) this.recs.set(tag, { tag, text, state: 'queued' });
    return tag;
  }

  // ---------------------------------------------------------------- the think loop

  private newRun(trace: TurnTrace, commitAt: number, speechEndAt: number | undefined, held: boolean): Run {
    const run: Run = {
      id: ++this.runId,
      controller: new AbortController(),
      trace,
      commitAt,
      speechEndAt,
      latencySent: false,
      thinkSentAt: 0,
      firstTokenAt: null,
      lastToolAnsweredAt: null,
      lastAnswerRel: null,
      ttsSentAt: null,
      finished: false,
      toolsUsed: false,
      thinking: false,
      held,
      heldSentences: [],
      adoption: null,
      settleAdoption: null,
      flushHeld: null,
      roundTextDone: false,
      failed: false,
    };
    if (held) {
      run.adoption = new Promise<boolean>((resolve) => {
        run.settleAdoption = resolve;
      });
    }
    return run;
  }

  private async startRun(trace: TurnTrace, commitAt: number, speechEndAt: number | undefined): Promise<void> {
    const run = this.newRun(trace, commitAt, speechEndAt, false);
    this.run = run;
    this.send({ type: 'AgentThinking', content: this.lastCommitText.slice(0, 200) });
    await this.loop(run);
  }

  /**
   * The think loop of a run: ask the model, speak what it says, run the functions it asks for and ask again, up to MAX_ROUNDS. A held run (an eager request, docs A10) asks the first round on the
   * conversation plus `extraUser`, and holds everything of its answer until `adopt` says the turn is confirmed: its sentences wait, and no function is requested before then.
   */
  private async loop(run: Run, extraUser?: string): Promise<void> {
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (run.controller.signal.aborted || this.closed) return;
        const toolCalls = await this.completion(run, round, round === 0 ? extraUser : undefined);
        if (run.controller.signal.aborted || this.closed) return;
        // an answer that came before the turn was confirmed is not acted on: no function runs (it may have a side effect: "Yeah. Sure." once started a search nobody asked for), until it is
        if (run.held && !(await run.adoption)) return;
        if (run.controller.signal.aborted || this.closed) return;
        if (!toolCalls.length) break;
        run.toolsUsed = true;
        const calls: ToolCall[] = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
        this.history.addToolCalls(calls);
        this.callTail = this.tail;
        this.tail = [];
        const results = await this.runFunctions(run, toolCalls);
        if (run.controller.signal.aborted || this.closed) return;
        for (const c of toolCalls) this.history.addToolResult(c.id, results.get(c.id) ?? JSON.stringify({ error: 'no answer' }));
        run.lastToolAnsweredAt = this.clock();
      }
    } catch (err) {
      if (!run.controller.signal.aborted) {
        if (run.held) {
          // an eager request that failed (the gateway, the relay's limits): nothing was shown and nothing is owed; the turn asks again when it is confirmed
          run.failed = true;
          this.log.debug({ kind: err instanceof ThinkError ? err.kind : 'internal', status: err instanceof ThinkError ? err.status : undefined }, 'voice lab: an eager request failed');
        } else {
          const kind = err instanceof ThinkError ? err.kind : 'internal';
          this.log.warn({ kind, status: err instanceof ThinkError ? err.status : undefined }, 'voice lab: the think step failed');
          this.send({ type: 'Error', code: 'THINK_REQUEST_FAILED', description: 'The language model could not be reached.' });
        }
      }
    } finally {
      run.finished = true;
      if (run.held) run.settleAdoption?.(false);
      if (this.run === run) {
        if (!this.speaker.speaking && !this.speaker.pending) {
          // nothing was said (an empty answer, a failed request): the turn is over; the page must not be left on "thinking"
          this.run = null;
          this.send({ type: 'AgentAudioDone' });
          this.finishTrace('no-audio');
        }
      }
    }
  }

  // ---------------------------------------------------------------- the eager request (docs A10)

  /**
   * The recognizer's eager end of turn (Flux): the student may have finished. The model is asked now, on the conversation as it stands plus these words, and its answer is held back until the turn is
   * confirmed with the same words (`commit`): nothing is said, no function is requested, nothing is written to the history or told to the page. At the commit it goes out at once, as if the model
   * had been asked `commit - askedAt` earlier. If the student goes on, or the words differ, the request is dropped. A talk-through is left out (it waits seconds after a pause anyway, and its answers are nudges).
   */
  private onEager(text: string, source: SpecTrace['source']): void {
    const clean = text.trim();
    if (this.closed || !this.applied || !this.think_ || !clean || this.profile === 'talk') return;
    // an answer is on its way, or being spoken, or a function is running: this is not a turn to answer
    if (this.run || this.speaker.speaking || this.speaker.pending || this.pending.size > 0) return;
    // the turn rule would hold these words (an unfinished sentence): a request made on them would be wasted
    if (judgeTurnText(clean) !== 'complete') return;
    const key = wordKey(clean);
    if (this.spec) {
      if (this.spec.key === key) return;
      this.dropSpec('replaced');
    }
    const now = this.clock();
    const trace = newTurnTrace({ sid: this.sid, mode: this.profile, ears: this.earsKind ?? '', mouth: this.primaryKind(), turn: 0, at: new Date((this.deps.wallNow ?? Date.now)()).toISOString() });
    const run = this.newRun(trace, 0, undefined, true);
    this.spec = { text: clean, key, rev: this.history.revision, askedAt: now, source, run };
    void this.loop(run, clean);
  }

  /** The eager request, if it is the answer to the turn that is being committed: asked with these words, on this conversation, and not failed. Otherwise it is dropped (with the reason) and null comes back. */
  private takeSpec(committed: string): Speculation | null {
    const spec = this.spec;
    if (!spec) return null;
    if (spec.run.failed) {
      this.dropSpec('failed');
      return null;
    }
    if (spec.rev !== this.history.revision) {
      this.dropSpec('history changed');
      return null;
    }
    if (spec.key !== wordKey(committed)) {
      this.dropSpec('different words');
      return null;
    }
    this.spec = null;
    return spec;
  }

  /** The turn is confirmed and the eager request is its answer: it becomes the run (the page is told the agent is thinking), its held sentences go out in order, and what is still to come goes out as it arrives. */
  private adopt(spec: Speculation, now: number, speechEndAt: number | undefined): void {
    const run = spec.run;
    run.commitAt = now;
    run.speechEndAt = speechEndAt;
    this.run = run;
    this.send({ type: 'AgentThinking', content: this.lastCommitText.slice(0, 200) });
    run.flushHeld?.();
    run.held = false;
    run.settleAdoption?.(true);
  }

  /** The eager request is not the answer (the student went on, said other words, the conversation changed, the call ended): it is aborted and noted for the trace. */
  private dropSpec(why: string): void {
    const spec = this.spec;
    if (!spec) return;
    this.spec = null;
    try {
      spec.run.controller.abort();
    } catch {
      /* aborted */
    }
    spec.run.settleAdoption?.(false);
    const readyAt = spec.run.trace.firstSentenceReady;
    this.specNotes.push({ askedAt: this.rel(spec.askedAt), source: spec.source, outcome: 'dropped', why, endedAt: this.rel(this.clock()), ...(readyAt !== undefined ? { readyAt } : {}) });
    if (this.specNotes.length > 20) this.specNotes.shift();
  }

  private async completion(run: Run, round: number, extraUser?: string): Promise<Array<{ id: string; name: string; arguments: string }>> {
    const cfg = this.think_;
    if (!cfg) throw new ThinkError('network', 'no think configuration');
    // the first sentence of the answer is the one the student waits for: a short opener ("Right.") goes out at once
    const cutter = new SentenceCutter({ firstMinWords: 1 });
    const speakNow = (sentence: string): void => {
      const original = sentence.trim();
      if (!original || !spokenText(original)) return;
      const tag = this.nextTag(true, original);
      this.tail.push({ tag, text: original, rec: this.recs.get(tag)! });
      this.history.addAssistant(original);
      if (run.ttsSentAt === null) {
        run.ttsSentAt = this.clock();
        run.trace.ttsSent = this.rel(run.ttsSentAt);
      }
      if (run.trace.firstSentence === undefined) run.trace.firstSentence = this.rel(this.clock());
      this.speaker.say(original, tag);
    };
    // an eager request's sentences wait for the turn to be confirmed (docs A10): `flushHeld` puts them into the speech, in order, and from then on the answer goes out as it arrives
    const speak = (sentence: string): void => {
      if (run.held) {
        const original = sentence.trim();
        if (!original || !spokenText(original)) return;
        if (run.trace.firstSentenceReady === undefined) run.trace.firstSentenceReady = this.rel(this.clock());
        run.heldSentences.push(original);
        return;
      }
      speakNow(sentence);
    };
    if (run.held && round === 0) {
      run.flushHeld = () => {
        run.held = false;
        for (const held of run.heldSentences.splice(0)) speakNow(held);
        if (run.roundTextDone) this.speaker.endText();            // (the round had finished while its sentences were held back)
      };
    }
    run.roundTextDone = false;
    run.thinkSentAt = this.clock();
    run.firstTokenAt = null;
    if (round === 0) run.trace.thinkSent = this.rel(run.thinkSentAt);
    const roundRec: RoundTrace = { thinkSent: this.rel(run.thinkSentAt) };
    if (round > 0 && run.lastAnswerRel !== null) roundRec.afterAnswerMs = roundRec.thinkSent - run.lastAnswerRel;
    run.trace.rounds.push(roundRec);
    run.thinking = true;
    const messages = extraUser !== undefined ? this.history.messagesWithUser(extraUser) : this.history.toMessages();
    const repaired = this.history.takeRepairs();
    if (repaired) this.log.warn({ repaired }, 'voice lab: the conversation held a function call without its reply (or a reply without its call); the request was repaired');
    const result = await think({
      url: cfg.url,
      headers: cfg.headers,
      model: cfg.model,
      temperature: cfg.temperature,
      tools: cfg.tools,
      messages,
      signal: run.controller.signal,
      clock: this.clock,
      fetchImpl: this.deps.fetchImpl,
      onText: (piece, at) => {
        if (run.firstTokenAt === null) run.firstTokenAt = at;
        if (roundRec.firstToken === undefined) roundRec.firstToken = this.rel(at);
        if (run.trace.firstToken === undefined) run.trace.firstToken = this.rel(at);
        for (const s of cutter.push(piece)) speak(s);
      },
    }).finally(() => {
      run.thinking = false;
    });
    if (result.firstTokenAt !== null && run.firstTokenAt === null) run.firstTokenAt = result.firstTokenAt;
    for (const s of cutter.end()) speak(s);
    run.roundTextDone = true;
    if (!run.held) this.speaker.endText();                         // the text of this round is complete: a streaming mouth ends its speech (the next round, after its functions, is another speech)
    if (run.trace.firstToken === undefined && result.firstTokenAt !== null) run.trace.firstToken = this.rel(result.firstTokenAt);
    if (roundRec.firstToken === undefined && result.firstTokenAt !== null) roundRec.firstToken = this.rel(result.firstTokenAt);
    return result.toolCalls;
  }

  private async runFunctions(run: Run, calls: Array<{ id: string; name: string; arguments: string }>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const recs: Array<TurnTrace['functions'][number]> = [];
    const waits = calls.map(
      (c) =>
        new Promise<void>((resolve) => {
          const startedAt = this.clock();
          const rec = { name: c.name, startedAt: this.rel(startedAt) } as TurnTrace['functions'][number];
          run.trace.functions.push(rec);
          recs.push(rec);
          const timer = setTimeout(() => {
            this.pending.delete(c.id);
            out.set(c.id, JSON.stringify({ error: 'the function did not answer in time' }));
            resolve();
          }, FUNCTION_WAIT_MS);
          timer.unref?.();
          this.pending.set(c.id, {
            name: c.name,
            resolve: (content) => {
              clearTimeout(timer);
              rec.answeredAt = this.rel(this.clock());
              if (content !== null) out.set(c.id, content);
              resolve();
            },
          });
        }),
    );
    this.send({ type: 'FunctionCallRequest', functions: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments || '{}', client_side: true })) });
    await Promise.race([Promise.all(waits), new Promise<void>((resolve) => run.controller.signal.addEventListener('abort', () => resolve(), { once: true }))]);
    const answered = recs.map((r) => r.answeredAt).filter((t): t is number => t !== undefined);
    run.lastAnswerRel = answered.length ? Math.max(...answered) : null;       // (the next request's `afterAnswerMs` counts from here: docs 9.4 C5, amendment A3)
    return out;
  }

  // ---------------------------------------------------------------- speaking

  /** The first chunk of a sentence went out. If it is the first of the model's answer to this turn, that is the turn's first audio (Deepgram's `total_latency` ends here); a filler's chunk is only noted. */
  private onSentenceFirstChunk(at: number, tag: number): void {
    const run = this.run;
    if (!this.recs.has(tag)) {
      const f = this.turnTrace?.fillers.find((x) => x.audioAt === undefined);
      if (f) f.audioAt = this.rel(at);
      return;
    }
    if (!run || run.latencySent) return;
    run.latencySent = true;
    run.trace.firstAudioOut = this.rel(at);
    const seconds = (ms: number): number => Math.max(0, Math.round(ms) / 1000);
    const report: Record<string, unknown> = { type: 'LatencyReport', total_latency: seconds(at - run.commitAt) };
    if (run.speechEndAt !== undefined) report.stt_latency = seconds(run.commitAt - run.speechEndAt);
    if (run.firstTokenAt !== null) {
      report.ttt_text_latency = seconds(run.firstTokenAt - run.thinkSentAt);
      if (run.toolsUsed && run.lastToolAnsweredAt !== null) report.ttt_tool_latency = seconds(run.firstTokenAt - run.lastToolAnsweredAt);
    }
    if (run.ttsSentAt !== null) report.tts_latency = seconds(at - run.ttsSentAt);
    this.send(report);
  }

  private onSentenceStart(text: string, _at: number, tag: number): void {
    const rec = this.recs.get(tag);
    if (rec) rec.state = 'started';
    this.send({ type: 'ConversationText', role: 'assistant', content: text });
  }

  private onIdle(at: number): void {
    for (const [tag, rec] of this.recs) {
      if (rec.state === 'started') rec.state = 'done';
      if (rec.state === 'done') this.recs.delete(tag);                 // (the run's own list still holds it for a barge-in's cut)
    }
    if (this.run) {
      this.run.trace.audioDone = this.rel(at);
    } else if (this.turnTrace) this.turnTrace.audioDone = this.rel(at);
    this.send({ type: 'AgentAudioDone' });
    if (this.run?.finished) {
      this.run = null;
      this.finishTrace('done');
    } else if (!this.run) this.finishTrace('done');
  }

  // ---------------------------------------------------------------- barge-in and resume

  /** How much loud speech the barge-in rule has heard: the loud frames of the last `bargeWindowMs` (A11), or the unbroken run when the window is no longer than what is asked for (round 1's rule). */
  private bargeHeardMs(): number {
    const window = this.cfg.bargeWindowMs;
    return window > this.cfg.bargeMinVoicedMs ? this.vad.strictWindow(window).voicedMs : this.vad.strictRunMs;
  }

  /** The student spoke over the agent: everything stops, and the history keeps what was said. */
  private bargeIn(by: 'vad' | 'startOfTurn'): void {
    if (this.closed || !this.speaker.speaking) return;
    const now = this.clock();
    const run = this.run;
    const report = this.speaker.stop();
    const hadCalls = this.pending.size > 0;
    run?.controller.abort();
    this.cancelFunctions();
    this.history.dropUnansweredToolCalls();
    // the message that is last now (the one the calls were on, when the student spoke while they ran) keeps only what was spoken of its end
    const items = hadCalls ? this.callTail : this.tail;
    const keptEstimate = this.keptOf(items, report);
    this.history.cutTail(items.map((i) => i.text).join(' '), keptEstimate);
    // a speech the service was still making is cut with the offset of what had played, and its answer, a moment later, says exactly what was heard: the estimate above is replaced by it
    if (report.exact) void report.exact.then((exact) => this.refineSpoken(items, report, exact, keptEstimate)).catch(() => undefined);
    const trace = run?.trace ?? this.turnTrace;
    if (trace) {
      // the first loud frame of what was heard (the window rule's own start: a dip splits the normal view's run)
      const windowed = this.cfg.bargeWindowMs > this.cfg.bargeMinVoicedMs ? this.vad.strictWindow(this.cfg.bargeWindowMs).startedAt : 0;
      const startedAt = windowed > 0 ? windowed : this.vad.runStartedAt;
      const onset = startedAt > 0 ? this.rel(startedAt) : this.rel(now);
      trace.bargeIn = {
        onset,
        confirmed: this.rel(now),
        audioStopped: this.rel(now),
        by,
        spoken: report.sentences.filter((s) => s.started).map((s) => ({ words: s.text.split(/\s+/).length, played: s.playedFraction })),
      };
    }
    this.run = null;
    this.finishTrace('barge-in');
    this.userStartedSent = true;
    this.send({ type: 'UserStartedSpeaking' });
    for (const rec of this.recs.values()) rec.state = 'done';
  }

  /**
   * What of these lines was spoken when the student spoke over the agent: a line of this speech by what the speaker says (the one that was playing, cut by what played; one not yet begun,
   * nothing); a sentence of an earlier speech (the model went on after a pause in the audio) in full if it was played out, nothing if it was never sent; a filler of an earlier speech in full.
   */
  private keptOf(items: TailItem[], report: SpokenReport, exact?: { tags: number[]; split: TurnSplit } | null): string {
    const parts: string[] = [];
    let exactUsed = false;
    for (const item of items) {
      if (exact?.tags.includes(item.tag)) {
        // the sentences of a streamed speech the service has cut: what it says was heard stands for all of them, once
        if (!exactUsed && exact.split.spoken) parts.push(exact.split.spoken);
        exactUsed = true;
        continue;
      }
      const r = report.sentences.find((x) => x.tag === item.tag);
      let kept: string;
      if (r) kept = r.started ? wordsPlayed(item.text, r.playedFraction) : '';
      else if (item.rec) kept = item.rec.state === 'done' ? item.text : '';
      else kept = item.text;
      if (kept) parts.push(kept);
    }
    return parts.join(' ');
  }

  /** The service's exact words replace the estimate in the history, as long as the history still ends with the estimate (a later message makes `cutTail` leave it alone). */
  private refineSpoken(items: TailItem[], report: SpokenReport, exact: { tags: number[]; split: TurnSplit } | null, keptEstimate: string): void {
    if (!exact || !keptEstimate || this.closed) return;
    const keptExact = this.keptOf(items, report, exact);
    if (keptExact && keptExact !== keptEstimate) this.history.cutTail(keptEstimate, keptExact);
  }

  /** The student went on before the answer had begun: the request is dropped, and the words go with the next turn. */
  private resume(): void {
    const run = this.run;
    if (!run) return;
    run.controller.abort();
    this.cancelFunctions();
    this.history.dropUnansweredToolCalls();
    this.speaker.stop();
    this.run = null;
    if (this.turnTrace) this.turnTrace.commitReason = `${this.turnTrace.commitReason ?? ''}+resumed`;
    this.finishTrace('resumed');
    this.userStartedSent = false;
    this.send({ type: 'UserStartedSpeaking' });
    this.userStartedSent = true;
  }

  private cancelFunctions(): void {
    if (!this.pending.size) return;
    const ids = [...this.pending.entries()].map(([id, p]) => ({ id, name: p.name }));
    this.send({ type: 'FunctionCallCancelled', functions: ids });
    for (const p of this.pending.values()) p.resolve(null);
    this.pending.clear();
  }

  // ---------------------------------------------------------------- the mouth

  private async *synth(text: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const clean = spokenText(text);
    if (!clean) return;
    const primary = this.primaryKind();
    const order: MouthKind[] = [primary, ...(this.cfg.mouthFallback !== 'none' && this.cfg.mouthFallback !== primary ? [this.cfg.mouthFallback] : [])];
    let last: Error | null = null;
    for (const kind of order) {
      if ((kind === 'aura' || kind === 'flux') && !this.deps.haveDeepgramKey()) continue;
      if ((this.mouthDownUntil.get(kind) ?? 0) > this.clock() && kind === primary && order.length > 1) continue;
      let yielded = false;
      try {
        for await (const chunk of this.mouthStream(kind, clean, signal)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (signal.aborted) return;
        last = err as Error;
        const why = err instanceof MouthError ? err.kind : 'error';
        this.turnTrace?.fallbacks.push(`${kind}:${why}`);
        this.log.warn({ kind, why }, 'voice lab: the synthesizer failed for a sentence');
        if (err instanceof MouthError && err.kind === 'fallback') this.send({ type: 'Warning', code: 'LAB_TTS_SUBSTITUTED', description: 'The synthesizer served another voice; that audio was dropped.' });
        if (!(err instanceof MouthError) || err.kind === 'down') this.mouthDownUntil.set(kind, this.clock() + MOUTH_DOWN_MS);
        if (yielded) return;
      }
    }
    throw last ?? new MouthError('down', 'no synthesizer');
  }

  private voiceFor(kind: MouthKind): string {
    if (kind === 'labgpu') return this.cfg.labgpuVoice;
    if (kind === 'flux') return this.fluxVoice() ?? this.cfg.fluxVoiceChat;
    if (/^aura-2-[a-z]+-[a-z]{2}$/.test(this.voice)) return this.voice;
    return this.profile === 'interview' ? this.cfg.auraVoiceInterview : this.cfg.auraVoiceChat;
  }

  /**
   * The Flux voice a speech is made in: the Settings' own when it is one (the live call's `flux-hannah-en`), else the lab's default for a conversation; null when this call's voice is not a Flux one
   * (the interviewer's is an Aura voice in the live call too, `aura-2-mars-en`): then the lab speaks as the live call does, a sentence at a time through Aura.
   */
  private fluxVoice(): string | null {
    if (/^flux-[a-z]+-[a-z]{2}$/.test(this.voice)) return this.voice;
    if (/^aura-2-[a-z]+-[a-z]{2}$/.test(this.voice) || this.profile === 'interview') return null;
    return this.cfg.fluxVoiceChat;
  }

  /** The mouth this call speaks with: the configured one, except that a Flux mouth speaks only in a Flux voice. */
  private primaryKind(): MouthKind {
    return this.mouthKind === 'flux' && this.fluxVoice() === null ? 'aura' : this.mouthKind;
  }

  private fluxSpeed(): number | undefined {
    return this.speed !== undefined ? this.speed * this.cfg.fluxSpeedScale : undefined;
  }

  /**
   * One whole answer as one continuous speech of the Flux mouth (the speaker asks for it when the first sentence of an answer is said), or null when the sentences are to be made one by one: another
   * mouth, no key, the Flux mouth failed a moment ago (`mouthDownUntil`), or a voice that is not a Flux one. The model's sentences are cleaned for speech here, as `synth` cleans each of them.
   */
  private openSpeechTurn(): SpeechTurn | null {
    if (this.mouthKind !== 'flux' || this.primaryKind() !== 'flux') return null;
    if (!this.deps.haveDeepgramKey() || (this.mouthDownUntil.get('flux') ?? 0) > this.clock()) return null;
    const voice = this.fluxVoice();
    const mouth = this.mouthOf('flux');
    if (!voice || !mouth.openTurn) return null;
    const turn = mouth.openTurn({ voice, speed: this.fluxSpeed() });
    return {
      speak: (text) => {
        const clean = spokenText(text);
        return clean ? turn.speak(clean) : '';
      },
      end: () => turn.end(),
      get audio() {
        return turn.audio;
      },
      interrupt: (playedMs) => turn.interrupt(playedMs),
      abandon: () => turn.abandon(),
      get durationMs() {
        return turn.durationMs;
      },
    };
  }

  /** The streaming mouth's socket is opened ahead of the first sentence, so that the answer does not wait for the handshake. */
  private prepareMouth(): void {
    if (this.primaryKind() !== 'flux' || !this.deps.haveDeepgramKey()) return;
    const voice = this.fluxVoice();
    const mouth = this.mouthOf('flux');
    if (voice && mouth.prepare) mouth.prepare({ voice, speed: this.fluxSpeed() });
  }

  /** The tempo factor that brings LabGPU's voice (which has no speed control) to the pace the live voices have at the Settings' speed. */
  private tempoFactor(): number {
    const speed = this.speed ?? 1;
    const target = (this.cfg.livePace * speed) / 1.2;
    return Math.min(1.5, Math.max(1, target / this.cfg.labgpuPace));
  }

  private mouthOf(kind: MouthKind): Mouth {
    let m = this.mouths.get(kind);
    if (!m) {
      m = this.deps.makeMouth(kind);
      this.mouths.set(kind, m);
    }
    return m;
  }

  private async *mouthStream(kind: MouthKind, clean: string, signal: AbortSignal): AsyncGenerator<Buffer> {
    const voice = this.voiceFor(kind);
    const mouth = this.mouthOf(kind);
    const scale = kind === 'flux' ? this.cfg.fluxSpeedScale : kind === 'labgpu' ? this.cfg.ttsSpeedScale : this.cfg.auraSpeedScale;
    const speed = mouth.takesSpeed && this.speed !== undefined ? this.speed * scale : undefined;
    const factor = !mouth.takesSpeed && this.cfg.tempo ? this.tempoFactor() : 1;
    // the level of the live voice is what the others are brought to (mouth/level.ts); what is cached is what is spoken, and the gain is the same for the life of the process
    const gainDb = kind === 'labgpu' ? this.cfg.ttsGainDb : 0;
    const key = PcmCache.key(kind, voice, factor !== 1 ? factor : speed, clean);
    const cached = this.deps.cache.get(key);
    if (cached) {
      yield cached;
      return;
    }
    if (factor !== 1) {
      const parts: Buffer[] = [];
      for await (const piece of mouth.synthesize(clean, { voice, signal })) parts.push(piece);
      if (signal.aborted) return;
      const pcm = Buffer.concat(parts);
      if (!pcm.length) return;
      const out = applyGain(stretch(pcm, OUT_RATE, factor), gainDb);
      if (clean.length <= 80) this.deps.cache.put(key, out);
      yield out;
      return;
    }
    const kept: Buffer[] = [];
    for await (const raw of mouth.synthesize(clean, { voice, speed, signal })) {
      const piece = applyGain(raw, gainDb);
      kept.push(piece);
      yield piece;
    }
    if (!signal.aborted && clean.length <= 80) this.deps.cache.put(key, Buffer.concat(kept));
  }

  /** The fixed lines of prompts.ts (the fillers) once, in the background, so that a filler starts without a synthesis wait. */
  private async warmFillers(): Promise<void> {
    // a streaming mouth serves one speech after the other and charges by the character: a warm-up of forty lines would hold the first answer back and cost money on every call
    if (this.mouthOf(this.primaryKind()).prewarm === false) return;
    const texts = Object.values(lines.fillers).flat();
    const signal = new AbortController().signal;
    for (const text of texts) {
      if (this.closed) return;
      const clean = spokenText(text);
      if (!clean) continue;
      try {
        for await (const _ of this.mouthStream(this.primaryKind(), clean, signal)) void _;
      } catch {
        return;
      }
    }
  }

  // ---------------------------------------------------------------- the end

  private finishTrace(how: string): void {
    const trace = this.turnTrace;
    if (!trace) return;
    this.turnTrace = null;
    trace.commitReason = trace.commitReason ?? how;
    if (this.shadow || this.shadowFinals.length) {
      const sinceAbs = Math.max(this.shadowAttachedUntil, trace.speechStart !== undefined ? this.callStart + trace.speechStart - 300 : 0);
      const finals = this.shadowFinals.filter((f) => f.at > sinceAbs);
      if (finals.length) {
        trace.shadow = { ears: this.cfg.shadowEars, finals: finals.map((f) => ({ text: f.text, at: this.rel(f.at) })) };
        this.shadowAttachedUntil = Math.max(...finals.map((f) => f.at));
      }
    }
    if (how === 'resumed' || how === 'superseded') trace.commitReason = `${trace.commitReason}:${how}`;
    finishDerived(trace);
    this.deps.trace.write(trace);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.dropSpec('closed');
    try {
      this.run?.controller.abort();
    } catch {
      /* aborted */
    }
    this.cancelFunctions();
    this.speaker.close();
    for (const mouth of this.mouths.values()) {
      try {
        mouth.close?.();
      } catch {
        /* closed */
      }
    }
    try {
      this.ears?.close();
      this.shadow?.close();
    } catch {
      /* closed */
    }
    this.finishTrace('closed');
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}
