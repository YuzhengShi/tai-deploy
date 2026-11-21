import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ADMIN_PHONE_NUMBERS,
  ASSISTANT_NAME,
  CONTAINER_PREFIX,
  DATA_DIR,
  DEBOUNCE_MS,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  REPLY_RULE,
  STORE_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { WebChannel } from './channels/web.js';
import { seedCompetencyFile } from './competency-seed.js';
import type { Portal } from './portal/server.js';
import { mediaStore, startPortal } from './portal/start.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  spawnToolHost,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  clearSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
} from './db.js';
import { readEnvFile } from './env.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { createCanvasSource } from './docs/canvas-source.js';
import { createDocs } from './docs/index.js';
import { createSandbox } from './sandbox/runner.js';
import { createSqliteRates } from './sandbox/rates.js';
import type { SandboxApi } from './sandbox/types.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { masterySnapshot, progressSteps } from './progress.js';
import { trimClosingFormula, withReplyRule } from './reply-shape.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { hasBootstrapRun, seedCompetencyBootstrap } from './competency-bootstrap.js';
import { createCompetencyWriter } from './competency-writer.js';
import { createStudentStateWriter } from './student-state-writer.js';
import { deleteWorkFact, listWorkFacts, upsertWorkFact } from './memory.js';
import { takeSendFlag } from './intervention-log.js';
import { seedCourseSync } from './course-sync.js';
import { chatFromPortal, createVoiceHub } from './voice/hub.js';
import { DockerToolHost, toolHostReadyTimeoutMs } from './voice/tool-host.js';
import { startCourseStatusJob } from './course-status.js';
import { courseUpdates, type CourseUpdate } from './course-updates.js';
import { startStudentCourseJob } from './student-course.js';
import { startLeanRAGSync } from './leanrag-sync.js';
import { seedTeachingPatrol } from './teaching-patrol.js';
import { anySeed, seedSwitches } from './seeds.js';
import { TurnStatus, progressForwarder, type MessageExtras, type ProgressEvent } from './turn-status.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
// Track messages piped to active containers (per group).
// Prevents re-piping while ensuring processGroupMessages can
// re-discover them if the container crashes without processing.
let pipedUpTo: Record<string, string> = {};

// Debounce timers for agent spawning — waits for the student to finish
// typing fragmented WhatsApp messages before spawning a container.
// Only applies when no container is active; active containers get
// messages piped immediately via stdin.
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

// --- Typing indicator management (shared between processGroupMessages and pipe path) ---
const typingIntervals: Record<string, ReturnType<typeof setInterval>> = {};

function startTypingIndicator(channel: Channel, chatJid: string): void {
  channel.setTyping?.(chatJid, true);
  if (typingIntervals[chatJid]) clearInterval(typingIntervals[chatJid]);
  typingIntervals[chatJid] = setInterval(() => {
    channel.setTyping?.(chatJid, true);
  }, 20_000);
}

function stopTypingIndicator(channel: Channel, chatJid: string): void {
  if (typingIntervals[chatJid]) {
    clearInterval(typingIntervals[chatJid]);
    delete typingIntervals[chatJid];
  }
  channel.setTyping?.(chatJid, false);
  channel.turn?.setStatus(chatJid, null);          // nothing is being worked on: nothing is said about it
}

/**
 * A turn begins (a container starts for a message, or a message is piped into one that was idle): the chips collected for the last answer are not this
 * one's, and the page may say TAi is working (the runner adds what it is doing, src/turn-status.ts). Web channel only.
 */
function beginTurnView(channel: Channel, chatJid: string): void {
  channel.turn?.resetSources(chatJid);
  channel.turn?.beginTurn?.(chatJid);              // (streaming: the last turn's preview state; nothing without the flag)
  channel.turn?.setStatus(chatJid, { state: 'working' });
}

/** What goes with TAi's answer to the channel: what its tools returned for this turn ("Looked at"), taken once; nothing for a notice that is not an answer. */
function answerExtras(channel: Channel, chatJid: string): MessageExtras | undefined {
  const sources = channel.turn?.takeSources(chatJid);
  return sources ? { sources } : undefined;
}

/** Check if a WhatsApp sender is on the admin allowlist. */
function isAdminSender(sender: string): boolean {
  if (ADMIN_PHONE_NUMBERS.length === 0) return true;
  const phone = sender.replace(/@.*$/, '');
  return ADMIN_PHONE_NUMBERS.includes(phone);
}

// Which channels to start: TAI_CHANNELS=whatsapp (default), web, or whatsapp,web.
const CHANNEL_NAMES = (process.env.TAI_CHANNELS || 'whatsapp')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Which background jobs run (competency bootstrap, teaching patrol, the course status page, the original's course sync and LeanRAG sync):
// they spawn containers on their own and have filled every slot before; see seeds.ts for the switches.
const SEEDS = seedSwitches(process.env);

let whatsapp: WhatsAppChannel | undefined;
let portal: Portal | null = null;
let stopCourseStatus: () => void = () => undefined;
let stopStudentCourse: () => void = () => undefined;
let voiceHub: { close(): Promise<void> } | null = null;
const channels: Channel[] = [];
const queue = new GroupQueue();
// The student model: after each answered exchange of a student's chat the host records what it showed in COMPETENCY.md and the logs, because the text
// models do not (src/competency-writer.ts, docs/STUDENT_MODEL.md). TAI_COMPETENCY_WRITER=on|shadow|off.
const competencyWriter = createCompetencyWriter({
  groupsDir: GROUPS_DIR,
  templateFile: path.join(GROUPS_DIR, 'global', 'COMPETENCY_TEMPLATE.md'),
  log: logger,
  readEnv: readEnvFile,
});
// What TAi remembers of a student's work (docs/STUDENT_STATE.md): after an answered exchange that shows code, an error or a repository, and after a finished voice
// call, the host keeps an issue, where the session stopped and a repository the student named (src/student-state-writer.ts). TAI_STATE_WRITER=on|shadow|off.
const stateWriter = createStudentStateWriter({
  log: logger,
  readEnv: readEnvFile,
  rememberWork: (folder, fact) => {
    try {
      return upsertWorkFact(folder, fact);
    } catch (err) {
      logger.warn({ err, folder, category: fact.category }, 'A fact of a student work could not be kept');
      return false;
    }
  },
  // the problems already on record, so that one that shows again is the same note and not another
  recorded: (folder) => listWorkFacts(folder).filter((f) => f.category === 'issue').map((f) => f.text),
});

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

/**
 * COMPETENCY.md from the template, with the name and accounts the registry knows (see competency-seed.ts). Every student turn begins by
 * reading that file; with nobody to create it, the model went looking for it with every tool it had. Never fails a registration.
 */
function seedCompetency(group: RegisteredGroup): void {
  if (group.folder === MAIN_GROUP_FOLDER) return;
  try {
    const result = seedCompetencyFile(path.join(GROUPS_DIR, group.folder), path.join(GROUPS_DIR, 'global', 'COMPETENCY_TEMPLATE.md'), {
      name: group.name,
      githubUsername: group.githubUsername,
      canvasUserId: group.canvasUserId,
    });
    if (result === 'created' || result === 'completed') logger.info({ folder: group.folder, result }, 'COMPETENCY.md seeded');
  } catch (err) {
    logger.warn({ err, folder: group.folder }, 'COMPETENCY.md could not be seeded');
  }
}

/** The one-time grade bootstrap is for a student's chat: not the admin group, and not the smoke tests' chats (each would hold a container slot for nothing). */
function wantsBootstrap(folder: string): boolean {
  return folder !== MAIN_GROUP_FOLDER && !folder.startsWith('smoke-');
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  seedCompetency(group);

  // Bootstrap COMPETENCY.md from Canvas grades for student groups
  if (SEEDS.bootstrap && wantsBootstrap(group.folder)) {
    const allTasks = getAllTasks();
    if (!hasBootstrapRun(group.folder, allTasks)) {
      seedCompetencyBootstrap(group.folder, jid);
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  let missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // Admin channel: only process messages from allowlisted phone numbers
  if (isMainGroup && ADMIN_PHONE_NUMBERS.length > 0) {
    missedMessages = missedMessages.filter(m => isAdminSender(m.sender));
    if (missedMessages.length === 0) return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // A student's reply gets a length rule after their messages (the teaching-team chat answers at its own length)
  const prompt = isMainGroup || !REPLY_RULE
    ? formatMessages(missedMessages)
    : withReplyRule(formatMessages(missedMessages), missedMessages.map((m) => m.content));

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  startTypingIndicator(channel, chatJid);
  beginTurnView(channel, chatJid);

  let hadError = false;
  let outputSentToUser = false;
  let emptyOutputRetried = false;
  // Track whether any output was produced after messages were piped.
  // If the container exits without responding to piped messages, we must
  // NOT advance the cursor — those messages need re-processing.
  let outputAfterPipe = false;
  const sendMessageFlagPath = path.join(DATA_DIR, 'ipc', group.folder, 'messages', '.send_message_used');

  // the student model: these messages begin a turn, and the file as it is now is that turn's "before" (a turn the container answers later begins at the pipe, below)
  if (!isMainGroup) competencyWriter.turnStarted(group.folder, missedMessages);
  if (!isMainGroup) stateWriter.turnStarted(group.folder, missedMessages);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks (the agent's internal reasoning) and redact system-prompt fingerprints: the same
      // filter as the send_message tool, so a reply that quotes the prompt does not reach the student by this path
      const text = isMainGroup || !REPLY_RULE ? formatOutbound(raw) : trimClosingFormula(formatOutbound(raw));
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      // Check if agent JUST sent via IPC tool (fresh per result — flag is created
      // each time an IPC tool fires, so only suppress the immediately following output).
      let ipcToolUsed = false;
      try {
        if (fs.existsSync(sendMessageFlagPath)) {
          ipcToolUsed = true;
          fs.unlinkSync(sendMessageFlagPath);
        }
      } catch { /* ignore */ }

      if (text) {
        if (ipcToolUsed) {
          logger.info({ group: group.name }, 'Suppressing text output (agent used send_message)');
        } else {
          await channel.sendMessage(chatJid, text, answerExtras(channel, chatJid));
        }
        stopTypingIndicator(channel, chatJid);
        emptyOutputRetried = false;
        // answered and sent: the student model is updated after it, in the background (never before the reply, never waited for)
        if (!isMainGroup) competencyWriter.turnFinished(group.folder, { reply: ipcToolUsed ? '' : text, apiFailure: result.apiFailure });
        if (!isMainGroup) stateWriter.turnFinished(group.folder, { reply: ipcToolUsed ? '' : text, apiFailure: result.apiFailure });
      } else if (ipcToolUsed) {
        // Agent sent via IPC tool and output was all <internal> — no retry needed.
        logger.info({ group: group.name }, 'Agent output was internal-only but sent via IPC tool, skipping retry');
        stopTypingIndicator(channel, chatJid);
        emptyOutputRetried = false;
        if (!isMainGroup) competencyWriter.turnFinished(group.folder, { reply: '', apiFailure: result.apiFailure });
        if (!isMainGroup) stateWriter.turnFinished(group.folder, { reply: '', apiFailure: result.apiFailure });
      } else if (!emptyOutputRetried) {
        // Agent output was entirely <internal> reasoning — student gets nothing.
        // Nudge the agent to produce a visible response (one retry only).
        emptyOutputRetried = true;
        logger.warn({ group: group.name }, 'Agent output stripped to empty (all internal), sending retry prompt');
        queue.sendMessage(chatJid,
          '[SYSTEM] Your previous output was entirely inside <internal> tags — the student received nothing. You MUST include student-facing text outside <internal> tags. Respond to the student now.');
      } else {
        logger.warn({ group: group.name }, 'Agent output stripped to empty after retry, giving up');
        channel.sendMessage(chatJid, "hey, sorry — I had a thought but lost it. what were you asking?").catch(() => {});
        stopTypingIndicator(channel, chatJid);
      }
      // Agent produced output — it likely already sent messages via IPC send_message.
      // Mark as sent even if text was stripped (all <internal>) to prevent
      // cursor rollback that would cause duplicate messages on error.
      outputSentToUser = true;
      // Track that output was produced after piped messages (so cursor can advance)
      if (pipedUpTo[chatJid] && pipedUpTo[chatJid] > (lastAgentTimestamp[chatJid] || '')) {
        outputAfterPipe = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    // The runner has answered everything it was sent and waits (what "everything" is: GroupQueue.markIdle). A turn that ended with no text (the answer
    // went out through send_message) started no timer above, so its container lived until CONTAINER_TIMEOUT (15 minutes) and its dots on the page
    // stayed on; now the idle timer starts here, the dots stop, and a student who waits for a slot may be given this one (docs/PROGRESS.md).
    if (result.idle && queue.markIdle(chatJid, result.received)) {
      stopTypingIndicator(channel, chatJid);
      resetIdleTimer();
    }
    // The runner is idle: no turn is in progress, so a send_message mark that is still here belongs to a turn that ended with no text at all (a null
    // result: the branch above reads the mark only when a text comes) and would hold back the NEXT turn's reply as "already sent by the tool". A turn
    // that had a text consumed its mark above; the message itself reaches the page through the IPC directory either way.
    if (result.idle) takeSendFlag(group.folder);

    if (result.status === 'error') {
      hadError = true;
    }
  }, progressForwarder({
    jid: chatJid,
    turn: new TurnStatus(),
    view: channel.turn,
    // streaming: once a tool has said the answer itself (the send tool, a diagram), the turn's own closing words are not sent, so they are not previewed either
    muted: () => fs.existsSync(sendMessageFlagPath),
  }));

  stopTypingIndicator(channel, chatJid);
  // (The chips of the turn are not cleared here: with a student waiting the container is closed within milliseconds of going idle, and a send_message
  // answer reaches the host up to a poll of the IPC directory, about a second, later. The next turn's start and the two minutes of SourceNotes clear them.)
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      // Piped messages may not have been processed — leave cursor as-is
      // so drainGroup can re-process them via a new container
      delete pipedUpTo[chatJid];
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    delete pipedUpTo[chatJid];
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    channel.sendMessage(chatJid, "sorry, something went wrong on my end — give me a sec and try again?").catch(() => {});
    return false;
  }

  // Advance cursor past messages piped to this container via sendMessage.
  // Only advance if the agent actually responded to the piped messages.
  // If the container timed out without producing output for piped messages,
  // leave the cursor so those messages get re-processed by the next container.
  if (pipedUpTo[chatJid] && pipedUpTo[chatJid] > (lastAgentTimestamp[chatJid] || '')) {
    if (outputAfterPipe) {
      lastAgentTimestamp[chatJid] = pipedUpTo[chatJid];
      saveState();
    } else {
      logger.warn(
        { group: group.name, pipedUpTo: pipedUpTo[chatJid] },
        'Piped messages got no response — leaving cursor for re-processing',
      );
    }
  }
  delete pipedUpTo[chatJid];

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (event: ProgressEvent) => void,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.resetSession) {
          delete sessions[group.folder];
          clearSession(group.folder);
        }
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // what the student's COMPETENCY.md says before the container starts: what it says after is the run's progress (the activity list)
  const masteryBefore = isMain ? null : masterySnapshot(GROUPS_DIR, group.folder);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        canvasUserId: group.canvasUserId,
        githubUsername: group.githubUsername,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      onProgress,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  } finally {
    if (masteryBefore) recordProgress(group.folder, masteryBefore);
  }
}

/** What changed in the course since the last sync (a new announcement, file or assignment, a deadline that moved or is near) goes to each student's activity list. */
function deliverCourseUpdates(previous: string, current: string): void {
  const updates = courseUpdates(previous, current);
  for (const update of updates) portal?.recordCourseUpdate({ type: 'course', ...update });
  if (updates.length > 0) logger.info({ count: updates.length, titles: updates.map((u) => u.title) }, 'Course updates put in the students\' activity lists');
}

/** A grade posted, an assignment marked missing, one due soon and not turned in: a line in the activity list of the student it is about, and nobody else's. */
function deliverStudentUpdates(canvasUserId: string, updates: CourseUpdate[]): void {
  for (const update of updates) portal?.recordForCanvasUser(canvasUserId, { type: 'course', ...update });
}

/** A concept the run moved up to "getting there" or "solid" is a line in the student's activity list (best-effort: it never fails the run). */
function recordProgress(folder: string, before: Map<string, number>): void {
  try {
    for (const step of progressSteps(before, masterySnapshot(GROUPS_DIR, folder))) {
      portal?.recordActivity(folder, { type: 'progress', title: 'Progress updated', text: `${step.concept}: ${step.was} → ${step.now}` });
    }
  } catch (err) {
    logger.warn({ folder, err }, 'Could not record a student\'s progress in the activity list');
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) {
            logger.warn({ chatJid, messageCount: groupMessages.length }, 'Message from unregistered JID — check groups config or JID mismatch');
            continue;
          }

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

          // Admin channel: skip if no messages are from allowlisted senders
          if (isMainGroup && ADMIN_PHONE_NUMBERS.length > 0) {
            const hasAdminMessage = groupMessages.some(m => isAdminSender(m.sender));
            if (!hasAdminMessage) continue;
          }

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Filter out messages already piped to the active container
          const pipedTs = pipedUpTo[chatJid] || lastAgentTimestamp[chatJid] || '';
          const unpiped = messagesToSend.filter(m => m.timestamp > pipedTs);
          if (unpiped.length === 0) continue;

          const formatted = isMainGroup || !REPLY_RULE
            ? formatMessages(unpiped)
            : withReplyRule(formatMessages(unpiped), unpiped.map((m) => m.content));

          // a message piped to a container that has answered everything begins a new turn (read before the pipe: it makes the container busy)
          const beginsTurn = queue.isIdle(chatJid);
          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: unpiped.length },
              'Piped messages to active container',
            );
            // Track piped messages to prevent re-piping, but DON'T advance
            // lastAgentTimestamp — only processGroupMessages does that after
            // confirmed processing. Ensures piped-but-unprocessed messages
            // are re-discovered if the container crashes.
            pipedUpTo[chatJid] = unpiped[unpiped.length - 1].timestamp;
            // the student model: a warm container answers these as a turn of its own (the first batch was noted in processGroupMessages)
            if (!isMainGroup) competencyWriter.turnStarted(group.folder, unpiped);
            if (!isMainGroup) stateWriter.turnStarted(group.folder, unpiped);
            // Restart typing indicator while the container processes the piped message
            startTypingIndicator(channel, chatJid);
            // after the dots: starting them clears the status, and this turn begins with "working" (the runner adds what it is doing)
            if (beginsTurn) beginTurnView(channel, chatJid);
          } else {
            // No active container — debounce before spawning a new one.
            // Students often send fragmented WhatsApp messages ("hey" → "about raft"
            // → "how does leader election work?"). Waiting DEBOUNCE_MS after the
            // last message ensures all fragments are included in the initial prompt.
            delete pipedUpTo[chatJid];
            if (!debounceTimers[chatJid]) {
              // Show typing immediately so student knows we're processing
              startTypingIndicator(channel, chatJid);
              debounceTimers[chatJid] = setTimeout(() => {
                delete debounceTimers[chatJid];
                queue.enqueueMessageCheck(chatJid);
              }, DEBOUNCE_MS);
            }
            // If timer already set, new messages will be picked up when it fires
            // (processGroupMessages re-fetches all pending via getMessagesSince)
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }
}

/**
 * Kill any leftover containers of THIS orchestrator (names that start with CONTAINER_PREFIX) from previous sessions.
 * Orphaned containers share the same IPC directory and steal messages
 * meant for the current session's containers. Another orchestrator's containers (another prefix) are not touched.
 */
function killStaleContainers(): void {
  try {
    const result = execSync(
      `docker ps -q --filter "name=^${CONTAINER_PREFIX}-"`,
      { stdio: 'pipe', timeout: 10000 },
    ).toString().trim();

    if (result) {
      const ids = result.split('\n').filter(Boolean);
      logger.info({ count: ids.length }, 'Killing stale containers from previous sessions');
      execSync(`docker rm -f ${ids.join(' ')}`, { stdio: 'pipe', timeout: 30000 });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale containers');
  }
}

async function main(): Promise<void> {
  ensureDockerRunning();
  killStaleContainers();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  // chats registered before this existed get their file at the first start after
  for (const group of Object.values(registeredGroups)) seedCompetency(group);

  // Running a student's Go code (docs/GO_SANDBOX.md): a disposable container started by the host, never the agent container. TAI_SANDBOX=0 switches it off (every request then says so);
  // without the image (tai_live.sh sandbox build) every request says it is not set up. The reaper removes containers and run directories that outlived their time.
  const sandbox = process.env.TAI_SANDBOX === '0' ? undefined : createSandbox({
    dir: path.join(DATA_DIR, 'sandbox'),
    uploadsDir: (folder) => path.join(GROUPS_DIR, folder, 'uploads'),
    githubToken: () => process.env.GITHUB_TOKEN_PUBLIC || readEnvFile(['GITHUB_TOKEN_PUBLIC']).GITHUB_TOKEN_PUBLIC,   // read at each fetch, never kept
    rates: createSqliteRates(),
    log: logger,
  });
  const runSandbox: SandboxApi['run'] | undefined = sandbox ? (who, request) => sandbox.run(who, request) : undefined;
  let sandboxReaper: ReturnType<typeof setInterval> | undefined;
  if (sandbox) {
    void sandbox.reap();
    sandboxReaper = setInterval(() => void sandbox.reap(), 60_000);
    sandboxReaper.unref();
  }
  logger.info({ sandbox: !!sandbox }, 'Go sandbox');

  // The document viewer's service (docs/DOCUMENTS.md, docs/CHAT_OBJECTS.md): a PDF is turned into page images and words by a disposable container, kept for the student, and shown by the page's
  // viewer and the calls' show_document; TAI_DOCS=0 turns it off (the page has no viewer then), and without the image (tai_live.sh doc build) every open says it is not set up.
  const docs = process.env.TAI_DOCS === '0' ? undefined : createDocs({
    dir: path.join(DATA_DIR, 'docs'),
    storeDir: STORE_DIR,
    uploadsDir: (folder) => path.join(GROUPS_DIR, folder, 'uploads'),
    log: logger,
    // the course's Canvas files a student may name (docs/COURSE_DOCS.md, "Canvas files"): the host lists and downloads them with the operator's token, read from the host's .env at each use; TAI_CANVAS_DOCS=0 turns it off
    canvas:
      process.env.TAI_CANVAS_DOCS === '0'
        ? undefined
        : createCanvasSource({
            settings: () => {
              const env = readEnvFile(['CANVAS_BASE_URL', 'CANVAS_API_TOKEN', 'CANVAS_COURSE_ID']);
              return env.CANVAS_BASE_URL && env.CANVAS_API_TOKEN && env.CANVAS_COURSE_ID ? { base: env.CANVAS_BASE_URL, token: env.CANVAS_API_TOKEN, course: env.CANVAS_COURSE_ID } : null;
            },
            log: logger,
          }),
  });
  let docsReaper: ReturnType<typeof setInterval> | undefined;
  if (docs) {
    void docs.reap();
    docsReaper = setInterval(() => void docs.reap(), 60_000);
    docsReaper.unref();
    void docs.searchLibrary('warm up');          // builds the course library's search index now, not during the first student's turn (src/docs/library-search.ts; never throws)
  }
  logger.info({ docs: !!docs }, 'Document viewer');

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (sandboxReaper) clearInterval(sandboxReaper);
    if (docsReaper) clearInterval(docsReaper);
    await queue.shutdown(10000);
    await competencyWriter.flush(4000);          // the exchange answered a moment ago is still being recorded
    stopCourseStatus();
    stopStudentCourse();
    await voiceHub?.close();          // before the page: the notes a call still has to write (summary, competency) must not be lost
    await stateWriter.flush(4000);    // after the calls: what a call that just ended, or an exchange answered a moment ago, has to keep of the student's work
    await portal?.close();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  if (CHANNEL_NAMES.includes('whatsapp')) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }
  if (CHANNEL_NAMES.includes('web')) {
    const web = new WebChannel({ ...channelOpts, registerGroup, media: mediaStore, queuePosition: (jid) => queue.queuePosition(jid) });
    channels.push(web);
    await web.connect();
    // The student page (src/portal): only when TAI_PORTAL_SOCKET or TAI_PORTAL_PORT is set, and then only with its allowlist and secret.
    portal = await startPortal(web, {
      registeredGroups: () => registeredGroups,
      registerGroup,
      // the document viewer (its routes and the page's pane), and, through the portal's context, the calls' show_document: docs/CHAT_OBJECTS.md
      docs,
      // a prediction card's Run button runs the card's own program in the sandbox (docs/PREDICT.md)
      runSandbox,
      // voice calls and the mock interview (src/voice, docs/VOICE.md): none unless TAI_VOICE=1 and a Deepgram key is stored
      createVoice: (ctx) =>
        (voiceHub = createVoiceHub({
          groupsDir: GROUPS_DIR,
          dataDir: DATA_DIR,
          storeDir: STORE_DIR,
          publicBase: ctx.publicBase,
          publicOrigin: ctx.publicOrigin,
          secretFile: ctx.secretFile,
          ...chatFromPortal(ctx.history, ctx.wakeStudent),
          // run_code: a student's Go code in the sandbox (docs/GO_SANDBOX.md)
          runSandbox,
          // where the student's page says it is looking, and the document viewer's service (docs/CHAT_OBJECTS.md): show_document, point_at, look_at_screen and each turn's screen note use them
          views: ctx.views,
          docs: ctx.docs,
          // the card on line n of the student's chat (a run, a chart ...): what the screen note says of a card they picked a part of
          objectOf: (folder, n) => {
            try {
              const line = ctx.history.forFolder(folder).get(n);
              return line?.kind === 'object' && line.obj ? line.obj : null;
            } catch {
              return null;
            }
          },
          // what TAi remembers of a student's work (docs/STUDENT_STATE.md): read for the conversation and the interviewer, kept by the host when an interview reads a repository and after a call
          workFacts: (folder) => {
            try {
              return listWorkFacts(folder);
            } catch (err) {
              logger.warn({ err, folder }, 'The facts of a student work could not be read');
              return [];
            }
          },
          rememberWork: (folder, fact) => {
            try {
              if (!upsertWorkFact(folder, fact)) logger.debug({ folder, category: fact.category }, 'A fact of a student work was refused');
            } catch (err) {
              // (the category, never the key: a key is made of what a student said)
              logger.warn({ err, folder, category: fact.category }, 'A fact of a student work could not be kept');
            }
          },
          forgetWork: (folder, key) => {
            try {
              deleteWorkFact(folder, key);
            } catch (err) {
              logger.warn({ err, folder }, 'A fact of a student work could not be taken back');
            }
          },
          // a finished call goes through the state writer once: an issue, where the call stopped, a repository the student named
          workFromCall: (input) => stateWriter.fromCall(input),
          // a row for the text agent's next start; a bot message, so it is read as context but starts nothing
          recordVoiceSummary: (jid, text) =>
            storeMessageDirect({
              id: `voice-${randomUUID()}`,
              chat_jid: jid,
              sender: 'voice_session',
              sender_name: ASSISTANT_NAME,
              content: text,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
            }),
          preemptTextAgent: (jid) => queue.closeStdin(jid),
          // a tool host started ahead of a call never takes the last container slot: a student's chat reply needs it
          spareContainer: () => queue.hasSpareSlot(),
          spawnToolHost: (folder) =>
            new DockerToolHost({
              log: logger,
              // the container's start and its wait for its servers fit in this (src/voice/tool-host.ts TOOL_HOST_READY_TIMEOUT_MS; TAI_VOICE_TOOLHOST_READY_SEC)
              readyTimeoutMs: toolHostReadyTimeoutMs(process.env),
              spawn: async () => {
                const entry = Object.entries(registeredGroups).find(([, g]) => g.folder === folder);
                if (!entry) throw new Error(`no registered group for ${folder}`);
                return spawnToolHost(entry[1], entry[0]);
              },
            }),
          registeredGroup: (folder) => {
            const entry = Object.entries(registeredGroups).find(([, g]) => g.folder === folder);
            return entry ? { jid: entry[0], canvasUserId: entry[1].canvasUserId, githubUsername: entry[1].githubUsername } : undefined;
          },
          readEnv: readEnvFile,
          log: logger,
        })),
    });
  }
  if (channels.length === 0) {
    throw new Error(`No channel started: TAI_CHANNELS=${process.env.TAI_CHANNELS || ''} names none of whatsapp, web`);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
  });
  startIpcWatcher({
    // a card in a student's chat (a run of their code: docs/CHAT_OBJECTS.md); throws when the chat did not take it
    postObject: (folder, obj) => {
      if (!portal) throw new Error('the page is not running');
      portal.postObject(folder, obj);
    },
    runSandbox,
    // show_document for the text agent: a document prepared for the student's viewer (docs/DOCUMENTS.md)
    docs,
    // the student page's activity list: a note TAi kept, a reminder it set
    recordActivity: (folder, entry) => portal?.recordActivity(folder, entry),
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText);
      if (!text) return Promise.resolve();
      // the answer TAi wrote with its send_message tool: what its lookups returned in this turn goes with it, as with an answer in the result
      return channel.sendMessage(jid, text, answerExtras(channel, jid));
    },
    sendReaction: async (jid, messageId, emoji) => {
      await findChannel(channels, jid)?.sendReaction?.(jid, messageId, emoji);
    },
    sendAudioMessage: async (jid, buffer) => {
      await findChannel(channels, jid)?.sendAudioMessage?.(jid, buffer);
    },
    sendImageMessage: async (jid, buffer, caption) => {
      await findChannel(channels, jid)?.sendImageMessage?.(jid, buffer, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  // the line of students who wait for a container moved: each page that is showing "waiting" reads its place again (the status itself is read from the queue)
  let waitingBefore: string[] = [];
  queue.setWaitingListener((waiting) => {
    for (const jid of new Set([...waitingBefore, ...waiting])) findChannel(channels, jid)?.turn?.refreshStatus(jid);
    waitingBefore = waiting;
  });
  if (!anySeed(SEEDS)) {
    logger.warn('TAI_NO_SEEDS=1: no background job (competency bootstrap, teaching patrol, course status) is started');
  } else {
    logger.info(SEEDS, 'Background jobs');
    if (SEEDS.patrol) seedTeachingPatrol(registeredGroups);
    if (SEEDS.courseStatus) stopCourseStatus = startCourseStatusJob(process.env, { onChange: deliverCourseUpdates });
    if (SEEDS.studentCourse) stopStudentCourse = startStudentCourseJob(process.env, { deliver: deliverStudentUpdates });
    if (SEEDS.courseSyncAgent) seedCourseSync(registeredGroups);
    if (SEEDS.leanragSync) startLeanRAGSync();

    // Bootstrap COMPETENCY.md for any existing student groups that haven't been bootstrapped
    if (SEEDS.bootstrap) {
      const allTasks = getAllTasks();
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (wantsBootstrap(group.folder) && !hasBootstrapRun(group.folder, allTasks)) {
          seedCompetencyBootstrap(group.folder, jid);
        }
      }
    }
  }
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests.
// On Windows, PM2 sets process.argv[1] to its own ProcessContainerFork.js,
// so we also detect PM2 via NODE_APP_INSTANCE (set by all PM2 versions).
const isDirectRun =
  process.env.NODE_APP_INSTANCE !== undefined ||
  (process.argv[1] != null &&
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]));

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
