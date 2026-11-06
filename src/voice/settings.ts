/**
 * The Deepgram Voice Agent messages that configure a call: Settings (once, after Welcome), UpdateThink and UpdateSpeak (the mode
 * switches). One builder for the think block serves both Settings and UpdateThink, because UpdateThink REPLACES the whole think
 * configuration: it must carry the provider, the endpoint (with the relay token), the prompt and the functions again, and the two must
 * never drift apart.
 *
 * Deepgram's schema is strict (an unknown field can fail the whole Settings), so only documented fields are sent:
 *   - top level: type, tags, mip_opt_out (always true: Deepgram's model-improvement programme must not keep students' voices), flags,
 *     audio, agent; the deprecated agent.language is left out;
 *   - listen: Flux models are version v2 and take eot_threshold / eager_eot_threshold / eot_timeout_ms; every other model is v1 without them; no smart_format;
 *   - think: provider {type: open_ai, model, temperature}, endpoint {url, headers} for our relay (left out for Deepgram's own managed
 *     model), prompt, functions (no client_side field: a function without an endpoint is the client's);
 *   - speak: provider {type: deepgram, model} (no language; version v2 for a Flux TTS voice, none for Aura).
 */
import type { VoiceConfig } from './config.js';
import { isFluxModel } from './config.js';
import type { HistoryItem } from './context-builder.js';
import type { FunctionDef } from './functions.js';
import { capPrompt } from './prompts.js';

/** Course words the speech-to-text should expect (the design's list, plus a few of this term's). */
export const KEYTERMS = [
  'TAi',
  'Paxos',
  'Raft',
  'goroutine',
  'MapReduce',
  'Kafka',
  'Docker',
  'Terraform',
  'EC2',
  'ECS',
  'Fargate',
  'gRPC',
  'REST',
  'CAP theorem',
  'consistent hashing',
  'Piazza',
  'mutex',
  'WaitGroup',
  'load balancer',
  'DynamoDB',
  'SQS',
  'SNS',
  'Locust',
  'Lamport',
  'Coady',
];

export interface RelayEndpoint {
  url: string;
  token: string;
}

export function thinkConfig(config: VoiceConfig, prompt: string, functions: FunctionDef[], relay: RelayEndpoint | null): Record<string, unknown> {
  if (config.think === 'deepgram' || !relay) {
    return {
      provider: { type: 'open_ai', model: config.deepgramThinkModel, temperature: config.temperature },
      prompt: capPrompt(prompt),
      functions,
    };
  }
  return {
    provider: { type: 'open_ai', model: config.model, temperature: config.temperature },
    endpoint: { url: relay.url, headers: { authorization: `Bearer ${relay.token}` } },
    prompt,
    functions,
  };
}

/**
 * How the end of a turn is judged: patient in an interview (the student thinks aloud), the most patient in a talk-it-through (the student
 * explains at length and a pause is not an ending), quicker in a conversation.
 */
export type TurnProfile = 'chat' | 'interview' | 'talk';

/** The end-of-turn fields of a Flux listen provider (Flux with v2 only: any other model refuses them). */
export function turnFields(config: VoiceConfig, profile: TurnProfile): Record<string, unknown> {
  const confirm = profile === 'talk' ? config.talkEotThreshold : profile === 'interview' ? config.interviewEotThreshold : config.eotThreshold;
  const timeout = profile === 'talk' ? config.talkEotTimeoutMs : profile === 'interview' ? config.interviewEotTimeoutMs : config.eotTimeoutMs;
  return {
    eot_threshold: confirm,
    // eager mode starts the reply while the end of the turn is still being confirmed; it must not be above the threshold that confirms it
    ...(config.eagerEotThreshold >= 0.3 ? { eager_eot_threshold: Math.min(config.eagerEotThreshold, confirm) } : {}),
    eot_timeout_ms: timeout,
  };
}

export function listenConfig(config: VoiceConfig, model: string, profile: TurnProfile = 'chat'): Record<string, unknown> {
  const provider: Record<string, unknown> = { type: 'deepgram', model, keyterms: KEYTERMS };
  if (isFluxModel(model)) {
    provider.version = 'v2';
    Object.assign(provider, turnFields(config, profile));
  } else {
    provider.version = 'v1';
  }
  return { provider };
}

/** UpdateListen for a mode switch: only the turn-taking fields change (omitted ones keep their value, the keyterms included). Null for a model without them. */
export function listenUpdate(config: VoiceConfig, model: string, profile: TurnProfile): Record<string, unknown> | null {
  if (!isFluxModel(model)) return null;
  return { type: 'UpdateListen', listen: { provider: { type: 'deepgram', version: 'v2', model, ...turnFields(config, profile) } } };
}

/** Flux TTS voices (flux-<name>-<language>) are the v2 speak API; Aura voices are v1. */
export function isFluxVoice(voice: string): boolean {
  return /^flux-[a-z]+-[a-z]{2}$/i.test(voice);
}

/**
 * What a voice accepts as its pace: Flux voices 0.5 to 1.5 in steps of 0.05, Aura voices 0.7 to 1.5 (Deepgram's documented ranges). The pace
 * is the deployment's or the student's own (speed.ts), and either may be outside what THIS call's voice takes: the interviewer's voice and the
 * conversation's are not the same, and a call that had to give up the Flux voices speaks with Aura ones. Undefined stays undefined (the voice's
 * own pace), and so does anything that is not a number.
 */
export function clampSpeed(speed: number | undefined, voice: string): number | undefined {
  if (speed === undefined || !Number.isFinite(speed)) return undefined;
  const [low, high] = isFluxVoice(voice) ? [0.5, 1.5] : [0.7, 1.5];
  return Math.round(Math.min(high, Math.max(low, speed)) * 20) / 20;
}

/**
 * The speak block: the voice, and how fast and how animated it speaks. `speed` is Deepgram's own (Flux 0.5-1.5 in steps of 0.05, Aura 0.7-1.5;
 * the owner found the default pace too slow; clampSpeed makes it fit THIS voice), `expressivity` is Flux's alone (-2..2, beta). Both are left
 * out at their defaults, so the block is what it always was when nothing is set.
 */
export function speakConfig(voice: string, how: { speed?: number; expressivity?: number } = {}): Record<string, unknown> {
  const flux = isFluxVoice(voice);
  const provider: Record<string, unknown> = flux ? { type: 'deepgram', version: 'v2', model: voice } : { type: 'deepgram', model: voice };
  const speed = clampSpeed(how.speed, voice);
  if (speed !== undefined && speed !== 1) provider.speed = speed;
  if (flux && how.expressivity) provider.expressivity = how.expressivity;
  return { provider };
}

export interface SettingsInput {
  config: VoiceConfig;
  listenModel: string;
  /** The turn-taking profile to start with: an interview that starts the call is judged patiently from the first word. */
  profile?: TurnProfile;
  think: Record<string, unknown>;
  voice: string;
  /** The pace and animation of the voice when they differ from the configured ones (Deepgram refused them: undefined / 0 sends neither). */
  speak?: { speed?: number; expressivity?: number };
  greeting: string | null;
  context: HistoryItem[];
}

export function buildSettings(input: SettingsInput): Record<string, unknown> {
  const agent: Record<string, unknown> = {
    listen: listenConfig(input.config, input.listenModel, input.profile ?? 'chat'),
    think: input.think,
    speak: speakConfig(input.voice, input.speak ?? { speed: input.config.speed, expressivity: input.config.expressivity }),
  };
  if (input.greeting) agent.greeting = input.greeting;
  if (input.context.length) agent.context = { messages: input.context };
  return {
    type: 'Settings',
    tags: ['tai', 'voice'],
    mip_opt_out: true,
    flags: { history: true },
    audio: {
      input: { encoding: 'linear16', sample_rate: 16000 },
      output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
    },
    agent,
  };
}
