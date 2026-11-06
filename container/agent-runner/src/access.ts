/**
 * Who a container's tools may show what, and the decisions that hang on it. Kept apart from ipc-mcp-stdio.ts, which starts a server when it is imported, so that
 * every row of the access table is a unit test (test/access.test.ts). Two things are decided, and they are not the same thing:
 *
 * 1. WHOSE DATA. The admin chat (NANOCLAW_IS_MAIN=1, which the host sets from the group's folder) is the instructor's and may ask about the whole class. EVERY other
 *    container is bound to the one student it serves: a student's chat, a task an agent scheduled, and the host's own tasks (the patrol, the bootstrap), which run in a
 *    student's group. Their Canvas user, their GitHub account and the course organisations, and nothing that lists the class (canvas_query grades, users and
 *    submissions; github_query for another owner; set_student_identity). The host's own tasks are NOT an exception: with `context_mode: group` they run in the student's
 *    own session, which the student resumes in the next chat turn, so what they read is in front of the student; and a prompt that says a tool "only shows this student"
 *    is not a gate (the patrol's said so about `submissions`, which lists the class). These rules are keyed on `isMain` and on nothing else.
 *
 * 2. WHICH TOOL LIMITS. The per-session limits of the expensive tools are lifted for the admin chat and for a SYSTEM task: NANOCLAW_IS_SCHEDULED_TASK=1 and
 *    NANOCLAW_IS_SYSTEM_TASK=1 together, which the host sets only for a task it made itself (src/task-origin.ts). A scheduled task alone is not enough: it was, and every
 *    scheduled task counted as the admin's, so a student's agent could schedule one with a prompt of its choosing (`schedule_task`, or a file in its own IPC directory).
 *    A task an agent scheduled is still a scheduled task (its answer is never sent to the student, only what it says through send_message), with the student's limits.
 *
 * Fail closed in every direction: only the text "1" is a yes; the system flag means nothing without the task flag; a host that does not send the system flag (an older
 * one) lifts no limit for a task, and an image from before this file ignores the flag, which is why the image is rebuilt with the host.
 */

import { checkGithubParams } from './github-access.js';

export interface AccessFlags {
  /** The admin chat. */
  isMain: boolean;
  /** Started by the scheduler, whoever made the task. */
  isScheduledTask: boolean;
  /** With isScheduledTask: the host made the task itself. */
  isSystemTask: boolean;
}

/** The flags as the nanoclaw MCP server's environment carries them (mcp-servers.ts sets them from the host's ContainerInput). */
export function accessFlagsFromEnv(env: Record<string, string | undefined>): AccessFlags {
  return {
    isMain: env['NANOCLAW_IS_MAIN'] === '1',
    isScheduledTask: env['NANOCLAW_IS_SCHEDULED_TASK'] === '1',
    isSystemTask: env['NANOCLAW_IS_SYSTEM_TASK'] === '1',
  };
}

/** The same flags from the ContainerInput the host wrote on stdin (the voice tool host reads it directly). */
export function accessFlagsFromInput(input: { isMain?: boolean; isScheduledTask?: boolean; isSystemTask?: boolean }): AccessFlags {
  return {
    isMain: input.isMain === true,
    isScheduledTask: input.isScheduledTask === true,
    isSystemTask: input.isSystemTask === true,
  };
}

/**
 * Whether the per-session tool limits are lifted: the admin chat, or a task that is both scheduled and the host's own. This is ALL it decides now. It used to decide
 * the data a container could read as well ("full access"); that is `isMain`'s alone (see the header), and the name says what is left.
 */
export function liftsToolLimits(flags: AccessFlags): boolean {
  return flags.isMain || (flags.isScheduledTask && flags.isSystemTask);
}

// ---- canvas_query ----

/**
 * Actions that list the class, refused to every container that is not the admin chat, the host's own tasks included: `submissions` is one assignment's rows for EVERY
 * student (user id, name, score, grade), `grades` every student's submissions, `users` the roster with e-mail addresses. Nothing here filters rows: a class listing
 * that is filtered after Canvas has answered is one bug from being the whole class, so it is not asked for at all.
 */
export const CANVAS_RESTRICTED_ACTIONS: ReadonlySet<string> = new Set(['grades', 'users', 'submissions']);
/** Actions that are about one student and say so with `user_id`: outside the admin chat the user is the one the host bound, whatever the model passes. */
export const CANVAS_IDENTITY_ACTIONS: ReadonlySet<string> = new Set(['student_submission', 'my_grades']);

export const CANVAS_IDENTITY_NOT_LINKED = 'Your Canvas identity has not been linked yet. Please ask your instructor to run the competency bootstrap, or use /admin to set your Canvas user ID.';

export type CanvasAccess = { ok: true; params: Record<string, string> | undefined } | { ok: false; message: string };

/**
 * canvas_query's access rule. The admin chat's calls pass as they are. In every other container (a student's chat, a task an agent scheduled, the patrol and the
 * bootstrap) an action that lists the class is refused, with what to use instead, and one that is about a single student gets the bound user id (a container that is
 * not linked is refused, not given somebody's data). Every other action passes as it is: the ones that are about one student but name no `user_id` in the model's hands
 * (week_status, user_contact) are scoped by brief-access.ts, with the same `isMain` key.
 */
export function checkCanvasAccess(
  action: string,
  params: Record<string, string> | undefined,
  ctx: { isMain: boolean; boundCanvasUserId: string },
): CanvasAccess {
  if (ctx.isMain) return { ok: true, params };
  if (CANVAS_RESTRICTED_ACTIONS.has(action)) {
    return {
      ok: false,
      message: `The "${action}" action is restricted to protect student privacy. It lists the whole class, so only the admin chat can use it. For this student use "week_status" (this week's assignments and whether each is submitted), "my_grades" (their scores) or "student_submission" (one assignment's submission).`,
    };
  }
  if (CANVAS_IDENTITY_ACTIONS.has(action)) {
    if (!ctx.boundCanvasUserId) return { ok: false, message: CANVAS_IDENTITY_NOT_LINKED };
    return { ok: true, params: { ...(params || {}), user_id: ctx.boundCanvasUserId } };
  }
  return { ok: true, params };
}

// ---- start_mock_interview: the repository a submission links to ----

/** The repository a submission's GitHub link names: the link's own owner and repository, with ".git" already taken off the repository. */
export interface LinkedRepo {
  owner: string;
  repo: string;
}

/**
 * Whether the mock interview may read the repository that a submission links to. The link is what the student wrote, and the interview reads with the operator's
 * token: a link to somebody else's repository (a classmate's, or a private one of the instructor's that the token can see) would put that code into the student's
 * own interview_context.json, and the owner a link names is no evidence of whose it is. So the interview reads it only when
 *   - the owner is the student's own GitHub login (compared without regard to case): the one the host bound to the chat, and in the admin chat the one it named or
 *     COMPETENCY.md says for that student (brief-access.ts resolveBriefIdentity: the same answer the weekly brief uses), or
 *   - for an organisation or a team, `belongs` shows that this login has committed to that very repository (the handler asks GitHub for one commit by that author).
 * No login known: the link is trusted for nothing. Names that could change an API path (`..`, a slash, `%`) are refused before anything is asked, and so is a `belongs`
 * that says no, fails or throws: the interview then goes on with the login's own repositories, as if the submission had no link.
 */
export async function mayReadLinkedRepo(input: {
  /** The student's GitHub login, from the host's binding (or, in the admin chat, named for that student); '' when there is none. */
  login: string;
  link: LinkedRepo;
  /** Asked only for an owner that is not the login, with the login; true when it has a commit in the linked repository. */
  belongs: (login: string) => Promise<boolean>;
}): Promise<boolean> {
  const { login, link } = input;
  if (!login || !link.owner || !link.repo) return false;      // (checkGithubParams reads an empty name as "not given", so it is refused here)
  // the shape only: the owner counts as "own" here, so that what is left to check is that both names are plain names (github-access.ts has the rule)
  if (!checkGithubParams({ owner: link.owner, repo: link.repo }, { username: link.owner, allowedOrgs: [] }).ok) return false;
  if (link.owner.toLowerCase() === login.toLowerCase()) return true;
  try {
    return (await input.belongs(login)) === true;
  } catch {
    return false;
  }
}
