import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanObject } from '../chat-objects/clean.js';
import { DOC_ALREADY_GOING, DOC_ANSWER_CHARS, DOC_EARLY_MS, DOC_FAILED, DOC_HARD_MS, DOC_NOT_REGISTERED, DOC_NO_NAME, DOC_PREPARING, _resetDocOpens, docOpensInFlight, startDocOpen } from './ipc-verb.js';
import type { DocVerbEnv, DocVerbInput } from './ipc-verb.js';
import { RENDER_NOT_SET_UP } from './render.js';
import type { DocMeta, DocOpenResult, DocsApi } from './types.js';

// The host's side of `show_document` without a database: the order of the checks, the binding to the folder, one request in flight for a folder, exactly one answer for a request, the card, and what is
// logged. (The container's tool is container/agent-runner/test/show-document.test.ts; src/ipc-docs.test.ts has the verb through processTaskIpc and the real answer files.)

const meta = (n: number, title: string, pages = 12): DocMeta => ({ id: n.toString(16).padStart(32, '0'), title, pages, origin: 'upload', createdAt: n, bytes: 100 });
const KEPT = [meta(1, 'Raft paper'), meta(2, 'Lecture 3 notes', 40)];

let uploadsRoot: string;
beforeEach(() => {
  uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-verb-'));
  fs.writeFileSync(path.join(uploadsRoot, 'report.pdf'), 'x');
  fs.writeFileSync(path.join(uploadsRoot, 'notes.txt'), 'x');
});
afterEach(() => {
  _resetDocOpens();
  vi.useRealTimers();
  fs.rmSync(uploadsRoot, { recursive: true, force: true });
});

type OpenFn = (who: { folder: string }, source: unknown) => Promise<DocOpenResult>;
function fakeDocs(open: OpenFn = async (_who, source) => ({ ok: true, doc: (source as { kind: string; id?: string }).kind === 'existing' ? KEPT.find((d) => d.id === (source as { id: string }).id) ?? KEPT[0] : meta(9, 'report', 5), page: 1 })): DocsApi & { open: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(open as never),
    list: vi.fn(() => KEPT),
    library: () => [],
    searchLibrary: () => [],
    meta: () => null,
    words: () => null,
    text: () => null,
    pageFile: () => null,
    ready: async () => true,
    reap: async () => 0,
  } as unknown as DocsApi & { open: ReturnType<typeof vi.fn> };
}

function harness(over: Partial<DocVerbEnv> = {}) {
  const said: Array<{ id: string; ok: boolean; message: string }> = [];
  const audits: Array<{ operation: string; fields: Record<string, unknown> }> = [];
  const cards: Array<{ folder: string; obj: unknown }> = [];
  const log = { warn: vi.fn() };
  const env: DocVerbEnv = {
    docs: fakeDocs(),
    uploadsDir: () => uploadsRoot,
    say: (id, ok, message) => void said.push({ id, ok, message }),
    audit: (operation, fields) => void audits.push({ operation, fields }),
    postObject: (folder, obj) => void cards.push({ folder, obj }),
    log,
    ...over,
  };
  return { env, said, audits, cards, log };
}
const input = (over: Partial<DocVerbInput> = {}): DocVerbInput => ({ folder: 'ada', isMain: false, requestId: 'req-00000001', request: { name: 'Raft paper' }, group: {}, ...over });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('which document is opened, for whom', () => {
  it('opens a document the student has by its title, for the folder of the IPC directory, leaves its card and answers with the document', async () => {
    const h = harness();
    startDocOpen(input(), h.env);
    await flush();
    const docs = h.env.docs as ReturnType<typeof fakeDocs>;
    expect(docs.list).toHaveBeenCalledWith('ada');
    expect(docs.open).toHaveBeenCalledWith({ folder: 'ada' }, { kind: 'existing', id: KEPT[0].id });
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toMatchObject({ id: 'req-00000001', ok: true });
    expect(h.said[0].message).toContain('"Raft paper"');
    expect(h.said[0].message).toContain('(12 pages)');
    expect(h.said[0].message).toContain('at page 1');
    expect(h.said[0].message).toMatch(/card with an Open button/);
    expect(h.cards).toEqual([{ folder: 'ada', obj: { t: 'doc', doc: KEPT[0].id, title: 'Raft paper', pages: 12, page: 1, origin: 'upload' } }]);
    expect(cleanObject(h.cards[0].obj)).not.toBeNull(); // the gate of the chat accepts the card as it is
    expect(h.audits).toEqual([{ operation: 'doc_open', fields: { sourceGroup: 'ada', isMain: false, kind: 'existing', ok: true, pages: 12, late: false } }]);
  });

  it('opens a file the student attached, by the name the host listed itself, however the model wrote it', async () => {
    for (const name of ['report.pdf', 'REPORT.PDF', '/workspace/group/uploads/report.pdf', 'uploads/report.pdf', 'report']) {
      _resetDocOpens();
      const h = harness();
      startDocOpen(input({ request: { name } }), h.env);
      await flush();
      const docs = h.env.docs as ReturnType<typeof fakeDocs>;
      expect(docs.open, name).toHaveBeenCalledWith({ folder: 'ada' }, { kind: 'upload', name: 'report.pdf' });
      expect(h.said[0]).toMatchObject({ ok: true });
    }
  });

  it('never opens anything for a name that is not in the host\'s two lists: it says what there is', async () => {
    for (const name of ['../COMPETENCY.md', 'notes.txt', '/etc/passwd', 'quantum cooking', 'sub/report.pdf']) {
      _resetDocOpens();
      const h = harness();
      startDocOpen(input({ request: { name } }), h.env);
      await flush();
      expect((h.env.docs as ReturnType<typeof fakeDocs>).open, name).not.toHaveBeenCalled();
      expect(h.said[0].ok).toBe(false);
      expect(h.said[0].message).toContain('Prepared documents: "Raft paper", "Lecture 3 notes".');
      expect(h.said[0].message).toContain('Files they attached: report.pdf.');
      expect(h.cards).toEqual([]);
    }
  });

  it('opens at the page that was asked for, kept inside the document, and at page 1 when the page is not a page', async () => {
    const cases: Array<[unknown, number]> = [[5, 5], ['7', 7], [99, 12], [500, 12], [1, 1], [0, 1], [-2, 1], [1.5, 1], ['x', 1], [501, 1], [undefined, 1], [null, 1], [[3], 1]];
    for (const [page, want] of cases) {
      _resetDocOpens();
      const h = harness();
      startDocOpen(input({ request: { name: 'Raft paper', page } }), h.env);
      await flush();
      expect((h.cards[0].obj as { page: number }).page, JSON.stringify(page)).toBe(want);
      expect(h.said[0].message).toContain(`at page ${want}`);
    }
  });

  it('takes the student from the folder alone: nothing in the request names another', async () => {
    const h = harness();
    startDocOpen(input({ request: { name: 'Raft paper', folder: 'bob', student: 'bob', who: { folder: 'bob' }, id: KEPT[1].id, doc: KEPT[1].id } }), h.env);
    await flush();
    const docs = h.env.docs as ReturnType<typeof fakeDocs>;
    expect(docs.list).toHaveBeenCalledWith('ada');
    expect(docs.open).toHaveBeenCalledWith({ folder: 'ada' }, { kind: 'existing', id: KEPT[0].id });
    expect(h.cards.every((c) => c.folder === 'ada')).toBe(true);
  });

  it('says why when the service could not, in its own words, with no card', async () => {
    const h = harness({ docs: fakeDocs(async () => ({ ok: false, reason: 'limit', message: 'Not opened: 6 new documents in ten minutes.' })) });
    startDocOpen(input({ request: { name: 'report.pdf' } }), h.env);
    await flush();
    expect(h.said).toEqual([{ id: 'req-00000001', ok: false, message: 'Not opened: 6 new documents in ten minutes.' }]);
    expect(h.cards).toEqual([]);
    expect(h.audits[0]).toMatchObject({ operation: 'doc_open', fields: { kind: 'upload', ok: false, reason: 'limit' } });
  });
});

describe('the order of the checks', () => {
  it('drops a request with no usable id (nobody could be told) and starts nothing', async () => {
    const h = harness();
    startDocOpen(input({ requestId: null }), h.env);
    await flush();
    expect(h.said).toEqual([]);
    expect((h.env.docs as ReturnType<typeof fakeDocs>).open).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(docOpensInFlight()).toBe(0);
  });

  it('says it is not set up when there is no documents service', async () => {
    const h = harness({ docs: undefined });
    startDocOpen(input(), h.env);
    expect(h.said).toEqual([{ id: 'req-00000001', ok: false, message: RENDER_NOT_SET_UP }]);
  });

  it('refuses a chat that is not registered, and lets the admin chat ask without a registration', async () => {
    const h = harness();
    startDocOpen(input({ group: undefined }), h.env);
    expect(h.said).toEqual([{ id: 'req-00000001', ok: false, message: DOC_NOT_REGISTERED }]);
    const admin = harness();
    startDocOpen(input({ group: undefined, isMain: true, folder: 'main' }), admin.env);
    await flush();
    expect(admin.said[0].ok).toBe(true);
  });

  it('refuses a request that names nothing, whatever else it holds', async () => {
    for (const request of [undefined, null, 7, 'Raft paper', [], {}, { name: '' }, { name: '   ' }, { name: 7 }, { name: '/workspace/group/uploads/' }, { page: 3 }]) {
      _resetDocOpens();
      const h = harness();
      startDocOpen(input({ request }), h.env);
      expect(h.said, JSON.stringify(request)).toEqual([{ id: 'req-00000001', ok: false, message: DOC_NO_NAME }]);
      expect((h.env.docs as ReturnType<typeof fakeDocs>).open).not.toHaveBeenCalled();
      expect(docOpensInFlight()).toBe(0);
    }
  });
});

describe('one at a time for a folder, and exactly one answer', () => {
  it('answers a second request for the same folder at once, and lets a folder go when its request is over; another folder is not held', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ docs: fakeDocs(async () => (await gate, { ok: true, doc: meta(9, 'report', 5), page: 1 })) });
    startDocOpen(input({ request: { name: 'report.pdf' } }), h.env);
    await flush();
    expect(docOpensInFlight()).toBe(1);
    startDocOpen(input({ requestId: 'req-00000002', request: { name: 'report.pdf' } }), h.env);
    expect(h.said).toEqual([{ id: 'req-00000002', ok: false, message: DOC_ALREADY_GOING }]);
    startDocOpen(input({ folder: 'bob', requestId: 'req-00000003', request: { name: 'report.pdf' } }), h.env);
    await flush();
    expect(docOpensInFlight()).toBe(2);
    release();
    await flush();
    expect(docOpensInFlight()).toBe(0);
    expect(h.said.filter((s) => s.ok).map((s) => s.id).sort()).toEqual(['req-00000001', 'req-00000003']);
    startDocOpen(input({ requestId: 'req-00000004', request: { name: 'Raft paper' } }), h.env);
    await flush();
    expect(h.said.at(-1)).toMatchObject({ id: 'req-00000004', ok: true });
  });

  it('answers "being prepared" when the work takes longer than the early time, keeps the folder until it is done, and then still leaves the card without answering twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness({ earlyMs: 20, docs: fakeDocs(async () => (await gate, { ok: true, doc: meta(9, 'report', 5), page: 1 })) });
    startDocOpen(input({ request: { name: 'report.pdf' } }), h.env);
    await vi.waitFor(() => expect(h.said).toHaveLength(1));
    expect(h.said[0]).toEqual({ id: 'req-00000001', ok: true, message: DOC_PREPARING });
    expect(DOC_PREPARING).toMatch(/card with an Open button/);
    expect(DOC_PREPARING).toMatch(/do not call show_document for it again/);
    expect(h.cards).toEqual([]);
    expect(docOpensInFlight()).toBe(1); // still being prepared: another request for the folder is held off
    startDocOpen(input({ requestId: 'req-00000002' }), h.env);
    expect(h.said.at(-1)).toEqual({ id: 'req-00000002', ok: false, message: DOC_ALREADY_GOING });
    release();
    await vi.waitFor(() => expect(h.cards).toHaveLength(1));
    expect(h.cards[0].obj).toMatchObject({ t: 'doc', title: 'report', pages: 5 });
    expect(h.said.filter((s) => s.id === 'req-00000001')).toHaveLength(1);
    expect(docOpensInFlight()).toBe(0);
    expect(h.audits.map((a) => a.fields.early ?? a.fields.late)).toEqual([true, true]);
  });

  it('lets the folder go when the service never answers, and answers for it if nobody has', async () => {
    const h = harness({ hardMs: 30, earlyMs: 1000, docs: fakeDocs(() => new Promise<never>(() => undefined)) });
    startDocOpen(input({ request: { name: 'report.pdf' } }), h.env);
    await flush();
    expect(docOpensInFlight()).toBe(1);
    await vi.waitFor(() => expect(h.said).toHaveLength(1));
    expect(h.said[0]).toEqual({ id: 'req-00000001', ok: false, message: DOC_FAILED });
    expect(docOpensInFlight()).toBe(0);
    expect(h.log.warn).toHaveBeenCalledWith({ folder: 'ada' }, 'doc_open: the documents service did not answer in time: let the folder go');
  });

  it('answers once and frees the folder when the service throws, rejects or returns nonsense', async () => {
    for (const open of [
      (() => {
        throw new Error('boom');
      }) as OpenFn,
      (async () => {
        throw new Error('boom');
      }) as OpenFn,
      (async () => undefined) as unknown as OpenFn,
      (async () => ({ ok: true })) as unknown as OpenFn,
    ]) {
      const h = harness({ docs: fakeDocs(open) });
      startDocOpen(input({ request: { name: 'report.pdf' } }), h.env);
      await flush();
      expect(h.said, String(open)).toEqual([{ id: 'req-00000001', ok: false, message: DOC_FAILED }]);
      expect(docOpensInFlight()).toBe(0);
      expect(h.cards).toEqual([]);
    }
  });

  it('is not held up by a log or an answer that fails', async () => {
    const h = harness({
      say: () => {
        throw new Error('disk full');
      },
      audit: () => {
        throw new Error('no log');
      },
    });
    startDocOpen(input(), h.env);
    await flush();
    expect(docOpensInFlight()).toBe(0);
    expect(h.cards).toHaveLength(1);
    expect(h.log.warn.mock.calls.map(([, m]) => m)).toContain('doc_open: the answer could not be written');
  });

  it('does not tell the model the document is in the chat when the card was not written: a chat that refuses the card, or no way to leave one', async () => {
    const refusing = harness({
      postObject: () => {
        throw new Error('the chat did not take the card');
      },
    });
    startDocOpen(input(), refusing.env);
    await flush();
    expect(refusing.said).toHaveLength(1);
    expect(refusing.said[0].ok).toBe(false);
    expect(refusing.said[0].message).toContain('"Raft paper" was prepared, but the chat did not take its card');
    expect(refusing.said[0].message).not.toMatch(/is in the chat now/);
    expect(refusing.audits[0].fields).toMatchObject({ ok: false, reason: 'no-card' });
    expect(refusing.log.warn).toHaveBeenCalledWith(expect.objectContaining({ folder: 'ada' }), 'doc_open: the card could not be left');
    expect(docOpensInFlight()).toBe(0);
    const none = harness({ postObject: undefined });
    startDocOpen(input({ requestId: 'req-00000002' }), none.env);
    await flush();
    expect(none.said[0]).toMatchObject({ ok: false });
    expect(none.said[0].message).toContain('did not take its card');
  });

  it('cuts the answer to the number the container reads, and the two numbers are the ones the tool waits for', () => {
    const h = harness({ docs: fakeDocs(async () => ({ ok: false, reason: 'failed', message: 'x'.repeat(DOC_ANSWER_CHARS + 500) })) });
    startDocOpen(input({ request: { name: 'report.pdf' } }), h.env);
    return flush().then(() => {
      expect(h.said[0].message).toHaveLength(DOC_ANSWER_CHARS);
      expect(DOC_EARLY_MS).toBe(22_000);
      expect(DOC_HARD_MS).toBeGreaterThan(150_000 + 30_000 + 25_000); // an Office render's clock, its queue and the guard
    });
  });
});

describe('what is logged', () => {
  it('is the kind of source and how it ended, never a name or a title', async () => {
    const h = harness({ docs: fakeDocs(async () => ({ ok: false, reason: 'bad-file', message: 'That file is not a PDF.' })) });
    startDocOpen(input({ request: { name: 'report.pdf' } }), h.env);
    await flush();
    const text = JSON.stringify([h.audits, h.log.warn.mock.calls]);
    expect(text).not.toContain('report');
    expect(h.audits).toHaveLength(1);
    const unknown = harness();
    startDocOpen(input({ request: { name: 'The Secret Title Nobody Has' } }), unknown.env);
    await flush();
    expect(JSON.stringify(unknown.audits)).not.toContain('Secret');
  });
});

describe('a deck of the course library', () => {
  const LIB: DocMeta = { id: 'f'.repeat(32), title: 'Week 5 - Raft', pages: 32, origin: 'course', createdAt: 5, bytes: 100 };
  const LIB2: DocMeta = { id: 'e'.repeat(32), title: 'Week 5 - Raft extras', pages: 8, origin: 'course', createdAt: 6, bytes: 100 };
  const withLibrary = (decks: DocMeta[], own: DocMeta[] = []) => {
    const docs = fakeDocs(async (_who, source) => ({ ok: true, doc: decks.concat(own).find((d) => d.id === (source as { id: string }).id) ?? decks[0], page: 1 }));
    docs.list = vi.fn(() => own);
    (docs as unknown as { library: () => DocMeta[] }).library = () => decks;
    return docs;
  };

  it('is opened by its title for a student who has nothing of their own, at the page asked for, with a card that says it is the course\'s', async () => {
    const docs = withLibrary([LIB]);
    const h = harness({ docs });
    startDocOpen(input({ request: { name: 'week 5 raft', page: 7 } }), h.env);
    await flush();
    expect(docs.open).toHaveBeenCalledWith({ folder: 'ada' }, { kind: 'existing', id: LIB.id });
    expect(h.cards).toEqual([{ folder: 'ada', obj: { t: 'doc', doc: LIB.id, title: 'Week 5 - Raft', pages: 32, page: 7, origin: 'course' } }]);
    expect(cleanObject(h.cards[0].obj)).not.toBeNull();
    expect(h.said[0]).toMatchObject({ ok: true });
    expect(h.said[0].message).toContain('"Week 5 - Raft" (32 pages)');
  });

  it('does not guess between two decks that fit: it says which, and opens nothing', async () => {
    const docs = withLibrary([LIB, LIB2]);
    const h = harness({ docs });
    startDocOpen(input({ request: { name: 'raft' } }), h.env);
    await flush();
    expect(docs.open).not.toHaveBeenCalled();
    expect(h.said[0].ok).toBe(false);
    expect(h.said[0].message).toContain('"Week 5 - Raft", "Week 5 - Raft extras"');
    expect(h.said[0].message).toMatch(/Ask which one they mean/);
    expect(h.cards).toEqual([]);
  });

  it('is listed after the student\'s own documents when the name matches none, and an exact title is that deck even when another contains it', async () => {
    const own = [meta(1, 'My report')];
    const h = harness({ docs: withLibrary([LIB, LIB2], own) });
    startDocOpen(input({ request: { name: 'quantum cooking' } }), h.env);
    await flush();
    expect(h.said[0].message).toContain('Prepared documents: "My report", "Week 5 - Raft", "Week 5 - Raft extras".');
    _resetDocOpens();
    const exact = harness({ docs: withLibrary([LIB, LIB2], own) });
    startDocOpen(input({ request: { name: 'Week 5 - Raft' } }), exact.env);
    await flush();
    expect((exact.env.docs as ReturnType<typeof fakeDocs>).open).toHaveBeenCalledWith({ folder: 'ada' }, { kind: 'existing', id: LIB.id });
  });

  it('is simply not there for a service that has no library, which is what the older ones are', async () => {
    const h = harness();
    startDocOpen(input({ request: { name: 'week 5 raft' } }), h.env);
    await flush();
    expect(h.said[0].ok).toBe(false);
    expect(h.said[0].message).toContain('Prepared documents: "Raft paper", "Lecture 3 notes".');
  });
});
