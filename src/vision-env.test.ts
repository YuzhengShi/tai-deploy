/**
 * TAI_VISION on the host (src/vision-env.ts, docs/VISION.md): the switch is exactly "1"; a student's own chat container is started with TAI_VISION=1 and the
 * alias that looks at pictures (a plain name only), and nothing else is: not the admin's chat, not a scheduled task, never the voice tool host. No key is
 * ever on the command line, and the host hands the container no second copy of the gateway's key.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
const envFile = vi.hoisted(() => ({ values: {} as Record<string, string> }));

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
vi.mock('./env.js', () => ({ readEnvFile: vi.fn((keys: string[]) => Object.fromEntries(Object.entries(envFile.values).filter(([k]) => keys.includes(k)))) }));
vi.mock('./student-tz.js', () => ({ studentTimeZone: vi.fn(() => undefined) }));
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
import type { RegisteredGroup } from './types.js';
import { MODEL_ALIAS, visionFor, visionModel, visionOn } from './vision-env.js';

const ada: RegisteredGroup = { name: 'Ada', folder: 's_ada', trigger: '@TAi', added_at: '2026-01-01', canvasUserId: '7' };
const GATEWAY_KEY = 'gateway-key-not-a-real-one';

const envOf = (args: string[]): string[] => args.flatMap((a, i) => (a === '-e' ? [args[i + 1]] : []));

type Input = Parameters<typeof runContainerAgent>[1];
const input = (extra: Partial<Input> = {}): Input => ({ prompt: 'hi', groupFolder: 's_ada', chatJid: 'web:s_ada', isMain: false, ...extra });

const lastArgs = (): string[] => vi.mocked(spawn).mock.calls[vi.mocked(spawn).mock.calls.length - 1][1] as string[];

/** Starts a container for a run and lets it end; answers the docker arguments and what the host wrote to its stdin. */
async function start(extra: Partial<Input> = {}): Promise<{ args: string[]; stdin: string }> {
  const done = runContainerAgent(ada, input(extra), () => {}, async () => {});
  await vi.advanceTimersByTimeAsync(10);
  const args = lastArgs();
  const stdin = String(fakeProc.stdin.read() ?? '');
  fakeProc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
  await done;
  return { args, stdin };
}

beforeEach(() => {
  vi.useFakeTimers();
  fakeProc = createFakeProcess();
  vi.mocked(spawn).mockClear();
  envFile.values = { ANTHROPIC_BASE_URL: 'http://tai-live-litellm:4000', ANTHROPIC_AUTH_TOKEN: GATEWAY_KEY };
  delete process.env.TAI_VISION;
  delete process.env.TAI_VISION_MODEL;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.TAI_VISION;
  delete process.env.TAI_VISION_MODEL;
});

describe('the switch', () => {
  it('is on for exactly "1" and for nothing else', () => {
    expect(visionOn({ TAI_VISION: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', 'on', ' 1', '1 ', '2', 'TRUE']) expect(visionOn({ TAI_VISION: value }), String(value)).toBe(false);
    expect(visionOn({})).toBe(false);
  });

  it('reads the orchestrator\'s environment unless it is handed another', () => {
    expect(visionOn()).toBe(false);
    process.env.TAI_VISION = '1';
    expect(visionOn()).toBe(true);
  });
});

describe('the model\'s name', () => {
  it('is passed on when it is a plain gateway alias', () => {
    for (const name of ['glm-vision', 'glm', 'glm-5.3-flash', 'my_alias:2', 'A1']) expect(visionModel({ TAI_VISION_MODEL: name }), name).toBe(name);
    expect(visionModel({ TAI_VISION_MODEL: '  glm-vision  ' })).toBe('glm-vision');
  });

  it('is ignored when it is anything else: it goes on a command line', () => {
    for (const bad of [undefined, '', '  ', 'two words', 'a;b', '$(id)', '`id`', '--privileged', '-x', 'a/b', 'a\nb', 'x'.repeat(65), 'quote"d', "it's"]) {
      expect(visionModel({ TAI_VISION_MODEL: bad }), JSON.stringify(bad)).toBeNull();
      expect(MODEL_ALIAS.test(bad ?? ''), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('who gets the tool', () => {
  it('is a student\'s own run, when the switch is on', () => {
    expect(visionFor({ isMain: false }, { TAI_VISION: '1' })).toEqual({ model: null });
    expect(visionFor({ isMain: false, isScheduledTask: false }, { TAI_VISION: '1', TAI_VISION_MODEL: 'glm' })).toEqual({ model: 'glm' });
  });

  it('is nobody when it is off, and never the admin\'s chat or a scheduled task', () => {
    expect(visionFor({ isMain: false }, {})).toBeNull();
    expect(visionFor({ isMain: false }, { TAI_VISION: '0' })).toBeNull();
    expect(visionFor({ isMain: true }, { TAI_VISION: '1' })).toBeNull();
    expect(visionFor({ isMain: false, isScheduledTask: true }, { TAI_VISION: '1' })).toBeNull();
    expect(visionFor({ isMain: true, isScheduledTask: true }, { TAI_VISION: '1' })).toBeNull();
  });
});

describe('TAI_VISION in the container\'s environment', () => {
  it('is set for a student\'s chat when the switch is on, before the image, with the default alias left to the container', async () => {
    process.env.TAI_VISION = '1';
    const { args } = await start();
    expect(envOf(args)).toContain('TAI_VISION=1');
    expect(envOf(args).some((e) => e.startsWith('TAI_VISION_MODEL'))).toBe(false);
    expect(args.indexOf('TAI_VISION=1')).toBeLessThan(args.length - 1);
    expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
  });

  it('carries the alias the owner named, when it is a plain name', async () => {
    process.env.TAI_VISION = '1';
    process.env.TAI_VISION_MODEL = 'glm-5.3-flash';
    const { args } = await start();
    expect(envOf(args)).toContain('TAI_VISION=1');
    expect(envOf(args)).toContain('TAI_VISION_MODEL=glm-5.3-flash');
  });

  it('does not carry a name that is not a plain alias, but the tool is still on', async () => {
    process.env.TAI_VISION = '1';
    process.env.TAI_VISION_MODEL = 'glm; docker run --privileged';
    const { args } = await start();
    expect(envOf(args)).toContain('TAI_VISION=1');
    expect(args.some((a) => a.includes('TAI_VISION_MODEL') || a.includes('privileged'))).toBe(false);
  });

  it('is not set without the switch: the container is started exactly as it always was', async () => {
    const { args } = await start();
    expect(args.some((a) => a.includes('TAI_VISION'))).toBe(false);
  });

  for (const flag of ['0', 'true', '', ' 1']) {
    it(`is not set for TAI_VISION=${JSON.stringify(flag)}: only "1" turns it on`, async () => {
      process.env.TAI_VISION = flag;
      const { args } = await start();
      expect(args.some((a) => a.includes('TAI_VISION'))).toBe(false);
    });
  }

  for (const [what, extra] of [
    ['the instructor\'s admin chat', { isMain: true, chatJid: 'web:main' }],
    ['a scheduled task', { isScheduledTask: true }],
  ] as Array<[string, Partial<Input>]>) {
    it(`is not set for ${what}, switch or no switch`, async () => {
      process.env.TAI_VISION = '1';
      const { args } = await start(extra);
      expect(args.some((a) => a.includes('TAI_VISION'))).toBe(false);
    });
  }

  it('is not set for a voice call\'s tool host, which would then run a tool that sends a student\'s picture to z.ai without the call\'s student knowing', async () => {
    process.env.TAI_VISION = '1';
    process.env.TAI_VISION_MODEL = 'glm-vision';
    await spawnToolHost(ada, 'web:s_ada');
    const args = lastArgs();
    expect(args.some((a) => a.includes('TAI_VISION'))).toBe(false);
    expect(envOf(args)).toContain('TAI_MODE=tool-host');
    const stdin = String(fakeProc.stdin.read() ?? '');
    expect(stdin).not.toContain('TAI_VISION');
  });
});

describe('the gateway\'s key', () => {
  it('is on no command line, with the tool on or off', async () => {
    for (const on of [true, false]) {
      if (on) process.env.TAI_VISION = '1';
      else delete process.env.TAI_VISION;
      fakeProc = createFakeProcess();
      const { args } = await start();
      expect(args.join(' '), `tool ${on ? 'on' : 'off'}`).not.toContain(GATEWAY_KEY);
    }
  });

  it('goes to the container once, as the secret it always was: the host makes no second copy of it for the tool', async () => {
    process.env.TAI_VISION = '1';
    const { stdin } = await start();
    const secrets = (JSON.parse(stdin.trim()) as { secrets: Record<string, string> }).secrets;
    expect(secrets.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY_KEY);
    expect(secrets.ANTHROPIC_BASE_URL).toBe('http://tai-live-litellm:4000');
    expect(Object.keys(secrets).filter((k) => k.startsWith('TAI_VISION'))).toEqual([]);
    expect(stdin.split(GATEWAY_KEY)).toHaveLength(2);
  });
});
