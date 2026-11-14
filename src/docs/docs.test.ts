import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import {
  DOCS_BUSY,
  DOCS_EMPTY,
  DOCS_NOT_A_PDF,
  DOCS_NOT_A_STUDENT,
  DOCS_NO_DOC,
  DOCS_NO_ROOM,
  DOCS_NO_UPLOAD,
  DOCS_OFF,
  DOCS_OLD_OFFICE,
  DOCS_RATE_10MIN,
  DOCS_RATE_DAY,
  DOCS_STUDENT_BUSY,
  DOCS_TOO_BIG_FILE,
  DOC_GATE,
  createDocs,
  kindOfBytes,
  looksLikeOldOffice,
  titleFrom,
} from './docs.js';
import type { DocsDeps } from './docs.js';
import { RENDER_FAILED } from './render.js';
import { DocStore } from './store.js';
import { ALPHA_WORDS, FakeDocker, pdfBytes, png, writeOutput } from './testing/harness.js';
import { DOC_LIMITS } from './types.js';
import type { DocOpenResult, DocsApi } from './types.js';

const ANA = `s_${'a1'.repeat(10)}`;
const BOB = `s_${'b2'.repeat(10)}`;

let root: string;
let docker: FakeDocker;
let clock: number;
type LogFn = (fields: Record<string, unknown>, message: string) => void;
let log: { info: Mock<LogFn>; warn: Mock<LogFn>; debug: Mock<LogFn> };
let docs: DocsApi;

const uploads = (folder: string) => path.join(root, 'groups', folder, 'uploads');
function build(over: Partial<DocsDeps> = {}): DocsApi {
  return createDocs({ dir: path.join(root, 'data', 'docs'), storeDir: path.join(root, 'store'), uploadsDir: uploads, log, docker, hostUser: { uid: 1000, gid: 1000 }, now: () => clock, ...over });
}
const attach = (folder: string, name: string, body: Buffer | string): void => {
  fs.mkdirSync(uploads(folder), { recursive: true });
  fs.writeFileSync(path.join(uploads(folder), name), body);
};
const upload = (folder: string, name: string, title?: string) => docs.open({ folder }, { kind: 'upload', name, ...(title ? { title } : {}) });
const runs = () => docker.specs.length;
const ok = (r: DocOpenResult) => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error('not ok');
  return r;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-service-'));
  docker = new FakeDocker();
  clock = Date.now();
  log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  docs = build();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('opening a file the student attached', () => {
  it('prepares it in the renderer, keeps it for the student and answers with the document at page 1', async () => {
    attach(ANA, 'Lecture_3-notes.pdf', pdfBytes());
    docker.behave = async (ctl) => {
      writeOutput(ctl.outDir, 3, { inFile: 3 });
      return { exitCode: 0 };
    };
    const r = ok(await upload(ANA, 'Lecture_3-notes.pdf'));
    expect(r.page).toBe(1);
    expect(r.doc).toMatchObject({ title: 'Lecture 3-notes', pages: 3, origin: 'upload', aspect: 0.7727 });
    expect(docs.meta(ANA, r.doc.id)).toEqual(r.doc);
    expect(docs.list(ANA).map((d) => d.id)).toEqual([r.doc.id]);
    expect(docs.text(ANA, r.doc.id, 1)).toBe('Alpha Beta gamma\nsecond line here');
    expect(docs.words(ANA, r.doc.id, 2)?.words).toHaveLength(6);
    expect(docs.pageFile(ANA, r.doc.id, 3)?.type).toBe('image/png');
    // another student has none of it
    expect(docs.meta(BOB, r.doc.id)).toBeNull();
    expect(docs.list(BOB)).toEqual([]);
    expect(runs()).toBe(1);
    expect(fs.readdirSync(path.join(root, 'data', 'docs'))).toEqual([]); // the run directory is gone
  });

  it('gives the same file the same document, without a render and without using one of the student\'s renders', async () => {
    attach(ANA, 'slides.pdf', pdfBytes());
    attach(ANA, 'copy-of-slides.pdf', pdfBytes());
    const first = ok(await upload(ANA, 'slides.pdf'));
    for (let i = 0; i < 12; i++) expect(ok(await upload(ANA, i % 2 ? 'slides.pdf' : 'copy-of-slides.pdf')).doc.id).toBe(first.doc.id);
    expect(runs()).toBe(1);
    expect(docs.list(ANA)).toHaveLength(1);
    // another student's identical file is their own document
    attach(BOB, 'slides.pdf', pdfBytes());
    expect(ok(await upload(BOB, 'slides.pdf')).doc.id).not.toBe(first.doc.id);
    expect(runs()).toBe(2);
  });

  it('decides what a file is from its bytes, never from its name', async () => {
    attach(ANA, 'really-a-pdf.txt', pdfBytes());
    attach(ANA, 'fake.pdf', 'This is plain text with a .pdf name.');
    attach(ANA, 'deck.pdf', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100, 1)]));
    attach(ANA, 'empty.pdf', '');
    attach(ANA, 'html.pdf', '<html><body>%PDF-1.4</body></html>');
    ok(await upload(ANA, 'really-a-pdf.txt'));
    expect(await upload(ANA, 'fake.pdf')).toEqual({ ok: false, reason: 'bad-file', message: DOCS_NOT_A_PDF });
    ok(await upload(ANA, 'deck.pdf')); // (a zip goes to the container as an Office file: it, not the host, decides what is in it)
    expect(await upload(ANA, 'empty.pdf')).toEqual({ ok: false, reason: 'bad-file', message: DOCS_EMPTY });
    expect(await upload(ANA, 'html.pdf')).toEqual({ ok: false, reason: 'bad-file', message: DOCS_NOT_A_PDF });
    expect(runs()).toBe(2); // the real PDF and the zip reached a container; the text, the empty file and the HTML did not
    expect(docker.specs.map((spec) => spec.args.at(-3))).toEqual(['pdf', 'office']);
    expect(kindOfBytes(pdfBytes())).toBe('pdf');
    expect(kindOfBytes(Buffer.from('%PDF'))).toBe('other');
  });

  it('refuses a file over the size of a source, an upload or bytes alike, with a sentence to say', async () => {
    attach(ANA, 'huge.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(DOC_LIMITS.sourceBytes)]));
    expect(await upload(ANA, 'huge.pdf')).toEqual({ ok: false, reason: 'too-big', message: DOCS_TOO_BIG_FILE });
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(DOC_LIMITS.sourceBytes)]);
    expect(await docs.open({ folder: ANA }, { kind: 'bytes', name: 'huge.pdf', bytes: big, origin: 'canvas' })).toMatchObject({ ok: false, reason: 'too-big' });
    attach(ANA, 'exact.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(DOC_LIMITS.sourceBytes - 9)]));
    ok(await upload(ANA, 'exact.pdf')); // the limit itself is allowed
    expect(runs()).toBe(1);
  });

  it('reads only a name that is one file name of the upload store, with the student\'s own folder as the root: a path, a link and a name from another folder are "not found"', async () => {
    fs.mkdirSync(path.join(root, 'groups', ANA), { recursive: true });
    fs.writeFileSync(path.join(root, 'groups', ANA, 'COMPETENCY.md'), pdfBytes()); // a file beside uploads/ that starts like a PDF
    attach(BOB, 'theirs.pdf', pdfBytes());
    attach(ANA, 'ok.pdf', pdfBytes());
    const noUpload = { ok: false, reason: 'not-found', message: DOCS_NO_UPLOAD };
    for (const name of ['../COMPETENCY.md', '../../' + BOB + '/uploads/theirs.pdf', `/${path.join(root, 'groups', BOB, 'uploads', 'theirs.pdf').replace(/\\/g, '/')}`, 'sub/ok.pdf', 'sub\\ok.pdf', '.hidden.pdf', '..', '.', '', 'ok.pdf\0', 'ok.pdf/', 'a'.repeat(300) + '.pdf', 'missing.pdf']) {
      expect(await upload(ANA, name), JSON.stringify(name)).toEqual(noUpload);
    }
    expect(runs()).toBe(0);
    // a link in uploads/ (the student's agent can make one) is not followed
    const target = path.join(root, 'groups', ANA, 'COMPETENCY.md');
    try {
      fs.symlinkSync(target, path.join(uploads(ANA), 'link.pdf'));
      expect(await upload(ANA, 'link.pdf')).toEqual(noUpload);
    } catch {
      /* a platform that does not let this user make links */
    }
    expect(runs()).toBe(0);
    ok(await upload(ANA, 'ok.pdf'));
  });

  it('says the file is not there when it is not, and not a student when the folder is not a chat folder', async () => {
    expect(await upload(ANA, 'nothing.pdf')).toEqual({ ok: false, reason: 'not-found', message: DOCS_NO_UPLOAD });
    for (const folder of ['', '../x', 'groups', 's_short']) {
      expect(await docs.open({ folder }, { kind: 'upload', name: 'a.pdf' })).toEqual({ ok: false, reason: 'not-found', message: DOCS_NOT_A_STUDENT });
    }
    expect(await docs.open({ folder: ANA }, { kind: 'upload', name: 7 as unknown as string })).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await docs.open({ folder: ANA }, { kind: 'bytes', name: 'x.pdf', bytes: 'text' as unknown as Buffer, origin: 'canvas' })).toMatchObject({ ok: false, reason: 'bad-file' });
    expect(await docs.open({ folder: ANA }, { kind: 'zip' } as never)).toMatchObject({ ok: false, reason: 'bad-file' });
    expect(await docs.open(undefined as never, { kind: 'upload', name: 'a.pdf' })).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('takes bytes the host holds, with the origin and the title it was given', async () => {
    const r = ok(await docs.open({ folder: ANA }, { kind: 'bytes', name: 'ignored-name.pdf', bytes: pdfBytes(300, 5), origin: 'canvas', title: '  Assignment 4:\n the spec  ' }));
    expect(r.doc).toMatchObject({ title: 'Assignment 4: the spec', origin: 'canvas' });
  });
});

describe('opening a document that is kept', () => {
  it('opens one of the student\'s own by its id at once, and another student\'s or a made up id is "not found"', async () => {
    attach(ANA, 'a.pdf', pdfBytes());
    const made = ok(await upload(ANA, 'a.pdf'));
    const again = ok(await docs.open({ folder: ANA }, { kind: 'existing', id: made.doc.id }));
    expect(again).toEqual({ ok: true, doc: made.doc, page: 1 });
    const missing = { ok: false, reason: 'not-found', message: DOCS_NO_DOC };
    expect(await docs.open({ folder: BOB }, { kind: 'existing', id: made.doc.id })).toEqual(missing);
    for (const id of ['0'.repeat(32), '../' + made.doc.id, 'x', made.doc.id.toUpperCase() + 'a', 7 as unknown as string]) expect(await docs.open({ folder: ANA }, { kind: 'existing', id })).toEqual(missing);
    expect(runs()).toBe(1);
  });

  it('marks it as opened, so that the thirty days start again', async () => {
    attach(ANA, 'a.pdf', pdfBytes());
    const made = ok(await upload(ANA, 'a.pdf'));
    const marker = path.join(root, 'store', 'portal', 'docs', ANA, made.doc.id, 'opened');
    expect(fs.existsSync(marker)).toBe(false);
    await docs.open({ folder: ANA }, { kind: 'existing', id: made.doc.id });
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('when it cannot be done', () => {
  it('is "off" without the image, and a render that was not started was not counted', async () => {
    docker.image = false;
    attach(ANA, 'a.pdf', pdfBytes());
    expect(await upload(ANA, 'a.pdf')).toEqual({ ok: false, reason: 'off', message: DOCS_OFF });
    expect(runs()).toBe(0);
    expect(await docs.ready()).toBe(false);
    docker.image = true;
    clock += 31_000;
    expect(await docs.ready()).toBe(true);
    ok(await upload(ANA, 'a.pdf'));
  });

  it('passes on the renderer\'s sentence for a file it cannot use, keeps nothing, and lets the student try again at once', async () => {
    attach(ANA, 'a.pdf', pdfBytes());
    docker.behave = async (ctl) => {
      ctl.write('doc: the file could not be read as a PDF.\n');
      return { exitCode: 2 };
    };
    const r = await upload(ANA, 'a.pdf');
    expect(r).toMatchObject({ ok: false, reason: 'bad-file' });
    expect(docs.list(ANA)).toEqual([]);
    docker.behave = async (ctl) => (writeOutput(ctl.outDir, 1), { exitCode: 0 });
    ok(await upload(ANA, 'a.pdf'));
  });

  it('says the service failed (not the file) when the container cannot run, and when the store cannot keep the document', async () => {
    attach(ANA, 'a.pdf', pdfBytes());
    docker.behave = async () => ({ error: 'no such image' });
    expect(await upload(ANA, 'a.pdf')).toEqual({ ok: false, reason: 'failed', message: expect.stringContaining('could not prepare that file') });
    docker.behave = async (ctl) => (writeOutput(ctl.outDir, 1), { exitCode: 0 });
    const noRoom = { commit: () => ({ ok: false, reason: 'too-big' }), findBySource: () => null, meta: () => null, list: () => [], sweep: () => 0, touch: () => undefined } as unknown as DocStore;
    expect(await build({ store: noRoom }).open({ folder: ANA }, { kind: 'upload', name: 'a.pdf' })).toEqual({ ok: false, reason: 'too-big', message: DOCS_NO_ROOM });
    const broken = { ...noRoom, commit: () => ({ ok: false, reason: 'failed' }) } as unknown as DocStore;
    expect(await build({ store: broken }).open({ folder: ANA }, { kind: 'upload', name: 'a.pdf' })).toEqual({ ok: false, reason: 'failed', message: RENDER_FAILED });
    const throwing = { ...noRoom, findBySource: () => { throw new Error('disk gone'); } } as unknown as DocStore;
    expect(await build({ store: throwing }).open({ folder: ANA }, { kind: 'upload', name: 'a.pdf' })).toMatchObject({ ok: false, reason: 'failed' });
    expect(log.warn.mock.calls.some(([, m]) => /an open failed unexpectedly/.test(m))).toBe(true);
  });

  it('never throws, whatever it is given', async () => {
    for (const source of [null, undefined, 7, {}, { kind: 'upload' }, { kind: 'bytes' }, { kind: 'existing' }]) {
      await expect(docs.open({ folder: ANA }, source as never)).resolves.toMatchObject({ ok: false });
    }
  });
});

describe('how many renders a student gets', () => {
  const distinct = (n: number) => pdfBytes(100 + n, n % 250);
  const render = async (folder: string, n: number) => {
    attach(folder, `f${n}.pdf`, distinct(n));
    return upload(folder, `f${n}.pdf`);
  };

  it('is six new documents in ten minutes: the seventh is told so, in words, and the clock gives them back', async () => {
    for (let n = 0; n < DOC_LIMITS.opensPer10Min; n++) {
      ok(await render(ANA, n));
      clock += 1000;
      // (a student keeps eight: the seven that follow take the places of the oldest)
    }
    expect(await render(ANA, 6)).toEqual({ ok: false, reason: 'limit', message: DOCS_RATE_10MIN });
    expect(runs()).toBe(6);
    expect(await render(BOB, 100)).toMatchObject({ ok: true }); // another student has their own
    clock += 10 * 60_000;
    ok(await render(ANA, 6));
  });

  it('is twenty a day, and the day is said first when both are used', async () => {
    for (let n = 0; n < DOC_LIMITS.opensPerDay; n++) {
      ok(await render(ANA, n));
      clock += 11 * 60_000; // (never six in ten minutes)
      if (n % 5 === 4) clock += 60_000;
    }
    const refused = await render(ANA, 99);
    expect(refused).toEqual({ ok: false, reason: 'limit', message: DOCS_RATE_DAY });
    clock += 25 * 3_600_000;
    ok(await render(ANA, 99));
  });

  it('does not count a document that is kept already (the same file, or an id), and does not apply to the admin chat', async () => {
    for (let n = 0; n < DOC_LIMITS.opensPer10Min; n++) ok(await render(ANA, n));
    attach(ANA, 'again.pdf', distinct(2));
    expect(ok(await upload(ANA, 'again.pdf')).doc.title).toBe('f2'); // the same bytes as f2.pdf
    const kept = docs.list(ANA)[0];
    ok(await docs.open({ folder: ANA }, { kind: 'existing', id: kept.id }));
    for (let n = 0; n < 9; n++) ok(await render('main', 200 + n));
    expect(runs()).toBe(6 + 9);
  });
});

describe('one at a time for a student, a few at once on the host', () => {
  const slow = (ms: number) => {
    docker.behave = FakeDocker.runsFor(ms, { exitCode: 0 }, (ctl) => writeOutput(ctl.outDir, 1));
  };
  const open = (folder: string, n: number) => {
    attach(folder, `g${n}.pdf`, pdfBytes(100 + n, n));
    return upload(folder, `g${n}.pdf`);
  };
  const folder = (i: number) => `s_${i.toString(16).padStart(20, '0')}`;

  it('refuses a second render for a student whose first is still going, and then lets them go on', async () => {
    slow(80);
    const first = open(ANA, 1);
    await vi.waitFor(() => expect(runs()).toBe(1));
    expect(await open(ANA, 2)).toEqual({ ok: false, reason: 'busy', message: DOCS_STUDENT_BUSY });
    ok(await first);
    ok(await open(ANA, 2));
  });

  it('runs two renders at once, lets four wait behind them and tells the seventh the service is busy at once', async () => {
    let running = 0;
    let peak = 0;
    docker.behave = async (ctl) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeOutput(ctl.outDir, 1);
      running--;
      return { exitCode: 0 };
    };
    expect(DOC_GATE).toEqual({ concurrent: 2, waiting: 4, waitMs: 30_000 });
    const six = Array.from({ length: 6 }, (_, i) => open(folder(i + 1), i + 1));
    await vi.waitFor(() => expect(runs()).toBe(2));
    const began = Date.now();
    const seventh = await open(folder(7), 7);
    expect(seventh).toEqual({ ok: false, reason: 'busy', message: DOCS_BUSY });
    expect(Date.now() - began).toBeLessThan(500);
    const results = await Promise.all(six);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
    expect(runs()).toBe(6);
  });
});

describe('what the service keeps in its log', () => {
  it('says the kind of source and how it ended, never a file name, a title or the bytes', async () => {
    attach(ANA, 'secret-project-plan.pdf', pdfBytes(400, 9));
    ok(await upload(ANA, 'secret-project-plan.pdf', 'The Secret Title'));
    await docs.open({ folder: ANA }, { kind: 'upload', name: 'missing-file.pdf' });
    const text = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls]);
    for (const secret of ['secret-project-plan', 'The Secret Title', 'missing-file']) expect(text).not.toContain(secret);
    expect(log.info.mock.calls.some(([f, m]) => m === 'docs: open' && f.source === 'upload' && f.ok === true && f.pages === 1)).toBe(true);
    expect(log.info.mock.calls.some(([f, m]) => m === 'docs: open' && f.ok === false && f.reason === 'not-found')).toBe(true);
  });
});

describe('the reaper', () => {
  it('removes leftover containers and directories and documents nobody opened for thirty days; and never throws', async () => {
    attach(ANA, 'a.pdf', pdfBytes());
    const made = ok(await upload(ANA, 'a.pdf'));
    docker.listing = [{ name: 'tai-doc-0123456789ab', startedMs: clock - 3_600_000 }];
    fs.mkdirSync(path.join(root, 'data', 'docs', 'run-0123456789abcdef'), { recursive: true });
    const old = (clock - 3_600_000) / 1000;
    fs.utimesSync(path.join(root, 'data', 'docs', 'run-0123456789abcdef'), old, old);
    expect(await docs.reap()).toBe(2);
    docker.listing = [];
    expect(docs.meta(ANA, made.doc.id)).not.toBeNull();
    clock += (DOC_LIMITS.keepDays + 1) * 86_400_000;
    expect(await docs.reap()).toBe(1);
    expect(docs.meta(ANA, made.doc.id)).toBeNull();
    docker.listError = true;
    await expect(docs.reap()).resolves.toBe(0);
    const throwing = { sweep: () => { throw new Error('no disk'); } } as unknown as DocStore;
    await expect(build({ store: throwing }).reap()).resolves.toBe(0);
  });
});

describe('titles', () => {
  it('come from the file name without its extension (underscores as spaces), or from the title given, on one line and short', () => {
    expect(titleFrom('Lecture_3-notes.pdf')).toBe('Lecture 3-notes');
    expect(titleFrom('report.final.v2.PDF')).toBe('report.final.v2');
    expect(titleFrom('x.pdf', 'Given title')).toBe('Given title');
    expect(titleFrom('x.pdf', '  two\nlines\tand   gaps ')).toBe('two lines and gaps');
    expect(titleFrom('x.pdf', `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}c`)).toBe('a b c');
    expect(titleFrom('___.pdf')).toBe('Document');
    expect(titleFrom('')).toBe('Document');
    expect(titleFrom('x.pdf', 'z'.repeat(500)).length).toBe(DOC_LIMITS.titleChars);
    expect(titleFrom('.pdf')).toBe('Document');
    expect(titleFrom('x.pdf', '   ')).toBe('x');
  });
});

describe('an Office file', () => {
  const zip = (extra = 300): Buffer => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]), Buffer.alloc(extra, 5)]);
  const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(200, 2)]);

  it('goes to the renderer as an Office file, named by its bytes (a zip) and never by its name: the host opens nothing, the container decides what it is', async () => {
    attach(ANA, 'Week_5_Raft.pptx', zip());
    attach(ANA, 'looks-like-a-pdf.pdf', zip(400));
    const seen: string[][] = [];
    docker.behave = async (ctl) => {
      seen.push([...ctl.command, ...fs.readdirSync(ctl.inDir)]);
      writeOutput(ctl.outDir, 4, { inFile: 4 });
      return { exitCode: 0 };
    };
    const deck = ok(await upload(ANA, 'Week_5_Raft.pptx'));
    expect(deck.doc).toMatchObject({ title: 'Week 5 Raft', pages: 4, origin: 'upload' });
    ok(await upload(ANA, 'looks-like-a-pdf.pdf'));
    expect(seen).toEqual([
      [expect.stringContaining('doc-render'), 'office', '120', '1100', 'source.bin'],
      [expect.stringContaining('doc-render'), 'office', '120', '1100', 'source.bin'],
    ]);
    attach(ANA, 'real.pdf', pdfBytes());
    ok(await upload(ANA, 'real.pdf'));
    expect(seen[2].slice(1)).toEqual(['pdf', '120', '1100', 'source.pdf']);
  });

  it('is the same document when it is attached again (the same bytes), with no second render', async () => {
    attach(ANA, 'deck.pptx', zip());
    attach(ANA, 'copy.pptx', zip());
    const first = ok(await upload(ANA, 'deck.pptx'));
    expect(ok(await upload(ANA, 'copy.pptx')).doc.id).toBe(first.doc.id);
    expect(runs()).toBe(1);
  });

  it('is refused in words that a student can be given when the container says it is not one (the line the script prints), and nothing is kept', async () => {
    attach(ANA, 'archive.docx', zip());
    docker.behave = async (ctl) => {
      ctl.write('doc: the file is not a PowerPoint, Word or Excel file.\n');
      return { exitCode: 2 };
    };
    const r = await upload(ANA, 'archive.docx');
    expect(r).toMatchObject({ ok: false, reason: 'bad-file' });
    expect(!r.ok && r.message).toMatch(/PowerPoint/);
    expect(docs.list(ANA)).toEqual([]);
  });

  it('is told apart from a file that is neither: an older Office file or a protected one has its own sentence, any other file the plain one (which names PDF, PowerPoint, Word and Excel)', async () => {
    attach(ANA, 'old.ppt', OLE);
    attach(ANA, 'notes.pdf', 'plain text with a .pdf name');
    expect(await upload(ANA, 'old.ppt')).toEqual({ ok: false, reason: 'bad-file', message: DOCS_OLD_OFFICE });
    expect(await upload(ANA, 'notes.pdf')).toEqual({ ok: false, reason: 'bad-file', message: DOCS_NOT_A_PDF });
    expect(DOCS_OLD_OFFICE).toMatch(/\.pptx, \.docx or \.xlsx/);
    expect(DOCS_NOT_A_PDF).toMatch(/not a PDF or a PowerPoint, Word or Excel file/);
    expect(looksLikeOldOffice(OLE)).toBe(true);
    expect(looksLikeOldOffice(zip())).toBe(false);
    expect(looksLikeOldOffice(Buffer.from([0xd0, 0xcf]))).toBe(false);
    expect(runs()).toBe(0);
  });

  it('counts as a render for the student like any other (the same limits), and records how long the conversion took', async () => {
    docker.behave = async (ctl) => {
      writeOutput(ctl.outDir, 1);
      ctl.write('doc-conv 1185\ndoc-mem 166252544\n');
      return { exitCode: 0, startedAtMs: clock + 5000, finishedAtMs: clock + 8000 };
    };
    for (let i = 0; i < DOC_LIMITS.opensPer10Min; i++) {
      attach(ANA, `d${i}.pptx`, zip(300 + i));
      ok(await upload(ANA, `d${i}.pptx`));
    }
    attach(ANA, 'one-more.docx', zip(999));
    expect(await upload(ANA, 'one-more.docx')).toMatchObject({ ok: false, reason: 'limit' });
    const prepared = log.info.mock.calls.filter(([, m]) => m === 'docs: a document was prepared').map(([f]) => f);
    expect(prepared).toHaveLength(DOC_LIMITS.opensPer10Min);
    expect(prepared[0]).toMatchObject({ kind: 'office', convertMs: 1185, memoryBytes: 166252544 });
  });
});

describe('the course library', () => {
  let store: DocStore;
  const page = { image: png(), ext: 'png' as const, words: { words: ALPHA_WORDS, lines: [[0, 2], [3, 5]] as Array<[number, number]> } };
  const deck = (title: string, week: number | null, sha: string, pages = 3) => store.commitLibrary({ title, week, sourceName: `${title}.pptx`, sha256: sha.repeat(64).slice(0, 64), pages: Array.from({ length: pages }, () => page), aspect: 1.3333 });

  beforeEach(() => {
    store = new DocStore(path.join(root, 'store'), { now: () => clock });
    docs = build();
  });

  it('lists the decks by week and then title, for every student alike, and keeps them out of a student\'s own list', () => {
    expect(docs.library()).toEqual([]);
    const a = deck('Week 5 Raft', 5, 'a');
    const b = deck('Week 2 Containers', 2, 'b');
    const c = deck('Syllabus', null, 'c');
    if (!a.ok || !b.ok || !c.ok) throw new Error('not added');
    expect(docs.library().map((e) => e.title)).toEqual(['Week 2 Containers', 'Week 5 Raft', 'Syllabus']);
    expect(docs.library()[1]).toMatchObject({ week: 5, origin: 'course', pages: 3, sourceName: 'Week 5 Raft.pptx', sha256: 'a'.repeat(64) });
    expect(docs.list(ANA)).toEqual([]);
    expect(docs.list(BOB)).toEqual([]);
  });

  it('is read for any student after their own: meta, words, text and the page image, a document that is not there stays not there', () => {
    const a = deck('Week 5 Raft', 5, 'a');
    if (!a.ok) throw new Error('not added');
    const id = a.entry.id;
    for (const who of [ANA, BOB]) {
      expect(docs.meta(who, id)).toMatchObject({ id, title: 'Week 5 Raft', origin: 'course', pages: 3 });
      expect(docs.words(who, id, 2)?.words).toHaveLength(6);
      expect(docs.text(who, id, 1)).toBe('Alpha Beta gamma\nsecond line here');
      expect(docs.pageFile(who, id, 3)?.type).toBe('image/png');
      expect(docs.words(who, id, 4)).toBeNull();
    }
    expect(docs.meta('not-a-folder', id)).toBeNull();
    expect(docs.meta(ANA, 'f'.repeat(32))).toBeNull();
  });

  it('opens at once for any student, by id: no render, no use of their renders, and the same card data whoever asks', async () => {
    const a = deck('Week 5 Raft', 5, 'a');
    if (!a.ok) throw new Error('not added');
    for (const who of [ANA, BOB, ANA, BOB, ANA, BOB, ANA, BOB]) {
      const r = ok(await docs.open({ folder: who }, { kind: 'existing', id: a.entry.id }));
      expect(r.doc).toMatchObject({ id: a.entry.id, title: 'Week 5 Raft', origin: 'course' });
      expect(r.page).toBe(1);
    }
    expect(runs()).toBe(0);
    // the student's own documents are not touched, and nothing was made for them
    expect(docs.list(ANA)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'store', 'portal', 'docs', ANA))).toBe(false);
  });

  it('is searched by the titles and the words of its pages, and refreshed when the library changes (the next search sees a deck added after the last one)', () => {
    expect(docs.searchLibrary('raft')).toEqual([]);
    const a = deck('Week 5 Raft', 5, 'a');
    if (!a.ok) throw new Error('not added');
    expect(docs.searchLibrary('raft')).toHaveLength(1); // (the title has it, no page does: the deck's first page stands for it)
    expect(docs.searchLibrary('raft')[0]).toMatchObject({ id: a.entry.id, title: 'Week 5 Raft', week: 5, page: 1, pages: 3 });
    expect(docs.searchLibrary('gamma')[0].snippet).toContain('Alpha Beta gamma');
    const b = deck('Week 6 Gamma Rays', 6, 'b');
    if (!b.ok) throw new Error('not added');
    expect(docs.searchLibrary('gamma rays')[0]).toMatchObject({ id: b.entry.id, title: 'Week 6 Gamma Rays' });
    expect(docs.searchLibrary('')).toEqual([]);
    expect(docs.searchLibrary(undefined as never)).toEqual([]);
    store.removeLibrary(b.entry.id);
    expect(docs.searchLibrary('rays')).toEqual([]);
  });
});
