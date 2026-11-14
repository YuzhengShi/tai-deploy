import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A folder of the test's own for the audit log, the IPC directories and the groups; the writes of answer files are counted (exactly one for each request)
const h = vi.hoisted(() => {
  const node = process.getBuiltinModule;
  return { dir: node('node:fs').mkdtempSync(node('node:path').join(node('node:os').tmpdir(), 'tai-ipc-docs-')) as string, writes: [] as string[] };
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
import { DOC_ANSWER_CHARS, DOC_ALREADY_GOING, DOC_NO_NAME, _resetDocOpens } from './docs/ipc-verb.js';
import { RENDER_NOT_SET_UP } from './docs/render.js';
import type { DocMeta, DocOpenResult, DocsApi } from './docs/types.js';
import { IpcDeps, processTaskIpc } from './ipc.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// The container's tool show_document asks the host to put a document in the student's chat: the verb `doc_open` of processTaskIpc, with a fake documents service. The document is found in the files of the
// group the IPC directory belongs to; the work is started and not waited for (this function is awaited once for every file of every group); every request gets one answer file and the card is left by the host.

const MAIN: RegisteredGroup = { name: 'Admin', folder: 'main', trigger: 'always', added_at: '2026-01-01T00:00:00.000Z' };
const ADA: RegisteredGroup = { name: 'Ada', folder: 'ada', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', canvasUserId: '1001', githubUsername: 'ada-gh' };
const BOB: RegisteredGroup = { name: 'Bob', folder: 'bob', trigger: '@TAi', added_at: '2026-01-01T00:00:00.000Z', canvasUserId: '1002' };

const meta = (n: number, title: string, pages = 12): DocMeta => ({ id: n.toString(16).padStart(32, '0'), title, pages, origin: 'upload', createdAt: n, bytes: 100 });

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;
let opened: Array<{ folder: string; source: unknown }>;
let cards: Array<{ folder: string; obj: unknown }>;
let listed: DocMeta[];
let open: (folder: string, source: unknown) => Promise<DocOpenResult>;
let counter = 0;

const fakeDocs = (): DocsApi =>
  ({
    open: (who: { folder: string }, source: unknown) => {
      opened.push({ folder: who.folder, source });
      return open(who.folder, source);
    },
    list: () => listed,
    library: () => [],
    searchLibrary: () => [],
    meta: () => null,
    words: () => null,
    text: () => null,
    pageFile: () => null,
    ready: async () => true,
    reap: async () => 0,
  }) as unknown as DocsApi;

beforeEach(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
  fs.mkdirSync(h.dir, { recursive: true });
  h.writes.length = 0;
  _initTestDatabase();
  groups = { 'web:main': MAIN, 'web:ada': ADA, 'web:bob': BOB };
  for (const [jid, group] of Object.entries(groups)) setRegisteredGroup(jid, group);
  for (const folder of ['main', 'ada', 'bob', 'ghost']) fs.mkdirSync(path.join(h.dir, 'data', 'ipc', folder, 'results'), { recursive: true });
  fs.mkdirSync(path.join(h.dir, 'groups', 'ada', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'groups', 'ada', 'uploads', 'report.pdf'), '%PDF-1.4');
  fs.mkdirSync(path.join(h.dir, 'groups', 'bob', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'groups', 'bob', 'uploads', 'bobs-notes.pdf'), '%PDF-1.4');
  opened = [];
  cards = [];
  listed = [meta(1, 'Raft paper'), meta(2, 'Lecture 3 notes', 40)];
  open = async (_folder, source) => ({ ok: true, doc: (source as { kind: string; id?: string }).kind === 'existing' ? listed.find((d) => d.id === (source as { id: string }).id) ?? listed[0] : meta(9, 'report', 5), page: 1 });
  for (const fn of Object.values(logger)) (fn as ReturnType<typeof vi.fn>).mockClear();
  deps = {
    docs: fakeDocs(),
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
  _resetDocOpens();
  vi.useRealTimers();
});

const resultsDir = (folder: string) => path.join(h.dir, 'data', 'ipc', folder, 'results');
const answerPath = (folder: string, id: string) => path.join(resultsDir(folder), `${id}.json`);
const newId = () => `req-${String(++counter).padStart(8, '0')}`;
const writesOf = (folder: string, id: string) => h.writes.filter((f) => f === answerPath(folder, id)).length;
function audit(): Array<Record<string, unknown>> {
  const file = path.join(h.dir, 'data', 'audit', 'admin-operations.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

async function send(request: unknown, source = 'ada', isMain = false, id = newId()): Promise<string> {
  await processTaskIpc({ type: 'doc_open', requestId: id, request } as never, source, isMain, deps);
  return id;
}
async function answerOf(folder: string, id: string, ms = 2000): Promise<{ ok: boolean; message: string }> {
  const until = Date.now() + ms;
  while (!fs.existsSync(answerPath(folder, id))) {
    if (Date.now() > until) throw new Error(`no answer for ${id}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  return JSON.parse(fs.readFileSync(answerPath(folder, id), 'utf-8'));
}
const ask = async (request: unknown, source = 'ada', isMain = false) => answerOf(source, await send(request, source, isMain));

describe('showing a document', () => {
  it('opens a prepared document by its title for the folder of the IPC directory, answers {ok, message} in one file written once, and leaves the card in that student\'s chat', async () => {
    const id = await send({ name: 'raft paper', page: 3 });
    const got = await answerOf('ada', id);
    expect(Object.keys(got).sort()).toEqual(['message', 'ok']);
    expect(got.ok).toBe(true);
    expect(got.message).toContain('"Raft paper" (12 pages)');
    expect(got.message).toContain('at page 3');
    expect(opened).toEqual([{ folder: 'ada', source: { kind: 'existing', id: listed[0].id } }]);
    expect(cards).toEqual([{ folder: 'ada', obj: { t: 'doc', doc: listed[0].id, title: 'Raft paper', pages: 12, page: 3, origin: 'upload' } }]);
    expect(writesOf('ada', id)).toBe(1);
    expect(fs.readdirSync(resultsDir('ada'))).toEqual([`${id}.json`]);
  });

  it('opens a PDF among the files of the group, by the name it finds in that group\'s uploads folder, and never one of another group', async () => {
    expect(await ask({ name: '/workspace/group/uploads/report.pdf' })).toMatchObject({ ok: true });
    expect(opened.at(-1)).toEqual({ folder: 'ada', source: { kind: 'upload', name: 'report.pdf' } });
    const other = await ask({ name: 'bobs-notes.pdf' }); // Bob's file, asked for by Ada's container
    expect(other.ok).toBe(false);
    expect(other.message).toContain('Files they attached: report.pdf.');
    expect(other.message).not.toContain('bobs-notes');
    expect(opened).toHaveLength(1);
    expect(await ask({ name: 'bobs-notes.pdf' }, 'bob')).toMatchObject({ ok: true });
    expect(opened.at(-1)).toEqual({ folder: 'bob', source: { kind: 'upload', name: 'bobs-notes.pdf' } });
  });

  it('tells the container what there is when the name matches nothing, in more than the 600 characters of the task tools, and opens nothing', async () => {
    listed = Array.from({ length: 8 }, (_, i) => meta(i + 1, `${'T'.repeat(100)} ${i}`));
    const got = await ask({ name: 'quantum cooking' });
    expect(got.ok).toBe(false);
    expect(got.message.length).toBeGreaterThan(600);
    expect(got.message.length).toBeLessThanOrEqual(DOC_ANSWER_CHARS);
    expect(got.message).toContain(`${'T'.repeat(100)} 7`);
    expect(opened).toEqual([]);
    expect(cards).toEqual([]);
  });

  it('says why when the service could not, and leaves no card', async () => {
    open = async () => ({ ok: false, reason: 'limit', message: 'Not opened: 6 new documents in ten minutes.' });
    expect(await ask({ name: 'report.pdf' })).toEqual({ ok: false, message: 'Not opened: 6 new documents in ten minutes.' });
    expect(cards).toEqual([]);
  });

  it('does not say the document is in the chat when the chat did not take its card', async () => {
    deps = {
      ...deps,
      postObject: () => {
        throw new Error('the chat did not take the card');
      },
    };
    const got = await ask({ name: 'raft paper' });
    expect(got.ok).toBe(false);
    expect(got.message).toContain('was prepared, but the chat did not take its card');
  });

  it('refuses a request with no name, and a request that names a student: the folder of the directory is the only student', async () => {
    expect(await ask({})).toEqual({ ok: false, message: DOC_NO_NAME });
    expect(await ask({ name: 'report.pdf', folder: 'bob', student: 'bob', who: { folder: 'bob' } })).toMatchObject({ ok: true });
    expect(opened.every((o) => o.folder === 'ada')).toBe(true);
    expect(cards.every((c) => c.folder === 'ada')).toBe(true);
  });

  it('is off without a documents service, and refuses a group that is not registered; the admin chat may ask', async () => {
    deps = { ...deps, docs: undefined };
    expect(await ask({ name: 'report.pdf' })).toEqual({ ok: false, message: RENDER_NOT_SET_UP });
    deps = { ...deps, docs: fakeDocs() };
    const ghost = await ask({ name: 'report.pdf' }, 'ghost');
    expect(ghost.ok).toBe(false);
    expect(ghost.message).toMatch(/not registered/);
    expect(opened).toEqual([]);
    expect((await ask({ name: 'Raft paper' }, 'main', true)).ok).toBe(true);
    expect(opened).toEqual([{ folder: 'main', source: { kind: 'existing', id: listed[0].id } }]);
  });

  it('starts the work and returns at once: this function is awaited for every file of every group, and a render takes up to a minute and a half', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    open = async () => (await gate, { ok: true, doc: meta(9, 'report', 5), page: 1 });
    const began = Date.now();
    const id = await send({ name: 'report.pdf' });
    expect(Date.now() - began).toBeLessThan(500);
    expect(fs.existsSync(answerPath('ada', id))).toBe(false);
    const second = await send({ name: 'report.pdf' }); // while the first is still going: told so at once
    expect(await answerOf('ada', second)).toEqual({ ok: false, message: DOC_ALREADY_GOING });
    release();
    expect((await answerOf('ada', id)).ok).toBe(true);
  });

  it('drops a request with no usable id without a word, and answers every other request exactly once', async () => {
    await processTaskIpc({ type: 'doc_open', requestId: '../../etc/x', request: { name: 'report.pdf' } } as never, 'ada', false, deps);
    await processTaskIpc({ type: 'doc_open', request: { name: 'report.pdf' } } as never, 'ada', false, deps);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(resultsDir('ada'))).toEqual([]);
    expect(opened).toEqual([]);
    const id = await send({ name: 'report.pdf' });
    await answerOf('ada', id);
    await new Promise((r) => setTimeout(r, 50));
    expect(writesOf('ada', id)).toBe(1);
  });

  it('audits the kind of source and how it ended, never a name or a title', async () => {
    await ask({ name: 'raft paper' });
    await ask({ name: 'The Secret Title Nobody Has' });
    const lines = audit().filter((l) => String(l.operation).startsWith('doc_open'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatchObject({ operation: 'doc_open', sourceGroup: 'ada', isMain: false, kind: 'existing', ok: true });
    expect(JSON.stringify(lines)).not.toMatch(/Secret|Raft|report/);
  });
});
