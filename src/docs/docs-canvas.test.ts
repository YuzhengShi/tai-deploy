import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { CanvasSource } from './canvas-source.js';
import { DOCS_CANVAS_NO_FILE, DOCS_CANVAS_RATE_10MIN, DOCS_CANVAS_RATE_DAY, DOCS_NOT_A_STUDENT, DOCS_STUDENT_BUSY, createDocs } from './docs.js';
import type { DocsDeps } from './docs.js';
import { DocStore } from './store.js';
import { ALPHA_WORDS, FakeDocker, pdfBytes, png, writeOutput } from './testing/harness.js';
import { DOC_LIMITS } from './types.js';
import type { CanvasFileInfo, DocOpenResult, DocsApi } from './types.js';

// A file of the course's Canvas as a student's own document (docs/COURSE_DOCS.md, "Canvas files"): the host downloads it by an id of its own listing, and it is prepared like any file. A fake Canvas source
// and the fake renderer: no network, no container.

const ANA = `s_${'a1'.repeat(10)}`;
const BOB = `s_${'b2'.repeat(10)}`;

let root: string;
let docker: FakeDocker;
let clock: number;
type LogFn = (fields: Record<string, unknown>, message: string) => void;
let log: { info: Mock<LogFn>; warn: Mock<LogFn>; debug: Mock<LogFn> };

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const ok = (r: DocOpenResult) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error('not ok');
  return r;
};

/** A Canvas source holding some files: `bytes` is what a download gives (null: Canvas did not give it). */
function fakeCanvas(files: CanvasFileInfo[], bytes: (id: number) => Buffer | null) {
  const downloads: number[] = [];
  const source: CanvasSource = {
    list: async () => ({ ok: true, files }),
    download: async (id) => {
      downloads.push(id);
      const b = bytes(id);
      return b ? { ok: true, bytes: b } : { ok: false, message: 'Canvas did not give that file just now. Say so in one short sentence and try again in a minute.' };
    },
  };
  return { source, downloads };
}
const info = (id: number, name: string, size = 1000): CanvasFileInfo => ({ id, name, kind: 'pdf', size });

function build(canvas: CanvasSource | undefined, over: Partial<DocsDeps> = {}): DocsApi {
  return createDocs({
    dir: path.join(root, 'data', 'docs'),
    storeDir: path.join(root, 'store'),
    uploadsDir: (folder) => path.join(root, 'groups', folder, 'uploads'),
    log,
    docker,
    hostUser: { uid: 1000, gid: 1000 },
    now: () => clock,
    ...(canvas ? { canvas } : {}),
    ...over,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-canvas-'));
  docker = new FakeDocker();
  clock = Date.now();
  log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  docker.behave = async (ctl) => {
    writeOutput(ctl.outDir, 3, { inFile: 3 });
    return { exitCode: 0 };
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('without a Canvas source', () => {
  it('has no Canvas methods at all: a name that is not the student\'s is simply not found', () => {
    const docs = build(undefined);
    expect(docs.canvasFiles).toBeUndefined();
    expect(docs.openCanvasFile).toBeUndefined();
  });
});

describe('the listing', () => {
  it('is the source\'s, and is "Canvas did not answer" when the source fails: it never throws', async () => {
    const f = fakeCanvas([info(41, 'Day 4.pdf')], () => pdfBytes());
    expect(await build(f.source).canvasFiles!()).toEqual({ ok: true, files: [info(41, 'Day 4.pdf')] });
    const broken: CanvasSource = {
      list: async () => {
        throw new Error('boom');
      },
      download: async () => ({ ok: false, message: 'no' }),
    };
    const r = await build(broken).canvasFiles!();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/Canvas did not answer/);
  });
});

describe('opening a Canvas file', () => {
  it('downloads it on the host, prepares it as the student\'s own document with the origin canvas, and keeps it for them', async () => {
    const bytes = pdfBytes(300, 7);
    const f = fakeCanvas([info(41, 'Day_4 ACID 2PC.pdf')], () => bytes);
    const docs = build(f.source);
    const r = ok(await docs.openCanvasFile!({ folder: ANA }, 41));
    expect(r.doc).toMatchObject({ title: 'Day 4 ACID 2PC', pages: 3, origin: 'canvas' });
    expect(r.page).toBe(1);
    expect(f.downloads).toEqual([41]);
    expect(docker.specs).toHaveLength(1);
    expect(docs.list(ANA).map((d) => d.id)).toEqual([r.doc.id]);
    expect(docs.meta(ANA, r.doc.id)).toEqual(r.doc);
    expect(docs.meta(BOB, r.doc.id)).toBeNull(); // the student's own, nobody else's
  });

  it('is the same document the next time: no second download, no second render, whatever the student asks', async () => {
    const f = fakeCanvas([info(41, 'Day 4.pdf')], () => pdfBytes(300, 7));
    const docs = build(f.source);
    const first = ok(await docs.openCanvasFile!({ folder: ANA }, 41));
    const again = ok(await docs.openCanvasFile!({ folder: ANA }, 41));
    expect(again.doc.id).toBe(first.doc.id);
    expect(f.downloads).toEqual([41]);
    expect(docker.specs).toHaveLength(1);
    // another student has their own: it is downloaded for them once
    const bobs = ok(await docs.openCanvasFile!({ folder: BOB }, 41));
    expect(bobs.doc.id).not.toBe(first.doc.id);
    expect(f.downloads).toEqual([41, 41]);
  });

  it('is the course library\'s deck when the bytes are one of its decks: nothing is prepared again and no render is counted', async () => {
    const bytes = pdfBytes(300, 9);
    const store = new DocStore(path.join(root, 'store'), { now: () => clock });
    const page = { image: png(), ext: 'png' as const, words: { words: ALPHA_WORDS, lines: [[0, 2], [3, 5]] as Array<[number, number]> } };
    const stored = store.commitLibrary({ title: 'Day 4 - ACID, 2PC and Consensus', week: 4, sourceName: 'Day 4.pdf', sha256: sha(bytes), pages: [page, page, page] });
    if (!stored.ok) throw new Error('not added');
    const f = fakeCanvas([info(41, 'Day 4.pdf')], () => bytes);
    const docs = build(f.source);
    const r = ok(await docs.openCanvasFile!({ folder: ANA }, 41));
    expect(r.doc).toMatchObject({ id: stored.entry.id, title: 'Day 4 - ACID, 2PC and Consensus', origin: 'course' });
    expect(docker.specs).toHaveLength(0);
    expect(docs.list(ANA)).toEqual([]); // nothing of the student's own was made
    expect(f.downloads).toEqual([41]); // (the bytes had to be fetched to know they are the deck's)
  });

  it('is refused in words for what is not a student, an id the listing does not have, and a listing that is not there', async () => {
    const f = fakeCanvas([info(41, 'Day 4.pdf')], () => pdfBytes());
    const docs = build(f.source);
    for (const folder of ['', '../x', 'groups', 's_short']) expect(await docs.openCanvasFile!({ folder }, 41), folder).toMatchObject({ ok: false, reason: 'not-found', message: DOCS_NOT_A_STUDENT });
    for (const id of [42, 0, -3, 2.5, Number.NaN]) expect(await docs.openCanvasFile!({ folder: ANA }, id), String(id)).toMatchObject({ ok: false, reason: 'not-found', message: DOCS_CANVAS_NO_FILE });
    expect(f.downloads).toEqual([]);
    const down: CanvasSource = { list: async () => ({ ok: false, message: 'Canvas did not answer just now. Say so in one short sentence.' }), download: async () => ({ ok: false, message: 'x' }) };
    expect(await build(down).openCanvasFile!({ folder: ANA }, 41)).toEqual({ ok: false, reason: 'failed', message: 'Canvas did not answer just now. Say so in one short sentence.' });
  });

  it('says what Canvas said when the download fails, keeps nothing, and a failed download does not use up the student\'s share', async () => {
    const files = [info(100, 'Broken.pdf'), ...Array.from({ length: 8 }, (_, i) => info(200 + i, `Good ${i}.pdf`))];
    const f = fakeCanvas(files, (id) => (id === 100 ? null : pdfBytes(100 + id, id % 200)));
    const docs = build(f.source);
    for (let i = 0; i < DOC_LIMITS.opensPer10Min + 2; i++) {
      const r = await docs.openCanvasFile!({ folder: ANA }, 100);
      expect(r).toMatchObject({ ok: false, reason: 'failed' });
      expect(!r.ok && r.message).toContain('Canvas did not give that file');
    }
    expect(docs.list(ANA)).toEqual([]);
    ok(await docs.openCanvasFile!({ folder: ANA }, 200)); // not told "too many"
  });
});

describe('how many files a student may fetch from Canvas', () => {
  it('is six in ten minutes: the seventh is told so before anything is fetched, and the clock gives them back', async () => {
    const files = Array.from({ length: 8 }, (_, i) => info(300 + i, `File ${i}.pdf`));
    const f = fakeCanvas(files, (id) => pdfBytes(100 + id, id % 250));
    const docs = build(f.source);
    for (let i = 0; i < DOC_LIMITS.opensPer10Min; i++) ok(await docs.openCanvasFile!({ folder: ANA }, 300 + i));
    const seventh = await docs.openCanvasFile!({ folder: ANA }, 306);
    expect(seventh).toEqual({ ok: false, reason: 'limit', message: DOCS_CANVAS_RATE_10MIN });
    expect(f.downloads).toHaveLength(DOC_LIMITS.opensPer10Min);
    // a file they opened already still opens (no download)
    ok(await docs.openCanvasFile!({ folder: ANA }, 300));
    expect(f.downloads).toHaveLength(DOC_LIMITS.opensPer10Min);
    clock += 11 * 60_000;
    ok(await docs.openCanvasFile!({ folder: ANA }, 306));
  });

  it('is twenty a day, and the day is said first', async () => {
    const files = Array.from({ length: DOC_LIMITS.opensPerDay + 2 }, (_, i) => info(500 + i, `Day file ${i}.pdf`));
    const f = fakeCanvas(files, (id) => pdfBytes(100 + id, id % 250));
    const docs = build(f.source);
    let made = 0;
    while (made < DOC_LIMITS.opensPerDay) {
      const r = await docs.openCanvasFile!({ folder: ANA }, 500 + made);
      if (!r.ok) {
        // the ten minutes' limit: let them pass, as a student who waits would
        expect(r.reason).toBe('limit');
        clock += 11 * 60_000;
        continue;
      }
      made++;
    }
    const next = await docs.openCanvasFile!({ folder: ANA }, 500 + made);
    expect(next).toEqual({ ok: false, reason: 'limit', message: DOCS_CANVAS_RATE_DAY });
  });

  it('is one at a time for a student: while a render of theirs goes on, a Canvas file is told "busy" at once, with no download', async () => {
    let release: () => void = () => undefined;
    docker.behave = async (ctl) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      writeOutput(ctl.outDir, 3, { inFile: 3 });
      return { exitCode: 0 };
    };
    const f = fakeCanvas([info(41, 'One.pdf'), info(42, 'Two.pdf')], (id) => pdfBytes(100 + id, id));
    const docs = build(f.source);
    const first = docs.openCanvasFile!({ folder: ANA }, 41);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await docs.openCanvasFile!({ folder: ANA }, 42)).toEqual({ ok: false, reason: 'busy', message: DOCS_STUDENT_BUSY });
    expect(f.downloads).toEqual([41]);
    release();
    ok(await first);
  });
});

describe('what the service keeps in its log', () => {
  it('says that a Canvas file was opened and how it ended, never its name or its title', async () => {
    const f = fakeCanvas([info(41, 'Confidential syllabus draft.pdf')], () => pdfBytes(300, 3));
    const docs = build(f.source);
    ok(await docs.openCanvasFile!({ folder: ANA }, 41));
    await docs.openCanvasFile!({ folder: ANA }, 999);
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    expect(logged).toContain('canvas');
    expect(logged).not.toMatch(/Confidential|syllabus/i);
  });
});
