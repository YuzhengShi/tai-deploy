import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TASK_CLOSE_DELAY,
  TIMEZONE,
} from './config.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getLastUserMessageTime,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logPatrolDecision, takeSendFlag, type PatrolRecord } from './intervention-log.js';
import { logger } from './logger.js';
import { gateNote, gatePatrol, recordPatrolRun, type GateDecision } from './patrol-gate.js';
import { isSystemTask } from './task-origin.js';
import { isPatrolTask } from './teaching-patrol.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
}

/** When a recurring task runs next (null for a task that runs once). */
function nextRunOf(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    return CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE }).next().toISOString();
  }
  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    return new Date(Date.now() + ms).toISOString();
  }
  return null;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // A student's teaching patrol: code decides first whether a model is needed today (src/patrol-gate.ts). A skip starts no container, calls no model,
  // and is written down like any other run, so every day's decision can be read back from task_run_logs.
  let gate: GateDecision | null = null;
  let prompt = task.prompt;
  if (isPatrolTask(task)) {
    gate = gatePatrol(task, group, { lastStudentMessage: (jid) => getLastUserMessageTime(jid, ASSISTANT_NAME) });
    logger.info(
      { taskId: task.id, group: task.group_folder, mode: gate.mode, run: gate.run, reasons: gate.reasons },
      gate.run ? 'Patrol gate: the model runs' : gate.mode === 'on' ? 'Patrol gate: no model today' : 'Patrol gate (shadow): would have skipped, runs anyway',
    );
    if (!gate.run && gate.mode === 'on') {
      const why = `skipped by the gate: ${gate.reasons.join('; ')}`.slice(0, 480);
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'success',
        result: why,
        error: null,
      });
      updateTaskAfterRun(task.id, nextRunOf(task), why.slice(0, 200), false);
      logPatrolDecision(groupDir, { kind: 'skipped', keys: gate.keys, weekly: gate.weekly }, Date.now(), (m) => logger.warn({ taskId: task.id }, m));
      return;
    }
    if (gate.mode === 'on') prompt = `${task.prompt}\n\n${gateNote(gate)}`;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      origin: t.origin ?? null,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Idle timer: closes the container's stdin, so that it exits instead of waiting for a next message that a task never gets (the queue
  // does not pipe a student's message into a task's container). Two ways to start it: the runner says it is idle (TASK_CLOSE_DELAY, a few
  // seconds: its answer has gone out, however empty it was), or a result arrives and nothing says idle after it (IDLE_TIMEOUT, the
  // fallback for a runner that does not say so). Without the first, a patrol that ended with no text held its container for the whole
  // CONTAINER_TIMEOUT: 937 s on 2026-11-03, with five containers for the whole school.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // The runner answered (a result with text) or said it was idle: its turn finished. A runner that is stopped before either (CONTAINER_TIMEOUT, a shutdown)
  // has not finished the task.
  let reportedDone = false;

  const closeIn = (ms: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id, afterMs: ms }, 'Scheduled task is done, closing container stdin');
      deps.queue.closeStdin(task.chat_jid);
    }, ms);
  };

  // For the patrol's decision log (src/intervention-log.ts): how a failed run failed, and whether the run sent the student a message (the marker the send tool
  // leaves; an old one from before this run is taken away first, so it is not read as this run's)
  let apiFailure: string | null = null;
  let unfinished = false;
  if (gate) takeSendFlag(task.group_folder);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        // Full access (class-wide Canvas, any GitHub owner, no tool limits) only for a task the host made itself. A task an agent scheduled runs as that student's
        // own chat would, and delivers its reminder through send_message as before (src/task-origin.ts).
        isSystemTask: isSystemTask(task),
        canvasUserId: group.canvasUserId,
        githubUsername: group.githubUsername,
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        // The model could not be reached: the runner's result is its apology, and the task did nothing. The status of such an output is
        // "success" (a chat has to show the apology), so it is read here. Counted as a failure, nothing of it is kept (the gate's
        // signals stay new, the next patrol looks again), and the operator's `patrol` view calls it failed.
        if (streamedOutput.apiFailure) {
          apiFailure = streamedOutput.apiFailure;
          error = `the model could not be reached (${streamedOutput.apiFailure}), so the task did nothing`;
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Scheduled tasks (patrol, bootstrap, etc.) must NEVER send text output
          // directly to students. Only explicit send_message MCP/IPC calls should
          // reach them — those go through the IPC watcher path, not here.
          logger.info(
            { taskId: task.id, group: task.group_folder },
            `Scheduled task output (suppressed): ${streamedOutput.result.slice(0, 200)}`,
          );
          // A result starts the long timer, not a session-update marker; the runner's own "idle" (below) shortens it
          reportedDone = true;
          closeIn(IDLE_TIMEOUT);
        }
        if (streamedOutput.idle) {
          reportedDone = true;
          closeIn(TASK_CLOSE_DELAY);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }
    // The container runner reports a container that was stopped after it had streamed something (the 15-minute timeout) as a success with nothing in
    // it, and a run that never finished must not be kept as one the model looked at. A runner that finishes its turn says idle, whatever it answered (one that
    // wrote an answer is taken as done even without it: a container image from before the marker existed).
    if (!error && !reportedDone) {
      unfinished = true;
      error = 'the task did not finish: its runner never said it was done (its container was stopped, or it ran out of time)';
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  // In shadow mode the model ran although the gate would not have let it: say so in the log, so a week of runs shows what the gate would have saved
  const shadowSkip = gate !== null && gate.mode === 'shadow' && !gate.run;
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result: shadowSkip ? `[the gate would have skipped this run: ${gate!.reasons.join('; ')}] ${result ?? ''}`.slice(0, 2000) : result,
    error,
  });

  // What the model has now looked at is what "new" is measured against tomorrow; a run that failed is not kept, so the next patrol looks again
  if (gate && gate.run && !error) {
    try {
      recordPatrolRun(task.group_folder, gate, new Date());
    } catch (err) {
      logger.warn({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, 'Patrol gate: could not keep what the model looked at');
    }
  }

  // The patrol's decision, one line in the student's intervention log, whatever the model did or did not write itself: ran and sent a message, ran and sent none
  // (it decided not to), or failed. Signal keys and numbers only.
  if (gate) {
    const sent = takeSendFlag(task.group_folder);
    const modelFailure = apiFailure as string | null;          // assigned by the runner's callback above, which the compiler's flow analysis does not follow
    const base = { sent, keys: gate.keys, weekly: gate.weekly, seconds: durationMs / 1000, gate: gate.mode };
    const record: PatrolRecord = error
      ? { kind: 'failed', why: modelFailure ? 'model' : unfinished ? 'unfinished' : 'error', ...(modelFailure ? { apiFailure: modelFailure } : {}), ...base }
      : { kind: 'ran', shadowSkip, ...base };
    logPatrolDecision(groupDir, record, Date.now(), (m) => logger.warn({ taskId: task.id }, m));
  }

  const nextRun = nextRunOf(task);        // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary, !!error);
}

let schedulerRunning = false;
// Track tasks currently in-flight to prevent the scheduler from
// re-enqueuing them on subsequent polls (next_run is only updated
// after the task completes, which can take minutes).
const runningTasks = new Set<string>();

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      // Only log when there are genuinely new tasks to run
      const newDueTasks = dueTasks.filter((t) => !runningTasks.has(t.id));
      if (newDueTasks.length > 0) {
        logger.info({ count: newDueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Skip tasks already running — their next_run hasn't been
        // updated yet because they haven't completed.
        if (runningTasks.has(currentTask.id)) continue;

        runningTasks.add(currentTask.id);

        // Advance next_run BEFORE executing to prevent re-triggering on crash/restart.
        // If the process dies mid-task, next_run already points to the future.
        if (currentTask.schedule_type === 'cron') {
          try {
            const interval = CronExpressionParser.parse(currentTask.schedule_value, { tz: TIMEZONE });
            const next = interval.next().toISOString();
            updateTask(currentTask.id, { next_run: next });
          } catch { /* will be updated again after completion */ }
        } else if (currentTask.schedule_type === 'interval') {
          const ms = parseInt(currentTask.schedule_value, 10);
          if (!isNaN(ms) && ms > 0) {
            updateTask(currentTask.id, { next_run: new Date(Date.now() + ms).toISOString() });
          }
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          async () => {
            try {
              await runTask(currentTask, deps);
            } finally {
              runningTasks.delete(currentTask.id);
            }
          },
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
