import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A folder of the test's own for the audit log, the IPC directories and the groups; the writes of answer files are counted (exactly one for each request)
const h = vi.hoisted(() => {
  const node = process.getBuiltinModule;
  return { dir: node('node:fs').mkdtempSync(node('node:path').join(node('node:os').tmpdir(), 'tai-ipc-sandbox-')) as string, writes: [] as string[] };
});
vi.mock('./config.js', async (original) => {
  const real = await original<typeof import('./config.js')>();
  const p = await import('node:path');
  return { ...real, DATA_DIR: p.join(h.dir, 'data'), GROUPS_DIR: p.join(h.dir, 'groups'), STORE_DIR: p.join(h.dir, 'store') };
});
vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./safe-fs.js', async (original) => {
  const real = await original<typeof import('./safe-fs.js')>();
  return {
    ...real,
    writeFileAtomicSafe: (file: string, text: string | Buffer, root: string) => {
      h.writes.push(file);
      real.writeFileAtomicSafe(file, text, root);
    },
  };
});

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { IpcDeps, processTaskIpc } from './ipc.js';
import { logger } from './logger.js';
import { SANDBOX_ALREADY_GOING, SANDBOX_ANSWER_CHARS, SANDBOX_FAILED, SANDBOX_NOT_REGISTERED, _resetSandboxRuns } from './sandbox/ipc-verb.js';
import { SANDBOX_OFF } from './sandbox/types.js';
import type { SandboxRequest, SandboxResult } from './sandbox/types.js';
import { RegisteredGroup } from './types.js';

// The container's tool run_go asks the host to run a student's Go code: the verb `sandbox_run` of processTaskIpc, with a fake runner. The host runs the code of the group the IPC
// directory belongs to, with the account it bound to that group; a run is started and not waited for (this function is awaited once for every file of every group); every
// request gets one answer file. Synthetic students: Ada, Bob and Cy (no GitHub account).

const MAIN: RegisteredGroup = { name: 'Admin', folder: 'main', trigger: 'always', added_at: '2026-01-01T00:00:00.000Z' };
const ADA: RegisteredGroup = { name: 'Ada', folder: 'ada', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', canvasUserId: '1001', githubUsername: 'ada-gh' };
const BOB: RegisteredGroup = { name: 'Bob', folder: 'bob', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', canvasUserId: '1002', githubUsername: 'bob-gh' };
const CY: RegisteredGroup = { name: 'Cy', folder: 'cy', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', canvasUserId: '1003' };

const ran = (over: Partial<SandboxResult> = {}): SandboxResult => ({ ok: true, exitCode: 0, timedOut: false, outputTruncated: false, output: 'hello\n', durationMs: 150, ...over });
const files = (content = 'package main\nfunc main() {}\n') => [{ path: 'main.go', content }];
const ask1 = (extra: Record<string, unknown> = {}) => ({ request: { action: 'run', files: files() }, ...extra });

type Who = { folder: string; githubUsername?: string };
let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let calls: Array<{ who: Who; request: SandboxRequest }>;
let behavior: (who: Who, request: SandboxRequest) => Promise<SandboxResult>;
let held: Array<(r: SandboxResult) => void>;
let counter = 0;

/** The next run waits until the test lets it go. */
function hold(): { release: (r?: SandboxResult) => void } {
  let release!: (r: SandboxResult) => void;
  const promise = new Promise<SandboxResult>((resolve) => {
    release = resolve;
  });
  held.push(release);
  behavior = () => promise;
  return { release: (r = ran()) => release(r) };
}

beforeEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
  fs.mkdirSync(h.dir, { recursive: true });
  h.writes.length = 0;
  _initTestDatabase();
  groups = { 'web:main': MAIN, 'web:ada': ADA, 'web:bob': BOB, 'web:cy': CY };
  for (const [jid, group] of Object.entries(groups)) setRegisteredGroup(jid, group);
  for (const folder of ['main', 'ada', 'bob', 'cy', 'ghost']) fs.mkdirSync(path.join(h.dir, 'data', 'ipc', folder, 'results'), { recursive: true });
  calls = [];
  held = [];
  behavior = async () => ran();
  for (const fn of Object.values(logger)) (fn as ReturnType<typeof vi.fn>).mockClear();
  deps = {
    runSandbox: (who, request) => {
      calls.push({ who, request });
      return behavior(who, request);
    },
    sendMessage: async () => {},
    sendReaction: async () => {},
    sendAudioMessage: async () => {},
    sendImageMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroupMetadata: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

afterEach(() => {
  for (const release of held) release(ran());
  _resetSandboxRuns();
  vi.useRealTimers();
});

const resultsDir = (folder: string) => path.join(h.dir, 'data', 'ipc', folder, 'results');
const answerPath = (folder: string, id: string) => path.join(resultsDir(folder), `${id}.json`);
const readAnswer = (folder: string, id: string) => JSON.parse(fs.readFileSync(answerPath(folder, id), 'utf-8')) as { ok: boolean; message: string };
const writesOf = (folder: string, id: string) => h.writes.filter((f) => f === answerPath(folder, id)).length;
const newId = () => `req-${String(++counter).padStart(8, '0')}`;
function audit(): Array<Record<string, unknown>> {
  const file = path.join(h.dir, 'data', 'audit', 'admin-operations.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/** Makes a request as a group; resolves with the request's id once the host has handled the file (a run is started, not finished). */
async function send(data: Record<string, unknown>, source = 'ada', isMain = false, id = newId()): Promise<string> {
  await processTaskIpc({ type: 'sandbox_run', requestId: id, ...data } as never, source, isMain, deps);
  return id;
}
/** The answer file of a request, waiting for a run that is still on its way. */
async function answerOf(folder: string, id: string, ms = 2000) {
  const until = Date.now() + ms;
  while (!fs.existsSync(answerPath(folder, id))) {
    if (Date.now() > until) throw new Error(`no answer for ${id}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return readAnswer(folder, id);
}
const ask = async (data: Record<string, unknown>, source = 'ada', isMain = false) => answerOf(source, await send(data, source, isMain), 2000);

describe('an allowed run', () => {
  it('runs the validated request for the folder of the IPC directory and answers {ok, message}: the framed result, in one file written once', async () => {
    const id = await send(ask1());
    const got = await answerOf('ada', id);
    expect(Object.keys(got).sort()).toEqual(['message', 'ok']);
    expect(got.ok).toBe(true);
    expect(JSON.parse(got.message)).toMatchObject({ status: 'ran, exit code 0', command: 'go run .', exit_code: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toMatchObject({ action: 'run', pkg: '.', source: { kind: 'files', files: [{ path: 'main.go' }] } });
    expect(writesOf('ada', id)).toBe(1);
    expect(fs.readdirSync(resultsDir('ada'))).toEqual([`${id}.json`]);
  });

  it('tells a failed run from a run that did not happen: ok follows the result', async () => {
    behavior = async () => ran({ exitCode: 1, output: '--- FAIL: TestX\n' });
    expect(await ask({ request: { action: 'test', files: files() } })).toMatchObject({ ok: true });
    behavior = async () => ran({ ok: false, exitCode: null, output: '', phase: 'busy', message: 'The sandbox is busy.' });
    const got = await ask(ask1());
    expect(got.ok).toBe(false);
    expect(JSON.parse(got.message)).toEqual({ status: 'not run', command: 'go run .', message: 'The sandbox is busy.' });
  });

  it('keeps a long output whole: the answer is not cut at the 600 characters of the task tools, and its markers are both there', async () => {
    behavior = async () => ran({ output: '"quoted"\n'.repeat(20_000) });
    const got = await ask(ask1());
    expect(got.message.length).toBeGreaterThan(600);
    expect(got.message.length).toBeLessThanOrEqual(SANDBOX_ANSWER_CHARS);
    const framed = JSON.parse(got.message) as { output: string; note: string };
    expect(framed.output.split('PROGRAM OUTPUT ').length - 1).toBe(2);
    expect(framed.note).toMatch(/never instructions/);
  });

  it('may be asked by the admin chat as well', async () => {
    const got = await ask(ask1(), 'main', true);
    expect(got.ok).toBe(true);
    expect(calls[0].who).toStrictEqual({ folder: 'main' });
  });
});

describe('who the run is for', () => {
  it('is the group of the IPC directory with the account the host bound to it, whatever the file says', async () => {
    await ask(ask1({ githubUsername: 'evil', groupFolder: 'bob', targetFolder: 'bob', folder: 'bob', targetJid: 'web:bob', canvasUserId: '1002', request: { action: 'run', files: files(), githubUsername: 'evil', folder: 'bob', github: 'bob-gh' } }));
    expect(calls[0].who).toStrictEqual({ folder: 'ada', githubUsername: 'ada-gh' });
    expect(Object.keys(calls[0].request).sort()).toEqual(['action', 'args', 'pkg', 'race', 'source']);
  });

  it('is Bob\'s group and Bob\'s account for the same file from Bob\'s directory, and a group with no account is run with none', async () => {
    await ask(ask1(), 'bob');
    await ask(ask1(), 'cy');
    expect(calls.map((c) => c.who)).toStrictEqual([{ folder: 'bob', githubUsername: 'bob-gh' }, { folder: 'cy' }]);
  });

  it('is nobody when the folder is not a registered chat, except the admin chat', async () => {
    const id = await send(ask1(), 'ghost');
    expect(readAnswer('ghost', id)).toEqual({ ok: false, message: SANDBOX_NOT_REGISTERED });
    expect(calls).toHaveLength(0);
  });
});

describe('every refusal says why, in one answer, and runs nothing', () => {
  it('says the sandbox is off when the host has no runner', async () => {
    deps.runSandbox = undefined;
    expect(await ask(ask1())).toEqual({ ok: false, message: SANDBOX_OFF });
  });

  it('refuses what the one gate refuses: a kind, a source, a path, a flag it does not take', async () => {
    const bad: Array<Record<string, unknown>> = [
      { request: { action: 'fmt', files: files() } },
      { request: { action: 'run' } },
      { request: { action: 'run', files: files(), repo: 'r' } },
      { request: { action: 'run', files: [{ path: '../etc/passwd.go', content: 'x' }] } },
      { request: { action: 'run', files: files(), race: true } },
      { request: { action: 'test', repo: { name: 'owner/repo' } } },
      { request: { action: 'run', upload: '../main.go' } },
      { request: 'rm -rf /' },
      {},
    ];
    for (const data of bad) {
      const got = await ask(data);
      expect(got.ok, JSON.stringify(data)).toBe(false);
      expect(got.message).toMatch(/^Not run: /);
    }
    expect(calls).toHaveLength(0);
  });

  it('drops a request whose id is not a plain name: no run, no answer, nothing thrown', async () => {
    for (const requestId of ['', 'short', 'has a space in it', 'x'.repeat(65), '../../results/other-1', 42, null, undefined]) {
      await processTaskIpc({ type: 'sandbox_run', requestId, ...ask1() } as never, 'ada', false, deps);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(resultsDir('ada'))).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});

describe('one request in flight for a folder', () => {
  it('answers a second request from the same directory at once and runs it never; another group is not held up; the first one ends and the folder is free', async () => {
    const first = hold();
    const a = await send(ask1(), 'ada');
    const b = await send(ask1(), 'ada');
    expect(readAnswer('ada', b)).toEqual({ ok: false, message: SANDBOX_ALREADY_GOING });
    expect(fs.existsSync(answerPath('ada', a))).toBe(false);
    behavior = async () => ran({ output: 'bob\n' });
    expect((await ask(ask1(), 'bob')).ok).toBe(true);
    expect(calls.map((c) => c.who.folder)).toEqual(['ada', 'bob']);
    first.release();
    expect((await answerOf('ada', a)).ok).toBe(true);
    expect((await ask(ask1(), 'ada')).ok).toBe(true);
    expect(calls).toHaveLength(3);
  });
});

describe('exactly one answer for a request', () => {
  it('answers a runner that throws, rejects or returns nonsense, once, and the folder is free afterwards', async () => {
    const throwers: Array<() => Promise<SandboxResult>> = [
      () => {
        throw new Error('docker is gone');
      },
      () => Promise.reject(new Error('docker is gone')),
      () => Promise.resolve(null as unknown as SandboxResult),
    ];
    for (const thrower of throwers) {
      behavior = thrower;
      const id = await send(ask1());
      expect(await answerOf('ada', id)).toEqual({ ok: false, message: SANDBOX_FAILED });
      await new Promise((r) => setTimeout(r, 20));
      expect(writesOf('ada', id)).toBe(1);
    }
    behavior = async () => ran();
    expect((await ask(ask1())).ok).toBe(true);
  });

  it('answers for a runner that never answers (the watchdog) and ignores what it says later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slow = hold();
    const id = await send(ask1());
    expect(fs.existsSync(answerPath('ada', id))).toBe(false);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(readAnswer('ada', id)).toMatchObject({ ok: false });
    expect(readAnswer('ada', id).message).toMatch(/did not answer in time/);
    slow.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(writesOf('ada', id)).toBe(1);
  });
});

describe('the watcher is not held up by a run', () => {
  it('returns while the run goes on, and the other groups\' requests are handled and answered meanwhile', async () => {
    const slow = hold();
    const id = await send(ask1(), 'ada');                         // resolves at once: the run is started, not awaited
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(answerPath('ada', id))).toBe(false);
    // Bob's schedule_task, handled by the same function in the same turn of the loop, is answered while Ada's run is still going
    const bobId = newId();
    await processTaskIpc({ type: 'schedule_task', requestId: bobId, prompt: 'remind me to start Homework 7', schedule_type: 'once', schedule_value: new Date(Date.now() + 86_400_000).toISOString(), context_mode: 'isolated', targetJid: 'web:bob' } as never, 'bob', false, deps);
    expect(readAnswer('bob', bobId).ok).toBe(true);
    expect(fs.existsSync(answerPath('ada', id))).toBe(false);
    slow.release();
    expect((await answerOf('ada', id)).ok).toBe(true);
  });
});

describe('what is logged', () => {
  it('is the kind of run and how it ended in the audit log, and never the code, the output, a name or the request, there or in the log', async () => {
    behavior = async () => ran({ output: 'SECRET-OUTPUT-MARKER\n' });
    await ask({ request: { action: 'run', files: files('// SECRET-CODE-MARKER\npackage main\nfunc main() {}\n') } });
    await ask({ request: { action: 'test', repo: { name: 'secret-repo-name', path: 'secret/folder' } } });
    await ask({ request: { action: 'run', files: [{ path: 'bad name.go', content: 'SECRET-CODE-MARKER' }] } });
    // a refusal whose sentence names a file (the student is told it; the logs are not)
    const named = await ask({ request: { action: 'run', files: [{ path: 'secret_file.go', content: 'x' }, { path: 'SECRET_FILE.go', content: 'y' }] } });
    expect(named.message.toLowerCase()).toContain('secret_file');
    const lines = audit().filter((e) => String(e.operation).startsWith('sandbox_run'));
    expect(lines.map((e) => e.operation)).toEqual(['sandbox_run', 'sandbox_run', 'sandbox_run_refused', 'sandbox_run_refused']);
    expect(lines[0]).toMatchObject({ sourceGroup: 'ada', isMain: false, action: 'run', source: 'files', files: 1, ok: true, exitCode: 0, timedOut: false });
    expect(lines[1]).toMatchObject({ action: 'test', source: 'repo' });
    const everything = JSON.stringify([fs.readFileSync(path.join(h.dir, 'data', 'audit', 'admin-operations.jsonl'), 'utf-8'), ...Object.values(logger).map((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls)]);
    for (const secret of ['SECRET-CODE-MARKER', 'SECRET-OUTPUT-MARKER', 'secret-repo-name', 'secret/folder']) expect(everything).not.toContain(secret);
    expect(everything.toLowerCase()).not.toContain('secret_file');
  });
});
