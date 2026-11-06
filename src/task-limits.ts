/**
 * The limits on a task that a student's own agent schedules, and the one function that checks them. This file is the SAME TEXT in the host (src/task-limits.ts) and in
 * the agent container (container/agent-runner/src/task-limits.ts): the host is the authority (src/ipc.ts checks every request before it makes a task, whatever wrote
 * the request file), and the container's schedule_task tool asks the same question first, so that the agent and the student hear a refusal in a sentence instead of
 * being told "scheduled" about a file that the host then drops. container/agent-runner/test/task-limits.test.ts fails when the two copies differ (the two packages are
 * built apart, so one cannot import the other). The admin chat is held to none of it.
 *
 * Why a student's task needs limits at all: every task runs a container, with the model, on the owner's budget, at a time and as often as the student's agent says,
 * and a task survives the conversation that made it. Without a floor on the gap, a count and a horizon, one student's "remind me every minute" is a container every
 * minute for good.
 */

import { CronExpressionParser } from 'cron-parser';

/** A repeating task may not run more often than once an hour (the gap between ANY two runs of a cron schedule, not only the first two). */
export const MIN_RECURRING_GAP_MS = 60 * 60 * 1000;
/** Tasks that agents scheduled and are still there (active or paused: a paused one is one resume away from running), per group. */
export const MAX_OPEN_TASKS = 10;
/** Tasks created, per group, in a rolling 24 hours: counted when they are made, so that cancelling one does not give the count back. */
export const MAX_CREATED_PER_DAY = 20;
/** A one-time task may be set at most this far ahead (the voice side says 60 days too). */
export const MAX_ONCE_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
/** Characters of the instructions a task carries. */
export const MAX_PROMPT_CHARS = 4000;
/** The heads of the host's own tasks' prompts (src/task-origin.ts SYSTEM_TASK_KINDS has them with the ids): a student's task may not start like one. */
export const SYSTEM_PROMPT_MARKERS: readonly string[] = ['[TEACHING_PATROL]', '[COMPETENCY_BOOTSTRAP]', '[COURSE_SYNC]'];

export const TASK_TOO_OFTEN = 'Not scheduled: a repeating reminder may not run more often than once an hour.';

export interface TaskRequest {
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
}

/** What the group has now: tasks that agents scheduled and are still there, and tasks made in the last 24 hours. */
export interface TaskCounts {
  open: number;
  createdLastDay: number;
}

export type TaskCheck = { ok: true } | { ok: false; message: string };

/** How far ahead the gaps of a cron schedule are looked at: a year. A schedule that is dense only on days beyond it runs a handful of times in all, whatever its gaps. */
export const GAP_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * The shortest gap between two runs of a cron schedule, over its next `runs` runs (200) and no further ahead than a year, or null when that holds fewer than two runs.
 * Looking at a few hundred runs and not two is what catches `0,5 * * * *` (5 minutes, then 55) and a schedule that is dense on some days only (every 5 minutes, but
 * only on Mondays); stopping at a year is what keeps a sparse schedule (every 29 February) from being searched for centuries on the thread every student shares.
 * Throws what the parser throws for a schedule it cannot read, an impossible date such as `0 0 31 2 *` included.
 */
export function minRunGapMs(cron: string, from: Date, tz?: string, runs = 200): number | null {
  const iterator = CronExpressionParser.parse(cron, { currentDate: from, ...(tz ? { tz } : {}) });
  const horizon = from.getTime() + GAP_HORIZON_MS;
  let previous: number;
  try {
    previous = iterator.next().toDate().getTime();
  } catch {
    return null;                                    // the schedule never runs
  }
  if (previous > horizon) return null;
  let shortest: number | null = null;
  for (let i = 1; i < runs; i++) {
    let next: number;
    try {
      next = iterator.next().toDate().getTime();
    } catch {
      break;                                        // no more runs
    }
    if (next > horizon) break;
    shortest = shortest === null ? next - previous : Math.min(shortest, next - previous);
    previous = next;
  }
  return shortest;
}

const number = (n: number): string => n.toLocaleString('en-US');

/**
 * Whether a student's agent may make this task now: every refusal is a sentence the agent can say to the student as it stands. Static limits first (the instructions, the
 * schedule), then the counts. `tz` is the time zone cron schedules are read in (the host's: the container's is the same by its TZ). A schedule the checks cannot read is
 * refused too: it would not have been made.
 */
export function checkNewTask(request: TaskRequest, now: Date, counts: TaskCounts, tz?: string): TaskCheck {
  const refuse = (message: string): TaskCheck => ({ ok: false, message });
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  if (prompt.length > MAX_PROMPT_CHARS) {
    return refuse(`Not scheduled: the instructions are ${number(prompt.length)} characters long and at most ${number(MAX_PROMPT_CHARS)} are allowed. Shorten them.`);
  }
  const marker = SYSTEM_PROMPT_MARKERS.find((m) => prompt.trimStart().startsWith(m));
  if (marker) {
    return refuse(`Not scheduled: instructions that begin with ${marker} are reserved for the system's own routines. Word them another way.`);
  }

  const value = typeof request.scheduleValue === 'string' ? request.scheduleValue : '';
  if (request.scheduleType === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) return refuse(`Not scheduled: "${value}" is not a number of milliseconds above zero.`);
    if (ms < MIN_RECURRING_GAP_MS) return refuse(TASK_TOO_OFTEN);
  } else if (request.scheduleType === 'cron') {
    let gap: number | null;
    try {
      gap = minRunGapMs(value, now, tz);
    } catch {
      return refuse(`Not scheduled: "${value}" is not a cron schedule I can read.`);
    }
    if (gap !== null && gap < MIN_RECURRING_GAP_MS) return refuse(TASK_TOO_OFTEN);
  } else if (request.scheduleType === 'once') {
    const at = new Date(value);
    if (isNaN(at.getTime())) return refuse(`Not scheduled: "${value}" is not a time I can read. Use local time like 2026-02-01T15:30:00.`);
    if (at.getTime() - now.getTime() > MAX_ONCE_AHEAD_MS) return refuse('Not scheduled: a one-time reminder can be set at most 60 days ahead.');
  } else {
    return refuse(`Not scheduled: "${request.scheduleType}" is not a kind of schedule (it is cron, interval or once).`);
  }

  if (counts.open >= MAX_OPEN_TASKS) {
    return refuse(`Not scheduled: ${number(MAX_OPEN_TASKS)} reminders or routines are already set up here (running or paused). Cancel one first; list_tasks shows them.`);
  }
  if (counts.createdLastDay >= MAX_CREATED_PER_DAY) {
    return refuse(`Not scheduled: at most ${number(MAX_CREATED_PER_DAY)} can be set up in a day, and that many were. Try again tomorrow.`);
  }
  return { ok: true };
}
