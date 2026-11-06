/**
 * Idle containers and the students who wait (docs/PROGRESS.md): a chat container that has answered holds its slot for IDLE_TIMEOUT in case the
 * student writes again; when a message must wait at the cap that slot is given back at once, to the first in line. The tests use the queue's own
 * fake style (group-queue.test.ts): three slots, containers that are promises, a process with a stdin that records `end`.
 */
import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupQueue, type GroupQueueOptions } from './group-queue.js';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 3,
}));

interface FakeStdin {
  writable: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function rig(options?: GroupQueueOptions) {
  const queue = new GroupQueue(2, options);
  const stdin: Record<string, FakeStdin> = {};
  const exits: Record<string, () => void> = {};
  const started: string[] = [];
  const proc = (jid: string): ChildProcess => {
    const s: FakeStdin = { writable: true, writableEnded: false, destroyed: false, write: vi.fn(() => true), end: vi.fn() };
    s.end.mockImplementation(() => {
      s.writableEnded = true;
    });
    stdin[jid] = s;
    return { stdin: s } as unknown as ChildProcess;
  };
  queue.setProcessMessagesFn(async (jid) => {
    started.push(jid);
    queue.registerProcess(jid, proc(jid), `container-${jid}`);
    await new Promise<void>((resolve) => {
      exits[jid] = resolve;
    });
    return true;
  });
  return { queue, stdin, exits, started, proc };
}

const flush = () => vi.advanceTimersByTimeAsync(10);

/** Three chats running, as the cap allows. */
async function full(options?: GroupQueueOptions) {
  const r = rig(options);
  for (const jid of ['a', 'b', 'c']) r.queue.enqueueMessageCheck(jid);
  await flush();
  expect(r.started).toEqual(['a', 'b', 'c']);
  return r;
}

describe('a container that is idle while a message waits for a slot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is closed when a message must wait: the one that has been idle longest, and only that one', async () => {
    const { queue, stdin, exits, started } = await full();
    queue.markIdle('b', 0);                                  // b answered first
    await vi.advanceTimersByTimeAsync(1000);
    queue.markIdle('a', 0);                                  // a a second later; c is still busy
    queue.enqueueMessageCheck('d');                          // at the cap: d waits
    expect(stdin.b.end).toHaveBeenCalledTimes(1);
    expect(stdin.a.end).not.toHaveBeenCalled();
    expect(stdin.c.end).not.toHaveBeenCalled();
    exits.b();                                               // b's runner exits at the end of its stdin: the slot goes to d at once
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is closed the moment it goes idle, when the message was already waiting (every slot was busy when the burst came)', async () => {
    const { queue, stdin } = await full();
    queue.enqueueMessageCheck('d');
    queue.enqueueMessageCheck('e');
    for (const jid of ['a', 'b', 'c']) expect(stdin[jid].end).not.toHaveBeenCalled();      // nothing was idle to close
    queue.markIdle('a', 0);
    expect(stdin.a.end).toHaveBeenCalledTimes(1);
    queue.markIdle('b', 0);
    expect(stdin.b.end).toHaveBeenCalledTimes(1);
    queue.markIdle('c', 0);                                  // two students wait, two containers have been closed for them
    expect(stdin.c.end).not.toHaveBeenCalled();
  });

  it('is closed once for one waiting message, however often it is asked: containers on their way out count', async () => {
    const { queue, stdin } = await full();
    queue.markIdle('a', 0);
    queue.markIdle('b', 0);
    queue.enqueueMessageCheck('d');
    queue.enqueueMessageCheck('d');                          // the same student's second message is not a second waiter
    queue.markIdle('c', 0);
    const closed = ['a', 'b', 'c'].filter((jid) => stdin[jid].end.mock.calls.length > 0);
    expect(closed).toEqual(['a']);
    expect(stdin.a.end).toHaveBeenCalledTimes(1);
  });

  it('is never a busy one: a message that has been piped is not answered until the runner says it has received it', async () => {
    const { queue, stdin } = await full();
    queue.markIdle('a', 0);
    expect(queue.sendMessage('a', 'one more thing')).toBe(true);        // the student writes again: a is busy
    queue.enqueueMessageCheck('d');
    expect(stdin.a.end).not.toHaveBeenCalled();
    // the idle marker the runner wrote before it read that message does not make it idle (it has received 0 of the 1 piped)
    expect(queue.markIdle('a', 0)).toBe(false);
    expect(queue.isIdle('a')).toBe(false);
    expect(stdin.a.end).not.toHaveBeenCalled();
    expect(queue.markIdle('a', 1)).toBe(true);               // the next one counts it: now it is idle, and d waits
    expect(stdin.a.end).toHaveBeenCalledTimes(1);
  });

  it('is not idle when its runner cannot count and something was piped to it, and is when nothing was', async () => {
    const { queue } = await full();
    expect(queue.markIdle('a')).toBe(true);
    queue.sendMessage('b', 'hi');
    expect(queue.markIdle('b')).toBe(false);
  });

  it('is never one with a message waiting behind it (its stdin is closed, or it is a task\'s), nor one with a task queued', async () => {
    const { queue, stdin } = await full();
    queue.markIdle('a', 0);
    queue.markIdle('b', 0);
    queue.closeStdin('a');                                   // the container's own idle timer closed it
    expect(queue.sendMessage('a', 'late')).toBe(false);      // cannot be piped: it waits for the container to go
    queue.enqueueMessageCheck('a');
    expect(queue.isIdle('a')).toBe(false);
    queue.enqueueTask('b', 'patrol-b', async () => undefined);     // b's own task is next: the slot would go to it, not to the student
    queue.enqueueMessageCheck('d');
    expect(stdin.a.end).toHaveBeenCalledTimes(1);            // only the closeStdin above
    expect(stdin.b.end).not.toHaveBeenCalled();
    expect(stdin.c.end).not.toHaveBeenCalled();
  });

  it('is never a scheduled task\'s container', async () => {
    const r = rig();
    const release: Record<string, () => void> = {};
    const task = (jid: string) => async () => {
      r.queue.registerProcess(jid, r.proc(jid), `task-${jid}`);
      await new Promise<void>((resolve) => {
        release[jid] = resolve;
      });
    };
    r.queue.enqueueTask('t1', 'task-1', task('t1'));
    r.queue.enqueueTask('t2', 'task-2', task('t2'));
    r.queue.enqueueMessageCheck('c');
    await flush();
    expect(r.queue.markIdle('t1', 0)).toBe(false);           // the scheduler ends a task by its own timer
    r.queue.enqueueMessageCheck('d');
    expect(r.stdin.t1.end).not.toHaveBeenCalled();
    expect(r.stdin.t2.end).not.toHaveBeenCalled();
    release.t1();
    release.t2();
    await flush();
  });

  it('is left alone when TAI_PREEMPT_IDLE is off: the idle bookkeeping stays, nothing is closed', async () => {
    const { queue, stdin } = await full({ preemptIdle: false });
    expect(queue.markIdle('a', 0)).toBe(true);
    queue.enqueueMessageCheck('d');
    queue.markIdle('b', 0);
    for (const jid of ['a', 'b', 'c']) expect(stdin[jid].end).not.toHaveBeenCalled();
  });

  it('does not keep a container that never leaves from counting: after the grace the next idle one is closed as well', async () => {
    const { queue, stdin } = await full();
    queue.markIdle('a', 0);
    queue.markIdle('b', 0);
    queue.enqueueMessageCheck('d');
    expect(stdin.a.end).toHaveBeenCalledTimes(1);            // a is closed and does not exit
    await vi.advanceTimersByTimeAsync(16_000);
    queue.enqueueMessageCheck('e');                          // two wait, and a is not on its way out any more
    expect(stdin.b.end).toHaveBeenCalledTimes(1);
  });

  it('hands the slot to the student it was closed for, not to its own student who has written since', async () => {
    const { queue, stdin, exits, started } = await full();
    queue.markIdle('a', 0);
    queue.enqueueMessageCheck('d');
    expect(stdin.a.end).toHaveBeenCalledTimes(1);
    expect(queue.sendMessage('a', 'wait, one more question')).toBe(false);   // a's stdin is closed
    queue.enqueueMessageCheck('a');                                           // so it waits for its own container to go
    exits.a();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd']);           // d, not a again
    expect(queue.queuePosition('a')).toEqual({ ahead: 0 });  // a's student is next in line
    exits.d();
    await flush();
    expect(started).toEqual(['a', 'b', 'c', 'd', 'a']);
  });
});

describe('the line of students who wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says how many are ahead, only for a message that waits, in the order they came', async () => {
    const { queue, exits, started } = await full();
    expect(queue.queuePosition('a')).toBeNull();             // it runs
    expect(queue.queuePosition('nobody')).toBeNull();        // nothing is asked of it
    queue.enqueueMessageCheck('d');
    queue.enqueueMessageCheck('e');
    queue.enqueueMessageCheck('f');
    expect(['d', 'e', 'f'].map((jid) => queue.queuePosition(jid))).toEqual([{ ahead: 0 }, { ahead: 1 }, { ahead: 2 }]);
    exits.a();
    await flush();
    expect(started.slice(-1)).toEqual(['d']);
    expect(queue.queuePosition('d')).toBeNull();
    expect(['e', 'f'].map((jid) => queue.queuePosition(jid))).toEqual([{ ahead: 0 }, { ahead: 1 }]);
  });

  it('does not count a task that waits, which never goes before a message', async () => {
    const { queue, exits } = await full();
    queue.enqueueTask('t', 'patrol-t', async () => undefined);
    queue.enqueueMessageCheck('d');
    expect(queue.queuePosition('d')).toEqual({ ahead: 0 });
    expect(queue.queuePosition('t')).toBeNull();
    exits.a();
    await flush();
  });

  it('tells a listener the waiting students in line order when the line changes, and not when it does not', async () => {
    const { queue, exits } = await full();
    const lines: string[][] = [];
    queue.setWaitingListener((waiting) => lines.push(waiting));
    queue.enqueueMessageCheck('d');
    queue.enqueueMessageCheck('d');                          // a second message of the same student changes nothing
    queue.enqueueMessageCheck('e');
    expect(lines).toEqual([['d'], ['d', 'e']]);
    exits.a();
    await flush();
    expect(lines.slice(-1)).toEqual([['e']]);
    exits.b();
    await flush();
    expect(lines.slice(-1)).toEqual([[]]);
  });

  it('survives a listener that throws', async () => {
    const { queue } = await full();
    queue.setWaitingListener(() => {
      throw new Error('boom');
    });
    expect(() => queue.enqueueMessageCheck('d')).not.toThrow();
  });
});
