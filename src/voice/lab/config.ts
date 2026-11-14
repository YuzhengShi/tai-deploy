/**
 * The settings of the voice lab (docs/VOICE_SELFBUILT.md section 7). Everything is off unless `TAI_VOICE_LAB=1`; a value that does not parse falls back to its default
 * and says so once, like src/voice/config.ts. The lab never reads or logs a credential here: the Deepgram key is fetched by the parts that need it, when they need it.
 */
import type { TurnProfile } from './types.js';
import type { TurnParams } from './turn.js';

export type EarsKind = 'labgpu' | 'flux' | 'nova';
export type MouthKind = 'labgpu' | 'aura';

export interface LabConfig {
  enabled: boolean;
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
  /** While the VAD hears the student speak and the recognizer sends nothing for this long, the recognizer is given up. */
  silentEarsMs: number;
  mouth: MouthKind;
  /** The synthesizer to use for a sentence when `mouth` fails ('none': the sentence is lost). */
  mouthFallback: MouthKind | 'none';
  ttsUrl: string;
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
  /** Aura voices for the control chain, per mode, when the Settings name a Flux voice (which the REST API does not have). */
  auraVoiceChat: string;
  auraVoiceInterview: string;
  /** The end-of-turn rule for a recognizer that does not decide turns, per mode (docs 5.2). `timeoutMs` comes from the Settings (eot_timeout_ms) at call time. */
  hold: Record<TurnProfile, { completeMs: number; incompleteMs: number }>;
  coverAfterMs: number;
  /** Barge-in: how long the student's speech must go on, at what factor over the normal threshold, before the agent is stopped. */
  bargeMinVoicedMs: number;
  bargeRmsFactor: number;
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
  'TAI_VOICE_LAB_MOUTH',
  'TAI_VOICE_LAB_MOUTH_FALLBACK',
  'TAI_VOICE_LAB_TTS_URL',
  'TAI_VOICE_LAB_LABGPU_VOICE',
  'TAI_VOICE_LAB_TEMPO',
  'TAI_VOICE_LAB_AURA_SPEED_SCALE',
  'TAI_VOICE_LAB_HOLD_CHAT',
  'TAI_VOICE_LAB_HOLD_INTERVIEW',
  'TAI_VOICE_LAB_HOLD_TALK',
  'TAI_VOICE_LAB_COVER_MS',
  'TAI_VOICE_LAB_BARGE_MS',
  'TAI_VOICE_LAB_BARGE_FACTOR',
  'TAI_VOICE_LAB_LEAD_MS',
  'TAI_VOICE_LAB_TRACE',
];

export const DEFAULT_LABGPU_ASR = 'ws://192.0.2.29:8803/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=tai-lab';
export const DEFAULT_LABGPU_TTS = 'http://192.0.2.29:8805';
export const DEFAULT_FLUX_URL = 'wss://api.deepgram.com/v2/listen';
export const DEFAULT_NOVA_URL = 'wss://api.deepgram.com/v1/listen';
export const DEFAULT_AURA_URL = 'https://api.deepgram.com';

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
  const mouth = choice<MouthKind>('TAI_VOICE_LAB_MOUTH', ['labgpu', 'aura'], 'labgpu');
  const shadowText = choice<EarsKind | 'none' | 'auto'>('TAI_VOICE_LAB_SHADOW_EARS', ['labgpu', 'flux', 'nova', 'none', 'auto'], 'auto');
  const shadow: EarsKind | 'none' = shadowText === 'auto' ? (ears === 'labgpu' ? 'flux' : ears === 'flux' ? 'labgpu' : 'none') : shadowText === ears ? 'none' : shadowText;
  const trace = raw('TAI_VOICE_LAB_TRACE');
  return {
    enabled: raw('TAI_VOICE_LAB') === '1',
    ears,
    earsFallback: fallbackEars === ears ? 'none' : fallbackEars,
    shadowEars: shadow,
    earsUrl: url('TAI_VOICE_LAB_EARS_URL', DEFAULT_LABGPU_ASR, ['ws:', 'wss:']),
    fluxUrl: url('TAI_VOICE_LAB_FLUX_URL', DEFAULT_FLUX_URL, ['ws:', 'wss:']),
    novaUrl: url('TAI_VOICE_LAB_NOVA_URL', DEFAULT_NOVA_URL, ['ws:', 'wss:']),
    auraUrl: url('TAI_VOICE_LAB_AURA_URL', DEFAULT_AURA_URL, ['http:', 'https:']),
    earsConnectTimeoutMs: 2500,
    silentEarsMs: 8000,
    mouth,
    mouthFallback: choice<MouthKind | 'none'>('TAI_VOICE_LAB_MOUTH_FALLBACK', ['labgpu', 'aura', 'none'], mouth === 'aura' ? 'none' : 'aura'),
    ttsUrl: url('TAI_VOICE_LAB_TTS_URL', DEFAULT_LABGPU_TTS, ['http:', 'https:']),
    labgpuVoice: safeLabGPUVoice(name('TAI_VOICE_LAB_LABGPU_VOICE', 'af_bella'), warn),
    tempo: raw('TAI_VOICE_LAB_TEMPO') !== '0',
    livePace: 3.45,
    labgpuPace: 2.69,
    auraSpeedScale: num('TAI_VOICE_LAB_AURA_SPEED_SCALE', 1, 0.5, 2),
    auraVoiceChat: 'aura-2-thalia-en',
    auraVoiceInterview: 'aura-2-mars-en',
    hold: {
      chat: hold('TAI_VOICE_LAB_HOLD_CHAT', { completeMs: 0, incompleteMs: 1800 }),
      interview: hold('TAI_VOICE_LAB_HOLD_INTERVIEW', { completeMs: 600, incompleteMs: 3500 }),
      talk: hold('TAI_VOICE_LAB_HOLD_TALK', { completeMs: 2000, incompleteMs: 6000 }),
    },
    coverAfterMs: num('TAI_VOICE_LAB_COVER_MS', 350, 100, 2000),
    bargeMinVoicedMs: num('TAI_VOICE_LAB_BARGE_MS', 240, 60, 1500),
    bargeRmsFactor: num('TAI_VOICE_LAB_BARGE_FACTOR', 1.5, 1, 4),
    leadMs: num('TAI_VOICE_LAB_LEAD_MS', 500, 100, 2000),
    traceFile: /^\/[A-Za-z0-9._/-]{1,200}$/.test(trace) && !trace.includes('..') ? trace : '',
  };
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
