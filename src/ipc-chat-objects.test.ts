import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A folder of the test's own for the audit log and the IPC directories; the writes of answer files are counted (exactly one for each request)
const h = vi.hoisted(() => {
  const node = process.getBuiltinModule;
  return { dir: node('node:fs').mkdtempSync(node('node:path').join(node('node:os').tmpdir(), 'tai-ipc-cards-')) as string, writes: [] as string[] };
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

import { CHAT_OBJECT_KIND_UNKNOWN, CHAT_OBJECT_NOT_REGISTERED, CHAT_OBJECT_NO_CARD, _resetChatObjects } from './chat-objects/ipc-verb.js';
import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { IpcDeps, processTaskIpc } from './ipc.js';
import { RegisteredGroup } from './types.js';

// The container's tools show_chart, show_trace and ask_to_predict ask the host for a card: the verb `chat_object` of processTaskIpc. The data goes through the history's gate, the student is the folder of the IPC
// directory, the card is left by the host, and every request gets one answer file.

const MAIN: RegisteredGroup = { name: 'Admin', folder: 'main', trigger: 'always', added_at: '2026-01-01T00:00:00.000Z' };
const ADA: RegisteredGroup = { name: 'Ada', folder: 'ada', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', canvasUserId: '1001' };

const chart = { title: 'Latency by threads', kind: 'line', x_label: 'threads', y_label: 'latency', y_unit: 'ms', series: [{ name: 'gin', points: [[1, 12], [2, 15], [4, 31]] }] };
const trace = { title: 'Raft election', actors: ['A', 'B'], events: [{ from: 'A', to: 'B', label: 'RequestVote' }] };

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let cards: Array<{ folder: string; obj: unknown }>;
let counter = 0;

beforeEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
  fs.mkdirSync(h.dir, { recursive: true });
  h.writes.length = 0;
  _initTestDatabase();
  _resetChatObjects();
  groups = { 'web:main': MAIN, 'web:ada': ADA };
  for (const [jid, group] of Object.entries(groups)) setRegisteredGroup(jid, group);
  for (const folder of ['main', 'ada', 'ghost']) fs.mkdirSync(path.join(h.dir, 'data', 'ipc', folder, 'results'), { recursive: true });
  cards = [];
  deps = {
    postObject: (folder, obj) => void cards.push({ folder, obj }),
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
  _resetChatObjects();
});

const resultsDir = (folder: string) => path.join(h.dir, 'data', 'ipc', folder, 'results');
const answerPath = (folder: string, id: string) => path.join(resultsDir(folder), `${id}.json`);
const newId = () => `req-${String(++counter).padStart(8, '0')}`;
function audit(): Array<Record<string, unknown>> {
  const file = path.join(h.dir, 'data', 'audit', 'admin-operations.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
async function ask(request: unknown, source = 'ada', isMain = false, id: string | undefined = newId()): Promise<{ ok: boolean; message: string }> {
  await processTaskIpc({ type: 'chat_object', ...(id ? { requestId: id } : {}), request } as never, source, isMain, deps);
  return JSON.parse(fs.readFileSync(answerPath(source, id as string), 'utf-8'));
}

describe('the chat_object request', () => {
  it('leaves a chart in the chat of the folder of the IPC directory and answers {ok, message} in one file written once', async () => {
    const id = newId();
    const got = await ask({ kind: 'chart', args: chart }, 'ada', false, id);
    expect(Object.keys(got).sort()).toEqual(['message', 'ok']);
    expect(got.ok).toBe(true);
    expect(got.message).toMatch(/^Chart: Latency by threads \(1 series\): it is in the chat now as a card/);
    expect(cards).toEqual([{ folder: 'ada', obj: expect.objectContaining({ t: 'chart', title: 'Latency by threads', xLabel: 'threads', yUnit: 'ms' }) }]);
    expect(h.writes.filter((f) => f === answerPath('ada', id))).toHaveLength(1);
    expect(fs.readdirSync(resultsDir('ada'))).toEqual([`${id}.json`]);
  });

  it('makes a trace as well, and answers within what the container reads', async () => {
    const got = await ask({ kind: 'trace', args: trace });
    expect(got.ok).toBe(true);
    expect(got.message.length).toBeLessThanOrEqual(900);
    expect(cards[0].obj).toMatchObject({ t: 'trace', actors: ['A', 'B'] });
  });

  it('says what is wrong with a card the gate refuses, and leaves nothing', async () => {
    const got = await ask({ kind: 'chart', args: { ...chart, kind: 'pie' } });
    expect(got.ok).toBe(false);
    expect(got.message).toMatch(/^Not drawn: kind is line, bar or scatter/);
    expect(cards).toEqual([]);
    expect(await ask({ kind: 'doc', args: {} })).toEqual({ ok: false, message: CHAT_OBJECT_KIND_UNKNOWN });
  });

  it('refuses a folder that is not a registered group, and the admin chat may ask', async () => {
    expect(await ask({ kind: 'chart', args: chart }, 'ghost')).toEqual({ ok: false, message: CHAT_OBJECT_NOT_REGISTERED });
    expect(cards).toEqual([]);
    expect(await ask({ kind: 'chart', args: chart }, 'main', true)).toMatchObject({ ok: true });
    expect(cards).toEqual([{ folder: 'main', obj: expect.objectContaining({ t: 'chart' }) }]);
  });

  it('does not say the card is in the chat when the chat did not take it', async () => {
    deps = {
      ...deps,
      postObject: () => {
        throw new Error('the chat did not take the card');
      },
    };
    expect(await ask({ kind: 'trace', args: trace })).toEqual({ ok: false, message: CHAT_OBJECT_NO_CARD });
  });

  it('writes no answer for a request with no usable id, and logs the kind and how it ended, never the data', async () => {
    await processTaskIpc({ type: 'chat_object', request: { kind: 'chart', args: chart } } as never, 'ada', false, deps);
    await processTaskIpc({ type: 'chat_object', requestId: '../../x', request: { kind: 'chart', args: chart } } as never, 'ada', false, deps);
    expect(fs.readdirSync(resultsDir('ada'))).toEqual([]);
    expect(cards).toEqual([]);
    await ask({ kind: 'chart', args: chart });
    const entries = audit().filter((e) => e.operation === 'chat_object' || e.op === 'chat_object');
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).toContain('"kind":"chart"');
    expect(JSON.stringify(audit())).not.toContain('Latency by threads');
  });
});
