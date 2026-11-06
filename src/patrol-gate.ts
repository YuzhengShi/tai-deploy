/**
 * The teaching patrol's gate. Every weekday morning each student has a patrol task; running it starts a container and a model that reads the student's
 * files and the course status, about 200,000 input tokens of it, and it finds nothing to do on nine days out of ten. This decides, with code and no model,
 * whether a student's patrol needs the model today. Nothing here starts a container or calls a model.
 *
 * The rule: the model runs when something NEW has appeared since it last looked, or when the weekly full check is due.
 *   - new: a Canvas deadline of this student's whose patrol is the last before it, or that passed half a day ago, with nothing turned in; a misconception
 *     confirmed and not resolved; concepts that were solid and have gone unconfirmed for two weeks; the student gone quiet for five days.
 *   - weekly: the triggers code cannot see (their GitHub, Piazza, this week's topic, the mock interview) get one look a week whatever else is true.
 * "New" is measured against the signals of the last run the model finished, so a state that lasts (a student who stays quiet, a misconception that waits
 * for them to come back) costs one run, not one a day. A run that failed is not recorded, so the next day looks again.
 *
 * Fail-open: what code cannot read (no Canvas snapshot, a COMPETENCY.md in a shape it does not know) is itself a signal, and every error means "run".
 * Nothing a student wrote reaches the note given to the model: the note holds ids, counts and hours only.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, STORE_DIR, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { readTextSafe, realDirInside } from './safe-fs.js';
import { readStudentSnapshot, type Snapshot } from './student-course.js';
import { misconceptionFields, parseMastery, parseMisconceptions } from './voice/competency.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A Canvas snapshot older than this is not looked at (the job that makes it runs every six hours). */
export const SNAPSHOT_MAX_AGE_HOURS = 48;
/** A deadline that has just passed is not "late" yet: students submit at 8:59. Half a day, and then for three days. */
export const LATE_AFTER_HOURS = 12;
export const LATE_UNTIL_HOURS = 72;
/** Without a patrol schedule to measure against, a deadline within this many hours is taken as "the last chance". */
const LAST_CHANCE_FALLBACK_HOURS = 48;
/** After this long quiet the weekly check is the only one: a student who has gone for three weeks is not nudged every few days. */
export const GIVE_UP_DAYS = 21;
/** Concepts with no evidence for this long that were solid (confidence above 0.7) but never well confirmed (stability below 0.3). */
export const SPACED_DAYS = 14;
/** The cron fires at 9:00 and the run a week ago ended a little after it. */
const FLOOR_SLACK_HOURS = 2;
/** A COMPETENCY.md this long with no mastery line code can read is in a shape code does not know. */
const UNREADABLE_AT_CHARS = 400;

export type GateMode = 'on' | 'shadow' | 'off';

export interface GateConfig {
  /** on: skips what needs no model. shadow: decides and logs, and the model runs anyway (to see what the gate would do before it does it). off: as before. */
  mode: GateMode;
  inactiveDays: number;
  /** Days between full checks (0: none, only a new signal runs the model). */
  floorDays: number;
}

function numberOf(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** TAI_PATROL_GATE (on|shadow|off, default on), TAI_PATROL_INACTIVE_DAYS (5), TAI_PATROL_FLOOR_DAYS (7). */
export function gateConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const mode = (env.TAI_PATROL_GATE ?? 'on').trim().toLowerCase();
  return {
    mode: mode === 'off' || mode === '0' || mode === 'false' ? 'off' : mode === 'shadow' ? 'shadow' : 'on',
    inactiveDays: numberOf(env.TAI_PATROL_INACTIVE_DAYS, 5, 1, 60),
    floorDays: numberOf(env.TAI_PATROL_FLOOR_DAYS, 7, 0, 60),
  };
}

// ---------------------------------------------------------------- what is known

export interface OpenAssignment {
  id: string;
  dueAt: string;
}

export interface CanvasFacts {
  /** none: no Canvas id for this student. unavailable: no snapshot, or one too old: code cannot see their deadlines. ok: `open` is what they have not turned in. */
  state: 'none' | 'unavailable' | 'ok';
  open: OpenAssignment[];
}

export interface PatrolFacts {
  now: Date;
  registeredAt: Date | null;
  /** The last message or call of the student's that code can see. */
  lastActive: Date | null;
  competency: string | null;
  canvas: CanvasFacts;
  /** When this student's next patrol runs after this one; null when unknown. */
  nextPatrol: Date | null;
  /** The signals of the last run of the model that finished, and when. */
  last: { at: Date; keys: string[] } | null;
}

export type SignalKind = 'due-last' | 'due-late' | 'canvas-unknown' | 'inactive' | 'misconception' | 'spaced' | 'competency-unknown';

export interface Signal {
  kind: SignalKind;
  /** What "new" is measured by: the same state has the same key from one day to the next. */
  key: string;
  /** The one number the note tells: hours, days or how many. */
  n: number;
  /** The Canvas assignment id, for the two that are about one. */
  id?: string;
}

export interface GateDecision {
  mode: GateMode;
  run: boolean;
  /** Why, for the log: ids, counts and dates, never a student's words. */
  reasons: string[];
  signals: Signal[];
  /** Every signal's key now: what is kept when the model runs. */
  keys: string[];
  /** The weekly full check is due. */
  weekly: boolean;
  /** False when code could not look (the gate is off, or an error): nothing is kept of such a decision. */
  recordable: boolean;
}

// ---------------------------------------------------------------- the signals

const hashOf = (items: string[]): string => crypto.createHash('sha1').update([...items].sort().join('\n')).digest('hex').slice(0, 8);

function canvasSignals(facts: PatrolFacts): Signal[] {
  const { canvas, now, nextPatrol } = facts;
  if (canvas.state === 'unavailable') return [{ kind: 'canvas-unknown', key: 'canvas-unknown', n: 0 }];
  const out: Signal[] = [];
  for (const a of canvas.open) {
    const due = Date.parse(a.dueAt);
    if (!Number.isFinite(due)) continue;
    const dueIn = due - now.getTime();
    if (dueIn > 0) {
      // the last patrol before the deadline is the last chance to say anything: no patrol runs on a weekend, so for Monday 9:00 that patrol is Friday's
      const lastChance = nextPatrol ? due <= nextPatrol.getTime() : dueIn <= LAST_CHANCE_FALLBACK_HOURS * HOUR;
      if (lastChance) out.push({ kind: 'due-last', key: `due-last:${a.id}`, n: Math.max(1, Math.round(dueIn / HOUR)), id: a.id });
    } else {
      const lateBy = -dueIn;
      if (lateBy >= LATE_AFTER_HOURS * HOUR && lateBy <= LATE_UNTIL_HOURS * HOUR) {
        out.push({ kind: 'due-late', key: `due-late:${a.id}`, n: Math.round(lateBy / HOUR), id: a.id });
      }
    }
  }
  return out;
}

function inactiveSignal(facts: PatrolFacts, cfg: GateConfig): Signal | null {
  const since = facts.lastActive ?? facts.registeredAt;
  if (!since) return null;
  const days = (facts.now.getTime() - since.getTime()) / DAY;
  const giveUp = Math.max(GIVE_UP_DAYS, cfg.inactiveDays + 16);
  if (days < cfg.inactiveDays || days >= giveUp) return null;
  return { kind: 'inactive', key: 'inactive', n: Math.floor(days) };
}

const DATE = /(\d{4})-(\d{2})-(\d{2})/;

function daysSince(text: string, now: Date): number {
  const m = DATE.exec(text);
  if (!m) return -1;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? (now.getTime() - t) / DAY : -1;
}

/** A closed misconception says so in a field of its own; the words "not yet resolved" in the remediation notes do not close it. */
export const CLOSED = /status\s*:\s*(?:remediated|resolved)\b|\|\s*(?:remediated|resolved)\s*(?:\||$)|effective\s*:\s*true\b/i;
export const IDENTIFYING = /\|\s*identifying\s*(?:\||$)/i;

// (exported so that the teaching-team view, src/portal/team.ts, classifies a line the way the patrol does)
export function isOpenAndConfirmed(line: string): boolean {
  // the fields after the quoted belief only: the belief is a student's near-words, and "status: confirmed" in it is not the line's status
  const fields = misconceptionFields(line);
  if (CLOSED.test(fields) || IDENTIFYING.test(fields)) return false;   // discussing a misconception correctly is not holding it
  const freq = Number(/\bfreq(?:uency)?\s*:\s*(\d+)/i.exec(fields)?.[1] ?? 0);
  return /\bstatus\s*:\s*confirmed\b/i.test(fields) || freq >= 3;
}

function competencySignals(text: string | null, now: Date): Signal[] {
  if (!text) return [];
  const out: Signal[] = [];
  const mastery = parseMastery(text);
  if (mastery.length === 0 && text.length >= UNREADABLE_AT_CHARS) out.push({ kind: 'competency-unknown', key: 'competency-unknown', n: 0 });
  const confirmed = parseMisconceptions(text).filter((m) => isOpenAndConfirmed(m.line));
  if (confirmed.length > 0) out.push({ kind: 'misconception', key: `misconception:${hashOf(confirmed.map((m) => m.belief))}`, n: confirmed.length });
  const fading = mastery.filter((e) => e.confidence > 0.7 && e.stability < 0.3 && daysSince(e.last, now) >= SPACED_DAYS);
  if (fading.length > 0) out.push({ kind: 'spaced', key: `spaced:${hashOf(fading.map((e) => e.name))}`, n: fading.length });
  return out;
}

// ---------------------------------------------------------------- the decision

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** What the gate says when it is off or could not look: run, as the patrol always did, and keep nothing of it. */
function runAnyway(mode: GateMode, reason: string): GateDecision {
  return { mode, run: true, reasons: [reason], signals: [], keys: [], weekly: false, recordable: false };
}

/** Whether the model needs to run today. Pure: everything it reads is in `facts`. */
export function evaluateGate(facts: PatrolFacts, cfg: GateConfig): GateDecision {
  if (cfg.mode === 'off') return runAnyway('off', 'the gate is off (TAI_PATROL_GATE=off)');
  const inactive = inactiveSignal(facts, cfg);
  const signals: Signal[] = [...canvasSignals(facts), ...(inactive ? [inactive] : []), ...competencySignals(facts.competency, facts.now)];
  const keys = signals.map((s) => s.key);
  const known = new Set(facts.last?.keys ?? []);
  const fresh = signals.filter((s) => !known.has(s.key));
  const since = facts.last?.at ?? facts.registeredAt;
  const weekly = cfg.floorDays > 0 && (since === null || facts.now.getTime() - since.getTime() >= cfg.floorDays * DAY - FLOOR_SLACK_HOURS * HOUR);
  const run = fresh.length > 0 || weekly;
  const reasons: string[] = [];
  if (fresh.length > 0) reasons.push(`new since the model last looked: ${fresh.map((s) => s.key).join(', ')}`);
  if (weekly) reasons.push(facts.last ? `the weekly full check is due (the model last looked ${dayOf(facts.last.at)})` : 'the weekly full check is due (the model has not looked yet)');
  if (!run) {
    const next = since && cfg.floorDays > 0 ? `; the weekly full check is due ${dayOf(new Date(since.getTime() + cfg.floorDays * DAY))}` : '';
    reasons.push(`nothing new since the model last looked (${facts.last ? dayOf(facts.last.at) : 'never'})${keys.length ? `; still open: ${keys.join(', ')}` : ''}${next}`);
  }
  return { mode: cfg.mode, run, reasons, signals, keys, weekly, recordable: true };
}

/** What the model is told when it runs: ids, counts and hours, and nothing that a student wrote. */
export function gateNote(decision: GateDecision): string {
  const lines: string[] = [];
  for (const s of decision.signals) {
    switch (s.kind) {
      case 'due-last':
        lines.push(`- Canvas assignment ${s.id}: due in about ${s.n} hours, before the next patrol, and Canvas showed no submission from this student: this is the last patrol before the deadline (check with canvas_query, action "submissions").`);
        break;
      case 'due-late':
        lines.push(`- Canvas assignment ${s.id}: was due about ${s.n} hours ago and Canvas showed no submission from this student (check with canvas_query; if it still holds, a gentle check-in, not nagging).`);
        break;
      case 'canvas-unknown':
        lines.push('- The Canvas snapshot that code reads is missing or out of date, so code did not check this student\'s deadlines: check Canvas yourself.');
        break;
      case 'inactive':
        lines.push(`- No message or call from this student for ${s.n} days.`);
        break;
      case 'misconception':
        lines.push(`- COMPETENCY.md lists ${s.n} confirmed misconception${s.n === 1 ? '' : 's'} that ${s.n === 1 ? 'is' : 'are'} not marked resolved.`);
        break;
      case 'spaced':
        lines.push(`- ${s.n} concept${s.n === 1 ? '' : 's'} in COMPETENCY.md ${s.n === 1 ? 'was' : 'were'} solid but never well confirmed and ${s.n === 1 ? 'has' : 'have'} had no evidence for ${SPACED_DAYS}+ days: a spaced review is due.`);
        break;
      case 'competency-unknown':
        lines.push('- COMPETENCY.md is in a shape code could not read, so code did not check it: read it carefully.');
        break;
    }
  }
  if (decision.weekly) lines.push('- Weekly full check: go through every trigger below, including the ones code cannot see (GitHub, Piazza, this week\'s topic, the mock interview).');
  return [
    'WHY YOU ARE RUNNING NOW (worked out by code from this student\'s records; it only decides WHEN a patrol needs you: whether to reach out is still your judgment, and the triggers below still apply):',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------- what was last looked at

export const PATROL_GATE_FILE = path.join(STORE_DIR, 'patrol-gate.json');

type GateState = Record<string, { at: string; keys: string[] }>;

export function readGateState(file: string = PATROL_GATE_FILE): GateState {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { groups?: unknown };
    return data && typeof data.groups === 'object' && data.groups !== null && !Array.isArray(data.groups) ? (data.groups as GateState) : {};
  } catch {
    return {};
  }
}

/** Kept when the model finished a run, so that tomorrow "new" means new since this. Only ids and hashes. */
export function recordPatrolRun(folder: string, decision: GateDecision, now: Date, file: string = PATROL_GATE_FILE): void {
  if (!decision.recordable) return;
  const groups = readGateState(file);
  groups[folder] = { at: now.toISOString(), keys: decision.keys };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ groups }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- reading the facts

export function canvasFacts(canvasUserId: string | undefined, snap: { at: string; snapshot: Snapshot } | null, now: Date): CanvasFacts {
  if (!canvasUserId) return { state: 'none', open: [] };
  const taken = snap ? Date.parse(snap.at) : NaN;
  if (!snap || !Number.isFinite(taken) || now.getTime() - taken > SNAPSHOT_MAX_AGE_HOURS * HOUR) return { state: 'unavailable', open: [] };
  const open: OpenAssignment[] = [];
  for (const [id, s] of Object.entries(snap.snapshot[canvasUserId] ?? {})) {
    // only what is turned in on Canvas, not excused, with a due date (a snapshot from before the dates were kept has none: nothing to judge)
    if (s.state === 'unsubmitted' && s.submittable === true && s.excused !== true && typeof s.dueAt === 'string') open.push({ id, dueAt: s.dueAt });
  }
  return { state: 'ok', open };
}

function dateOf(iso: string | undefined | null): Date | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** A file of a student's folder, which their container can write: a regular file only, never a link, a FIFO or one over 2 MB (src/safe-fs.ts). */
function readText(file: string, root: string): string | null {
  return readTextSafe(file, undefined, root);
}

/** When a file of a student's folder last changed; null for a link, a directory or nothing (the container could point a link at any file of the host). */
function mtimeOf(file: string, root: string): Date | null {
  try {
    if (realDirInside(path.dirname(file), root) === null) return null;
    const info = fs.lstatSync(file);
    return info.isFile() ? info.mtime : null;
  } catch {
    return null;
  }
}

export function nextPatrolAfter(cron: string, from: Date): Date | null {
  try {
    return CronExpressionParser.parse(cron, { tz: TIMEZONE, currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

export interface GateDeps {
  now?: () => Date;
  groupsDir?: string;
  stateFile?: string;
  snapshot?: () => { at: string; snapshot: Snapshot } | null;
  /** The ISO time of the last message in the chat that TAi did not write (the database). */
  lastStudentMessage?: (chatJid: string) => string | undefined;
  nextPatrol?: (cron: string, from: Date) => Date | null;
  env?: NodeJS.ProcessEnv;
}

export interface GateTask {
  chat_jid: string;
  group_folder: string;
  schedule_value: string;
}

export interface GateGroup {
  added_at?: string;
  canvasUserId?: string;
}

export function gatherFacts(task: GateTask, group: GateGroup, deps: GateDeps = {}): PatrolFacts {
  const now = (deps.now ?? (() => new Date()))();
  const dir = path.join(deps.groupsDir ?? GROUPS_DIR, task.group_folder);
  const message = dateOf(deps.lastStudentMessage?.(task.chat_jid));
  const call = mtimeOf(path.join(dir, 'competency', 'voice-sessions.md'), dir);     // written when a voice call ends
  const lastActive = [message, call].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const state = readGateState(deps.stateFile ?? PATROL_GATE_FILE)[task.group_folder];
  const lastAt = dateOf(state?.at);
  return {
    now,
    registeredAt: dateOf(group.added_at),
    lastActive,
    competency: readText(path.join(dir, 'COMPETENCY.md'), dir),
    canvas: canvasFacts(group.canvasUserId, (deps.snapshot ?? (() => readStudentSnapshot()))(), now),
    nextPatrol: (deps.nextPatrol ?? nextPatrolAfter)(task.schedule_value, now),
    last: lastAt && Array.isArray(state?.keys) ? { at: lastAt, keys: state.keys.filter((k) => typeof k === 'string') } : null,
  };
}

/** The whole gate for one patrol run. Never throws: whatever goes wrong, the patrol runs as it always did. */
export function gatePatrol(task: GateTask, group: GateGroup, deps: GateDeps = {}): GateDecision {
  const cfg = gateConfig(deps.env);
  if (cfg.mode === 'off') return runAnyway('off', 'the gate is off (TAI_PATROL_GATE=off)');
  try {
    return evaluateGate(gatherFacts(task, group, deps), cfg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, folder: task.group_folder }, 'Patrol gate: could not decide, so the patrol runs');
    return runAnyway(cfg.mode, `the gate could not decide (${message.slice(0, 120)}), so the patrol runs`);
  }
}
