/**
 * What the teaching team sees of the class: the numbers behind portal/web/team.html. Everything here is READ-ONLY and made of files the
 * orchestrator already keeps; nothing is written, no model is called, no container is started.
 *
 *   heat map         groups/<folder>/COMPETENCY.md of every student (src/voice/competency.ts reads the mastery lines in every spelling)
 *   misconceptions   the Active Misconceptions lines, grouped by the concept they contradict; classified the way the patrol's gate does
 *   patrol           task_run_logs (the gate's skips in its own words, failures) and each student's competency/intervention-log.md
 *   quick checks     the history lines `quiz: true` and the taps on them (`choice.correct`), per question, with no student attached
 *   needs attention  the gate's own signals (src/patrol-gate.ts: deadlines, Canvas snapshot), the days since the student last wrote, and
 *                    the confirmed misconceptions that are still open
 *   voice            store/voice-usage.json (seconds per student per day) and the headings of competency/voice-sessions.md
 *
 * What never leaves this module, whatever the file holds: a message a student wrote or said, a call's transcript (voice-sessions.md is read
 * for its `## ` headings only), a file they attached, the text of a note TAi saved (the database's `memories` is not touched), the belief
 * of a misconception (only the concept it contradicts), the error text of a failed run, what a model answered in a patrol run (a run's
 * `result` is shown only when it is the gate's own text, which is made of ids, counts and dates) and the text of a line the model wrote in a
 * student's intervention log (of one, only the decision word; the lines the scheduler writes there show their reason, which is made of signal
 * keys, numbers and fixed words). What IS shown, and comes from a student's own words by way of a model: the names of concepts, which the record
 * keeps within 80 characters and a model chooses.
 *
 * Every file read from a student's folder (COMPETENCY.md, competency/*.md) goes through src/safe-fs.ts or the same checks: their container can
 * write there, and a link, a FIFO or a directory that leads out of the folder is "no file", never read and never waited for.
 *
 * The database, the Canvas snapshot, the roster and the clock are injected (TeamDeps), so the aggregation is tested on real files in a
 * temporary directory and the database part by a stand-in: `sqliteTeamDb` is the only code here that knows a table, and it is handed `getDb`
 * (like memory-view.ts's `sqliteMemoryStore`) so that importing this module does not load better-sqlite3.
 *
 * The whole aggregate is cached for a minute (reading about 110 files is cheap, doing it for every reload is not needed) and is made with
 * asynchronous file reads, so the orchestrator's event loop is never held for the length of a class.
 */
import fs from 'fs';
import path from 'path';

import { TIMEZONE } from '../config.js';
import {
  CLOSED,
  IDENTIFYING,
  SNAPSHOT_MAX_AGE_HOURS,
  evaluateGate,
  gateConfig,
  gatherFacts,
  isOpenAndConfirmed,
  nextPatrolAfter,
  type GateConfig,
  type Signal,
} from '../patrol-gate.js';
import type { Snapshot } from '../student-course.js';
import { realDirInside } from '../safe-fs.js';
import { GETTING_THERE_AT, SCOPES, SOLID_AT, findConcept, interviewProfile, levelWord, misconceptionFields, parseMastery, parseMisconceptions } from '../voice/competency.js';
import type { MasteryEntry } from '../voice/competency.js';
import { STUDENT_FOLDER } from './history.js';

// ---------------------------------------------------------------- what is injected

/** One person on the allowlist, as the view needs to know them. */
export interface RosterEntry {
  /** `s_` and 20 hex digits: the only thing that becomes a path here. */
  folder: string;
  /** The chat (`web:<folder>`): what the database knows the student's messages by. */
  jid: string;
  name: string;
  /** A teaching-team account (role owner): left out of the class's numbers unless the page asks for them. */
  staff: boolean;
  canvasUserId?: string;
  /** When the chat was registered (ISO): a student who has never written counts from here. */
  addedAt?: string;
}

/** A patrol task's run, as task_run_logs and scheduled_tasks have it (the columns the view needs, and not `error`). */
export interface PatrolRow {
  folder: string;
  runAt: string;
  status: string;
  result: string | null;
}

/** The three questions the view asks the database. */
export interface TeamDb {
  /** The runs of the teaching patrol since `sinceIso`. */
  patrolRuns(sinceIso: string): PatrolRow[];
  /** The cron of the patrol (so that "the last patrol before a deadline" is the gate's own), or null. */
  patrolCron(): string | null;
  /** The ISO time of the last message each chat's student wrote (the predicate of getLastUserMessageTime in src/db.ts, for every chat at once). */
  lastStudentMessages(): Map<string, string>;
}

export interface TeamDeps {
  groupsDir: string;
  /** store/portal: one `<folder>.jsonl` per student (src/portal/history.ts). */
  historyDir: string;
  /** store/voice-usage.json (src/voice/usage.ts). */
  voiceUsageFile: string;
  roster: () => RosterEntry[];
  /** Absent: no patrol panel and nobody's last message (the page says what is missing). */
  db?: TeamDb | null;
  /** The Canvas snapshot the gate reads (store/student-course.json); absent or null: deadlines cannot be seen. */
  canvas?: () => { at: string; snapshot: Snapshot } | null;
  now?: () => number;
  /** TAI_PATROL_INACTIVE_DAYS and friends (src/patrol-gate.ts gateConfig). */
  env?: NodeJS.ProcessEnv;
  /** The zone the days are counted in (default: the orchestrator's own, TZ, the one the patrol's cron and the agent's dates are in). */
  timeZone?: string;
  /** TAI_VOICE_DAILY_MIN: the daily cap of a student's voice, shown beside their minutes. */
  voiceCapMinutes?: number | null;
  /** Where the gate keeps what it last looked at (src/patrol-gate.ts); the view does not use it, tests point it at nothing. */
  gateStateFile?: string;
  cacheMs?: number;
}

// ---------------------------------------------------------------- what is answered

export const OVERVIEW_CACHE_MS = 60_000;
export const PATROL_DAYS = 7;
/** The page's own words for the bands: the same numbers the student's page and a voice call use (src/voice/competency.ts). */
export const BANDS = { solid: SOLID_AT, gettingThere: GETTING_THERE_AT };

export type RecordState = 'ok' | 'none' | 'unreadable';
export type MisconceptionStatus = 'candidate' | 'confirmed' | 'remediated';

/** `[confidence, stability, scopes, last evidence day ('' for none), verbal gap (1: knows it, has not said it aloud)]`. */
export type HeatCell = [number, number, string[], string, 0 | 1];

export interface TeamStudent {
  id: string;
  name: string;
  staff: boolean;
  record: RecordState;
  /** Concepts with any evidence. */
  touched: number;
  /** Mean confidence of those, or null. */
  mean: number | null;
  verbalGaps: number;
  /** The newest evidence day over the concepts, or null. */
  lastEvidence: string | null;
  /** Days since the student last wrote or called, or null for never. */
  quietDays: number | null;
}

export interface ConceptRow {
  name: string;
  /** The `###` heading the concept sits under in the files ("Week 11: Consensus & Replication (HW10)"), or ''. */
  group: string;
  touched: number;
  mean: number | null;
  stability: number | null;
  levels: { solid: number; gettingThere: number; justStarted: number };
  /** Of the students with evidence: how many know it (confidence 0.3 or more) and have not explained it out loud. */
  noVerbal: number;
  last: string | null;
  /** One entry per student of `students`, in that order; null: no evidence yet. */
  cells: Array<HeatCell | null>;
}

export interface MisconceptionRow {
  concept: string;
  students: number;
  /** Students by their most serious line on this concept. */
  candidate: number;
  confirmed: number;
  remediated: number;
  who: Array<{ id: string; name: string; status: MisconceptionStatus }>;
}

export type AttentionReason =
  | { kind: 'quiet'; days: number | null }
  | { kind: 'deadline'; assignment: string; hours: number }
  | { kind: 'overdue'; assignment: string; hours: number }
  | { kind: 'misconception'; concepts: string[] };

export interface AttentionRow {
  id: string;
  name: string;
  reasons: AttentionReason[];
}

export type Decision = 'intervene' | 'no-action' | 'failed' | 'other';

export interface PatrolPanel {
  /** A database was given: false means the page has nothing to say about runs. */
  available: boolean;
  days: number;
  runs: number;
  ranModel: number;
  skipped: number;
  /** Shadow mode: runs the gate would have skipped and the model made anyway. */
  shadow: number;
  failed: number;
  byDay: Array<{ day: string; ranModel: number; skipped: number; failed: number }>;
  /** The gate's reasons for skipping, with dates and ids taken out so that the same reason counts together. */
  skipReasons: Array<{ reason: string; count: number }>;
  recent: Array<{ day: string; student: string; kind: 'skipped' | 'shadow' | 'ran' | 'failed'; reason?: string }>;
  /** competency/intervention-log.md of each student; `available` is false when no student has an entry. */
  interventions: {
    available: boolean;
    intervene: number;
    noAction: number;
    other: number;
    students: Array<{ id: string; name: string; intervene: number; noAction: number; other: number; last: { date: string; decision: Decision } | null }>;
  };
}

export interface QuestionRow {
  question: string;
  answers: number;
  /** Answers to a question TAi had marked an answer for (a tap on one it did not mark, or dropped, is not graded). */
  graded: number;
  right: number;
  percentRight: number | null;
}

export interface QuickCheckPanel {
  asked: number;
  answered: number;
  graded: number;
  right: number;
  questions: QuestionRow[];
}

export interface VoicePanel {
  capMinutes: number | null;
  days: string[];
  /** The class's minutes on each of `days`. */
  totals: number[];
  students: Array<{ id: string; name: string; minutes: number[]; total: number; calls: number; lastCall: string | null }>;
}

export interface TeamOverview {
  generatedAt: string;
  cacheSeconds: number;
  bands: typeof BANDS;
  class: {
    students: number;
    withRecord: number;
    noRecord: number;
    unreadable: number;
    /** Teaching-team accounts that are not counted (0 when the page asked for them). */
    staffHidden: number;
    includeStaff: boolean;
    inactiveDays: number;
    /** The day it is for the orchestrator (YYYY-MM-DD, in its zone): what "today" and "yesterday" on the page mean. */
    today: string;
    canvas: { state: 'ok' | 'stale' | 'missing'; at: string | null };
    /** Files that could not be read and were skipped, so that a number is never quietly smaller than it should be. */
    skipped: { records: number; histories: number; voiceUsage: boolean };
  };
  students: TeamStudent[];
  concepts: ConceptRow[];
  misconceptions: MisconceptionRow[];
  attention: AttentionRow[];
  patrol: PatrolPanel;
  quickChecks: QuickCheckPanel;
  voice: VoicePanel;
}

export interface StudentDetail {
  id: string;
  name: string;
  staff: boolean;
  record: RecordState;
  lastActive: string | null;
  quietDays: number | null;
  concepts: Array<{
    name: string;
    group: string;
    confidence: number;
    stability: number;
    level: string;
    scope: string[];
    via: string[];
    last: string | null;
    verbalGap: boolean;
  }>;
  misconceptions: Array<{ concept: string; status: MisconceptionStatus }>;
  attention: AttentionReason[];
  patrol: {
    available: boolean;
    ranModel: number;
    skipped: number;
    failed: number;
    decisions: Array<{ date: string; decision: Decision; reason: string }>;
  };
  voice: { calls: number; lastCall: string | null; minutes: Array<{ day: string; minutes: number }> };
}

// ---------------------------------------------------------------- small things

const DAY = 86_400_000;
const FILE_MAX_BYTES = 2 * 1024 * 1024;
/** How much of the end of a student's history is read for quick checks: far more than a student writes in a term, and a bound on a runaway file. */
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
const QUESTION_CHARS = 240;
const CONCEPT_CHARS = 120;
const MAX_QUESTIONS = 200;
const MAX_RECENT = 40;
const TOP_REASONS = 8;
const CONCURRENCY = 8;

const tidy = (text: unknown, max: number): string => {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
};

const round = (n: number, places: number): number => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};

/** The calendar day of a moment in a zone, "2026-11-04" (an unknown zone name is the process's own). */
export function dayFormatter(timeZone: string | undefined): (ms: number) => string {
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat('en-CA', options);
  }
  return (ms) => format.format(new Date(ms));
}

/** A day some days before or after another, by the calendar alone (a day with an hour more or less in it is still one day). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const keyOf = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.name.localeCompare(b.name);

/** The day a mastery line has evidence for ("2026-10-30"), null for "never" or anything that is not a date. */
const evidenceDay = (last: string): string | null => (/^\d{4}-\d{2}-\d{2}/.test(last) ? last.slice(0, 10) : null);

// ---------------------------------------------------------------- reading the files

/**
 * A file of a student's folder (their container can write it): its text; `failed` when it is there and could not be read (a link, a FIFO, a directory, a
 * directory that leads out of `root`, no permission, over the size bound), null text and no failure when it is not there. Never follows a link and never
 * waits for a writer (src/safe-fs.ts: a FIFO read this way would stop the page's server for good).
 */
async function readSmall(file: string, root: string): Promise<{ text: string | null; failed: boolean }> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    if (realDirInside(path.dirname(file), root) === null) return { text: null, failed: true };
    if (!(await fs.promises.lstat(file)).isFile()) return { text: null, failed: true };
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_MAX_BYTES) return { text: null, failed: true };
    return { text: await handle.readFile('utf-8'), failed: false };
  } catch (err) {
    return { text: null, failed: (err as NodeJS.ErrnoException).code !== 'ENOENT' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The last `maxBytes` of a file, from the first whole line on. */
async function readTail(file: string, maxBytes: number): Promise<{ text: string | null; failed: boolean }> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    // (opening a directory succeeds on some systems and reads nothing: a file that is not a file is a file that could not be read)
    if (!(await fs.promises.stat(file)).isFile()) return { text: null, failed: true };
    handle = await fs.promises.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const text = buffer.subarray(0, read).toString('utf-8');
    return { text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text, failed: false };
  } catch (err) {
    return { text: null, failed: (err as NodeJS.ErrnoException).code !== 'ENOENT' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------- misconceptions

/**
 * Where a line of Active Misconceptions stands, by the patrol's own rules (src/patrol-gate.ts): closed when it says so in a field of its own,
 * confirmed when it says so or has three sightings, else a candidate; a line that is `identifying` (the student discussing the mix-up
 * correctly, not holding it) is none of them. Undercounts "remediated": the protocol moves a resolved line to competency/interviews.md.
 */
export function misconceptionStatus(line: string): MisconceptionStatus | 'identifying' {
  const fields = misconceptionFields(line);                      // never the belief itself: its words are a student's, and "status: resolved" in them is not the line's status
  if (CLOSED.test(fields)) return 'remediated';
  if (IDENTIFYING.test(fields)) return 'identifying';
  return isOpenAndConfirmed(line) ? 'confirmed' : 'candidate';
}

const SEVERITY: Record<MisconceptionStatus, number> = { remediated: 1, candidate: 2, confirmed: 3 };

// ---------------------------------------------------------------- the intervention log

export interface Intervention {
  date: string;
  decision: Decision;
  reason: string;
}

const LOG_LINE = /^(?:[-*]\s+)?(?:\*\*)?(\d{4}-\d{2}-\d{2})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?(?:\*\*)?\s*(?:[:|–—-]\s*)?(.*)$/;
const NO_ACTION = /^(?:\*\*)?(?:no[- ]?action|no intervention|not intervening|skipp?ed?|none)\b/i;
const INTERVENE = /^(?:\*\*)?(?:interven\w*|sent|message[ds]?|reach\w*|nudg\w*)\b/i;
const FAILED = /^(?:\*\*)?failed\b/i;

/**
 * The openings of the lines the scheduler writes for each patrol run (src/intervention-log.ts `interventionLine`): the rest of such a line is signal
 * keys, numbers and fixed words, so it may be shown. A line the MODEL wrote (the persona still lets it log a decision in its own words) can say anything,
 * the student's words included: of such a line only the decision is read, never its text.
 */
const HOST_LINE = /^(?:no-action — the gate skipped the run \(no container, no model\)|intervene — the model ran and sent the student a message|no-action — the model ran and sent no message|failed — (?:the model could not be reached|the run did not finish|the run failed))/;

/**
 * What competency/intervention-log.md says, as far as it can be read without knowing who wrote it: a line that begins with a date (as a
 * bullet or not) is a decision, and its first word says which: "intervene" and "no-action" (the protocol's examples, and the line the scheduler
 * writes for each patrol run, src/intervention-log.ts) or "failed" (a run that did not finish). Anything else is skipped. The reason is the
 * scheduler's own words; a line written by the model has none.
 */
export function parseInterventions(text: string): Intervention[] {
  const out: Intervention[] = [];
  for (const raw of text.split('\n')) {
    const m = LOG_LINE.exec(raw.trim());
    if (!m) continue;
    const rest = m[2].trim();
    const lead = NO_ACTION.exec(rest) ?? INTERVENE.exec(rest) ?? FAILED.exec(rest);
    const decision: Decision = lead
      ? NO_ACTION.test(rest) ? 'no-action' : INTERVENE.test(rest) ? 'intervene' : 'failed'
      : /\bno[- ]action\b/i.test(rest) ? 'no-action' : /\binterven/i.test(rest) ? 'intervene' : 'other';
    // the decision's own word, and the dash after it, are not the reason; and only the scheduler's lines have one
    const reason = HOST_LINE.test(rest) && lead ? tidy(rest.slice(lead[0].length).replace(/^(?:\*\*)?\s*(?:[:|–—-]\s*)?/, ''), 200) : '';
    out.push({ date: m[1], decision, reason });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------- voice

const CALL_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})\s*·\s*(\d+(?:\.\d+)?)\s*min\b/;

/** The calls in competency/voice-sessions.md: its `## ` headings, and nothing under them (that is the transcript). */
export function callHeadings(text: string): Array<{ day: string; minutes: number }> {
  const out: Array<{ day: string; minutes: number }> = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('## ')) continue;
    const m = CALL_HEADING.exec(line);
    if (m) out.push({ day: m[1], minutes: Number(m[3]) });
  }
  return out;
}

/** store/voice-usage.json as src/voice/usage.ts writes it: day -> folder -> seconds. Anything else in it is ignored. */
export function parseUsage(text: string | null): { days: Record<string, Record<string, number>>; failed: boolean } {
  if (text === null) return { days: {}, failed: false };
  try {
    const data = JSON.parse(text) as { days?: unknown };
    const days: Record<string, Record<string, number>> = {};
    if (data && typeof data.days === 'object' && data.days !== null) {
      for (const [day, folders] of Object.entries(data.days as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !folders || typeof folders !== 'object') continue;
        const clean: Record<string, number> = {};
        for (const [folder, seconds] of Object.entries(folders as Record<string, unknown>)) {
          if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) clean[folder] = seconds;
        }
        days[day] = clean;
      }
    }
    return { days, failed: false };
  } catch {
    return { days: {}, failed: true };
  }
}

// ---------------------------------------------------------------- the quick checks

export interface QuizEvents {
  /** TAi's quick checks of this student, by the number of the line: its question. */
  asked: Map<number, string>;
  /** The student's taps: the line they answer, and whether TAi had marked that option (absent: nothing was marked, or the mark was dropped). */
  taps: Array<{ to: number; correct?: boolean }>;
}

/**
 * The quick checks and the taps on them in one student's history. Only lines that can be one of the two are parsed. A tap on a line that
 * is not a quick check (quick replies carry choices but no `quiz`) is not an answer. The `secret` of a line is never read.
 */
export function quizEvents(text: string): QuizEvents {
  const asked = new Map<number, string>();
  const taps: QuizEvents['taps'] = [];
  for (const line of text.split('\n')) {
    if (!/"quiz"\s*:\s*true|"choice"\s*:/.test(line)) continue;
    let entry: { n?: unknown; role?: unknown; text?: unknown; quiz?: unknown; choice?: { to?: unknown; correct?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.role === 'assistant' && entry.quiz === true && typeof entry.n === 'number' && typeof entry.text === 'string') asked.set(entry.n, entry.text);
    else if (entry.role === 'user' && entry.choice && typeof entry.choice.to === 'number') {
      taps.push({ to: entry.choice.to, ...(typeof entry.choice.correct === 'boolean' ? { correct: entry.choice.correct } : {}) });
    }
  }
  return { asked, taps };
}

/** Quick checks across the class, by the words of the question (the options are shuffled for each student, so they cannot be matched by position). */
export function quickCheckPanel(all: QuizEvents[]): QuickCheckPanel {
  const rows = new Map<string, QuestionRow>();
  let asked = 0;
  let answered = 0;
  let graded = 0;
  let right = 0;
  for (const quiz of all) {
    asked += quiz.asked.size;
    const taken = new Set<number>();
    for (const tap of quiz.taps) {
      const question = quiz.asked.get(tap.to);
      if (question === undefined || taken.has(tap.to)) continue;          // not a quick check, or a second tap on the same one
      taken.add(tap.to);
      const clipped = tidy(question, QUESTION_CHARS);
      const key = keyOf(clipped).replace(/[\s.?!:;,]+$/, '');
      if (!key) continue;
      let row = rows.get(key);
      if (!row) {
        row = { question: clipped, answers: 0, graded: 0, right: 0, percentRight: null };
        rows.set(key, row);
      }
      answered++;
      row.answers++;
      if (tap.correct !== undefined) {
        graded++;
        row.graded++;
        if (tap.correct) {
          right++;
          row.right++;
        }
      }
    }
  }
  const questions = [...rows.values()].map((q) => ({ ...q, percentRight: q.graded > 0 ? Math.round((q.right / q.graded) * 100) : null }));
  questions.sort((a, b) => b.answers - a.answers || (a.percentRight ?? 101) - (b.percentRight ?? 101) || a.question.localeCompare(b.question));
  return { asked, answered, graded, right, questions: questions.slice(0, MAX_QUESTIONS) };
}

// ---------------------------------------------------------------- one student's facts

interface Facts {
  entry: RosterEntry;
  record: RecordState;
  entries: MasteryEntry[];
  /** The `###` heading above each entry. */
  groups: string[];
  gaps: Set<string>;
  misconceptions: Array<{ concept: string; status: MisconceptionStatus }>;
  signals: Signal[];
  lastActive: Date | null;
  registeredAt: Date | null;
  quiz: QuizEvents | null;
  interventions: Intervention[] | null;
  calls: Array<{ day: string; minutes: number }>;
  historyFailed: boolean;
}

interface Shared {
  now: Date;
  dayOf: (ms: number) => string;
  today: string;
  /** The days of the patrol's window, oldest first, the last one today. */
  days: string[];
  cfg: GateConfig;
  snapshot: { at: string; snapshot: Snapshot } | null;
  snapshotState: 'ok' | 'stale' | 'missing';
  usage: Record<string, Record<string, number>>;
  usageFailed: boolean;
  patrol: PatrolRow[] | null;
  cron: string;
  lastMessages: Map<string, string> | null;
}

/** The headings (`### Week 3: ...`) above each line of a COMPETENCY.md: what parseMastery's `line` is an index into. */
function headingsByLine(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = new Array(lines.length);
  let current = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^###\s+(.+?)\s*$/.exec(lines[i]);
    if (m) current = tidy(m[1], CONCEPT_CHARS);
    out[i] = current;
  }
  return out;
}

function emptyFacts(entry: RosterEntry, record: RecordState): Facts {
  return {
    entry,
    record,
    entries: [],
    groups: [],
    gaps: new Set(),
    misconceptions: [],
    signals: [],
    lastActive: null,
    registeredAt: null,
    quiz: null,
    interventions: null,
    calls: [],
    historyFailed: false,
  };
}

async function gather(entry: RosterEntry, deps: TeamDeps, shared: Shared): Promise<Facts> {
  const dir = path.join(deps.groupsDir, entry.folder);
  const file = path.join(dir, 'COMPETENCY.md');
  let facts: Facts = emptyFacts(entry, 'none');
  try {
    const gate = gatherFacts(
      { chat_jid: entry.jid, group_folder: entry.folder, schedule_value: shared.cron },
      { added_at: entry.addedAt, canvasUserId: entry.canvasUserId },
      {
        now: () => shared.now,
        groupsDir: deps.groupsDir,
        stateFile: deps.gateStateFile,
        snapshot: () => shared.snapshot,
        lastStudentMessage: (jid) => shared.lastMessages?.get(jid),
        // an empty cron is "every minute" to cron-parser: with no patrol schedule known the gate must fall back to its 48 hours, not to the next minute
        nextPatrol: (cron, from) => (cron ? nextPatrolAfter(cron, from) : null),
      },
    );
    const decision = evaluateGate(gate, shared.cfg);
    facts.signals = decision.signals;
    facts.lastActive = gate.lastActive;
    facts.registeredAt = gate.registeredAt;
    const text = gate.competency;
    if (text === null) facts.record = fs.existsSync(file) ? 'unreadable' : 'none';
    else if (!text.trim()) facts.record = 'none';
    else if (text.includes('\u0000') || decision.signals.some((s) => s.kind === 'competency-unknown')) facts.record = 'unreadable';
    else facts.record = 'ok';
    if (facts.record === 'ok' && text !== null) {
      const entries = parseMastery(text);
      const headings = headingsByLine(text);
      facts.entries = entries;
      facts.groups = entries.map((e) => headings[e.line] ?? '');
      facts.gaps = new Set(interviewProfile(text).verbalGaps);
      for (const m of parseMisconceptions(text)) {
        const status = misconceptionStatus(m.line);
        if (status === 'identifying') continue;
        const found = m.contradicts && !m.contradicts.startsWith('[') ? findConcept(entries, m.contradicts) : undefined;
        facts.misconceptions.push({ concept: tidy(found?.name ?? m.contradicts, CONCEPT_CHARS) || 'No concept named', status });
      }
    }
  } catch {
    facts = emptyFacts(entry, 'unreadable');
  }
  const [history, log, calls] = await Promise.all([
    readTail(path.join(deps.historyDir, `${entry.folder}.jsonl`), HISTORY_TAIL_BYTES),
    readSmall(path.join(dir, 'competency', 'intervention-log.md'), dir),
    readSmall(path.join(dir, 'competency', 'voice-sessions.md'), dir),
  ]);
  facts.historyFailed = history.failed;
  if (history.text !== null) facts.quiz = quizEvents(history.text);
  if (log.text !== null) facts.interventions = parseInterventions(log.text);
  if (calls.text !== null) facts.calls = callHeadings(calls.text);
  return facts;
}

// ---------------------------------------------------------------- the panels

const daysQuiet = (facts: Facts, now: number): number | null => (facts.lastActive ? Math.max(0, Math.floor((now - facts.lastActive.getTime()) / DAY)) : null);

function attentionOf(facts: Facts, shared: Shared): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  const now = shared.now.getTime();
  const quiet = daysQuiet(facts, now);
  if (quiet !== null) {
    if (quiet >= shared.cfg.inactiveDays) reasons.push({ kind: 'quiet', days: quiet });
  } else if (!facts.registeredAt || now - facts.registeredAt.getTime() >= shared.cfg.inactiveDays * DAY) {
    reasons.push({ kind: 'quiet', days: null });             // never wrote, and not new
  }
  for (const s of facts.signals) {
    if (s.kind === 'due-last' && s.id) reasons.push({ kind: 'deadline', assignment: s.id, hours: s.n });
    else if (s.kind === 'due-late' && s.id) reasons.push({ kind: 'overdue', assignment: s.id, hours: s.n });
  }
  const open = [...new Set(facts.misconceptions.filter((m) => m.status === 'confirmed').map((m) => m.concept))];
  if (open.length > 0) reasons.push({ kind: 'misconception', concepts: open });
  return reasons;
}

/** Hours to the nearest deadline (nothing: infinity), and how long quiet (never wrote: longest). */
const soonest = (reasons: AttentionReason[]): number => Math.min(Infinity, ...reasons.flatMap((r) => (r.kind === 'deadline' ? [r.hours] : [])));
const quietest = (reasons: AttentionReason[]): number => Math.max(-1, ...reasons.flatMap((r) => (r.kind === 'quiet' ? [r.days ?? 9999] : [])));

function attentionPanel(all: Facts[], shared: Shared): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const facts of all) {
    const reasons = attentionOf(facts, shared);
    if (reasons.length > 0) rows.push({ id: facts.entry.folder, name: facts.entry.name, reasons });
  }
  // the most reasons first, then the nearest deadline, then the longest quiet
  return rows.sort((a, b) => b.reasons.length - a.reasons.length || soonest(a.reasons) - soonest(b.reasons) || quietest(b.reasons) - quietest(a.reasons) || byName(a, b));
}

function conceptRows(students: Facts[]): ConceptRow[] {
  const index = new Map(students.map((f, i) => [f.entry.folder, i]));
  const rows = new Map<string, ConceptRow & { sum: number; stabilitySum: number }>();
  for (const facts of students) {
    const seen = new Set<string>();
    facts.entries.forEach((e, i) => {
      const key = keyOf(e.name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      let row = rows.get(key);
      if (!row) {
        row = {
          name: tidy(e.name, CONCEPT_CHARS),
          group: facts.groups[i] ?? '',
          touched: 0,
          mean: null,
          stability: null,
          levels: { solid: 0, gettingThere: 0, justStarted: 0 },
          noVerbal: 0,
          last: null,
          cells: new Array(students.length).fill(null),
          sum: 0,
          stabilitySum: 0,
        };
        rows.set(key, row);
      }
      if (e.confidence <= 0 && e.scope.length === 0) return;      // nothing recorded: the same as no line
      const day = evidenceDay(e.last);
      const gap = facts.gaps.has(e.name);
      row.touched++;
      row.sum += e.confidence;
      row.stabilitySum += e.stability;
      const band = levelWord(e.confidence);
      if (band === 'solid') row.levels.solid++;
      else if (band === 'getting there') row.levels.gettingThere++;
      else row.levels.justStarted++;
      if (gap) row.noVerbal++;
      if (day && (!row.last || day > row.last)) row.last = day;
      row.cells[index.get(facts.entry.folder) as number] = [round(e.confidence, 2), round(e.stability, 2), SCOPES.filter((s) => e.scope.includes(s)), day ?? '', gap ? 1 : 0];
    });
  }
  const out = [...rows.values()].map(({ sum, stabilitySum, ...row }) => ({
    ...row,
    mean: row.touched ? round(sum / row.touched, 2) : null,
    stability: row.touched ? round(stabilitySum / row.touched, 2) : null,
  }));
  // the weakest first among what the class has met; what nobody has touched yet (a later week) after them, in the files' order
  const met = out.filter((r) => r.touched > 0).sort((a, b) => (a.mean as number) - (b.mean as number) || b.touched - a.touched || a.name.localeCompare(b.name));
  return [...met, ...out.filter((r) => r.touched === 0)];
}

function misconceptionRows(all: Facts[]): MisconceptionRow[] {
  const rows = new Map<string, { concept: string; who: Map<string, { id: string; name: string; status: MisconceptionStatus }> }>();
  for (const facts of all) {
    for (const m of facts.misconceptions) {
      const key = keyOf(m.concept);
      let row = rows.get(key);
      if (!row) {
        row = { concept: m.concept, who: new Map() };
        rows.set(key, row);
      }
      const had = row.who.get(facts.entry.folder);
      if (!had || SEVERITY[m.status] > SEVERITY[had.status]) row.who.set(facts.entry.folder, { id: facts.entry.folder, name: facts.entry.name, status: m.status });
    }
  }
  const out: MisconceptionRow[] = [...rows.values()].map(({ concept, who }) => {
    const list = [...who.values()].sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || byName(a, b));
    return {
      concept,
      students: list.length,
      candidate: list.filter((s) => s.status === 'candidate').length,
      confirmed: list.filter((s) => s.status === 'confirmed').length,
      remediated: list.filter((s) => s.status === 'remediated').length,
      who: list,
    };
  });
  return out.sort((a, b) => b.confirmed - a.confirmed || b.students - a.students || a.concept.localeCompare(b.concept));
}

/** The gate's reason with what varies from day to day taken out, so that "the same reason" is counted together. */
export function normalizeReason(reason: string): string {
  return reason
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/\b(due-(?:last|late)):\d+/g, '$1:<id>')
    .replace(/\b(misconception|spaced):[0-9a-f]{8}\b/g, '$1:<hash>')
    .replace(/\s+/g, ' ')
    .trim();
}

// what src/task-scheduler.ts writes into task_run_logs.result for a skip and for a shadow-mode run (`tai_live.sh patrol` reads the same two starts)
const SKIPPED = 'skipped by the gate';
const SHADOW = /^\[the gate would have skipped this run: ([^\]]*)\]/;

/** A patrol run as the view tells it: only the gate's own words are kept, never what the model answered or the error column. */
export function classifyRun(row: PatrolRow): { kind: 'skipped' | 'shadow' | 'ran' | 'failed'; reason?: string } {
  const result = row.result ?? '';
  if (result.startsWith(SKIPPED)) return { kind: 'skipped', reason: tidy(result.slice(SKIPPED.length).replace(/^:\s*/, ''), 300) };
  const shadow = SHADOW.exec(result);
  if (shadow && row.status !== 'error') return { kind: 'shadow', reason: tidy(shadow[1], 300) };
  return { kind: row.status === 'error' ? 'failed' : 'ran' };
}

function patrolPanel(all: Facts[], shared: Shared): PatrolPanel {
  const days = shared.days;
  const byDay = new Map(days.map((d) => [d, { day: d, ranModel: 0, skipped: 0, failed: 0 }]));
  const names = new Map(all.map((f) => [f.entry.folder, f.entry.name]));
  const reasons = new Map<string, number>();
  const recent: PatrolPanel['recent'] = [];
  let runs = 0;
  let ranModel = 0;
  let skipped = 0;
  let shadow = 0;
  let failed = 0;
  for (const row of shared.patrol ?? []) {
    const name = names.get(row.folder);
    const at = Date.parse(row.runAt);
    const day = Number.isFinite(at) ? shared.dayOf(at) : '';
    const bucket = byDay.get(day);
    if (name === undefined || !bucket) continue;                       // not this class, or older than the window
    const run = classifyRun(row);
    runs++;
    if (run.kind === 'skipped') {
      skipped++;
      bucket.skipped++;
      const reason = normalizeReason(run.reason ?? '');
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    } else {
      ranModel++;
      bucket.ranModel++;
      if (run.kind === 'shadow') shadow++;
      if (run.kind === 'failed') {
        failed++;
        bucket.failed++;
      }
    }
    recent.push({ day, student: name, kind: run.kind, ...(run.reason ? { reason: run.reason } : {}) });
  }
  recent.sort((a, b) => b.day.localeCompare(a.day));
  const since = days[0];
  const students: PatrolPanel['interventions']['students'] = [];
  const totals = { intervene: 0, noAction: 0, other: 0 };
  for (const facts of all) {
    if (!facts.interventions || facts.interventions.length === 0) continue;
    const mine = { intervene: 0, noAction: 0, other: 0 };
    for (const i of facts.interventions) {
      if (i.date < since) continue;
      if (i.decision === 'intervene') mine.intervene++;
      else if (i.decision === 'no-action') mine.noAction++;
      else mine.other++;
    }
    totals.intervene += mine.intervene;
    totals.noAction += mine.noAction;
    totals.other += mine.other;
    const newest = facts.interventions[0];
    students.push({ id: facts.entry.folder, name: facts.entry.name, ...mine, last: { date: newest.date, decision: newest.decision } });
  }
  students.sort((a, b) => b.intervene - a.intervene || (b.last?.date ?? '').localeCompare(a.last?.date ?? '') || byName(a, b));
  return {
    available: shared.patrol !== null,
    days: PATROL_DAYS,
    runs,
    ranModel,
    skipped,
    shadow,
    failed,
    byDay: days.map((d) => byDay.get(d) as { day: string; ranModel: number; skipped: number; failed: number }),
    skipReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, TOP_REASONS),
    recent: recent.slice(0, MAX_RECENT),
    interventions: { available: students.length > 0, ...totals, students },
  };
}

function voicePanel(all: Facts[], shared: Shared, cap: number | null): VoicePanel {
  const wanted = new Set(all.map((f) => f.entry.folder));
  const days = Object.keys(shared.usage)
    .filter((d) => Object.keys(shared.usage[d]).some((folder) => wanted.has(folder)))
    .sort()
    .slice(-14);
  const students: VoicePanel['students'] = [];
  for (const facts of all) {
    const minutes = days.map((d) => round((shared.usage[d]?.[facts.entry.folder] ?? 0) / 60, 1));
    const total = round(minutes.reduce((a, b) => a + b, 0), 1);
    if (total === 0 && facts.calls.length === 0) continue;
    const lastCall = facts.calls.reduce<string | null>((best, c) => (!best || c.day > best ? c.day : best), null);
    students.push({ id: facts.entry.folder, name: facts.entry.name, minutes, total, calls: facts.calls.length, lastCall });
  }
  students.sort((a, b) => b.total - a.total || b.calls - a.calls || byName(a, b));
  return { capMinutes: cap, days, totals: days.map((_, i) => round(students.reduce((sum, s) => sum + s.minutes[i], 0), 1)), students };
}

// ---------------------------------------------------------------- the whole

function overviewOf(all: Facts[], shared: Shared, deps: TeamDeps, staffHidden: number, includeStaff: boolean): TeamOverview {
  const students = [...all].sort((a, b) => byName(a.entry, b.entry));
  const now = shared.now.getTime();
  const listed: TeamStudent[] = students.map((facts) => {
    const cells = facts.entries.filter((e) => e.confidence > 0 || e.scope.length > 0);
    const days = cells.map((e) => evidenceDay(e.last)).filter((d): d is string => d !== null).sort();
    return {
      id: facts.entry.folder,
      name: facts.entry.name,
      staff: facts.entry.staff,
      record: facts.record,
      touched: cells.length,
      mean: cells.length ? round(cells.reduce((sum, e) => sum + e.confidence, 0) / cells.length, 2) : null,
      verbalGaps: cells.filter((e) => facts.gaps.has(e.name)).length,
      lastEvidence: days.length ? days[days.length - 1] : null,
      quietDays: daysQuiet(facts, now),
    };
  });
  return {
    generatedAt: shared.now.toISOString(),
    cacheSeconds: Math.round((deps.cacheMs ?? OVERVIEW_CACHE_MS) / 1000),
    bands: BANDS,
    class: {
      students: students.length,
      withRecord: students.filter((f) => f.record === 'ok').length,
      noRecord: students.filter((f) => f.record === 'none').length,
      unreadable: students.filter((f) => f.record === 'unreadable').length,
      staffHidden,
      includeStaff,
      inactiveDays: shared.cfg.inactiveDays,
      today: shared.today,
      canvas: { state: shared.snapshotState, at: shared.snapshot?.at ?? null },
      skipped: { records: students.filter((f) => f.record === 'unreadable').length, histories: students.filter((f) => f.historyFailed).length, voiceUsage: shared.usageFailed },
    },
    students: listed,
    concepts: conceptRows(students),
    misconceptions: misconceptionRows(students),
    attention: attentionPanel(students, shared),
    patrol: patrolPanel(students, shared),
    quickChecks: quickCheckPanel(students.flatMap((f) => (f.quiz ? [f.quiz] : []))),
    voice: voicePanel(students, shared, deps.voiceCapMinutes ?? null),
  };
}

function detailOf(facts: Facts, shared: Shared): StudentDetail {
  const now = shared.now.getTime();
  const since = shared.days[0];
  const mine = (shared.patrol ?? []).filter((r) => r.folder === facts.entry.folder && Number.isFinite(Date.parse(r.runAt)) && shared.dayOf(Date.parse(r.runAt)) >= since).map(classifyRun);
  const concepts = facts.entries.flatMap((e, i) =>
    e.confidence > 0 || e.scope.length > 0
      ? [
          {
            name: tidy(e.name, CONCEPT_CHARS),
            group: facts.groups[i] ?? '',
            confidence: round(e.confidence, 2),
            stability: round(e.stability, 2),
            level: levelWord(e.confidence),
            scope: SCOPES.filter((s) => e.scope.includes(s)) as string[],
            via: e.via.map((v) => tidy(v, 40)).slice(0, 8),
            last: evidenceDay(e.last),
            verbalGap: facts.gaps.has(e.name),
          },
        ]
      : [],
  );
  concepts.sort((a, b) => a.confidence - b.confidence || a.name.localeCompare(b.name));
  const usage = Object.keys(shared.usage)
    .sort()
    .slice(-14)
    .map((day) => ({ day, minutes: round((shared.usage[day][facts.entry.folder] ?? 0) / 60, 1) }))
    .filter((d) => d.minutes > 0);
  return {
    id: facts.entry.folder,
    name: facts.entry.name,
    staff: facts.entry.staff,
    record: facts.record,
    lastActive: facts.lastActive ? facts.lastActive.toISOString() : null,
    quietDays: daysQuiet(facts, now),
    concepts,
    misconceptions: facts.misconceptions.map((m) => ({ concept: m.concept, status: m.status })).sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || a.concept.localeCompare(b.concept)),
    attention: attentionOf(facts, shared),
    patrol: {
      available: shared.patrol !== null,
      ranModel: mine.filter((r) => r.kind !== 'skipped').length,
      skipped: mine.filter((r) => r.kind === 'skipped').length,
      failed: mine.filter((r) => r.kind === 'failed').length,
      decisions: (facts.interventions ?? []).filter((i) => i.date >= since).slice(0, 14),
    },
    voice: { calls: facts.calls.length, lastCall: facts.calls.reduce<string | null>((best, c) => (!best || c.day > best ? c.day : best), null), minutes: usage },
  };
}

/** The view the routes answer from: the aggregate cached for a minute (one computation at a time), and one student's detail on demand. */
export class TeamView {
  private readonly cache = new Map<string, { at: number; value: Promise<TeamOverview> }>();
  private readonly now: () => number;
  private readonly cacheMs: number;

  constructor(private readonly deps: TeamDeps) {
    this.now = deps.now ?? Date.now;
    this.cacheMs = deps.cacheMs ?? OVERVIEW_CACHE_MS;
  }

  /** Forgets what was computed (the next call reads the files again). */
  clear(): void {
    this.cache.clear();
  }

  overview(includeStaff = false): Promise<TeamOverview> {
    const key = includeStaff ? 'with-staff' : 'class';
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.value;
    const value = this.compute(includeStaff).catch((err) => {
      this.cache.delete(key);
      throw err;
    });
    this.cache.set(key, { at: this.now(), value });
    return value;
  }

  /** One student's detail, from fresh reads; null when the folder is not on the roster. */
  async student(folder: string): Promise<StudentDetail | null> {
    if (!STUDENT_FOLDER.test(folder)) return null;
    const entry = this.deps.roster().find((r) => r.folder === folder);
    if (!entry) return null;
    const shared = this.loadShared();
    return detailOf(await gather(entry, this.deps, shared), shared);
  }

  private loadShared(): Shared {
    const now = new Date(this.now());
    const env = this.deps.env ?? process.env;
    const snapshot = (() => {
      try {
        return this.deps.canvas?.() ?? null;
      } catch {
        return null;
      }
    })();
    const taken = snapshot ? Date.parse(snapshot.at) : NaN;
    const usage = parseUsage(readSyncOrNull(this.deps.voiceUsageFile));
    const db = this.deps.db ?? null;
    const guard = <T>(run: () => T): T | null => {
      try {
        return run();
      } catch {
        return null;                                                  // a database that cannot be asked is a panel with nothing in it, not a failed page
      }
    };
    const dayOf = dayFormatter(this.deps.timeZone ?? TIMEZONE);
    const today = dayOf(now.getTime());
    return {
      now,
      dayOf,
      today,
      days: Array.from({ length: PATROL_DAYS }, (_, i) => addDays(today, i - (PATROL_DAYS - 1))),
      cfg: { ...gateConfig(env), mode: 'on' },                        // not what TAI_PATROL_GATE says: with it off the gate reports no signals at all
      snapshot,
      snapshotState: !snapshot || !Number.isFinite(taken) ? 'missing' : now.getTime() - taken > SNAPSHOT_MAX_AGE_HOURS * 3_600_000 ? 'stale' : 'ok',
      usage: usage.days,
      usageFailed: usage.failed,
      // a day more than the window needs: the days are cut in the zone, not in UTC
      patrol: db ? guard(() => db.patrolRuns(new Date(now.getTime() - (PATROL_DAYS + 1) * DAY).toISOString())) : null,
      cron: (db && guard(() => db.patrolCron())) || '',
      lastMessages: db ? guard(() => db.lastStudentMessages()) : null,
    };
  }

  private async compute(includeStaff: boolean): Promise<TeamOverview> {
    const roster = this.deps.roster().filter((r) => STUDENT_FOLDER.test(r.folder));
    const counted = roster.filter((r) => includeStaff || !r.staff);
    const shared = this.loadShared();
    const all: Facts[] = [];
    for (let i = 0; i < counted.length; i += CONCURRENCY) {
      all.push(...(await Promise.all(counted.slice(i, i + CONCURRENCY).map((entry) => gather(entry, this.deps, shared)))));
    }
    return overviewOf(all, shared, this.deps, roster.length - counted.length, includeStaff);
  }
}

function readSyncOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the database

/** The part of a better-sqlite3 database the view uses. */
export interface TeamSqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * The three questions, as SQL. A patrol task is one the host seeded: its stored origin is 'system' AND its id starts with `patrol-` (src/task-origin.ts
 * isSystemTaskOfKind, written out here because importing src/teaching-patrol.ts would load the whole database layer). Never the marker in its prompt: a student's own
 * task can carry `[TEACHING_PATROL]`, and was counted as a patrol here, with its runs. (`tai_live.sh patrol` asks by the id prefix alone, because it also runs against
 * a database whose host has not yet added the origin column.)
 */
export function sqliteTeamDb(getDb: () => TeamSqlite, assistantName: string): TeamDb {
  return {
    patrolRuns: (sinceIso) =>
      getDb()
        .prepare(
          `SELECT t.group_folder AS folder, l.run_at AS runAt, l.status AS status, l.result AS result
             FROM task_run_logs l JOIN scheduled_tasks t ON t.id = l.task_id
            WHERE t.origin = 'system' AND substr(t.id, 1, 7) = 'patrol-' AND l.run_at >= ? ORDER BY l.run_at DESC LIMIT 5000`,
        )
        .all(sinceIso) as PatrolRow[],
    patrolCron: () => {
      const row = getDb()
        .prepare(`SELECT schedule_value AS cron FROM scheduled_tasks WHERE origin = 'system' AND substr(id, 1, 7) = 'patrol-' AND schedule_type = 'cron' AND status = 'active' ORDER BY created_at DESC LIMIT 1`)
        .all()[0] as { cron?: unknown } | undefined;
      return typeof row?.cron === 'string' ? row.cron : null;
    },
    lastStudentMessages: () => {
      const rows = getDb()
        .prepare(`SELECT chat_jid AS jid, MAX(timestamp) AS t FROM messages WHERE chat_jid LIKE 'web:%' AND is_bot_message = 0 AND content NOT LIKE ? GROUP BY chat_jid`)
        .all(`${assistantName}:%`) as Array<{ jid: string; t: string | null }>;
      return new Map(rows.flatMap((r) => (typeof r.jid === 'string' && typeof r.t === 'string' ? [[r.jid, r.t] as [string, string]] : [])));
    },
  };
}
