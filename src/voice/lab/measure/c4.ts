/**
 * C4, the agent's filler phrases (docs/VOICE_SELFBUILT.md 9.4, amendment A12), read from what a `tools` session left behind. Two sources, and what each can say:
 *
 * - **the measuring client's raw logs** (every chain, live included): a `status working` event starts a tool turn; the audio that follows it in a run that came right after `working` is a
 *   filler (`runOf` of analyze.ts, as round 1 told fillers from answers). The client does not see the injection, but the session injects at a known time after the function started
 *   (`fillerAfterMs`, 1.5 s, for the look-ups that run long; at once for the immediate kinds: "reading", the tool host's start-up), so the client reads **how long after the moment the
 *   filler was due its first audio arrived** (the path from the injection to the student's ear, whatever the chain does with it), and whether a filler came at all.
 * - **the lab's own trace** (`data/voice-lab/turns.jsonl`, chains d, h, fd, c): per turn the exact injection and first-audio times of each filler (`fillers[]`) and the start and answer of each
 *   function (`functions[]`), so the criterion itself is read here: first audio at most 300 ms after the injection (p90), a filler in a turn whose function ran 2 s or more and none in
 *   one that answered within 1.2 s, and the second line ("still looking") when a function ran longer than 7 s.
 *
 *   node dist/voice/lab/measure/c4.js client --dir <raw logs of one chain>      (prints the client's view of that chain's tool turns)
 *   node dist/voice/lab/measure/c4.js trace --file <turns.jsonl> --from <iso> --to <iso>      (prints the lab's own view, per chain)
 *
 * Prints times and counts only; no words.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { readRawLogs, runOf, statusList, type RawCall } from './analyze.js';

/** The session's timing (src/voice/session.ts DEFAULT_TIMING): when a look-up that runs long gets its line, and how long after that the second one. */
export const FILLER_AFTER_MS = 1500;
export const STILL_LOOKING_MS = 5000;
/** A filler whose first frame came within this long of `working` was an immediate one ("reading", the tool host's start-up). */
const IMMEDIATE_MS = 1000;
/** C4's tolerance, and the lengths that make a function long or quick (9.4, A12). */
export const FILLER_AUDIO_MS = 300;
export const LONG_FUNCTION_MS = 2000;
export const QUICK_FUNCTION_MS = 1200;
export const VERY_LONG_FUNCTION_MS = 7000;

export type FillerKind = 'immediate' | 'timed' | 'still';

export interface ClientFiller {
  kind: FillerKind;
  /** the first frame of the filler's audio, ms from the call's start */
  at: number;
  /** For `timed`: first audio minus (working + 1500). For `immediate`: first audio minus working. For `still`: minus (the first filler's first audio + 5000). Negative: earlier than due. */
  lateMs: number;
}

export interface ClientToolTurn {
  callId: string;
  chain: string;
  id: string;
  /** the `working` status, ms from the call's start */
  workingAt: number;
  /** from `working` to the first frame of the answer (a run that is not a filler), null when none came */
  waitMs: number | null;
  fillers: ClientFiller[];
}

/** The tool turns of one raw log: the scenarios in which the agent went to `working`. */
export function clientToolTurns(call: RawCall): ClientToolTurn[] {
  const statuses = statusList(call);
  const out: ClientToolTurn[] = [];
  for (const scn of call.scenarios) {
    if (scn.ueSentAt === null || scn.ueSentAt === undefined) continue;
    const from = scn.ueSentAt;
    const to = scn.end;
    const working = statuses.find((s) => s.state === 'working' && s.t >= from && s.t <= to);
    if (!working) continue;
    // the runs of speech after the end of speech, in order
    const runs: Array<{ startedAt: number; filler: boolean; firstFrame: number }> = [];
    for (const frame of call.audio) {
      if (frame.t < from || frame.t > to) continue;
      const run = runOf(statuses, frame);
      if (runs.length && runs[runs.length - 1].startedAt === run.startedAt) continue;
      runs.push({ startedAt: run.startedAt, filler: run.filler, firstFrame: frame.t });
    }
    // a turn gets one filler at the most from the immediate kinds or the timer (session.ts: once to a student turn), and after a timed one a second line ("still looking")
    const fillers: ClientFiller[] = [];
    let first: number | null = null;
    for (const run of runs) {
      if (!run.filler || run.firstFrame < working.t) continue;
      const sinceWorking = run.firstFrame - working.t;
      if (first === null) {
        fillers.push(sinceWorking < IMMEDIATE_MS ? { kind: 'immediate', at: run.firstFrame, lateMs: sinceWorking } : { kind: 'timed', at: run.firstFrame, lateMs: run.firstFrame - (working.t + FILLER_AFTER_MS) });
        first = run.firstFrame;
      } else fillers.push({ kind: 'still', at: run.firstFrame, lateMs: run.firstFrame - (first + STILL_LOOKING_MS) });
    }
    const answer = runs.find((r) => !r.filler && r.firstFrame >= working.t);
    out.push({ callId: call.header.callId, chain: call.header.chain, id: scn.id, workingAt: working.t, waitMs: answer ? answer.firstFrame - working.t : null, fillers });
  }
  return out;
}

const pct = (values: number[], p: number): number | null => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.floor((v.length - 1) * p)]) : null;
};

export interface ClientSummary {
  toolTurns: number;
  withFiller: number;
  /** waits long enough that the function must have run 2 s or more (the answer needs about 1.4 s more after the function), and how many of them had no filler */
  longWaits: number;
  longWithoutFiller: number;
  /** waits too short for a function to have run 1.5 s, and how many of them had a filler */
  quickWaits: number;
  quickWithFiller: number;
  timedLateP50: number | null;
  timedLateP90: number | null;
  timedN: number;
  immediateN: number;
  stillN: number;
}

/** Waits of this long or more mean a function of 2 s or more (the second round of the model and the voice need 1.4 s at the median after it); this short or less, one of 1.1 s or less. */
export const LONG_WAIT_MS = LONG_FUNCTION_MS + 1500;
export const QUICK_WAIT_MS = QUICK_FUNCTION_MS + 1300;

export function summarizeClient(turns: readonly ClientToolTurn[]): ClientSummary {
  const timed = turns.flatMap((t) => t.fillers.filter((f) => f.kind === 'timed').map((f) => f.lateMs));
  const long = turns.filter((t) => t.waitMs !== null && t.waitMs >= LONG_WAIT_MS);
  const quick = turns.filter((t) => t.waitMs !== null && t.waitMs <= QUICK_WAIT_MS);
  return {
    toolTurns: turns.length,
    withFiller: turns.filter((t) => t.fillers.length > 0).length,
    longWaits: long.length,
    longWithoutFiller: long.filter((t) => t.fillers.length === 0).length,
    quickWaits: quick.length,
    quickWithFiller: quick.filter((t) => t.fillers.length > 0).length,
    timedLateP50: pct(timed, 0.5),
    timedLateP90: pct(timed, 0.9),
    timedN: timed.length,
    immediateN: turns.reduce((n, t) => n + t.fillers.filter((f) => f.kind === 'immediate').length, 0),
    stillN: turns.reduce((n, t) => n + t.fillers.filter((f) => f.kind === 'still').length, 0),
  };
}

// ---------------------------------------------------------------- the lab's own trace

export interface TraceRow {
  at?: string;
  chain?: string;
  turn?: number;
  functions?: Array<{ name?: string; startedAt: number; answeredAt?: number }>;
  fillers?: Array<{ text?: string; injectedAt: number; audioAt?: number }>;
}

export interface TraceSummary {
  /** turns with a function */
  toolTurns: number;
  fillers: number;
  /** injection to first audio of every filler that got audio (ms) */
  audioP50: number | null;
  audioP90: number | null;
  /** fillers that never got audio (the turn was cut short, or the mouth failed) */
  noAudio: number;
  /** functions that ran LONG_FUNCTION_MS or more: how many turns, and how many of them had no filler */
  longTurns: number;
  longWithoutFiller: number;
  /** functions that answered within QUICK_FUNCTION_MS: how many turns, and how many of them had a filler */
  quickTurns: number;
  quickWithFiller: number;
  /** functions that ran longer than VERY_LONG_FUNCTION_MS: how many turns, and how many of them had two fillers or more */
  veryLongTurns: number;
  veryLongWithSecond: number;
}

/** What a turn's longest function ran, in ms (the filler is once to a turn, whatever the number of functions): null when none answered. */
function functionMs(row: TraceRow): number | null {
  const times = (row.functions ?? []).filter((f) => typeof f.answeredAt === 'number').map((f) => (f.answeredAt as number) - f.startedAt);
  return times.length ? Math.max(...times) : null;
}

export function summarizeTrace(rows: readonly TraceRow[]): TraceSummary {
  const tool = rows.filter((r) => (r.functions ?? []).length > 0);
  const delays = tool.flatMap((r) => (r.fillers ?? []).filter((f) => typeof f.audioAt === 'number').map((f) => (f.audioAt as number) - f.injectedAt));
  const withMs = tool.map((r) => ({ r, ms: functionMs(r) })).filter((x): x is { r: TraceRow; ms: number } => x.ms !== null);
  const has = (r: TraceRow, n: number): boolean => (r.fillers ?? []).length >= n;
  const long = withMs.filter((x) => x.ms >= LONG_FUNCTION_MS);
  const quick = withMs.filter((x) => x.ms <= QUICK_FUNCTION_MS);
  const veryLong = withMs.filter((x) => x.ms > VERY_LONG_FUNCTION_MS);
  return {
    toolTurns: tool.length,
    fillers: tool.reduce((n, r) => n + (r.fillers ?? []).length, 0),
    audioP50: pct(delays, 0.5),
    audioP90: pct(delays, 0.9),
    noAudio: tool.reduce((n, r) => n + (r.fillers ?? []).filter((f) => typeof f.audioAt !== 'number').length, 0),
    longTurns: long.length,
    longWithoutFiller: long.filter((x) => !has(x.r, 1)).length,
    quickTurns: quick.length,
    quickWithFiller: quick.filter((x) => has(x.r, 1)).length,
    veryLongTurns: veryLong.length,
    veryLongWithSecond: veryLong.filter((x) => has(x.r, 2)).length,
  };
}

/** The rows of a trace file whose `at` (ISO, the wall clock of the commit) is within [from, to], grouped by chain ('' for a process's own settings). */
export function readTrace(file: string, from: string, to: string): Map<string, TraceRow[]> {
  const out = new Map<string, TraceRow[]>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: TraceRow;
    try {
      row = JSON.parse(line) as TraceRow;
    } catch {
      continue;
    }
    if (typeof row.at !== 'string' || row.at < from || row.at > to) continue;
    const key = row.chain ?? '';
    (out.get(key) ?? out.set(key, []).get(key)!).push(row);
  }
  return out;
}

// ---------------------------------------------------------------- the command

const show = (v: number | null): string => (v === null ? 'n/a' : String(v));

export function renderClient(label: string, s: ClientSummary): string {
  return [
    `chain ${label}: ${s.toolTurns} tool turn(s), a filler in ${s.withFiller}; timed fillers ${s.timedN} (first audio against the moment due: p50 ${show(s.timedLateP50)} p90 ${show(s.timedLateP90)} ms), immediate ${s.immediateN}, second lines ${s.stillN}`,
    `  waits long enough for a function of ${LONG_FUNCTION_MS} ms or more: ${s.longWaits}, with no filler: ${s.longWithoutFiller}; waits too short for one of ${FILLER_AFTER_MS} ms: ${s.quickWaits}, with a filler: ${s.quickWithFiller}`,
  ].join('\n');
}

export function renderTrace(label: string, s: TraceSummary): string {
  const audio = s.audioP90 === null ? 'n/a' : s.audioP90 <= FILLER_AUDIO_MS ? `${s.audioP90} (within ${FILLER_AUDIO_MS})` : `${s.audioP90} (OVER ${FILLER_AUDIO_MS})`;
  return [
    `chain ${label || '(none)'}: ${s.toolTurns} turn(s) with a function, ${s.fillers} filler(s); injection to first audio p50 ${show(s.audioP50)} p90 ${audio} ms; fillers with no audio ${s.noAudio}`,
    `  functions of ${LONG_FUNCTION_MS} ms or more: ${s.longTurns} turn(s), with no filler: ${s.longWithoutFiller}; of ${QUICK_FUNCTION_MS} ms or less: ${s.quickTurns}, with a filler: ${s.quickWithFiller}; over ${VERY_LONG_FUNCTION_MS} ms: ${s.veryLongTurns}, with a second line: ${s.veryLongWithSecond}`,
  ].join('\n');
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) flags.set(rest[i].replace(/^--/, ''), rest[i + 1] ?? '');
  if (command === 'client' && flags.get('dir')) {
    const calls = readRawLogs(flags.get('dir') as string).filter((c) => c.header.set === 'tools');
    const byChain = new Map<string, ClientToolTurn[]>();
    for (const call of calls) (byChain.get(call.header.chain) ?? byChain.set(call.header.chain, []).get(call.header.chain)!).push(...clientToolTurns(call));
    for (const [chain, turns] of byChain) console.log(renderClient(chain, summarizeClient(turns)));
    return 0;
  }
  if (command === 'trace' && flags.get('file') && flags.get('from') && flags.get('to')) {
    for (const [chain, rows] of readTrace(flags.get('file') as string, flags.get('from') as string, flags.get('to') as string)) console.log(renderTrace(chain, summarizeTrace(rows)));
    return 0;
  }
  console.error('usage: c4.js client --dir <raw logs> | c4.js trace --file <turns.jsonl> --from <iso> --to <iso>');
  return 2;
}

if (process.argv[1] != null && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
