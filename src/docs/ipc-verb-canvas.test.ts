import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOC_FAILED, _resetDocOpens, startDocOpen } from './ipc-verb.js';
import type { DocVerbEnv, DocVerbInput } from './ipc-verb.js';
import type { CanvasFilesResult, DocMeta, DocOpenResult, DocsApi } from './types.js';

// The text agent's `show_document` for a Canvas file (docs/COURSE_DOCS.md, "Canvas files"): the host looks at the course's Canvas files only when nothing of the student's matched the name, opens the one it found
// through `openCanvasFile` (the host downloads it), leaves the card, and logs the kind of source, never a name.

const meta = (n: number, title: string, origin: DocMeta['origin'] = 'upload', pages = 12): DocMeta => ({ id: n.toString(16).padStart(32, '0'), title, pages, origin, createdAt: n, bytes: 100 });
const KEPT = [meta(1, 'Raft paper'), meta(2, 'Raft slides')];
const CANVAS: CanvasFilesResult = {
  ok: true,
  files: [
    { id: 41, name: 'Homework 5 spec.pdf', kind: 'pdf', size: 1000 },
    { id: 42, name: 'Syllabus.pdf', kind: 'pdf', size: 1000 },
  ],
};

let uploadsRoot: string;
beforeEach(() => {
  uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-verb-canvas-'));
});
afterEach(() => {
  _resetDocOpens();
  fs.rmSync(uploadsRoot, { recursive: true, force: true });
});

function fakeDocs(over: Record<string, unknown> = {}) {
  return {
    open: vi.fn(async () => ({ ok: true, doc: KEPT[0], page: 1 }) as DocOpenResult),
    openCanvasFile: vi.fn(async (_who: { folder: string }, id: number) => ({ ok: true, doc: meta(9, id === 41 ? 'Homework 5 spec' : 'Syllabus', 'canvas', 4), page: 1 }) as DocOpenResult),
    canvasFiles: vi.fn(async () => CANVAS),
    list: vi.fn(() => KEPT),
    library: () => [],
    searchLibrary: () => [],
    meta: () => null,
    words: () => null,
    text: () => null,
    pageFile: () => null,
    ready: async () => true,
    reap: async () => 0,
    ...over,
  } as unknown as DocsApi & { open: ReturnType<typeof vi.fn>; openCanvasFile: ReturnType<typeof vi.fn>; canvasFiles: ReturnType<typeof vi.fn> };
}

function harness(docs: DocsApi) {
  const said: Array<{ id: string; ok: boolean; message: string }> = [];
  const audits: Array<{ operation: string; fields: Record<string, unknown> }> = [];
  const cards: Array<{ folder: string; obj: unknown }> = [];
  const env: DocVerbEnv = {
    docs,
    uploadsDir: () => uploadsRoot,
    say: (id, ok, message) => void said.push({ id, ok, message }),
    audit: (operation, fields) => void audits.push({ operation, fields }),
    postObject: (folder, obj) => void cards.push({ folder, obj }),
    log: { warn: vi.fn() },
  };
  return { env, said, audits, cards };
}
const input = (name: string, over: Partial<DocVerbInput> = {}): DocVerbInput => ({ folder: 'ada', isMain: false, requestId: 'req-00000001', request: { name }, group: {}, ...over });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('a name that is a Canvas file', () => {
  it('is opened through the host\'s own listing and download, with the card of a canvas document and the model told it is in the chat', async () => {
    const docs = fakeDocs();
    const h = harness(docs);
    startDocOpen(input('homework 5 spec', { request: { name: 'homework 5 spec', page: 2 } }), h.env);
    await flush();
    expect(docs.canvasFiles).toHaveBeenCalledTimes(1);
    expect(docs.openCanvasFile).toHaveBeenCalledWith({ folder: 'ada' }, 41);
    expect(docs.open).not.toHaveBeenCalled();
    expect(h.cards).toEqual([{ folder: 'ada', obj: { t: 'doc', doc: meta(9, 'x').id, title: 'Homework 5 spec', pages: 4, page: 2, origin: 'canvas' } }]);
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toMatchObject({ id: 'req-00000001', ok: true });
    expect(h.said[0].message).toContain('Homework 5 spec');
    expect(h.audits.find((a) => a.operation === 'doc_open')?.fields).toMatchObject({ kind: 'canvas', ok: true, pages: 4 });
    expect(JSON.stringify(h.audits)).not.toMatch(/Homework|spec/i); // the kind of source, never a name
  });

  it('is looked for only when nothing of the student\'s matched: a document they have is opened without asking Canvas', async () => {
    const docs = fakeDocs();
    const h = harness(docs);
    startDocOpen(input('raft paper'), h.env);
    await flush();
    expect(docs.canvasFiles).not.toHaveBeenCalled();
    expect(docs.open).toHaveBeenCalledTimes(1);
    expect(docs.openCanvasFile).not.toHaveBeenCalled();
  });

  it('is not looked for when several of the student\'s own fit: the model is told which and asks', async () => {
    const docs = fakeDocs();
    const h = harness(docs);
    startDocOpen(input('raft'), h.env);
    await flush();
    expect(docs.canvasFiles).not.toHaveBeenCalled();
    expect(h.said[0]).toMatchObject({ ok: false });
    expect(h.said[0].message).toContain('Several prepared documents match');
    expect(h.cards).toEqual([]);
  });

  it('says what there is when nothing matches, the course\'s files on Canvas among it, and does not open anything', async () => {
    const docs = fakeDocs();
    const h = harness(docs);
    startDocOpen(input('quantum computing'), h.env);
    await flush();
    expect(h.said[0]).toMatchObject({ ok: false });
    expect(h.said[0].message).toContain('Nothing matches that name');
    expect(h.said[0].message).toContain('"Homework 5 spec.pdf"');
    expect(docs.openCanvasFile).not.toHaveBeenCalled();
    expect(h.audits.find((a) => a.operation === 'doc_open')?.fields).toMatchObject({ kind: 'none', ok: false, reason: 'not-found' });
  });

  it('says that Canvas could not be looked at when it did not answer, after the hint', async () => {
    const docs = fakeDocs({ canvasFiles: vi.fn(async () => ({ ok: false, message: 'Canvas did not answer just now, so the course files could not be looked at. Say so in one short sentence.' })) });
    const h = harness(docs);
    startDocOpen(input('quantum computing'), h.env);
    await flush();
    expect(h.said[0].ok).toBe(false);
    expect(h.said[0].message).toMatch(/Nothing matches that name\..*Canvas did not answer just now/);
  });

  it('is told as it is when the host could not give the file: the host\'s sentence, no card', async () => {
    const docs = fakeDocs({ openCanvasFile: vi.fn(async () => ({ ok: false, reason: 'limit', message: 'Not opened: 6 files from Canvas in ten minutes is the most for one student.' }) as DocOpenResult) });
    const h = harness(docs);
    startDocOpen(input('syllabus'), h.env);
    await flush();
    expect(h.said[0]).toEqual({ id: 'req-00000001', ok: false, message: 'Not opened: 6 files from Canvas in ten minutes is the most for one student.' });
    expect(h.cards).toEqual([]);
    expect(h.audits.find((a) => a.operation === 'doc_open')?.fields).toMatchObject({ kind: 'canvas', ok: false, reason: 'limit' });
  });

  it('is a failure of the service, not of the student\'s file, when the host has a listing but no way to open from it', async () => {
    const docs = fakeDocs({ openCanvasFile: undefined });
    const h = harness(docs);
    startDocOpen(input('syllabus'), h.env);
    await flush();
    expect(h.said[0]).toEqual({ id: 'req-00000001', ok: false, message: DOC_FAILED });
  });

  it('does not exist for a host without a Canvas source: the answer is what it always was', async () => {
    const docs = fakeDocs({ canvasFiles: undefined, openCanvasFile: undefined });
    const h = harness(docs);
    startDocOpen(input('syllabus'), h.env);
    await flush();
    expect(h.said[0].ok).toBe(false);
    expect(h.said[0].message).not.toContain('Canvas');
  });
});
