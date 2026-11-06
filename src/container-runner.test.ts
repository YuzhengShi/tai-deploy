import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_CPU_LIMIT: '1.0',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_MEMORY_LIMIT: '2g',
  CONTAINER_NETWORK: 'test-net',
  CONTAINER_PIDS_LIMIT: '256',
  CONTAINER_PREFIX: 'testprefix',
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  STORE_DIR: '/tmp/nanoclaw-test-store',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'UTC',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// With no AWS keys readSecrets asks the EC2 metadata service for a role. There is none here, and a real request would hang under fake timers.
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no metadata service in the tests'))));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { spawn } from 'child_process';
import { agentHarness, runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner harness choice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.TAI_HARNESS;
  });

  async function harnessOfSpawn(): Promise<string | undefined> {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    const calls = vi.mocked(spawn).mock.calls;
    const args = calls[calls.length - 1][1] as string[];
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
    return args.find((a) => a.startsWith('TAI_HARNESS='));
  }

  it('runs pi unless the orchestrator is told to run Claude Code', async () => {
    expect(agentHarness()).toBe('pi');
    expect(await harnessOfSpawn()).toBe('TAI_HARNESS=pi');
    process.env.TAI_HARNESS = 'claude';
    expect(agentHarness()).toBe('claude');
    expect(await harnessOfSpawn()).toBe('TAI_HARNESS=claude');
    process.env.TAI_HARNESS = 'something else';
    expect(agentHarness()).toBe('pi');
  });
});

describe('container-runner naming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the container with the orchestrator\'s prefix and joins its network, so a second orchestrator on the daemon is left alone', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    const calls = vi.mocked(spawn).mock.calls;
    const args = calls[calls.length - 1][1] as string[];
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
    expect(args[args.indexOf('--name') + 1]).toMatch(/^testprefix-test-group-\d+$/);
    expect(args[args.indexOf('--network') + 1]).toBe('test-net');
  });
});

describe('container-runner hands the container who made the task (access: container/agent-runner/src/access.ts)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The first line the container is given on stdin: the ContainerInput, as the container's runner parses it. */
  async function inputLine(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    let written = '';
    fakeProc.stdin.on('data', (chunk) => {
      written += chunk.toString();
    });
    const resultPromise = runContainerAgent(testGroup, { ...testInput, ...input }, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
    return JSON.parse(written.split('\n')[0]);
  }

  it('sends isSystemTask with isScheduledTask for a task the host made, and isScheduledTask alone for one an agent scheduled', async () => {
    const system = await inputLine({ isScheduledTask: true, isSystemTask: true });
    expect(system).toMatchObject({ isMain: false, isScheduledTask: true, isSystemTask: true });
    fakeProc = createFakeProcess();
    const student = await inputLine({ isScheduledTask: true, isSystemTask: false });
    expect(student).toMatchObject({ isMain: false, isScheduledTask: true, isSystemTask: false });
  });

  it('sends neither for a chat', async () => {
    const chat = await inputLine({});
    expect(chat.isScheduledTask).toBeUndefined();
    expect(chat.isSystemTask).toBeUndefined();
  });

  it('does not let a flag the caller leaves out turn into a yes on the way (the field is not defaulted)', async () => {
    const task = await inputLine({ isScheduledTask: true });
    expect(task.isSystemTask).toBeUndefined();
  });
});

// What the runner says between its results (src/turn-status.ts): the progress lines of the student's page (docs/PROGRESS.md)
const PROGRESS = '---NANOCLAW_PROGRESS---';
const progressLine = (event: unknown) => `${PROGRESS} ${JSON.stringify(event)}\n`;

describe('container-runner progress lines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function finish(promise: Promise<ContainerOutput>): Promise<ContainerOutput> {
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    return promise;
  }

  it('hands each event to onProgress, in the order of the results between which it was written, whatever the chunks cut', async () => {
    const order: string[] = [];
    const onOutput = vi.fn(async (out: ContainerOutput) => {
      order.push(`output:${out.result ?? (out.idle ? 'idle' : 'none')}`);
    });
    const onProgress = vi.fn((event: { type: string; name?: string; phase?: string }) => {
      order.push(`progress:${event.type}${event.name ? `:${event.name}:${event.phase}` : ''}`);
    });
    const promise = runContainerAgent(testGroup, testInput, () => {}, onOutput, onProgress);
    const stream =
      progressLine({ type: 'thinking' }) +
      progressLine({ type: 'tool', name: 'canvas_query', phase: 'start' }) +
      progressLine({ type: 'tool', name: 'canvas_query', phase: 'end' }) +
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'Done', newSessionId: 's1' })}\n${OUTPUT_END_MARKER}\n` +
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: null, idle: true, received: 0 })}\n${OUTPUT_END_MARKER}\n` +
      progressLine({ type: 'thinking' });
    // in chunks of 7 characters: lines and markers are cut in the middle
    for (let i = 0; i < stream.length; i += 7) fakeProc.stdout.push(stream.slice(i, i + 7));
    await vi.advanceTimersByTimeAsync(20);
    expect(order).toEqual(['progress:thinking', 'progress:tool:canvas_query:start', 'progress:tool:canvas_query:end', 'output:Done', 'output:idle', 'progress:thinking']);
    await finish(promise);
  });

  it('keeps a result that is still being delivered ahead of the progress written after it', async () => {
    const order: string[] = [];
    const onOutput = vi.fn(async () => {
      order.push('output:start');
      await new Promise((resolve) => setTimeout(resolve, 500));
      order.push('output:end');
    });
    const promise = runContainerAgent(testGroup, testInput, () => {}, onOutput, (event) => order.push(`progress:${event.type}`));
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'Slow to deliver' })}\n${OUTPUT_END_MARKER}\n${progressLine({ type: 'thinking' })}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual(['output:start']);
    await vi.advanceTimersByTimeAsync(600);
    expect(order).toEqual(['output:start', 'output:end', 'progress:thinking']);
    await finish(promise);
  });

  it('reads the chips of a lookup as the page may have them: a kind from the list, a label of one line, a plain https address', async () => {
    const onProgress = vi.fn();
    const promise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}), onProgress);
    fakeProc.stdout.push(
      progressLine({
        type: 'sources',
        seq: 2,
        items: [
          { kind: 'canvas', label: 'Homework 6', url: 'https://canvas.example.edu/courses/1/assignments/107' },
          { kind: 'github', label: 'x', url: 'javascript:alert(1)' },
          { kind: 'made-up', label: 'dropped' },
          { kind: 'piazza', label: `${'long '.repeat(40)}` },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(onProgress).toHaveBeenCalledTimes(1);
    const [event] = onProgress.mock.calls[0];
    expect(event.type).toBe('sources');
    expect(event.seq).toBe(2);
    expect(event.items.map((c: { kind: string }) => c.kind)).toEqual(['canvas', 'github', 'piazza']);
    expect(event.items[0].url).toBe('https://canvas.example.edu/courses/1/assignments/107');
    expect(event.items[1].url).toBeUndefined();
    expect(event.items[2].label.length).toBeLessThanOrEqual(80);
    await finish(promise);
  });

  it('ignores a line that is not an event, a kind it does not know, and the marker inside the words of a result', async () => {
    const onProgress = vi.fn();
    const onOutput = vi.fn(async () => {});
    const promise = runContainerAgent(testGroup, testInput, () => {}, onOutput, onProgress);
    fakeProc.stdout.push(`${PROGRESS} not json\n${progressLine({ type: 'shout' })}${progressLine({ type: 'tool', name: 'bad name!', phase: 'start' })}${progressLine({ type: 'tool', name: 'ok', phase: 'sideways' })}`);
    const forged = `a student asked for ${PROGRESS} ${JSON.stringify({ type: 'thinking' })}\n`;
    fakeProc.stdout.push(`${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: forged })}\n${OUTPUT_END_MARKER}\n`);
    await vi.advanceTimersByTimeAsync(10);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({ result: forged }));
    await finish(promise);
  });

  it('does not make the run one that answered: stopped by the timeout after only progress it is a timeout with no output', async () => {
    const promise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}), vi.fn());
    fakeProc.stdout.push(progressLine({ type: 'thinking' }));
    await vi.advanceTimersByTimeAsync(1_830_000 + 10);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });

  it('does not reset the container\'s hard timeout: a loop of tool calls is still stopped', async () => {
    const onProgress = vi.fn();
    const promise = runContainerAgent(testGroup, testInput, () => {}, vi.fn(async () => {}), onProgress);
    // a tool call every minute for 30 minutes, the length of the hard timeout here (the mock's IDLE_TIMEOUT + 30 s)
    for (let minute = 0; minute < 30; minute++) {
      fakeProc.stdout.push(progressLine({ type: 'tool', name: 'canvas_query', phase: 'start' }));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await vi.advanceTimersByTimeAsync(40_000);                  // 1,840 s in: past the 1,830 s the timeout allows
    expect(onProgress).toHaveBeenCalledTimes(30);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result.status).toBe('error');                       // it timed out although it kept saying it was busy
    expect(result.error).toContain('timed out');               // (not merely a close with an exit code: the timer is what stopped it)
  });

  it('leaves a caller that asks for no progress as it was: the lines are skipped and the results parse', async () => {
    const onOutput = vi.fn(async () => {});
    const promise = runContainerAgent(testGroup, testInput, () => {}, onOutput);
    fakeProc.stdout.push(progressLine({ type: 'thinking' }));
    emitOutputMarker(fakeProc, { status: 'success', result: 'Plain', newSessionId: 's2' });
    await vi.advanceTimersByTimeAsync(10);
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({ result: 'Plain' }));
    const result = await finish(promise);
    expect(result.newSessionId).toBe('s2');
  });

  it('survives a listener that throws: the next event and the results still arrive', async () => {
    const onOutput = vi.fn(async () => {});
    const onProgress = vi.fn(() => {
      throw new Error('listener bug');
    });
    const promise = runContainerAgent(testGroup, testInput, () => {}, onOutput, onProgress);
    fakeProc.stdout.push(progressLine({ type: 'thinking' }) + progressLine({ type: 'thinking' }));
    emitOutputMarker(fakeProc, { status: 'success', result: 'Still here' });
    await vi.advanceTimersByTimeAsync(10);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onOutput).toHaveBeenCalledWith(expect.objectContaining({ result: 'Still here' }));
    await finish(promise);
  });
});
