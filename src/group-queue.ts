import { ChildProcess } from 'child_process';

import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
/**
 * How many of the containers may be scheduled tasks (the grade bootstrap, the morning patrol) at once. The rest are for students who are
 * waiting for an answer: with the seeds on, a start with a hundred students on the roster queues a hundred background runs, and when they
 * shared the slots equally the first student to write waited behind them for minutes.
 */
const DEFAULT_MAX_TASKS = Math.max(1, parseInt(process.env.TAI_MAX_CONCURRENT_TASKS || '2', 10) || 2);
/**
 * A container that was closed for a waiting student counts as a slot about to be free for this long; after it the next idle one may be closed
 * as well (a runner that never reacts to the end of its stdin would otherwise hold the waiters back for as long as it lives).
 */
const PREEMPT_GRACE_MS = 15_000;

interface GroupState {
  active: boolean;
  runningTask: boolean; // true when container is running a scheduled task (not a message handler)
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  /**
   * The runner said it has answered everything it was sent and nothing has been piped or queued for it since: the container holds a slot and does
   * nothing (the time it said so). `pendingMessages` cannot tell: a message piped into a warm container leaves it set until the container exits.
   */
  idleSince: number | null;
  /** How many follow-up messages were piped into this container: the runner counts what it received, and markIdle compares the two. */
  piped: number;
  /** When this container was closed for a student who waits (its slot is on its way to them), or null. */
  preemptedAt: number | null;
  /** When a student's message was handed to the queue without a container to take it (at the cap, or the group's own container is closing); null: none waits. */
  requestedAt: number | null;
}

export interface GroupQueueOptions {
  /** Close the stdin of the container that has been idle longest when a student's message must wait at the cap. Default: on, unless TAI_PREEMPT_IDLE=0. */
  preemptIdle?: boolean;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private activeTasks = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private readonly preemptIdle: boolean;
  private waitingListener: ((waiting: string[]) => void) | null = null;
  private lastWaiting = '';

  constructor(private readonly maxTasks: number = DEFAULT_MAX_TASKS, options: GroupQueueOptions = {}) {
    this.preemptIdle = options.preemptIdle ?? process.env.TAI_PREEMPT_IDLE !== '0';
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        runningTask: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        idleSince: null,
        piped: 0,
        preemptedAt: null,
        requestedAt: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      // a message that could not be piped (the container's stdin is closed, or it is a task's) waits for this group's own container to go: that
      // container is not idle, whatever the runner said before
      state.idleSince = null;
      state.requestedAt ??= Date.now();
      // If a scheduled task is occupying this group's slot, close its stdin
      // so it exits promptly instead of waiting for the full idle timeout.
      // The student is waiting in real time; the task's work is already done.
      if (state.runningTask && state.process?.stdin && !state.process.stdin.destroyed) {
        logger.info({ groupJid }, 'Student message arrived during scheduled task, closing task stdin to expedite');
        try { state.process.stdin.end(); } catch { /* already closed */ }
      }
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      state.requestedAt ??= Date.now();
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      this.notifyWaiting();
      // a container that has answered and waits for a next message that may never come holds a slot this student could have (docs/PROGRESS.md)
      this.rebalance();
      return;
    }

    this.runForGroup(groupJid, 'messages');
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS || this.activeTasks >= this.maxTasks) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn });
  }

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Send a follow-up message to the active container via stdin NDJSON.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    // Don't pipe user messages into scheduled task containers — the task has its own
    // prompt/context and won't handle conversational messages correctly. Return false
    // so the message loop queues it via debounce → enqueueMessageCheck instead.
    if (state.runningTask) return false;
    const stdin = state.process?.stdin;
    if (!state.active || !stdin?.writable || stdin.writableEnded || stdin.destroyed) return false;

    try {
      stdin.write(JSON.stringify({ type: 'message', text }) + '\n');
      // Safety net: if the container crashes before processing this piped
      // message, drainGroup will start a new container to re-process.
      state.pendingMessages = true;
      // the container has work again: it is no longer idle, and the runner's next idle marker has to say it has received this one too
      state.idleSince = null;
      state.piped++;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The runner says it has answered what it was sent and waits (the `idle` marker of its output). Returns whether the container is idle now: false
   * for a task's container, for one with a message queued behind it, and for one the runner has not caught up with: `received` is how many follow-up
   * messages the runner has taken in, and a marker that counts fewer than were piped (a message went in after the runner wrote it, or in answer to
   * the result just before it: the empty-reply nudge) is out of date. A runner that does not count (`received` undefined: an image from before it
   * did) is taken for idle only when nothing was ever piped to it.
   *
   * An idle container that a student's message is waiting for is closed at once (see rebalance).
   */
  markIdle(groupJid: string, received?: number): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || state.runningTask || state.requestedAt !== null) return false;
    if (received === undefined ? state.piped > 0 : received < state.piped) return false;
    state.idleSince = Date.now();
    this.rebalance();
    return true;
  }

  /** Whether the runner of this group's container has said it is idle, and nothing has been sent to it since. */
  isIdle(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return !!state && state.active && state.idleSince !== null;
  }

  /**
   * Is there a container's worth of room for something nobody is waiting for yet, such as a voice call's tool host started ahead of the call
   * (src/voice/hub.ts `spareContainer`)? True while at least two slots are free: the last one is always kept for a student who writes. The
   * queue counts its own containers only (a tool host is not one of them), so this is the answer for the text agents' side.
   */
  hasSpareSlot(): boolean {
    return this.activeCount < MAX_CONCURRENT_CONTAINERS - 1;
  }

  /**
   * Where a student's message stands when it waits for a container: how many other students' messages are in line before it. Null when it does not
   * wait (it runs, or nothing is asked of this group). The line is the order in which the messages were handed over, and a waiting task never goes
   * before a message, so the number is the number of other students ahead: nothing is estimated.
   */
  queuePosition(groupJid: string): { ahead: number } | null {
    const at = this.waitingGroups.indexOf(groupJid);
    const state = this.groups.get(groupJid);
    if (at < 0 || !state || state.requestedAt === null || state.active) return null;
    return { ahead: this.waitingGroups.slice(0, at).filter((jid) => this.isMessageWaiter(jid)).length };
  }

  /** Called with the jids whose messages wait for a slot, in line order, whenever that list changes (not for a task that waits). */
  setWaitingListener(listener: ((waiting: string[]) => void) | null): void {
    this.waitingListener = listener;
    this.lastWaiting = '';
  }

  private isMessageWaiter(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return !!state && !state.active && state.requestedAt !== null;
  }

  private notifyWaiting(): void {
    if (!this.waitingListener) return;
    const waiting = this.waitingGroups.filter((jid) => this.isMessageWaiter(jid));
    const key = waiting.join('\n');
    if (key === this.lastWaiting) return;
    this.lastWaiting = key;
    try {
      this.waitingListener(waiting);
    } catch (err) {
      logger.warn({ err }, 'Waiting-line listener failed');
    }
  }

  /**
   * Frees slots for the students who wait. A chat container holds its slot for IDLE_TIMEOUT after its answer (2 minutes) in case the student writes
   * again; when a message is waiting for a slot that wait is no longer worth it, so the container that has been idle longest is closed (its
   * stdin ends, the runner exits, the slot goes to the first in line). One container per waiting message, counting the ones already on their way
   * out. Never a busy container, one that a message was piped to (not idle until the runner has caught up), one with a message or a task queued
   * behind it (its slot would go to that, not to the student who waits), or a task's. Runs when a message starts to wait and when a container
   * says it is idle: in a burst every slot is busy at the first, and the idle ones only appear later.
   */
  private rebalance(): void {
    if (!this.preemptIdle || this.shuttingDown) return;
    const now = Date.now();
    const waiting = this.waitingGroups.filter((jid) => this.isMessageWaiter(jid)).length;
    if (waiting === 0) return;
    let closing = 0;
    for (const state of this.groups.values()) {
      if (state.active && state.preemptedAt !== null && now - state.preemptedAt < PREEMPT_GRACE_MS) closing++;
    }
    let needed = waiting - closing;
    if (needed <= 0) return;
    const candidates = [...this.groups.entries()]
      .filter(([, s]) => {
        const stdin = s.process?.stdin;
        return (
          s.active && !s.runningTask && s.idleSince !== null && s.preemptedAt === null && s.requestedAt === null && s.pendingTasks.length === 0 &&
          !!stdin && !stdin.destroyed && !stdin.writableEnded
        );
      })
      .sort((a, b) => (a[1].idleSince as number) - (b[1].idleSince as number));
    for (const [groupJid, state] of candidates) {
      if (needed-- <= 0) break;
      state.preemptedAt = now;
      logger.info({ groupJid, idleMs: now - (state.idleSince as number), waiting }, 'Closing an idle container: a student is waiting for its slot');
      try {
        state.process?.stdin?.end();
      } catch {
        /* the process is going anyway */
      }
    }
  }

  /**
   * Signal the active container to wind down by closing stdin (EOF).
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.process?.stdin) return;

    try {
      state.process.stdin.end();
    } catch {
      // process may have exited
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.pendingMessages = false;
    state.idleSince = null;
    state.piped = 0;
    state.preemptedAt = null;
    state.requestedAt = null;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      const closedForWaiter = state.preemptedAt !== null;
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.idleSince = null;
      state.piped = 0;
      state.preemptedAt = null;
      this.activeCount--;
      if (closedForWaiter && state.requestedAt !== null && this.waitingGroups.some((jid) => jid !== groupJid && this.isMessageWaiter(jid))) {
        // this container was closed so that a student who waited could have its slot, and its own student has written since: they take their place at
        // the back of the line (drainGroup would hand them the slot first, which is the one it was closed for)
        if (!this.waitingGroups.includes(groupJid)) this.waitingGroups.push(groupJid);
        this.drainWaiting();
      } else {
        this.drainGroup(groupJid);
      }
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.runningTask = true;
    state.idleSince = null;
    state.piped = 0;
    state.preemptedAt = null;
    this.activeCount++;
    this.activeTasks++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.runningTask = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.idleSince = null;
      this.activeCount--;
      this.activeTasks--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Messages first — student is waiting in real time
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain');
      return;
    }

    // Then tasks (they won't be re-discovered from SQLite like messages), as many as the cap lets run
    if (state.pendingTasks.length > 0) {
      if (this.activeTasks < this.maxTasks) {
        const task = state.pendingTasks.shift()!;
        this.runTask(groupJid, task);
        return;
      }
      if (!this.waitingGroups.includes(groupJid)) this.waitingGroups.push(groupJid);
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (this.waitingGroups.length > 0 && this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      // Messages first (a student is waiting in real time); then a task, if the cap on tasks lets one run
      let at = this.waitingGroups.findIndex((jid) => this.getGroup(jid).pendingMessages);
      if (at < 0 && this.activeTasks < this.maxTasks) at = this.waitingGroups.findIndex((jid) => this.getGroup(jid).pendingTasks.length > 0);
      if (at < 0) {
        // nothing can run now: groups with nothing pending are forgotten, those whose tasks wait for the cap stay in line
        this.waitingGroups = this.waitingGroups.filter((jid) => {
          const waiting = this.getGroup(jid);
          return waiting.pendingMessages || waiting.pendingTasks.length > 0;
        });
        return;
      }
      const [nextJid] = this.waitingGroups.splice(at, 1);
      const state = this.getGroup(nextJid);
      if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain');
      } else {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task);
      }
    }
    // the line moved (or a student still waits for a slot that no idle container could give yet)
    this.notifyWaiting();
    this.rebalance();
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Close stdin for all active containers — triggers graceful EOF exit.
    // This lets processGroupMessages complete and advance lastAgentTimestamp
    // past any piped messages, preventing phantom "unprocessed" messages on
    // next startup.
    for (const [_jid, state] of this.groups) {
      if (state.process?.stdin && !state.process.stdin.destroyed) {
        try { state.process.stdin.end(); } catch { /* already closed */ }
      }
    }

    if (this.activeCount > 0) {
      logger.info(
        { activeCount: this.activeCount },
        'Waiting for active containers to finish',
      );
      const deadline = Date.now() + gracePeriodMs;
      while (this.activeCount > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (this.activeCount > 0) {
        logger.warn(
          { activeCount: this.activeCount },
          'Grace period expired, some containers still active',
        );
      }
    }

    logger.info('GroupQueue shutdown complete');
  }
}
