/**
 * Whose data the weekly brief and the three actions made for it (canvas_query week_status and user_contact, github_query activity, piazza_query
 * student_activity) may read. Kept apart from ipc-mcp-stdio.ts, which starts a server when imported, so that every rule here is unit tested.
 *
 * The rule is one: in a student's container (NANOCLAW_IS_MAIN 0: not the admin chat) the student is who the host bound the container to, whatever the
 * model passes. The Canvas user id and the GitHub login come from NANOCLAW_CANVAS_USER_ID and NANOCLAW_GITHUB_USERNAME (the orchestrator sets them from its
 * database; nothing the container can write changes them), and the name and e-mail address Piazza is searched by come from Canvas's record of that bound
 * id. Not from `COMPETENCY.md` (a student's agent can write that file), not from a tool argument, not from an address in a submission. Keyed on
 * isMain and not on "full access": a scheduled task runs in a student's container too, and the student's agent can schedule one.
 *
 * The admin chat may name anybody: a Canvas id, a GitHub login, a student's folder (whose COMPETENCY.md then says who that is: the admin chat's own
 * binding is the admin's, not that student's).
 */

import type { BriefIdentity, RunPy } from './weekly-brief.js';

const DIGITS = /^\d{1,20}$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const CANVAS_NOT_LINKED = 'Your Canvas identity has not been linked yet. Please ask your instructor to run the competency bootstrap, or use /admin to set your Canvas user ID.';
export const PIAZZA_NOT_IDENTIFIED = 'I cannot find your e-mail address or name in Canvas, so I cannot tell which Piazza account is yours.';

export type Scoped<T> = { ok: true; params: T } | { ok: false; message: string };

// ---- who the brief is about ----

/** What a student's COMPETENCY.md says of them: the lines start_mock_interview has always read. */
export interface CompetencyIdentity {
  name?: string;
  canvasUserId?: string;
  githubUsername?: string;
}

export function competencyIdentity(text: string): CompetencyIdentity {
  const out: CompetencyIdentity = {};
  const name = text.match(/^(?:[-*\s]*)?\**(?:Student name|Student|Name)\**:\s*([^\n\r]+)/im);
  if (name) out.name = name[1].trim();
  const canvas = text.match(/Canvas User ID:\s*(\d+)/i);
  if (canvas) out.canvasUserId = canvas[1];
  const github = text.match(/GitHub:\s*(\S+)/i);
  if (github) out.githubUsername = github[1];
  return out;
}

export interface IdentityInputs {
  /** NANOCLAW_IS_MAIN === '1': the admin chat. */
  isMain: boolean;
  groupFolder: string;
  /** The student_folder argument: only the admin chat's is read. */
  studentFolder?: string;
  /** The host's binding (NANOCLAW_CANVAS_USER_ID, NANOCLAW_GITHUB_USERNAME), '' when the student is not linked. */
  bound: { canvasUserId: string; githubUsername: string };
  /** The canvas_user_id and github_username arguments: only the admin chat's are read. */
  args: { canvasUserId?: string; githubUsername?: string };
  /** What a folder's COMPETENCY.md says; only called for the admin chat. */
  readCompetency: (folder: string) => CompetencyIdentity | null;
}

export type ResolvedIdentity = { ok: true; folder: string; identity: BriefIdentity } | { ok: false; message: string };

export function resolveBriefIdentity(input: IdentityInputs): ResolvedIdentity {
  if (!input.isMain) {
    // The binding and nothing else. studentName and email stay empty: Piazza is searched by what Canvas says of the bound id (buildWeekBrief).
    return {
      ok: true,
      folder: input.groupFolder,
      identity: {
        canvasUserId: DIGITS.test(input.bound.canvasUserId) ? input.bound.canvasUserId : '',
        githubUsername: LOGIN.test(input.bound.githubUsername) ? input.bound.githubUsername : '',
        studentName: '',
      },
    };
  }
  const wanted = (input.studentFolder ?? '').trim();
  if (wanted && !FOLDER.test(wanted)) return { ok: false, message: 'student_folder is a folder name only (letters, digits, dot, dash, underscore).' };
  const folder = wanted || input.groupFolder;
  const someoneElse = folder !== input.groupFolder;
  const comp = input.readCompetency(folder) ?? {};
  // explicit argument, then (for the admin's own folder only) the admin chat's binding, then what the folder says
  const canvasUserId = [input.args.canvasUserId, someoneElse ? '' : input.bound.canvasUserId, comp.canvasUserId].map((v) => (v ?? '').trim()).find((v) => DIGITS.test(v)) ?? '';
  const githubUsername = [input.args.githubUsername, someoneElse ? '' : input.bound.githubUsername, comp.githubUsername].map((v) => (v ?? '').trim()).find((v) => LOGIN.test(v)) ?? '';
  return { ok: true, folder, identity: { canvasUserId, githubUsername, studentName: (comp.name ?? '').trim() } };
}

// ---- the actions of the three lookup tools ----

type Params = Record<string, string> | undefined;

/** Canvas actions that are about ONE student and say so with `user_id`. */
const CANVAS_BOUND_ACTIONS: ReadonlySet<string> = new Set(['week_status', 'user_contact']);

/**
 * canvas_query: for week_status and user_contact in a student's container the user is the bound one and the call has no other parameter than
 * assignment_id (week_status's `now` and `budget_seconds` are for tests). A student who is not linked gets a refusal, not somebody's data. Every other
 * action, and the admin chat, are passed on as they are (the tool's own rules for them stay where they were).
 */
export function scopeCanvasParams(action: string, params: Params, ctx: { isMain: boolean; boundCanvasUserId: string }): Scoped<Params> {
  if (ctx.isMain || !CANVAS_BOUND_ACTIONS.has(action)) return { ok: true, params };
  if (!DIGITS.test(ctx.boundCanvasUserId)) return { ok: false, message: CANVAS_NOT_LINKED };
  const assignment = params?.assignment_id ?? '';
  return { ok: true, params: { user_id: ctx.boundCanvasUserId, ...(action === 'week_status' && DIGITS.test(assignment) ? { assignment_id: assignment } : {}) } };
}

/** since and until of a window that was not given: the last seven days up to now. */
export function withWindowDefaults(params: Params, now: Date): Record<string, string> {
  return { ...params, since: params?.since || new Date(now.getTime() - 7 * DAY_MS).toISOString(), until: params?.until || now.toISOString() };
}

const looksLikeEmail = (text: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

export interface PiazzaScopeContext {
  isMain: boolean;
  boundCanvasUserId: string;
  now: Date;
  runPy: RunPy;
}

/**
 * piazza_query: for student_activity in a student's container the e-mail address and name Piazza is searched by are Canvas's, for the bound user id
 * (canvas_api.py user_contact): whatever `email`, `emails`, `name` or `uid` the model passed is dropped. A student who is not linked, or whom Canvas
 * gives neither address nor name, is refused. The admin chat names the person itself. since and until default to the last seven days. Every other
 * action is passed on as it is.
 */
export async function scopePiazzaParams(action: string, params: Params, ctx: PiazzaScopeContext): Promise<Scoped<Params>> {
  if (action !== 'student_activity') return { ok: true, params };
  const windowed = withWindowDefaults(params, ctx.now);
  if (ctx.isMain) return { ok: true, params: windowed };
  if (!DIGITS.test(ctx.boundCanvasUserId)) return { ok: false, message: CANVAS_NOT_LINKED };
  let contact: Record<string, unknown> = {};
  try {
    const answer = await ctx.runPy('canvas_api.py', { action: 'user_contact', params: { user_id: ctx.boundCanvasUserId } });
    if (answer && typeof answer === 'object' && !Array.isArray(answer) && !('error' in answer)) contact = answer as Record<string, unknown>;
  } catch {
    /* no contact: refused below */
  }
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const emails = [text(contact.email), text(contact.login_id)].filter((e, i, all) => looksLikeEmail(e) && all.indexOf(e) === i);
  const name = text(contact.name);
  if (emails.length === 0 && !name) return { ok: false, message: PIAZZA_NOT_IDENTIFIED };
  return {
    ok: true,
    params: {
      since: windowed.since,
      until: windowed.until,
      ...(params?.limit ? { limit: params.limit } : {}),
      ...(emails[0] ? { email: emails[0] } : {}),
      ...(emails.length > 1 ? { emails: emails.slice(1).join(',') } : {}),
      ...(name ? { name } : {}),
    },
  };
}
