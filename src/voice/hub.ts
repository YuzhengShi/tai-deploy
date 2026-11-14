/**
 * The voice hub: what the portal (src/portal/server.ts) hands voice calls to. It owns the calls of all students on this host:
 *
 *   upgrade   /api/voice: the portal has checked the session cookie and Origin; the hub checks Origin again (a page of another site must
 *             never open a call, which costs money), takes the socket, and speaks the browser protocol of docs/VOICE.md.
 *   relay     /voice-llm/v1/chat/completions: Deepgram's Think requests, authenticated by the call's bearer token (relay.ts).
 *   inject    what the student types in the chat while a call is on goes into the call instead of to the text agent.
 *
 * The limits are taken here, before anything is awaited: one call per student, TAI_VOICE_MAX_CONCURRENT on the host, and the daily
 * minutes (a call gets at most what is left of the student's day). Identity is the portal's PortalUser, never anything the browser says:
 * an interview link's token only says which interview, and one that names another student's folder is refused.
 */
import http from 'http';
import path from 'path';
import type { Duplex } from 'stream';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { RateLimiter, loadSecret } from '../portal/auth.js';
import { clipActivity, clipSpeech } from '../portal/history.js';
import type { ActivityType, HistoryStore } from '../portal/history.js';
import { VOICE_ENV_KEYS, VoiceConfig, chatCompletionsUrl, loadVoiceConfig } from './config.js';
import { LabEngine, type LabEngineDeps } from './lab/engine.js';
import { isChainName, loadLabConfig, type ChainName, type LabConfig } from './lab/config.js';
import type { ChatLine } from './context-builder.js';
import { InterviewTokenInfo, verifyInterviewToken } from './interview-token.js';
import { RelayTokens, createRelay, newSessionId } from './relay.js';
import { screenNoteFor } from './screen.js';
import type { ScreenSources } from './screen.js';
import { DEFAULT_TIMING, VoiceSession, VoiceTiming } from './session.js';
import { speedFor } from './speed.js';
import type { ToolHost } from './tool-host.js';
import { ToolHostPool } from './tool-host-pool.js';
import type { AgentMode, Caller, ChatExtra, VoiceLog } from './types.js';
import type { ChatObject } from '../chat-objects/types.js';
import { parseViewState } from '../chat-objects/view.js';
import type { ViewStore } from '../chat-objects/view.js';
import type { DocsApi } from '../docs/types.js';
import type { SandboxApi } from '../sandbox/types.js';
import type { StoredWorkFact, WorkFact } from '../work-facts.js';
import { CallSlots, VoiceUsage } from './usage.js';

export interface VoiceHub {
  /** The portal has authenticated the cookie and checked Origin; `query` is the upgrade URL's search params. The hub owns the socket from here. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, user: Caller, query: URLSearchParams): void;
  /**
   * The voice lab (docs/VOICE_SELFBUILT.md): the same upgrade for `/api/voice-lab`, for the owner only, onto a self-built chain instead of Deepgram's Voice Agent. Refuses (404) unless the hub was
   * started with TAI_VOICE_LAB=1, and (403) anyone but the owner. The browser protocol is the same; the session is the same session.
   */
  upgradeLab?(req: http.IncomingMessage, socket: Duplex, head: Buffer, user: Caller, query: URLSearchParams): void;
  /** POST /voice-llm/v1/chat/completions: Deepgram's calls for the Think step. No cookie; the bearer token is the check. Streams the answer. */
  relay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  /** The deep link /interview/<token> that start_mock_interview returns: who and what it is for, or null (bad, expired). */
  checkInterviewToken(token: string): { folder: string; assignmentId?: string } | null;
  /** A call is on for this student: typed chat goes to the call (inject) instead of the text agent. */
  isActive(folder: string): boolean;
  inject(folder: string, text: string): boolean;
  /** A call is on and the page knows something the model should answer (a prediction card was run: src/portal/predict-routes.ts): it is told as a note of the host's, not as anything the student typed or said. False when no call is on. */
  tellCall(folder: string, text: string): boolean;
  /**
   * The student pressed the call button and the browser has not asked for the microphone yet: start their tool host now, so that the
   * container is coming up while the permission prompt is on screen (POST /api/voice/warm, src/portal/voice-routes.ts). Answers at once, never
   * waits for the container, never throws; `state` says why nothing was started.
   */
  warm(user: Caller): VoiceWarmResult;
  close(): Promise<void>;
}

/**
 * What warm() did: `warming` a host was started now; `warm` the student already has one waiting; the rest are reasons for nothing: `active` a
 * call of theirs is on (it has its host), `recent` a host was started for them less than a minute ago, `budget` they have no voice time left
 * today, `busy` every voice line is taken or the machine has no spare container, `full` the pool's idle places are all someone's, `off` voice
 * is not running, or there is no pool (TAI_VOICE_TOOLHOST_KEEP_SEC=0).
 */
export interface VoiceWarmResult {
  ok: boolean;
  state: 'warming' | 'warm' | 'active' | 'recent' | 'budget' | 'busy' | 'full' | 'off';
}

/** The least time between two hosts started ahead of a call for one student: a button pressed again and again starts one container, not many. */
export const WARM_EVERY_MS = 60_000;

export interface VoiceDeps {
  groupsDir: string;
  dataDir: string;
  storeDir: string;
  /** https origin + base path, as browsers see the page: Deepgram calls the relay under it. */
  publicBase: string;
  /** The page's origin: an upgrade with any other Origin is refused. Derived from publicBase when absent. */
  publicOrigin?: string;
  /** The portal's secret file: the relay's token key is derived from it (label tai-voice-relay). */
  secretFile: string;
  /** The student's chat in the page: TAi's lines (`kind: 'voice'` for a call's summary), and the wake-up of whoever polls it. */
  appendChat: (folder: string, role: 'user' | 'assistant', text: string, extra?: ChatExtra) => void;
  /** The page's recent chat, oldest first (for the call's context). */
  recentChat?: (folder: string, n: number) => ChatLine[];
  /** The student's memories as lines; without it they are read from groups/<folder>/memory_store.json. */
  memories?: (folder: string, jid: string) => string[];
  /** What TAi remembers of the student's work (a repository, where a session stopped, a problem: docs/STUDENT_STATE.md), newest first; without it the conversation and the interviewer go without. */
  workFacts?: (folder: string) => StoredWorkFact[];
  /** Keeps one fact of the student's work, or takes one back by its key: host-side and best-effort, they never throw. */
  rememberWork?: (folder: string, fact: WorkFact) => void;
  forgetWork?: (folder: string, key: string) => void;
  /** Runs a student's Go code for the run_code function (src/sandbox, docs/GO_SANDBOX.md): for the student of the call, with the account the host bound to them. Without it the function says it is not set up. */
  runSandbox?: SandboxApi['run'];
  /** Where the page says the student is looking (src/chat-objects/view.ts): a call's socket writes it, each turn of the call reads it. Without it a call does not know. */
  views?: ViewStore;
  /** The document viewer's service (src/docs): what show_document, point_at and look_at_screen use. Without it they say it is not set up. */
  docs?: DocsApi;
  /** The chat object on line `n` of this student's chat (the history's line `n` object, or null): what a note about a card they are looking at is made from. Without it such a view says nothing. */
  objectOf?: (folder: string, n: number) => ChatObject | null;
  /**
   * A finished call goes through the host's state writer once (src/student-state-writer.ts, docs/STUDENT_STATE.md): the call's merged turns and the session's facts, for an issue,
   * where the call stopped and a repository the student named. Asynchronous and best-effort: it settles when the writer is done and never rejects; the call waits for it only a moment.
   */
  workFromCall?: (input: { folder: string; turns: Array<{ role: 'student' | 'tai'; text: string }>; facts: string[] }) => Promise<void>;
  /** A `messages` row with the call's summary, for the text agent's next start (it must not wake the text agent). */
  recordVoiceSummary: (jid: string, text: string) => void;
  /** Close the student's running text container: the call has the floor. */
  preemptTextAgent: (jid: string) => void;
  /** A tool host for this student's group (tool-host.ts DockerToolHost around container-runner.ts spawnToolHost). The hub keeps it up for the student's next call (tool-host-pool.ts). */
  spawnToolHost: (folder: string) => ToolHost;
  /** The identity binding of a registered group (only checked: a call for an unregistered folder gets a warning in the log). */
  registeredGroup?: (folder: string) => { jid: string; canvasUserId?: string; githubUsername?: string } | undefined;
  /**
   * Is there a container's worth of room on the machine for something nobody is waiting for yet (a tool host started ahead of a call)? Without
   * it only the voice side's own limits apply: the calls (TAI_VOICE_MAX_CONCURRENT) and the idle hosts (TAI_VOICE_TOOLHOST_KEEP_MAX). The text
   * agents' containers are counted by src/group-queue.ts alone, which does not see a tool host at all, so only the orchestrator can answer this
   * for them: the answer it gives is the one that keeps the last container slot for a student who is waiting for a chat reply.
   */
  spareContainer?: () => boolean;
  /** .env (readEnvFile): DEEPGRAM_API_KEY and VOICE_INTERVIEW_SECRET are read through it when used, so a key typed later counts. */
  readEnv: (keys: string[]) => Record<string, string>;
  /** The process environment (orch.env): the TAI_VOICE_* settings. Default process.env. */
  env?: Record<string, string | undefined>;
  now?: () => number;
  log: VoiceLog;
  /** COMPETENCY.md for a student who has none yet (default <groupsDir>/global/COMPETENCY_TEMPLATE.md). */
  templateFile?: string;
  /** Calendar of the daily budget (default the process's zone). */
  timeZone?: string;
  /** Tests: shorter timers, another Deepgram, another fetch for the gateway. */
  timing?: Partial<VoiceTiming>;
  deepgramUrl?: string;
  fetchImpl?: typeof fetch;
  /** Tests: other ears and mouths than the real ones for the voice lab's stand-in (src/voice/lab/engine.ts). */
  labFactories?: LabEngineDeps['factories'];
}

const FOLDER = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEXT_FRAME = 16 * 1024;
/** The views one socket may send in a minute (the page's own pace is under 75). */
export const VIEW_PER_MINUTE = 120;

/**
 * The portal's history store as VoiceDeps' appendChat and recentChat (what a call leaves in the chat is an `activity` line, the old long summary
 * was a `voice` line; the page wakes its pollers).
 * What a call starts knowing of the chat is the student's words and TAi's answers, not the summaries of earlier calls: in the owner's first
 * day of calls three of them were sent in as TAi's last words, and the model took their topics (and their mistakes) into the next call.
 */
export function chatFromPortal(history: HistoryStore, wakeStudent: (folder: string) => void): Pick<VoiceDeps, 'appendChat' | 'recentChat'> {
  return {
    appendChat: (folder, role, text, extra) => {
      const log = history.forFolder(folder);
      if (extra?.kind === 'activity') {
        // an activity is clipped to the line's limits; one that says nothing (no title, no gist) is not a line
        const clipped = clipActivity({ type: extra.type as ActivityType, title: extra.title ?? '', text, detail: extra.detail, items: extra.items });
        if (!clipped) return;
        log.append(role, clipped.text, new Date(), clipped.extra);
      } else if (extra?.kind === 'object') {
        // a card (a run of their code, a document ...): only what the gate accepts becomes a line, with its own summary as the text
        if (!log.appendObject(extra.obj)) throw new Error('the chat did not take the card');       // the caller says "a card is in the chat" only when this did not throw
      } else if (extra?.kind === 'speech') {
        // what was said aloud in a call: one line a turn (or a marker), bounded; no words and no event is not a line
        const clipped = clipSpeech({ text, call: extra.call, event: extra.event, mode: extra.mode, seconds: extra.seconds });
        if (!clipped) return;
        log.append(role, clipped.text, new Date(), clipped.extra);
      } else log.append(role, text, new Date(), extra?.kind ? { kind: extra.kind } : {});
      wakeStudent(folder);
    },
    recentChat: (folder, n) =>
      history
        .forFolder(folder)
        .tail(n * 2)
        .filter((e) => (!e.kind || e.kind === 'text') && e.text.trim())
        .slice(-n)
        .map((e) => ({ role: e.role, text: e.text })),
  };
}

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    try {
      socket.destroy();
    } catch {
      /* gone */
    }
  }
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* going away */
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/** Null when voice is off (TAI_VOICE != 1), DEEPGRAM_API_KEY is missing, or the portal's secret cannot be read. */
export function createVoiceHub(deps: VoiceDeps): VoiceHub | null {
  const env = deps.env ?? process.env;
  const fromFile = deps.readEnv(VOICE_ENV_KEYS);
  const lookup = (key: string) => env[key] ?? fromFile[key];
  const config = loadVoiceConfig(lookup, (message) => deps.log.warn({}, `voice: ${message}`));
  if (!config.enabled) return null;
  const key = deps.readEnv(['DEEPGRAM_API_KEY']).DEEPGRAM_API_KEY || env.DEEPGRAM_API_KEY;
  if (!key) {
    deps.log.warn({}, 'voice: TAI_VOICE=1 but DEEPGRAM_API_KEY is not set: voice calls are off');
    return null;
  }
  const base = deps.publicBase.replace(/\/+$/, '');
  let origin: string;
  try {
    origin = deps.publicOrigin ?? new URL(base).origin;
    if (!/^https?:\/\//.test(origin) || !(base === origin || base.startsWith(origin + '/'))) throw new Error('publicBase is not under publicOrigin');
  } catch (err) {
    deps.log.error({ err: (err as Error).message }, 'voice: the public address is not usable: voice calls are off');
    return null;
  }
  let tokens: RelayTokens;
  try {
    // the portal's own reading of its secret file (64 hex digits or raw bytes, at least 32)
    tokens = new RelayTokens(loadSecret(deps.secretFile));
  } catch (err) {
    deps.log.error({ err: (err as Error).message }, 'voice: the portal secret cannot be read: voice calls are off');
    return null;
  }
  if (config.think === 'relay' && !config.llmKey) deps.log.warn({}, 'voice: TAI_VOICE_LLM_KEY is empty: the relay calls the gateway without a key');
  // the voice lab reads the process environment only (orch.env); with TAI_VOICE_LAB unset it is `enabled: false` and nothing of it is built
  const lab = loadLabConfig((k) => env[k], (message) => deps.log.warn({}, `voice lab: ${message}`));
  return new Hub(deps, config, tokens, base, origin, lab);
}

class Hub implements VoiceHub {
  private readonly wss: WebSocketServer;
  private readonly byFolder = new Map<string, VoiceSession>();
  private readonly bySid = new Map<string, VoiceSession>();
  /** Every session not yet finished, including those still writing their notes after the student was told the call ended. */
  private readonly unfinished = new Set<VoiceSession>();
  private readonly slots: CallSlots;
  private readonly usage: VoiceUsage;
  /** The tool hosts of calls that ended, kept for the next call of the same student (TAI_VOICE_TOOLHOST_KEEP_SEC). */
  private readonly toolHosts: ToolHostPool;
  private readonly relayHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  private readonly now: () => number;
  private readonly timing: VoiceTiming;
  private readonly env: Record<string, string | undefined>;
  /** What a note about the student's screen is made from (screen.ts): the page's views, the documents service, the student's chat objects. */
  private readonly screen: ScreenSources;
  /** The lab's stand-in (src/voice/lab), when TAI_VOICE_LAB=1: starting, then ready. Null otherwise (and then nothing of the lab exists). */
  private lab: Promise<LabEngine | null> | null = null;
  private labEngine: LabEngine | null = null;
  private closed = false;

  constructor(
    private readonly deps: VoiceDeps,
    private readonly config: VoiceConfig,
    private readonly tokens: RelayTokens,
    private readonly base: string,
    private readonly origin: string,
    labConfig?: LabConfig,
  ) {
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
    this.timing = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) };
    this.screen = { views: deps.views, docs: deps.docs, objectOf: deps.objectOf, now: this.now };
    this.slots = new CallSlots(config.maxConcurrent);
    this.toolHosts = new ToolHostPool({ spawn: deps.spawnToolHost, keepSec: config.toolHostKeepSec, keepMax: config.toolHostKeepMax, log: deps.log });
    this.usage = new VoiceUsage(path.join(deps.storeDir, 'voice-usage.json'), {
      now: this.now,
      timeZone: deps.timeZone,
      warn: (message) => deps.log.warn({}, `voice: ${message}`),
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false, clientTracking: false });
    this.wss.on('error', (err) => deps.log.warn({ err: err.message }, 'voice: websocket server error'));
    this.relayHandler = createRelay({
      tokens,
      isLive: (sid) => {
        const s = this.bySid.get(sid);
        return !!s && !s.ended;
      },
      upstreamUrl: chatCompletionsUrl(config.llmUrl),
      upstreamKey: config.llmKey,
      model: config.model,
      maxTokens: config.maxTokens,
      now: this.now,
      log: deps.log,
      fetchImpl: deps.fetchImpl,
      dumpFile: config.relayDump || undefined,
      muteHandoff: config.muteHandoff,
      speech: config.govern ? { maxSentences: config.maxSentences, maxWords: config.maxWords } : false,
      speechFor: (sid, messages) => this.bySid.get(sid)?.speechLimits(messages),
      modelFor: (sid) => this.bySid.get(sid)?.relayModel(),
      // what the student has open or selected on their page, on each turn of the call (a listener's talk-it-through has no use for it: its prompt does not know the note)
      screenFor: (sid) => {
        const s = this.bySid.get(sid);
        return s && !s.ended && s.mode !== 'listener' ? screenNoteFor(s.user.folder, this.screen) : undefined;
      },
      onClaimDropped: (sid) => this.bySid.get(sid)?.onClaimDropped(),
    });
    if (labConfig?.enabled) this.startLab(labConfig);
  }

  /** The lab needs the relay (its think step is the relay's): a hub on Deepgram's own model has no lab. */
  private startLab(cfg: LabConfig): void {
    if (this.config.think !== 'relay') {
      this.deps.log.warn({}, 'voice lab: TAI_VOICE_LAB=1 needs TAI_VOICE_THINK=relay: the lab is off');
      return;
    }
    const c = this.config;
    this.lab = LabEngine.start({
      config: cfg,
      profiles: {
        chat: { eotThreshold: c.eotThreshold, eotTimeoutMs: c.eotTimeoutMs },
        interview: { eotThreshold: c.interviewEotThreshold, eotTimeoutMs: c.interviewEotTimeoutMs },
        talk: { eotThreshold: c.talkEotThreshold, eotTimeoutMs: c.talkEotTimeoutMs },
      },
      relay: this.relayHandler,
      deepgramKey: () => this.deepgramKey(),
      log: this.deps.log,
      traceFile: cfg.traceFile || path.join(this.deps.dataDir, 'voice-lab', 'turns.jsonl'),
      fetchImpl: this.deps.fetchImpl,
      factories: this.deps.labFactories,
    }).then(
      (engine) => {
        this.labEngine = engine;
        return engine;
      },
      (err: Error) => {
        this.deps.log.error({ err: err.message }, 'voice lab: the stand-in could not start: the lab is off');
        return null;
      },
    );
  }

  private deepgramKey(): string {
    try {
      return this.deps.readEnv(['DEEPGRAM_API_KEY']).DEEPGRAM_API_KEY || this.env.DEEPGRAM_API_KEY || '';
    } catch {
      return '';
    }
  }

  checkInterviewToken(token: string): InterviewTokenInfo | null {
    let secret: string | undefined;
    try {
      secret = this.deps.readEnv(['VOICE_INTERVIEW_SECRET']).VOICE_INTERVIEW_SECRET || this.env.VOICE_INTERVIEW_SECRET;
    } catch {
      secret = undefined;
    }
    return verifyInterviewToken(token, secret, this.now());
  }

  isActive(folder: string): boolean {
    const s = this.byFolder.get(folder);
    return !!s && !s.ended;
  }

  /**
   * What the pool keys a host by besides the folder: the accounts the container got. A call's acquire() and a warm start must build it the same
   * way, or the host started ahead of a call would be closed as "bound differently" by the call that was meant to take it over.
   */
  private bindingOf(user: Caller): string {
    return `${user.canvasUserId ?? ''}|${user.githubUsername ?? ''}`;
  }

  /** When a host was last started ahead of a call, for each student (entries older than the minute are dropped as it goes). */
  private readonly warmedAt = new Map<string, number>();

  warm(user: Caller): VoiceWarmResult {
    try {
      return this.warmFor(user);
    } catch (err) {
      this.deps.log.warn({ folder: user?.folder, err: (err as Error).message }, 'voice: a tool host could not be started ahead of a call');
      return { ok: false, state: 'off' };
    }
  }

  /**
   * The rules, in the order that makes the cheapest refusals first. Nothing here waits: the container is started and left to come up.
   * Nothing is taken that a call or a chat needs: a student with a call open has their host; the pool's idle places are filled, never
   * emptied (a full pool refuses rather than dropping the oldest, which would be someone else's warm host); and when the voice lines are
   * all taken the next call would be refused anyway.
   */
  private warmFor(user: Caller): VoiceWarmResult {
    if (this.closed || this.config.toolHostKeepSec <= 0 || !this.deepgramKey()) return { ok: false, state: 'off' };
    if (!user || !FOLDER.test(user.folder)) return { ok: false, state: 'off' };
    // a call of theirs is on, or the last one is still being saved (it holds its slot until it is over): the host of that call is theirs
    if (this.isActive(user.folder) || this.slots.has(user.folder)) return { ok: false, state: 'active' };
    const now = this.now();
    for (const [folder, at] of this.warmedAt) if (now - at >= WARM_EVERY_MS) this.warmedAt.delete(folder);
    if (this.warmedAt.has(user.folder)) return { ok: false, state: 'recent' };
    // every attempt that gets this far uses the student's minute, whatever the answer: it used to be only a host that was started, so a student (or a
    // script holding the call button) whose attempts were refused (busy, full, budget) could ask again and again, each time going through the pool
    this.warmedAt.set(user.folder, now);
    if (this.config.dailyMin * 60 - this.usage.usedSeconds(user.folder) < 60) return { ok: false, state: 'budget' };
    if (this.slots.count >= this.config.maxConcurrent) return { ok: false, state: 'busy' };
    if (this.deps.spareContainer && !this.deps.spareContainer()) return { ok: false, state: 'busy' };
    const outcome = this.toolHosts.warm(user.folder, this.bindingOf(user));
    if (outcome === 'warming') return { ok: true, state: 'warming' };
    if (outcome === 'warm') {
      // the student has one waiting: nothing was asked of the pool, so the minute is not used (a refused or failed attempt is)
      this.warmedAt.delete(user.folder);
      return { ok: true, state: 'warm' };
    }
    return { ok: false, state: outcome };                               // 'full' and 'off': nothing could be
  }

  inject(folder: string, text: string): boolean {
    const s = this.byFolder.get(folder);
    if (!s || s.ended) return false;
    try {
      return s.inject(text);
    } catch {
      return false;
    }
  }

  tellCall(folder: string, text: string): boolean {
    const s = this.byFolder.get(folder);
    if (!s || s.ended) return false;
    try {
      return s.tell(text);
    } catch {
      return false;
    }
  }

  async relay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.relayHandler(req, res);
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'voice relay failed');
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"the language model is unavailable"}}');
      } else {
        res.end();
      }
    }
  }

  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, user: Caller, _query: URLSearchParams): void {
    socket.on('error', () => undefined); // a client that vanishes mid-handshake must not become an uncaught error
    try {
      if (this.closed) return refuseUpgrade(socket, 503, 'Service Unavailable');
      if (req.headers.origin !== this.origin) return refuseUpgrade(socket, 403, 'Forbidden');
      if (!user || !FOLDER.test(user.folder) || typeof user.jid !== 'string' || !user.jid) return refuseUpgrade(socket, 403, 'Forbidden');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user));
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'voice: upgrade failed');
      try {
        socket.destroy();
      } catch {
        /* gone */
      }
    }
  }

  upgradeLab(req: http.IncomingMessage, socket: Duplex, head: Buffer, user: Caller, query: URLSearchParams): void {
    socket.on('error', () => undefined);
    try {
      // with the flag off there is no lab: the route does not exist; for anyone but the owner it exists and is not theirs
      if (this.closed || !this.lab) return refuseUpgrade(socket, 404, 'Not Found');
      if (req.headers.origin !== this.origin) return refuseUpgrade(socket, 403, 'Forbidden');
      if (!user || user.role !== 'owner') return refuseUpgrade(socket, 403, 'Forbidden');
      if (!FOLDER.test(user.folder) || typeof user.jid !== 'string' || !user.jid) return refuseUpgrade(socket, 403, 'Forbidden');
      // `?chain=d|h|fd|c` picks the chain of this call (docs A10); anything else is the process's own settings, as in round 1
      const chain = query.get('chain');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, user, true, isChainName(chain) ? chain : undefined));
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'voice lab: upgrade failed');
      try {
        socket.destroy();
      } catch {
        /* gone */
      }
    }
  }

  private onConnection(ws: WebSocket, user: Caller, lab = false, chain?: ChainName): void {
    ws.on('error', (err) => this.deps.log.debug({ folder: user.folder, err: err.message }, 'voice: browser socket error'));
    const conn: { session: VoiceSession | null; started: boolean; lab: boolean; chain?: ChainName } = { session: null, started: false, lab, chain };
    const textLimit = new RateLimiter(30, 60_000, this.now);
    const frameLimit = new RateLimiter(240, 60_000, this.now);
    // the page reports the whole view at most every 0.8 s (about 75 a minute at the most); this allows for a little more than that
    const viewLimit = new RateLimiter(VIEW_PER_MINUTE, 60_000, this.now);
    const startTimer = setTimeout(() => {
      if (!conn.started) {
        send(ws, { type: 'error', code: 'no-start', message: 'Expected a start message.' });
        ws.close(1008);
      }
    }, 10_000);
    startTimer.unref?.();
    ws.on('message', (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          conn.session?.audioIn(toBuffer(data));
          return;
        }
        if (!frameLimit.allow('frames')) return;
        const text = toBuffer(data).toString('utf-8');
        if (text.length > MAX_TEXT_FRAME) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
        switch (msg.type) {
          case 'start':
            if (conn.started) return;
            conn.started = true;
            clearTimeout(startTimer);
            this.start(ws, conn, user, msg);
            return;
          case 'text': {
            const s = conn.session;
            const typed = typeof msg.text === 'string' ? msg.text.replace(/\r\n/g, '\n').trim().slice(0, 6000) : '';
            if (!s || s.ended || !typed) return;
            if (!textLimit.allow('text')) {
              send(ws, { type: 'notice', text: 'Slow down a little: that was not sent.' });
              return;
            }
            // it did not come through /api/send, so it is not in the chat yet: put it there, then into the call
            try {
              this.deps.appendChat(user.folder, 'user', typed);
            } catch (err) {
              this.deps.log.warn({ folder: user.folder, err: (err as Error).message }, 'voice: could not add the typed line to the chat');
            }
            s.inject(typed);
            return;
          }
          case 'view': {
            // where the student is looking (docs/CHAT_OBJECTS.md "The view"): kept for this student, with or without a call attached to the socket yet. An empty view is kept too: it is how the page
            // says the viewer was closed. One that does not parse is dropped; the folder is the portal's, never the page's
            if (!this.deps.views || !viewLimit.allow('view')) return;
            const view = parseViewState(msg.view);
            if (view) this.deps.views.set(user.folder, view);
            return;
          }
          case 'mute':
            conn.session?.setMuted(msg.muted === true);
            return;
          case 'end':
            conn.session?.hangUp();
            return;
          case 'ping':
            send(ws, { type: 'pong' });
            return;
          default:
            return;
        }
      } catch (err) {
        this.deps.log.warn({ folder: user.folder, err: (err as Error).message }, 'voice: a browser message could not be handled');
      }
    });
    ws.on('close', () => {
      clearTimeout(startTimer);
      try {
        conn.session?.detach(ws);
      } catch {
        /* nothing left to do */
      }
    });
  }

  private refuse(ws: WebSocket, code: string, message: string): void {
    send(ws, { type: 'error', code, message });
    try {
      ws.close(1000);
    } catch {
      /* gone */
    }
  }

  private start(ws: WebSocket, conn: { session: VoiceSession | null; lab?: boolean; chain?: ChainName }, user: Caller, msg: Record<string, unknown>): void {
    const resume = msg.resume === true;
    // a call on the lab's chain: its stand-in must be up (it starts with the hub, a moment after the service does)
    const engine = conn.lab ? this.labEngine : null;
    if (conn.lab && !engine && !resume) return this.refuse(ws, 'not-configured', 'The voice lab is not ready.');
    const existing = this.byFolder.get(user.folder);
    if (existing && !existing.ended) {
      if (resume) {
        conn.session = existing;
        existing.attach(ws, true);
        return;
      }
      return this.refuse(ws, 'busy', 'You already have a voice call open (in another tab?). Hang that one up first.');
    }
    if (resume) return this.refuse(ws, 'no-session', 'That call has ended.');
    if (this.closed) return this.refuse(ws, 'not-configured', 'Voice calls are not available right now.');

    let mode: AgentMode = msg.mode === 'interview' ? 'interviewer' : msg.mode === 'talk' ? 'listener' : 'conversational';
    let interview: { assignmentId?: string; topic?: string } | undefined;
    let talk: { topic?: string } | undefined;
    if (msg.token !== undefined && msg.token !== null && msg.token !== '') {
      const info = typeof msg.token === 'string' ? this.checkInterviewToken(msg.token) : null;
      if (!info || info.folder !== user.folder) {
        this.deps.log.warn({ folder: user.folder, valid: !!info }, 'voice: an interview link that is not this student\'s was refused');
        return this.refuse(ws, 'bad-token', 'This interview link is not valid for your account, or it has expired. Ask TAi for a new one.');
      }
      mode = 'interviewer';
      interview = { assignmentId: info.assignmentId };
    } else if (mode === 'interviewer') {
      interview = {};
    } else if (mode === 'listener') {
      // what the student typed they want to explain: plain words only, short (it goes into a prompt)
      const topic = typeof msg.topic === 'string' ? msg.topic.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      talk = topic ? { topic } : {};
    }

    // (a lab call may run on LabGPU's services alone: whatever of Deepgram's it uses, the stand-in checks for itself)
    if (!engine && !this.deepgramKey()) return this.refuse(ws, 'not-configured', 'Voice calls are not set up on this server.');
    const remaining = this.config.dailyMin * 60 - this.usage.usedSeconds(user.folder);
    if (remaining < 60) {
      return this.refuse(ws, 'budget', `You have used today's ${this.config.dailyMin} minutes of voice calls. The chat is still open.`);
    }
    const slot = this.slots.take(user.folder);
    if (slot === 'student-busy') return this.refuse(ws, 'busy', 'Your last call is still being saved. Try again in a few seconds.');
    if (slot === 'host-full') return this.refuse(ws, 'busy', 'All voice lines are busy right now. Try again in a few minutes.');

    if (this.deps.registeredGroup && !this.deps.registeredGroup(user.folder)) {
      this.deps.log.warn({ folder: user.folder }, 'voice: the student has no registered chat yet: messages and schedules from the call will be refused');
    }
    const sid = newSessionId();
    let session: VoiceSession;
    try {
      session = new VoiceSession(
        // the pace this student chose in Settings (their preferences file, read now: a change counts from the next call), else the deployment's
        { sid, user, mode, maxSeconds: Math.min(this.config.sessionMin * 60, Math.floor(remaining)), interview, talk, speed: speedFor(user.folder, this.config.speed, { storeDir: this.deps.storeDir }) },
        {
          config: this.config,
          groupsDir: this.deps.groupsDir,
          dataDir: this.deps.dataDir,
          templateFile: this.deps.templateFile ?? path.join(this.deps.groupsDir, 'global', 'COMPETENCY_TEMPLATE.md'),
          // a lab call connects to the stand-in with a token of its own (never the Deepgram key) and its think requests go to the loopback door of this hub's relay
          deepgramUrl: engine ? engine.agentUrlFor(conn.chain) : (this.deps.deepgramUrl ?? this.config.deepgramUrl),
          deepgramKey: engine ? () => engine.token : () => this.deepgramKey(),
          relay: this.config.think === 'relay' ? { url: engine ? engine.relayUrl : `${this.base}/voice-llm/v1/chat/completions`, tokens: this.tokens } : null,
          // the student's own host from their last call when it is still up and bound as they are now, else a new one
          spawnToolHost: (folder) => this.toolHosts.acquire(folder, this.bindingOf(user)),
          appendChat: this.deps.appendChat,
          recentChat: this.deps.recentChat,
          memories: this.deps.memories,
          workFacts: this.deps.workFacts,
          rememberWork: this.deps.rememberWork,
          forgetWork: this.deps.forgetWork,
          runSandbox: this.deps.runSandbox,
          views: this.deps.views,
          docs: this.deps.docs,
          objectOf: this.deps.objectOf,
          workFromCall: this.deps.workFromCall,
          recordVoiceSummary: this.deps.recordVoiceSummary,
          gateway: { url: this.config.llmUrl, key: this.config.llmKey, model: this.config.evalModel, fetchImpl: this.deps.fetchImpl, log: this.deps.log },
          addUsage: (folder, seconds) => this.usage.add(folder, seconds),
          onClosed: (s) => this.onClosed(s),
          onFinished: (s) => this.unfinished.delete(s),
          now: this.now,
          timing: this.timing,
          log: this.deps.log,
        },
      );
    } catch (err) {
      this.slots.release(user.folder);
      this.deps.log.error({ folder: user.folder, err: (err as Error).message }, 'voice: the call could not be set up');
      return this.refuse(ws, 'error', 'The voice call could not start.');
    }
    this.byFolder.set(user.folder, session);
    this.bySid.set(sid, session);
    this.unfinished.add(session);
    conn.session = session;
    try {
      this.deps.preemptTextAgent(user.jid);
    } catch (err) {
      this.deps.log.warn({ folder: user.folder, err: (err as Error).message }, 'voice: could not stop the text agent');
    }
    session.attach(ws, false);
    void session.start();
  }

  private onClosed(session: VoiceSession): void {
    if (this.byFolder.get(session.user.folder) === session) this.byFolder.delete(session.user.folder);
    this.bySid.delete(session.sid);
    this.slots.release(session.user.folder);
    this.usage.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // end() of a session that is already ending is the same promise: its notes get written before the process goes
    const sessions = [...this.unfinished];
    await Promise.race([
      Promise.all(sessions.map((s) => s.end('error', { code: 'shutdown', message: 'The server is restarting; call again in a minute.' }))),
      new Promise((resolve) => setTimeout(resolve, 15_000).unref?.()),
    ]);
    // the hosts kept for next calls go with the service (the calls above have given theirs back by now, and none is kept from here on)
    await Promise.race([this.toolHosts.closeAll(), new Promise((resolve) => setTimeout(resolve, 10_000).unref?.())]);
    // the lab's stand-in goes after the calls that used it
    if (this.lab) await Promise.race([this.lab.then((engine) => engine?.close()), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
    this.usage.flush();
    try {
      this.wss.close();
    } catch {
      /* already */
    }
  }
}
