/**
 * Offline replay of the barge-in rule on the interrupting clips (docs/VOICE_SELFBUILT.md amendment A11): when would the rule of round 1 (12 loud frames in a row) and the windowed rule
 * (12 loud frames in the last 15) have confirmed a barge-in, counted from the first speech sample of each clip? It runs the lab's own `Vad` over the clip as the agent would hear it, so
 * the numbers are the ones the engine's rule gives, without a call. Which clips it may be run on is the test set's own rule (9.3): `bargein.tuning` of testset2.json for choosing a rule,
 * the retired round-1 phrases for comparing with round 1; the eval phrases of round 2 are never replayed before their run.
 *
 *   node dist/voice/lab/measure/replay.js --audio <dir with manifest.json> --testset <testset.json> --part tuning|eval [--min <ms of loud speech>] [--window <ms>]
 *
 * Reads local files only; prints times and phrases, nothing else.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { DEFAULT_VAD, Vad } from '../vad.js';
import { AudioLibrary, buildInterruption, loadTestSet } from './scenario.js';

export interface ReplayOptions {
  /** Loud speech the rule asks for (the lab's `bargeMinVoicedMs`). */
  minVoicedMs: number;
  /** The window of the windowed rule (the lab's `bargeWindowMs`). */
  windowMs: number;
  /** Frames of silence before the clip, for the VAD's noise floor to be learned (the agent has been speaking over a quiet room). */
  leadFrames?: number;
}

export interface ReplayResult {
  /** From the first sample of the clip: when the first loud (strict) frame ended, and when each rule was first satisfied (null: never within the clip). */
  firstLoudMs: number | null;
  runMs: number | null;
  windowMs: number | null;
}

export function replayBarge(pcm: Buffer, opts: ReplayOptions): ReplayResult {
  const clock = { t: 0 };
  const vad = new Vad(() => clock.t);
  const frameBytes = Math.round((16_000 * 2 * DEFAULT_VAD.frameMs) / 1000);
  const quiet = Buffer.alloc(frameBytes);
  for (let i = 0; i < (opts.leadFrames ?? 30); i++) {
    clock.t += DEFAULT_VAD.frameMs;
    vad.feed(quiet);
  }
  const start = clock.t;
  const out: ReplayResult = { firstLoudMs: null, runMs: null, windowMs: null };
  for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) {
    clock.t += DEFAULT_VAD.frameMs;
    vad.feed(pcm.subarray(off, off + frameBytes));
    const at = clock.t - start;
    if (out.firstLoudMs === null && vad.strictRunMs > 0) out.firstLoudMs = at;
    if (out.runMs === null && vad.strictRunMs >= opts.minVoicedMs) out.runMs = at;
    if (out.windowMs === null && vad.strictWindow(opts.windowMs).voicedMs >= opts.minVoicedMs) out.windowMs = at;
  }
  return out;
}

const fmt = (ms: number | null, from: number): string => (ms === null ? 'never' : String(Math.round(ms - from)));

function main(argv: string[]): number {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) flags.set(argv[i].replace(/^--/, ''), argv[i + 1] ?? '');
  const audioDir = flags.get('audio');
  const testsetFile = flags.get('testset');
  const part = flags.get('part');
  const minVoicedMs = Number(flags.get('min') ?? 200);
  const windowMs = Number(flags.get('window') ?? 300);
  if (!audioDir || !testsetFile || (part !== 'tuning' && part !== 'eval') || !(minVoicedMs >= 20) || !(windowMs >= minVoicedMs)) {
    console.error('usage: replay.js --audio <dir> --testset <file> --part tuning|eval [--min <ms>] [--window <ms>]');
    return 2;
  }
  const { testset } = loadTestSet(testsetFile);
  const audio = new AudioLibrary(audioDir);
  const phrases = part === 'tuning' ? testset.bargein.tuning : testset.bargein.eval;
  const opts: ReplayOptions = { minVoicedMs, windowMs };
  const rows: Array<{ voice: string; text: string; run: number | null; window: number | null }> = [];
  console.log(`rule 1: ${opts.minVoicedMs / DEFAULT_VAD.frameMs} loud frames in a row (round 1); rule 2: ${opts.minVoicedMs / DEFAULT_VAD.frameMs} loud frames in the last ${opts.windowMs / DEFAULT_VAD.frameMs}; ms after the first speech sample; ${part} phrases of ${testsetFile}`);
  for (const voice of testset.voices) {
    for (const text of phrases) {
      const clip = buildInterruption(text, voice, audio);
      const r = replayBarge(clip.pcm, opts);
      const from = clip.firstSample / 16;
      console.log(`${voice.split(' ')[1].padEnd(5)} rule 1 ${fmt(r.runMs, from).padStart(6)}  rule 2 ${fmt(r.windowMs, from).padStart(6)}  ${JSON.stringify(text)}`);
      rows.push({ voice, text, run: r.runMs === null ? null : r.runMs - from, window: r.windowMs === null ? null : r.windowMs - from });
    }
  }
  const pct = (values: Array<number | null>, p: number): string => {
    const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
    return v.length ? String(Math.round(v[Math.floor((v.length - 1) * p)])) : 'n/a';
  };
  console.log(`n ${rows.length}: rule 1 p50 ${pct(rows.map((r) => r.run), 0.5)} p90 ${pct(rows.map((r) => r.run), 0.9)} max ${pct(rows.map((r) => r.run), 1)}; rule 2 p50 ${pct(rows.map((r) => r.window), 0.5)} p90 ${pct(rows.map((r) => r.window), 0.9)} max ${pct(rows.map((r) => r.window), 1)}`);
  return 0;
}

if (process.argv[1] != null && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
