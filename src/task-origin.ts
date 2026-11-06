/**
 * Who made a scheduled task, and what that decides: only a task the HOST made runs in a container whose per-session tool limits are lifted. (It used to decide
 * far more: every scheduled task had the admin's access, class-wide Canvas, any GitHub owner and set_student_identity. What a container may READ is now `isMain`'s alone:
 * the host's own tasks run in a student's session, and what they read is in front of the student.) The origin also decides who may stop a task: a student's agent
 * may pause, resume and cancel only its own container-origin tasks, never the patrol's or the bootstrap's. docs/SECURITY.md, "Scheduled tasks and access", has the flaw
 * this closes and what it leaves open.
 *
 * The answer is written once, when the row is created, by the host code that creates it: the three seeds below say 'system'; src/ipc.ts says 'container' for
 * every task an agent schedules, whoever the agent was, and never reads the field from the IPC file (the file is the container's own words: it already carries a
 * `createdBy` that nothing checks). Anything that is not exactly 'system' (NULL, a value this code does not know) is not system: "the host made this" is true
 * only when the host said so.
 *
 * The prompt's marker (`[TEACHING_PATROL]` ...) is NOT evidence of anything: an agent's prompt can hold any text, so a task that carries a patrol's marker gets
 * no more than any other task of a student. Rows that exist when the column is added, and the ones an older host writes during a rollback, are classified by
 * the migration (classifyTaskOrigins in db.ts, at every start) by what a container cannot fake: the host's own id form (an IPC task's id is made by the host,
 * `task-<time>-<random>`; an agent cannot choose one) together with the marker its own prompt carries.
 */

import type { ScheduledTask } from './types.js';

export type SystemTaskKind = 'teaching patrol' | 'grade bootstrap' | 'course sync';

/** What the host's own tasks look like: the id its seed gives them and the marker at the head of their prompt (teaching-patrol.ts, competency-bootstrap.ts, course-sync.ts). */
export const SYSTEM_TASK_KINDS: ReadonlyArray<{ kind: SystemTaskKind; idPrefix: string; marker: string }> = [
  { kind: 'teaching patrol', idPrefix: 'patrol-', marker: '[TEACHING_PATROL]' },
  { kind: 'grade bootstrap', idPrefix: 'bootstrap-', marker: '[COMPETENCY_BOOTSTRAP]' },
  { kind: 'course sync', idPrefix: 'course-sync-', marker: '[COURSE_SYNC]' },
];

/** Whether a task's container is started as a system task. Only the stored origin 'system' says yes. */
export function isSystemTask(task: Pick<ScheduledTask, 'origin'>): boolean {
  return task.origin === 'system';
}

/**
 * Whether a task is one of the host's own of a kind (the patrol, the bootstrap, the course sync): the stored origin says the host made it AND its id has that seed's
 * prefix. The prompt's marker is never read: an agent's prompt can hold any text, and a check that took a marker for the patrol let a student's task stand in for it
 * (it was counted as a patrol on the teaching-team page, and its marker kept the real patrol from being seeded).
 */
export function isSystemTaskOfKind(task: { id: string; origin?: string | null }, kind: SystemTaskKind): boolean {
  const spec = SYSTEM_TASK_KINDS.find((k) => k.kind === kind);
  return !!spec && task.origin === 'system' && typeof task.id === 'string' && task.id.startsWith(spec.idPrefix);
}

/**
 * The UPDATE that classifies the rows that have no origin, and its parameters (db.ts runs it): a row is system when its id has a host seed's prefix AND its prompt
 * holds that seed's marker, and a container task otherwise. Written from SYSTEM_TASK_KINDS so that the two cannot drift apart. instr and substr, not LIKE: `_` is
 * a wildcard there, and LIKE is case blind.
 */
export function originBackfill(): { sql: string; params: Array<string | number> } {
  const test = SYSTEM_TASK_KINDS.map(() => '(substr(id, 1, ?) = ? AND instr(prompt, ?) > 0)').join(' OR ');
  return {
    sql: `UPDATE scheduled_tasks SET origin = CASE WHEN ${test} THEN 'system' ELSE 'container' END WHERE origin IS NULL`,
    params: SYSTEM_TASK_KINDS.flatMap((k) => [k.idPrefix.length, k.idPrefix, k.marker]),
  };
}
