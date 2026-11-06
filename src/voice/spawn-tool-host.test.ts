/**
 * src/container-runner.ts spawnToolHost: the tool host container is the text agent's container (same mounts, limits, network,
 * identity) started in tool-host mode, and it never gets the Deepgram key or the relay's gateway key.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
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
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../mount-security.js', () => ({ validateAdditionalMounts: vi.fn(() => []) }));
vi.mock('../memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
  buildMemoryExport: vi.fn(() => ({ memories: [{ text: 'likes analogies' }], messages: [] })),
  pruneExpiredMemories: vi.fn(),
}));
// everything the .env could hold, including what must never reach a container
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({ CANVAS_API_TOKEN: 'canvas-tok', ANTHROPIC_API_KEY: 'anth', DEEPGRAM_API_KEY: 'dg-secret', TAI_VOICE_LLM_KEY: 'gw-secret', VOICE_INTERVIEW_SECRET: 'iv' })),
}));
const written: Record<string, string> = {};
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn((file: string, data: string) => {
        written[String(file)] = String(data);
      }),
      // (the memory export is written to a temporary name and renamed, src/safe-fs.ts: the rename is what makes the file)
      renameSync: vi.fn((from: string, to: string) => {
        written[String(to)] = written[String(from)];
        delete written[String(from)];
      }),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      realpathSync: vi.fn((p: string) => p),
    },
  };
});
const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
const spawnMock = vi.fn((..._args: unknown[]) => child);
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no metadata service in the tests'))));

import { spawnToolHost } from '../container-runner.js';

describe('spawnToolHost', () => {
  it('starts the student container in tool-host mode, writes the ContainerInput, and keeps the voice keys out', async () => {
    let input = '';
    child.stdin.on('data', (c: Buffer) => (input += c.toString()));
    const { process: proc, containerName, refresh } = await spawnToolHost(
      { name: 'Ana', folder: 's_abc', trigger: '@TAi', added_at: '2026-01-01', canvasUserId: '77', githubUsername: 'ana-gh' },
      'web:s_abc',
    );
    expect(proc).toBe(child);
    expect(containerName).toMatch(/^testprefix-voice-s-abc-\d+$/);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('docker');
    expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
    expect(args.slice(-3, -1)).toEqual(['-e', 'TAI_MODE=tool-host']);
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('test-net');
    expect(args[args.indexOf('--name') + 1]).toBe(containerName);
    const joined = args.join(' ').replace(/\\/g, '/'); // path.join on a Windows test machine
    expect(joined).toContain('/tmp/tai-test-groups/s_abc:/workspace/group');
    expect(joined).toContain('/tmp/tai-test-data/ipc/s_abc:/workspace/ipc');
    expect(joined).not.toContain('/workspace/project');
    await new Promise((r) => setTimeout(r, 10));
    const line = JSON.parse(input.trim());
    expect(line).toMatchObject({ prompt: '', groupFolder: 's_abc', chatJid: 'web:s_abc', isMain: false, canvasUserId: '77', githubUsername: 'ana-gh' });
    expect(line.secrets.CANVAS_API_TOKEN).toBe('canvas-tok');
    expect(line.secrets.VOICE_INTERVIEW_SECRET).toBe('iv');
    expect(line.secrets.DEEPGRAM_API_KEY).toBeUndefined();
    expect(line.secrets.TAI_VOICE_LLM_KEY).toBeUndefined();
    expect(Object.keys(written).some((f) => f.replace(/\\/g, '/').endsWith('s_abc/memory_store.json'))).toBe(true);
    // a host kept for the student's next call has the memory export written again before it is handed out (voice/tool-host-pool.ts)
    const file = Object.keys(written).find((f) => f.replace(/\\/g, '/').endsWith('s_abc/memory_store.json'))!;
    written[file] = 'stale';
    refresh();
    expect(written[file]).toContain('likes analogies');
    // an error of the process (no docker) has a listener before the caller gets it
    expect(child.listenerCount('error')).toBeGreaterThan(0);
  });
});
