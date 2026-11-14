import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { seedCompetencyBootstrap } from './competency-bootstrap.js';
import {
  countOpenContainerTasks,
  countTaskCreationsSince,
  createTask,
  deleteTask,
  getTaskById,
  recordTaskCreation,
  updateGroupIdentity,
  updateTask,
} from './db.js';
import { ipcMediaPath } from './ipc-media.js';
import { buildMemoryExport, MemoryFact, storeMemory } from './memory.js';
import { isWorkCategory } from './work-facts.js';
import { logger } from './logger.js';
import { writeFileAtomicSafe } from './safe-fs.js';
import { CHAT_OBJECT_ANSWER_CHARS, handleChatObject } from './chat-objects/ipc-verb.js';
import { DOC_ANSWER_CHARS, startDocOpen } from './docs/ipc-verb.js';
import { LIBRARY_ANSWER_CHARS, handleCourseDocFind } from './docs/library-verb.js';
import type { DocsApi } from './docs/types.js';
import { SANDBOX_ANSWER_CHARS, startSandboxRun } from './sandbox/ipc-verb.js';
import type { SandboxApi } from './sandbox/types.js';
import { formatOutbound } from './router.js';
import { checkNewTask } from './task-limits.js';
import { RegisteredGroup } from './types.js';

// Audit log for high-risk admin operations (append-only)
function auditLog(operation: string, details: Record<string, unknown>): void {
  const logDir = path.join(DATA_DIR, 'audit');
  fs.mkdirSync(logDir, { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    operation,
    ...details,
  };
  fs.appendFileSync(
    path.join(logDir, 'admin-operations.jsonl'),
    JSON.stringify(entry) + '\n',
  );
  logger.info({ operation, ...details }, 'AUDIT: admin operation');
}

/** What became of a request that a container made through its schedule_task, pause_task, resume_task or cancel_task tool. */
export interface IpcResult {
  ok: boolean;
  /** A sentence the agent can say to the student as it stands. */
  message: string;
  taskId?: string;
}

/** The container picks the name of its request, and it names a file: a plain id of 8 to 64 letters, digits, dashes and underscores, or no answer. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Tells the container that asked what became of its request: a file `results/<requestId>.json` in its own IPC directory, which its tool waits for
 * (container/agent-runner/src/ipc-result.ts). Until now these tools wrote a file and answered "scheduled" or "requested" at once, so a request the host dropped (a typo in
 * a schedule, another group's task, now a limit) left the agent and the student told something false. Written through writeFileAtomicSafe, which refuses a `results` that
 * is a link leading out of the group's directory; a request with no valid id, or a failure to write, is not an error of the request's (an older container asks for no answer).
 */
export function answer(sourceGroup: string, requestId: unknown, result: IpcResult, maxChars = 600): void {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return;
  try {
    const groupIpcDir = path.join(DATA_DIR, 'ipc', sourceGroup);
    // (600 characters for the task tools' sentences; a run's answer is longer, and is cut at SANDBOX_ANSWER_CHARS, which its framing never reaches)
    const body: IpcResult = { ok: result.ok, message: String(result.message).slice(0, maxChars), ...(result.taskId ? { taskId: result.taskId } : {}) };
    writeFileAtomicSafe(path.join(groupIpcDir, 'results', `${requestId}.json`), JSON.stringify(body), groupIpcDir);
  } catch (err) {
    logger.warn({ sourceGroup, err: err instanceof Error ? err.message : String(err) }, 'Could not write the answer to an IPC request');
  }
}

/** Something that happened for a student and belongs in their activity list on the page: a note TAi kept, a reminder it set. */
export interface ActivityEntry {
  type: 'memory' | 'reminder';
  title: string;
  text: string;
  detail?: string;
}

/** "Tue, Nov 3, 9:00 AM": a time as the student reads it, in the course's time zone. */
function whenText(iso: string): string {
  // newer ICU puts a narrow no-break space before AM/PM: a plain space is what a title and a search should hold
  return new Date(iso).toLocaleString('en-US', { timeZone: TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ');
}

/** Notes TAi keeps for its own working (not things about the student) are not shown as something it remembered. */
const WORKING_NOTES = new Set(['checkpoint', 'session']);

export interface IpcDeps {
  /** The page's activity list: told of a note TAi kept and of a reminder it set (best-effort: a failure here never stops the IPC file being handled). */
  recordActivity?: (folder: string, entry: ActivityEntry) => void;
  /** Runs a student's Go code (src/sandbox, docs/GO_SANDBOX.md) for the `sandbox_run` request of a container; without it the sandbox is off and every request says so. */
  runSandbox?: SandboxApi['run'];
  /** Puts a card in a student's chat (docs/CHAT_OBJECTS.md: the history's `appendObject` and a wake-up of the page); best-effort. Without it no card is made. */
  postObject?: (folder: string, obj: unknown) => void;
  /** Prepares a document for a student and leaves its card in their chat (src/docs, docs/DOCUMENTS.md) for the `doc_open` request of a container; without it the viewer is off and every request says so. */
  docs?: DocsApi;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendReaction: (jid: string, messageId: string, emoji: string) => Promise<void>;
  sendAudioMessage: (jid: string, audioBuffer: Buffer) => Promise<void>;
  sendImageMessage: (jid: string, imageBuffer: Buffer, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

/**
 * What the watcher does with a `memory_store` file: the facts about a student's work (a repository, where a session stopped, a problem: docs/STUDENT_STATE.md, src/work-facts.ts) are the host's own, so a
 * container's file, which a student's agent can write itself, never writes one, whatever it names and whoever sent it (the admin chat too); any other note is stored for the sender's own
 * group (the admin chat: for any).
 */
export function memoryStoreVerdict(category: unknown, studentFolder: string, sourceGroup: string, isMain: boolean): 'store' | 'host-only' | 'unauthorized' {
  if (isWorkCategory(category)) return 'host-only';
  return isMain || studentFolder === sourceGroup ? 'store' : 'unauthorized';
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const cleaned = formatOutbound(data.text);
                  if (cleaned) {
                    await deps.sendMessage(data.chatJid, cleaned);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'reaction' && data.chatJid && data.messageId && data.emoji) {
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  await deps.sendReaction(data.chatJid, data.messageId, data.emoji);
                  logger.info({ chatJid: data.chatJid, emoji: data.emoji, sourceGroup }, 'IPC reaction sent');
                }
              } else if (data.type === 'voice_message' && data.chatJid && data.audioPath) {
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  // Map container path to host path
                  const hostPath = ipcMediaPath(sourceGroup, data.audioPath as string);
                  if (!hostPath) throw new Error('audioPath is outside the IPC directory');
                  const buffer = fs.readFileSync(hostPath);
                  await deps.sendAudioMessage(data.chatJid, buffer);
                  logger.info({ chatJid: data.chatJid, sourceGroup, size: buffer.length }, 'IPC voice message sent');
                  // Clean up the TTS file
                  try { fs.unlinkSync(hostPath); } catch { /* ignore */ }
                }
              } else if (data.type === 'image_message' && data.chatJid && data.imagePath) {
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  const hostPath = ipcMediaPath(sourceGroup, data.imagePath as string);
                  if (!hostPath) throw new Error('imagePath is outside the IPC directory');
                  const buffer = fs.readFileSync(hostPath);
                  await deps.sendImageMessage(data.chatJid, buffer, data.caption as string | undefined);
                  logger.info({ chatJid: data.chatJid, sourceGroup, size: buffer.length }, 'IPC image message sent');
                  try { fs.unlinkSync(hostPath); } catch { /* ignore */ }
                }
              } else if (data.type === 'memory_store' && data.studentFolder && data.fact) {
                // (memoryStoreVerdict: the host's own categories are never written from here; any other note only for the sender's own group)
                const verdict = memoryStoreVerdict((data.fact as MemoryFact).category, data.studentFolder as string, sourceGroup, isMain);
                if (verdict === 'host-only') {
                  logger.warn({ sourceGroup, category: (data.fact as MemoryFact).category }, 'memory_store of a category the host keeps itself refused');
                } else if (verdict === 'store') {
                  storeMemory(data.studentFolder as string, data.fact as MemoryFact);
                  logger.info({ studentFolder: data.studentFolder, sourceGroup }, 'IPC memory stored');
                  const fact = data.fact as MemoryFact;
                  if (fact.text && !WORKING_NOTES.has(fact.category || 'other')) {
                    try {
                      deps.recordActivity?.(data.studentFolder as string, {
                        type: 'memory',
                        title: 'Remembered',
                        text: fact.text,
                        detail: `${fact.text}\n\nTAi kept this note about you so that it can pick things up next time. See all of them, or take one back, under "What TAi remembers" in the account menu.`,
                      });
                    } catch { /* the list is a convenience */ }
                  }
                  // Refresh memory_store.json so memory_query sees the new entry this session
                  try {
                    const folder = data.studentFolder as string;
                    const chatJid = Object.entries(registeredGroups).find(([, g]) => g.folder === folder)?.[0];
                    if (chatJid) {
                      const exportData = buildMemoryExport(folder, chatJid);
                      // (the agent that sent this message can have planted a link under that name: never written through one, src/safe-fs.ts)
                      writeFileAtomicSafe(path.join(GROUPS_DIR, folder, 'memory_store.json'), JSON.stringify(exportData), path.join(GROUPS_DIR, folder));
                    }
                  } catch { /* best-effort */ }
                } else {
                  logger.warn({ studentFolder: data.studentFolder, sourceGroup }, 'Unauthorized memory_store attempt blocked');
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    // The container's own name for this request: the answer is written to results/<requestId>.json (answer())
    requestId?: string;
    // For sandbox_run: what the container asks to run (checked by parseSandboxRequest, the one gate); for doc_open: { name, page? } (checked by src/docs/ipc-verb.ts); for course_doc_find: { query } (checked by src/docs/library-verb.ts); for chat_object: { kind, args } (checked by src/chat-objects/ipc-verb.ts)
    request?: unknown;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For register_group + set_student_identity
    canvasUserId?: string;
    githubUsername?: string;
    // For set_student_identity
    targetFolder?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task': {
      // Every way out of this case says why, to the container that asked (answer(): a file its tool waits for), so that the agent and the student are never told
      // "scheduled" about a request that was dropped. A group that is not the admin chat is held to the limits of src/task-limits.ts.
      const say = (ok: boolean, message: string, taskId?: string) => answer(sourceGroup, data.requestId, { ok, message, ...(taskId ? { taskId } : {}) });
      if (!data.prompt || !data.schedule_type || !data.schedule_value || !data.targetJid) {
        say(false, 'Not scheduled: the request was incomplete (it needs the instructions, a kind of schedule, the schedule and the chat).');
        break;
      }
      // Resolve the target group from JID
      const targetJid = data.targetJid as string;
      const targetGroupEntry = registeredGroups[targetJid];

      if (!targetGroupEntry) {
        logger.warn({ targetJid }, 'Cannot schedule task: target group not registered');
        say(false, 'Not scheduled: that chat is not registered.');
        break;
      }

      const targetFolder = targetGroupEntry.folder;

      // Authorization: non-main groups can only schedule for themselves
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn({ sourceGroup, targetFolder }, 'Unauthorized schedule_task attempt blocked');
        say(false, 'Not scheduled: a chat can only schedule for itself.');
        break;
      }

      const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(data.schedule_value, {
            tz: TIMEZONE,
          });
          nextRun = interval.next().toISOString();
        } catch {
          logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
          say(false, `Not scheduled: "${data.schedule_value}" is not a cron schedule I can read.`);
          break;
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(data.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
          say(false, `Not scheduled: "${data.schedule_value}" is not a number of milliseconds above zero.`);
          break;
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (scheduleType === 'once') {
        const scheduled = new Date(data.schedule_value);
        if (isNaN(scheduled.getTime())) {
          logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
          say(false, `Not scheduled: "${data.schedule_value}" is not a time I can read. Use local time like 2026-02-01T15:30:00.`);
          break;
        }
        // If timestamp is in the past (e.g. agent sent local time without
        // timezone and host parsed as UTC), run in 5 seconds instead of
        // skipping or firing stale.
        nextRun = scheduled.getTime() <= Date.now()
          ? new Date(Date.now() + 5000).toISOString()
          : scheduled.toISOString();
      } else {
        logger.warn({ scheduleType }, 'Unknown schedule type');
        say(false, `Not scheduled: "${String(data.schedule_type).slice(0, 40)}" is not a kind of schedule (it is cron, interval or once).`);
        break;
      }

      // The limits of a student's agent (src/task-limits.ts; the admin chat has none): how often, how far ahead, how long, how many open, how many made today, and the
      // heads of the host's own prompts. The host decides here whatever wrote the file: a student's agent can write one without the container's tool.
      if (!isMain) {
        const now = new Date();
        const verdict = checkNewTask(
          { prompt: data.prompt, scheduleType, scheduleValue: data.schedule_value },
          now,
          {
            open: countOpenContainerTasks(targetFolder),
            createdLastDay: countTaskCreationsSince(targetFolder, new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()),
          },
          TIMEZONE,
        );
        if (!verdict.ok) {
          // the length of the instructions, never their words
          auditLog('schedule_task_refused', { sourceGroup, scheduleType, scheduleValue: data.schedule_value, promptChars: data.prompt.length, reason: verdict.message });
          logger.warn({ sourceGroup, scheduleType, reason: verdict.message }, 'schedule_task refused: over a limit');
          say(false, verdict.message);
          break;
        }
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextMode =
        data.context_mode === 'group' || data.context_mode === 'isolated'
          ? data.context_mode
          : 'isolated';
      createTask({
        id: taskId,
        group_folder: targetFolder,
        chat_jid: targetJid,
        prompt: data.prompt,
        schedule_type: scheduleType,
        schedule_value: data.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
        // A task an agent scheduled is never a system task, whoever the agent was and whatever the file says (it also carries a `createdBy` that nothing
        // reads): the file is the container's own words, and a student's agent can write one without the tool. Only the host's seeds say 'system'
        // (src/task-origin.ts), and only a system task's container has its tool limits lifted.
        origin: 'container',
      });
      // counted when it is made, in a table of its own: cancelling the task deletes its row, and must not give the day's count back
      if (!isMain) recordTaskCreation(targetFolder, new Date().toISOString());
      auditLog('schedule_task', {
        taskId, sourceGroup, targetFolder, scheduleType,
        scheduleValue: data.schedule_value, contextMode,
        promptPreview: data.prompt.slice(0, 200),
      });
      logger.info(
        { taskId, sourceGroup, targetFolder, contextMode },
        'Task created via IPC',
      );
      say(true, `Scheduled (${taskId}): ${scheduleType} ${data.schedule_value}${nextRun ? `; next run ${whenText(nextRun)}` : ''}.`, taskId);
      // a reminder the student asked for (a one-time task) goes in their activity list; a recurring task is TAi's own routine
      if (scheduleType === 'once' && nextRun) {
        try {
          deps.recordActivity?.(targetFolder, { type: 'reminder', title: `Reminder · ${whenText(nextRun)}`, text: data.prompt, detail: `${data.prompt}\n\nScheduled for ${whenText(nextRun)}.` });
        } catch { /* the list is a convenience */ }
      }
      break;
    }

    case 'sandbox_run': {
      // A student's Go code is run for the group the IPC directory belongs to, with the account the host bound to it. This function is awaited once for every file of every group
      // (startIpcWatcher) and a run takes up to a minute: the run is started and NOT waited for, and its answer is written when it ends (src/sandbox/ipc-verb.ts has the rules
      // and the order of the checks). The admin chat may ask too.
      startSandboxRun(
        {
          folder: sourceGroup,
          isMain,
          requestId: typeof data.requestId === 'string' && REQUEST_ID.test(data.requestId) ? data.requestId : null,
          request: data.request,
          group: Object.values(registeredGroups).find((g) => g.folder === sourceGroup),
        },
        {
          runSandbox: deps.runSandbox,
          say: (requestId, ok, message) => answer(sourceGroup, requestId, { ok, message }, SANDBOX_ANSWER_CHARS),
          // the kind of run and how it ended, never the code or the output
          audit: (operation, fields) => auditLog(operation, fields),
          postObject: deps.postObject,
          log: logger,
        },
      );
      break;
    }

    case 'doc_open': {
      // A document is prepared for the group the IPC directory belongs to and left in its chat as a card. Like sandbox_run it is started and NOT waited for (src/docs/ipc-verb.ts has the rules and the
      // order of the checks): a PDF takes up to a minute and a half. The admin chat may ask too.
      startDocOpen(
        {
          folder: sourceGroup,
          isMain,
          requestId: typeof data.requestId === 'string' && REQUEST_ID.test(data.requestId) ? data.requestId : null,
          request: data.request,
          group: Object.values(registeredGroups).find((g) => g.folder === sourceGroup),
        },
        {
          docs: deps.docs,
          uploadsDir: (folder) => path.join(GROUPS_DIR, folder, 'uploads'),
          say: (requestId, ok, message) => answer(sourceGroup, requestId, { ok, message }, DOC_ANSWER_CHARS),
          // the kind of source and how it ended, never a name or a title
          audit: (operation, fields) => auditLog(operation, fields),
          postObject: deps.postObject,
          log: logger,
        },
      );
      break;
    }

    case 'course_doc_find': {
      // A search of the course library (the decks the operator added for every student) for the group the IPC directory belongs to: a few words in, the slides that matched out, as quoted data. Nothing here
      // takes long (an index in memory), so the answer is written before this returns (src/docs/library-verb.ts has the rules). The admin chat may ask too.
      handleCourseDocFind(
        {
          folder: sourceGroup,
          isMain,
          requestId: typeof data.requestId === 'string' && REQUEST_ID.test(data.requestId) ? data.requestId : null,
          request: data.request,
          group: Object.values(registeredGroups).find((g) => g.folder === sourceGroup),
        },
        {
          docs: deps.docs,
          say: (requestId, ok, message) => answer(sourceGroup, requestId, { ok, message }, LIBRARY_ANSWER_CHARS),
          // that a search happened and how many slides it found, never the words of the query
          audit: (operation, fields) => auditLog(operation, fields),
          log: logger,
        },
      );
      break;
    }

    case 'chat_object': {
      // A chart, a sequence or a prediction card for the group the IPC directory belongs to, from the arguments of the container's show_chart, show_trace or ask_to_predict (checked by the type's own cleaner,
      // the history's one gate). Nothing here takes long, so the answer is written before this returns (src/chat-objects/ipc-verb.ts has the rules and the order of the checks). The admin chat may ask too.
      handleChatObject(
        {
          folder: sourceGroup,
          isMain,
          requestId: typeof data.requestId === 'string' && REQUEST_ID.test(data.requestId) ? data.requestId : null,
          request: data.request,
          group: Object.values(registeredGroups).find((g) => g.folder === sourceGroup),
        },
        {
          say: (requestId, ok, message) => answer(sourceGroup, requestId, { ok, message }, CHAT_OBJECT_ANSWER_CHARS),
          // the kind of card and how it ended, never the data
          audit: (operation, fields) => auditLog(operation, fields),
          postObject: deps.postObject,
          log: logger,
        },
      );
      break;
    }

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      const [verb, done] = data.type === 'pause_task' ? ['pause', 'paused'] : data.type === 'resume_task' ? ['resume', 'resumed'] : ['cancel', 'cancelled'];
      const say = (ok: boolean, message: string) => answer(sourceGroup, data.requestId, { ok, message });
      const task = data.taskId ? getTaskById(data.taskId) : undefined;
      // a task of another group is "no such task" to a group that is not the admin chat: it is not told that the task exists
      if (!task || (!isMain && task.group_folder !== sourceGroup)) {
        logger.warn({ taskId: data.taskId, sourceGroup }, `Unauthorized or unknown task ${verb} attempt`);
        say(false, data.taskId ? `There is no task ${String(data.taskId).slice(0, 80)} in this chat.` : 'No task was named.');
        break;
      }
      // The host's own tasks (the patrol, the bootstrap) are not for a student's agent to stop: a group that is not the admin chat changes only the tasks that agents made
      // in it. (A task nobody classified is not one of those either.)
      if (!isMain && task.origin !== 'container') {
        auditLog('task_change_refused', { sourceGroup, taskId: task.id, verb, origin: task.origin ?? null });
        logger.warn({ taskId: task.id, sourceGroup, verb }, 'A group tried to change a task of the system\'s: refused');
        say(false, `Task ${task.id} is part of the system's own routine (the teaching patrol or the account setup), so it cannot be ${done} from here.`);
        break;
      }
      if (data.type === 'pause_task') {
        updateTask(task.id, { status: 'paused' });
      } else if (data.type === 'resume_task') {
        updateTask(task.id, { status: 'active' });
      } else {
        auditLog('cancel_task', { sourceGroup, taskId: task.id, taskGroup: task.group_folder });
        deleteTask(task.id);
      }
      logger.info({ taskId: task.id, sourceGroup }, `Task ${done} via IPC`);
      say(true, `Task ${task.id} ${done}.`);
      break;
    }

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          canvasUserId: data.canvasUserId,
          githubUsername: data.githubUsername,
        });
        auditLog('register_group', {
          sourceGroup, jid: data.jid, name: data.name,
          folder: data.folder, trigger: data.trigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'run_bootstrap': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized run_bootstrap attempt blocked');
        break;
      }
      const bootstrapJid = data.targetJid as string;
      if (!bootstrapJid) {
        logger.warn({ sourceGroup }, 'run_bootstrap: missing targetJid');
        break;
      }
      const bootstrapGroup = registeredGroups[bootstrapJid];
      if (!bootstrapGroup) {
        logger.warn({ targetJid: bootstrapJid }, 'run_bootstrap: target group not registered');
        break;
      }
      seedCompetencyBootstrap(bootstrapGroup.folder, bootstrapJid);
      auditLog('run_bootstrap', {
        sourceGroup, targetFolder: bootstrapGroup.folder, targetJid: bootstrapJid,
      });
      logger.info(
        { targetFolder: bootstrapGroup.folder, targetJid: bootstrapJid },
        'Bootstrap triggered via IPC',
      );
      break;
    }

    case 'set_student_identity':
      // Only the admin chat binds an identity (verified by the IPC directory). The binding is what keeps one student's agent from reading another's grades
      // (canvas_query my_grades and student_submission use it), so a container must not be able to write it. The tool of that name refuses a container that
      // is not the admin chat or a system task, but this file is the container's own words: a student's agent can write it into its own IPC directory without
      // the tool (nothing guards that directory), and the host cannot tell a system task's file from a student's, so until now any group could bind any Canvas
      // user to itself. A student's binding comes from the allowlist (ensureStudentGroup) when their chat is registered; the grade bootstrap's own call is a
      // no-op there, and is ignored here without a word.
      if (!isMain) {
        const targetFolder = data.targetFolder || sourceGroup;
        const current = Object.values(registeredGroups).find((g) => g.folder === targetFolder);
        const changesNothing =
          targetFolder === sourceGroup &&
          !!current &&
          (!data.canvasUserId || data.canvasUserId === current.canvasUserId) &&
          (!data.githubUsername || data.githubUsername === current.githubUsername);
        if (!changesNothing) {
          auditLog('set_student_identity_refused', {
            sourceGroup, targetFolder,
            canvasUserId: data.canvasUserId, githubUsername: data.githubUsername,
          });
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized set_student_identity attempt blocked',
          );
        }
        break;
      } else {
        // Main can set identity for any group
        const targetFolder = data.targetFolder || sourceGroup;
        if (data.canvasUserId || data.githubUsername) {
          const updated = updateGroupIdentity(targetFolder, {
            canvasUserId: data.canvasUserId,
            githubUsername: data.githubUsername,
          });
          if (updated) {
            logger.info(
              { targetFolder, canvasUserId: data.canvasUserId, githubUsername: data.githubUsername },
              'Student identity updated via IPC (admin)',
            );
          } else {
            logger.warn(
              { targetFolder },
              'set_student_identity: no matching group found',
            );
          }
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
