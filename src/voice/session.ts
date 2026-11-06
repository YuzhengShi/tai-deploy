/**
 * One student's voice call: the browser's WebSocket on one side, one Deepgram Voice Agent WebSocket on the other
 * (wss://agent.deepgram.com/v1/agent/converse), and between them everything that makes it TAi: the student's context, the functions,
 * the mock interview as a mode of the same call, the limits, and what the call leaves behind when it ends.
 *
 *   Deepgram  Welcome -> Settings -> SettingsApplied (10 s gate) -> audio both ways, KeepAlive every 5 s, events. A Settings error about
 *             a Flux listen model reconnects once with nova-3. An unexpected close after the call is live reconnects once with the
 *             conversation so far as context.
 *   browser   binary PCM16 16 kHz in, PCM16 24 kHz out; JSON events (docs/VOICE.md, "Browser protocol"). A browser that drops has 30 s
 *             to come back (start with resume); the Deepgram side keeps running meanwhile.
 *   modes     conversational <-> interviewer, and conversational <-> listener (a talk-it-through), by UpdateThink (the whole think block
 *             again) + UpdateSpeak (another voice, when the mode has one) + UpdateListen (its turn-taking) + a queued InjectAgentMessage,
 *             each confirmation awaited (5 s), on the same connection: no audio gap, the history is kept.
 *   inject    what the student types in the chat, and the lines the call speaks itself, go out one at a time: InjectionRefused names no
 *             message, so only one may be unconfirmed, and a refusal puts it back at the head of the queue for after AgentAudioDone.
 *   limits    the session cap with a wrap-up a minute before (UpdatePrompt appends), the interview cap likewise, the daily budget (the
 *             hub gives the session its maxSeconds), three minutes without the student saying anything, and a hard ceiling.
 *
 * Nothing in here may throw into the process (logger.ts exits on an uncaught exception): every handler is guarded, an error ends this
 * call only, and the end runs once whatever triggers it. The Deepgram key and the relay token are never logged.
 */
import path from 'path';

import { WebSocket } from 'ws';

import { urlsIn } from './canvas-text.js';
import { isChatClaim } from './chat-claim.js';
import { CompetencyGuard, InterviewResults, appendVoiceSession, levelWord, overallRating, rubricLine, score, writeInterviewResults } from './competency.js';
import type { VoiceConfig } from './config.js';
import { isFluxModel } from './config.js';
import {
  ChatLine,
  HistoryItem,
  InterviewContext,
  StudentContext,
  buildContextMessages,
  clip,
  loadInterviewContext,
  loadStudentContext,
} from './context-builder.js';
import { EvaluationResult, GatewayOptions, evaluateDetailed, summarizeCall } from './evaluator.js';
import { waitForIpcAnswer } from './ipc-answer.js';
import { RepoLookup, lookUpRepo } from './interview-repo.js';
import { pickAssignment, topicEvidenced } from './interview-topic.js';
import { isLeadIn } from './lead-in.js';
import { CALL_FUNCTIONS, CodeSeen, PROMOTABLE_FUNCTIONS, SLOW_FUNCTIONS, TOOL_HOST_FUNCTIONS, capResult, clearSendFlag, errorResult, functionsFor, newCodeSeen, parseArgs, runFunction } from './functions.js';
import { HANDOFF_MARK, PROMPT_MAX, SYSTEM_NOTE, TYPED_NOTE, appendices, conversationalPrompt, fillerLine, firstNameOf, interviewerPrompt, lines, listenerPrompt, pickLine, promotion } from './prompts.js';
import type { FillerKind } from './prompts.js';
import { RelayTokens } from './relay.js';
import { REVIEW_KEEP, REVIEW_MAX, ReviewItem, Weighed, pickItems, reviewItem } from './review.js';
import { practicingOf, weekNext } from './week-brief.js';
import { LISTENER_FEEDBACK, LISTENER_NUDGE } from './speech-governor.js';
import type { GovernorOptions } from './speech-governor.js';
import { TEACH_LIMITS, teachingNow } from './teach.js';
import { buildSettings, isFluxVoice, listenUpdate, speakConfig, thinkConfig } from './settings.js';
import type { TurnProfile } from './settings.js';
import type { ToolHost } from './tool-host.js';
import type { AgentMode, Caller, ChatExtra, CloseReason, VoiceLog } from './types.js';

export interface VoiceTiming {
  settingsTimeoutMs: number;
  keepAliveMs: number;
  graceMs: number;
  tickMs: number;
  timerEventMs: number;
  updateWaitMs: number;
  handoffPauseMs: number;
  farewellMinMs: number;
  farewellMaxMs: number;
  closingDelayMs: number;
  hardCeilingExtraMs: number;
  injectAckMs: number;
  injectRetryMs: number;
  summaryTimeoutMs: number;
  silenceNudgeBeforeMs: number;
  toolHostWaitMs: number;
  /** How long after TAi says it put something in the chat before checking that it did. */
  claimCheckMs: number;
  /** How long a look-up may run before TAi says a pre-written "one sec" (0: never), and how long after that one before it says "still looking". */
  fillerAfterMs: number;
  stillLookingMs: number;
  /** How long after TAi finishes a turn that only announced its answer ("here's a quick rundown") before it is asked to give the answer. */
  leadInWaitMs: number;
}

export const DEFAULT_TIMING: VoiceTiming = {
  settingsTimeoutMs: 10_000,
  keepAliveMs: 5_000,
  graceMs: 30_000,
  tickMs: 1_000,
  timerEventMs: 5_000,
  updateWaitMs: 5_000,
  handoffPauseMs: 500,
  farewellMinMs: 3_000,
  farewellMaxMs: 9_000,
  closingDelayMs: 8_000,
  hardCeilingExtraMs: 15_000,
  injectAckMs: 1_500,
  injectRetryMs: 3_000,
  summaryTimeoutMs: 12_000,
  silenceNudgeBeforeMs: 30_000,
  toolHostWaitMs: 30_000,
  claimCheckMs: 2_500,
  fillerAfterMs: 1_500,
  stillLookingMs: 5_000,
  leadInWaitMs: 2_500,
};

export interface SessionDeps {
  config: VoiceConfig;
  groupsDir: string;
  dataDir: string;
  templateFile?: string;
  deepgramUrl: string;
  /** Read when a connection opens, so a rotated key counts; never logged. */
  deepgramKey: () => string;
  /** The relay's public URL and the token minter; null when Think is Deepgram's own model. */
  relay: { url: string; tokens: RelayTokens } | null;
  spawnToolHost: (folder: string) => ToolHost;
  appendChat: (folder: string, role: 'user' | 'assistant', text: string, extra?: ChatExtra) => void;
  recentChat?: (folder: string, n: number) => ChatLine[];
  memories?: (folder: string, jid: string) => string[];
  recordVoiceSummary: (jid: string, text: string) => void;
  gateway: GatewayOptions;
  /** Counts connected seconds to the student's day (the hub's usage store). */
  addUsage: (folder: string, seconds: number) => void;
  /** The call is over for the student (Deepgram closed, `closed` sent): the hub forgets it and gives its slot back. */
  onClosed: (session: VoiceSession) => void;
  /** Everything is done, the post-call writes included. */
  onFinished?: (session: VoiceSession) => void;
  now: () => number;
  timing: VoiceTiming;
  log: VoiceLog;
}

export interface SessionStart {
  sid: string;
  user: Caller;
  mode: AgentMode;
  maxSeconds: number;
  interview?: { assignmentId?: string; topic?: string };
  /** A call that starts as a talk-it-through: what the student said they want to explain (optional). */
  talk?: { topic?: string };
  /** The pace the student chose in Settings, as the hub read it when the call began (speed.ts speedFor); absent: the deployment's TAI_VOICE_SPEED. 1 is the voice's own pace. */
  speed?: number;
}

type Injection = { kind: 'user' | 'agent'; text: string; retry: boolean; attempts: number; filler?: boolean };

/** What a function answers the model with, and what the call does once that has been said (a mode switch, the end). */
type CallOutcome = { content: string; after?: () => Promise<void> };

interface DeepgramConn {
  ws: WebSocket;
  listenModel: string;
  settingsSent: boolean;
  applied: boolean;
  history: HistoryItem[];
  greeting: string | null;
  reconnect: boolean;
}

interface InterviewState {
  context: InterviewContext;
  startedAt: number;
  evaluations: EvaluationResult[];
  topics: Set<string>;
  finished: boolean;
  /** The week's beats (week-brief.ts) that the result of evaluate_answer has named as due so far: a brief that arrives late is caught up from this record, one beat to an answer. */
  beats: Set<string>;
  /** The student's repository for the assignment and the names of its files, once the look-up that starts with the interview has answered (none: still looking, or nothing to look for). */
  repo?: RepoLookup;
}

/** A talk-it-through: the student explains out loud, TAi listens (docs/VOICE.md, "Talk it through"). */
interface TalkState {
  /** What the student said they want to explain ('' when they did not say). */
  topic: string;
  startedAt: number;
  /** TAi's own note when it ended the talk (end_talk_through). */
  summary: string;
  finished: boolean;
}

interface TranscriptEntry {
  role: 'student' | 'tai';
  text: string;
  mode: AgentMode;
  at: number;
}

const MAX_TRANSCRIPT = 600;
/** TAI_VOICE_TRACE=1: every event Deepgram sends (but the latency reports and the history) is logged with the call's state, to see in what order things happen. */
const TRACE = process.env.TAI_VOICE_TRACE === '1';
/** A student who says they have no idea (short lines only). */
const LOST = /^\W*(?:i\s+)?(?:really\s+)?(?:don'?t|do not)\s+(?:know|understand|get)\b|^\W*(?:nothing|no idea|no clue|not sure|idk)\b|\b(?:i'?m|i am)\s+(?:so\s+|totally\s+)?(?:lost|confused|stuck)\b|^\W*give me a hint|^\W*what\W*$|\bdon'?t know anything\b|\bno background\b/i;
/** The student asking for something to be put in the chat (a note, a link, a diagram, the slides): a claim that it was sent without a send is then worth a nudge. */
const ASKED_FOR_CHAT = /\b(?:chat|write (?:it|that|this|those|them)?\s*(?:down|out)|send (?:it|that|this|me|them)|put (?:it|that|this|them)|paste|text me|links?|diagram|draw|show me|slides?|pdf)\b/i;
/** "Too long", "keep it short": said to an answer. */
const TOO_LONG = /\b(?:too long|too much|too wordy|shorter|keep it short|be brief|say less|so long)\b/i;
const MAX_INJECT_ATTEMPTS = 6;
/** How often in one call TAi is asked to give an answer it only announced (noticeLeadIn). */
const LEAD_IN_MAX_NUDGES = 3;
const USER_TURN_MS = 15_000;
const AUDIO_BURST_BYTES = 96_000; // 3 s of 16 kHz PCM16
const AUDIO_RATE_BYTES = 48_000; // 1.5x real time
const BARGE_IN_DROP_MS = 1500;
/** The student asking to explain something out loud: start_talk_through is let through. Or TAi offering it, and the student saying yes. */
const TALK_WANTED = /\b(?:talk(?:ing)?\s+(?:it|this|that|something|them|\w+)?\s*through|walk(?:ing)?\s+(?:you|me)\s+through|out loud|aloud|practi[cs]e explaining|rubber duck|let me (?:try )?(?:to )?explain|can i (?:try )?(?:to )?explain|(?:i'?ll|i will|i want to|i wanna|i'd like to) (?:try )?(?:to )?explain)\b/i;
const TALK_OFFER = /\b(?:talk(?:ing)?\s+(?:it|this|that|something)?\s*through|out loud|aloud|explain (?:it|that|this) (?:to me|back)|walk me through)\b/i;
const YES = /^\W*(?:yes|yeah|yep|yup|sure|okay|ok|alright|sounds good|let'?s (?:do it|go)|go ahead|please|why not|of course)\b/i;
/** What a student has to have explained (words) before TAi's turns in a talk-it-through may be its feedback and no longer only nudges (speechLimits). */
const TALK_FEEDBACK_WORDS = 45;
/** The longest result a note carries to the model: what a person would say of a look-up, not the whole of it. */
const NOTE_RESULT_CHARS = 1500;
/** At most this many look-ups run on in the background (promotion) at once. */
const MAX_BACKGROUND = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/** The promise's value, or null when it has not settled within ms (it goes on running either way; it must never reject). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** The first sentence of a text (up to `max` characters, cut with an ellipsis), with a capital: the one line of a call's activity card. */
export function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](?=\s|$)/);
  const one = end > 0 ? flat.slice(0, end + 1) : flat;
  const cut = one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** A function's answer is an error ({"error": ...}, functions.ts errorResult). */
const isErrorResult = (content: string): boolean => /^\s*\{\s*"error"\s*:/.test(content);

/** "query_canvas file_content": what a note says was looked up. */
function describeCall(name: string, args: Record<string, unknown>): string {
  const action = str(args.action, 40);
  return action ? `${name.slice(0, 40)} ${action}` : name.slice(0, 40);
}

/** The text of the last thing the student said in the messages Deepgram sent the model (a note of ours is not theirs), or ''. */
function lastStudentLine(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m?.role !== 'user') continue;
    const text = (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p as { text?: unknown })?.text ?? '').join('') : '').trim();
    if (!text.startsWith(SYSTEM_NOTE)) return text;
  }
  return '';
}

/** At most `max` characters of a result for a note: cut where a person would stop, and said so. */
function cutForNote(text: string, max: number): string {
  const plain = text.trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 30).trimEnd()} [... cut: the rest is longer]`;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '';
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${localDay(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The lines of a transcript as turns: the sentences one speaker said one after the other (Deepgram sends them one by one) are one turn. */
export function mergeTurns(entries: ReadonlyArray<{ role: 'student' | 'tai'; text: string; mode: AgentMode }>): Array<{ role: 'student' | 'tai'; text: string; mode: AgentMode }> {
  const out: Array<{ role: 'student' | 'tai'; text: string; mode: AgentMode }> = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.role === e.role && last.mode === e.mode) last.text = `${last.text} ${e.text}`.slice(0, 4000);
    else out.push({ role: e.role, text: e.text, mode: e.mode });
  }
  return out;
}

/** "Monday, November 2, 2026 at 6:35 AM PST": the course keeps Pacific time, and "due this morning" means nothing without the hour. */
function longDate(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
}

export class VoiceSession {
  readonly sid: string;
  readonly user: Caller;
  readonly maxSeconds: number;
  readonly startedMode: AgentMode;
  mode: AgentMode;
  state: 'connecting' | 'live' | 'ending' | 'closed' = 'connecting';

  private readonly deps: SessionDeps;
  private readonly t: VoiceTiming;
  private readonly log: VoiceLog;
  private readonly groupDir: string;
  private readonly ipcDir: string;
  private readonly guard = new CompetencyGuard();
  private readonly firstName: string;

  private browser: WebSocket | null = null;
  private dg: DeepgramConn | null = null;
  private listenFellBack = false;
  private reconnected = false;
  private voice: string;
  private context: StudentContext | null = null;
  private interview: InterviewState | null = null;
  private readonly interviewRequest?: { assignmentId?: string; topic?: string };
  private readonly interviewsDone: InterviewResults[] = [];
  private readonly transcript: TranscriptEntry[] = [];
  private readonly topicsTouched = new Set<string>();
  /** start_interview was refused once for want of a topic the student named: the model has been told to ask, and its next try is let through. */
  private interviewAsked = false;
  /** Deepgram's report of each turn (milliseconds): what the call felt like, in the log and in the summary at its end. */
  private readonly latencies: Array<{ stt?: number; ttt?: number; tool?: number; tts?: number; total?: number }> = [];
  private latencyParts: { stt?: number; ttt?: number; tool?: number; tts?: number; total?: number } = {};
  private speakFellBack = false;
  /** How the voice speaks: from the configuration, given up (once) when Deepgram refuses it. */
  private speed: number | undefined;
  private expressivity: number;
  /** When TAi last put something in the chat, and how often a claim that it had was found to be untrue (see checkChatClaim). */
  private lastChatSendAt = 0;
  private studentTurnAt = 0;
  private claimTimer: NodeJS.Timeout | null = null;
  private claimsCorrected = 0;
  /**
   * TAi's last turn only announced its answer (lead-in.ts) and nothing has been said since: the timer asks it to give the answer once the
   * student has waited leadInWaitMs. Once to a student turn (leadInTurn), three times to a call.
   */
  private leadInOpen = false;
  private leadInTimer: NodeJS.Timeout | null = null;
  private leadInTurn = -1;
  private leadInNudges = 0;
  /** Student turns in a row that say they have no idea: the second one changes TAi's approach (see noticeLost). */
  private lostTurns = 0;
  private shifted = false;
  private briefed = false;
  /** The student turn (studentTurnAt) that a filler was already said in. */
  private fillerTurn = -1;
  /** How many fillers of each kind this call has said: where in its list the next one comes from (prompts.ts fillerLine). */
  private readonly fillersSaid: Record<FillerKind, number> = { tool_wait: 0, slow: 0, start_interview: 0, reading: 0, still: 0 };
  /** The second line of a long wait ("still looking"), armed when the first one is said. */
  private stillTimer: NodeJS.Timeout | null = null;
  /** Look-ups answered provisionally that are still running (TAI_VOICE_ASYNC_AFTER_MS), and what they are ("query_canvas:{...}"). */
  private background = 0;
  private readonly backgroundKeys = new Set<string>();
  /** The talk-it-through going on and the ones that are over; whether the model has been told to offer one; what the student has explained in it. */
  private talk: TalkState | null = null;
  private readonly talkRequest?: { topic?: string };
  private readonly talksDone: Array<{ topic: string; minutes: number; summary: string }> = [];
  private talkAsked = false;
  private talkWrapSent = false;
  private talkClosing = false;
  private explainedWords = 0;
  private lastStudentText = '';
  /** The links this call has seen (the course status, what the student said or typed, every lookup's answer): the only ones send_to_chat lets through. */
  private readonly seenUrls = new Set<string>();
  /** The files an interview has read from the student's repository, and which have an excerpt in the chat (the guard on the interviewer's send_to_chat, functions.ts). */
  private readonly codeSeen: CodeSeen = newCodeSeen();
  /** The questions of the call's mock interview(s) that were really scored, as review items (review.ts): they go on the activity line when the call ends. Kept on the call because an interview's state is dropped as it finishes. */
  private readonly reviewPool: Weighed[] = [];
  private readonly lookupCache = new Map<string, { at: number; r: { ok: boolean; text: string } }>();
  /** "one sec, let me check" has been said while the tool host was still starting. */
  private toolWaitSaid = false;
  /** Function calls running now, and whether the answer to one that finished has yet to begin: the page must not say "listening" while TAi is still looking something up. */
  private pendingCalls = 0;
  private answerOwed = false;
  /** What really went into the chat during the call (send_to_chat, render_diagram): the summary must not take TAi's word for it. */
  private chatSent = 0;
  private summaryNote = '';

  private toolHost: ToolHost | null = null;
  private toolHostReady: Promise<ToolHost | null> | null = null;
  private toolHostRetried = false;

  private liveAt = 0;
  private endedAt = 0;
  private lastSpeechAt = 0;
  private lastTimerEvent = 0;
  private billingSince: number | null = null;
  private wrapSent = false;
  private closingAt = 0;
  private interviewWrapSent = false;
  private interviewClosing = false;
  private nudged = false;
  private muted = false;
  private agentSpeaking = false;
  private userSpeakingAt = 0;
  private bargeInAt = 0;
  private status = '';
  private switching = false;
  /** Counts the mode switches that happened: a look-up that ran on in the background answers only to the conversation it was asked in. */
  private modeEpoch = 0;
  private audioTokens = AUDIO_BURST_BYTES;
  private audioRefillAt = 0;

  private queue: Injection[] = [];
  private inFlight: Injection | null = null;
  private inFlightTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private waiters = new Map<string, Array<(ok: boolean) => void>>();
  private cancelled = new Set<string>();
  private fnChain: Promise<void> = Promise.resolve();

  private settingsTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private endPromise: Promise<void> | null = null;

  constructor(start: SessionStart, deps: SessionDeps) {
    this.sid = start.sid;
    this.user = start.user;
    this.maxSeconds = Math.max(30, Math.floor(start.maxSeconds));
    this.mode = start.mode;
    this.startedMode = start.mode;
    this.interviewRequest = start.interview;
    this.talkRequest = start.talk;
    this.deps = deps;
    this.t = deps.timing;
    this.log = deps.log;
    this.groupDir = path.join(deps.groupsDir, start.user.folder);
    this.ipcDir = path.join(deps.dataDir, 'ipc', start.user.folder);
    this.firstName = firstNameOf(start.user.name);
    this.voice = this.voiceFor(start.mode);
    // the student's own pace, when they chose one in Settings; every voice of the call (the interviewer's too) speaks at it, as far as it accepts
    this.speed = start.speed !== undefined ? start.speed : deps.config.speed;
    this.expressivity = deps.config.expressivity;
  }

  get ended(): boolean {
    return this.state === 'ending' || this.state === 'closed';
  }

  get currentVoice(): string {
    return this.voice;
  }

  /**
   * The interviewer has a voice of its own (a change of role to the ear); the listener is TAi as it always sounds. A call that had to give
   * up the Flux voices (Deepgram refused them) stays with the Aura ones in every mode.
   */
  private voiceFor(mode: AgentMode): string {
    const cfg = this.deps.config;
    if (mode === 'interviewer') return this.speakFellBack ? cfg.fallbackVoiceInterview : cfg.voiceInterview;
    return this.speakFellBack ? cfg.fallbackVoiceChat : cfg.voiceChat;
  }

  // ---------------------------------------------------------------- start

  /** Opens the call. Never throws: a failure ends the call with an error the browser is told. */
  async start(): Promise<void> {
    try {
      this.startToolHost();
      this.context = loadStudentContext({
        groupsDir: this.deps.groupsDir,
        folder: this.user.folder,
        jid: this.user.jid,
        recentChat: this.deps.recentChat,
        memories: this.deps.memories,
        warn: (message) => this.log.warn({ folder: this.user.folder }, message),
        now: this.deps.now,
      });
      this.noteUrls(this.context.courseStatus);
      if (this.mode === 'interviewer') this.beginInterviewState(this.interviewRequest?.assignmentId, this.interviewRequest?.topic);
      if (this.mode === 'listener') this.beginTalkState(this.talkRequest?.topic);
      const greeting =
        this.mode === 'interviewer' && this.interview
          ? lines.interviewGreeting(this.interview.context.assignmentName)
          : this.mode === 'listener'
            ? pickLine(lines.talkOpeners, this.sid, 0)
            : lines.chatGreeting();
      this.connect({
        listenModel: this.deps.config.listenModel,
        history: buildContextMessages(this.context, { withMemoryCall: this.mode === 'conversational' }),
        greeting,
        reconnect: false,
      });
    } catch (err) {
      this.log.error({ folder: this.user.folder, err: (err as Error).message }, 'voice call could not start');
      void this.end('error', { code: 'deepgram', message: 'The voice call could not start.' });
    }
  }

  private startToolHost(): void {
    try {
      const th = this.deps.spawnToolHost(this.user.folder);
      this.toolHost = th;
      const began = this.deps.now();
      this.toolHostReady = th.start().then(
        () => {
          this.log.info({ folder: this.user.folder, ms: this.deps.now() - began }, 'voice tool host ready');
          this.warmCourse();
          return th;
        },
        (err: Error) => {
          // a call that ends while the container is still starting closes it: that is the call ending, not a tool host that failed
          if (this.ended) this.log.debug({ folder: this.user.folder }, 'voice tool host closed before it was ready: the call had ended');
          else this.log.warn({ folder: this.user.folder, err: err.message }, 'voice tool host did not start');
          return null;
        },
      );
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice tool host could not be spawned');
      this.toolHostReady = Promise.resolve(null);
    }
  }

  /**
   * The tool host when it is up (waiting for it at most toolHostWaitMs), or null. One that was up and has died is replaced once per
   * call; one that never started is not retried (a broken docker would only make every function wait twice).
   */
  private async tools(): Promise<ToolHost | null> {
    if (this.ended || !this.toolHostReady) return null;
    const wait = (p: Promise<ToolHost | null>) => Promise.race([p, sleep(this.t.toolHostWaitMs).then(() => null)]);
    let ready = await wait(this.toolHostReady);
    if (ready && !ready.alive && !this.toolHostRetried && !this.ended) {
      this.toolHostRetried = true;
      void ready.close().catch(() => undefined);
      this.startToolHost();
      ready = this.toolHostReady ? await wait(this.toolHostReady) : null;
    }
    return ready && ready.alive && !this.ended ? ready : null;
  }

  // ---------------------------------------------------------------- the Deepgram connection

  private connect(opts: { listenModel: string; history: HistoryItem[]; greeting: string | null; reconnect: boolean }): void {
    const ws = new WebSocket(this.deps.deepgramUrl, {
      headers: { Authorization: `Token ${this.deps.deepgramKey()}` },
      handshakeTimeout: this.t.settingsTimeoutMs,
      maxPayload: 8 * 1024 * 1024,
      perMessageDeflate: false,
    });
    const conn: DeepgramConn = { ws, listenModel: opts.listenModel, settingsSent: false, applied: false, history: opts.history, greeting: opts.greeting, reconnect: opts.reconnect };
    this.dg = conn;
    ws.on('open', () => {
      if (this.dg !== conn) return;
      if (this.billingSince === null) this.billingSince = this.deps.now();
    });
    ws.on('message', (data, isBinary) => {
      if (this.dg !== conn || this.ended) return;
      try {
        if (isBinary) this.onAgentAudio(data as Buffer);
        else this.onDeepgramEvent(conn, data.toString());
      } catch (err) {
        this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: a Deepgram message could not be handled');
      }
    });
    ws.on('error', (err) => {
      // the message never carries the key; the URL is ours
      this.log.warn({ folder: this.user.folder, err: err.message }, 'voice: Deepgram connection error');
    });
    ws.on('unexpected-response', (_req, res) => {
      this.log.warn({ folder: this.user.folder, status: res.statusCode }, 'voice: Deepgram refused the connection');
      try {
        ws.terminate();
      } catch {
        /* gone */
      }
    });
    ws.on('close', (code) => {
      if (this.dg !== conn) return;
      this.onDeepgramClose(conn, code);
    });
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      if (this.dg === conn && !conn.applied && !this.ended) {
        this.log.warn({ folder: this.user.folder }, 'voice: Deepgram did not apply the Settings in time');
        this.failConnection(conn, 'The voice service did not answer in time.');
      }
    }, this.t.settingsTimeoutMs);
    this.settingsTimer.unref?.();
  }

  private sendDeepgram(message: Record<string, unknown>): boolean {
    const conn = this.dg;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private relayEndpoint(): { url: string; token: string } | null {
    if (this.deps.config.think === 'deepgram' || !this.deps.relay) return null;
    const expires = this.deps.now() + (this.deps.config.sessionMin + 5) * 60_000;
    return { url: this.deps.relay.url, token: this.deps.relay.tokens.mint(this.sid, expires) };
  }

  private promptFor(mode: AgentMode): string {
    const person = { studentName: clip(this.user.name, 80) || 'the student', firstName: this.firstName, today: longDate(this.deps.now()) };
    const ctx = this.context ?? loadStudentContext({ groupsDir: this.deps.groupsDir, folder: this.user.folder, jid: this.user.jid });
    if (mode === 'interviewer') {
      const ic = this.interview?.context ?? this.fallbackInterviewContext(this.interviewRequest?.topic);
      // (the repository too: a call that reconnects to Deepgram gets its Settings again, and what was only appended is not in them otherwise)
      return interviewerPrompt(person, ic, this.deps.config.interviewMin, this.interview?.repo);
    }
    if (mode === 'listener') return listenerPrompt(person, ctx, this.talk?.topic ?? str(this.talkRequest?.topic, 200), this.deps.config.talkMin);
    return conversationalPrompt(person, ctx);
  }

  private thinkFor(mode: AgentMode): Record<string, unknown> {
    return thinkConfig(this.deps.config, this.promptFor(mode), functionsFor(mode), this.relayEndpoint());
  }

  private profile(): TurnProfile {
    return this.mode === 'interviewer' ? 'interview' : this.mode === 'listener' ? 'talk' : 'chat';
  }

  private sendSettings(conn: DeepgramConn): void {
    conn.settingsSent = true;
    const settings = buildSettings({
      config: this.deps.config,
      listenModel: conn.listenModel,
      profile: this.profile(),
      think: this.thinkFor(this.mode),
      voice: this.voice,
      speak: { speed: this.speed, expressivity: this.expressivity },
      greeting: conn.greeting,
      context: conn.history,
    });
    // the Settings carry the relay token: they are sent, never logged
    this.sendDeepgram(settings);
  }

  private onDeepgramEvent(conn: DeepgramConn, raw: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    if (TRACE && ev.type !== 'LatencyReport' && ev.type !== 'History') {
      const text = typeof ev.content === 'string' ? ev.content.slice(0, 50) : undefined;
      this.log.info({ sid: this.sid.slice(0, 6), type: ev.type, status: this.status, pending: this.pendingCalls, owed: this.answerOwed, speaking: this.agentSpeaking, text }, 'voice trace');
    }
    switch (ev.type) {
      case 'Welcome':
        if (!conn.settingsSent) this.sendSettings(conn);
        return;
      case 'SettingsApplied':
        return this.onSettingsApplied(conn);
      case 'ConversationText':
        return this.onConversationText(ev);
      case 'UserStartedSpeaking':
        this.studentTurnAt = this.deps.now();
        this.userSpeakingAt = this.deps.now();
        this.bargeInAt = this.userSpeakingAt;
        this.clearLeadIn();
        this.heardStudent();
        this.agentSpeaking = false;
        this.answerOwed = false;
        this.browserSend({ type: 'agent_interrupted' });
        this.setStatus('listening');
        return;
      case 'AgentThinking':
        this.userSpeakingAt = 0;
        this.bargeInAt = 0;
        this.setStatus('thinking');
        return;
      case 'FunctionCallRequest':
        this.userSpeakingAt = 0;
        this.bargeInAt = 0;
        this.fnChain = this.fnChain.then(() => this.onFunctionCalls(ev)).catch((err) => this.log.warn({ err: (err as Error).message }, 'voice: function calls failed'));
        return;
      case 'FunctionCallCancelled': {
        const fns = Array.isArray(ev.functions) ? ev.functions : [];
        for (const fn of fns) if (fn && typeof (fn as { id?: unknown }).id === 'string') this.cancelled.add((fn as { id: string }).id);
        return;
      }
      case 'AgentStartedSpeaking':
        this.userSpeakingAt = 0;
        this.bargeInAt = 0;
        this.startedSpeaking();
        return;
      case 'AgentAudioDone':
        this.bargeInAt = 0;
        this.agentSpeaking = false;
        // after "one sec, let me check" the look-up is still running (or its answer is being made): not "listening" yet
        this.setStatus(this.pendingCalls > 0 ? 'working' : this.answerOwed ? 'thinking' : 'listening');
        this.resolveWaiters('AgentAudioDone', true);
        this.pump();
        // the lead-in has been said: from here the student is being left waiting
        if (this.leadInOpen) this.armLeadIn();
        return;
      case 'ThinkUpdated':
      case 'SpeakUpdated':
      case 'PromptUpdated':
      case 'ListenUpdated':
        this.resolveWaiters(ev.type, true);
        return;
      case 'LatencyReport':
        return this.onLatency(ev);
      case 'InjectionRefused':
        return this.onInjectionRefused();
      case 'Warning': {
        const code = str(ev.code, 80);
        this.log.warn({ folder: this.user.folder, code, description: str(ev.description, 300) }, 'voice: Deepgram warning');
        if (code === 'INJECT_AGENT_MESSAGE_DURING_USER_SPEECH' || code === 'INJECT_AGENT_MESSAGE_DURING_AGENT_SPEECH') this.onInjectionRefused();
        if (code === 'THINK_MODEL_MIP_OPT_OUT_UNSUPPORTED') this.resolveWaiters('ThinkUpdated', false);
        return;
      }
      case 'Error':
        return this.onDeepgramError(conn, str(ev.code, 80), str(ev.description, 500));
      default:
        // History, a server-side FunctionCallResponse, anything newer: nothing to do
        return;
    }
  }

  /**
   * Deepgram sends these all the time, each with one or two of the numbers (seconds; one per interim transcript while the student speaks):
   * the parts are kept, and the one that carries `total_latency` (the end of the student's words to the first sound of the answer)
   * closes the turn: that is the one logged and counted.
   */
  private onLatency(ev: Record<string, unknown>): void {
    const ms = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) : undefined);
    const parts = { stt: ms(ev.stt_latency), ttt: ms(ev.ttt_text_latency ?? ev.ttt_token_latency), tool: ms(ev.ttt_tool_latency), tts: ms(ev.tts_latency), total: ms(ev.total_latency) };
    for (const [key, value] of Object.entries(parts)) if (value !== undefined) this.latencyParts[key as keyof typeof parts] = value;
    if (parts.total === undefined) return;
    const row = this.latencyParts;
    this.latencyParts = {};
    this.latencies.push(row);
    if (this.latencies.length > 300) this.latencies.shift();
    this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6), mode: this.mode, ...row }, 'voice turn latency (ms: stt, first model token, first tool token, tts, total)');
  }

  /** The median and the 90th percentile of the turns' total latency, for the line that ends a call. */
  private latencySummary(): { turns: number; p50?: number; p90?: number } {
    const totals = this.latencies.map((l) => l.total).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    if (!totals.length) return { turns: 0 };
    return { turns: totals.length, p50: totals[Math.floor((totals.length - 1) * 0.5)], p90: totals[Math.floor((totals.length - 1) * 0.9)] };
  }

  private onSettingsApplied(conn: DeepgramConn): void {
    if (conn.applied) return;
    conn.applied = true;
    if (this.settingsTimer) {
      clearTimeout(this.settingsTimer);
      this.settingsTimer = null;
    }
    const now = this.deps.now();
    if (this.state === 'connecting') {
      this.state = 'live';
      this.liveAt = now;
      this.lastSpeechAt = now;
      this.lastTimerEvent = now;
      if (this.interview) this.interview.startedAt = now;
      if (this.talk) this.talk.startedAt = now;
      this.keepAliveTimer = setInterval(() => this.sendDeepgram({ type: 'KeepAlive' }), this.t.keepAliveMs);
      this.keepAliveTimer.unref?.();
      this.tickTimer = setInterval(() => this.tick(), this.t.tickMs);
      this.tickTimer.unref?.();
      this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6), mode: this.mode, listen: conn.listenModel, maxSeconds: this.maxSeconds }, 'voice call live');
      this.sendReady(false);
      this.persistSpeech('assistant', '', { event: 'start', mode: this.mode });
      this.setStatus('listening');
      if (this.interview) this.prepareInterview();
    } else {
      this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6) }, 'voice call reconnected to Deepgram');
      this.browserSend({ type: 'notice', text: 'Reconnected.' });
    }
    this.pump();
  }

  private onDeepgramError(conn: DeepgramConn, code: string, description: string): void {
    this.log.warn({ folder: this.user.folder, code, description }, 'voice: Deepgram error');
    if (!conn.applied) {
      const flux = isFluxModel(conn.listenModel);
      const cfg = this.deps.config;
      // a Flux TTS voice is the newest part of the Settings: when they are refused for it (or for no reason that can be told apart from it
      // and from the listen model), the call is tried once more with the Aura voice of the same mode
      // the pace (or the animation) of the voice is the newest part of the Settings: refused for that, the call is tried once more at the voice's own pace
      if ((this.speed !== undefined || this.expressivity) && /speed|expressiv/i.test(`${code} ${description}`)) {
        this.log.warn({ folder: this.user.folder, code, speed: this.speed, expressivity: this.expressivity }, 'voice: Settings refused for the voice speed, retrying at the voice own pace');
        this.speed = undefined;
        this.expressivity = 0;
        this.replaceConnection(conn, { listenModel: conn.listenModel, history: conn.history, greeting: conn.greeting, reconnect: conn.reconnect });
        return;
      }
      const aboutSpeak = code === 'FAILED_TO_START_SPEAKING' || new RegExp('speak|tts|text.to.speech|voice|flux-(?!general)[a-z]+-[a-z]{2}', 'i').test(description);
      if (!this.speakFellBack && isFluxVoice(this.voice) && aboutSpeak) {
        this.speakFellBack = true;
        const from = this.voice;
        this.voice = this.mode === 'interviewer' ? cfg.fallbackVoiceInterview : cfg.fallbackVoiceChat;
        this.log.warn({ folder: this.user.folder, from, to: this.voice }, 'voice: Settings refused for the voice, retrying with the Aura voice');
        this.replaceConnection(conn, { listenModel: conn.listenModel, history: conn.history, greeting: conn.greeting, reconnect: conn.reconnect });
        return;
      }
      const aboutListen =
        code === 'FAILED_TO_START_LISTENING' ||
        (code === 'INVALID_SETTINGS' && (!description || /listen|flux|eot|stt|model|version|keyterm/i.test(description))) ||
        /flux/i.test(description);
      if (flux && aboutListen && !this.listenFellBack) {
        // the Flux-only fields (or Flux itself) are not accepted: once more with nova-3, which takes neither
        this.listenFellBack = true;
        this.log.warn({ folder: this.user.folder, from: conn.listenModel }, 'voice: Settings refused for the listen model, retrying with nova-3');
        this.replaceConnection(conn, { listenModel: 'nova-3', history: conn.history, greeting: conn.greeting, reconnect: conn.reconnect });
        return;
      }
      if (!this.speakFellBack && isFluxVoice(this.voice)) {
        // a refusal that names nothing, after the listen model has been given up: the voice is the other new part of the Settings
        this.speakFellBack = true;
        const from = this.voice;
        this.voice = this.mode === 'interviewer' ? cfg.fallbackVoiceInterview : cfg.fallbackVoiceChat;
        this.log.warn({ folder: this.user.folder, from, to: this.voice }, 'voice: Settings refused again, retrying with the Aura voice');
        this.replaceConnection(conn, { listenModel: conn.listenModel, history: conn.history, greeting: conn.greeting, reconnect: conn.reconnect });
        return;
      }
      this.failConnection(conn, 'The voice service refused to start the call.');
      return;
    }
    // after the call is live an Error usually means Deepgram closes the connection next, and the close decides (reconnect, or the end
    // with error/closed): until then it is only a notice, so that a page does not hang up on a call that goes on
    this.browserSend({ type: 'notice', text: 'The voice service reported a problem.' });
  }

  private replaceConnection(conn: DeepgramConn, opts: { listenModel: string; history: HistoryItem[]; greeting: string | null; reconnect: boolean }): void {
    this.dg = null;
    this.accountUsage();
    this.billingSince = null;
    try {
      conn.ws.close(1000);
    } catch {
      /* gone */
    }
    this.connect(opts);
  }

  private failConnection(conn: DeepgramConn, message: string): void {
    if (this.dg === conn) this.dg = null;
    try {
      conn.ws.terminate();
    } catch {
      /* gone */
    }
    void this.end('error', { code: 'deepgram', message });
  }

  private onDeepgramClose(conn: DeepgramConn, code: number): void {
    this.accountUsage();
    this.billingSince = null;
    this.dg = null;
    if (this.ended) return;
    if (!conn.applied) {
      this.log.warn({ folder: this.user.folder, code }, 'voice: Deepgram closed before the Settings were applied');
      void this.end('error', { code: 'deepgram', message: 'The voice service is not available right now.' });
      return;
    }
    const remaining = this.maxSeconds * 1000 - (this.deps.now() - this.liveAt);
    if (!this.reconnected && remaining > 60_000) {
      // the conversation so far goes back in as context, so the agent picks up where it was
      this.reconnected = true;
      this.log.warn({ folder: this.user.folder, code }, 'voice: Deepgram closed the call, reconnecting once');
      this.browserSend({ type: 'notice', text: 'The voice service dropped; reconnecting...' });
      const history: HistoryItem[] = [
        ...(this.context ? buildContextMessages({ ...this.context, recentChat: [] }, { withMemoryCall: this.mode === 'conversational' }) : []),
        ...this.transcript.slice(-40).map((t) => ({ type: 'History' as const, role: t.role === 'student' ? ('user' as const) : ('assistant' as const), content: t.text })),
      ];
      this.connect({ listenModel: conn.listenModel, history, greeting: lines.reconnectGreeting(this.mode), reconnect: true });
      return;
    }
    this.log.warn({ folder: this.user.folder, code }, 'voice: Deepgram closed the call');
    void this.end('error', { code: 'deepgram', message: 'The voice service ended the call.' });
  }

  // ---------------------------------------------------------------- audio

  private startedSpeaking(): void {
    this.agentSpeaking = true;
    if (this.pendingCalls === 0) this.answerOwed = false; // the answer has begun (a filler said while the call runs is not it)
    this.setStatus('speaking');
  }

  private onAgentAudio(data: Buffer): void {
    // what was still on its way when the student cut in is the sentence they interrupted: the page has just emptied its queue, so it is
    // dropped here too, until the next turn begins (or 1.5 s, in case no marker of the next turn ever comes)
    if (this.bargeInAt && this.deps.now() - this.bargeInAt < BARGE_IN_DROP_MS) return;
    this.bargeInAt = 0;
    // AgentStartedSpeaking is not in every version of the protocol (the live one never sends it): the first audio says it as well
    if (!this.agentSpeaking) this.startedSpeaking();
    const b = this.browser;
    if (!b || b.readyState !== WebSocket.OPEN) return;
    if (b.bufferedAmount > 4 * 1024 * 1024) return; // a browser this far behind loses audio rather than the host memory
    b.send(data, { binary: true }, () => undefined);
  }

  /** Microphone audio from the browser: PCM16 mono 16 kHz, at most 1.5x real time, silence while muted. */
  audioIn(data: Buffer): void {
    const conn = this.dg;
    if (this.state !== 'live' || !conn || !conn.applied || conn.ws.readyState !== WebSocket.OPEN) return;
    if (data.length === 0 || data.length % 2 !== 0 || data.length > 32_000) return;
    const now = this.deps.now();
    if (this.audioRefillAt === 0) this.audioRefillAt = now;
    this.audioTokens = Math.min(AUDIO_BURST_BYTES, this.audioTokens + ((now - this.audioRefillAt) / 1000) * AUDIO_RATE_BYTES);
    this.audioRefillAt = now;
    if (this.audioTokens < data.length) return;
    this.audioTokens -= data.length;
    conn.ws.send(this.muted ? Buffer.alloc(data.length) : data, { binary: true }, () => undefined);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  // ---------------------------------------------------------------- what is said

  private heardStudent(): void {
    this.lastSpeechAt = this.deps.now();
    this.nudged = false;
  }

  private onConversationText(ev: Record<string, unknown>): void {
    const role = ev.role === 'user' ? 'student' : ev.role === 'assistant' ? 'tai' : null;
    const text = typeof ev.content === 'string' ? ev.content.trim() : '';
    if (!role || !text) return;
    // a note this side sent the model (below) comes back as the user's line: it is not the student's, and is neither shown nor kept
    if (role === 'student' && text.startsWith(SYSTEM_NOTE)) return;
    if (role === 'student') {
      this.userSpeakingAt = 0;
      this.bargeInAt = 0;
      this.clearLeadIn();
      this.heardStudent();
      this.noticeLost(text);
      this.noticeTooLong(text);
      this.noteUrls(text);
      this.lastStudentText = text;
      if (this.mode === 'listener') this.explainedWords += wordCount(text);
    }
    this.transcript.push({ role, text: text.slice(0, 2000), mode: this.mode, at: this.deps.now() });
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    // (a line typed in the chat comes back from Deepgram as the user's turn: it is in the chat already, as they typed it)
    if (!(role === 'student' && text.startsWith(TYPED_NOTE))) this.persistSpeech(role === 'student' ? 'user' : 'assistant', text.slice(0, 2000));
    this.browserSend({ type: 'transcript', role: role === 'student' ? 'user' : 'agent', text: text.slice(0, 4000), mode: this.mode });
    if (role === 'tai') {
      this.noticeChatClaim(text);
      this.noticeLeadIn(text);
    }
  }

  /**
   * Two turns in a row of "I don't know" or "nothing": the model had gone on asking questions (the owner's first call), and no prompt
   * rule makes gpt-oss stop, so the prompt is changed here, once (UpdatePrompt appends).
   */
  private noticeLost(text: string): void {
    this.lostTurns = text.length <= 80 && LOST.test(text) ? this.lostTurns + 1 : 0;
    if (this.lostTurns < 2 || this.shifted || this.mode !== 'conversational') return;
    this.shifted = true;
    this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6) }, 'voice: the student is lost twice in a row; the approach changes to explaining');
    this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.strategyShift });
  }

  private noteUrls(text: string | undefined): void {
    if (!text) return;
    for (const u of urlsIn(text)) if (this.seenUrls.size < 2000) this.seenUrls.add(u);
  }

  /** "Too long", twice or not: the prompt gets the BREVITY paragraph, once per call (the owner's long call: "No. No. No. Too long. Too long."). */
  private noticeTooLong(text: string): void {
    // in a talk-it-through TAi says next to nothing, and its one real turn (the feedback) is meant to be longer than a sentence
    if (this.briefed || this.mode === 'listener' || text.length > 120 || !TOO_LONG.test(text)) return;
    this.briefed = true;
    this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6) }, 'voice: the student says the answers are too long; they get shorter');
    this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.brevityShift });
  }

  /**
   * The relay kept a sentence that said something was in the chat out of the speech, because nothing had been sent in that turn. When the
   * student had asked for something to be put there, TAi is asked to send it now; when they had not, closing an answer with that sentence
   * was only the model's habit, and the sentence being gone is all there is to do.
   */
  onClaimDropped(): void {
    // the listener of a talk-it-through has no send_to_chat: a note telling it to call that would send it after a function it does not have
    if (this.ended || this.state !== 'live' || this.claimsCorrected >= 2 || this.mode === 'listener') return;
    const last = [...this.transcript].reverse().find((t) => t.role === 'student')?.text ?? '';
    if (!ASKED_FOR_CHAT.test(last) || this.lastChatSendAt >= this.studentTurnAt) return;
    this.claimsCorrected++;
    this.log.warn({ folder: this.user.folder, sid: this.sid.slice(0, 6) }, 'voice: TAi claimed to have put something in the chat that the student asked for, and had not; asking it to send it');
    this.enqueue({ kind: 'user', text: lines.chatAskedNote, retry: true, attempts: 0 });
  }

  /** The model this call's next request goes to when it is not the voice model (relay.ts modelFor): a talk-it-through has its own. */
  relayModel(): string | undefined {
    return this.mode === 'listener' ? this.deps.config.talkModel : undefined;
  }

  /**
   * What is said in the call goes into the student's chat too, as lines of kind `speech` (the page draws them as the call's words in the
   * thread, like ChatGPT's voice mode, and keeps them after the call): one line for each turn, and a marker when the call begins, changes
   * kind and ends. Not a message (the text agent is not started by it). Never allowed to fail the call.
   */
  private persistSpeech(role: 'user' | 'assistant', text: string, extra: ChatExtra = {}): void {
    try {
      this.deps.appendChat(this.user.folder, role, text, { kind: 'speech', call: this.sid, ...extra });
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: a line of the call could not be put in the chat');
    }
  }

  /**
   * What the relay lets one answer say now (relay.ts speechFor). A conversation in which the student has asked to be taught has room for a
   * short explanation (teach.ts); a talk-it-through has limits of its own: while the student has said little, TAi's turns are nudges and
   * the odd short answer; once they have explained enough, the feedback. The words are those of the transcript, plus those of the turn
   * being answered, which may reach the relay before its transcript reaches us.
   */
  speechLimits(messages?: unknown): Partial<GovernorOptions> | undefined {
    // a conversation in which the student has asked to be taught: an answer may be a short explanation, not one sentence (teach.ts)
    if (this.mode === 'conversational') return teachingNow(messages, (text) => text.startsWith(SYSTEM_NOTE)) ? TEACH_LIMITS : undefined;
    if (this.mode !== 'listener') return undefined;
    let words = this.explainedWords;
    const last = lastStudentLine(messages);
    if (last && last !== this.lastStudentText.trim()) words += wordCount(last);
    return words >= TALK_FEEDBACK_WORDS ? LISTENER_FEEDBACK : LISTENER_NUDGE;
  }

  /**
   * TAi said it put something in the chat: when it did not (the model claims actions it did not take, and a call written as text is not a
   * call), it is told so, once the answer has been given a moment to arrive, and asked to send it. Twice in a call at most.
   */
  private noticeChatClaim(text: string): void {
    if (this.claimsCorrected >= 2 || this.mode === 'listener' || !isChatClaim(text)) return;
    if (this.claimTimer) clearTimeout(this.claimTimer);
    this.claimTimer = setTimeout(() => {
      this.claimTimer = null;
      if (this.ended || this.state !== 'live') return;
      // sent since the student began this turn, or in the last half minute: the claim is true
      if (this.lastChatSendAt >= this.studentTurnAt || this.deps.now() - this.lastChatSendAt < 30_000) return;
      this.claimsCorrected++;
      this.log.warn({ folder: this.user.folder, sid: this.sid.slice(0, 6) }, 'voice: TAi said it had put something in the chat, and had not; asking it to send it');
      this.enqueue({ kind: 'user', text: lines.chatClaimNote, retry: true, attempts: 0 });
    }, this.t.claimCheckMs);
    this.claimTimer.unref?.();
  }

  /**
   * TAi's turn only announced its answer ("here's a quick rundown of the interesting ones") and said none of it: the model (qwen) ends a turn
   * there, and the student, who was never asked anything, waits in silence until they say "okay, go on" (the owner's call of 2026-11-03:
   * asked for a few project proposals, TAi said the lead-in and no more). The latest thing TAi said decides: if it was such a lead-in the
   * floor is TAi's, and once the student has waited leadInWaitMs after it was said TAi is asked to give the answer. Conversation only: an
   * interviewer's or a listener's short turns are meant to be short.
   */
  private noticeLeadIn(text: string): void {
    this.clearLeadIn();
    if (this.mode !== 'conversational' || !isLeadIn(text)) return;
    this.leadInOpen = true;
    // the turn is usually still being spoken (AgentAudioDone arms it then); when it was said already, the wait starts now
    if (!this.agentSpeaking) this.armLeadIn();
  }

  private armLeadIn(): void {
    if (this.leadInTimer) clearTimeout(this.leadInTimer);
    const turn = this.studentTurnAt;
    this.leadInTimer = setTimeout(() => {
      this.leadInTimer = null;
      if (!this.leadInOpen || this.ended || this.state !== 'live' || this.mode !== 'conversational') return;
      // the student has spoken since, TAi is speaking or about to (a look-up is running, an answer is owed), something went to the chat in this
      // turn (a short line after a send is the closing of an answer, and a second send or the answer said twice is worse than a wait), or it was
      // nudged already in this turn: the lead-in was not the whole of it, or asking again would not help
      if (this.studentTurnAt !== turn || this.agentSpeaking || this.pendingCalls > 0 || this.answerOwed || this.lastChatSendAt >= turn) return;
      if (this.leadInTurn === turn || this.leadInNudges >= LEAD_IN_MAX_NUDGES) return;
      this.leadInOpen = false;
      this.leadInTurn = turn;
      this.leadInNudges++;
      this.log.warn({ folder: this.user.folder, sid: this.sid.slice(0, 6), n: this.leadInNudges }, 'voice: TAi announced an answer and said none of it; asking it to give the answer');
      this.enqueue({ kind: 'user', text: lines.leadInNote, retry: true, attempts: 0 });
    }, this.t.leadInWaitMs);
    this.leadInTimer.unref?.();
  }

  private clearLeadIn(): void {
    this.leadInOpen = false;
    if (this.leadInTimer) {
      clearTimeout(this.leadInTimer);
      this.leadInTimer = null;
    }
    // a note still waiting for the student's turn to end is out of date once they have spoken
    if (this.queue.some((i) => i.text === lines.leadInNote)) this.queue = this.queue.filter((i) => i.text !== lines.leadInNote);
  }

  /** What the student typed in the chat during the call (the portal has put it in the chat history already). */
  inject(text: string): boolean {
    if (this.ended || typeof text !== 'string' || !text.trim()) return false;
    this.heardStudent();
    this.noteUrls(text);
    if (/\(a picture, /.test(text)) this.browserSend({ type: 'notice', text: 'TAi cannot see pictures: describe it, or paste the text.' });
    const body = text.length > 8000 ? text.slice(0, 8000) + '\n[... the rest is in the chat]' : text;
    this.enqueue({ kind: 'user', text: `${TYPED_NOTE}\n${body}`, retry: true, attempts: 0 });
    return true;
  }

  /** False only for a filler that was not said (it is worth saying now or never); everything else is sent or kept for later. */
  private enqueue(item: Injection, opts: { front?: boolean } = {}): boolean {
    if (this.ended) return false;
    if (item.filler) {
      // a filler is worth saying now or never: it does not wait behind anything
      if (this.inFlight || this.state !== 'live' || !this.dg?.applied) return false;
      this.sendInjection(item);
      return true;
    }
    if (opts.front) this.queue.unshift(item);
    else this.queue.push(item);
    this.pump();
    return true;
  }

  private enqueueAgent(text: string, retry = true): void {
    this.enqueue({ kind: 'agent', text, retry, attempts: 0 });
  }

  private userMidTurn(): boolean {
    return this.userSpeakingAt > 0 && this.deps.now() - this.userSpeakingAt < USER_TURN_MS;
  }

  private pump(): void {
    if (this.inFlight || this.state !== 'live' || !this.dg?.applied) return;
    const next = this.queue[0];
    if (!next) return;
    if (this.userMidTurn()) return; // after the student's turn (AgentAudioDone, or the retry timer)
    if (next.kind === 'user' && this.agentSpeaking) return;
    this.queue.shift();
    this.sendInjection(next);
  }

  private sendInjection(item: Injection): void {
    item.attempts++;
    const ok =
      item.kind === 'user'
        ? this.sendDeepgram({ type: 'InjectUserMessage', content: item.text })
        : this.sendDeepgram({ type: 'InjectAgentMessage', message: item.text, behavior: 'queue' });
    if (!ok) {
      if (item.retry) this.queue.unshift(item);
      return;
    }
    this.inFlight = item;
    if (this.inFlightTimer) clearTimeout(this.inFlightTimer);
    // no refusal within this long: it was taken
    this.inFlightTimer = setTimeout(() => {
      this.inFlightTimer = null;
      this.inFlight = null;
      this.pump();
    }, this.t.injectAckMs);
    this.inFlightTimer.unref?.();
  }

  private onInjectionRefused(): void {
    const item = this.inFlight;
    this.inFlight = null;
    if (this.inFlightTimer) {
      clearTimeout(this.inFlightTimer);
      this.inFlightTimer = null;
    }
    if (!item) return;
    if (item.retry && !item.filler && item.attempts < MAX_INJECT_ATTEMPTS) {
      this.queue.unshift(item);
    } else if (item.kind === 'user') {
      this.browserSend({ type: 'notice', text: 'TAi could not take what you typed into the call; say it, or type it again.' });
    }
    // AgentAudioDone normally sends it again; this timer covers a refusal with nobody speaking afterwards
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, this.t.injectRetryMs);
    this.retryTimer.unref?.();
  }

  // ---------------------------------------------------------------- confirmations

  private waitFor(type: string, ms = this.t.updateWaitMs): Promise<boolean> {
    if (this.ended) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
      const list = this.waiters.get(type) ?? [];
      list.push(finish);
      this.waiters.set(type, list);
    });
  }

  private resolveWaiters(type: string, ok: boolean): void {
    const list = this.waiters.get(type);
    if (!list) return;
    this.waiters.delete(type);
    for (const finish of list) finish(ok);
  }

  // ---------------------------------------------------------------- functions

  private async onFunctionCalls(ev: Record<string, unknown>): Promise<void> {
    const fns = Array.isArray(ev.functions) ? ev.functions : [];
    for (const raw of fns) {
      if (this.ended) return;
      const fn = raw as { id?: unknown; name?: unknown; arguments?: unknown; client_side?: unknown };
      if (typeof fn?.id !== 'string' || typeof fn.name !== 'string') continue;
      if (fn.client_side === false) continue; // Deepgram runs those itself
      const id = fn.id;
      const name = fn.name;
      if (this.cancelled.has(id)) continue;
      const args = parseArgs(fn.arguments);
      this.setStatus('working');
      // One short filler to a student turn, however many functions the model calls in it: two ("one sec, let me check." and then "let me read
      // through that.") are TAi talking about its tools, which the owner did not want to hear.
      // The filler is one of a short list of pre-written lines, in turn (prompts.ts), so that the same "one sec" is not said every time.
      const fill = (kind: FillerKind): void => {
        if (this.fillerTurn === this.studentTurnAt) return;
        this.fillerTurn = this.studentTurnAt;
        // the next line of the list only when this one was said
        if (this.enqueue({ kind: 'agent', text: fillerLine(kind, this.sid, this.fillersSaid[kind]), retry: false, attempts: 0, filler: true })) this.fillersSaid[kind]++;
      };
      // "give me a second to set that up" is only said when the interview really is being set up (not when the model is sent to ask which assignment)
      if (SLOW_FUNCTIONS.has(name) && (name !== 'start_interview' || this.mayStartInterview(args))) {
        fill(name === 'start_interview' ? 'start_interview' : 'slow');
      } else if (name === 'query_canvas' && (args.action === 'file_content' || args.action === 'page_detail') && this.toolHost?.alive) {
        // reading a PDF or a page of the course takes a few seconds (Canvas sends the file, the container takes the text out of it)
        fill('reading');
      } else if (TOOL_HOST_FUNCTIONS.has(name) && this.toolHost && !this.toolHost.alive && !this.toolWaitSaid) {
        // the first look-up of a call waits for the tool host's container to start (ten seconds or more): say so once, not silence
        this.toolWaitSaid = true;
        fill('tool_wait');
      }
      // the model asks again for what is still being looked up in the background: the same answer for now, and no second look-up
      const jobKey = `${name}:${JSON.stringify(args)}`;
      if (this.backgroundKeys.has(jobKey)) {
        this.sendDeepgram({ type: 'FunctionCallResponse', id, name, content: promotion.provisionalResult() });
        continue;
      }
      this.pendingCalls++;
      if (TRACE) this.log.info({ sid: this.sid.slice(0, 6), fn: name, status: this.status, pending: this.pendingCalls }, 'voice trace: function starts');
      // never rejects: a function that throws answers with an error the model can say
      const run: Promise<CallOutcome> = this.runCallFunction(name, args).catch((err: Error) => {
        this.log.warn({ folder: this.user.folder, fn: name, err: err.message }, 'voice function failed');
        return { content: errorResult('that did not work; say so briefly and carry on') };
      });
      // A look-up that takes more than a moment is not met with silence (the owner's call of 2026-11-02 22:47: Piazza 3 to 8 seconds, the first
      // search of the course 6.5, and not a word): once it has run fillerAfterMs, one pre-written line (once to a student turn, whatever the
      // function), and one more if the wait goes on. A look-up that is quicker than that gets none.
      let slowTimer: NodeJS.Timeout | undefined;
      if (this.t.fillerAfterMs > 0 && TOOL_HOST_FUNCTIONS.has(name)) {
        slowTimer = setTimeout(() => this.fillLongWait(), this.t.fillerAfterMs);
        slowTimer.unref?.();
      }
      // a look-up that runs long (TAI_VOICE_ASYNC_AFTER_MS, off by default) is answered for now and handed over later: promote()
      const waitMs = this.deps.config.asyncAfterMs;
      const promotable = waitMs > 0 && PROMOTABLE_FUNCTIONS.has(name) && this.background < MAX_BACKGROUND;
      let settled: CallOutcome | null;
      try {
        settled = promotable ? await within(run, waitMs) : await run;
      } finally {
        if (slowTimer) clearTimeout(slowTimer);
      }
      if (settled === null) {
        if (!this.cancelled.has(id) && !this.ended) this.promote(id, name, args, jobKey, run);
        else this.pendingCalls--;
        continue;
      }
      const outcome = settled;
      this.pendingCalls--;
      if (this.cancelled.has(id) || this.ended) continue; // a cancelled call gets no answer (Deepgram would drop it anyway)
      this.answerOwed = true;
      if (TRACE) this.log.info({ sid: this.sid.slice(0, 6), fn: name, status: this.status, pending: this.pendingCalls, speaking: this.agentSpeaking }, 'voice trace: function answers');
      this.sendDeepgram({ type: 'FunctionCallResponse', id, name, content: capResult(outcome.content) });
      if (!this.agentSpeaking && this.pendingCalls === 0) this.setStatus('thinking');
      if (outcome.after) {
        try {
          await outcome.after();
        } catch (err) {
          this.log.warn({ folder: this.user.folder, fn: name, err: (err as Error).message }, 'voice: after a function');
        }
      }
    }
  }

  /**
   * A look-up has run longer than a moment and TAi has said nothing: a pre-written "one sec" (never the model's own words, which come out as
   * talk about its tools), once to a student turn, unless one has been said already in this turn (an immediate one for a known slow function,
   * or the tool host's start-up). If the wait then goes on, `stillLookingMs` later TAi says one more line, as a person would ("still on it"),
   * unless it has begun to answer, the student has begun to speak, or the call is over.
   */
  private fillLongWait(): void {
    if (this.ended || this.state !== 'live' || this.agentSpeaking || this.fillerTurn === this.studentTurnAt) return;
    this.fillerTurn = this.studentTurnAt;
    if (!this.enqueue({ kind: 'agent', text: fillerLine('slow', this.sid, this.fillersSaid.slow), retry: false, attempts: 0, filler: true })) return;
    this.fillersSaid.slow++;
    const turn = this.studentTurnAt;
    if (this.stillTimer) clearTimeout(this.stillTimer);
    this.stillTimer = setTimeout(() => {
      this.stillTimer = null;
      if (this.ended || this.state !== 'live' || this.agentSpeaking || this.studentTurnAt !== turn || (this.status !== 'working' && this.status !== 'thinking')) return;
      if (this.enqueue({ kind: 'agent', text: fillerLine('still', this.sid, this.fillersSaid.still), retry: false, attempts: 0, filler: true })) this.fillersSaid.still++;
    }, this.t.stillLookingMs);
    this.stillTimer.unref?.();
  }

  /**
   * A look-up that has run longer than TAI_VOICE_ASYNC_AFTER_MS: the model is answered at once with "still running" (prompts.ts promotion) so
   * that the conversation goes on, and what the look-up returns is handed over later as a note, once the call is quiet (the same queue as
   * what the student types: nothing is injected while TAi or the student is speaking). The call counts as "working" until then. The note is
   * dropped when the call has ended or has changed its mode in the meantime: it belongs to the conversation it was asked in.
   */
  private promote(id: string, name: string, args: Record<string, unknown>, jobKey: string, run: Promise<CallOutcome>): void {
    const epoch = this.modeEpoch;
    const what = describeCall(name, args);
    this.background++;
    this.backgroundKeys.add(jobKey);
    // the model now has the provisional answer and says its own short holding sentence: the pre-written "still on it" that fillLongWait() armed
    // would be a third wait line within seconds (the first filler, the model's sentence, this one: found by reading, probed wording in VOICE.md)
    if (this.stillTimer) {
      clearTimeout(this.stillTimer);
      this.stillTimer = null;
    }
    this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6), fn: name, afterMs: this.deps.config.asyncAfterMs }, 'voice: a look-up runs long; the model is answered for now and gets its result as a note');
    this.sendDeepgram({ type: 'FunctionCallResponse', id, name, content: promotion.provisionalResult() });
    void run.then((outcome) => {
      this.background--;
      this.backgroundKeys.delete(jobKey);
      this.pendingCalls--;
      const stale = this.ended || this.state !== 'live' || this.modeEpoch !== epoch;
      if (stale) this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6), fn: name }, 'voice: the result of a look-up that ran on was dropped: the call had ended or changed its mode');
      else {
        // the links in it were noted by the function itself, as for any answer: the guard on send_to_chat is the same either way
        const note = promotion.resultNote(what, cutForNote(outcome.content, NOTE_RESULT_CHARS), isErrorResult(outcome.content));
        this.enqueue({ kind: 'user', text: note, retry: true, attempts: 0 });
      }
      // the look-up is no longer what the call is waiting for (the note, when there is one, is on its way as the student's typed lines are)
      if (!this.ended && !this.agentSpeaking && this.pendingCalls === 0) this.setStatus(this.answerOwed ? 'thinking' : 'listening');
    });
  }

  private allowed(name: string): boolean {
    return functionsFor(this.mode).some((f) => f.name === name);
  }

  /** What a function that goes through the tool host runs with: this student's folder and identity, the call's tool host, links seen, cache and guard. */
  private functionEnv() {
    return {
      folder: this.user.folder,
      jid: this.user.jid,
      githubUsername: this.user.githubUsername,
      groupDir: this.groupDir,
      ipcDir: this.ipcDir,
      awaitIpcAnswer: (requestId: string, timeoutMs: number) => waitForIpcAnswer(this.ipcDir, requestId, timeoutMs),
      today: localDay(this.deps.now()),
      templateFile: this.deps.templateFile,
      now: this.deps.now,
      toolHost: () => this.tools(),
      toolHostNow: () => (this.toolHost && this.toolHost.alive && !this.ended ? this.toolHost : null),
      urls: this.seenUrls,
      mode: this.mode,
      code: this.codeSeen,
      cache: this.lookupCache,
      guard: this.guard,
      log: this.log,
    };
  }

  /**
   * The first search of the course asks Canvas for its files, modules and pages (modules with their items are the slow one), and in the
   * owner's call of 2026-11-02 22:47 the student waited 6.5 seconds for it, in silence. Asked once the tool host is up, in the background,
   * they are in the call's cache (functions.ts keeps them fifteen minutes) before the student asks for the slides. Nothing is said or
   * recorded for it.
   */
  private warmCourse(): void {
    if (this.ended || this.mode !== 'conversational' || !this.deps.config.warmCourse) return;
    void runFunction('query_canvas', { action: 'find', query: 'lecture' }, this.functionEnv()).catch(() => undefined);
  }

  private async runCallFunction(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
    if (!this.allowed(name)) return { content: errorResult(`${name.slice(0, 60)} is not available in ${this.mode === 'interviewer' ? 'the interview' : this.mode === 'listener' ? 'the talk-through' : 'this mode'}`) };
    if (name === 'query_knowledge') {
      const q = str(args.question, 80);
      if (q) this.topicsTouched.add(q);
    }
    if (!CALL_FUNCTIONS.has(name)) {
      const content = await runFunction(name, args, this.functionEnv());
      if ((name === 'send_to_chat' || name === 'render_diagram') && /in the chat now/.test(content)) {
        this.chatSent++;
        this.lastChatSendAt = this.deps.now();
      }
      return { content };
    }
    switch (name) {
      case 'evaluate_answer':
        return { content: await this.evaluate(args) };
      case 'start_interview':
        return this.startInterview(args);
      case 'end_interview':
        return this.endInterview(args);
      case 'start_talk_through':
        return this.startTalkThrough(args);
      case 'end_talk_through':
        return this.endTalkThrough(args);
      case 'end_session':
        return this.endSessionFn(args);
      default:
        return { content: errorResult('unknown function') };
    }
  }

  // ---------------------------------------------------------------- the mock interview

  private fallbackInterviewContext(topic?: string): InterviewContext {
    return loadInterviewContext({
      groupDir: this.groupDir,
      studentName: clip(this.user.name, 80),
      competencyText: this.context?.competencyText ?? null,
      topic,
      now: this.deps.now(),
      skipFile: true,
    }).context;
  }

  private beginInterviewState(assignmentId?: string, topic?: string): void {
    const { context } = loadInterviewContext({
      groupDir: this.groupDir,
      studentName: clip(this.user.name, 80),
      competencyText: this.context?.competencyText ?? null,
      assignmentId,
      topic,
      now: this.deps.now(),
    });
    this.interview = { context, startedAt: this.deps.now(), evaluations: [], topics: new Set(), finished: false, beats: new Set() };
  }

  /**
   * The interview has begun: in the background, the assignment's material (when the call has only COMPETENCY.md and the topic to go on) and the
   * student's repository (always: a fresh interview_context.json has the assignment but never the names of the files to pick from). The first
   * question does not wait for either.
   */
  private prepareInterview(): void {
    const iv = this.interview;
    if (!iv) return;
    if (iv.context.source === 'competency') void this.fetchInterviewMaterial();
    else void this.fetchInterviewRepository();
  }

  /** In the background: the student's repository for an assignment whose material the call already has. Never throws. */
  private async fetchInterviewRepository(): Promise<void> {
    try {
      const iv = this.interview;
      if (!iv) return;
      const th = await this.tools();
      if (!th || this.interview !== iv || this.ended) return;
      await this.listRepository(th, iv);
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: the repository for the interview could not be looked up');
    }
  }

  /**
   * The student's repository for the interview's assignment and the NAMES of its code files, appended to the interviewer's prompt when found (and
   * kept, for a prompt that is sent again after a reconnect). It goes through the student's own tool host, as the account the host bound to them.
   * Never throws.
   */
  private async listRepository(th: ToolHost, iv: InterviewState): Promise<void> {
    try {
      const label = iv.context.assignmentName || iv.context.topic;
      if (!label) return; // nobody has said which assignment: there is nothing to look for
      const found = await lookUpRepo(th, this.user.githubUsername, label, this.log);
      if (this.interview !== iv || this.ended || this.mode !== 'interviewer') return;
      iv.repo = found;
      this.log.info({ folder: this.user.folder, sid: this.sid.slice(0, 6), found: found.found, ...(found.found ? { files: found.files.length, more: found.more } : { why: found.why }) }, "voice: the interview's repository looked up");
      this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.interviewRepository(found) });
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: the repository for the interview could not be looked up');
    }
  }

  /** In the background: ask the tool host for the assignment, and append it to the interviewer's prompt when it arrives. Never throws. */
  private async fetchInterviewMaterial(): Promise<void> {
    try {
      await this.fetchInterviewMaterialInner();
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: the assignment for the interview could not be fetched');
    }
  }

  private async fetchInterviewMaterialInner(): Promise<void> {
    const iv = this.interview;
    if (!iv) return;
    const th = await this.tools();
    if (!th || this.interview !== iv || this.ended) return;
    // a topic the student named is looked up in Canvas's own list first: asked for nothing, the tool would take its default assignment, which
    // is not necessarily the one they asked for
    if (!iv.context.assignmentId && iv.context.topic) {
      const found = await this.resolveInterviewAssignment(th, iv.context.topic);
      if (this.interview !== iv || this.ended || this.mode !== 'interviewer') return;
      if (!found) {
        // nothing in Canvas by that name: the interviewer works from the topic and asks the student about it (a repository may still be named for it)
        await this.listRepository(th, iv);
        return;
      }
      iv.context = { ...iv.context, assignmentId: found.id, assignmentName: found.name };
      this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.interviewMaterial(iv.context) });
    } else if (iv.context.assignmentId && !iv.context.assignmentName) {
      // a link names the assignment by its id alone (its file was too old to count): Canvas's own list says what it is called, which the repository is looked for by
      const name = await this.assignmentNameOf(th, iv.context.assignmentId);
      if (this.interview !== iv || this.ended || this.mode !== 'interviewer') return;
      if (name) {
        iv.context = { ...iv.context, assignmentName: name };
        this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.interviewMaterial(iv.context) });
      }
    }
    // The student's repository before the material: the nanoclaw tools run one at a time (execSync), start_mock_interview holds them for twenty
    // seconds or more, and what is asked after it waits for it. Two quick GitHub calls now mean the first file can be picked, and read, at once.
    await this.listRepository(th, iv);
    if (this.interview !== iv || this.ended || this.mode !== 'interviewer') return;
    const args = iv.context.assignmentId ? { assignment_id: iv.context.assignmentId } : {};
    // Canvas, GitHub and the lecture files take a while: the container is asked for 115 s instead of its usual 60 (tool-host.ts)
    const r = await th.call('start_mock_interview', args, { timeoutMs: 115_000 });
    if (this.interview !== iv || this.ended || this.mode !== 'interviewer') return;
    const { context, fresh } = loadInterviewContext({
      groupDir: this.groupDir,
      studentName: clip(this.user.name, 80),
      competencyText: this.context?.competencyText ?? null,
      assignmentId: iv.context.assignmentId || undefined,
      topic: iv.context.topic,
      now: this.deps.now(),
      maxAgeMs: 15 * 60_000,
    });
    if (fresh) {
      // (the room is measured first: it is what the call holds without this update, and a week brief's sections are fitted to it)
      const room = this.materialRoom();
      iv.context = context;
      this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.interviewMaterial(context, { room }) });
      return;
    }
    // the tool's own words name the assignment even when its file did not arrive ("Mock interview ready for X — HW3 ...")
    const name = r.ok ? r.text.match(/^Mock interview ready for .+? — (.+)$/m)?.[1]?.trim() : undefined;
    if (name && name !== 'Unknown') {
      iv.context = { ...iv.context, assignmentName: clip(name, 160) };
      this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.interviewMaterial(iv.context) });
    }
  }

  /**
   * How many characters are still free for the material that arrives late, of the PROMPT_MAX that Deepgram takes in all (the Settings' prompt and
   * what UpdatePrompt appends to it, together): the interviewer's prompt as the call holds it now, its repository included, and 400 for the
   * little that was appended since (the assignment's name).
   */
  private materialRoom(): number {
    return Math.max(0, PROMPT_MAX - this.promptFor('interviewer').length - 400);
  }

  /** The assignment of the course that a topic the student named means, or null. Never throws. */
  private async resolveInterviewAssignment(th: ToolHost, topic: string): Promise<{ id: string; name: string } | null> {
    try {
      const r = await th.call('canvas_query', { action: 'assignments' });
      if (!r.ok) return null;
      const list: unknown = JSON.parse(r.text);
      return Array.isArray(list) ? pickAssignment(topic, list as Array<Record<string, unknown>>, this.deps.now()) : null;
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: the assignments could not be listed for the interview');
      return null;
    }
  }

  /** The name of an assignment of Canvas's list by its id, or null. Never throws. */
  private async assignmentNameOf(th: ToolHost, id: string): Promise<string | null> {
    try {
      const r = await th.call('canvas_query', { action: 'assignments' });
      if (!r.ok) return null;
      const list: unknown = JSON.parse(r.text);
      const hit = Array.isArray(list) ? (list as Array<Record<string, unknown>>).find((a) => a && String(a.id) === id && typeof a.name === 'string') : undefined;
      return hit ? clip(String(hit.name), 160) : null;
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: the assignments could not be listed for the interview');
      return null;
    }
  }

  private async evaluate(args: Record<string, unknown>): Promise<string> {
    const ic = this.interview?.context ?? this.fallbackInterviewContext();
    const { result, scored } = await evaluateDetailed(args, { studentName: clip(this.user.name, 80), weakConcepts: ic.weakConcepts, misconceptions: ic.misconceptions }, this.deps.gateway);
    if (this.interview) {
      this.interview.evaluations.push(result);
      const topic = str(args.topic, 80);
      if (topic) this.interview.topics.add(topic);
      // what the student gets to practise from when the call is over (review.ts): only from an answer that somebody really scored
      if (scored) {
        const weighed = reviewItem(args, result);
        if (weighed) {
          this.reviewPool.push(weighed);
          if (this.reviewPool.length > REVIEW_KEEP) this.reviewPool.shift();
        }
      }
    }
    // the interviewer gets the evaluation it always got: the sentences written for the student's review are not its to say (it would say them aloud)
    const { said: _said, better: _better, ...forTheInterviewer } = result;
    // with a week brief the result also says what the sections show and which beat is due (week-brief.ts weekNext): the last thing the interviewer reads before it chooses its question
    // (and a brief that arrived after the first answers is caught up from the beats already named: `beats`)
    const week = ic.week;
    let note = '';
    if (week && this.interview) {
      const practicing = practicingOf(week, ic.assignmentId);
      const next = weekNext(week, practicing, this.interview.evaluations.length, ic.assignmentSpec || practicing?.requirements || '', this.interview.beats);
      if (next.beat) this.interview.beats.add(next.beat);
      note = next.text;
    }
    return JSON.stringify(note ? { ...forTheInterviewer, week: note } : forTheInterviewer);
  }

  /** Did the student choose what to practice (their words, or their yes to TAi's offer), or has the model already asked them? */
  private mayStartInterview(args: Record<string, unknown>): boolean {
    return this.interviewAsked || topicEvidenced(str(args.topic, 120), this.transcript);
  }

  private async startInterview(args: Record<string, unknown>): Promise<{ content: string; after?: () => Promise<void> }> {
    if (this.mode === 'interviewer') return { content: errorResult('the interview is already on') };
    if (this.switching) return { content: errorResult('a switch is already happening') };
    const topic = str(args.topic, 120);
    const id = str(args.assignment_id, 20);
    const assignmentId = /^\d{1,15}$/.test(id) ? id : undefined;
    if (!this.mayStartInterview(args)) {
      // the student did not say what to practice: the model asks (once; what it then brings back is let through)
      this.interviewAsked = true;
      return {
        content: JSON.stringify({
          status: 'not started',
          instruction: 'The student has not said which assignment or topic to practice. Ask them in one short question, with no list of options. When they answer, call start_interview again with what they said. Do not pick the assignment for them.',
        }),
      };
    }
    this.interviewAsked = false;
    return {
      content: JSON.stringify({ status: 'switching to interview mode', note: `say nothing more: the interviewer takes over in a moment ${HANDOFF_MARK}` }),
      after: async () => {
        await sleep(this.t.handoffPauseMs);
        if (this.ended) return;
        this.beginInterviewState(assignmentId, topic);
        const ok = await this.switchMode('interviewer');
        if (!ok) {
          this.interview = null;
          this.enqueueAgent(lines.switchFailed());
          return;
        }
        if (this.interview) {
          this.interview.startedAt = this.deps.now();
          this.interviewWrapSent = false;
          this.interviewClosing = false;
          this.enqueueAgent(lines.interviewOpener(this.interview.context.assignmentName));
          this.prepareInterview();
        }
      },
    };
  }

  private async endInterview(args: Record<string, unknown>): Promise<{ content: string; after?: () => Promise<void> }> {
    if (!this.interview) return { content: errorResult('there is no interview going on') };
    return {
      content: JSON.stringify({ status: 'ending the interview', note: HANDOFF_MARK }),
      after: async () => {
        await sleep(this.t.handoffPauseMs);
        await this.finishInterview({ topics: str(args.topics_covered, 400), impression: str(args.overall_impression, 400), switchBack: true });
      },
    };
  }

  private interviewResults(iv: InterviewState, opts: { topics?: string; impression?: string }): InterviewResults {
    const evals = iv.evaluations;
    const avg = (pick: (e: EvaluationResult) => number) => Math.round((evals.reduce((s, e) => s + pick(e), 0) / evals.length) * 10) / 10;
    const rubric = evals.length
      ? {
          verbal_clarity: avg((e) => e.verbal_clarity),
          technical_accuracy: avg((e) => e.accuracy),
          depth_of_reasoning: avg((e) => e.depth),
          problem_solving_process: avg((e) => e.problem_solving),
        }
      : null;
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    if (rubric) {
      if (rubric.verbal_clarity >= 4) strengths.push('clear verbal explanations');
      if (rubric.technical_accuracy >= 4) strengths.push('strong technical accuracy');
      if (rubric.depth_of_reasoning >= 4) strengths.push('good depth of reasoning');
      if (rubric.problem_solving_process >= 4) strengths.push('a solid problem-solving approach');
      if (rubric.verbal_clarity < 3) weaknesses.push('verbal clarity');
      if (rubric.technical_accuracy < 3) weaknesses.push('technical accuracy');
      if (rubric.depth_of_reasoning < 3) weaknesses.push('going deeper in explanations');
      if (rubric.problem_solving_process < 3) weaknesses.push('the problem-solving approach');
    }
    const missed = [...new Set(evals.flatMap((e) => e.missed_concepts))].slice(0, 6);
    if (missed.length) weaknesses.push(`missed concepts: ${missed.join(', ')}`);
    const topics = [...new Set([...iv.topics, ...(opts.topics || '').split(',').map((t) => t.trim()).filter(Boolean)])].slice(0, 12).map((t) => clip(t, 80));
    return {
      assignmentName: iv.context.assignmentName || 'an assignment the student named in the call',
      date: localDay(this.deps.now()),
      durationMinutes: Math.max(1, Math.round((this.deps.now() - iv.startedAt) / 60_000)),
      rubric,
      strengths,
      weaknesses,
      topicsCovered: topics,
      overallImpression: opts.impression || undefined,
      questions: evals.length,
    };
  }

  /** Writes the interview's results once; with switchBack, returns the call to the conversational TA. */
  private async finishInterview(opts: { topics?: string; impression?: string; switchBack: boolean }): Promise<void> {
    const iv = this.interview;
    if (!iv || iv.finished) return;
    iv.finished = true;
    const results = this.interviewResults(iv, opts);
    try {
      writeInterviewResults(this.groupDir, results, this.deps.templateFile);
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: interview results could not be written');
    }
    this.interviewsDone.push(results);
    if (!opts.switchBack || this.ended) {
      this.interview = null;
      return;
    }
    let ok = await this.switchMode('conversational');
    if (!ok && !this.ended) {
      await sleep(2000);
      ok = await this.switchMode('conversational');
    }
    this.interview = null;
    if (ok) this.enqueueAgent(lines.interviewReturn(results.strengths[0] ?? null));
  }

  // ---------------------------------------------------------------- the talk-it-through

  private beginTalkState(topic?: string): void {
    this.talk = { topic: str(topic, 200), startedAt: this.deps.now(), summary: '', finished: false };
    this.explainedWords = 0;
    this.talkWrapSent = false;
    this.talkClosing = false;
  }

  /** Did the student ask to explain something out loud (their words, or their yes to TAi's offer), or has the model already been told to offer it? */
  private mayStartTalk(): boolean {
    if (this.talkAsked) return true;
    const recent = this.transcript.slice(-8);
    if (TALK_WANTED.test(recent.filter((t) => t.role === 'student').map((t) => t.text).join(' '))) return true;
    // TAi's offer (its last sentences) and the student's yes to it
    let at = recent.length - 1;
    while (at >= 0 && recent[at].role !== 'student') at--;
    if (at < 1 || !YES.test(recent[at].text)) return false;
    const offer: string[] = [];
    for (let i = at - 1; i >= 0 && recent[i].role === 'tai'; i--) offer.unshift(recent[i].text);
    return TALK_OFFER.test(offer.join(' '));
  }

  private async startTalkThrough(args: Record<string, unknown>): Promise<CallOutcome> {
    if (this.mode !== 'conversational') return { content: errorResult('that can only be started from the normal conversation') };
    if (this.switching) return { content: errorResult('a switch is already happening') };
    const topic = str(args.topic, 200);
    if (!this.mayStartTalk()) {
      // the student did not ask for it: the model offers it (once; what it then brings back is let through)
      this.talkAsked = true;
      return {
        content: JSON.stringify({
          status: 'not started',
          instruction: 'The student has not said they want to explain something out loud. Offer it in one short sentence ("want to just talk it through out loud?") and wait for their yes. When they say yes, call start_talk_through again with what they want to explain. Do not start it on your own.',
        }),
      };
    }
    this.talkAsked = false;
    return {
      content: JSON.stringify({ status: 'switching to listening mode', note: `say nothing more: you listen from here ${HANDOFF_MARK}` }),
      after: async () => {
        await sleep(this.t.handoffPauseMs);
        if (this.ended) return;
        this.beginTalkState(topic);
        const ok = await this.switchMode('listener');
        if (!ok) {
          this.talk = null;
          this.enqueueAgent(lines.talkSwitchFailed());
          return;
        }
        if (this.talk) {
          this.talk.startedAt = this.deps.now();
          this.enqueueAgent(pickLine(lines.talkOpeners, this.sid, this.talksDone.length + 1));
        }
      },
    };
  }

  private async endTalkThrough(args: Record<string, unknown>): Promise<CallOutcome> {
    if (!this.talk) return { content: errorResult('there is no talk-through going on') };
    return {
      content: JSON.stringify({ status: 'ending the talk-through', note: HANDOFF_MARK }),
      after: async () => {
        await sleep(this.t.handoffPauseMs);
        await this.finishTalk({ summary: str(args.summary, 500), switchBack: true });
      },
    };
  }

  /** Records the talk-through once; with switchBack, returns the call to the conversational TA (and, when that did not work, keeps the talk for another try). */
  private async finishTalk(opts: { summary?: string; switchBack: boolean }): Promise<void> {
    const tk = this.talk;
    if (!tk) return;
    if (!tk.finished) {
      tk.finished = true;
      if (opts.summary) tk.summary = opts.summary;
      this.talksDone.push({ topic: tk.topic, minutes: Math.max(1, Math.round((this.deps.now() - tk.startedAt) / 60_000)), summary: tk.summary });
    }
    if (!opts.switchBack || this.ended || this.mode !== 'listener') {
      this.talk = null;
      return;
    }
    let ok = await this.switchMode('conversational');
    if (!ok && !this.ended) {
      await sleep(2000);
      ok = await this.switchMode('conversational');
    }
    if (!ok) return;
    this.talk = null;
    this.enqueueAgent(pickLine(lines.talkReturns, this.sid, this.talksDone.length));
  }

  /** The turn-taking of the mode the call is in now: patient for an interview, the most patient for a talk-it-through, quicker for a conversation. Never fails the switch. */
  private async updateListen(): Promise<void> {
    const model = this.dg?.listenModel;
    if (!model || this.listenFellBack) return;
    const update = listenUpdate(this.deps.config, model, this.profile());
    if (!update || !this.sendDeepgram(update)) return;
    if (!(await this.waitFor('ListenUpdated'))) this.log.warn({ folder: this.user.folder, profile: this.profile() }, 'voice: UpdateListen was not confirmed; the turn-taking stays as it was');
  }

  /** UpdateThink (the whole think block) and UpdateSpeak, each confirmation awaited. False: the switch did not happen. */
  private async switchMode(target: AgentMode): Promise<boolean> {
    if (this.switching || this.ended) return false;
    this.switching = true;
    try {
      if (!this.sendDeepgram({ type: 'UpdateThink', think: this.thinkFor(target) })) return false;
      if (!(await this.waitFor('ThinkUpdated'))) {
        this.log.warn({ folder: this.user.folder, target }, 'voice: UpdateThink was not confirmed; staying in the current mode');
        return false;
      }
      this.mode = target;
      this.modeEpoch++;
      const voice = this.voiceFor(target);
      // the listener sounds as TAi always does: going into a talk-it-through and out of it there is nothing to change in the voice
      if (voice !== this.voice) {
        this.sendDeepgram({ type: 'UpdateSpeak', speak: speakConfig(voice, { speed: this.speed, expressivity: this.expressivity }) });
        if (await this.waitFor('SpeakUpdated')) this.voice = voice;
        else this.log.warn({ folder: this.user.folder, voice }, 'voice: UpdateSpeak was not confirmed; the voice stays');
      }
      await this.updateListen();
      this.browserSend({ type: 'mode', mode: this.mode, voice: this.voice });
      this.persistSpeech('assistant', '', { event: 'mode', mode: this.mode });
      return true;
    } finally {
      this.switching = false;
    }
  }

  private async endSessionFn(args: Record<string, unknown>): Promise<{ content: string; after?: () => Promise<void> }> {
    this.summaryNote = str(args.summary_note, 500);
    return {
      content: JSON.stringify({ status: 'goodbye', note: HANDOFF_MARK }),
      after: async () => {
        // the goodbye may still be on its way: give it time to be spoken
        await sleep(this.t.farewellMinMs);
        if (this.agentSpeaking && !this.ended) await this.waitFor('AgentAudioDone', Math.max(0, this.t.farewellMaxMs - this.t.farewellMinMs));
        await this.end('agent');
      },
    };
  }

  // ---------------------------------------------------------------- the clock

  private accountUsage(): void {
    if (this.billingSince === null) return;
    const now = this.deps.now();
    const seconds = (now - this.billingSince) / 1000;
    this.billingSince = now;
    if (seconds > 0) {
      try {
        this.deps.addUsage(this.user.folder, seconds);
      } catch {
        /* the usage store says so itself */
      }
    }
  }

  /** Every second: usage, the limits, the silence rule, the timer for the page. Public for tests. */
  tick(): void {
    try {
      this.tickInner();
    } catch (err) {
      this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: tick failed');
    }
  }

  private tickInner(): void {
    if (this.state !== 'live') return;
    const now = this.deps.now();
    this.accountUsage();
    const elapsed = now - this.liveAt;
    const max = this.maxSeconds * 1000;
    if (!this.wrapSent && max > 90_000 && elapsed >= max - 60_000) {
      this.wrapSent = true;
      this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.sessionWrapUp });
    }
    if (!this.closingAt && elapsed >= max) {
      this.closingAt = now + this.t.closingDelayMs;
      this.enqueueAgent(lines.sessionClosing());
    }
    if ((this.closingAt && now >= this.closingAt) || elapsed >= max + this.t.hardCeilingExtraMs) {
      void this.end(this.maxSeconds < this.deps.config.sessionMin * 60 ? 'budget' : 'timeout');
      return;
    }
    const iv = this.interview;
    if (iv && this.mode === 'interviewer' && !iv.finished) {
      const ie = now - iv.startedAt;
      const imax = this.deps.config.interviewMin * 60_000;
      if (!this.interviewWrapSent && ie >= imax - 60_000) {
        this.interviewWrapSent = true;
        this.sendDeepgram({ type: 'UpdatePrompt', prompt: iv.context.week ? appendices.interviewWrapUpWeek : appendices.interviewWrapUp });
      }
      if (!this.interviewClosing && ie >= imax) {
        this.interviewClosing = true;
        this.enqueueAgent(lines.interviewClosing());
        this.finishInterview({ switchBack: true }).catch((err) => this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: ending the interview failed'));
      }
    }
    const tk = this.talk;
    if (tk && this.mode === 'listener' && !tk.finished) {
      const te = now - tk.startedAt;
      const tmax = this.deps.config.talkMin * 60_000;
      if (!this.talkWrapSent && te >= tmax - 60_000) {
        this.talkWrapSent = true;
        this.sendDeepgram({ type: 'UpdatePrompt', prompt: appendices.talkWrapUp });
      }
      if (!this.talkClosing && te >= tmax) {
        this.talkClosing = true;
        this.enqueueAgent(lines.talkClosing());
        this.finishTalk({ switchBack: true }).catch((err) => this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: ending the talk-through failed'));
      }
    }
    const silenceMs = this.deps.config.silenceSec * 1000;
    const quiet = now - this.lastSpeechAt;
    if (!this.nudged && quiet >= Math.max(silenceMs / 2, silenceMs - this.t.silenceNudgeBeforeMs)) {
      this.nudged = true;
      this.browserSend({ type: 'notice', text: `No speech for a while: the call ends after ${Math.round(silenceMs / 60_000)} minutes of silence.` });
      this.enqueue({ kind: 'agent', text: lines.stillThere(), retry: false, attempts: 0 });
    }
    if (quiet >= silenceMs) {
      this.log.info({ folder: this.user.folder }, 'voice call ended: no speech from the student');
      void this.end('timeout');
      return;
    }
    if (now - this.lastTimerEvent >= this.t.timerEventMs) {
      this.lastTimerEvent = now;
      this.sendTimer(now);
    }
    // an injection held back while the student was talking goes out once the turn is over, even if nobody spoke after it
    this.pump();
  }

  private sendTimer(now: number): void {
    const elapsedSec = Math.floor((now - this.liveAt) / 1000);
    const event: Record<string, unknown> = { type: 'timer', elapsedSec, remainingSec: Math.max(0, this.maxSeconds - elapsedSec) };
    if (this.interview && this.mode === 'interviewer') {
      event.interviewRemainingSec = Math.max(0, this.deps.config.interviewMin * 60 - Math.floor((now - this.interview.startedAt) / 1000));
    }
    if (this.talk && this.mode === 'listener') {
      event.talkRemainingSec = Math.max(0, this.deps.config.talkMin * 60 - Math.floor((now - this.talk.startedAt) / 1000));
    }
    this.browserSend(event);
  }

  // ---------------------------------------------------------------- the browser

  private browserSend(message: Record<string, unknown>): void {
    const b = this.browser;
    if (!b || b.readyState !== WebSocket.OPEN) return;
    try {
      b.send(JSON.stringify(message));
    } catch {
      /* it is going away */
    }
  }

  private setStatus(state: 'listening' | 'thinking' | 'speaking' | 'working'): void {
    if (this.status === state) return;
    this.status = state;
    this.browserSend({ type: 'status', state });
  }

  private sendReady(resumed: boolean): void {
    this.browserSend({ type: 'ready', sessionId: this.sid, mode: this.mode, voice: this.voice, maxSeconds: this.maxSeconds, resumed });
  }

  /** The page's socket for this call (a new one replaces the old, e.g. after a reload). */
  attach(ws: WebSocket, resumed: boolean): void {
    const old = this.browser;
    if (old && old !== ws) {
      try {
        old.send(JSON.stringify({ type: 'error', code: 'replaced', message: 'The call continues in another window.' }));
        old.close(1000);
      } catch {
        /* gone */
      }
    }
    this.browser = ws;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.state === 'live') {
      this.sendReady(resumed);
      if (this.status) this.browserSend({ type: 'status', state: this.status });
    }
  }

  /** The page's socket closed: the call waits graceMs for it to come back (start with resume), then ends. */
  detach(ws: WebSocket): void {
    if (this.browser !== ws) return;
    this.browser = null;
    if (this.ended) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.browser && !this.ended) {
        this.log.info({ folder: this.user.folder }, 'voice call ended: the page did not come back');
        void this.end('timeout');
      }
    }, this.t.graceMs);
    this.graceTimer.unref?.();
  }

  hangUp(): void {
    void this.end('user');
  }

  // ---------------------------------------------------------------- the end

  /** Ends the call once, whatever asks for it and however often. */
  end(reason: CloseReason, browserError?: { code: string; message: string }): Promise<void> {
    if (this.endPromise) return this.endPromise;
    this.state = 'ending';
    this.endedAt = this.deps.now();
    this.endPromise = this.cleanup(reason, browserError)
      .catch((err) => this.log.error({ folder: this.user.folder, err: (err as Error).message }, 'voice: cleanup failed'))
      .finally(() => {
        this.release();
        this.state = 'closed';
        try {
          this.deps.onFinished?.(this);
        } catch {
          /* nothing to undo */
        }
      });
    return this.endPromise;
  }

  private released = false;

  /** Gives the call's slot back to the hub (once): the student may call again while this call's notes are still being written. */
  private release(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.deps.onClosed(this);
    } catch {
      /* the hub logs its own */
    }
  }

  private async cleanup(reason: CloseReason, browserError?: { code: string; message: string }): Promise<void> {
    for (const timer of [this.settingsTimer, this.inFlightTimer, this.retryTimer, this.graceTimer]) if (timer) clearTimeout(timer);
    for (const timer of [this.keepAliveTimer, this.tickTimer]) if (timer) clearInterval(timer);
    this.settingsTimer = this.inFlightTimer = this.retryTimer = this.graceTimer = this.keepAliveTimer = this.tickTimer = null;
    for (const type of [...this.waiters.keys()]) this.resolveWaiters(type, false);
    this.queue = [];
    this.inFlight = null;

    // the meter stops first
    const conn = this.dg;
    this.dg = null;
    this.accountUsage();
    this.billingSince = null;
    if (conn) {
      try {
        conn.ws.close(1000);
      } catch {
        /* gone */
      }
      setTimeout(() => {
        try {
          if (conn.ws.readyState !== WebSocket.CLOSED) conn.ws.terminate();
        } catch {
          /* gone */
        }
      }, 3000).unref?.();
    }

    if (this.interview && !this.interview.finished) await this.finishInterview({ switchBack: false }).catch(() => undefined);
    if (this.talk && !this.talk.finished) await this.finishTalk({ switchBack: false }).catch(() => undefined);

    const quick = this.liveAt ? this.quickSummary() : undefined;
    if (this.liveAt) this.persistSpeech('assistant', '', { event: 'end', seconds: Math.round((this.endedAt - this.liveAt) / 1000) });
    if (browserError) this.browserSend({ type: 'error', ...browserError });
    this.browserSend({ type: 'closed', reason, ...(quick ? { summary: quick } : {}) });
    const b = this.browser;
    this.browser = null;
    if (b) {
      try {
        b.close(1000);
      } catch {
        /* gone */
      }
    }
    // Deepgram is closed and the student has been told: the slot is free from here (the rest is our own housekeeping)
    this.release();

    const th = this.toolHost;
    if (th) await Promise.race([th.close().catch(() => undefined), sleep(8000)]);
    clearSendFlag(this.ipcDir);

    this.log.info(
      { folder: this.user.folder, sid: this.sid.slice(0, 6), reason, seconds: this.liveAt ? Math.round((this.endedAt - this.liveAt) / 1000) : 0, turns: this.transcript.length, latencyMs: this.latencySummary() },
      'voice call ended',
    );
    if (this.liveAt) {
      try {
        await this.postSessionSync();
      } catch (err) {
        this.log.warn({ folder: this.user.folder, err: (err as Error).message }, 'voice: the post-call writes failed');
      }
    }
  }

  private minutes(): number {
    return Math.max(1, Math.round((this.endedAt - this.liveAt) / 60_000));
  }

  private competencyLines(): string[] {
    const byConcept = new Map<string, { before: number; after: number }>();
    for (const c of this.guard.changes) {
      const seen = byConcept.get(c.concept);
      byConcept.set(c.concept, { before: seen ? seen.before : c.before, after: c.after });
    }
    return [...byConcept.entries()].filter(([, v]) => v.before !== v.after).map(([k, v]) => `${k} ${score(v.before)} → ${score(v.after)}`);
  }

  private interviewLines(): string[] {
    return this.interviewsDone.map((r) => `Mock interview, ${r.assignmentName}: ${overallRating(r.rubric)} (${rubricLine(r.rubric)})`);
  }

  /** What the call changed in the student's progress, in words ("Raft leader election: just started → getting there"): their page shows no scores. */
  private competencyWords(): string[] {
    const byConcept = new Map<string, { before: number; after: number }>();
    for (const c of this.guard.changes) {
      const seen = byConcept.get(c.concept);
      byConcept.set(c.concept, { before: seen ? seen.before : c.before, after: c.after });
    }
    return [...byConcept.entries()]
      .filter(([, v]) => v.before !== v.after)
      .map(([k, v]) => {
        const was = levelWord(v.before);
        const now = levelWord(v.after);
        return was === now ? `${k}: ${v.after > v.before ? 'a little stronger' : 'a little less sure'}` : `${k}: ${was} → ${now}`;
      });
  }

  /**
   * What the call leaves in the student's chat and activity list, in place of the long summary it used to leave: a title ("Voice call · 4 min"),
   * the first sentence of the summary as the one line, and the rest (the summary, what went into the chat, the interview's scores, where they
   * stand now in words) for the card to open. The text agent still gets the whole summary (the voice_summary row).
   */
  private activity(minutes: number, summary: string): { type: 'voice' | 'interview' | 'talk'; title: string; text: string; detail: string; items: ReviewItem[] } {
    const type = this.interviewsDone.length ? 'interview' : this.talksDone.length ? 'talk' : 'voice';
    const name = type === 'interview' ? 'Mock interview' : type === 'talk' ? 'Talk it through' : 'Voice call';
    const words = this.competencyWords();
    const detail = [
      summary,
      this.chatSent ? `Put in the chat: ${this.chatSent} thing${this.chatSent > 1 ? 's' : ''}.` : '',
      ...this.interviewLines(),
      words.length ? `Where you stand now: ${words.join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    // the questions of a mock interview, for the card to list with a way to practise each: at most eight (the weakest, when there were more), in the order asked
    const items = this.interviewsDone.length ? pickItems(this.reviewPool, REVIEW_MAX) : [];
    return { type, title: `${name} · ${minutes} min`, text: firstSentence(summary, 110), detail, items };
  }

  /** The talk-throughs of the call as the summary names them: "talk-it-through: Raft leader election" ('' when there was none). */
  private talkLabel(): string {
    return this.talksDone.map((t) => (t.topic ? `talk-it-through: ${t.topic}` : 'talk-it-through')).join(', ');
  }

  /** What the page shows at once when the call ends; the fuller summary follows in the chat. */
  private quickSummary(): string {
    const label = this.talkLabel();
    const parts = [`Voice session, ${this.minutes()} min${label ? ` (${label})` : ''}.`];
    const comp = this.competencyLines();
    if (comp.length) parts.push(`COMPETENCY.md: ${comp.join('; ')}`);
    parts.push(...this.interviewLines());
    return parts.join('\n');
  }

  private facts(): string[] {
    const facts: string[] = [];
    facts.push(this.chatSent ? `TAi put ${this.chatSent} thing${this.chatSent > 1 ? 's' : ''} in the chat during the call` : 'nothing was put in the chat during the call, whatever TAi may have said');
    if (this.summaryNote) facts.push(`TAi's own note at the end: ${this.summaryNote}`);
    const comp = this.competencyLines();
    if (comp.length) facts.push(`competency changes: ${comp.join('; ')}`);
    facts.push(...this.interviewLines());
    for (const t of this.talksDone) {
      facts.push(`the student talked ${t.topic ? `"${t.topic}"` : 'an idea'} through out loud (talk-it-through mode: TAi listened, then gave feedback)`);
      if (t.summary) facts.push(`TAi's own note on that talk-through: ${t.summary}`);
    }
    if (this.topicsTouched.size) facts.push(`looked up: ${[...this.topicsTouched].slice(0, 6).join('; ')}`);
    return facts;
  }

  /** "After a call" (docs/VOICE.md): the chat message, competency/voice-sessions.md, and the voice_summary row for the text agent. */
  private async postSessionSync(): Promise<void> {
    const studentTurns = this.transcript.filter((t) => t.role === 'student').length;
    if (studentTurns === 0 && this.interviewsDone.length === 0) return; // nothing was said: nothing to write
    const minutes = this.minutes();
    const facts = this.facts();
    const turns = mergeTurns(this.transcript);
    const said = await summarizeCall(
      turns.map((t) => ({ role: t.role, text: t.text })),
      facts,
      { ...this.deps.gateway, timeoutMs: this.t.summaryTimeoutMs },
    );
    const plain =
      this.summaryNote ||
      (this.talksDone.length
        ? `you talked ${this.talksDone[0].topic || 'an idea'} through out loud.`
        : this.topicsTouched.size
          ? `we talked about ${[...this.topicsTouched].slice(0, 3).join(', ')}.`
          : this.interviewsDone.length
            ? 'we did a mock interview.'
            : 'thanks for the call.');
    const summary = said || plain;
    const comp = this.competencyLines();
    const label = this.talkLabel();
    const act = this.activity(minutes, summary);
    const modes = [...new Set(this.transcript.map((t) => (t.mode === 'interviewer' ? 'mock interview' : t.mode === 'listener' ? 'talk-it-through' : 'conversation')))];
    const steps: Array<[string, () => void]> = [
      ['chat', () => this.deps.appendChat(this.user.folder, 'assistant', act.text, { kind: 'activity', type: act.type, title: act.title, detail: act.detail, ...(act.items.length ? { items: act.items } : {}) })],
      [
        'voice-sessions.md',
        () =>
          appendVoiceSession(this.groupDir, {
            startedAt: localStamp(this.liveAt),
            minutes,
            modes: [...(modes.length ? modes : ['conversation']), ...this.interviewsDone.map((r) => r.assignmentName), ...this.talksDone.map((t) => t.topic).filter(Boolean)].join(', '),
            summary,
            competency: [...comp, ...this.interviewLines()],
            transcript: turns,
          }),
      ],
      ['voice_summary', () => this.deps.recordVoiceSummary(this.user.jid, `[Voice session, ${minutes} min${label ? `, ${label}` : ''}] ${summary}${comp.length ? ` | COMPETENCY.md: ${comp.join('; ')}` : ''}${this.interviewLines().length ? ` | ${this.interviewLines().join(' | ')}` : ''}`)],
    ];
    for (const [what, step] of steps) {
      try {
        step();
      } catch (err) {
        this.log.warn({ folder: this.user.folder, what, err: (err as Error).message }, 'voice: a post-call write failed');
      }
    }
  }
}
