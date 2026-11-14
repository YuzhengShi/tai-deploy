import fs from 'fs';
import path from 'path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const node = process.getBuiltinModule;
  return { dir: node('node:fs').mkdtempSync(node('node:path').join(node('node:os').tmpdir(), 'tai-ipc-watcher-')) as string };
});
vi.mock('./config.js', async (original) => {
  const real = await original<typeof import('./config.js')>();
  const p = await import('node:path');
  return { ...real, DATA_DIR: p.join(h.dir, 'data'), GROUPS_DIR: p.join(h.dir, 'groups'), STORE_DIR: p.join(h.dir, 'store'), IPC_POLL_INTERVAL: 20 };
});
vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { startIpcWatcher } from './ipc.js';
import { _resetSandboxRuns } from './sandbox/ipc-verb.js';
import type { SandboxResult } from './sandbox/types.js';
import { RegisteredGroup } from './types.js';

// The real watcher loop (startIpcWatcher, polling every 20 ms here), not only processTaskIpc: a student's run that takes a minute must not hold up the other groups' files, and a file
// whose run is still going must not be read again and run twice. (The loop can be started once per module, so this is a file of its own.)

const ADA: RegisteredGroup = { name: 'Ada', folder: 'ada', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', githubUsername: 'ada-gh' };
const BOB: RegisteredGroup = { name: 'Bob', folder: 'bob', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', githubUsername: 'bob-gh' };

afterAll(() => {
  _resetSandboxRuns();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const ipcFile = (folder: string, sub: string, name: string) => path.join(h.dir, 'data', 'ipc', folder, sub, name);
function drop(folder: string, name: string, data: object): void {
  fs.mkdirSync(path.dirname(ipcFile(folder, 'tasks', name)), { recursive: true });
  fs.writeFileSync(ipcFile(folder, 'tasks', name), JSON.stringify(data));
}
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('not in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the IPC watcher with a run that is still going', () => {
  it('answers the other group\'s request meanwhile, takes the file of the run away at once, and never starts the same run twice', async () => {
    _initTestDatabase();
    setRegisteredGroup('web:ada', ADA);
    setRegisteredGroup('web:bob', BOB);
    for (const folder of ['ada', 'bob']) fs.mkdirSync(path.join(h.dir, 'data', 'ipc', folder, 'results'), { recursive: true });

    const calls: string[] = [];
    let release!: (r: SandboxResult) => void;
    const slow = new Promise<SandboxResult>((resolve) => {
      release = resolve;
    });
    startIpcWatcher({
      runSandbox: (who) => {
        calls.push(who.folder);
        return slow;
      },
      sendMessage: async () => {},
      sendReaction: async () => {},
      sendAudioMessage: async () => {},
      sendImageMessage: async () => {},
      registeredGroups: () => ({ 'web:ada': ADA, 'web:bob': BOB }),
      registerGroup: () => {},
      syncGroupMetadata: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
    });

    drop('ada', '1-run.json', { type: 'sandbox_run', requestId: 'req-ada-00000001', request: { action: 'run', files: [{ path: 'main.go', content: 'package main\nfunc main() {}\n' }] } });
    drop('bob', '1-task.json', { type: 'schedule_task', requestId: 'req-bob-00000001', prompt: 'remind me', schedule_type: 'once', schedule_value: new Date(Date.now() + 86_400_000).toISOString(), context_mode: 'isolated', targetJid: 'web:bob' });

    // Bob is answered while Ada's run is still going
    await until(() => fs.existsSync(ipcFile('bob', 'results', 'req-bob-00000001.json')));
    expect(JSON.parse(fs.readFileSync(ipcFile('bob', 'results', 'req-bob-00000001.json'), 'utf-8')).ok).toBe(true);
    expect(fs.existsSync(ipcFile('ada', 'results', 'req-ada-00000001.json'))).toBe(false);
    // the run's file is taken away as soon as the run is started, and many polls later the run has still been started once
    expect(fs.existsSync(ipcFile('ada', 'tasks', '1-run.json'))).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toEqual(['ada']);

    release({ ok: true, exitCode: 0, timedOut: false, outputTruncated: false, output: 'hi\n', durationMs: 10 });
    await until(() => fs.existsSync(ipcFile('ada', 'results', 'req-ada-00000001.json')));
    expect(JSON.parse(fs.readFileSync(ipcFile('ada', 'results', 'req-ada-00000001.json'), 'utf-8')).ok).toBe(true);
    expect(calls).toEqual(['ada']);
  });
});
