/**
 * The second recognition test of the voice lab (docs/VOICE_SELFBUILT.md 9.4 C6, 10.1): LabGPU's Qwen3-ASR against Deepgram Flux (and nova-3 for reference) on the 64 sentences of
 * eval/voice-lab/recognition2.json, because the first set (26 sentences, 72 key-term instances) was too small to tell the two apart.
 *
 *   node dist/voice/lab/measure/recognize.js run --audio <dir of make_audio.ps1> --set <recognition2.json> --ears labgpu|flux|nova
 *        [--url <ws address>] [--env-file <file with a DEEPGRAM_API_KEY= line>] [--out <results.jsonl>] [--limit N]
 *   node dist/voice/lab/measure/recognize.js compare --a <results.jsonl> --b <results.jsonl> --set <recognition2.json>
 *
 * RUN. The recognizer is opened through the lab's own ears class, built by the lab's own factory (factories.ts: the same construction as a lab call; Flux gets the live course key terms
 * from src/voice/settings.ts and the live conversation fields eot_threshold 0.75 and eot_timeout_ms 5000), one stream per utterance (sentence x voice, sentence-major), never two at once.
 * A stream is: 600 ms of digital silence, the clip trimmed to its speech plus a 40 ms margin on each side (wav.ts, as the measuring client does), then digital silence, all in real time,
 * 40 ms frames against one monotonic clock (the ears class regroups them to what its server wants: 20 ms for LabGPU, 80 ms for Deepgram).
 *  - UE, the end of speech, is the moment the 40 ms frame that carries the last speech sample (the rule of wav.ts, speech_check.sh) was handed to the ears class: docs 9.2's "send time of the frame".
 *    A delay below is milliseconds after UE; negative means before it.
 *  - The wait after UE ends when a final that arrived at or after UE has been followed by `graceMs` of quiet (no partial and no final), so that a recognizer that finalised early on a pause and
 *    sends the rest as another final is still read to its end; or `maxWaitMs` (6 s) after UE. Then the stream is closed, and `pauseMs` later the next one is opened.
 *  - The text of an utterance is every final the recognizer sent, joined with a space. `firstPartialMs` and `lastFinalMs` are the first partial and the last final; `lastFinalMs` is null when no final
 *    came, `timedOut` is true when none came after UE. A recognizer that sent nothing is a result (an empty text), not an error.
 *  - A stream that fails (the connect is refused or times out, or the socket goes away before a final after UE) is tried once more; a second failure is recorded as `error` and the run goes on.
 *    The Deepgram key (flux, nova) is read from --env-file's DEEPGRAM_API_KEY= line, else the environment variable of that name; it reaches only the ears class's key callback, and every
 *    string this program prints or writes is passed through a filter that takes it out.
 *  - One JSON line per utterance goes to --out as soon as it is complete (the file must not exist yet: a record is never overwritten), a summary to stdout.
 *
 * COMPARE. Words are what docs 10.1 says: lower case, `[a-z0-9']+`, nothing else (no other clean-up, so the numbers are comparable with round 1). WER of an utterance is the word edit distance
 * (substitution, insertion and deletion cost 1) over the reference's words; the mean WER is the mean over utterances. A key term is hit when its words occur in the recognizer's words, in order and
 * adjacent (strict whole-term match). Utterances whose record is an `error` are left out of that recognizer's numbers (they are counted and printed), and the paired comparison uses the utterances
 * that were scored in both files. The paired recall interval is Newcombe's (see `pairedRecallInterval`), the paired WER interval a seeded bootstrap over those utterances.
 * Then the two pre-registered margins, MARGIN_TERM_POINTS and MARGIN_WER_POINTS, for A = the first file (LabGPU) against B = the second (Flux).
 *
 * Exit codes: 0 done, 2 usage, 1 anything else.
 */
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

import { loadVoiceConfig } from '../../config.js';
import { KEYTERMS } from '../../settings.js';
import type { VoiceLog } from '../../types.js';
import { loadLabConfig, type EarsKind, type LabConfig } from '../config.js';
import { defaultFactories } from '../factories.js';
import type { Ears, EarsHandlers, LabClock, TurnFields } from '../types.js';
import { AudioLibrary } from './scenario.js';
import { BOOTSTRAP_REPS, BOOTSTRAP_SEED, mean, mulberry32, pctl, rateDiffWithin, wilson, type DiffInterval } from './stats.js';
import { frameOfSample, sampleCount, SAMPLE_RATE, silence, toFrames, trimToSpeech } from './wav.js';

// ---------------------------------------------------------------- the pre-registered margins

/** A's key-term recall may be at most this many percentage points below B's (point estimate). */
export const MARGIN_TERM_POINTS = 5;
/** A's mean WER may be at most this many percentage points above B's (point estimate). */
export const MARGIN_WER_POINTS = 2;

/** What the live Flux Settings send for a conversation (src/voice/config.ts defaults: TAI_VOICE_EOT_THRESHOLD 0.75, TAI_VOICE_EOT_TIMEOUT_MS 5000), read from the live loader with no environment. */
const liveConfig = loadVoiceConfig(() => undefined);
export const LIVE_TURN: TurnFields = { eotThreshold: liveConfig.eotThreshold, eotTimeoutMs: liveConfig.eotTimeoutMs };

// ---------------------------------------------------------------- words, WER, key terms

/** The words of a text: lower case, runs of `[a-z0-9']`. Nothing else is done to the text. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** The word edit distance (a substitution, an insertion and a deletion cost 1 each). */
export function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, j) => j);
  for (let i = 1; i <= reference.length; i++) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

/** Edit distance over the reference's words. It can be above 1 (a recognizer that adds more words than the reference has). A reference with no words has no WER: throws. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = wordsOf(reference);
  if (ref.length === 0) throw new RangeError('the reference has no words');
  return editDistance(ref, wordsOf(hypothesis)) / ref.length;
}

/** Strict whole-term match: the words of `term` occur in `hypothesis`, in order and adjacent. A term with no words is never hit. */
export function containsTerm(hypothesis: string | readonly string[], term: string): boolean {
  const have = typeof hypothesis === 'string' ? wordsOf(hypothesis) : hypothesis;
  const want = wordsOf(term);
  if (want.length === 0) return false;
  for (let i = 0; i + want.length <= have.length; i++) {
    let all = true;
    for (let j = 0; j < want.length; j++) {
      if (have[i + j] !== want[j]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

export interface RecognitionSentence {
  id: string;
  text: string;
  terms: string[];
}

export interface RecognitionSet {
  version: number;
  note: string;
  voices: string[];
  recognition: RecognitionSentence[];
}

/** The key terms of a sentence in their normalised form (their words joined by a space), each once. */
export function distinctTerms(sentence: RecognitionSentence): string[] {
  const seen = new Set<string>();
  for (const term of sentence.terms) {
    const key = wordsOf(term).join(' ');
    if (key) seen.add(key);
  }
  return [...seen];
}

export interface UtteranceScore {
  wer: number;
  terms: Array<{ term: string; hit: boolean }>;
}

export function scoreUtterance(sentence: RecognitionSentence, hypothesis: string): UtteranceScore {
  const have = wordsOf(hypothesis);
  return { wer: wordErrorRate(sentence.text, hypothesis), terms: distinctTerms(sentence).map((term) => ({ term, hit: containsTerm(have, term) })) };
}

// ---------------------------------------------------------------- the test set and the result files

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

/** Reads and checks a recognition set (the shape of eval/voice-lab/recognition2.json): voices, and sentences with an id, a text and key terms that occur in the text. */
export function parseRecognitionSet(text: string, where = 'recognition set'): RecognitionSet {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    return fail(where, `not JSON (${(err as Error).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(where, 'not an object');
  const o = raw as Record<string, unknown>;
  const voices = o.voices;
  if (!Array.isArray(voices) || voices.length === 0 || voices.some((v) => typeof v !== 'string' || v === '')) return fail(where, '"voices" must be a non-empty list of voice names');
  const list = o.recognition;
  if (!Array.isArray(list) || list.length === 0) return fail(where, '"recognition" must be a non-empty list');
  const ids = new Set<string>();
  const recognition = (list as unknown[]).map((item, i): RecognitionSentence => {
    const at = `${where}, sentence ${i + 1}`;
    if (!item || typeof item !== 'object') return fail(at, 'not an object');
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || s.id === '') return fail(at, 'no id');
    if (ids.has(s.id)) return fail(at, `the id ${s.id} is used twice`);
    ids.add(s.id);
    if (typeof s.text !== 'string' || wordsOf(s.text).length === 0) return fail(at, `${s.id} has no text`);
    if (!Array.isArray(s.terms) || s.terms.some((t) => typeof t !== 'string')) return fail(at, `${s.id}: "terms" must be a list of strings`);
    const terms = s.terms as string[];
    const have = wordsOf(s.text);
    for (const term of terms) if (!containsTerm(have, term)) return fail(at, `${s.id}: the key term ${JSON.stringify(term)} is not in the sentence`);
    return { id: s.id, text: s.text, terms };
  });
  return { version: typeof o.version === 'number' ? o.version : 0, note: typeof o.note === 'string' ? o.note : '', voices: voices as string[], recognition };
}

export function loadRecognitionSet(file: string): RecognitionSet {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the test set ${file} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  return parseRecognitionSet(text, file);
}

/** One line of a results file. `error` is set when the stream failed twice; then `text` is empty and the record is not scored. */
export interface UtteranceRecord {
  id: string;
  voice: string;
  /** the recognizer: 'labgpu', 'flux' or 'nova' */
  ears: string;
  /** every final, joined with a space ('' when there was none) */
  text: string;
  finals: string[];
  /** ms after the end of speech (negative: before it) of the first partial, null when there was none */
  firstPartialMs: number | null;
  /** ms after the end of speech of the last final, null when there was none */
  lastFinalMs: number | null;
  /** no final arrived after the end of speech within the wait */
  timedOut: boolean;
  /** streams opened for this utterance (2: the first failed) */
  attempts: number;
  error?: string;
}

export const utteranceKey = (id: string, voice: string): string => `${id}|${voice}`;

const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Reads a results file against its set: every line must be a record of a sentence and a voice of the set, each at most once. */
export function parseRecords(text: string, set: RecognitionSet, where: string): Map<string, UtteranceRecord> {
  const ids = new Set(set.recognition.map((s) => s.id));
  const voices = new Set(set.voices);
  const records = new Map<string, UtteranceRecord>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const at = `${where}, line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return fail(at, 'not JSON');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(at, 'not an object');
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || !ids.has(o.id)) return fail(at, `the id ${JSON.stringify(o.id)} is not in the set`);
    if (typeof o.voice !== 'string' || !voices.has(o.voice)) return fail(at, `the voice ${JSON.stringify(o.voice)} is not in the set`);
    const key = utteranceKey(o.id, o.voice);
    if (records.has(key)) return fail(at, `a second record for ${o.id} with ${o.voice}`);
    const error = typeof o.error === 'string' && o.error !== '' ? o.error : undefined;
    if (error === undefined && typeof o.text !== 'string') return fail(at, 'no text and no error');
    records.set(key, {
      id: o.id,
      voice: o.voice,
      ears: typeof o.ears === 'string' ? o.ears : '',
      text: typeof o.text === 'string' ? o.text : '',
      finals: Array.isArray(o.finals) ? o.finals.filter((f): f is string => typeof f === 'string') : [],
      firstPartialMs: finiteOrNull(o.firstPartialMs),
      lastFinalMs: finiteOrNull(o.lastFinalMs),
      timedOut: o.timedOut === true,
      attempts: typeof o.attempts === 'number' ? o.attempts : 1,
      ...(error !== undefined ? { error } : {}),
    });
  });
  return records;
}

export function loadRecords(file: string, set: RecognitionSet): Map<string, UtteranceRecord> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the results ${file} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  return parseRecords(text, set, file);
}

// ---------------------------------------------------------------- one recognizer's numbers

export interface RunSummary {
  /** sentences x voices */
  expected: number;
  /** records in the file */
  records: number;
  /** utterances of the set with no record in the file */
  missing: number;
  /** records that are errors (left out of the numbers below) */
  errors: number;
  /** utterances the numbers are over */
  scored: number;
  /** mean over the scored utterances of their WER (a fraction), null when none */
  meanWer: number | null;
  termHits: number;
  termInstances: number;
  /** the last final's delay after the end of speech, of the scored utterances that had a final at or after it */
  delaysMs: number[];
  /** scored utterances with no final at or after the end of speech */
  noFinal: number;
  /** the recognizer named by the records */
  ears: string;
}

export function summarizeRecords(set: RecognitionSet, records: ReadonlyMap<string, UtteranceRecord>): RunSummary {
  const wers: number[] = [];
  const delays: number[] = [];
  let hits = 0;
  let instances = 0;
  let errors = 0;
  let noFinal = 0;
  let ears = '';
  for (const sentence of set.recognition) {
    for (const voice of set.voices) {
      const record = records.get(utteranceKey(sentence.id, voice));
      if (!record) continue;
      if (record.ears) ears = record.ears;
      if (record.error !== undefined) {
        errors++;
        continue;
      }
      const score = scoreUtterance(sentence, record.text);
      wers.push(score.wer);
      for (const t of score.terms) {
        instances++;
        if (t.hit) hits++;
      }
      if (record.lastFinalMs !== null && record.lastFinalMs >= 0) delays.push(record.lastFinalMs);
      else noFinal++;
    }
  }
  return {
    expected: set.recognition.length * set.voices.length,
    records: records.size,
    missing: set.recognition.length * set.voices.length - records.size,
    errors,
    scored: wers.length,
    meanWer: mean(wers),
    termHits: hits,
    termInstances: instances,
    delaysMs: delays,
    noFinal,
    ears,
  };
}

// ---------------------------------------------------------------- the paired comparison

export interface TermTable {
  /** both recognizers hit the term */
  both: number;
  /** only A did */
  onlyA: number;
  /** only B did */
  onlyB: number;
  neither: number;
}

/**
 * The 95 % interval of (A's recall minus B's) over paired term instances: Newcombe's hybrid score interval for paired proportions (Newcombe 1998, Statistics in Medicine 17:2635-2650, "method
 * 10"), written out so that this text, not the citation, defines what is computed. With the table a = both hit, b = only A hit, c = only B hit, d = neither, n = a + b + c + d:
 *   p1 = (a+b)/n and p2 = (a+c)/n, with their 95 % Wilson score intervals [l1, u1] and [l2, u2] (stats.ts `wilson`);
 *   phi = C / sqrt((a+b)(c+d)(a+c)(b+d)), or 0 when a marginal total is 0, where A = a*d - b*c and
 *     C = A - n/2 if A > n/2, C = 0 if 0 <= A <= n/2, C = A if A < 0   (the n/2 term is the paper's continuity correction: without it the interval collapses to a point when the two always agree);
 *   lower = (p1 - p2) - sqrt((p1-l1)^2 - 2 phi (p1-l1)(u2-p2) + (u2-p2)^2)
 *   upper = (p1 - p2) + sqrt((u1-p1)^2 - 2 phi (u1-p1)(p2-l2) + (p2-l2)^2).
 * The pairs are key-term instances and they are treated as independent; the terms of one sentence, and the two voices that read it, are not, so the interval is somewhat narrower than it
 * should be. Fractions, not points. Null when the table is empty. Note the sign: A minus B (stats.ts `newcombe` is B minus A, for two independent samples).
 */
export function pairedRecallInterval(t: TermTable): DiffInterval | null {
  const a = t.both;
  const b = t.onlyA;
  const c = t.onlyB;
  const d = t.neither;
  const n = a + b + c + d;
  const first = wilson(a + b, n);
  const second = wilson(a + c, n);
  if (!first || !second) return null;
  const denominator = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  let phi = 0;
  if (denominator > 0) {
    const cross = a * d - b * c;
    const corrected = cross > n / 2 ? cross - n / 2 : cross >= 0 ? 0 : cross;
    phi = corrected / denominator;
  }
  const diff = first.p - second.p;
  const downA = first.p - first.lo;
  const upA = first.hi - first.p;
  const downB = second.p - second.lo;
  const upB = second.hi - second.p;
  return {
    diff,
    lo: diff - Math.sqrt(Math.max(0, downA * downA - 2 * phi * downA * upB + upB * upB)),
    hi: diff + Math.sqrt(Math.max(0, upA * upA - 2 * phi * upA * downB + downB * downB)),
  };
}

/** The mean of `values` with its 95 % percentile bootstrap interval (resampling the values with replacement, `reps` times, seeded: the same data always give the same interval). Null for no values. */
export function bootstrapMeanInterval(values: readonly number[], reps = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED): DiffInterval | null {
  const centre = mean(values);
  if (centre === null) return null;
  const rng = mulberry32(seed);
  const n = values.length;
  const means: number[] = [];
  for (let r = 0; r < reps; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rng() * n)];
    means.push(sum / n);
  }
  return { diff: centre, lo: pctl(means, 0.025) as number, hi: pctl(means, 0.975) as number };
}

export interface Paired {
  /** utterances scored in both files */
  utterances: number;
  /** utterances of the set that were not (an error record, or no record, in A or in B) */
  left: number;
  /** key-term instances of the paired utterances, and how often each recognizer hit them */
  instances: number;
  hitsA: number;
  hitsB: number;
  table: TermTable;
  /** A minus B, as a fraction of instances */
  recall: DiffInterval | null;
  werA: number | null;
  werB: number | null;
  /** A minus B over the paired utterances, as a fraction */
  wer: DiffInterval | null;
}

export function comparePaired(set: RecognitionSet, a: ReadonlyMap<string, UtteranceRecord>, b: ReadonlyMap<string, UtteranceRecord>): Paired {
  const table: TermTable = { both: 0, onlyA: 0, onlyB: 0, neither: 0 };
  const werA: number[] = [];
  const werB: number[] = [];
  let utterances = 0;
  for (const sentence of set.recognition) {
    for (const voice of set.voices) {
      const ra = a.get(utteranceKey(sentence.id, voice));
      const rb = b.get(utteranceKey(sentence.id, voice));
      if (!ra || !rb || ra.error !== undefined || rb.error !== undefined) continue;
      utterances++;
      const sa = scoreUtterance(sentence, ra.text);
      const sb = scoreUtterance(sentence, rb.text);
      werA.push(sa.wer);
      werB.push(sb.wer);
      sa.terms.forEach((t, i) => {
        const hitB = sb.terms[i].hit;
        if (t.hit && hitB) table.both++;
        else if (t.hit) table.onlyA++;
        else if (hitB) table.onlyB++;
        else table.neither++;
      });
    }
  }
  return {
    utterances,
    left: set.recognition.length * set.voices.length - utterances,
    instances: table.both + table.onlyA + table.onlyB + table.neither,
    hitsA: table.both + table.onlyA,
    hitsB: table.both + table.onlyB,
    table,
    recall: pairedRecallInterval(table),
    werA: mean(werA),
    werB: mean(werB),
    wer: bootstrapMeanInterval(werA.map((w, i) => w - werB[i])),
  };
}

/** "A's recall >= B's recall - MARGIN_TERM_POINTS", on the paired instances, in exact integer arithmetic. Null when there are none. */
export function termMarginMet(p: Paired): boolean | null {
  return p.instances === 0 ? null : rateDiffWithin(p.hitsB, p.instances, p.hitsA, p.instances, MARGIN_TERM_POINTS);
}

/** "A's mean WER <= B's mean WER + MARGIN_WER_POINTS" on the paired utterances (a tie within 1e-9 of a point counts as within). Null when there are none. */
export function werMarginMet(p: Paired): boolean | null {
  return p.werA === null || p.werB === null ? null : 100 * (p.werA - p.werB) <= MARGIN_WER_POINTS + 1e-9;
}

// ---------------------------------------------------------------- the report

const percent = (fraction: number, digits = 2): string => `${(100 * fraction).toFixed(digits)} %`;
/** A signed number of percentage points from a fraction: "+1.8", "-0.5"; a value that rounds to zero is "+0.0". */
const signedPoints = (fraction: number, digits = 1): string => {
  const v = Math.round(100 * fraction * 10 ** digits) / 10 ** digits;
  return `${v < 0 ? '-' : '+'}${Math.abs(v).toFixed(digits)}`;
};
const ms = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value)} ms`);

function describeRun(label: string, file: string, s: RunSummary): string[] {
  const rate = s.termInstances > 0 ? ` (${percent(s.termHits / s.termInstances, 1)})` : '';
  return [
    `${label}: ${file}${s.ears ? ` (${s.ears})` : ''}`,
    `  ${s.scored} of ${s.expected} utterances scored, ${s.errors} error record${s.errors === 1 ? '' : 's'}, ${s.missing} with no record`,
    `  mean WER ${s.meanWer === null ? 'n/a' : percent(s.meanWer)}`,
    `  key terms ${s.termHits} / ${s.termInstances}${rate}`,
    `  final after the end of speech: p50 ${ms(pctl(s.delaysMs, 0.5))}, p90 ${ms(pctl(s.delaysMs, 0.9))} (${s.delaysMs.length} utterances; ${s.noFinal} scored with none after the end of speech)`,
  ];
}

export interface ComparisonInput {
  set: RecognitionSet;
  fileA: string;
  fileB: string;
  a: ReadonlyMap<string, UtteranceRecord>;
  b: ReadonlyMap<string, UtteranceRecord>;
}

/** The text `compare` prints. Numbers and the two margin sentences; no other verdict. */
export function renderComparison(input: ComparisonInput): string {
  const { set, fileA, fileB } = input;
  const sa = summarizeRecords(set, input.a);
  const sb = summarizeRecords(set, input.b);
  const p = comparePaired(set, input.a, input.b);
  const perPass = set.recognition.reduce((sum, s) => sum + distinctTerms(s).length, 0);
  const lines: string[] = [];
  lines.push(`recognition set: ${set.recognition.length} sentences x ${set.voices.length} voices = ${sa.expected} utterances, ${perPass} key-term instances per voice pass (${perPass * set.voices.length} in all)`);
  lines.push(...describeRun('A', fileA, sa));
  lines.push(...describeRun('B', fileB, sb));
  lines.push('');
  if (p.utterances === 0) {
    lines.push('paired: no utterance was scored in both files, nothing to compare');
  } else {
    lines.push(`paired: ${p.utterances} utterances scored in both files (${p.left} left out), ${p.instances} key-term instances`);
    lines.push(`  key terms: both ${p.table.both}, only A ${p.table.onlyA}, only B ${p.table.onlyB}, neither ${p.table.neither}`);
    if (p.recall) {
      lines.push(
        `  recall: A ${p.hitsA} / ${p.instances} = ${percent(p.hitsA / p.instances, 1)}, B ${p.hitsB} / ${p.instances} = ${percent(p.hitsB / p.instances, 1)}; A minus B ${signedPoints(p.recall.diff)} points, ` +
          `95 % interval ${signedPoints(p.recall.lo)} to ${signedPoints(p.recall.hi)} (Newcombe's paired score interval; the instances are treated as independent)`,
      );
    }
    if (p.wer && p.werA !== null && p.werB !== null) {
      lines.push(
        `  WER: A ${percent(p.werA)}, B ${percent(p.werB)}; A minus B ${signedPoints(p.wer.diff, 2)} points, 95 % interval ${signedPoints(p.wer.lo, 2)} to ${signedPoints(p.wer.hi, 2)} ` +
          `(paired bootstrap over the ${p.utterances} utterances, ${BOOTSTRAP_REPS} resamples, seed ${BOOTSTRAP_SEED})`,
      );
    }
  }
  lines.push('');
  lines.push(`MARGIN_TERM_POINTS = ${MARGIN_TERM_POINTS}`);
  lines.push(`MARGIN_WER_POINTS = ${MARGIN_WER_POINTS}`);
  const termMet = termMarginMet(p);
  const werMet = werMarginMet(p);
  lines.push(`term recall of A is not worse than B's by more than ${MARGIN_TERM_POINTS} points: ${termMet === null ? 'not computable, no key-term instance was scored in both files' : termMet}`);
  lines.push(`WER of A is not worse than B's by more than ${MARGIN_WER_POINTS} points: ${werMet === null ? 'not computable, no utterance was scored in both files' : werMet}`);
  if (p.recall) {
    const lo = 100 * p.recall.lo;
    const hi = 100 * p.recall.hi;
    const shown = `(${signedPoints(p.recall.lo)} to ${signedPoints(p.recall.hi)} points)`;
    if (lo > -MARGIN_TERM_POINTS) lines.push(`the 95 % interval of the recall difference ${shown} excludes -${MARGIN_TERM_POINTS}: non-inferiority shown`);
    else if (hi < -MARGIN_TERM_POINTS) lines.push(`the 95 % interval of the recall difference ${shown} lies below -${MARGIN_TERM_POINTS}: not shown at this n`);
    else lines.push(`the 95 % interval of the recall difference ${shown} does not exclude -${MARGIN_TERM_POINTS}: not shown at this n`);
  }
  return lines.join('\n');
}

/** What `run` prints at the end: the same numbers `compare` prints for each file. */
export function renderSummary(file: string, s: RunSummary): string {
  return describeRun('results', file, s).join('\n');
}

// ---------------------------------------------------------------- the Deepgram key

/** The value of the last `DEEPGRAM_API_KEY=` line of an env file (an `export` prefix, quotes and a trailing comment are understood), or null. Nothing else in the text is looked at. */
export function keyFromEnvText(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?DEEPGRAM_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1].trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    found = value === '' ? null : value;
  }
  return found;
}

/** --env-file first (when it has the line), then the environment variable; null when there is none. A file that cannot be read throws an error that names the file and says nothing of its content. */
export function resolveDeepgramKey(opts: { envFile?: string; environ: Record<string, string | undefined> }): string | null {
  if (opts.envFile) {
    let text: string;
    try {
      text = fs.readFileSync(opts.envFile, 'utf8');
    } catch (err) {
      throw new Error(`cannot read the env file ${opts.envFile} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    const fromFile = keyFromEnvText(text);
    if (fromFile) return fromFile;
  }
  const fromEnvironment = (opts.environ.DEEPGRAM_API_KEY ?? '').trim();
  return fromEnvironment === '' ? null : fromEnvironment;
}

// ---------------------------------------------------------------- the stream

export interface RecognizeTiming {
  /** silence before the clip, ms (docs 9.2: 600) */
  leadMs: number;
  /** the longest wait after the end of speech for a final, ms */
  maxWaitMs: number;
  /** quiet (no partial, no final) that must follow a final after the end of speech before the stream is closed, ms */
  graceMs: number;
  connectTimeoutMs: number;
  /** between one stream's close and the next stream's open, ms */
  pauseMs: number;
  /** before the second attempt of a failed stream, ms */
  retryPauseMs: number;
}

export const DEFAULT_TIMING: RecognizeTiming = { leadMs: 600, maxWaitMs: 6000, graceMs: 600, connectTimeoutMs: 5000, pauseMs: 200, retryPauseMs: 1000 };

const FRAME_MS = 40;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/** The lab's configuration with the address of the chosen recognizer replaced (labgpu: the whole URL with its query; flux and nova: the endpoint, the lab builds the query). */
export function recognizerConfig(ears: EarsKind, url?: string): LabConfig {
  const base = loadLabConfig(() => undefined);
  if (!url) return base;
  return ears === 'labgpu' ? { ...base, earsUrl: url } : ears === 'flux' ? { ...base, fluxUrl: url } : { ...base, novaUrl: url };
}

export interface PlannedUtterance {
  id: string;
  voice: string;
  /** the stream as whole 40 ms frames: the lead silence, the trimmed clip, the last frame padded */
  frames: Buffer[];
  /** the frame that carries the last speech sample */
  lastSpeechFrame: number;
}

function planUtterance(sentence: RecognitionSentence, voice: string, audio: AudioLibrary, leadMs: number): PlannedUtterance {
  const clip = trimToSpeech(audio.clip(voice, sentence.text));
  if (!clip) throw new Error(`the clip of ${JSON.stringify(voice)} saying ${sentence.id} has no speech above the threshold`);
  const lead = silence(leadMs);
  return {
    id: sentence.id,
    voice,
    frames: toFrames(Buffer.concat([lead, clip.pcm]), FRAME_BYTES),
    lastSpeechFrame: frameOfSample(sampleCount(lead) + clip.last, FRAME_SAMPLES),
  };
}

/** The streams of the set, sentence-major (every voice of a sentence, then the next sentence), the first `limit` of them. A clip that is missing, or has no speech, throws here, before any stream is opened. */
export function planRun(set: RecognitionSet, audio: AudioLibrary, timing: RecognizeTiming, limit?: number): PlannedUtterance[] {
  const plans: PlannedUtterance[] = [];
  for (const sentence of set.recognition) {
    for (const voice of set.voices) {
      if (limit !== undefined && plans.length >= limit) return plans;
      plans.push(planUtterance(sentence, voice, audio, timing.leadMs));
    }
  }
  return plans;
}

type Outcome = { ok: true; finals: string[]; firstPartialMs: number | null; lastFinalMs: number | null; timedOut: boolean } | { ok: false; error: string };

interface StreamState {
  partials: number[];
  finals: Array<{ text: string; at: number }>;
  /** the last partial or final, on the stream's clock; -Infinity before the first */
  lastEventAt: number;
  down: string | null;
}

async function sleepUntil(clock: LabClock, due: number): Promise<void> {
  const wait = due - clock();
  // behind schedule: still give the socket's events a turn
  await new Promise<void>((resolve) => (wait > 0 ? setTimeout(resolve, wait) : setImmediate(resolve)));
}

const pause = (waitMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));

/** One stream of one utterance, in real time (see the header). Never throws. */
async function streamOnce(plan: PlannedUtterance, open: (handlers: EarsHandlers) => Ears, timing: RecognizeTiming, clock: LabClock, redact: (text: string) => string): Promise<Outcome> {
  const st: StreamState = { partials: [], finals: [], lastEventAt: Number.NEGATIVE_INFINITY, down: null };
  const handlers: EarsHandlers = {
    partial: (_text, at) => {
      st.partials.push(at);
      st.lastEventAt = at;
    },
    final: (text, at) => {
      st.finals.push({ text, at });
      st.lastEventAt = at;
    },
    down: (reason) => {
      st.down = reason;
    },
  };
  const ears = open(handlers);
  try {
    await ears.connect(timing.connectTimeoutMs);
  } catch (err) {
    ears.close();
    return { ok: false, error: redact(err instanceof Error ? err.message : String(err)) };
  }
  const silent = Buffer.alloc(FRAME_BYTES);
  const t0 = clock();
  let endOfSpeech: number | null = null;
  for (let k = 0; ; k++) {
    await sleepUntil(clock, t0 + k * FRAME_MS);
    const now = clock();
    if (st.down !== null) break;
    if (endOfSpeech !== null) {
      const last = st.finals.length > 0 ? st.finals[st.finals.length - 1] : undefined;
      if (last !== undefined && last.at >= endOfSpeech && now - st.lastEventAt >= timing.graceMs) break;
      if (now - endOfSpeech >= timing.maxWaitMs) break;
    }
    ears.sendAudio(k < plan.frames.length ? plan.frames[k] : silent);
    if (k === plan.lastSpeechFrame) endOfSpeech = now;
  }
  ears.close();
  const end = endOfSpeech;
  const afterEnd = end !== null && st.finals.some((f) => f.at >= end);
  if (st.down !== null && !afterEnd) return { ok: false, error: redact(`${ears.name}: ${st.down}`) };
  const lastFinal = st.finals.length > 0 ? st.finals[st.finals.length - 1].at : null;
  const from = end ?? t0;
  return {
    ok: true,
    finals: st.finals.map((f) => f.text),
    firstPartialMs: st.partials.length > 0 ? Math.round(st.partials[0] - from) : null,
    lastFinalMs: lastFinal === null ? null : Math.round(lastFinal - from),
    timedOut: !afterEnd,
  };
}

export interface RunOptions {
  ears: EarsKind;
  /** replaces the recognizer's default address */
  url?: string;
  /** read when a Deepgram stream is opened (flux, nova); never called for labgpu */
  deepgramKey: () => string;
  timing: RecognizeTiming;
  log: VoiceLog;
  /** every string that leaves the program goes through this (it takes the key out) */
  redact: (text: string) => string;
  /** called with each utterance's record as soon as it is complete */
  onRecord: (record: UtteranceRecord, index: number, total: number) => void;
}

/** The planned utterances one after the other, each recognizer stream opened through the lab's own factory (a failed one is tried once more), one at a time. */
export async function runRecognition(plans: readonly PlannedUtterance[], opts: RunOptions): Promise<UtteranceRecord[]> {
  const { timing } = opts;
  const cfg = recognizerConfig(opts.ears, opts.url);
  const clock: LabClock = () => performance.now();
  const factories = defaultFactories(cfg, opts.deepgramKey, opts.log, clock);
  const request = { keyterms: [...KEYTERMS], turn: { ...LIVE_TURN } };
  const records: UtteranceRecord[] = [];
  for (const plan of plans) {
    const open = (handlers: EarsHandlers): Ears => factories.makeEars(opts.ears, handlers, request);
    let record: UtteranceRecord | null = null;
    let lastError = '';
    for (let attempt = 1; attempt <= 2 && record === null; attempt++) {
      const outcome = await streamOnce(plan, open, timing, clock, opts.redact);
      await pause(timing.pauseMs);
      if (outcome.ok) {
        record = {
          id: plan.id,
          voice: plan.voice,
          ears: opts.ears,
          text: outcome.finals.join(' '),
          finals: outcome.finals,
          firstPartialMs: outcome.firstPartialMs,
          lastFinalMs: outcome.lastFinalMs,
          timedOut: outcome.timedOut,
          attempts: attempt,
        };
      } else {
        lastError = outcome.error;
        if (attempt === 1) await pause(timing.retryPauseMs);
      }
    }
    const done: UtteranceRecord = record ?? { id: plan.id, voice: plan.voice, ears: opts.ears, text: '', finals: [], firstPartialMs: null, lastFinalMs: null, timedOut: false, attempts: 2, error: lastError };
    records.push(done);
    opts.onRecord(done, records.length, plans.length);
  }
  return records;
}

// ---------------------------------------------------------------- the command line

export const USAGE = [
  'usage:',
  '  recognize run --audio <dir with manifest.json> --set <recognition2.json> --ears labgpu|flux|nova',
  '                [--url <ws address>] [--env-file <file with a DEEPGRAM_API_KEY= line>] [--out <results.jsonl>] [--limit N]',
  '        (one stream at a time, in real time; flux and nova need DEEPGRAM_API_KEY in the environment or in --env-file; --out defaults to recognize-<ears>.jsonl and must not exist;',
  '         --limit N runs only the first N utterances, sentence x voice in the set\'s order)',
  '  recognize compare --a <results.jsonl> --b <results.jsonl> --set <recognition2.json>',
  '        (A is the first file, B the second; the margins are MARGIN_TERM_POINTS and MARGIN_WER_POINTS)',
  'exit codes: 0 done, 2 usage, 1 anything else',
].join('\n');

class UsageError extends Error {}

export interface RecognizeEnv {
  /** shortens the waits of a run (tests) */
  timing?: Partial<RecognizeTiming>;
  /** where DEEPGRAM_API_KEY is looked up (default: the process's environment) */
  environ?: Record<string, string | undefined>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const ALLOWED: Record<string, string[]> = {
  run: ['audio', 'set', 'ears', 'url', 'env-file', 'out', 'limit'],
  compare: ['a', 'b', 'set'],
};

function parse(argv: string[]): { command: string; values: Map<string, string> } {
  const [command, ...rest] = argv;
  const allowed = ALLOWED[command ?? ''];
  if (!allowed) throw new UsageError(command ? `unknown command ${command}` : 'no command');
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (!allowed.includes(name)) throw new UsageError(`unknown option ${a} for ${command}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${a} needs a value`);
    values.set(name, value);
    i++;
  }
  return { command, values };
}

function need(values: Map<string, string>, name: string): string {
  const v = values.get(name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
}

const isEarsKind = (value: string): value is EarsKind => value === 'labgpu' || value === 'flux' || value === 'nova';

/** Anything that goes wrong with an input the user named is a usage error (exit 2), found before the first stream. */
function asUsage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}

async function cmdRun(values: Map<string, string>, env: RecognizeEnv, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const earsName = need(values, 'ears');
  if (!isEarsKind(earsName)) throw new UsageError('--ears must be labgpu, flux or nova');
  const setFile = need(values, 'set');
  const set = asUsage(() => loadRecognitionSet(setFile));
  const audio = asUsage(() => new AudioLibrary(need(values, 'audio')));
  const url = values.get('url');
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UsageError('--url is not a URL');
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new UsageError('--url must be a ws:// or wss:// address');
  }
  const limitText = values.get('limit');
  let limit: number | undefined;
  if (limitText !== undefined) {
    if (!/^\d+$/.test(limitText) || Number(limitText) < 1) throw new UsageError('--limit must be a whole number of at least 1');
    limit = Number(limitText);
  }
  let key: string | null = null;
  if (earsName !== 'labgpu') {
    key = asUsage(() => resolveDeepgramKey({ envFile: values.get('env-file'), environ: env.environ ?? process.env }));
    if (key === null) throw new UsageError(`${earsName} needs a Deepgram key: set DEEPGRAM_API_KEY in the environment, or pass --env-file with a file that has a DEEPGRAM_API_KEY= line`);
  }
  const secret = key;
  const redact = (text: string): string => (secret ? text.split(secret).join('[redacted]') : text);
  const timing: RecognizeTiming = { ...DEFAULT_TIMING, ...env.timing };
  const plans = asUsage(() => planRun(set, audio, timing, limit));
  const outFile = values.get('out') ?? `recognize-${earsName}.jsonl`;
  const cfg = recognizerConfig(earsName, url);
  const host = hostOf(earsName === 'labgpu' ? cfg.earsUrl : earsName === 'flux' ? cfg.fluxUrl : cfg.novaUrl);
  const log: VoiceLog = {
    debug: () => undefined,
    info: () => undefined,
    warn: (obj, msg) => err(redact(`warn: ${msg ?? ''} ${JSON.stringify(obj)}`)),
    error: (obj, msg) => err(redact(`error: ${msg ?? ''} ${JSON.stringify(obj)}`)),
  };
  const fd = createResultsFile(outFile);
  out(`recognize: ${earsName} at ${host}, ${set.recognition.length} sentences x ${set.voices.length} voices, ${plans.length} utterances to run, results in ${outFile}`);
  let records: UtteranceRecord[];
  try {
    records = await runRecognition(plans, {
      ears: earsName,
      ...(url !== undefined ? { url } : {}),
      deepgramKey: () => secret ?? '',
      timing,
      log,
      redact,
      onRecord: (record, index, count) => {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
        const detail =
          record.error !== undefined
            ? `ERROR after ${record.attempts} attempts: ${record.error}`
            : record.lastFinalMs === null
              ? `no final (first partial ${ms(record.firstPartialMs)})`
              : `first partial ${ms(record.firstPartialMs)}, last final ${ms(record.lastFinalMs)}${record.timedOut ? ', none after the end of speech' : ''}`;
        out(`[${index}/${count}] ${record.id} ${record.voice}: ${detail}`);
      },
    });
  } finally {
    fs.closeSync(fd);
  }
  const summary = summarizeRecords(set, new Map(records.map((r) => [utteranceKey(r.id, r.voice), r])));
  out(`done: ${records.length} utterances, ${summary.errors} error record${summary.errors === 1 ? '' : 's'}`);
  out(renderSummary(outFile, summary));
  return 0;
}

/** The results file, created exclusively: a file that is already there is never touched (usage error), whatever else is wrong is an ordinary error. */
function createResultsFile(file: string): number {
  try {
    return fs.openSync(file, 'wx');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new UsageError(`${file} already exists: results are never overwritten, remove it or choose another --out`);
    throw new Error(`cannot create ${file} (${code ?? 'error'})`);
  }
}

function cmdCompare(values: Map<string, string>, out: (t: string) => void): number {
  const fileA = need(values, 'a');
  const fileB = need(values, 'b');
  const set = asUsage(() => loadRecognitionSet(need(values, 'set')));
  const a = asUsage(() => loadRecords(fileA, set));
  const b = asUsage(() => loadRecords(fileB, set));
  out(renderComparison({ set, fileA, fileB, a, b }));
  return 0;
}

/** The CLI. Returns the exit code (0 done, 2 usage, 1 anything else); never throws. */
export async function main(argv: string[], env: RecognizeEnv = {}): Promise<number> {
  const out = env.out ?? ((t: string) => console.log(t));
  const err = env.err ?? ((t: string) => console.error(t));
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    (argv.length === 0 ? err : out)(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  try {
    const { command, values } = parse(argv);
    if (command === 'run') return await cmdRun(values, env, out, err);
    return cmdCompare(values, out);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`lab recognize: ${e.message}\n${USAGE}`);
      return 2;
    }
    err(`lab recognize: ${(e as Error).message}`);
    return 1;
  }
}

const direct = process.argv[1] != null && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (direct) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`lab recognize: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
