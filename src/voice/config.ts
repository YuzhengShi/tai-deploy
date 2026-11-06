/**
 * Every setting of the voice side in one place, read defensively: a value that does not parse, or that is outside what makes sense,
 * falls back to its default (and says so once in the log) instead of stopping the orchestrator. The limits here are the cost guard
 * (Deepgram bills per connected minute), so a typo must never turn one off.
 *
 *   TAI_VOICE=1                    voice calls on (anything else: off)
 *   TAI_VOICE_LLM_URL              the gateway the relay forwards to (default http://127.0.0.1:4010; /v1/chat/completions is appended)
 *   TAI_VOICE_LLM_KEY              its key (the relay's Authorization: Bearer)
 *   TAI_VOICE_MODEL                the model name every Think request is rewritten to (default gpt-oss)
 *   TAI_VOICE_EVAL_MODEL           the shadow evaluator's and the call summary's model (default gpt-oss)
 *   TAI_VOICE_THINK                relay (default: Deepgram calls our relay) | deepgram (Deepgram's own managed model, the fallback)
 *   TAI_VOICE_DG_THINK_MODEL       the managed model for TAI_VOICE_THINK=deepgram (default gpt-4o-mini)
 *   TAI_VOICE_LISTEN_MODEL         speech-to-text model (default flux-general-en; a Settings error about it falls back to nova-3 once)
 *   TAI_VOICE_VOICE_CHAT           the conversational voice (default flux-hannah-en: a Flux TTS voice; aura-2-thalia-en is the fallback)
 *   TAI_VOICE_VOICE_INTERVIEW      the interviewer's voice (default flux-miles-en; aura-2-mars-en is the fallback)
 *   TAI_VOICE_SESSION_MIN          longest call (default 30)
 *   TAI_VOICE_INTERVIEW_MIN        longest mock interview inside a call (default 15)
 *   TAI_VOICE_DAILY_MIN            minutes per student per day (default 45)
 *   TAI_VOICE_MAX_CONCURRENT       calls on the host at once (default 3)
 *   TAI_VOICE_SILENCE_SEC          a call with no speech from the student this long is ended (default 180)
 *   TAI_VOICE_MAX_TOKENS           the relay's clamp of max_tokens (default 1200, at most 4000; Deepgram sends none, so it is the cap of every answer, reasoning included: a call to send_to_chat with a page of text needs room)
 *   TAI_VOICE_EOT_THRESHOLD        Flux end-of-turn confidence in a conversation (default 0.75, 0.5..1)
 *   TAI_VOICE_EAGER_EOT_THRESHOLD  Flux eager end-of-turn: the reply starts at this confidence and is dropped if the student goes on (default 0: OFF.
 *                                  On, it costs half again as many model calls, and a function that is not deferred runs on a turn the student
 *                                  then goes on with: in the owner's long call a "Yeah. Sure." started a Piazza search nobody had asked for;
 *                                  never above the threshold above)
 *   TAI_VOICE_SPEED                how fast TAi speaks: Deepgram's speak.provider.speed (default 1.2; 0.7..1.5, Flux takes steps of 0.05; 1 = the voice's own pace)
 *   TAI_VOICE_EXPRESSIVITY         Flux voices only (beta): -2 calmer .. 2 more animated (default 0 = the voice's own)
 *   TAI_VOICE_GOVERN               0: what the model says is spoken as it is (default on: see speech-governor.ts)
 *   TAI_VOICE_WARM_COURSE          0: the call does not ask Canvas for the course's files, modules and pages when its tool host is up (default on: the first search of the slides then waits for them)
 *   TAI_VOICE_MAX_SENTENCES / TAI_VOICE_MAX_WORDS   what one answer may say (default 3 sentences, 55 words, nothing after a question; while the student
 *                                  has asked to be taught: 5 and 85, src/voice/teach.ts)
 *   TAI_VOICE_EOT_TIMEOUT_MS       Flux end-of-turn silence (default 5000)
 *   TAI_VOICE_INTERVIEW_EOT_THRESHOLD / TAI_VOICE_INTERVIEW_EOT_TIMEOUT_MS   the same in a mock interview (default 0.88 / 8000: it waits for a thinker)
 *   TAI_VOICE_TALK_EOT_THRESHOLD / TAI_VOICE_TALK_EOT_TIMEOUT_MS   the same in a talk-it-through (default 0.9 / 10000: the student explains at length and TAi waits;
 *                                  Deepgram documents eot_timeout_ms up to 10000, so more than that is for a probe to confirm first)
 *   TAI_VOICE_TALK_MAX_MIN         longest talk-it-through inside a call (default 15)
 *   TAI_VOICE_TOOLHOST_KEEP_SEC    a student's tool host stays up this long after their call and serves their next one (default 600; 0: closed with the call, as before)
 *   TAI_VOICE_TOOLHOST_KEEP_MAX    at most this many idle tool hosts at once (default 3; one container each, on a shared machine)
 *   TAI_VOICE_ASYNC_AFTER_MS       a look-up that has run this long is answered provisionally and its result follows as a note while the
 *                                  conversation goes on (default 0: off; 4000 is the value to try)
 *   TAI_VOICE_DEEPGRAM_URL        the Voice Agent endpoint (default wss://agent.deepgram.com/v1/agent/converse; tests point it elsewhere)
 *   TAI_VOICE_RELAY_DUMP           a file path: the relay appends what Deepgram sent and what the model answered, one JSON line each (a
 *                                  diagnostic that holds the student's words: for finding out why a call went wrong, then unset; default off)
 *   TAI_VOICE_MUTE_HANDOFF         0: the model's reply after start_interview, end_interview and end_session is not silenced (default on)
 */

export type ThinkBackend = 'relay' | 'deepgram';

export interface VoiceConfig {
  enabled: boolean;
  llmUrl: string;
  llmKey: string;
  model: string;
  /**
   * The model of a talk-it-through (the listener). The batch-1 probes on the owner's scenarios: qwen answers a student who stopped mid-thought
   * with "mm-hm." every time and writes feedback that names what was right; gpt-oss wrote a script of nudges and feedback in one answer, or a
   * made-up "[System note]". The gateway falls back to gpt-oss by itself when qwen's share of the tokens is used up.
   */
  talkModel: string;
  evalModel: string;
  think: ThinkBackend;
  deepgramThinkModel: string;
  listenModel: string;
  voiceChat: string;
  voiceInterview: string;
  sessionMin: number;
  interviewMin: number;
  dailyMin: number;
  maxConcurrent: number;
  silenceSec: number;
  maxTokens: number;
  /** Turn-taking in a conversation (Flux): the end of a turn is confirmed at this confidence, or after this silence; eager (0: off) starts the reply sooner and drops it if the student goes on. */
  eotThreshold: number;
  eagerEotThreshold: number;
  eotTimeoutMs: number;
  /** How fast the voice speaks (speak.provider.speed; 1 = its own pace; undefined = not sent) and, for Flux voices, how animated (-2..2; 0 = not sent). */
  speed: number | undefined;
  expressivity: number;
  /** What one answer may say before the relay cuts it off (speech-governor.ts); `govern` false lets the model speak as it writes. */
  govern: boolean;
  maxSentences: number;
  maxWords: number;
  /** Ask Canvas for the course's files, modules and pages when the call's tool host is up, so the first search of the slides does not wait for them. */
  warmCourse: boolean;
  /** The same in a mock interview, where the student pauses to think: more patient. */
  interviewEotThreshold: number;
  interviewEotTimeoutMs: number;
  /** The same in a talk-it-through, where the student explains at length and TAi waits: the most patient of the three. */
  talkEotThreshold: number;
  talkEotTimeoutMs: number;
  /** Longest talk-it-through inside a call, in minutes. */
  talkMin: number;
  /** How long a student's tool host is kept after their call for the next one (seconds; 0: closed with the call) and how many idle ones at most. */
  toolHostKeepSec: number;
  toolHostKeepMax: number;
  /** A function that has run this long (ms) is answered provisionally and its result follows as a note (0: off). */
  asyncAfterMs: number;
  /** The voices to fall back to when Deepgram refuses the configured ones (a Flux voice an account may not have). */
  fallbackVoiceChat: string;
  fallbackVoiceInterview: string;
  temperature: number;
  deepgramUrl: string;
  /** A file the relay appends what Deepgram sent and the model answered to, for finding out why a call went wrong ('' = off). */
  relayDump: string;
  /** The model's reply after start_interview, end_interview and end_session is silence (on unless TAI_VOICE_MUTE_HANDOFF=0). */
  muteHandoff: boolean;
}

export const DEFAULT_DEEPGRAM_URL = 'wss://agent.deepgram.com/v1/agent/converse';

export const VOICE_ENV_KEYS = [
  'TAI_VOICE',
  'TAI_VOICE_LLM_URL',
  'TAI_VOICE_LLM_KEY',
  'TAI_VOICE_MODEL',
  'TAI_VOICE_TALK_MODEL',
  'TAI_VOICE_EVAL_MODEL',
  'TAI_VOICE_THINK',
  'TAI_VOICE_DG_THINK_MODEL',
  'TAI_VOICE_LISTEN_MODEL',
  'TAI_VOICE_VOICE_CHAT',
  'TAI_VOICE_VOICE_INTERVIEW',
  'TAI_VOICE_SESSION_MIN',
  'TAI_VOICE_INTERVIEW_MIN',
  'TAI_VOICE_DAILY_MIN',
  'TAI_VOICE_MAX_CONCURRENT',
  'TAI_VOICE_SILENCE_SEC',
  'TAI_VOICE_MAX_TOKENS',
  'TAI_VOICE_EOT_THRESHOLD',
  'TAI_VOICE_EAGER_EOT_THRESHOLD',
  'TAI_VOICE_SPEED',
  'TAI_VOICE_EXPRESSIVITY',
  'TAI_VOICE_GOVERN',
  'TAI_VOICE_WARM_COURSE',
  'TAI_VOICE_MAX_SENTENCES',
  'TAI_VOICE_MAX_WORDS',
  'TAI_VOICE_EOT_TIMEOUT_MS',
  'TAI_VOICE_INTERVIEW_EOT_THRESHOLD',
  'TAI_VOICE_INTERVIEW_EOT_TIMEOUT_MS',
  'TAI_VOICE_TALK_EOT_THRESHOLD',
  'TAI_VOICE_TALK_EOT_TIMEOUT_MS',
  'TAI_VOICE_TALK_MAX_MIN',
  'TAI_VOICE_TOOLHOST_KEEP_SEC',
  'TAI_VOICE_TOOLHOST_KEEP_MAX',
  'TAI_VOICE_ASYNC_AFTER_MS',
  'TAI_VOICE_TEMPERATURE',
  'TAI_VOICE_DEEPGRAM_URL',
  'TAI_VOICE_RELAY_DUMP',
  'TAI_VOICE_MUTE_HANDOFF',
];

// A model or voice name as Deepgram and LiteLLM spell them (gpt-oss, flux-general-en, aura-2-mars-en, cerebras/qwen-3...): nothing that
// could break out of the JSON it is put into or name something unexpected.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export function loadVoiceConfig(
  lookup: (key: string) => string | undefined,
  warn: (message: string) => void = () => undefined,
): VoiceConfig {
  const raw = (key: string): string => (lookup(key) ?? '').trim();

  const num = (key: string, fallback: number, min: number, max: number, integer = true): number => {
    const text = raw(key);
    if (!text) return fallback;
    const value = integer ? Number.parseInt(text, 10) : Number.parseFloat(text);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !/^\d+$/.test(text))) {
      warn(`${key}=${JSON.stringify(text)} is not a number in ${min}..${max}: using ${fallback}`);
      return fallback;
    }
    return value;
  };

  const name = (key: string, fallback: string): string => {
    const text = raw(key);
    if (!text) return fallback;
    if (!NAME.test(text)) {
      warn(`${key}=${JSON.stringify(text)} is not a usable name: using ${fallback}`);
      return fallback;
    }
    return text;
  };

  const url = (key: string, fallback: string, protocols: string[]): string => {
    const text = raw(key);
    if (!text) return fallback;
    try {
      const parsed = new URL(text);
      if (!protocols.includes(parsed.protocol)) throw new Error('protocol');
      return text.replace(/\/+$/, '');
    } catch {
      warn(`${key} is not a ${protocols.join(' or ')} URL: using the default`);
      return fallback;
    }
  };

  // eager <= confirm (Deepgram refuses the other way round); 0 turns eager mode off
  const eot = num('TAI_VOICE_EOT_THRESHOLD', 0.75, 0.5, 1, false);
  const eager = num('TAI_VOICE_EAGER_EOT_THRESHOLD', 0, 0, 0.9, false);
  // Flux takes speeds in steps of 0.05 between 0.5 and 1.5, Aura any value between 0.7 and 1.5: one value that both take
  const speedValue = num('TAI_VOICE_SPEED', 1.2, 0.7, 1.5, false);
  const expressivityText = raw('TAI_VOICE_EXPRESSIVITY');
  let expressivity = 0;
  if (expressivityText) {
    const value = Number.parseInt(expressivityText, 10);
    if (/^-?\d+$/.test(expressivityText) && value >= -2 && value <= 2) expressivity = value;
    else warn(`TAI_VOICE_EXPRESSIVITY=${JSON.stringify(expressivityText)} is not a whole number in -2..2: using 0`);
  }
  const interviewEot = num('TAI_VOICE_INTERVIEW_EOT_THRESHOLD', 0.88, 0.5, 1, false);
  const thinkText = raw('TAI_VOICE_THINK').toLowerCase();
  if (thinkText && thinkText !== 'relay' && thinkText !== 'deepgram') warn(`TAI_VOICE_THINK=${JSON.stringify(thinkText)} is neither relay nor deepgram: using relay`);

  return {
    enabled: raw('TAI_VOICE') === '1',
    llmUrl: url('TAI_VOICE_LLM_URL', 'http://127.0.0.1:4010', ['http:', 'https:']),
    llmKey: raw('TAI_VOICE_LLM_KEY'),
    model: name('TAI_VOICE_MODEL', 'gpt-oss'),
    talkModel: name('TAI_VOICE_TALK_MODEL', 'qwen'),
    evalModel: name('TAI_VOICE_EVAL_MODEL', 'gpt-oss'),
    think: thinkText === 'deepgram' ? 'deepgram' : 'relay',
    deepgramThinkModel: name('TAI_VOICE_DG_THINK_MODEL', 'gpt-4o-mini'),
    listenModel: name('TAI_VOICE_LISTEN_MODEL', 'flux-general-en'),
    voiceChat: name('TAI_VOICE_VOICE_CHAT', 'flux-hannah-en'),
    voiceInterview: name('TAI_VOICE_VOICE_INTERVIEW', 'flux-miles-en'),
    fallbackVoiceChat: 'aura-2-thalia-en',
    fallbackVoiceInterview: 'aura-2-mars-en',
    sessionMin: num('TAI_VOICE_SESSION_MIN', 30, 2, 120),
    interviewMin: num('TAI_VOICE_INTERVIEW_MIN', 15, 2, 60),
    dailyMin: num('TAI_VOICE_DAILY_MIN', 45, 1, 600),
    maxConcurrent: num('TAI_VOICE_MAX_CONCURRENT', 3, 1, 50),
    silenceSec: num('TAI_VOICE_SILENCE_SEC', 180, 30, 1800),
    maxTokens: num('TAI_VOICE_MAX_TOKENS', 1200, 50, 4000),
    eotThreshold: eot,
    eagerEotThreshold: Math.min(eager, eot),
    eotTimeoutMs: num('TAI_VOICE_EOT_TIMEOUT_MS', 5000, 500, 10000),
    speed: Math.round(speedValue * 20) / 20 === 1 ? undefined : Math.round(speedValue * 20) / 20,
    expressivity,
    govern: raw('TAI_VOICE_GOVERN') !== '0',
    warmCourse: raw('TAI_VOICE_WARM_COURSE') !== '0',
    maxSentences: num('TAI_VOICE_MAX_SENTENCES', 3, 1, 6),
    maxWords: num('TAI_VOICE_MAX_WORDS', 55, 10, 200),
    interviewEotThreshold: interviewEot,
    interviewEotTimeoutMs: num('TAI_VOICE_INTERVIEW_EOT_TIMEOUT_MS', 8000, 500, 20000),
    talkEotThreshold: num('TAI_VOICE_TALK_EOT_THRESHOLD', 0.9, 0.5, 1, false),
    talkEotTimeoutMs: num('TAI_VOICE_TALK_EOT_TIMEOUT_MS', 10000, 500, 20000),
    talkMin: num('TAI_VOICE_TALK_MAX_MIN', 15, 2, 60),
    toolHostKeepSec: num('TAI_VOICE_TOOLHOST_KEEP_SEC', 600, 0, 3600),
    toolHostKeepMax: num('TAI_VOICE_TOOLHOST_KEEP_MAX', 3, 1, 20),
    asyncAfterMs: num('TAI_VOICE_ASYNC_AFTER_MS', 0, 0, 60000),
    temperature: num('TAI_VOICE_TEMPERATURE', 0.7, 0, 1.5, false),
    deepgramUrl: url('TAI_VOICE_DEEPGRAM_URL', DEFAULT_DEEPGRAM_URL, ['wss:', 'ws:']),
    relayDump: dumpPath(raw('TAI_VOICE_RELAY_DUMP'), warn),
    muteHandoff: raw('TAI_VOICE_MUTE_HANDOFF') !== '0',
  };
}

/** An absolute path of plain characters, or '' (the diagnostic is off). */
function dumpPath(text: string, warn: (message: string) => void): string {
  if (!text) return '';
  if (/^\/[A-Za-z0-9._/-]{1,200}$/.test(text) && !text.includes('..')) return text;
  warn('TAI_VOICE_RELAY_DUMP is not an absolute path of plain characters: the relay diagnostic stays off');
  return '';
}

/** Flux is Deepgram's v2 listen family: it alone takes the end-of-turn fields. */
export function isFluxModel(model: string): boolean {
  return /^flux-/i.test(model);
}

/** The gateway's chat completions address from TAI_VOICE_LLM_URL, whether that names the root or already ends in /v1. */
export function chatCompletionsUrl(llmUrl: string): string {
  const base = llmUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return /\/v1$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}
