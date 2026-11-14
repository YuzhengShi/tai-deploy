import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasFilesResult, DocMeta, DocOpenResult, DocsApi } from '../docs/types.js';
import { CompetencyGuard } from './competency.js';
import type { FunctionEnv } from './functions.js';
import { newScreenState, showDocument } from './screen.js';
import { silentLog } from './types.js';

// `show_document` in a call for a file of the course's Canvas (docs/COURSE_DOCS.md, "Canvas files"): looked for only when nothing of the student's matches the name; opened through the host's own listing and
// download; the same early "preparing" answer as any document that takes long; one card for it in the call.

const MADE: DocMeta = { id: 'e'.repeat(32), title: 'Day 4 ACID 2PC and Consensus', pages: 60, origin: 'canvas', createdAt: 1, bytes: 10 };
const OWN: DocMeta = { id: 'a'.repeat(32), title: 'Raft slides', pages: 32, origin: 'upload', createdAt: 1, bytes: 10 };
const LISTING: CanvasFilesResult = { ok: true, files: [{ id: 41, name: 'Day 4 ACID 2PC and Consensus.pdf', kind: 'pdf', size: 1000 }] };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-canvas-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeDocs(over: Record<string, unknown> = {}) {
  const docs = {
    list: () => [] as DocMeta[],
    library: () => [] as DocMeta[],
    searchLibrary: () => [],
    meta: (_folder: string, id: string) => (id === MADE.id ? MADE : id === OWN.id ? OWN : null),
    words: () => null,
    text: () => null,
    pageFile: () => null,
    ready: async () => true,
    reap: async () => 0,
    open: vi.fn(async () => ({ ok: true, doc: OWN, page: 1 }) as DocOpenResult),
    canvasFiles: vi.fn(async () => LISTING),
    openCanvasFile: vi.fn(async () => ({ ok: true, doc: MADE, page: 1 }) as DocOpenResult),
    ...over,
  };
  return docs as unknown as DocsApi & { open: ReturnType<typeof vi.fn>; canvasFiles: ReturnType<typeof vi.fn>; openCanvasFile: ReturnType<typeof vi.fn> };
}

function rig(docs: DocsApi, over: Partial<FunctionEnv> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const cards: unknown[] = [];
  const env: FunctionEnv = {
    folder: 'ana',
    jid: 'web:ana',
    groupDir: path.join(root, 'groups', 'ana'),
    ipcDir: path.join(root, 'data', 'ipc', 'ana'),
    today: '2026-11-07',
    now: () => Date.now(),
    toolHost: async () => null,
    guard: new CompetencyGuard(),
    log: silentLog,
    docs,
    browserSend: (message) => sent.push(message),
    postObject: (obj) => cards.push(obj),
    screenState: newScreenState(),
    screenPrepareMs: 2_000,
    mode: 'conversational',
    ...over,
  };
  return { env, sent, cards };
}
const json = (text: string): Record<string, any> => JSON.parse(text);

describe('show_document for a Canvas file', () => {
  it('opens a file of the course that nothing of the student\'s matches, through the host\'s listing and download, with one card and the page told to show it', async () => {
    const docs = fakeDocs();
    const r = rig(docs);
    const answer = json(await showDocument({ document: 'day 4 acid', page: 5 }, r.env));
    expect(docs.canvasFiles).toHaveBeenCalledTimes(1);
    expect(docs.openCanvasFile).toHaveBeenCalledWith({ folder: 'ana' }, 41);
    expect(docs.open).not.toHaveBeenCalled();
    expect(r.cards).toEqual([{ t: 'doc', doc: MADE.id, title: 'Day 4 ACID 2PC and Consensus', pages: 60, page: 5, origin: 'canvas' }]);
    expect(r.sent).toEqual([{ type: 'show', doc: MADE.id, page: 5, title: 'Day 4 ACID 2PC and Consensus', pages: 60 }]);
    expect(answer.status).toBe('on their screen');
    expect(JSON.stringify(answer)).toMatch(/in the chat now/);
  });

  it('is opened for a student who has no document at all, no library deck and no attached file (it used to be "they have no document yet")', async () => {
    const docs = fakeDocs();
    const answer = json(await showDocument({ document: 'day 4 acid' }, rig(docs).env));
    expect(answer.status).toBe('on their screen');
    // and where the host has no Canvas source the old sentence stays
    const without = fakeDocs({ canvasFiles: undefined, openCanvasFile: undefined });
    expect(json(await showDocument({ document: 'day 4 acid' }, rig(without).env)).error).toMatch(/they have no document to show yet/);
  });

  it('is not looked for when a document of the student\'s matches: Canvas is not asked', async () => {
    const docs = fakeDocs({ list: () => [OWN] });
    const r = rig(docs);
    const answer = json(await showDocument({ document: 'raft slides' }, r.env));
    expect(answer.status).toBe('on their screen');
    expect(docs.canvasFiles).not.toHaveBeenCalled();
    expect(docs.open).toHaveBeenCalledTimes(1);
  });

  it('answers with what there is when nothing matches, and says Canvas could not be looked at when it did not answer', async () => {
    const docs = fakeDocs({ canvasFiles: vi.fn(async () => ({ ok: false, message: 'Canvas did not answer just now, so the course files could not be looked at. Say so in one short sentence.' })) });
    const answer = json(await showDocument({ document: 'quantum computing' }, rig(docs).env));
    expect(answer.error).toMatch(/could not tell which document/);
    expect(answer.their_documents).toContain('Canvas did not answer just now');
    expect(docs.openCanvasFile).not.toHaveBeenCalled();
    const found = fakeDocs();
    const nothing = json(await showDocument({ document: 'quantum computing' }, rig(found).env));
    expect(nothing.their_documents).toContain('"Day 4 ACID 2PC and Consensus.pdf"');
  });

  it('puts the card in the chat once in a call: the same Canvas file again goes to the page asked for, and is not fetched again', async () => {
    const docs = fakeDocs();
    const r = rig(docs);
    await showDocument({ document: 'day 4 acid', page: 5 }, r.env);
    const again = json(await showDocument({ document: 'day 4 acid', page: 6 }, r.env));
    expect(again.status).toBe('on their screen');
    // (the second open is the host's own: it keeps what it made for this file and does not fetch it again; the card of the call is one)
    expect(r.cards).toHaveLength(1);
    expect(r.sent.map((m) => [m.type, m.page])).toEqual([['show', 5], ['show', 6]]);
  });

  it('is "preparing" at once when the file takes long (the download and the render), and shows itself, with its card, when it is ready', async () => {
    let finish: (r: DocOpenResult) => void = () => undefined;
    const docs = fakeDocs({
      openCanvasFile: vi.fn(
        () =>
          new Promise<DocOpenResult>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const r = rig(docs, { screenPrepareMs: 20 });
    const answer = json(await showDocument({ document: 'day 4 acid' }, r.env));
    expect(answer.status).toBe('preparing');
    expect(r.sent).toEqual([{ type: 'doc_state', state: 'preparing', title: 'Day 4 ACID 2PC and Consensus.pdf' }]);
    expect(r.cards).toEqual([]);
    finish({ ok: true, doc: MADE, page: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.cards).toHaveLength(1);
    expect(r.sent.at(-1)).toMatchObject({ type: 'show', doc: MADE.id, page: 1 });
  });

  it('tells the model what the host said when the file could not be opened', async () => {
    const docs = fakeDocs({ openCanvasFile: vi.fn(async () => ({ ok: false, reason: 'limit', message: 'Not opened: 6 files from Canvas in ten minutes is the most for one student.' }) as DocOpenResult) });
    const r = rig(docs);
    const answer = json(await showDocument({ document: 'day 4 acid' }, r.env));
    expect(answer.error).toContain('6 files from Canvas in ten minutes');
    expect(r.cards).toEqual([]);
    expect(r.sent).toEqual([]);
  });
});
