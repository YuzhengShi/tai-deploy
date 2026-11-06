/**
 * The environment of the containers that answer a student (src/container-runner.ts): the text agent's and the voice call's tool host get
 * TAI_STUDENT_TZ when the student's page has told us their time zone, and nothing when it has not. (The reading of the zone is tested in
 * src/student-tz.test.ts; here it is replaced, to see what the container's `docker run` is given.)
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const zone = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('./student-tz.js', () => ({ studentTimeZone: vi.fn(() => zone.value) }));
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
vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./mount-security.js', () => ({ validateAdditionalMounts: vi.fn(() => []) }));
vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
  buildMemoryExport: vi.fn(() => ({ memories: [], messages: [] })),
  pruneExpiredMemories: vi.fn(),
}));
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
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
import { studentTimeZone } from './student-tz.js';
import type { RegisteredGroup } from './types.js';

const ada: RegisteredGroup = { name: 'Ada', folder: 's_ada', trigger: '@TAi', added_at: '2026-01-01', canvasUserId: '7' };

/** The `-e` values of a docker run line, and the image (the last argument: anything after it would be the container's command). */
function envOf(args: string[]): string[] {
  const values: string[] = [];
  args.forEach((a, i) => {
    if (a === '-e') values.push(args[i + 1]);
  });
  return values;
}

describe('TAI_STUDENT_TZ in the text agent\'s container', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(studentTimeZone).mockClear();
    zone.value = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function dockerArgs(group: RegisteredGroup, isMain = false): Promise<string[]> {
    const done = runContainerAgent(group, { prompt: 'hi', groupFolder: group.folder, chatJid: `web:${group.folder}`, isMain }, () => {}, vi.fn(async () => {}));
    await vi.advanceTimersByTimeAsync(10);
    const calls = vi.mocked(spawn).mock.calls;
    const args = calls[calls.length - 1][1] as string[];
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await done;
    return args;
  }

  it('is the zone the student told us, set before the image', async () => {
    zone.value = 'America/Vancouver';
    const args = await dockerArgs(ada);
    expect(envOf(args)).toContain('TAI_STUDENT_TZ=America/Vancouver');
    expect(args.indexOf('TAI_STUDENT_TZ=America/Vancouver')).toBeLessThan(args.length - 1);
    expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
    expect(vi.mocked(studentTimeZone)).toHaveBeenCalledWith('s_ada', '/tmp/tai-test-store'); // this student's folder, in the orchestrator's store
    expect(envOf(args)).toContain('TZ=UTC'); // the host's own TZ is untouched: the course's Pacific is not the student's zone
  });

  it('is not there when the student has not said: the container is started as it always was', async () => {
    const args = await dockerArgs(ada);
    expect(args.some((a) => a.startsWith('TAI_STUDENT_TZ'))).toBe(false);
    expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
  });
});

describe('TAI_STUDENT_TZ in a voice call\'s tool host', () => {
  beforeEach(() => {
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(studentTimeZone).mockClear();
    zone.value = undefined;
  });

  it('is the zone the student told us, and the container stays a tool host', async () => {
    zone.value = 'Asia/Kolkata';
    await spawnToolHost(ada, 'web:s_ada');
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(envOf(args)).toContain('TAI_STUDENT_TZ=Asia/Kolkata');
    expect(args.slice(-3, -1)).toEqual(['-e', 'TAI_MODE=tool-host']);
    expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
    expect(vi.mocked(studentTimeZone)).toHaveBeenCalledWith('s_ada', '/tmp/tai-test-store');
  });

  it('is not there when the student has not said', async () => {
    await spawnToolHost(ada, 'web:s_ada');
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args.some((a) => a.startsWith('TAI_STUDENT_TZ'))).toBe(false);
    expect(args.slice(-3, -1)).toEqual(['-e', 'TAI_MODE=tool-host']);
  });
});
