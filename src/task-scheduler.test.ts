import fs from 'fs';
import path from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// every pass loads the scheduler (and the logger under it) again, and the logger puts a few listeners on the process each time
process.setMaxListeners(100);

type Task = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
  // the folder the scheduler makes a folder for each group in and the gate keeps its file in: one for the whole file (the config below is made once), emptied before each test
  dir: (() => {
    const node = process.getBuiltinModule;
    return node('node:fs').mkdtempSync(node('node:path').join(node('node:os').tmpdir(), 'tai-scheduler-'));
  })() as string,
  due: [] as Task[],
  pending: [] as Array<() => Promise<void>>,
  runs: [] as Array<{ prompt: string }>,
  logs: [] as Array<{ task_id: string; status: string; result: string | null; error: string | null }>,
  after: [] as unknown[][],
  output: { status: 'success', result: 'done' } as { status: string; result: string | null; error?: string },
  // what the container says while it runs (the streamed markers), how long it stays up after that, and how often the host closed its stdin
  markers: [] as Array<Record<string, unknown>>,
  holdMs: 0,
  closes: 0,
  gate: null as unknown,
  // what the container does while it runs, before it says anything (a patrol that sends the student a message leaves the send tool's marker)
  during: null as null | (() => void),
}));

vi.mock('./config.js', async (original) => {
  const real = await original<typeof import('./config.js')>();
  const path = await import('node:path');
  return { ...real, GROUPS_DIR: path.join(h.dir, 'groups'), STORE_DIR: path.join(h.dir, 'store'), DATA_DIR: path.join(h.dir, 'data') };
});
vi.mock('./db.js', () => ({
  getAllTasks: () => [],
  getDueTasks: () => h.due,
  getTaskById: (id: string) => h.due.find((t) => t.id === id),
  getLastUserMessageTime: () => undefined,
  logTaskRun: (log: (typeof h.logs)[number]) => void h.logs.push(log),
  updateTask: () => undefined,
  updateTaskAfterRun: (...args: unknown[]) => void h.after.push(args),
}));
vi.mock('./container-runner.js', () => ({
  runContainerAgent: async (_group: unknown, input: { prompt: string }, _onProcess?: unknown, onOutput?: (marker: Record<string, unknown>) => Promise<void>) => {
    h.runs.push(input);
    h.during?.();
    for (const marker of h.markers) await onOutput?.(marker);
    if (h.holdMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, h.holdMs));          // the container stays up until it is closed or this is over
    return h.output;
  },
  writeTasksSnapshot: () => undefined,
}));
vi.mock('./patrol-gate.js', async (original) => ({ ...(await original<typeof import('./patrol-gate.js')>()), gatePatrol: () => h.gate }));

const PATROL = '[TEACHING_PATROL]\nDo the patrol';
const task = (over: Record<string, unknown> = {}): Task => ({
  id: 'patrol-ana-1',
  group_folder: 'ana',
  chat_jid: 'web:ana',
  prompt: PATROL,
  schedule_type: 'cron',
  schedule_value: '0 9 * * 1-5',
  context_mode: 'group',
  next_run: '2026-11-04T17:00:00.000Z',
  last_run: null,
  last_result: null,
  status: 'active',
  created_at: '2026-09-01T00:00:00Z',
  origin: 'system',                       // the host's own patrol, as the seed writes it (a student's task says 'container')
  ...over,
});
const decision = (over: Record<string, unknown> = {}) => ({
  mode: 'on',
  run: true,
  reasons: ['new since the model last looked: inactive'],
  signals: [{ kind: 'inactive', key: 'inactive', n: 8 }],
  keys: ['inactive'],
  weekly: false,
  recordable: true,
  ...over,
});

/** One pass of the scheduler over the due tasks: starts its loop fresh, and runs what it queued. */
async function pass(...due: Task[]) {
  vi.resetModules();
  vi.useFakeTimers();
  h.due = due;
  h.pending = [];
  const { startSchedulerLoop } = await import('./task-scheduler.js');
  startSchedulerLoop({
    registeredGroups: () => ({ 'web:ana': { name: 'Ana', folder: 'ana', trigger: '@TAi', added_at: '2026-09-01T00:00:00Z' } }),
    getSessions: () => ({}),
    queue: { enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => void h.pending.push(fn), closeStdin: () => undefined } as never,
    onProcess: () => undefined,
  });
  for (const fn of h.pending) await fn();
  vi.useRealTimers();
}
const kept = async () => (await import('./patrol-gate.js')).readGateState();

/**
 * A pass where the container stays up for `hold` ms unless the host closes it, with the clock in the test's hands: how many times the host had
 * closed its stdin at each of the `checkpoints` (ms from the start) is what comes back.
 */
async function passHeld(hold: number, checkpoints: number[], ...due: Task[]): Promise<number[]> {
  vi.resetModules();
  vi.useFakeTimers();
  h.due = due;
  h.pending = [];
  h.holdMs = hold;
  h.closes = 0;
  const { startSchedulerLoop } = await import('./task-scheduler.js');
  startSchedulerLoop({
    registeredGroups: () => ({ 'web:ana': { name: 'Ana', folder: 'ana', trigger: '@TAi', added_at: '2026-09-01T00:00:00Z' } }),
    getSessions: () => ({}),
    queue: { enqueueTask: (_jid: string, _id: string, fn: () => Promise<void>) => void h.pending.push(fn), closeStdin: () => void h.closes++ } as never,
    onProcess: () => undefined,
  });
  const running = Promise.all(h.pending.slice(0, 1).map((fn) => fn()));
  const seen: number[] = [];
  let at = 0;
  for (const t of checkpoints) {
    await vi.advanceTimersByTimeAsync(t - at);
    at = t;
    seen.push(h.closes);
  }
  await vi.advanceTimersByTimeAsync(hold);
  await running;
  vi.useRealTimers();
  return seen;
}

beforeEach(() => {
  h.runs = [];
  h.logs = [];
  h.after = [];
  h.markers = [{ status: 'success', result: null, newSessionId: 's1', idle: true }];       // an ordinary run: the runner finishes its turn and says it is idle
  h.holdMs = 0;
  h.closes = 0;
  h.during = null;
  h.output = { status: 'success', result: 'done' };
  h.gate = decision();
  fs.rmSync(h.dir, { recursive: true, force: true });
  fs.mkdirSync(h.dir, { recursive: true });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('the scheduler and the teaching patrol\'s gate', () => {
  it('starts no container and calls no model for a patrol the gate skips, and writes the day\'s decision down like any run', async () => {
    h.gate = decision({ run: false, reasons: ['nothing new since the model last looked (2026-11-02); the weekly full check is due 2026-11-09'], signals: [], keys: [] });
    await pass(task());
    expect(h.runs).toEqual([]);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ task_id: 'patrol-ana-1', status: 'success', error: null });
    expect(h.logs[0].result).toMatch(/^skipped by the gate: nothing new since the model last looked/);
    expect(h.after).toHaveLength(1);
    expect(h.after[0][0]).toBe('patrol-ana-1');
    expect(typeof h.after[0][1]).toBe('string');                                           // the next run is still scheduled
    expect(String(h.after[0][2])).toMatch(/^skipped by the gate/);
    expect(h.after[0][3]).toBe(false);
    expect(await kept()).toEqual({});                                                      // a skip does not move what the model last looked at
  });

  it('runs the patrol with the reasons added to its prompt when the gate lets it through, and keeps what the model looked at once it finished', async () => {
    await pass(task());
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].prompt.startsWith(PATROL)).toBe(true);
    expect(h.runs[0].prompt).toContain('WHY YOU ARE RUNNING NOW');
    expect(h.runs[0].prompt).toContain('No message or call from this student for 8 days');
    expect(h.logs[0]).toMatchObject({ status: 'success', result: 'done' });
    expect((await kept()).ana).toMatchObject({ keys: ['inactive'] });
  });

  it('does not keep a run that failed, so the next patrol looks again', async () => {
    h.output = { status: 'error', result: null, error: 'the provider says payment required' };
    await pass(task());
    expect(h.runs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ status: 'error' });
    expect(await kept()).toEqual({});
  });

  it('in shadow mode runs the patrol exactly as before and writes down what the gate would have done', async () => {
    h.gate = decision({ mode: 'shadow', run: false, reasons: ['nothing new since the model last looked (never)'], keys: [], signals: [] });
    await pass(task());
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].prompt).toBe(PATROL);                                                 // no note: the old behaviour, to compare against
    expect(h.logs[0].result).toMatch(/^\[the gate would have skipped this run: nothing new since the model last looked \(never\)\] done/);
    expect(await kept()).toEqual({});                                                      // the gate would not have run: nothing to keep
    h.gate = decision({ mode: 'shadow' });
    await pass(task());
    expect(h.runs[1].prompt).toBe(PATROL);
    expect((await kept()).ana).toMatchObject({ keys: ['inactive'] });                      // the gate would have run: kept, so tomorrow's shadow decision is the real one
  });

  it('runs the patrol as it always did, and keeps nothing, when the gate is off or could not decide', async () => {
    h.gate = decision({ mode: 'off', recordable: false, signals: [], keys: [], reasons: ['the gate is off'] });
    await pass(task());
    expect(h.runs[0].prompt).toBe(PATROL);
    expect(h.logs[0].result).toBe('done');
    expect(await kept()).toEqual({});
  });

  it('leaves every other task alone: no gate, the prompt as it is, nothing kept', async () => {
    h.gate = decision({ run: false });                                                     // would skip a patrol; must not touch this
    await pass(task({ id: 'bootstrap-ana', prompt: '[COMPETENCY_BOOTSTRAP]\nGrades' }));
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].prompt).toBe('[COMPETENCY_BOOTSTRAP]\nGrades');
    expect(await kept()).toEqual({});
  });
});

describe('a task whose model request failed', () => {
  // 2026-11-04 17:03 UTC: the patrol met Cerebras' "payment required", the runner answered with its apology under status "success", and the
  // run was logged as a success: the operator's view said "0 failed", and the gate would have kept the day's signals as seen.
  const apology = 'sorry, something went wrong on my end — give me a sec and try again?';

  it('is logged as failed, with the reason, and the patrol keeps nothing of it, so the next patrol looks again', async () => {
    h.markers = [{ status: 'success', result: apology, apiFailure: 'other' }, { status: 'success', result: null, idle: true }];
    h.output = { status: 'success', result: null };                                        // what the container runner returns at the end of a streamed run
    await pass(task());
    expect(h.runs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ task_id: 'patrol-ana-1', status: 'error' });
    expect(h.logs[0].error).toMatch(/the model could not be reached \(other\)/);
    expect(h.logs[0].result).toBe(apology);                                                // what was said is still written down
    expect(h.after[0][3]).toBe(true);                                                      // updateTaskAfterRun: failed
    expect(String(h.after[0][2])).toMatch(/^Error: the model could not be reached/);
    expect(await kept()).toEqual({});
  });

  it('is told apart for every kind of failure, and an ordinary answer that merely sounds like one is not a failure', async () => {
    for (const kind of ['overflow', 'busy', 'auth', 'other']) {
      h.logs = [];
      h.markers = [{ status: 'success', result: apology, apiFailure: kind }];
      await pass(task());
      expect(h.logs[0].status, kind).toBe('error');
      expect(h.logs[0].error, kind).toContain(`(${kind})`);
    }
    h.logs = [];
    h.markers = [{ status: 'success', result: apology }];                                  // the same words, but nothing says the model failed
    await pass(task());
    expect(h.logs[0]).toMatchObject({ status: 'success', error: null });
  });
});

describe('a task whose container was stopped before its runner was done', () => {
  // The container runner reports a container that is stopped after it has streamed something (the 15-minute timeout) as a success with nothing in it.
  it('is a failed run, and the gate keeps nothing of it', async () => {
    h.markers = [{ status: 'success', result: null, newSessionId: 's1' }];                 // the turn's marker, and then nothing: no answer, no idle
    h.output = { status: 'success', result: null };
    await pass(task());
    expect(h.logs[0]).toMatchObject({ status: 'error' });
    expect(h.logs[0].error).toMatch(/the task did not finish: its runner never said it was done/);
    expect(await kept()).toEqual({});
    expect(h.after[0][3]).toBe(true);
  });

  it('is not one that wrote its answer and then said nothing more (a container image from before the idle marker), and not one that said idle with no text', async () => {
    h.markers = [{ status: 'success', result: 'All clear.' }];
    await pass(task());
    expect(h.logs[0]).toMatchObject({ status: 'success', error: null });
    expect((await kept()).ana).toMatchObject({ keys: ['inactive'] });
    h.logs = [];
    h.markers = [{ status: 'success', result: null, idle: true }];
    await pass(task());
    expect(h.logs[0]).toMatchObject({ status: 'success', error: null });
  });

  it('says what happened first when the container itself reported an error', async () => {
    h.markers = [];
    h.output = { status: 'error', result: null, error: 'Container exited with code 137' };
    await pass(task());
    expect(h.logs[0]).toMatchObject({ status: 'error', error: 'Container exited with code 137' });
  });
});

describe('the container of a task is closed when the runner is done, not minutes later', () => {
  it('a few seconds after the runner says it is idle, even when its answer had no text at all (937 s before)', async () => {
    const { TASK_CLOSE_DELAY } = await import('./config.js');
    h.markers = [{ status: 'success', result: null, newSessionId: 's1' }, { status: 'success', result: null, newSessionId: 's1', idle: true }];
    const seen = await passHeld(900_000, [TASK_CLOSE_DELAY - 100, TASK_CLOSE_DELAY + 100, 600_000], task());
    expect(seen).toEqual([0, 1, 1]);                                                       // not before the delay, once after it, and no more
  });

  it('a result with text starts the long timer, and the idle marker after it shortens it to the same few seconds', async () => {
    const { TASK_CLOSE_DELAY } = await import('./config.js');
    h.markers = [{ status: 'success', result: 'All clear.' }, { status: 'success', result: null, idle: true }];
    const seen = await passHeld(900_000, [TASK_CLOSE_DELAY - 100, TASK_CLOSE_DELAY + 100], task());
    expect(seen).toEqual([0, 1]);
  });

  it('a runner that never says idle is still closed after the long timeout, as before', async () => {
    const { IDLE_TIMEOUT } = await import('./config.js');
    h.markers = [{ status: 'success', result: 'All clear.' }];
    const seen = await passHeld(900_000, [IDLE_TIMEOUT - 1000, IDLE_TIMEOUT + 1000], task());
    expect(seen).toEqual([0, 1]);
  });

  it('is not closed while the runner has said nothing: a long task is left to work (until the container timeout)', async () => {
    const { IDLE_TIMEOUT } = await import('./config.js');
    h.markers = [{ status: 'success', result: null, newSessionId: 's1' }];                 // a session-update marker is not "done"
    const seen = await passHeld(600_000, [IDLE_TIMEOUT + 60_000, 300_000], task());
    expect(seen).toEqual([0, 0]);
  });
});

describe('the patrol\'s decision, written down in the student\'s intervention log', () => {
  // The persona tells the model to log every decision "including when you decide NOT to intervene", and no model did (src/competency-writer.ts has the
  // evidence): the scheduler writes one line per patrol run, from the gate's signal keys and numbers, and never a word a student wrote.
  const logFile = () => path.join(h.dir, 'groups', 'ana', 'competency', 'intervention-log.md');
  const lines = () => (fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf-8').split('\n').filter((l) => l.startsWith('- ')) : []);
  const marker = () => path.join(h.dir, 'data', 'ipc', 'ana', 'messages', '.send_message_used');
  const leaveMarker = () => {
    fs.mkdirSync(path.dirname(marker()), { recursive: true });
    fs.writeFileSync(marker(), '');
  };
  const day = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('says a skip, with the signals still open, and the gate\'s reasons (words and all) stay out of it', async () => {
    h.gate = decision({ run: false, reasons: ['nothing new: the student wrote that they hate this course'], signals: [], keys: ['due-last:555'], weekly: false });
    await pass(task());
    expect(h.runs).toEqual([]);
    expect(lines()).toEqual([`- ${day()}: no-action — the gate skipped the run (no container, no model) | open signals: due-last:555 | weekly check not due`]);
    expect(fs.readFileSync(logFile(), 'utf-8')).not.toContain('hate');
    expect(fs.readFileSync(logFile(), 'utf-8').startsWith('# Intervention Log\n\n')).toBe(true);
  });

  it('says a run that sent the student nothing was a decision not to intervene', async () => {
    await pass(task());
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(new RegExp(`^- ${day()}: no-action — the model ran and sent no message \\| signals: inactive \\| new signal \\| gate on \\| \\d+ s$`));
  });

  it('says a run that sent a message intervened, and takes the send tool\'s marker away, so the student\'s next reply is not held back as already sent', async () => {
    h.during = leaveMarker;
    await pass(task());
    expect(lines()[0]).toMatch(/: intervene — the model ran and sent the student a message \| signals: inactive \|/);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('does not read a marker left before the run as this run\'s message, and removes it', async () => {
    leaveMarker();                                                                         // an earlier turn's, never taken
    await pass(task());
    expect(lines()[0]).toMatch(/: no-action — the model ran and sent no message/);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('says the weekly check when that is why it ran, and a shadow run the gate would have skipped', async () => {
    h.gate = decision({ weekly: true, signals: [], keys: [] });
    await pass(task());
    h.gate = decision({ mode: 'shadow', run: false, signals: [], keys: [], reasons: ['nothing new'] });
    await pass(task());
    expect(lines()[1]).toMatch(/\| signals: none \| weekly check \| gate on \|/);
    expect(lines()[0]).toMatch(/\| gate shadow \(it would have skipped\) \|/);
  });

  it('says how a run failed: the model could not be reached, it never finished, or its container broke', async () => {
    h.markers = [{ status: 'success', result: 'sorry, something went wrong on my end', apiFailure: 'busy' }];
    await pass(task());
    expect(lines()[0]).toMatch(/: failed — the model could not be reached \(busy\) \| signals: inactive \| no message sent \| nothing kept, the next patrol looks again \| gate on \| \d+ s$/);
    h.markers = [{ status: 'success', result: null, newSessionId: 's1' }];
    h.output = { status: 'success', result: null };
    await pass(task());
    expect(lines()[0]).toMatch(/: failed — the run did not finish \(its container was stopped, or it ran out of time\)/);
    h.markers = [];
    h.output = { status: 'error', result: null, error: 'Container exited with code 137' };
    await pass(task());
    expect(lines()[0]).toMatch(/: failed — the run failed \|/);
    expect(lines()).toHaveLength(3);
  });

  it('says so when a failed run had sent a message before it failed', async () => {
    h.during = leaveMarker;
    h.markers = [{ status: 'success', result: 'sorry', apiFailure: 'other' }];
    await pass(task());
    expect(lines()[0]).toMatch(/: failed — the model could not be reached \(other\) \| signals: inactive \| a message had already been sent \|/);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('writes nothing for a task that is not a patrol, and does not touch its marker', async () => {
    leaveMarker();
    await pass(task({ id: 'bootstrap-ana', prompt: '[COMPETENCY_BOOTSTRAP]\nGrades' }));
    expect(h.runs).toHaveLength(1);
    expect(lines()).toEqual([]);
    expect(fs.existsSync(marker())).toBe(true);
  });
});

describe('whose access a task\'s container is started with', () => {
  // Every task's container used to be started as "a scheduled task", and the runner gave every scheduled task the admin's access: a student's agent could
  // schedule one with a prompt it chose (docs/SECURITY.md, "Scheduled tasks and access"). The container is told whether the HOST made the task.
  const started = () => h.runs[h.runs.length - 1] as unknown as Record<string, unknown>;

  it('tells the container that a task the host made itself is a system task: the patrol and the grade bootstrap keep what they had', async () => {
    await pass(task({ origin: 'system' }));
    expect(started()).toMatchObject({ isScheduledTask: true, isSystemTask: true, isMain: false });
    await pass(task({ id: 'bootstrap-ana-1', prompt: '[COMPETENCY_BOOTSTRAP]\nGrades', origin: 'system', context_mode: 'group' }));
    expect(started()).toMatchObject({ isScheduledTask: true, isSystemTask: true });
  });

  it('tells it that a task an agent scheduled is a scheduled task and not the host\'s own, and runs the student\'s prompt as written', async () => {
    await pass(task({ id: 'task-1730000000000-abc123', prompt: 'remind me to start Homework 7', origin: 'container', context_mode: 'isolated' }));
    expect(started()).toMatchObject({ prompt: 'remind me to start Homework 7', isScheduledTask: true, isSystemTask: false, isMain: false });
    expect(started()).toMatchObject({ canvasUserId: undefined, githubUsername: undefined });      // the binding the group has goes with it (this group has none)
  });

  it('does not take a patrol\'s id or marker for the host\'s word: a student\'s task that carries both is still a container task, and the patrol\'s gate is not asked about it', async () => {
    h.gate = decision({ run: false });                                                     // the gate would skip a patrol: a student's task must not be held back by it
    await pass(task({ origin: 'container' }));                                             // id patrol-ana-1, the patrol's prompt, and the origin of a task an agent made
    expect(h.runs).toHaveLength(1);
    expect(started()).toMatchObject({ prompt: PATROL, isScheduledTask: true, isSystemTask: false });
    expect(started().prompt).not.toContain('WHY YOU ARE RUNNING NOW');
    expect(await kept()).toEqual({});                                                      // and it does not move what the model last looked at for the student's real patrol
  });

  it('counts a task nobody classified (no origin, or an origin it does not know) as not the host\'s', async () => {
    await pass(task({ origin: undefined }));
    expect(started().isSystemTask).toBe(false);
    await pass(task({ origin: null }));
    expect(started().isSystemTask).toBe(false);
    await pass(task({ origin: 'admin' }));
    expect(started().isSystemTask).toBe(false);
    await pass(task({ origin: 'SYSTEM' }));
    expect(started().isSystemTask).toBe(false);
  });

  it('starts a container task\'s container the way it always did otherwise: its output is still never sent as text, and it is closed when it is idle', async () => {
    h.markers = [{ status: 'success', result: 'Reminder: start Homework 7', newSessionId: 's1' }, { status: 'success', result: null, idle: true }];
    const seen = await passHeld(900_000, [0, 600_000], task({ id: 'task-1730000000000-abc123', prompt: 'remind me', origin: 'container', context_mode: 'isolated' }));
    expect(started()).toMatchObject({ isScheduledTask: true, isSystemTask: false });
    expect(h.logs[h.logs.length - 1]).toMatchObject({ task_id: 'task-1730000000000-abc123', status: 'success' });
    expect(seen[1]).toBeGreaterThanOrEqual(1);
  });
});
