/**
 * What changed in a student's own standing in the course, for their activity list: a grade posted (or changed), an assignment Canvas has
 * marked missing, and an assignment that is due within 24 hours and that Canvas has no submission for. The class-wide changes (an
 * announcement, a file, a deadline that moved) are src/course-updates.ts; these are one student's.
 *
 * ONE Canvas call from the orchestrator reads the submissions of the whole class (`students/submissions?student_ids[]=all`, with the
 * assignment: the token is the instructor's, as for COURSE_STATUS.md; the same call the `grades` action of canvas_query makes), and the
 * result is mapped to the page's students by the Canvas user id of the allowlist. Nothing here starts a container or a model. What is kept
 * between two calls is a flag and a time per student and assignment (no score, no name); what is told goes to that student's own history and
 * nobody else's. The first call only makes the baseline: a term's worth of grades is not news.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import type { CourseUpdate } from './course-updates.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface Submission {
  userId: string;
  assignmentId: string;
  name: string;
  /** The student's own due date when Canvas has one (an extension), else the assignment's. */
  dueAt?: string;
  points?: number;
  state: string;
  submittedAt?: string;
  gradedAt?: string;
  /** When the grade became visible to the student (Canvas can grade and hold the grades back): what a student is told of is never before it. */
  postedAt?: string;
  score?: number;
  missing: boolean;
  excused: boolean;
  /** A student turns it in on Canvas (an upload, a URL, text, a recording, a quiz): "no submission" means something. Gradescope or paper do not. */
  submittable: boolean;
}

const ONLINE = new Set(['online_upload', 'online_url', 'online_text_entry', 'media_recording', 'online_quiz']);

const oneLine = (text: unknown, max: number): string => {
  const flat = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
};
const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);

/** The rows Canvas answers with, as far as they are a student's submission of a published assignment; anything else is left out. */
export function parseSubmissions(rows: unknown): Submission[] {
  if (!Array.isArray(rows)) return [];
  const out: Submission[] = [];
  for (const raw of rows as Array<Record<string, unknown>>) {
    const a = (raw?.assignment ?? null) as Record<string, unknown> | null;
    const userId = raw?.user_id != null ? String(raw.user_id) : '';
    const assignmentId = raw?.assignment_id != null ? String(raw.assignment_id) : '';
    if (!userId || !assignmentId || !a || typeof a.name !== 'string' || a.published === false || raw.workflow_state === 'deleted') continue;
    const types = Array.isArray(a.submission_types) ? (a.submission_types as unknown[]) : [];
    out.push({
      userId,
      assignmentId,
      name: oneLine(a.name, 80),
      dueAt: str(raw.cached_due_date) ?? str(a.due_at),
      points: typeof a.points_possible === 'number' ? a.points_possible : undefined,
      state: str(raw.workflow_state) ?? 'unsubmitted',
      submittedAt: str(raw.submitted_at),
      gradedAt: str(raw.graded_at),
      postedAt: str(raw.posted_at),
      score: typeof raw.score === 'number' ? raw.score : undefined,
      missing: raw.missing === true,
      excused: raw.excused === true,
      submittable: types.some((t) => typeof t === 'string' && ONLINE.has(t)),
    });
  }
  return out;
}

export interface FetchConfig {
  /** The API root, as CANVAS_BASE_URL has it ("https://school.instructure.com/api/v1"). */
  baseUrl: string;
  token: string;
  courseId: string;
  fetchImpl?: typeof fetch;
  /** Pages of 100 at most (a class of 80 and fifteen assignments is twelve). */
  maxPages?: number;
}

/** All the class's submissions, every page. Throws a short reason (never the token) when Canvas cannot be read. */
export async function fetchSubmissions(cfg: FetchConfig): Promise<Submission[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const root = cfg.baseUrl.replace(/\/+$/, '');
  const origin = new URL(root).origin;
  let url: string | null = `${root}/courses/${encodeURIComponent(cfg.courseId)}/students/submissions?student_ids[]=all&include[]=assignment&per_page=100`;
  const out: Submission[] = [];
  for (let page = 0; url && page < (cfg.maxPages ?? 60); page++) {
    const res: Response = await doFetch(url, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Canvas answered ${res.status}`);
    out.push(...parseSubmissions(await res.json()));
    const next: RegExpExecArray | null = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
    // the token goes to Canvas and nowhere else: a next page on another host is not followed
    url = next && new URL(next[1]).origin === origin ? next[1] : null;
  }
  return out;
}

/** What is kept of one submission between two calls: no score and no name. */
export interface SubState {
  state: string;
  gradedAt?: string;
  postedAt?: string;
  missing: boolean;
  /** The student has been told the assignment is due soon and not submitted. */
  reminded?: boolean;
  /** When it is due for this student, and whether it is turned in on Canvas and not excused: what the teaching patrol's gate (src/patrol-gate.ts) needs to know of a deadline. */
  dueAt?: string;
  submittable?: boolean;
  excused?: boolean;
}
export type Snapshot = Record<string, Record<string, SubState>>;

const bits = new RegExp(`[${String.fromCharCode(0x202f, 0xa0)}]`, 'g');

/** "Mon Nov 9, 9:00 AM PST": the course keeps Pacific time. '' for no date. */
export function pacificTime(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  return new Date(t)
    .toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .replace(bits, ' ')
    .replace(/^(\w{3}),/, '$1');
}

const number = (n: number): string => String(Math.round(n * 100) / 100);

const PLURAL: Record<string, string> = {
  'Grade posted': 'Grades posted',
  'Grade updated': 'Grades updated',
  'Marked missing': 'Marked missing',
  'Due soon · not submitted yet': 'Due soon · not submitted yet',
};
const MAX_PER_KIND = 3;

/** Four of one kind for one student in one call are one line naming how many. */
function capped(list: CourseUpdate[]): CourseUpdate[] {
  const out: CourseUpdate[] = [];
  for (const title of new Set(list.map((u) => u.title))) {
    const same = list.filter((u) => u.title === title);
    if (same.length <= MAX_PER_KIND) out.push(...same);
    else out.push({ title: PLURAL[title] ?? title, text: `${same.length} assignments`, detail: same.map((u) => u.text).join('\n') });
  }
  return out;
}

/**
 * What the new submissions say compared to the last snapshot: per Canvas user id the updates, and the snapshot to keep. `prev` null is the first
 * call (the baseline: no grade and no "missing" is news; a deadline within 24 hours still is, once). A student, or an assignment of a student, that
 * the last snapshot did not know is a baseline too (a student who has just joined has all their old grades at once). An answer with no
 * submissions in it is Canvas failing, not a class with nothing in it: the old snapshot stays.
 */
export function studentUpdates(prev: Snapshot | null, subs: Submission[], now: Date): { next: Snapshot; updates: Map<string, CourseUpdate[]> } {
  const updates = new Map<string, CourseUpdate[]>();
  if (subs.length === 0 && prev) return { next: prev, updates };
  const next: Snapshot = {};
  const soon = now.getTime() + 24 * 3_600_000;
  for (const s of subs) {
    const before = prev?.[s.userId]?.[s.assignmentId];
    const out: CourseUpdate[] = [];
    if (before && !s.excused) {
      // a grade is news when it becomes visible to the student (posted), or changes after that: a grade Canvas holds back is not told
      const posted = s.state === 'graded' && !!s.postedAt && !!s.gradedAt;
      const becameVisible = posted && !before.postedAt;
      const changed = posted && !!before.postedAt && s.gradedAt !== before.gradedAt;
      if (becameVisible || changed) {
        const score = s.score !== undefined && s.points ? ` · ${number(s.score)}/${number(s.points)}` : ' · graded';
        out.push({ title: becameVisible ? 'Grade posted' : 'Grade updated', text: `${s.name}${score}`, detail: 'The score and the comments are in Canvas.' });
      }
      // only of what is turned in on Canvas and has no submission at all: for Gradescope or paper "missing" says nothing, and a row that has a
      // submission or a grade (Canvas keeps the flag on some of those) must not say "no submission from you"
      if (s.missing && !before.missing && s.submittable && s.state === 'unsubmitted' && !s.submittedAt) {
        const due = pacificTime(s.dueAt);
        out.push({
          title: 'Marked missing',
          text: due ? `${s.name} · was due ${due}` : s.name,
          detail: 'Canvas has no submission from you for this assignment. If that is a mistake, tell the teaching team.',
        });
      }
    }
    let reminded = before?.reminded === true;
    const due = s.dueAt ? Date.parse(s.dueAt) : NaN;
    if (!reminded && s.submittable && !s.excused && s.state === 'unsubmitted' && !s.submittedAt && Number.isFinite(due) && due > now.getTime() && due <= soon) {
      out.push({ title: 'Due soon · not submitted yet', text: `${s.name} · due ${pacificTime(s.dueAt)}`, detail: 'Canvas has no submission from you yet.' });
      reminded = true;
    }
    (next[s.userId] ??= {})[s.assignmentId] = {
      state: s.state,
      ...(s.gradedAt ? { gradedAt: s.gradedAt } : {}),
      ...(s.postedAt ? { postedAt: s.postedAt } : {}),
      missing: s.missing,
      ...(reminded ? { reminded: true } : {}),
      ...(s.dueAt ? { dueAt: s.dueAt } : {}),
      ...(s.submittable ? { submittable: true } : {}),
      ...(s.excused ? { excused: true } : {}),
    };
    // a student the last snapshot did not know has no grade or "missing" to compare: only the deadline reminder above can have said something
    if (out.length > 0) updates.set(s.userId, [...(updates.get(s.userId) ?? []), ...out]);
  }
  for (const [user, list] of updates) updates.set(user, capped(list));
  return { next, updates };
}

// ---------------------------------------------------------------- the job

export type StudentCourseResult = 'baseline' | 'delivered' | 'unchanged' | 'skipped' | 'failed';

export interface StudentCourseDeps {
  /** Told of one student's updates: the Canvas user id, and what to put in their activity list. Never allowed to fail the job. */
  deliver: (canvasUserId: string, updates: CourseUpdate[]) => void;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  file?: string;
  readSecrets?: () => Record<string, string | undefined>;
}

export const STUDENT_COURSE_FILE = path.join(STORE_DIR, 'student-course.json');

function readSnapshot(file: string): Snapshot | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { snapshot?: unknown };
    return data && typeof data.snapshot === 'object' && data.snapshot !== null ? (data.snapshot as Snapshot) : null;
  } catch {
    return null;
  }
}

/** The snapshot and when it was taken, for the teaching patrol's gate; null when there is none or it cannot be read. */
export function readStudentSnapshot(file: string = STUDENT_COURSE_FILE): { at: string; snapshot: Snapshot } | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { at?: unknown; snapshot?: unknown };
    if (!data || typeof data.at !== 'string' || typeof data.snapshot !== 'object' || data.snapshot === null) return null;
    return { at: data.at, snapshot: data.snapshot as Snapshot };
  } catch {
    return null;
  }
}

function writeSnapshot(file: string, snapshot: Snapshot, now: Date): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ at: now.toISOString(), snapshot }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** One look at Canvas. Never throws: the job must not take the orchestrator down. */
export async function refreshStudentCourse(deps: StudentCourseDeps): Promise<StudentCourseResult> {
  const secrets = (deps.readSecrets ?? (() => readEnvFile(['CANVAS_API_TOKEN', 'CANVAS_BASE_URL', 'CANVAS_COURSE_ID'])))();
  if (!secrets.CANVAS_API_TOKEN || !secrets.CANVAS_BASE_URL || !secrets.CANVAS_COURSE_ID) {
    logger.info('Student course: Canvas is not configured, nothing to look at');
    return 'skipped';
  }
  const now = (deps.now ?? (() => new Date()))();
  const file = deps.file ?? STUDENT_COURSE_FILE;
  try {
    const subs = await fetchSubmissions({ baseUrl: secrets.CANVAS_BASE_URL, token: secrets.CANVAS_API_TOKEN, courseId: secrets.CANVAS_COURSE_ID, fetchImpl: deps.fetchImpl });
    if (subs.length === 0) {
      logger.warn('Student course: Canvas gave no submissions: the snapshot is kept as it was');
      return 'failed';
    }
    const prev = readSnapshot(file);
    const { next, updates } = studentUpdates(prev, subs, now);
    writeSnapshot(file, next, now);                      // before the telling: a crash in between loses an update and never says one twice
    let told = 0;
    for (const [user, list] of updates) {
      try {
        deps.deliver(user, list);
        told += list.length;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Student course: could not put an update in a student\'s activity list');
      }
    }
    logger.info({ students: Object.keys(next).length, submissions: subs.length, told, baseline: prev === null }, 'Student course: looked');
    return prev === null ? 'baseline' : told > 0 ? 'delivered' : 'unchanged';
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Student course: Canvas could not be read');
    return 'failed';
  }
}

/** Looks three minutes after start and then every `hours` (TAI_STUDENT_COURSE_HOURS, default 6; 0 turns it off). Returns how to stop it. */
export function startStudentCourseJob(env: NodeJS.ProcessEnv, deps: StudentCourseDeps): () => void {
  const hours = parseFloat(env.TAI_STUDENT_COURSE_HOURS ?? '6');
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.info('Student course job is off (TAI_STUDENT_COURSE_HOURS=0)');
    return () => undefined;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await refreshStudentCourse(deps);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 180_000);
  const every = setInterval(() => void tick(), Math.max(hours, 0.05) * 3_600_000);
  first.unref();
  every.unref();
  logger.info({ hours }, 'Student course job started');
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
