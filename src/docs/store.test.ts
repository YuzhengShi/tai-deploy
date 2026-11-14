import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DocStore, cleanMeta } from './store.js';
import type { CommitInput } from './store.js';
import { ALPHA_WORDS, jpeg, png } from './testing/harness.js';
import { DOC_ID, DOC_LIMITS } from './types.js';
import type { DocMeta } from './types.js';

const ANA = `s_${'a1'.repeat(10)}`;
const BOB = `s_${'b2'.repeat(10)}`;
const DAY = 86_400_000;
const SHA = 'a'.repeat(64);

let dir: string;
let clock: number;
let counter: number;
let store: DocStore;
const warnings: string[] = [];

const idOf = (n: number): string => n.toString(16).padStart(32, '0');
const make = (extra: Partial<ConstructorParameters<typeof DocStore>[1]> = {}) =>
  new DocStore(dir, { now: () => clock, newId: () => idOf(++counter), log: { warn: (_f, m) => void warnings.push(m) }, ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-store-'));
  clock = Date.now(); // (the store compares its clock with the modification times of its files)
  counter = 0;
  warnings.length = 0;
  store = make();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const words = { words: ALPHA_WORDS, lines: [[0, 2], [3, 5]] as Array<[number, number]> };
function input(over: Partial<CommitInput> = {}, pages = 2, imageSize = 120): CommitInput {
  return {
    folder: ANA,
    title: 'Lecture 3',
    origin: 'upload',
    pages: Array.from({ length: pages }, (_, i) => ({ image: i % 2 === 0 ? png(850, 1100, imageSize) : jpeg(1100, 825, imageSize), ext: i % 2 === 0 ? ('png' as const) : ('jpg' as const), words })),
    aspect: 0.7727,
    source: { sha256: SHA, name: 'lecture3.pdf' },
    ...over,
  };
}
const commit = (over: Partial<CommitInput> = {}, pages = 2, imageSize = 120): DocMeta => {
  const r = store.commit(input(over, pages, imageSize));
  if (!r.ok) throw new Error(`commit failed: ${r.reason}`);
  return r.meta;
};
const docDir = (folder: string, id: string) => path.join(store.root, folder, id);
const touchAt = (folder: string, id: string, ms: number) => {
  const marker = path.join(docDir(folder, id), 'opened');
  fs.closeSync(fs.openSync(marker, 'a'));
  fs.utimesSync(marker, ms / 1000, ms / 1000);
};

describe('keeping a document', () => {
  it('writes the layout of the contract: meta.json, the page images under their sniffed extension, a words file for each page, source.json, and nothing else', () => {
    const meta = commit();
    expect(meta).toMatchObject({ id: idOf(1), title: 'Lecture 3', pages: 2, origin: 'upload', createdAt: clock, aspect: 0.7727 });
    expect(DOC_ID.test(meta.id)).toBe(true);
    const names = fs.readdirSync(docDir(ANA, meta.id)).sort();
    expect(names).toEqual(['meta.json', 'p001.png', 'p002.jpg', 'source.json', 'w001.json', 'w002.json']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(docDir(ANA, meta.id), 'meta.json'), 'utf8'));
    expect(onDisk).toEqual(meta);
    const images = input().pages.reduce((sum, p) => sum + p.image.length, 0);
    expect(meta.bytes).toBe(images + 2 * Buffer.byteLength(JSON.stringify(words)));
    expect(JSON.parse(fs.readFileSync(path.join(docDir(ANA, meta.id), 'source.json'), 'utf8'))).toEqual({ sha256: SHA, name: 'lecture3.pdf' });
    expect(JSON.parse(fs.readFileSync(path.join(docDir(ANA, meta.id), 'w001.json'), 'utf8'))).toEqual(words);
    // the document appears with one rename: no temporary directory is left in the student's directory
    expect(fs.readdirSync(path.join(store.root, ANA))).toEqual([meta.id]);
  });

  it('is invisible until it is complete: a half made directory is not a document, and the sweep removes it after ten minutes', () => {
    const half = path.join(store.root, ANA, `.tmp-${idOf(99)}`);
    fs.mkdirSync(half, { recursive: true });
    fs.writeFileSync(path.join(half, 'p001.png'), png());
    expect(store.list(ANA)).toEqual([]);
    expect(store.sweep()).toBe(0);
    const old = (clock - 11 * 60_000) / 1000;
    fs.utimesSync(half, old, old);
    expect(store.sweep()).toBe(1);
    expect(fs.existsSync(half)).toBe(false);
  });

  it('records the pages the file has when that is more than was kept', () => {
    const meta = commit({ pagesInFile: 200 });
    expect(meta.pagesInFile).toBe(200);
    expect(commit({ pagesInFile: 2 }).pagesInFile).toBeUndefined();
    expect(commit({}).pagesInFile).toBeUndefined();
  });

  it('refuses what is not a document: a folder that is not a chat folder, no pages, too many pages', () => {
    expect(store.commit(input({ folder: '../escape' }))).toEqual({ ok: false, reason: 'failed' });
    expect(store.commit(input({ folder: 's_short' }))).toEqual({ ok: false, reason: 'failed' });
    expect(store.commit(input({ pages: [] }))).toEqual({ ok: false, reason: 'failed' });
    expect(store.commit(input({}, DOC_LIMITS.pages + 1))).toEqual({ ok: false, reason: 'failed' });
    expect(fs.existsSync(path.join(dir, 'escape'))).toBe(false);
  });

  it('gives a document an id that is taken neither by the student\'s own nor by the library', () => {
    const library = path.join(store.courseRoot, idOf(1));
    fs.mkdirSync(library, { recursive: true });
    const first = commit();
    expect(first.id).toBe(idOf(2)); // idOf(1) is the library's
    const ids = [idOf(2), idOf(2), idOf(1), idOf(7)];
    store = make({ newId: () => ids.shift() ?? 'not an id' });
    expect(commit().id).toBe(idOf(7));
    store = make({ newId: () => 'not an id' });
    expect(store.commit(input())).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('reading it back', () => {
  it('answers meta, words, text and the page file for the student\'s own document, and nothing for another student\'s', () => {
    const meta = commit();
    expect(store.meta(ANA, meta.id)).toEqual(meta);
    expect(store.words(ANA, meta.id, 1)).toEqual(words);
    expect(store.text(ANA, meta.id, 2)).toBe('Alpha Beta gamma\nsecond line here');
    expect(store.pageFile(ANA, meta.id, 1)).toEqual({ file: path.join(docDir(ANA, meta.id), 'p001.png'), type: 'image/png' });
    expect(store.pageFile(ANA, meta.id, 2)).toEqual({ file: path.join(docDir(ANA, meta.id), 'p002.jpg'), type: 'image/jpeg' });
    expect(store.meta(BOB, meta.id)).toBeNull();
    expect(store.words(BOB, meta.id, 1)).toBeNull();
    expect(store.text(BOB, meta.id, 1)).toBeNull();
    expect(store.pageFile(BOB, meta.id, 1)).toBeNull();
    expect(store.list(BOB)).toEqual([]);
  });

  it('is not fooled by a folder or an id that is not one, or a page that is not there', () => {
    store = make({ newId: () => 'ab'.repeat(16) }); // (an id with letters in it, so that its upper case is another name)
    const meta = commit();
    for (const id of ['../' + meta.id, meta.id + '/..', meta.id.toUpperCase(), meta.id.slice(1), '', `${meta.id}\0`, 'x'.repeat(40)]) {
      expect(store.meta(ANA, id)).toBeNull();
      expect(store.pageFile(ANA, id, 1)).toBeNull();
    }
    for (const folder of ['', '..', `${ANA}/..`, 's_zz', ANA.toUpperCase()]) expect(store.meta(folder, meta.id)).toBeNull();
    for (const page of [0, 3, -1, 1.5, NaN]) {
      expect(store.words(ANA, meta.id, page)).toBeNull();
      expect(store.text(ANA, meta.id, page)).toBeNull();
      expect(store.pageFile(ANA, meta.id, page)).toBeNull();
    }
  });

  it('names the type of an image from its bytes, never from its name, and has no page when the file is not an image', () => {
    const meta = commit();
    const p1 = path.join(docDir(ANA, meta.id), 'p001.png');
    fs.writeFileSync(p1, jpeg()); // a JPEG under a .png name
    expect(store.pageFile(ANA, meta.id, 1)?.type).toBe('image/jpeg');
    fs.writeFileSync(p1, Buffer.from('<html><script>alert(1)</script></html>'));
    expect(store.pageFile(ANA, meta.id, 1)).toBeNull();
    fs.rmSync(p1);
    expect(store.pageFile(ANA, meta.id, 1)).toBeNull();
  });

  it('gives a page whose words file is missing or damaged no words, and a document whose meta is damaged is no document', () => {
    const meta = commit();
    fs.rmSync(path.join(docDir(ANA, meta.id), 'w001.json'));
    expect(store.words(ANA, meta.id, 1)).toEqual({ words: [], lines: [] });
    expect(store.text(ANA, meta.id, 1)).toBe('');
    fs.writeFileSync(path.join(docDir(ANA, meta.id), 'w002.json'), '{"words": 7}');
    expect(store.words(ANA, meta.id, 2)).toEqual({ words: [], lines: [] });
    fs.writeFileSync(path.join(docDir(ANA, meta.id), 'meta.json'), '{"id":"x"}');
    expect(store.meta(ANA, meta.id)).toBeNull();
    expect(store.list(ANA)).toEqual([]);
  });

  it('lists a student\'s documents newest first, and only theirs', () => {
    const a = commit({ title: 'One' });
    clock += 1000;
    const b = commit({ title: 'Two' });
    clock += 1000;
    commit({ title: 'Other student', folder: BOB });
    expect(store.list(ANA).map((d) => d.title)).toEqual(['Two', 'One']);
    expect(store.list(ANA).map((d) => d.id)).toEqual([b.id, a.id]);
    expect(store.list(BOB).map((d) => d.title)).toEqual(['Other student']);
    expect(store.list('main')).toEqual([]);
  });

  it('finds the document made from a file by its SHA-256, and only for that student', () => {
    const meta = commit();
    expect(store.findBySource(ANA, SHA)?.id).toBe(meta.id);
    expect(store.findBySource(ANA, 'b'.repeat(64))).toBeNull();
    expect(store.findBySource(BOB, SHA)).toBeNull();
    expect(store.findBySource(ANA, 'not a hash')).toBeNull();
    expect(store.findBySource(ANA, SHA.toUpperCase())).toBeNull();
  });

  it('does not follow a link that was put where a file of a document should be', () => {
    const meta = commit();
    const secret = path.join(dir, 'secret.json');
    fs.writeFileSync(secret, JSON.stringify({ words: [[0, 0, 1, 1, 'LEAK']], lines: [] }));
    try {
      fs.rmSync(path.join(docDir(ANA, meta.id), 'w001.json'));
      fs.symlinkSync(secret, path.join(docDir(ANA, meta.id), 'w001.json'));
    } catch {
      return; // (a platform that does not let this user make links: the check is the same code on the host)
    }
    expect(store.words(ANA, meta.id, 1)).toEqual({ words: [], lines: [] });
    fs.rmSync(path.join(docDir(ANA, meta.id), 'p001.png'));
    fs.symlinkSync(secret, path.join(docDir(ANA, meta.id), 'p001.png'));
    expect(store.pageFile(ANA, meta.id, 1)).toBeNull();
  });
});

describe('the course library', () => {
  const libraryDoc = (id: string): void => {
    const d = path.join(store.courseRoot, id);
    fs.mkdirSync(d, { recursive: true });
    const meta: DocMeta = { id, title: 'Raft paper', pages: 1, origin: 'course', createdAt: 1, bytes: 10 };
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(d, 'p001.png'), png());
    fs.writeFileSync(path.join(d, 'w001.json'), JSON.stringify(words));
  };

  it('is read second and by every student, never listed among a student\'s own, never touched and never swept', () => {
    libraryDoc(idOf(500));
    for (const folder of [ANA, BOB]) {
      expect(store.meta(folder, idOf(500))?.title).toBe('Raft paper');
      expect(store.text(folder, idOf(500), 1)).toBe('Alpha Beta gamma\nsecond line here');
      expect(store.pageFile(folder, idOf(500), 1)?.type).toBe('image/png');
    }
    expect(store.list(ANA)).toEqual([]);
    store.touch(ANA, idOf(500), true);
    expect(fs.existsSync(path.join(store.courseRoot, idOf(500), 'opened'))).toBe(false);
    clock += 400 * DAY;
    expect(store.sweep()).toBe(0);
    expect(store.meta(ANA, idOf(500))).not.toBeNull();
  });

  it('is looked at after the student\'s own directory', () => {
    const meta = commit();
    const d = path.join(store.courseRoot, meta.id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ ...meta, title: 'The library\'s' }));
    expect(store.meta(ANA, meta.id)?.title).toBe('Lecture 3');
    expect(store.meta(BOB, meta.id)?.title).toBe("The library's"); // another student has only the library's
  });
});

describe('the room of one student', () => {
  it('keeps eight documents: the ninth takes the place of the one opened longest ago', () => {
    const made: DocMeta[] = [];
    for (let i = 0; i < DOC_LIMITS.perStudentDocs; i++) {
      made.push(commit({ title: `Doc ${i}`, source: { sha256: String(i).repeat(64).slice(0, 64) } }));
      clock += 1000;
    }
    expect(store.list(ANA)).toHaveLength(8);
    touchAt(ANA, made[0].id, clock + 5000); // the first was opened after all of them were made
    const r = store.commit(input({ title: 'Doc 8' }));
    expect(r.ok && r.evicted).toBe(1);
    const titles = store.list(ANA).map((d) => d.title);
    expect(titles).toHaveLength(8);
    expect(titles).toContain('Doc 0'); // kept: it was opened last
    expect(titles).not.toContain('Doc 1'); // the one opened longest ago
    expect(titles).toContain('Doc 8');
    expect(store.list(BOB)).toEqual([]); // nobody else's room is touched
  });

  it('keeps 60 MB: a document that does not fit makes room by removing the oldest, and one that is bigger than all the room is cut to the pages that fit', () => {
    const big = 700_000;
    const a = commit({ title: 'A' }, 40, big);
    clock += 1000;
    const b = commit({ title: 'B' }, 10, big);
    clock += 1000;
    expect(store.usage(ANA).docs).toBe(2);
    expect(a.bytes).toBeGreaterThan(27_000_000);
    const c = store.commit(input({ title: 'C' }, 50, big));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.evicted).toBe(1); // A is the oldest: 28 MB + 7 MB + 35 MB is over 60 MB; without A it fits
    expect(store.list(ANA).map((d) => d.title).sort()).toEqual(['B', 'C']);
    expect(store.usage(ANA).bytes).toBeLessThanOrEqual(DOC_LIMITS.perStudentBytes);
    void b;

    const huge = store.commit(input({ title: 'Huge', pagesInFile: 120 }, 100, big));
    expect(huge.ok).toBe(true);
    if (!huge.ok) return;
    expect(huge.cutPages).toBe(true);
    expect(huge.meta.pages).toBeLessThan(100);
    expect(huge.meta.pages).toBeGreaterThan(80);
    expect(huge.meta.pagesInFile).toBe(120);
    expect(huge.meta.bytes).toBeLessThanOrEqual(DOC_LIMITS.perStudentBytes);
    expect(store.list(ANA).map((d) => d.title)).toEqual(['Huge']); // it took all the room: the older ones went
    expect(fs.readdirSync(docDir(ANA, huge.meta.id)).filter((n) => n.startsWith('p'))).toHaveLength(huge.meta.pages);
  });

  it('says too-big when not even one page fits', () => {
    const r = store.commit(input({}, 1, DOC_LIMITS.perStudentBytes + 1));
    expect(r).toEqual({ ok: false, reason: 'too-big' });
    expect(store.list(ANA)).toEqual([]);
  });
});

describe('opened, expired and swept', () => {
  it('marks a document as opened (a file whose time is the last open), at most every ten minutes unless forced, and for the student\'s own only', () => {
    const meta = commit();
    const marker = path.join(docDir(ANA, meta.id), 'opened');
    expect(fs.existsSync(marker)).toBe(false);
    store.touch(ANA, meta.id);
    expect(fs.statSync(marker).mtimeMs).toBeCloseTo(clock, -3);
    const first = fs.statSync(marker).mtimeMs;
    clock += 5 * 60_000;
    store.touch(ANA, meta.id);
    expect(fs.statSync(marker).mtimeMs).toBe(first); // not again so soon
    store.touch(ANA, meta.id, true);
    expect(fs.statSync(marker).mtimeMs).toBeGreaterThan(first);
    clock += 11 * 60_000;
    store.touch(ANA, meta.id);
    expect(fs.statSync(marker).mtimeMs).toBeCloseTo(clock, -3);
    store.touch(BOB, meta.id, true); // not theirs
    store.touch(ANA, '../x', true); // not an id
    expect(warnings).toEqual([]);
  });

  it('serving a page counts as opening it', () => {
    const meta = commit();
    store.pageFile(ANA, meta.id, 1);
    expect(fs.existsSync(path.join(docDir(ANA, meta.id), 'opened'))).toBe(true);
  });

  it('removes what nobody opened for thirty days, counted from the last open, and keeps the rest', () => {
    const stale = commit({ title: 'stale' });
    const used = commit({ title: 'used' });
    const fresh = commit({ title: 'fresh' });
    clock += 31 * DAY;
    touchAt(ANA, used.id, clock - 2 * DAY);
    store.touch(ANA, fresh.id, true);
    expect(store.sweep()).toBe(1);
    expect(store.list(ANA).map((d) => d.title).sort()).toEqual(['fresh', 'used']);
    expect(store.meta(ANA, stale.id)).toBeNull();
    clock += 29 * DAY;
    expect(store.sweep()).toBe(1); // 'used' was last opened 31 days ago now
    expect(store.list(ANA).map((d) => d.title)).toEqual(['fresh']);
  });

  it('removes a directory with an id and no meta only after an hour, and ignores names that are not ids', () => {
    const orphan = path.join(store.root, ANA, idOf(900));
    const other = path.join(store.root, ANA, 'notes');
    fs.mkdirSync(orphan, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    expect(store.sweep()).toBe(0);
    const old = (clock - 61 * 60_000) / 1000;
    fs.utimesSync(orphan, old, old);
    fs.utimesSync(other, old, old);
    expect(store.sweep()).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('does not throw when there is no store yet', () => {
    expect(make().sweep()).toBe(0);
    expect(make().list(ANA)).toEqual([]);
  });
});

describe('cleanMeta', () => {
  const good = { id: idOf(1), title: 'T', pages: 3, origin: 'upload', createdAt: 5, bytes: 9 };
  it('takes the fields of a DocMeta and drops anything else', () => {
    expect(cleanMeta({ ...good, extra: 'x', aspect: 1.7778, pagesInFile: 10 }, idOf(1))).toEqual({ ...good, aspect: 1.7778, pagesInFile: 10 });
  });
  it('refuses a meta of another id, with a title that is empty or too long, pages out of range, an origin it does not know, or numbers that are not numbers', () => {
    for (const bad of [{ ...good, id: idOf(2) }, { ...good, title: '' }, { ...good, title: 'x'.repeat(DOC_LIMITS.titleChars + 1) }, { ...good, pages: 0 }, { ...good, pages: DOC_LIMITS.pages + 1 }, { ...good, pages: 1.5 }, { ...good, origin: 'web' }, { ...good, createdAt: NaN }, { ...good, bytes: -1 }, null, [], 'x']) {
      expect(cleanMeta(bad, idOf(1))).toBeNull();
    }
  });
  it('drops an aspect or a pagesInFile that is out of range instead of failing', () => {
    expect(cleanMeta({ ...good, aspect: 99, pagesInFile: 2 }, idOf(1))).toEqual(good);
  });
});
