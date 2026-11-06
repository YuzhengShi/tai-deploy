import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Messages prioritized over tasks: a student is waiting in real time (drainGroup) ---

  it('drains messages before tasks for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // The pending message check runs before the queued task: the student is waiting, the task is not
    expect(executionOrder).toEqual(['messages', 'messages', 'task']);
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Scheduled tasks must not take every slot ---

  it('lets a limited number of containers be scheduled tasks and keeps the rest for messages', async () => {
    const q = new GroupQueue(1);              // one task at a time, two containers in all (the mocked limit)
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    const task = (name: string) => () =>
      new Promise<void>((resolve) => {
        started.push(name);
        release[name] = resolve;
      });
    q.setProcessMessagesFn(async () => {
      started.push('message');
      return true;
    });

    q.enqueueTask('group1@g.us', 'patrol-1', task('patrol-1'));
    q.enqueueTask('group2@g.us', 'patrol-2', task('patrol-2'));       // a second container is free, the cap on tasks says wait
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(['patrol-1']);

    q.enqueueMessageCheck('group3@g.us');                              // the student gets the free slot
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(['patrol-1', 'message']);

    release['patrol-1']();
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(['patrol-1', 'message', 'patrol-2']);      // when the first task is done the next one goes
    release['patrol-2']();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('serves a waiting message before a waiting task when a slot frees up', async () => {
    const q = new GroupQueue(2);
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    const hold = (name: string) => () =>
      new Promise<void>((resolve) => {
        started.push(name);
        release[name] = resolve;
      });
    q.setProcessMessagesFn(async (jid: string) => {
      started.push('message ' + jid);
      return true;
    });
    q.enqueueTask('group1@g.us', 'a', hold('a'));
    q.enqueueTask('group2@g.us', 'b', hold('b'));                      // both containers busy with tasks
    q.enqueueTask('group3@g.us', 'c', hold('c'));                      // waits
    q.enqueueMessageCheck('group4@g.us');                              // waits too, but it is a student
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual(['a', 'b']);
    release['a']();
    await vi.advanceTimersByTimeAsync(10);
    // the student first, though the task was in line earlier; the message is answered at once, so the task follows
    expect(started).toEqual(['a', 'b', 'message group4@g.us', 'c']);
    release['b']();
    release['c']();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- The last slot stays for a student (a voice call's tool host started ahead of the call asks first: src/voice/hub.ts spareContainer) ---

  it('has a spare slot only while another is free after it: the last slot is kept for a student who writes', async () => {
    const release: Array<() => void> = [];
    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => release.push(resolve));
      return true;
    });

    expect(queue.hasSpareSlot()).toBe(true);                     // nothing runs: both of the two slots (the mocked limit) are free
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.hasSpareSlot()).toBe(false);                    // one runs and one is free: that one is a student's, not for something started ahead
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.hasSpareSlot()).toBe(false);                    // all taken

    release[0]();
    release[1]();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.hasSpareSlot()).toBe(true);                     // both gone: room again
  });

});
