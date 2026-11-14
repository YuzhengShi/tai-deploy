/**
 * The scenarios of the voice lab as audio: reads eval/voice-lab/testset.json and the clips make_audio.ps1 made, and builds each scenario the way the
 * document's section 9.2 says (and the probe did): 600 ms of silence, each segment's clip trimmed to its speech plus a 40 ms margin, the scenario's
 * own pause of digital silence after a segment. The end of speech (UE) of a scenario is the end of the last speech sample of its last segment, taken
 * from sample indices, so it is exact to one sample whatever the margins were clamped to.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseWav } from '../../smoke-client.js';
import { SAMPLES_PER_MS, sampleCount, silence, trimToSpeech } from './wav.js';

/** The groups of scenarios a `--set` can name (the documented ones, and no others). */
export const LAB_SETS = ['latency', 'pause', 'short', 'filler', 'bargein', 'interview', 'talk', 'tuning'] as const;
export type LabSet = (typeof LAB_SETS)[number];
export type CallMode = 'chat' | 'interview' | 'talk';
export type ScenarioClass = 'latency' | 'pause' | 'short' | 'filler' | 'bargein';

export function isLabSet(value: string): value is LabSet {
  return (LAB_SETS as readonly string[]).includes(value);
}

/** The mode a call is started in to play this set (the interview and talk-through sets are only meaningful in their own mode). */
export function modeForSet(set: LabSet): CallMode {
  return set === 'interview' ? 'interview' : set === 'talk' ? 'talk' : 'chat';
}

/** The silence before the first clip of every scenario (docs 9.2). */
export const LEAD_SILENCE_MS = 600;

export interface SegmentSpec {
  text: string;
  pauseAfterMs?: number;
}

export interface ScenarioSpec {
  id: string;
  class: ScenarioClass;
  segments: SegmentSpec[];
  /** barge-in scenarios: what is said over the agent's answer (the segments hold the question) */
  interruption?: string;
}

export interface TestSet {
  version: number;
  voices: string[];
  recognition: Array<{ id: string; text: string; terms: string[] }>;
  latency: Array<{ id: string; text: string }>;
  turntaking: { tuning: ScenarioSpec[]; eval: ScenarioSpec[] };
  bargein: { ask: string; afterFirstAudioMs: number; tuning: string[]; eval: string[] };
  modes: { interview: { eval: ScenarioSpec[] }; talk: { eval: ScenarioSpec[] } };
}

export interface Fingerprint {
  /** sha256 of the file with LF line ends (the document's 9.7 value) */
  sha256: string;
  /** the git blob id of that content (`git hash-object`) */
  blob: string;
}

/** The two fingerprints docs/VOICE_SELFBUILT.md 9.7 gives for the frozen test set. */
export const FROZEN_TESTSET: Fingerprint = {
  sha256: '89b4b8d2a10568988e21841fa8d15f118914ece03e73e0f13aff141d1edf7612',
  blob: '5066b76d5863429013bebd953f4305b5771f834b',
};

/** Both fingerprints of a text, computed on its LF form (a Windows checkout may have CRLF; the document's values are of the LF file). */
export function fingerprintOf(text: string): Fingerprint {
  const body = Buffer.from(text.replace(/^﻿/, '').replace(/\r\n/g, '\n'), 'utf8');
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const blob = crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, 'utf8'), body]))
    .digest('hex');
  return { sha256, blob };
}

function fail(message: string): never {
  throw new Error(`test set: ${message}`);
}

function checkScenarios(list: unknown, where: string): ScenarioSpec[] {
  if (!Array.isArray(list)) fail(`${where} is not a list`);
  for (const s of list as ScenarioSpec[]) {
    if (!s || typeof s.id !== 'string' || typeof s.class !== 'string' || !Array.isArray(s.segments) || s.segments.length === 0) fail(`${where} has a scenario without id, class or segments`);
    for (const seg of s.segments) if (!seg || typeof seg.text !== 'string' || !seg.text) fail(`${where}: scenario ${s.id} has a segment without text`);
  }
  return list as ScenarioSpec[];
}

/** Reads and checks the test set; returns it with the fingerprints of the file as read (the caller says whether they are the frozen ones). */
export function loadTestSet(file: string): { testset: TestSet; fingerprint: Fingerprint } {
  const text = fs.readFileSync(file, 'utf8');
  const fingerprint = fingerprintOf(text);
  let raw: TestSet;
  try {
    raw = JSON.parse(text.replace(/^﻿/, '')) as TestSet;
  } catch (err) {
    return fail(`${file} is not JSON (${(err as Error).message})`);
  }
  if (!raw || !Array.isArray(raw.voices) || raw.voices.length === 0) fail('no voices');
  if (!Array.isArray(raw.latency)) fail('no latency prompts');
  checkScenarios(raw.turntaking?.tuning, 'turntaking.tuning');
  checkScenarios(raw.turntaking?.eval, 'turntaking.eval');
  checkScenarios(raw.modes?.interview?.eval, 'modes.interview.eval');
  checkScenarios(raw.modes?.talk?.eval, 'modes.talk.eval');
  const b = raw.bargein;
  if (!b || typeof b.ask !== 'string' || !Array.isArray(b.tuning) || !Array.isArray(b.eval) || typeof b.afterFirstAudioMs !== 'number') fail('bargein is incomplete');
  return { testset: raw, fingerprint };
}

/** The scenarios of one set, in the test set's own order (the order is part of the method: both chains play the same list). */
export function scenariosFor(ts: TestSet, set: LabSet): ScenarioSpec[] {
  const bargeIn = (prefix: string, interruptions: string[]): ScenarioSpec[] =>
    interruptions.map((text, i) => ({ id: `${prefix}${i + 1}`, class: 'bargein' as const, segments: [{ text: ts.bargein.ask }], interruption: text }));
  switch (set) {
    case 'latency':
      return ts.latency.map((l) => ({ id: l.id, class: 'latency' as const, segments: [{ text: l.text }] }));
    case 'pause':
    case 'short':
    case 'filler':
      return ts.turntaking.eval.filter((s) => s.class === set);
    case 'bargein':
      return bargeIn('b', ts.bargein.eval);
    case 'interview':
      return ts.modes.interview.eval;
    case 'talk':
      return ts.modes.talk.eval;
    case 'tuning':
      return [...ts.turntaking.tuning, ...bargeIn('tb', ts.bargein.tuning)];
  }
}

/** The voice that reads the scenario at `position` (0-based in its call): the voices alternate, shifted by `offset`; the same for both chains. */
export function voiceFor(ts: TestSet, position: number, offset = 0): string {
  const n = ts.voices.length;
  return ts.voices[(((position + offset) % n) + n) % n];
}

/** The clips make_audio.ps1 wrote: `manifest.json` maps "<voice>|<text>" to a file name (written with a UTF-8 BOM by Windows PowerShell). */
export class AudioLibrary {
  private readonly manifest: Record<string, string>;
  private readonly cache = new Map<string, Buffer>();

  constructor(readonly dir: string) {
    const file = path.join(dir, 'manifest.json');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`audio directory ${dir} has no manifest.json (${(err as Error).message}); make it with eval/voice-lab/make_audio.ps1`);
    }
    this.manifest = JSON.parse(text.replace(/^﻿/, '')) as Record<string, string>;
  }

  has(voice: string, text: string): boolean {
    return `${voice}|${text}` in this.manifest;
  }

  /** The 16 kHz mono PCM16 of this voice saying this text (throws if there is no such clip, or it is not in that format). */
  clip(voice: string, text: string): Buffer {
    const key = `${voice}|${text}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const name = this.manifest[key];
    if (!name) throw new Error(`no audio for ${JSON.stringify(key)} in ${this.dir}/manifest.json (make it with eval/voice-lab/make_audio.ps1)`);
    const pcm = parseWav(fs.readFileSync(path.join(this.dir, name))).data;
    this.cache.set(key, pcm);
    return pcm;
  }
}

export interface SpeechMark {
  text: string;
  /** stream time of the first speech sample, ms (sample / 16) */
  beginMs: number;
  /** stream time of the END of the last speech sample, ms; of the last segment this is the scenario's UE */
  endMs: number;
  /** index of the first speech sample in the scenario's stream */
  beginSample: number;
  /** index of the last speech sample + 1 */
  endSample: number;
}

export interface BuiltScenario {
  /** 16 kHz mono PCM16: the lead silence, the clips and the pauses. Not padded to whole frames (the client pads the last one). */
  pcm: Buffer;
  speech: SpeechMark[];
}

function clipOf(audio: AudioLibrary, voice: string, text: string) {
  const clip = trimToSpeech(audio.clip(voice, text));
  if (!clip) throw new Error(`the clip of ${JSON.stringify(`${voice}|${text}`)} has no speech above the threshold`);
  return clip;
}

/** The scenario as one stream, and where the speech of each segment begins and ends in it (docs 9.2). `leadMs` is the silence before the first clip (600 ms; tests use less). */
export function buildScenario(scenario: ScenarioSpec, voice: string, audio: AudioLibrary, leadMs = LEAD_SILENCE_MS): BuiltScenario {
  const lead = silence(leadMs);
  const parts: Buffer[] = [lead];
  const speech: SpeechMark[] = [];
  let at = sampleCount(lead);
  for (const segment of scenario.segments) {
    const clip = clipOf(audio, voice, segment.text);
    const beginSample = at + clip.first;
    const endSample = at + clip.last + 1;
    speech.push({ text: segment.text, beginSample, endSample, beginMs: beginSample / SAMPLES_PER_MS, endMs: endSample / SAMPLES_PER_MS });
    parts.push(clip.pcm);
    at += sampleCount(clip.pcm);
    if (segment.pauseAfterMs) {
      const pause = silence(segment.pauseAfterMs);
      parts.push(pause);
      at += sampleCount(pause);
    }
  }
  return { pcm: Buffer.concat(parts), speech };
}

export interface BuiltInterruption {
  text: string;
  /** the clip trimmed to its speech plus the margin; the runner places it in the stream at the moment it chooses */
  pcm: Buffer;
  /** index of the first speech sample inside `pcm` */
  firstSample: number;
  /** index of the last speech sample inside `pcm` (inclusive) */
  lastSample: number;
}

/** The interrupting speech of a barge-in scenario, trimmed; its place in the stream is chosen at run time. */
export function buildInterruption(text: string, voice: string, audio: AudioLibrary): BuiltInterruption {
  const clip = clipOf(audio, voice, text);
  return { text, pcm: clip.pcm, firstSample: clip.first, lastSample: clip.last };
}

/** The pair of a barge-in scenario: the question (the test set's `bargein.ask`) as a scenario, and the interruption to be placed over its answer by the runner. */
export function buildBargeIn(ts: TestSet, interruption: string, voice: string, audio: AudioLibrary, leadMs = LEAD_SILENCE_MS): { ask: BuiltScenario; interruption: BuiltInterruption } {
  const ask = buildScenario({ id: 'ask', class: 'bargein', segments: [{ text: ts.bargein.ask }] }, voice, audio, leadMs);
  return { ask, interruption: buildInterruption(interruption, voice, audio) };
}

export interface ScenarioPlan {
  id: string;
  class: ScenarioClass;
  set: LabSet;
  /** 0-based position in the call */
  position: number;
  voice: string;
  built: BuiltScenario;
  /** barge-in scenarios only */
  interruption?: BuiltInterruption & { afterFirstAudioMs: number };
}

/** Every scenario of a set as audio, in order, each with its voice. Throws before any call is made if a clip is missing. */
export function planSet(ts: TestSet, set: LabSet, audio: AudioLibrary, voiceOffset = 0, leadMs = LEAD_SILENCE_MS): ScenarioPlan[] {
  return scenariosFor(ts, set).map((scenario, position) => {
    const voice = voiceFor(ts, position, voiceOffset);
    const plan: ScenarioPlan = { id: scenario.id, class: scenario.class, set, position, voice, built: buildScenario(scenario, voice, audio, leadMs) };
    if (scenario.interruption !== undefined) plan.interruption = { ...buildInterruption(scenario.interruption, voice, audio), afterFirstAudioMs: ts.bargein.afterFirstAudioMs };
    return plan;
  });
}
