/**
 * The settings of the voice lab (docs/VOICE_SELFBUILT.md section 7). Everything is off unless `TAI_VOICE_LAB=1`; a value that does not parse falls back to its default
 * and says so once, like src/voice/config.ts. The lab never reads or logs a credential here: the Deepgram key is fetched by the parts that need it, when they need it.
 */
import type { TurnProfile } from './types.js';
import type { TurnParams } from './turn.js';

export type EarsKind = 'labgpu' | 'flux' | 'nova';
/** 'flux' is Deepgram's Flux TTS (the live call's conversation voice, one continuous speech per answer); 'aura' is Aura-2's REST endpoint (one request per sentence). */
export type MouthKind = 'labgpu' | 'aura' | 'flux';

/**
 * The chains a lab call can be asked for with `?chain=` (the owner's route only; docs/VOICE_SELFBUILT.md 9.1 and amendment A10). Without the parameter a call runs on the settings of the process, as in round 1.
 *   d  : LabGPU's ears and mouth (round 1's lab), nothing asked early
 *   h  : LabGPU's ears and mouth, and Flux listening beside them whose eager end of turn only starts the model early (its answer is kept back until LabGPU's text of the turn has the same words)
 *   fd : Flux's ears (eager end of turn) and LabGPU's mouth: everything but the recognizer self-built
 *   c  : Flux's ears (eager end of turn) and Aura's mouth: the control, our orchestration over Deepgram's models. NOT the live voice: Aura-2 over REST, one request per sentence (amendment A15)
 *   cf : Flux's ears (eager end of turn) and Flux TTS's mouth, the voice of today's call spoken as one continuous speech per answer: the control that is like for like with the live call (A15)
 *   lf : the local recognizer alone (no second recognizer beside it: the student's audio goes nowhere else) and Flux TTS's mouth: the live call's voice with the audio kept on the host (A19)
 */
export type ChainName = 'd' | 'h' | 'fd' | 'c' | 'cf' | 'lf';
export const CHAIN_NAMES: readonly ChainName[] = ['d', 'h', 'fd', 'c', 'cf', 'lf'];
export const isChainName = (value: unknown): value is ChainName => typeof value === 'string' && (CHAIN_NAMES as readonly string[]).includes(value);

/** The eager threshold a chain that uses the eager end of turn takes when `TAI_VOICE_LAB_EAGER_EOT` names none (A10: the live call's request left 0.44 s after the end of speech, p50, and this threshold's eager event came at 0.40 s). */
export const DEFAULT_EAGER_EOT = 0.45;

export interface LabConfig {
  enabled: boolean;
  /** The chain this configuration is for ('' = the process's own settings, no `?chain=`): written into every turn's trace. */
  chain: ChainName | '';
  /** Flux's eager end-of-turn threshold (0.3 to 0.9), 0 = off: the model is asked on the eager event and the answer is kept back until the turn is confirmed with the same words (src/voice/lab/agent.ts). */
  eagerEot: number;
  ears: EarsKind;
  /** The recognizer to use when `ears` cannot be reached or goes silent ('none': the call fails instead). */
  earsFallback: EarsKind | 'none';
  /** A second recognizer on the same audio whose finals only go into the trace (see docs 5.1): the other one of LabGPU's and Flux by default. */
  shadowEars: EarsKind | 'none';
  /** The `/v1/listen` address of LabGPU's adapter (used when `ears` or the fallback is 'labgpu'). */
  earsUrl: string;
  /** Deepgram's own addresses (tests point them at fakes; the key is sent to whatever they name, which only the operator sets). */
  fluxUrl: string;
  novaUrl: string;
  auraUrl: string;
  earsConnectTimeoutMs: number;
  /**
   * While the VAD hears the student speak, the recognizer is given up when it has said nothing for this long since the wait began AND the VAD has heard at least `silentEarsVoicedMs` of speech
   * in that time (docs/LOCAL_VOICE.md 9.10): the wall time alone is what a deaf recognizer shows to a student who says short things with pauses; the speech alone cannot tell a deaf recognizer
   * from a click or a cough that a healthy one ignores.
   */
  silentEarsMs: number;
  /**
   * The speech a healthy recognizer always answers with some text before it is given up on: the local service's first interim comes after 3 s of unbroken speech and a decode of up to 1 s
   * (docs/LOCAL_VOICE.md 3.3), Flux's and LabGPU's within a second or so; the default is more than that.
   */
  silentEarsVoicedMs: number;
  mouth: MouthKind;
  /** The synthesizer to use for a sentence when `mouth` fails ('none': the sentence is lost). */
  mouthFallback: MouthKind | 'none';
  ttsUrl: string;
  /**
   * The TTS service takes a `speed` field in the body, as the engine's own pace (the local voice service does, docs/LOCAL_VOICE.md 9.12; LabGPU's adapter does not and gets the time-stretch of `tempo`
   * instead). Then the pace of the Settings (1.2 in a conversation, 1.08 in the interview: what the live voices speak at) times `ttsSpeedScale` is what the engine is asked for.
   */
  ttsSpeedField: boolean;
  /** A multiple of the Settings' pace for that field (default 1: the local voice at 1.2 speaks about 3.5 words a second, the live Flux voice at 1.2 about 3.6). */
  ttsSpeedScale: number;
  /**
   * A fixed gain on the speech of the TTS service, in dB (default 0: none). The local voice speaks about 10 dB below the live voice (-26 dBFS RMS against -16) and Flux TTS's own level is the live one;
   * 9 brings the local voice to within a dB of it (mouth/level.ts: a soft limiter keeps the peaks under -1 dBFS).
   */
  ttsGainDb: number;
  /** The voice of LabGPU's TTS (one English voice there: af_bella and default are the same). */
  labgpuVoice: string;
  /** Time-stretch LabGPU's voice, which has no speed control, to the pace the live voices have (src/voice/lab/mouth/tempo.ts). */
  tempo: boolean;
  /** Words a second of the live voices at the Settings' speed 1.2, and of LabGPU's voice as it comes (measured 2026-11-13 on a 39-word passage). */
  livePace: number;
  labgpuPace: number;
  /**
   * Aura's REST `speed` is not the Voice Agent's scale (measured 2026-11-13: mars at 1.2 is 3.1 to 3.45 words/s through REST, 4.0 to 4.5 in the agent on 2026-11-06): the Settings' speed is multiplied
   * by this before it goes to REST. 1 until the live pace has been measured through a call and the lab's Aura control compared with it.
   */
  auraSpeedScale: number;
  /** Flux TTS's own address (ws or wss; the path /v2/speak is added), the voice it speaks when the Settings name none, and the scale of the Settings' speed (Flux's `speed` is the Voice Agent's own scale: 1). */
  fluxTtsUrl: string;
  fluxVoiceChat: string;
  fluxSpeedScale: number;
  /** Aura voices for the control chain, per mode, when the Settings name a Flux voice (which the REST API does not have). */
  auraVoiceChat: string;
  auraVoiceInterview: string;
  /** The end-of-turn rule for a recognizer that does not decide turns, per mode (docs 5.2). `timeoutMs` comes from the Settings (eot_timeout_ms) at call time. */
  hold: Record<TurnProfile, { completeMs: number; incompleteMs: number }>;
  coverAfterMs: number;
  /** Barge-in: how much of the student's speech (loud frames at `bargeRmsFactor` over the normal threshold) must have been heard, within a window of `bargeWindowMs`, before the agent is stopped. */
  bargeMinVoicedMs: number;
  bargeRmsFactor: number;
  /** The window `bargeMinVoicedMs` of loud frames must fall in (A11): 300 ms lets a stop consonant or a short gap between syllables go by; at most `bargeMinVoicedMs` is the round-1 rule (all of them in a row). */
  bargeWindowMs: number;
  /** How far ahead of real time the audio is sent. */
  leadMs: number;
  /** One line per turn goes here ('' = off). Defaults to <data dir>/voice-lab/turns.jsonl, set by the hub. */
  traceFile: string;
}

export const LAB_ENV_KEYS = [
  'TAI_VOICE_LAB',
  'TAI_VOICE_LAB_EARS',
  'TAI_VOICE_LAB_EARS_FALLBACK',
  'TAI_VOICE_LAB_SHADOW_EARS',
  'TAI_VOICE_LAB_EARS_URL',
  'TAI_VOICE_LAB_FLUX_URL',
  'TAI_VOICE_LAB_NOVA_URL',
  'TAI_VOICE_LAB_AURA_URL',
  'TAI_VOICE_LAB_FLUX_TTS_URL',
  'TAI_VOICE_LAB_FLUX_SPEED_SCALE',
  'TAI_VOICE_LAB_MOUTH',
  'TAI_VOICE_LAB_MOUTH_FALLBACK',
  'TAI_VOICE_LAB_TTS_URL',
  'TAI_VOICE_LAB_TTS_SPEED_FIELD',
  'TAI_VOICE_LAB_TTS_SPEED_SCALE',
  'TAI_VOICE_LAB_TTS_GAIN_DB',
  'TAI_VOICE_LAB_LABGPU_VOICE',
  'TAI_VOICE_LAB_TEMPO',
  'TAI_VOICE_LAB_AURA_SPEED_SCALE',
  'TAI_VOICE_LAB_HOLD_CHAT',
  'TAI_VOICE_LAB_HOLD_INTERVIEW',
  'TAI_VOICE_LAB_HOLD_TALK',
  'TAI_VOICE_LAB_COVER_MS',
  'TAI_VOICE_LAB_BARGE_MS',
  'TAI_VOICE_LAB_BARGE_FACTOR',
  'TAI_VOICE_LAB_BARGE_WINDOW_MS',
  'TAI_VOICE_LAB_EAGER_EOT',
  'TAI_VOICE_LAB_LEAD_MS',
  'TAI_VOICE_LAB_TRACE',
];

export const DEFAULT_LABGPU_ASR = 'ws://192.0.2.29:8803/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=tai-lab';
export const DEFAULT_LABGPU_TTS = 'http://192.0.2.29:8805';
export const DEFAULT_FLUX_URL = 'wss://api.deepgram.com/v2/listen';
export const DEFAULT_NOVA_URL = 'wss://api.deepgram.com/v1/listen';
export const DEFAULT_AURA_URL = 'https://api.deepgram.com';
export const DEFAULT_FLUX_TTS_URL = 'wss://api.deepgram.com';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function loadLabConfig(lookup: (key: string) => string | undefined, warn: (message: string) => void = () => undefined): LabConfig {
  const raw = (key: string): string => (lookup(key) ?? '').trim();
  const num = (key: string, fallback: number, min: number, max: number): number => {
    const text = raw(key);
    if (!text) return fallback;
    const value = Number(text);
    if (!Number.isFinite(value) || value < min || value > max) {
      warn(`${key}=${JSON.stringify(text)} is not a number in ${min}..${max}: using ${fallback}`);
      return fallback;
    }
    return value;
  };
  const choice = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const text = raw(key).toLowerCase();
    if (!text) return fallback;
    if ((allowed as readonly string[]).includes(text)) return text as T;
    warn(`${key}=${JSON.stringify(text)} is not one of ${allowed.join(', ')}: using ${fallback}`);
    return fallback;
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
  const name = (key: string, fallback: string): string => {
    const text = raw(key);
    if (!text) return fallback;
    if (!NAME.test(text)) {
      warn(`${key}=${JSON.stringify(text)} is not a usable name: using ${fallback}`);
      return fallback;
    }
    return text;
  };
  // "complete,incomplete" in ms, e.g. 0,1800
  const hold = (key: string, fallback: { completeMs: number; incompleteMs: number }): { completeMs: number; incompleteMs: number } => {
    const text = raw(key);
    if (!text) return fallback;
    const m = /^(\d{1,5})\s*,\s*(\d{1,5})$/.exec(text);
    if (!m) {
      warn(`${key}=${JSON.stringify(text)} is not "completeMs,incompleteMs": using ${fallback.completeMs},${fallback.incompleteMs}`);
      return fallback;
    }
    return { completeMs: Number(m[1]), incompleteMs: Number(m[2]) };
  };
  const ears = choice<EarsKind>('TAI_VOICE_LAB_EARS', ['labgpu', 'flux', 'nova'], 'labgpu');
  const fallbackEars = choice<EarsKind | 'none'>('TAI_VOICE_LAB_EARS_FALLBACK', ['labgpu', 'flux', 'nova', 'none'], ears === 'flux' ? 'none' : 'flux');
  const mouth = choice<MouthKind>('TAI_VOICE_LAB_MOUTH', ['labgpu', 'aura', 'flux'], 'labgpu');
  const shadowText = choice<EarsKind | 'none' | 'auto'>('TAI_VOICE_LAB_SHADOW_EARS', ['labgpu', 'flux', 'nova', 'none', 'auto'], 'auto');
  const shadow: EarsKind | 'none' = shadowText === 'auto' ? (ears === 'labgpu' ? 'flux' : ears === 'flux' ? 'labgpu' : 'none') : shadowText === ears ? 'none' : shadowText;
  const trace = raw('TAI_VOICE_LAB_TRACE');
  // 0 = off; otherwise Flux's own range (a value outside it would fail the stream's handshake)
  const eagerText = raw('TAI_VOICE_LAB_EAGER_EOT');
  let eagerEot = 0;
  if (eagerText) {
    const value = Number(eagerText);
    if (!Number.isFinite(value) || value < 0 || value > 0.9) warn(`TAI_VOICE_LAB_EAGER_EOT=${JSON.stringify(eagerText)} is not 0 or a number in 0.3..0.9: the eager end of turn stays off`);
    else eagerEot = value === 0 ? 0 : Math.max(0.3, value);
  }
  return {
    enabled: raw('TAI_VOICE_LAB') === '1',
    chain: '',
    eagerEot,
    ears,
    earsFallback: fallbackEars === ears ? 'none' : fallbackEars,
    shadowEars: shadow,
    earsUrl: url('TAI_VOICE_LAB_EARS_URL', DEFAULT_LABGPU_ASR, ['ws:', 'wss:']),
    fluxUrl: url('TAI_VOICE_LAB_FLUX_URL', DEFAULT_FLUX_URL, ['ws:', 'wss:']),
    novaUrl: url('TAI_VOICE_LAB_NOVA_URL', DEFAULT_NOVA_URL, ['ws:', 'wss:']),
    auraUrl: url('TAI_VOICE_LAB_AURA_URL', DEFAULT_AURA_URL, ['http:', 'https:']),
    earsConnectTimeoutMs: 2500,
    silentEarsMs: 8000,
    silentEarsVoicedMs: 5000,
    mouth,
    mouthFallback: choice<MouthKind | 'none'>('TAI_VOICE_LAB_MOUTH_FALLBACK', ['labgpu', 'aura', 'flux', 'none'], mouth === 'aura' ? 'none' : 'aura'),
    ttsUrl: url('TAI_VOICE_LAB_TTS_URL', DEFAULT_LABGPU_TTS, ['http:', 'https:']),
    ttsSpeedField: raw('TAI_VOICE_LAB_TTS_SPEED_FIELD') === '1',
    ttsSpeedScale: num('TAI_VOICE_LAB_TTS_SPEED_SCALE', 1, 0.5, 2),
    ttsGainDb: num('TAI_VOICE_LAB_TTS_GAIN_DB', 0, -12, 18),
    labgpuVoice: safeLabGPUVoice(name('TAI_VOICE_LAB_LABGPU_VOICE', 'af_bella'), warn),
    tempo: raw('TAI_VOICE_LAB_TEMPO') !== '0',
    livePace: 3.45,
    labgpuPace: 2.69,
    auraSpeedScale: num('TAI_VOICE_LAB_AURA_SPEED_SCALE', 1, 0.5, 2),
    fluxTtsUrl: url('TAI_VOICE_LAB_FLUX_TTS_URL', DEFAULT_FLUX_TTS_URL, ['ws:', 'wss:']),
    fluxVoiceChat: 'flux-hannah-en',
    fluxSpeedScale: num('TAI_VOICE_LAB_FLUX_SPEED_SCALE', 1, 0.5, 2),
    auraVoiceChat: 'aura-2-thalia-en',
    auraVoiceInterview: 'aura-2-mars-en',
    hold: {
      chat: hold('TAI_VOICE_LAB_HOLD_CHAT', { completeMs: 0, incompleteMs: 1800 }),
      interview: hold('TAI_VOICE_LAB_HOLD_INTERVIEW', { completeMs: 600, incompleteMs: 3500 }),
      talk: hold('TAI_VOICE_LAB_HOLD_TALK', { completeMs: 2000, incompleteMs: 6000 }),
    },
    coverAfterMs: num('TAI_VOICE_LAB_COVER_MS', 350, 100, 2000),
    bargeMinVoicedMs: num('TAI_VOICE_LAB_BARGE_MS', 200, 60, 1500),
    bargeRmsFactor: num('TAI_VOICE_LAB_BARGE_FACTOR', 1.5, 1, 4),
    bargeWindowMs: num('TAI_VOICE_LAB_BARGE_WINDOW_MS', 300, 20, 3000),
    leadMs: num('TAI_VOICE_LAB_LEAD_MS', 500, 100, 2000),
    traceFile: /^\/[A-Za-z0-9._/-]{1,200}$/.test(trace) && !trace.includes('..') ? trace : '',
  };
}

/**
 * The configuration of one call that asked for a chain (`?chain=`): the process's settings with the parts the chain names replaced. A name that is not one of the four leaves the settings as they
 * are (a typo must not turn a call into something else). The recognizer that fails over is the other kind's, as in round 1.
 */
export function forChain(base: LabConfig, chain: string | null | undefined): LabConfig {
  if (!isChainName(chain)) return base;
  const eager = base.eagerEot > 0 ? base.eagerEot : DEFAULT_EAGER_EOT;
  switch (chain) {
    case 'd':
      return { ...base, chain, ears: 'labgpu', earsFallback: 'flux', shadowEars: 'flux', mouth: 'labgpu', mouthFallback: 'aura', eagerEot: 0 };
    case 'h':
      return { ...base, chain, ears: 'labgpu', earsFallback: 'flux', shadowEars: 'flux', mouth: 'labgpu', mouthFallback: 'aura', eagerEot: eager };
    case 'fd':
      return { ...base, chain, ears: 'flux', earsFallback: 'labgpu', shadowEars: 'labgpu', mouth: 'labgpu', mouthFallback: 'aura', eagerEot: eager };
    case 'c':
      return { ...base, chain, ears: 'flux', earsFallback: 'labgpu', shadowEars: 'labgpu', mouth: 'aura', mouthFallback: 'labgpu', eagerEot: eager };
    case 'cf':
      return { ...base, chain, ears: 'flux', earsFallback: 'labgpu', shadowEars: 'labgpu', mouth: 'flux', mouthFallback: 'aura', eagerEot: eager };
    case 'lf':
      // the local recognizer, nothing listening beside it (a shadow would be a second copy of the student's audio going out), no eager end of turn (it is Flux's); the fallback recognizer is Flux's, as in
      // every chain with these ears: it takes over only if the local one fails, and the owner has kept the fallbacks on
      return { ...base, chain, ears: 'labgpu', earsFallback: 'flux', shadowEars: 'none', mouth: 'flux', mouthFallback: 'aura', eagerEot: 0 };
  }
}

/** `DrBerg` is on LabGPU's list of voices and its authorisation is open: never used (the mouth refuses it too, at the first sentence; this stops it at the start). */
function safeLabGPUVoice(voice: string, warn: (message: string) => void): string {
  if (voice.replace(/[^A-Za-z0-9]/g, '').toLowerCase().includes('drberg')) {
    warn('TAI_VOICE_LAB_LABGPU_VOICE names DrBerg, which is never used: using af_bella');
    return 'af_bella';
  }
  return voice;
}

/** The tracker's parameters for a mode: the hold-offs of the configuration and the Settings' timeout. */
export function turnParamsFor(cfg: LabConfig, profile: TurnProfile, eotTimeoutMs: number): TurnParams {
  const h = cfg.hold[profile];
  const timeoutMs = Math.max(eotTimeoutMs, h.incompleteMs, 1000);
  return { completeMs: h.completeMs, incompleteMs: h.incompleteMs, timeoutMs, coverAfterMs: cfg.coverAfterMs };
}
