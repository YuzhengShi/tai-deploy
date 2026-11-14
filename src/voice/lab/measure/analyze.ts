/**
 * The criteria of docs/VOICE_SELFBUILT.md 9.4 that a client can measure (C0, C1, C2, C3, C10), computed from raw logs only, for two chains:
 * A = today's call (live), B = the lab. Every metric is the one 9.2 defines; where the document leaves a choice open, the choice is made once,
 * here, and written into the report's "Definitions" section so that nobody has to read it into a number.
 *
 * Verdicts: PASS when the point estimate is within its documented tolerance AND both chains meet the document's minimum sample; FAIL when it is
 * not (whatever the sample); INSUFFICIENT when it would pass on a sample below the minimum (never a silent pass); NO DATA when a chain has none.
 * The absolute criteria (no call fails to start, every short answer committed, no false barge-in, the mode of the call is the one asked) bind
 * chain B. A difference is always B minus A. Rates carry k/n and a Wilson interval; the interval of a difference of rates is Newcombe's hybrid
 * score, of a difference of percentiles a seeded bootstrap; where it contains zero the verdict says "not distinguishable at this n".
 *
 * Only the TYPES of run.ts are imported (erased at build time): the analysis does not load the client or the socket library.
 */
import fs from 'fs';
import path from 'path';

import type { CallHeader, EndLine, EventLine, FramesLine, GreetLine, MicLine, OpenLine, ScenarioLine, StartLine } from './run.js';
import type { CallMode, ScenarioClass } from './scenario.js';
import { BOOTSTRAP_REPS, BOOTSTRAP_SEED, bootstrapDiff, containsZero, newcombe, pctl, rateDiffWithin, wilson, type DiffInterval, type Proportion } from './stats.js';
import { AUDIBLE_SLACK_MS, audibleAt } from './wav.js';

// ---------------------------------------------------------------- the document's numbers

/** An agent audio frame before UE + this is a cut-in (docs 9.4 C2). */
export const CUT_IN_AUDIO_MS = 300;
/** An end-of-turn wait longer than this on a complete utterance is too long (C2). */
export const TOO_LONG_MS = 3000;
/** A scripted speech explains an `agent_interrupted` from this long before its first frame to this long after its last (detection and network time). */
export const EXPLAIN_BEFORE_MS = 100;
export const EXPLAIN_AFTER_MS = 1000;
/** The frozen test set's fingerprint (docs 9.7). */
export const FROZEN_SHA256 = '89b4b8d2a10568988e21841fa8d15f118914ece03e73e0f13aff141d1edf7612';

export const TOLERANCE = {
  readyMs: 500,
  greetingMs: 700,
  plainP50Ms: 300,
  plainP90Ms: 600,
  toolP50Ms: 300,
  cutInPoints: 10,
  tooLongPoints: 5,
  interruptedP50Ms: 100,
  interruptedP90Ms: 200,
  audioStopP90Ms: 300,
  modeCutInPoints: 10,
} as const;

/** The smallest samples the document asks for, per chain. */
export const MINIMUM = {
  calls: 20,
  plainTurns: 30,
  toolTurns: 15,
  interviewToolTurns: 10,
  cutInTrials: 60, // pause + filler: 10 + 10 scenarios x 3 runs
  tooLongTrials: 90, // pause + short + filler
  shortTrials: 30,
  interruptions: 24,
  agentTurns: 40,
  interviewTrials: 15,
  talkTrials: 9,
} as const;

// ---------------------------------------------------------------- reading raw logs

export interface EventRec extends EventLine {
  seq: number;
}
export interface AudioRec {
  k: 'a';
  t: number;
  n: number;
  seq: number;
}

export interface RawCall {
  file: string;
  header: CallHeader;
  open: OpenLine | null;
  start: StartLine | null;
  mic: MicLine | null;
  events: EventRec[];
  audio: AudioRec[];
  frames: FramesLine[];
  greet: GreetLine | null;
  scenarios: ScenarioLine[];
  end: EndLine | null;
  /** the last line was cut (the process died while writing it) */
  truncated: boolean;
}

/** Parses one raw log (JSON lines). A cut last line is tolerated and flagged; a bad line anywhere else, or a log with no header, throws. */
export function parseRawLog(text: string, file = ''): RawCall {
  const rows = text.split('\n').filter((l) => l.trim() !== '');
  const call: RawCall = { file, header: null as unknown as CallHeader, open: null, start: null, mic: null, events: [], audio: [], frames: [], greet: null, scenarios: [], end: null, truncated: false };
  rows.forEach((row, index) => {
    let line: { k?: string } & Record<string, unknown>;
    try {
      line = JSON.parse(row) as typeof line;
    } catch {
      if (index === rows.length - 1) {
        call.truncated = true;
        return;
      }
      throw new Error(`${file || 'raw log'}: line ${index + 1} is not JSON`);
    }
    switch (line.k) {
      case 'call':
        call.header = line as unknown as CallHeader;
        break;
      case 'open':
        call.open = line as unknown as OpenLine;
        break;
      case 'start':
        call.start = line as unknown as StartLine;
        break;
      case 'mic':
        call.mic = line as unknown as MicLine;
        break;
      case 'e':
        call.events.push({ ...(line as unknown as EventLine), seq: index });
        break;
      case 'a':
        call.audio.push({ k: 'a', t: Number(line.t), n: Number(line.n), seq: index });
        break;
      case 'f':
        call.frames.push(line as unknown as FramesLine);
        break;
      case 'greet':
        call.greet = line as unknown as GreetLine;
        break;
      case 'scn':
        call.scenarios.push(line as unknown as ScenarioLine);
        break;
      case 'end':
        call.end = line as unknown as EndLine;
        break;
      default:
        break; // a kind of a newer version: ignored
    }
  });
  if (!call.header) throw new Error(`${file || 'raw log'}: no call header line`);
  return call;
}

/** Every `*.jsonl` raw log in a directory, in name order. */
export function readRawLogs(dir: string): RawCall[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  return files.map((f) => parseRawLog(fs.readFileSync(path.join(dir, f), 'utf8'), f));
}

// ---------------------------------------------------------------- facts per trial

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** A `status` event of the call, for asking what the agent was doing before a frame arrived. */
export interface StatusRec {
  seq: number;
  t: number;
  state: string;
}

export function statusList(call: RawCall): StatusRec[] {
  return call.events.filter((e) => e.type === 'status').map((e) => ({ seq: e.seq, t: e.t, state: str(e.state) }));
}

/** The index of the last status event that came before the record numbered `seq`, or -1 (binary search: the list is in arrival order). */
function lastStatusBefore(list: readonly StatusRec[], seq: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].seq < seq) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The run of speech an agent frame belongs to: the hub sends `status speaking` just before the first frame of a run, so the frame's run began at the
 * last status before it when that was `speaking`. A run that follows a `working` status is a filler the session injected while a function ran (the
 * answer of a tool turn follows `thinking`, and a lead-in the model speaks before its call follows `thinking` too). A frame with no `speaking` before
 * it (the tail of a lead-in after the status went to `working`) is taken as the start of a run of its own.
 */
export function runOf(list: readonly StatusRec[], frame: { seq: number; t: number }): { startedAt: number; filler: boolean } {
  const i = lastStatusBefore(list, frame.seq);
  if (i < 0 || list[i].state !== 'speaking') return { startedAt: frame.t, filler: false };
  return { startedAt: list[i].t, filler: i > 0 && list[i - 1].state === 'working' };
}

export interface TrialFacts {
  chain: string;
  callId: string;
  mode: CallMode;
  set: string;
  id: string;
  class: ScenarioClass;
  /** the call was closed under the scenario, or its end of speech was never sent: no data, listed, not counted */
  incomplete: boolean;
  ue: number | null;
  /** user transcripts in the scenario's window */
  userTranscripts: number;
  /** more than one user transcript in the window (amendment A1: reported next to the cut-in rate, never pass/fail) */
  split: boolean;
  /** an agent frame before UE + 300 ms that is not the greeting, a filler, or part of a run that began before the scenario did (amendment A1) */
  early: boolean;
  /** of those frames, one came before the student's first word */
  stray: boolean;
  answered: boolean;
  /** first agent frame at or after UE, minus UE; null when none came */
  latencyMs: number | null;
  /** a `status working` between UE and the first agent frame (or, with no frame, the end of the window) */
  tool: boolean;
  /** a user transcript arrived at or after UE (the line of the complete utterance); false: the scenario was not committed */
  committed: boolean;
  /** the first user transcript at or after UE, minus UE; null when the scenario was not committed */
  eotMs: number | null;
  /** an agent frame before UE + 300 ms (amendment A1: audio only; the split lines are `split`) */
  cutIn: boolean;
  /** EOT latency over 3.0 s, or no end-of-turn line at all (a scenario that was not committed: the page never learned that the turn ended; amendment A4) */
  tooLong: boolean;
  /** the previous scenario of the call did not reach quiet: a late answer may sit in this window */
  afterUnsettled: boolean;
}

export function trialFacts(call: RawCall, scn: ScenarioLine, previousSettled: boolean, statuses: readonly StatusRec[] = statusList(call)): TrialFacts {
  const ue = scn.ueSentAt;
  const base = {
    chain: call.header.chain,
    callId: call.header.callId,
    mode: call.header.mode,
    set: scn.set,
    id: scn.id,
    class: scn.class,
    afterUnsettled: !previousSettled,
  };
  if (ue === null || scn.wait === 'closed') {
    return { ...base, incomplete: true, ue, userTranscripts: 0, split: false, early: false, stray: false, answered: false, latencyMs: null, tool: false, committed: false, eotMs: null, cutIn: false, tooLong: false };
  }
  const inWindow = (t: number) => t >= scn.begin && t < scn.end;
  const audio = call.audio.filter((a) => inWindow(a.t));
  const events = call.events.filter((e) => inWindow(e.t));
  const firstSpeech = scn.segments[0]?.beginSentAt ?? scn.begin;
  const userTranscripts = events.filter((e) => e.type === 'transcript' && e.role === 'user');
  // a cut-in is agent audio before UE + 300 ms; what the scenario did not cause does not count: a run of speech that began before the scenario did
  // (the greeting, a late answer) and a filler the session injected while a function ran
  const counted = audio.filter((a) => {
    if (a.t >= ue + CUT_IN_AUDIO_MS) return false;
    const run = runOf(statuses, a);
    return run.startedAt >= scn.begin && !run.filler;
  });
  const firstAfter = audio.find((a) => a.t >= ue) ?? null;
  const tool = events.some((e) => e.type === 'status' && e.state === 'working' && e.t >= ue && e.t < (firstAfter ? firstAfter.t : scn.end));
  const eot = userTranscripts.find((e) => e.t >= ue) ?? null;
  const eotMs = eot ? eot.t - ue : null;
  return {
    ...base,
    incomplete: false,
    ue,
    userTranscripts: userTranscripts.length,
    split: userTranscripts.length > 1,
    early: counted.length > 0,
    stray: counted.some((a) => a.t < firstSpeech),
    answered: firstAfter !== null,
    latencyMs: firstAfter ? firstAfter.t - ue : null,
    tool,
    committed: eot !== null,
    eotMs,
    cutIn: counted.length > 0,
    tooLong: eotMs === null || eotMs > TOO_LONG_MS,
  };
}

export interface BargeFacts {
  chain: string;
  callId: string;
  id: string;
  /** why the trial is not a barge-in: nothing was said (`skipped`), or the agent was not audible at the onset by the playout clock */
  invalid: 'skipped' | 'not-audible' | 'incomplete' | null;
  /** the send time of the frame that carries the first speech sample of the interruption */
  onset: number | null;
  /** first `agent_interrupted` at or after the onset, minus the onset; Infinity when none came */
  interruptedMs: number | null;
  /** last agent frame between the onset and the first user transcript after it, minus the onset (0 when none); Infinity when the agent was never interrupted */
  audioStopMs: number | null;
}

export function bargeFacts(call: RawCall, scn: ScenarioLine): BargeFacts {
  const base = { chain: call.header.chain, callId: call.header.callId, id: scn.id, onset: null, interruptedMs: null, audioStopMs: null };
  const bi = scn.interruption;
  if (!bi) return { ...base, invalid: 'skipped' };
  if (bi.skipped || bi.onsetSentAt === null || bi.onsetSentAt === undefined) return { ...base, invalid: bi.skipped === 'closed' ? 'incomplete' : 'skipped' };
  const onset = bi.onsetSentAt;
  const audio = call.audio.filter((a) => a.t >= scn.begin && a.t < scn.end);
  const heard = audio.filter((a) => a.t >= (scn.ueSentAt ?? scn.begin) && a.t <= onset).map((a) => ({ t: a.t, bytes: a.n }));
  if (!audibleAt(heard, onset, AUDIBLE_SLACK_MS)) return { ...base, onset, invalid: 'not-audible' };
  const events = call.events.filter((e) => e.t >= onset && e.t < scn.end);
  const interrupted = events.find((e) => e.type === 'agent_interrupted') ?? null;
  if (!interrupted && scn.wait === 'closed') return { ...base, onset, invalid: 'incomplete' };
  const transcript = events.find((e) => e.type === 'transcript' && e.role === 'user' && e.t > onset) ?? null;
  const stopWindowEnd = transcript ? transcript.t : scn.end;
  const lastFrame = [...audio].reverse().find((a) => a.t >= onset && a.t < stopWindowEnd) ?? null;
  return {
    ...base,
    onset,
    invalid: null,
    interruptedMs: interrupted ? interrupted.t - onset : Infinity,
    audioStopMs: interrupted ? (lastFrame ? lastFrame.t - onset : 0) : Infinity,
  };
}

export interface FalseBarge {
  callId: string;
  t: number;
  /** the last status before it: what the agent was doing */
  state: string;
}

export interface CallFacts {
  call: RawCall;
  chain: string;
  mode: CallMode;
  set: string;
  /** `ready` arrived */
  started: boolean;
  readyMs: number | null;
  greetingMs: number | null;
  readyMode: string | null;
  trials: TrialFacts[];
  barges: BargeFacts[];
  falseBarges: FalseBarge[];
  /** times the agent began to speak while the student was silent (the denominator of the false barge-in count) */
  silentAgentTurns: number;
}

/** The scripted speech of a call, as send-time intervals, widened by what detection and the network may take. */
function explainedIntervals(call: RawCall): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const scn of call.scenarios) {
    for (const seg of scn.segments) if (seg.beginSentAt !== null && seg.endSentAt !== null) out.push([seg.beginSentAt - EXPLAIN_BEFORE_MS, seg.endSentAt + EXPLAIN_AFTER_MS]);
    const bi = scn.interruption;
    if (bi && bi.onsetSentAt !== null && bi.endSentAt !== null) out.push([(bi.firstSentAt ?? bi.onsetSentAt) - EXPLAIN_BEFORE_MS, bi.endSentAt + EXPLAIN_AFTER_MS]);
  }
  return out;
}

export function callFacts(call: RawCall): CallFacts {
  const startT = call.start ? call.start.t : null;
  const ready = call.events.find((e) => e.type === 'ready') ?? null;
  const firstAudio = call.audio[0] ?? null;
  const trials: TrialFacts[] = [];
  const barges: BargeFacts[] = [];
  const statuses = statusList(call);
  call.scenarios.forEach((scn, i) => {
    trials.push(trialFacts(call, scn, i > 0 ? call.scenarios[i - 1].settled : call.greet ? call.greet.settled : true, statuses));
    if (scn.class === 'bargein') barges.push(bargeFacts(call, scn));
  });
  const explained = explainedIntervals(call);
  const isExplained = (t: number) => explained.some(([lo, hi]) => t >= lo && t <= hi);
  const statusBefore = (seq: number): string => {
    for (let i = call.events.length - 1; i >= 0; i--) if (call.events[i].seq < seq && call.events[i].type === 'status') return str(call.events[i].state);
    return 'none';
  };
  const falseBarges: FalseBarge[] = call.events.filter((e) => e.type === 'agent_interrupted' && !isExplained(e.t)).map((e) => ({ callId: call.header.callId, t: e.t, state: statusBefore(e.seq) }));
  const silentAgentTurns = call.events.filter((e) => e.type === 'status' && e.state === 'speaking' && !isExplained(e.t)).length;
  return {
    call,
    chain: call.header.chain,
    mode: call.header.mode,
    set: call.header.set,
    started: ready !== null,
    readyMs: ready && startT !== null ? ready.t - startT : null,
    greetingMs: firstAudio && startT !== null ? firstAudio.t - startT : null,
    readyMode: ready ? str(ready.mode) : null,
    trials,
    barges,
    falseBarges,
    silentAgentTurns,
  };
}

// ---------------------------------------------------------------- checks

export type Verdict = 'PASS' | 'FAIL' | 'INSUFFICIENT' | 'NO DATA';

export interface Check {
  id: string;
  label: string;
  unit: 'ms' | 'points' | 'count';
  /** the rule in words, as the document states it */
  rule: string;
  /** the values compared: ms, or percent for a rate, or a count; null with no data */
  a: number | null;
  b: number | null;
  /** the value lands on a turn that never got an answer */
  aCensored: boolean;
  bCensored: boolean;
  /** rates: k/n and the Wilson interval */
  aRate: Proportion | null;
  bRate: Proportion | null;
  nA: number;
  nB: number;
  /** the smallest sample per chain the document asks for */
  minimum: number | null;
  /** B minus A (null for the absolute criteria and with no data) */
  diff: number | null;
  /** the tolerance on the difference, or null when the rule is absolute (0 bad outcomes on chain B) */
  tolerance: number | null;
  interval: { lo: number; hi: number; method: string } | null;
  /** the interval of the difference contains zero */
  notDistinguishable: boolean | null;
  verdict: Verdict;
  notes: string[];
}

export interface Criterion {
  id: string;
  title: string;
  verdict: Verdict;
  checks: Check[];
  /** numbers reported without a tolerance */
  info: Array<{ label: string; unit: 'ms' | 'points' | 'count'; a: number | null; b: number | null; nA: number; nB: number; note?: string; aRate?: Proportion | null; bRate?: Proportion | null }>;
}

const finiteOrNull = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : v);

function blank(id: string, label: string, unit: Check['unit'], rule: string, minimum: number | null, nA: number, nB: number): Check {
  return { id, label, unit, rule, a: null, b: null, aCensored: false, bCensored: false, aRate: null, bRate: null, nA, nB, minimum, diff: null, tolerance: null, interval: null, notDistinguishable: null, verdict: 'NO DATA', notes: [] };
}

function thin(check: Check): boolean {
  return check.minimum !== null && (check.nA < check.minimum || check.nB < check.minimum);
}

/** "would pass" becomes INSUFFICIENT on a thin sample; a failure stays a failure and says the sample is thin. */
function settle(check: Check, passes: boolean): void {
  if (!passes) {
    check.verdict = 'FAIL';
    if (thin(check)) check.notes.push('sample below the minimum');
    return;
  }
  if (thin(check)) {
    check.verdict = 'INSUFFICIENT';
    check.notes.push(`sample below the minimum (n ${check.nA} / ${check.nB}, minimum ${check.minimum})`);
    return;
  }
  check.verdict = 'PASS';
}

/** p-th percentile of B must be within `tolerance` ms of A's (B <= A + tolerance). Samples may hold Infinity: a turn that never got an answer. */
export function quantileCheck(o: { id: string; label: string; a: number[]; b: number[]; p: number; tolerance: number; minimum: number; rule: string }): Check {
  const check = blank(o.id, o.label, 'ms', o.rule, o.minimum, o.a.length, o.b.length);
  check.tolerance = o.tolerance;
  if (o.a.length === 0 || o.b.length === 0) {
    check.notes.push('no data in ' + (o.a.length === 0 && o.b.length === 0 ? 'either chain' : o.a.length === 0 ? 'chain A' : 'chain B'));
    return check;
  }
  const pa = pctl(o.a, o.p) as number;
  const pb = pctl(o.b, o.p) as number;
  check.aCensored = pa === Infinity;
  check.bCensored = pb === Infinity;
  check.a = finiteOrNull(pa);
  check.b = finiteOrNull(pb);
  if (check.bCensored) {
    settle(check, false);
    check.notes.push('chain B has turns with no answer at this percentile');
    return check;
  }
  if (check.aCensored) {
    check.verdict = 'INSUFFICIENT';
    check.notes.push('the live baseline has turns with no answer at this percentile (an outage? repeat the session, docs 9.2): no comparison');
    return check;
  }
  check.diff = pb - pa;
  const interval = bootstrapDiff(o.a, o.b, o.p);
  if (interval) {
    check.interval = { lo: interval.lo, hi: interval.hi, method: `bootstrap, ${BOOTSTRAP_REPS} resamples, seed ${BOOTSTRAP_SEED}` };
    check.notDistinguishable = containsZero(interval);
  }
  settle(check, check.diff <= o.tolerance);
  return check;
}

/** B's rate may exceed A's by at most `tolerancePoints` percentage points. Exact integer arithmetic on the edge. */
export function rateCheck(o: { id: string; label: string; kA: number; nA: number; kB: number; nB: number; tolerancePoints: number; minimum: number; rule: string }): Check {
  const check = blank(o.id, o.label, 'points', o.rule, o.minimum, o.nA, o.nB);
  check.tolerance = o.tolerancePoints;
  check.aRate = wilson(o.kA, o.nA);
  check.bRate = wilson(o.kB, o.nB);
  if (!check.aRate || !check.bRate) {
    check.notes.push('no data in ' + (!check.aRate && !check.bRate ? 'either chain' : !check.aRate ? 'chain A' : 'chain B'));
    return check;
  }
  check.a = check.aRate.p * 100;
  check.b = check.bRate.p * 100;
  check.diff = check.b - check.a;
  const iv: DiffInterval | null = newcombe(o.kB, o.nB, o.kA, o.nA);
  if (iv) {
    check.interval = { lo: iv.lo * 100, hi: iv.hi * 100, method: "Newcombe's hybrid score (method 10) from the two Wilson intervals" };
    check.notDistinguishable = containsZero(iv);
  }
  settle(check, rateDiffWithin(o.kB, o.nB, o.kA, o.nA, o.tolerancePoints));
  return check;
}

/** An absolute criterion on chain B: the number of bad outcomes must be zero. A's count is shown for reference. */
export function zeroCheck(o: { id: string; label: string; badA: number; nA: number; badB: number; nB: number; minimum: number; rule: string }): Check {
  const check = blank(o.id, o.label, 'count', o.rule, o.minimum, o.nA, o.nB);
  check.aRate = wilson(o.badA, o.nA);
  check.bRate = wilson(o.badB, o.nB);
  if (!check.bRate) {
    check.notes.push('no data in chain B');
    return check;
  }
  if (!check.aRate) check.notes.push('no data in chain A (its count is only a reference)');
  check.a = check.aRate ? o.badA : null;
  check.b = o.badB;
  settle(check, o.badB === 0);
  return check;
}

function rollUp(checks: Check[]): Verdict {
  if (checks.some((c) => c.verdict === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.verdict === 'INSUFFICIENT' || c.verdict === 'NO DATA')) return 'INSUFFICIENT';
  return 'PASS';
}

// ---------------------------------------------------------------- the criteria

/** What is known of one chain's logs once the superseded and tuning ones are out. */
export interface ChainData {
  label: string;
  calls: CallFacts[];
  trials: TrialFacts[];
  barges: BargeFacts[];
}

const CHAT_CLASSES = new Set<ScenarioClass>(['latency', 'pause', 'short', 'filler']);
const num = (values: Array<number | null>): number[] => values.filter((v): v is number => v !== null);

/** The turn latency of a trial for the percentiles: its value, or Infinity when it never got an answer (never silently dropped). */
const latencyOf = (t: TrialFacts): number => (t.latencyMs === null ? Infinity : t.latencyMs);

function infoRow(label: string, unit: 'ms' | 'points' | 'count', a: number | null, b: number | null, nA: number, nB: number, note?: string): Criterion['info'][number] {
  return { label, unit, a, b, nA, nB, ...(note ? { note } : {}) };
}

/** A rate reported without a tolerance: k/n with its Wilson interval for each chain, and the percent as the number. */
function rateInfo(label: string, kA: number, nA: number, kB: number, nB: number, note?: string): Criterion['info'][number] {
  const ra = wilson(kA, nA);
  const rb = wilson(kB, nB);
  return { label, unit: 'points', a: ra ? ra.p * 100 : null, b: rb ? rb.p * 100 : null, nA, nB, aRate: ra, bRate: rb, ...(note ? { note } : {}) };
}

function c0(a: ChainData, b: ChainData): Criterion {
  const ready = (d: ChainData) => num(d.calls.map((c) => (c.started ? c.readyMs : null)));
  // a call with no greeting audio counts as the wait it was given up after: Infinity, so that a chain that never greets cannot pass
  const greeting = (d: ChainData) => d.calls.filter((c) => c.started).map((c) => (c.greetingMs === null ? Infinity : c.greetingMs));
  const checks = [
    quantileCheck({ id: 'C0.ready.p50', label: 'start to ready, p50', a: ready(a), b: ready(b), p: 0.5, tolerance: TOLERANCE.readyMs, minimum: MINIMUM.calls, rule: 'B p50 <= A p50 + 500 ms' }),
    quantileCheck({ id: 'C0.greeting.p50', label: 'start to first greeting audio, p50', a: greeting(a), b: greeting(b), p: 0.5, tolerance: TOLERANCE.greetingMs, minimum: MINIMUM.calls, rule: 'B p50 <= A p50 + 700 ms' }),
    zeroCheck({
      id: 'C0.starts',
      label: 'calls that failed to start (no ready)',
      badA: a.calls.filter((c) => !c.started).length,
      nA: a.calls.length,
      badB: b.calls.filter((c) => !c.started).length,
      nB: b.calls.length,
      minimum: MINIMUM.calls,
      rule: 'no call of B fails to start',
    }),
  ];
  const info = [
    infoRow('calls without greeting audio', 'count', a.calls.filter((c) => c.started && c.greetingMs === null).length, b.calls.filter((c) => c.started && c.greetingMs === null).length, a.calls.length, b.calls.length, 'counted as a greeting that never came (infinite) in the p50 above'),
  ];
  return { id: 'C0', title: 'Call start', verdict: rollUp(checks), checks, info };
}

function c1(a: ChainData, b: ChainData): Criterion {
  const pool = (d: ChainData, classes: Set<ScenarioClass>, mode: CallMode) => d.trials.filter((t) => !t.incomplete && t.mode === mode && classes.has(t.class) && !t.early);
  const plain = (d: ChainData) => pool(d, new Set<ScenarioClass>(['latency']), 'chat').filter((t) => !t.tool);
  const tool = (d: ChainData) => pool(d, CHAT_CLASSES, 'chat').filter((t) => t.tool);
  const interviewTool = (d: ChainData) => pool(d, new Set<ScenarioClass>(['pause']), 'interview').filter((t) => t.tool);
  const lat = (ts: TrialFacts[]) => ts.map(latencyOf);
  const checks = [
    quantileCheck({ id: 'C1.plain.p50', label: 'plain turns (latency prompts), p50', a: lat(plain(a)), b: lat(plain(b)), p: 0.5, tolerance: TOLERANCE.plainP50Ms, minimum: MINIMUM.plainTurns, rule: 'B p50 <= A p50 + 300 ms' }),
    quantileCheck({ id: 'C1.plain.p90', label: 'plain turns (latency prompts), p90', a: lat(plain(a)), b: lat(plain(b)), p: 0.9, tolerance: TOLERANCE.plainP90Ms, minimum: MINIMUM.plainTurns, rule: 'B p90 <= A p90 + 600 ms' }),
    quantileCheck({ id: 'C1.tool.p50', label: 'tool turns (conversation), p50', a: lat(tool(a)), b: lat(tool(b)), p: 0.5, tolerance: TOLERANCE.toolP50Ms, minimum: MINIMUM.toolTurns, rule: 'B p50 <= A p50 + 300 ms' }),
    quantileCheck({ id: 'C1.interviewTool.p50', label: 'interview answers that start a look-up, p50', a: lat(interviewTool(a)), b: lat(interviewTool(b)), p: 0.5, tolerance: TOLERANCE.toolP50Ms, minimum: MINIMUM.interviewToolTurns, rule: 'B p50 <= A p50 + 300 ms' }),
  ];
  const info: Criterion['info'] = [];
  const addQ = (label: string, fa: number[], fb: number[], p: number) => info.push(infoRow(label, 'ms', finiteOrNull(pctl(fa, p)), finiteOrNull(pctl(fb, p)), fa.length, fb.length));
  const eot = (d: ChainData, classes: Set<ScenarioClass>, mode: CallMode) => num(d.trials.filter((t) => !t.incomplete && t.mode === mode && classes.has(t.class)).map((t) => t.eotMs));
  addQ('end-of-turn latency (transcript after UE), chat turns, p50', eot(a, CHAT_CLASSES, 'chat'), eot(b, CHAT_CLASSES, 'chat'), 0.5);
  addQ('end-of-turn latency (transcript after UE), chat turns, p90', eot(a, CHAT_CLASSES, 'chat'), eot(b, CHAT_CLASSES, 'chat'), 0.9);
  const plainAll = (d: ChainData) => pool(d, CHAT_CLASSES, 'chat').filter((t) => !t.tool);
  addQ('plain turns of all conversation scenarios (latency, pause, short, filler), p50', lat(plainAll(a)), lat(plainAll(b)), 0.5);
  addQ('plain turns of all conversation scenarios (latency, pause, short, filler), p90', lat(plainAll(a)), lat(plainAll(b)), 0.9);
  const unanswered = (d: ChainData) => d.trials.filter((t) => !t.incomplete && !t.early && t.mode === 'chat' && CHAT_CLASSES.has(t.class) && !t.answered).length;
  info.push(infoRow('turns with no answer within the cap (an infinite latency above)', 'count', unanswered(a), unanswered(b), a.trials.length, b.trials.length));
  const earlyLatency = (d: ChainData) => d.trials.filter((t) => !t.incomplete && t.mode === 'chat' && t.class === 'latency' && t.early).length;
  info.push(infoRow('latency prompts answered before UE + 300 ms (left out of the latency; no turn latency is defined for them)', 'count', earlyLatency(a), earlyLatency(b), a.trials.length, b.trials.length));
  info.push(infoRow('parts of the latency (recognizer final, first token, first sentence, TTS first byte)', 'count', null, null, 0, 0, 'server-side: in the lab trace (turns.jsonl), not visible to a client'));
  return { id: 'C1', title: 'End of speech to first audio', verdict: rollUp(checks), checks, info };
}

function c2(a: ChainData, b: ChainData): Criterion {
  const pool = (d: ChainData, classes: ScenarioClass[]) => d.trials.filter((t) => !t.incomplete && t.mode === 'chat' && classes.includes(t.class));
  const cut = (d: ChainData) => pool(d, ['pause', 'filler']);
  const all = (d: ChainData) => pool(d, ['pause', 'short', 'filler']);
  const short = (d: ChainData) => pool(d, ['short']);
  const checks = [
    rateCheck({
      id: 'C2.cutin',
      label: 'cut-in rate (pause and filler scenarios)',
      kA: cut(a).filter((t) => t.cutIn).length,
      nA: cut(a).length,
      kB: cut(b).filter((t) => t.cutIn).length,
      nB: cut(b).length,
      tolerancePoints: TOLERANCE.cutInPoints,
      minimum: MINIMUM.cutInTrials,
      rule: 'B <= A + 10 points; a cut-in is an agent audio frame before UE + 300 ms (the greeting, a filler and a run that began before the scenario do not count)',
    }),
    rateCheck({
      id: 'C2.toolong',
      label: 'too-long wait (end-of-turn latency > 3.0 s; pause, short, filler)',
      kA: all(a).filter((t) => t.tooLong).length,
      nA: all(a).length,
      kB: all(b).filter((t) => t.tooLong).length,
      nB: all(b).length,
      tolerancePoints: TOLERANCE.tooLongPoints,
      minimum: MINIMUM.tooLongTrials,
      rule: 'B <= A + 5 points; end-of-turn latency over 3.0 s, or no end-of-turn line at all (a scenario with no user line at or after UE was never committed: the wait has no end, amendment A4)',
    }),
    zeroCheck({
      id: 'C2.short',
      label: 'short answers not committed (no user line at or after UE)',
      badA: short(a).filter((t) => !t.committed).length,
      nA: short(a).length,
      badB: short(b).filter((t) => !t.committed).length,
      nB: short(b).length,
      minimum: MINIMUM.shortTrials,
      rule: 'every short answer of B is committed: a user line arrives at or after UE',
    }),
  ];
  const splitNote = "more than one user transcript for the scenario: the student's words are in two lines of the chat, and TAi answered once, or twice (the lab commits early and takes the commit back before any audio when the student goes on); not pass/fail";
  const info: Criterion['info'] = [
    rateInfo('split lines, pause and filler scenarios', cut(a).filter((t) => t.split).length, cut(a).length, cut(b).filter((t) => t.split).length, cut(b).length, splitNote),
    rateInfo('not committed: no user line at or after UE (pause, short, filler)', all(a).filter((t) => !t.committed).length, all(a).length, all(b).filter((t) => !t.committed).length, all(b).length, 'no end-of-turn latency: counted as a too-long wait above (amendment A4); for the short scenarios it is also the check above'),
    infoRow('short answers with no agent answer at all (reference)', 'count', short(a).filter((t) => !t.answered).length, short(b).filter((t) => !t.answered).length, short(a).length, short(b).length),
    infoRow('trials of pause, short, filler (n per chain; the document asks for 90)', 'count', all(a).length, all(b).length, all(a).length, all(b).length),
    infoRow("trials where agent audio began before the student's first word (counted as cut-ins above)", 'count', all(a).filter((t) => t.stray).length, all(b).filter((t) => t.stray).length, all(a).length, all(b).length),
    infoRow('trials that began before the previous one reached quiet (a late answer may sit in them)', 'count', all(a).filter((t) => t.afterUnsettled).length, all(b).filter((t) => t.afterUnsettled).length, all(a).length, all(b).length),
  ];
  return { id: 'C2', title: 'Turn-taking, conversation', verdict: rollUp(checks), checks, info };
}

function c3(a: ChainData, b: ChainData): Criterion {
  const valid = (d: ChainData) => d.barges.filter((x) => x.invalid === null);
  const interrupted = (d: ChainData) => valid(d).map((x) => x.interruptedMs as number);
  const stop = (d: ChainData) => valid(d).map((x) => x.audioStopMs as number);
  const falseOf = (d: ChainData) => d.calls.reduce((s, c) => s + c.falseBarges.length, 0);
  const turnsOf = (d: ChainData) => d.calls.reduce((s, c) => s + c.silentAgentTurns, 0);
  const checks = [
    quantileCheck({ id: 'C3.interrupted.p50', label: 'agent_interrupted after the onset, p50', a: interrupted(a), b: interrupted(b), p: 0.5, tolerance: TOLERANCE.interruptedP50Ms, minimum: MINIMUM.interruptions, rule: 'B p50 <= A p50 + 100 ms' }),
    quantileCheck({ id: 'C3.interrupted.p90', label: 'agent_interrupted after the onset, p90', a: interrupted(a), b: interrupted(b), p: 0.9, tolerance: TOLERANCE.interruptedP90Ms, minimum: MINIMUM.interruptions, rule: 'B p90 <= A p90 + 200 ms' }),
    quantileCheck({ id: 'C3.audioStop.p90', label: 'last agent audio frame after the onset, p90', a: stop(a), b: stop(b), p: 0.9, tolerance: TOLERANCE.audioStopP90Ms, minimum: MINIMUM.interruptions, rule: 'B p90 <= A p90 + 300 ms' }),
    zeroCheck({
      id: 'C3.falseBarge',
      label: 'false barge-ins (agent_interrupted that no scripted speech explains), per agent turn with a silent student',
      badA: falseOf(a),
      nA: turnsOf(a),
      badB: falseOf(b),
      nB: turnsOf(b),
      minimum: MINIMUM.agentTurns,
      rule: '0 in at least 40 agent turns (chain B)',
    }),
  ];
  const countOf = (d: ChainData, why: BargeFacts['invalid']) => d.barges.filter((x) => x.invalid === why).length;
  const notStopped = (d: ChainData) => valid(d).filter((x) => x.interruptedMs === Infinity).length;
  const info: Criterion['info'] = [
    infoRow('scripted interruptions (n per chain; the document asks for 24)', 'count', a.barges.length, b.barges.length, a.barges.length, b.barges.length),
    infoRow('valid barge-ins measured (the agent was audible at the onset)', 'count', valid(a).length, valid(b).length, a.barges.length, b.barges.length),
    infoRow('interruptions never said (no answer audio, or the agent was never audible at a planned moment)', 'count', countOf(a, 'skipped'), countOf(b, 'skipped'), a.barges.length, b.barges.length),
    infoRow('interruptions over an agent that was not audible at the onset (not a barge-in; left out)', 'count', countOf(a, 'not-audible'), countOf(b, 'not-audible'), a.barges.length, b.barges.length),
    infoRow('barge-ins after which the agent was never interrupted (an infinite stop time above)', 'count', notStopped(a), notStopped(b), valid(a).length, valid(b).length),
  ];
  const states = (d: ChainData) => {
    const m = new Map<string, number>();
    for (const c of d.calls) for (const f of c.falseBarges) m.set(f.state, (m.get(f.state) ?? 0) + 1);
    return [...m.entries()].map(([s, n]) => `${s}: ${n}`).join(', ');
  };
  const sa = states(a);
  const sb = states(b);
  if (sa || sb) info.push(infoRow('false barge-ins by the agent status at the time', 'count', null, null, 0, 0, `A: ${sa || 'none'}; B: ${sb || 'none'}`));
  info.push(infoRow('the assistant message of the next request holds only what was spoken', 'count', null, null, 0, 0, 'checked in the server trace (turns.jsonl), not by this client'));
  return { id: 'C3', title: 'Barge-in', verdict: rollUp(checks), checks, info };
}

function c10(a: ChainData, b: ChainData): Criterion {
  const modeTrials = (d: ChainData, mode: CallMode) => d.trials.filter((t) => !t.incomplete && t.mode === mode && t.class === 'pause');
  const expected: Record<CallMode, string> = { chat: 'conversational', interview: 'interviewer', talk: 'listener' };
  const modeCalls = (d: ChainData) => d.calls.filter((c) => c.started && c.mode !== 'chat');
  const wrongMode = (d: ChainData) => modeCalls(d).filter((c) => c.readyMode !== expected[c.mode]).length;
  const rate = (mode: CallMode, minimum: number, label: string) =>
    rateCheck({
      id: `C10.${mode}.cutin`,
      label,
      kA: modeTrials(a, mode).filter((t) => t.cutIn).length,
      nA: modeTrials(a, mode).length,
      kB: modeTrials(b, mode).filter((t) => t.cutIn).length,
      nB: modeTrials(b, mode).length,
      tolerancePoints: TOLERANCE.modeCutInPoints,
      minimum,
      rule: 'B <= A + 10 points',
    });
  const checks = [
    rate('interview', MINIMUM.interviewTrials, 'cut-in rate, interview pause scenarios'),
    rate('talk', MINIMUM.talkTrials, 'cut-in rate, talk-through pause scenarios'),
    zeroCheck({ id: 'C10.mode', label: 'calls whose ready did not report the mode asked for', badA: wrongMode(a), nA: modeCalls(a).length, badB: wrongMode(b), nB: modeCalls(b).length, minimum: 1, rule: 'every interview and talk call of B reports its mode' }),
  ];
  const splitRow = (mode: CallMode, label: string) =>
    rateInfo(label, modeTrials(a, mode).filter((t) => t.split).length, modeTrials(a, mode).length, modeTrials(b, mode).filter((t) => t.split).length, modeTrials(b, mode).length, "more than one user transcript for the scenario: the student's words are in two lines of the chat, and TAi answered once, or twice; not pass/fail");
  const info: Criterion['info'] = [
    splitRow('interview', 'split lines, interview pause scenarios'),
    splitRow('talk', 'split lines, talk-through pause scenarios'),
    infoRow('the hold-off follows the mode switch (UpdateThink / UpdateSpeak / UpdateListen)', 'count', null, null, 0, 0, 'the client sees only the mode in ready and the cut-in rates above; the switch itself is in the server trace'),
  ];
  return { id: 'C10', title: 'Interview and talk-through turn-taking', verdict: rollUp(checks), checks, info };
}

// ---------------------------------------------------------------- the report

export interface Pacing {
  frames: number;
  /** milliseconds a frame was sent after its due time */
  p50: number | null;
  p99: number | null;
  max: number | null;
}

export interface ChainSummary {
  label: string;
  calls: number;
  byMode: Record<CallMode, number>;
  bySet: Record<string, number>;
  scenarios: number;
  incompleteScenarios: number;
  truncatedLogs: number;
  firstWall: string | null;
  lastWall: string | null;
  pacing: Pacing;
}

export interface Report {
  generated: string;
  /** the tuning logs were analysed (and nothing else): not a criterion result */
  tuningOnly: boolean;
  a: ChainSummary;
  b: ChainSummary;
  testset: { fingerprints: string[]; frozen: boolean };
  /** raw logs left out: repeated after a socket error, or of the other kind of set */
  excluded: { superseded: string[]; otherSets: number };
  interleaving: { calls: number; spanMinutes: number | null; longestRun: number; alternations: number };
  warnings: string[];
  criteria: Criterion[];
  definitions: string[];
  verdict: Verdict;
}

function pacingOf(calls: RawCall[]): Pacing {
  const late: number[] = [];
  for (const c of calls) {
    if (!c.mic) continue;
    for (const f of c.frames) {
      for (let j = 0; j < f.t.length; j++) if (typeof f.t[j] === 'number') late.push(f.t[j] - (c.mic.t + (f.i + j) * c.mic.frameMs));
    }
  }
  return { frames: late.length, p50: pctl(late, 0.5), p99: pctl(late, 0.99), max: late.length ? Math.max(...late) : null };
}

function summarize(label: string, calls: CallFacts[], raw: RawCall[]): ChainSummary {
  const byMode: Record<CallMode, number> = { chat: 0, interview: 0, talk: 0 };
  const bySet: Record<string, number> = {};
  for (const c of calls) {
    byMode[c.mode] = (byMode[c.mode] ?? 0) + 1;
    bySet[c.set] = (bySet[c.set] ?? 0) + 1;
  }
  const walls = raw.map((c) => c.header.wall).sort();
  return {
    label,
    calls: calls.length,
    byMode,
    bySet,
    scenarios: calls.reduce((s, c) => s + c.trials.length, 0),
    incompleteScenarios: calls.reduce((s, c) => s + c.trials.filter((t) => t.incomplete).length, 0),
    truncatedLogs: raw.filter((c) => c.truncated).length,
    firstWall: walls[0] ?? null,
    lastWall: walls[walls.length - 1] ?? null,
    pacing: pacingOf(raw),
  };
}

const labelOf = (calls: RawCall[], fallback: string): string => [...new Set(calls.map((c) => c.header.chain))].join(', ') || fallback;

export interface AnalyzeOptions {
  /** analyse the tuning logs (and only them) instead of the evaluation ones */
  tuning?: boolean;
  now?: () => Date;
}

export const DEFINITIONS: string[] = [
  'Times are milliseconds on the client\'s one monotonic clock; a difference is B (the lab) minus A (live). UE is the send time of the frame that carries the last speech sample of the last segment (exact to one frame); a frame is sent when it is due, 40 ms apart.',
  'Call start is the moment `start` was sent (the socket\'s connect time is not in it; it is in the log). Greeting audio is the first binary frame of the call. A call that never got greeting audio counts as an infinite greeting time in the p50.',
  'Turn latency is the first agent audio frame at or after UE minus UE. A turn is a tool turn when a `status working` arrived between UE and that frame, a plain turn otherwise. A turn whose answer never came counts as an infinite latency in its class (it is never dropped); a latency prompt answered before UE + 300 ms has no turn latency and is counted apart.',
  'The plain-turn criterion uses the 10 latency prompts only (the document\'s 30 turns). Tool turns are all conversation turns (latency, pause, short, filler) that started a look-up. "Interview answers with evaluate_answer" cannot be seen from a client (the browser protocol carries no function names): the proxy is a tool turn in a call started in interview mode.',
  'End-of-turn (EOT) latency (amendment A1) is the arrival of the first `transcript` event with role user AT OR AFTER UE, minus UE: a line that arrived before UE belongs to a fragment. A scenario with no such line has no EOT latency and counts as not committed: it is reported (and warned about), it counts as a too-long wait (amendment A4: the page never learned that the turn ended), and for the short scenarios C2 also requires a line in every trial.',
  'Cut-in (amendment A1; pause and filler scenarios, and the interview and talk-through ones): an agent audio frame that arrives before UE + 300 ms, UE being the end of the last segment. Not counted: the greeting, a filler the session injects while a function runs (a run of speech that follows a `working` status), and any run of speech that began before the scenario did (a late answer). More than one user turn is no longer a cut-in: those scenarios are reported as split lines (k/n, with the cut-in rates, never pass/fail): the lab may commit early and take the commit back before any audio when the student goes on. The window of a scenario runs from its first frame to the moment the next one begins (after the answer and 1.5 s of quiet).',
  'Barge-in: the onset is the send time of the frame that carries the first speech sample of the interruption. The stop time is the first `agent_interrupted` at or after it; the audio stop is the last agent frame between the onset and the first user transcript after it (0 when none): later frames answer the interruption. No `agent_interrupted` is an infinite stop time. An interruption over an agent that was not audible at the onset (playout clock: audio received so far, played back to back; audio that ended less than 150 ms earlier still counts) is not a barge-in and is counted apart.',
  '`agent_interrupted` is sent by the hub on EVERY user speech onset, not only on a barge-in. A false barge-in is therefore one that no scripted speech explains: it arrives outside every scripted utterance (from 100 ms before its first frame to 1 s after its last). The agent turns it is counted against are the times the agent began to speak outside scripted speech (the greeting included).',
  'Percentiles are the value at index floor((n-1)p) of the sorted sample. The interval of a difference of rates is Newcombe\'s hybrid score from the two Wilson 95 % intervals; of a difference of percentiles a seeded percentile bootstrap (2000 resamples). "Not distinguishable at this n" means that interval contains zero.',
  'Calls repeated after a client socket error: the failed attempt\'s raw log is kept but not counted (the repeat is). Scenarios cut off by the server (budget, timeout) are listed as incomplete and not counted. The tuning set is never part of a criterion.',
];

export function analyzeLogs(rawA: RawCall[], rawB: RawCall[], options: AnalyzeOptions = {}): Report {
  const all = [...rawA, ...rawB];
  const superseded = new Set(all.map((c) => c.header.retryOf).filter((id): id is string => !!id));
  const wanted = (c: RawCall) => !superseded.has(c.header.callId) && (c.header.set === 'tuning') === !!options.tuning;
  const usable = (calls: RawCall[]) => calls.filter(wanted);
  const supersededIds = all.filter((c) => superseded.has(c.header.callId)).map((c) => c.header.callId);
  const otherSets = all.filter((c) => !superseded.has(c.header.callId) && (c.header.set === 'tuning') !== !!options.tuning).length;
  const ua = usable(rawA);
  const ub = usable(rawB);
  const factsA = ua.map(callFacts);
  const factsB = ub.map(callFacts);
  const dataOf = (label: string, facts: CallFacts[]): ChainData => ({ label, calls: facts, trials: facts.flatMap((f) => f.trials), barges: facts.flatMap((f) => f.barges) });
  const labelA = labelOf(rawA, 'A');
  const labelB = labelOf(rawB, 'B');
  const a = dataOf(labelA, factsA);
  const b = dataOf(labelB, factsB);
  const criteria = [c0(a, b), c1(a, b), c2(a, b), c3(a, b), c10(a, b)];
  const warnings: string[] = [];

  const prints = [...new Set(all.map((c) => c.header.testset?.sha256).filter((s): s is string => !!s))];
  const frozen = prints.length === 1 && prints[0] === FROZEN_SHA256;
  if (prints.length === 0) warnings.push('no raw log carries a test-set fingerprint: it cannot be said that the frozen test set was used');
  else if (!frozen) warnings.push(`the test set of these logs is NOT the frozen one of docs 9.7 (sha256 ${prints.map((p) => p.slice(0, 12)).join(', ')}, frozen ${FROZEN_SHA256.slice(0, 12)}): do not read this as a criterion result`);
  if (options.tuning) warnings.push('TUNING LOGS ONLY: these numbers tune the end-of-turn and barge-in parameters and are not a criterion result');
  if (ua.length === 0) warnings.push('chain A (live) has no usable call: nothing can be compared');
  if (ub.length === 0) warnings.push('chain B (lab) has no usable call: nothing can be compared');
  const labelsOverlap = labelA === labelB && ua.length + ub.length > 0;
  if (labelsOverlap) warnings.push(`both directories hold chain "${labelA}": check that --a and --b point at different chains`);
  if (supersededIds.length) warnings.push(`${supersededIds.length} call(s) were repeated after a client socket error: their raw logs are kept but not counted (${supersededIds.join(', ')})`);
  const sumA = summarize(labelA, factsA, ua);
  const sumB = summarize(labelB, factsB, ub);
  for (const s of [sumA, sumB]) {
    if (s.incompleteScenarios) warnings.push(`chain ${s.label}: ${s.incompleteScenarios} scenario(s) were cut off by the server (budget, timeout) and are not counted`);
    if (s.truncatedLogs) warnings.push(`chain ${s.label}: ${s.truncatedLogs} raw log(s) end in a cut line (the process died while writing)`);
    if (s.pacing.frames && ((s.pacing.p99 ?? 0) > 10 || (s.pacing.max ?? 0) > 50)) warnings.push(`chain ${s.label}: the client sent microphone frames late (p99 ${(s.pacing.p99 ?? 0).toFixed(1)} ms, max ${(s.pacing.max ?? 0).toFixed(1)} ms): the host was busy; the numbers may be off`);
  }
  for (const [label, facts] of [
    [labelA, factsA],
    [labelB, factsB],
  ] as const) {
    const trials = facts.flatMap((f) => f.trials).filter((t) => !t.incomplete);
    const uncommitted = trials.filter((t) => !t.committed).length;
    if (uncommitted) warnings.push(`chain ${label}: ${uncommitted} of ${trials.length} scenario(s) were not committed (no user line at or after UE): counted as too-long waits, and a failure of C2.short for the short answers`);
  }
  const unsettled = [...factsA, ...factsB].reduce((s, f) => s + f.trials.filter((t) => t.afterUnsettled).length, 0);
  if (unsettled) warnings.push(`${unsettled} scenario(s) began before the previous one reached quiet: a late answer may sit in their window`);
  const censored = criteria.flatMap((c) => c.checks).filter((c) => c.aCensored);
  if (censored.length) warnings.push('the live baseline (chain A) has turns with no answer: that looks like an outage; repeat the session (docs 9.2)');

  // interleaving: calls should alternate A, B, A, B ... in one window of at most two hours
  const timeline = [
    ...ua.map((c) => ({ wall: Date.parse(c.header.wall), chain: 'A' })),
    ...ub.map((c) => ({ wall: Date.parse(c.header.wall), chain: 'B' })),
  ].sort((x, y) => x.wall - y.wall);
  let longestRun = 0;
  let run = 0;
  let alternations = 0;
  timeline.forEach((e, i) => {
    if (i > 0 && timeline[i - 1].chain === e.chain) run++;
    else {
      run = 1;
      if (i > 0) alternations++;
    }
    longestRun = Math.max(longestRun, run);
  });
  const spanMinutes = timeline.length > 1 ? (timeline[timeline.length - 1].wall - timeline[0].wall) / 60000 : timeline.length === 1 ? 0 : null;
  if (spanMinutes !== null && spanMinutes > 120) warnings.push(`the calls span ${spanMinutes.toFixed(0)} minutes: the document asks for one session of at most two hours`);
  if (ua.length && ub.length && longestRun > 2) warnings.push(`the calls are not interleaved: up to ${longestRun} in a row came from one chain (the document asks A, B, A, B ...)`);

  const verdict = rollUp(criteria.flatMap((c) => c.checks));
  return {
    generated: (options.now ? options.now() : new Date()).toISOString(),
    tuningOnly: !!options.tuning,
    a: sumA,
    b: sumB,
    testset: { fingerprints: prints, frozen },
    excluded: { superseded: supersededIds, otherSets },
    interleaving: { calls: timeline.length, spanMinutes, longestRun, alternations },
    warnings,
    criteria,
    definitions: DEFINITIONS,
    verdict,
  };
}

export function analyzeDirs(dirA: string, dirB: string, options: AnalyzeOptions = {}): Report {
  return analyzeLogs(readRawLogs(dirA), readRawLogs(dirB), options);
}

// ---------------------------------------------------------------- the Markdown report

const sign = (v: number, digits = 0): string => (v >= 0 ? '+' : '') + v.toFixed(digits);

function cell(check: Check, side: 'a' | 'b'): string {
  const value = check[side];
  const censored = side === 'a' ? check.aCensored : check.bCensored;
  const rate = side === 'a' ? check.aRate : check.bRate;
  if (censored) return 'no answer';
  if (check.unit === 'ms') return value === null ? '-' : `${Math.round(value)} ms`;
  if (rate) return `${rate.k}/${rate.n} = ${(rate.p * 100).toFixed(1)} % [${(rate.lo * 100).toFixed(1)}, ${(rate.hi * 100).toFixed(1)}]`;
  return '-';
}

function verdictCell(check: Check): string {
  const flags: string[] = [];
  if (check.notDistinguishable) flags.push('not distinguishable at this n');
  return check.verdict + (flags.length ? ` (${flags.join('; ')})` : '');
}

function diffCell(check: Check): string {
  if (check.diff === null) return '-';
  if (check.unit === 'ms') return `${sign(check.diff)} ms`;
  return `${sign(check.diff, 1)} points`;
}

function toleranceCell(check: Check): string {
  if (check.tolerance === null) return check.unit === 'count' ? '0 on B' : '-';
  return check.unit === 'ms' ? `<= ${sign(check.tolerance)} ms` : `<= ${sign(check.tolerance)} points`;
}

function intervalCell(check: Check): string {
  if (!check.interval) return '-';
  const unit = check.unit === 'ms' ? 'ms' : 'points';
  const d = check.unit === 'ms' ? 0 : 1;
  return `[${sign(check.interval.lo, d)}, ${sign(check.interval.hi, d)}] ${unit} (${check.interval.method.split(',')[0].split(' (')[0]})`;
}

function sampleCell(check: Check): string {
  const min = check.minimum;
  const short = min !== null && (check.nA < min || check.nB < min);
  return `${check.nA} / ${check.nB}${min !== null ? ` (min ${min}${short ? ': NOT MET' : ''})` : ''}`;
}

/** The report as Markdown: the verdict table, the warnings, one table per criterion with both chains' numbers, the difference, the tolerance, the interval and the sample against its minimum. */
export function renderReport(r: Report): string {
  const out: string[] = [];
  out.push(`# Voice lab: measurement report${r.tuningOnly ? ' (TUNING LOGS ONLY)' : ''}`);
  out.push('');
  out.push(`Generated ${r.generated}. Chain A = ${r.a.label} (today's call, "live"), chain B = ${r.b.label} (the lab). A difference is B minus A. Criteria of docs/VOICE_SELFBUILT.md 9.4 that a client can measure: C0, C1, C2, C3, C10 (C4 to C9 and C11 are measured elsewhere; the verdict of 9.6 also needs the owner's real calls).`);
  out.push('');
  out.push(`Test set: ${r.testset.fingerprints.length ? r.testset.fingerprints.map((p) => p.slice(0, 16)).join(', ') : 'unknown'} (${r.testset.frozen ? 'the frozen one of 9.7' : 'NOT the frozen one'}).`);
  out.push('');
  for (const s of [r.a, r.b]) {
    const modes = (['chat', 'interview', 'talk'] as const).filter((m) => s.byMode[m]).map((m) => `${s.byMode[m]} ${m}`).join(', ');
    const sets = Object.entries(s.bySet).map(([k, v]) => `${k} ${v}`).join(', ');
    out.push(`- Chain ${s.label}: ${s.calls} call(s) (${modes || 'none'}; sets: ${sets || 'none'}), ${s.scenarios} scenarios${s.incompleteScenarios ? ` (${s.incompleteScenarios} incomplete)` : ''}; first call ${s.firstWall ?? '-'}, last ${s.lastWall ?? '-'}; client pacing over ${s.pacing.frames} frames: p50 ${s.pacing.p50 === null ? '-' : s.pacing.p50.toFixed(1)} ms late, p99 ${s.pacing.p99 === null ? '-' : s.pacing.p99.toFixed(1)}, max ${s.pacing.max === null ? '-' : s.pacing.max.toFixed(1)}`);
  }
  if (r.excluded.otherSets) out.push(`- Left out: ${r.excluded.otherSets} call(s) of the ${r.tuningOnly ? 'evaluation' : 'tuning'} sets.`);
  out.push(`- Interleaving: ${r.interleaving.calls} call(s), ${r.interleaving.alternations} alternations, longest run of one chain ${r.interleaving.longestRun}, span ${r.interleaving.spanMinutes === null ? '-' : r.interleaving.spanMinutes.toFixed(0)} min.`);
  out.push('');
  out.push('## Verdicts');
  out.push('');
  out.push('| Criterion | Verdict |');
  out.push('|---|---|');
  for (const c of r.criteria) out.push(`| ${c.id} ${c.title} | ${c.verdict} |`);
  out.push('');
  out.push('PASS: within the documented tolerance on a sample that meets the document\'s minimum. FAIL: outside it. INSUFFICIENT: it would pass, but a sample is below the minimum (or the live baseline is unusable): not a pass. NO DATA: a chain has none.');
  if (r.warnings.length) {
    out.push('');
    out.push('## Warnings');
    out.push('');
    for (const w of r.warnings) out.push(`- ${w}`);
  }
  for (const c of r.criteria) {
    out.push('');
    out.push(`## ${c.id}: ${c.title} (${c.verdict})`);
    out.push('');
    out.push('| Check | A | B | B - A | Tolerance | 95 % interval of B - A | n A / n B | Verdict |');
    out.push('|---|---|---|---|---|---|---|---|');
    for (const k of c.checks) out.push(`| ${k.label} (${k.rule}) | ${cell(k, 'a')} | ${cell(k, 'b')} | ${diffCell(k)} | ${toleranceCell(k)} | ${intervalCell(k)} | ${sampleCell(k)} | ${verdictCell(k)} |`);
    const notes = c.checks.filter((k) => k.notes.length);
    if (notes.length) {
      out.push('');
      for (const k of notes) out.push(`- ${k.label}: ${k.notes.join('; ')}`);
    }
    if (c.info.length) {
      out.push('');
      out.push('Reported without a tolerance:');
      out.push('');
      out.push('| What | A | B | n A / n B | Note |');
      out.push('|---|---|---|---|---|');
      for (const i of c.info) {
        const rateText = (p: Proportion | null | undefined) => (p ? `${p.k}/${p.n} = ${(p.p * 100).toFixed(1)} % [${(p.lo * 100).toFixed(1)}, ${(p.hi * 100).toFixed(1)}]` : '-');
        const fmt = (v: number | null) => (v === null ? '-' : i.unit === 'ms' ? `${Math.round(v)} ms` : String(v));
        const isRate = i.aRate !== undefined || i.bRate !== undefined;
        out.push(`| ${i.label} | ${isRate ? rateText(i.aRate) : fmt(i.a)} | ${isRate ? rateText(i.bRate) : fmt(i.b)} | ${i.nA} / ${i.nB} | ${i.note ?? ''} |`);
      }
    }
  }
  out.push('');
  out.push('## Definitions used');
  out.push('');
  for (const d of r.definitions) out.push(`- ${d}`);
  out.push('');
  return out.join('\n');
}
