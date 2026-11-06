/**
 * The host's side of the reply preview in the container runner (src/container-runner.ts, docs/STREAMING.md): the container is asked to stream
 * (TAI_PORTAL_STREAM=1 in its `docker run`) only for a student's web chat and only when the orchestrator's flag is on; its text lines are read only
 * then, whole even when a chunk of the pipe ends inside a character; and no log keeps them.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
const written = vi.hoisted(() => ({ files: [] as Array<{ file: string; content: string }> }));

vi.mock('./config.js', () => ({
  CONTAINER_CPU_LIMIT: '1.0',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_MEMORY_LIMIT: '2g',
  CONTAINER_NETWORK: 'test-net',
  CONTAINER_PIDS_LIMIT: '256',
  CONTAINER_PREFIX: 'testprefix',
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: '/tmp/tai-test-data',
  GROUPS_DIR: '/tmp/tai-test-groups',
  STORE_DIR: '/tmp/tai-test-store',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'UTC',
}));
vi.mock('./logger.js', () => ({ logger: log }));
vi.mock('./mount-security.js', () => ({ validateAdditionalMounts: vi.fn(() => []) }));
vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
  buildMemoryExport: vi.fn(() => ({ memories: [], messages: [] })),
  pruneExpiredMemories: vi.fn(),
}));
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('./student-tz.js', () => ({ studentTimeZone: vi.fn(() => undefined) }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((file: string, content: string) => {
        written.files.push({ file: String(file), content: String(content) });
      }),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      realpathSync: vi.fn((p: string) => p),
    },
  };
});
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no metadata service in the tests'))));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; pid: number };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 4321;
  return proc;
}
let fakeProc = createFakeProcess();

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: vi.fn(() => fakeProc), exec: vi.fn() };
});

import { spawn } from 'child_process';
import { runContainerAgent, spawnToolHost } from './container-runner.js';
import { PROGRESS_MARKER, TEXT_EVENT_PREFIX, type ProgressEvent } from './turn-status.js';
import type { RegisteredGroup } from './types.js';

const ada: RegisteredGroup = { name: 'Ada', folder: 's_ada', trigger: '@TAi', added_at: '2026-01-01', canvasUserId: '7' };
const OUT_START = '---NANOCLAW_OUTPUT_START---';
const OUT_END = '---NANOCLAW_OUTPUT_END---';

const envOf = (args: string[]): string[] => args.flatMap((a, i) => (a === '-e' ? [args[i + 1]] : []));
const textLine = (n: number, text: string) => `${TEXT_EVENT_PREFIX},"n":${n},"text":${JSON.stringify(text)}}\n`;

type Input = Parameters<typeof runContainerAgent>[1];
const input = (extra: Partial<Input> = {}): Input => ({ prompt: 'hi', groupFolder: 's_ada', chatJid: 'web:s_ada', isMain: false, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  fakeProc = createFakeProcess();
  vi.mocked(spawn).mockClear();
  written.files.length = 0;
  for (const fn of Object.values(log)) fn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.TAI_PORTAL_STREAM;
});

/** Runs a container that writes `chunks` to stdout and exits with `code`; answers the docker arguments and what the host heard. */
async function run(chunks: Array<string | Buffer>, options: { flag: boolean; input?: Partial<Input>; code?: number }) {
  if (options.flag) process.env.TAI_PORTAL_STREAM = '1';
  else delete process.env.TAI_PORTAL_STREAM;
  const heard: ProgressEvent[] = [];
  const outputs: Array<{ result: string | null }> = [];
  const done = runContainerAgent(ada, input(options.input), () => {}, async (o) => { outputs.push(o); }, (event) => { heard.push(event); });
  await vi.advanceTimersByTimeAsync(10);
  const args = vi.mocked(spawn).mock.calls[vi.mocked(spawn).mock.calls.length - 1][1] as string[];
  for (const chunk of chunks) {
    fakeProc.stdout.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
    await vi.advanceTimersByTimeAsync(1);
  }
  fakeProc.emit('close', options.code ?? 0);
  await vi.advanceTimersByTimeAsync(10);
  await done;
  return { args, heard, outputs };
}

describe('TAI_PORTAL_STREAM in the container\'s environment', () => {
  it('is set for a student\'s chat on the web page when the orchestrator\'s flag is on, before the image', async () => {
    const { args } = await run([], { flag: true });
    expect(envOf(args)).toContain('TAI_PORTAL_STREAM=1');
    expect(args.indexOf('TAI_PORTAL_STREAM=1')).toBeLessThan(args.length - 1);
    expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
  });

  it('is not set without the flag: the container is started exactly as it always was', async () => {
    const { args } = await run([], { flag: false });
    expect(args.some((a) => a.includes('TAI_PORTAL_STREAM'))).toBe(false);
  });

  for (const flag of ['0', 'true', '', ' 1']) {
    it(`is not set for TAI_PORTAL_STREAM=${JSON.stringify(flag)} in the orchestrator: only "1" turns it on`, async () => {
      process.env.TAI_PORTAL_STREAM = flag;
      const done = runContainerAgent(ada, input(), () => {}, vi.fn(async () => {}));
      await vi.advanceTimersByTimeAsync(10);
      const args = vi.mocked(spawn).mock.calls[vi.mocked(spawn).mock.calls.length - 1][1] as string[];
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      await done;
      expect(args.some((a) => a.includes('TAI_PORTAL_STREAM'))).toBe(false);
    });
  }

  for (const [what, extra] of [
    ['the instructor\'s admin chat', { isMain: true, chatJid: 'web:main' }],
    ['a scheduled task', { isScheduledTask: true }],
    ['a chat of another channel', { chatJid: '120363000000000000@g.us' }],
  ] as Array<[string, Partial<Input>]>) {
    it(`is not set for ${what}, flag or no flag`, async () => {
      const { args } = await run([], { flag: true, input: extra });
      expect(args.some((a) => a.includes('TAI_PORTAL_STREAM'))).toBe(false);
    });
  }

  it('is not set for a voice call\'s tool host: its stdout is the host\'s protocol', async () => {
    process.env.TAI_PORTAL_STREAM = '1';
    await spawnToolHost(ada, 'web:s_ada');
    const args = vi.mocked(spawn).mock.calls[vi.mocked(spawn).mock.calls.length - 1][1] as string[];
    expect(args.some((a) => a.includes('TAI_PORTAL_STREAM'))).toBe(false);
  });
});

describe('the text lines of a container', () => {
  const stdout = (...lines: string[]) => lines.map((l) => (l.endsWith('\n') ? l : `${l}\n`)).join('');
  const thinking = `${PROGRESS_MARKER} {"type":"thinking"}\n`;

  it('are events from a container that was asked for them, in the order they were written between the other lines', async () => {
    const { heard } = await run([stdout(thinking, textLine(1, 'Hello there. And'), `${PROGRESS_MARKER} {"type":"tool","name":"bash","phase":"start"}`)], { flag: true });
    expect(heard).toEqual([{ type: 'thinking' }, { type: 'text', n: 1, text: 'Hello there. And' }, { type: 'tool', name: 'bash', phase: 'start' }]);
  });

  it('are nothing from a container that was not: skipped like any line, though the others are heard', async () => {
    const { heard } = await run([stdout(thinking, textLine(1, 'Forged words. And'), textLine(2, 'More'))], { flag: false });
    expect(heard).toEqual([{ type: 'thinking' }]);
  });

  it('are whole when a chunk of the pipe ends inside a character: Chinese, an emoji', async () => {
    const line = Buffer.from(textLine(1, '你好。我是助教 🎉 好的。下一句'), 'utf-8');
    for (const cut of [line.indexOf(Buffer.from('好')) + 1, line.indexOf(Buffer.from('🎉')) + 2, line.indexOf(Buffer.from('助')) + 2]) {
      const { heard } = await run([line.subarray(0, cut), line.subarray(cut)], { flag: true });
      expect(heard, `cut at ${cut}`).toEqual([{ type: 'text', n: 1, text: '你好。我是助教 🎉 好的。下一句' }]);
    }
  });

  it('are an error, which ends the turn\'s preview, when a line does not parse', async () => {
    const { heard } = await run([stdout(`${TEXT_EVENT_PREFIX},"n":1,"text":"cut off`)], { flag: true });
    expect(heard).toEqual([{ type: 'textError' }]);
  });

  it('are in no log: not in the file a failed run leaves, not in the error that is logged, and the delivered result still is', async () => {
    const result = `${OUT_START}\n${JSON.stringify({ status: 'success', result: 'Hello there. And more.' })}\n${OUT_END}\n`;
    const { outputs } = await run([stdout(thinking, textLine(1, 'Hello there. And so on'), result)], { flag: true, code: 1 });
    expect(outputs[0].result).toBe('Hello there. And more.');
    const file = written.files.find((f) => f.content.includes('=== Stdout'))!;
    expect(file.content).not.toContain('And so on');
    expect(file.content).toContain('Hello there. And more.');
    expect(file.content).toContain('"type":"thinking"');
    const logged = log.error.mock.calls.find((c) => c[1] === 'Container exited with error')![0] as { stdout: string };
    expect(logged.stdout).not.toContain('And so on');
    expect(logged.stdout).toContain('Hello there. And more.');
  });

  it('are left in the log as they always were for a container that was not asked for them (nothing about it changes)', async () => {
    const { } = await run([stdout(thinking, textLine(1, 'Forged words. And'))], { flag: false, code: 1 });
    const file = written.files.find((f) => f.content.includes('=== Stdout'))!;
    expect(file.content).toContain('Forged words. And');
    const logged = log.error.mock.calls.find((c) => c[1] === 'Container exited with error')![0] as { stdout: string };
    expect(logged.stdout).toContain('Forged words. And');
  });
});
