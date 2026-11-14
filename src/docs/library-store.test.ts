import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INDEX_FILE, cleanRow, cleanWeek, parseLibraryIndex, serializeLibraryIndex, titleKey, weekFrom } from './library-index.js';
import { DocStore } from './store.js';
import type { LibraryCommitInput } from './store.js';
import { ALPHA_WORDS, jpeg, png } from './testing/harness.js';
import { DOC_ID, LIBRARY_LIMITS } from './types.js';

const ANA = `s_${'a1'.repeat(10)}`;
const SHA = (c: string): string => c.repeat(64).slice(0, 64);

let dir: string;
let clock: number;
let counter: number;
let store: DocStore;
const warnings: string[] = [];
const idOf = (n: number): string => n.toString(16).padStart(32, '0');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-library-'));
  clock = Date.now();
  counter = 0;
  warnings.length = 0;
  store = new DocStore(dir, { now: () => clock, newId: () => idOf(++counter), log: { warn: (_f, m) => void warnings.push(m) } });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const words = { words: ALPHA_WORDS, lines: [[0, 2], [3, 5]] as Array<[number, number]> };
const input = (over: Partial<LibraryCommitInput> = {}, pages = 2): LibraryCommitInput => ({
  title: 'Week 5 Raft',
  week: 5,
  sourceName: 'week5-raft.pptx',
  sha256: SHA('a'),
  pages: Array.from({ length: pages }, (_, i) => ({ image: i % 2 === 0 ? png(1100, 825, 200) : jpeg(1100, 825, 300), ext: i % 2 === 0 ? ('png' as const) : ('jpg' as const), words })),
  aspect: 1.3333,
  ...over,
});
const add = (over: Partial<LibraryCommitInput> = {}, pages = 2) => {
  const r = store.commitLibrary(input(over, pages));
  if (!r.ok) throw new Error(`not added: ${r.reason}`);
  return r.entry;
};
const indexFile = (): string => path.join(store.courseRoot, INDEX_FILE);

describe('weeks, rows and the index file', () => {
  it('takes a week from "Week 5", "week5", "Wk 05" and "W5" in a name, not from "HW5" or a number that is not a week', () => {
    for (const [text, week] of [['Week 5 - Raft', 5], ['week5.pdf', 5], ['Wk 05 slides', 5], ['CS6650_W7_Paxos.pptx', 7], ['W12', 12], ['lecture w3 notes', 3], ['Week 30', 30]] as const) expect(weekFrom(text), text).toBe(week);
    for (const text of ['HW5 spec.pdf', 'Homework 5', 'Day1 lecture ONLINE 2026.pdf', 'Week 31', 'Week 0', 'week', 'show 5', '', 'Network5']) expect(weekFrom(text), text).toBeNull();
    expect(weekFrom(undefined)).toBeNull();
    expect(weekFrom('Week 5 and Week 6')).toBe(5);
    expect(cleanWeek(5)).toBe(5);
    for (const bad of [0, 31, 2.5, '5', null, undefined, NaN]) expect(cleanWeek(bad)).toBeNull();
  });

  it('keeps a row whose every field passes, and drops one that does not: an id that is not 32 hex, a title that is empty or long, a hash that is not one, pages out of range, numbers that are not numbers', () => {
    const good = { id: idOf(1), title: 'Raft', week: 5, sourceName: 'raft.pptx', sha256: SHA('b'), pages: 3, bytes: 100, createdAt: 5 };
    expect(cleanRow(good)).toEqual(good);
    expect(cleanRow({ ...good, week: 99 })).toMatchObject({ week: null });
    expect(cleanRow({ ...good, sourceName: 42 })).toMatchObject({ sourceName: '' });
    expect(cleanRow({ ...good, pagesInFile: 150 })).toMatchObject({ pagesInFile: 150 });
    expect(cleanRow({ ...good, pagesInFile: 2 })).not.toHaveProperty('pagesInFile');
    for (const bad of [{ ...good, id: '../../etc' }, { ...good, id: 'ABCDEF0123456789'.repeat(2) }, { ...good, title: '' }, { ...good, title: '   ' }, { ...good, title: 'x'.repeat(500) }, { ...good, sha256: 'xyz' }, { ...good, pages: 0 }, { ...good, pages: 500 }, { ...good, bytes: -1 }, { ...good, createdAt: 'now' }, null, 'row', [good]]) {
      expect(cleanRow(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(cleanRow({ ...good, title: `A${String.fromCharCode(0x202e)}B${String.fromCharCode(0x2028)}C` })?.title).toBe('A B C');
  });

  it('reads an index file as its rows: each id once, at most a hundred, nothing from a file that is not an index', () => {
    const rows = Array.from({ length: 130 }, (_, i) => ({ id: idOf(i + 1), title: `Deck ${i}`, week: null, sourceName: '', sha256: SHA('c'), pages: 1, bytes: 1, createdAt: 1 }));
    expect(parseLibraryIndex(serializeLibraryIndex(rows))).toHaveLength(LIBRARY_LIMITS.entries);
    expect(parseLibraryIndex(JSON.stringify({ v: 1, entries: [rows[0], rows[0], { nope: 1 }] }))).toHaveLength(1);
    for (const text of ['', 'not json', '[]', '{}', '{"entries":"x"}', '{"entries":{"a":1}}', 'null']) expect(parseLibraryIndex(text), text).toEqual([]);
    expect(titleKey('Week 5 - Raft!')).toBe(titleKey('week 5  raft'));
  });
});

describe('adding a deck to the library', () => {
  it('writes the layout of a document (meta.json, the page images, the words files, source.json) in a directory of the library and a row in index.json, and answers with the entry', () => {
    const entry = add();
    expect(DOC_ID.test(entry.id)).toBe(true);
    expect(entry).toMatchObject({ title: 'Week 5 Raft', week: 5, sourceName: 'week5-raft.pptx', sha256: SHA('a'), pages: 2, origin: 'course', aspect: 1.3333 });
    expect(fs.readdirSync(path.join(store.courseRoot, entry.id)).sort()).toEqual(['meta.json', 'p001.png', 'p002.jpg', 'source.json', 'w001.json', 'w002.json']);
    expect(fs.readdirSync(store.courseRoot).sort()).toEqual([entry.id, INDEX_FILE]);
    const rows = parseLibraryIndex(fs.readFileSync(indexFile(), 'utf8'));
    expect(rows).toEqual([expect.objectContaining({ id: entry.id, title: 'Week 5 Raft', week: 5, sourceName: 'week5-raft.pptx', sha256: SHA('a'), pages: 2 })]);
    expect(JSON.parse(fs.readFileSync(path.join(store.courseRoot, entry.id, 'source.json'), 'utf8'))).toEqual({ sha256: SHA('a'), name: 'week5-raft.pptx' });
  });

  it('is read by every student, after their own, as soon as it is added: meta, words, text and the page image', () => {
    const entry = add();
    for (const folder of [ANA, `s_${'b2'.repeat(10)}`]) {
      expect(store.meta(folder, entry.id)).toMatchObject({ title: 'Week 5 Raft', origin: 'course' });
      expect(store.text(folder, entry.id, 2)).toBe('Alpha Beta gamma\nsecond line here');
      expect(store.pageFile(folder, entry.id, 2)?.type).toBe('image/jpeg');
    }
    expect(store.list(ANA)).toEqual([]);
  });

  it('lists the entries by week (none last) and then title, and hands out the same array until the index file changes', () => {
    add({ title: 'Zeta', week: 3, sha256: SHA('1') });
    add({ title: 'Alpha', week: null, sha256: SHA('2') });
    add({ title: 'Beta', week: 3, sha256: SHA('3') });
    add({ title: 'Early', week: 1, sha256: SHA('4') });
    const first = store.library();
    expect(first.map((e) => e.title)).toEqual(['Early', 'Beta', 'Zeta', 'Alpha']);
    expect(store.library()).toBe(first);
    add({ title: 'New', week: 2, sha256: SHA('5') });
    expect(store.library()).not.toBe(first);
    expect(store.library().map((e) => e.title)).toEqual(['Early', 'New', 'Beta', 'Zeta', 'Alpha']);
  });

  it('sees a change another process made to the index (a library the operator changed while the service runs) the next time it is asked, and an index that is gone is an empty library', () => {
    const entry = add();
    const before = store.library();
    expect(before).toHaveLength(1);
    // the operator's command runs in another process: here, another store over the same directory
    const operator = new DocStore(dir, { now: () => clock + 5, newId: () => idOf(900) });
    const r = operator.commitLibrary(input({ title: 'Added by the operator', sha256: SHA('9') }));
    expect(r.ok).toBe(true);
    expect(store.library().map((e) => e.title).sort()).toEqual(['Added by the operator', 'Week 5 Raft']);
    expect(operator.removeLibrary(entry.id)).toBe(true);
    expect(store.library().map((e) => e.title)).toEqual(['Added by the operator']);
    fs.rmSync(indexFile());
    expect(store.library()).toEqual([]);
  });

  it('does not add the same file twice (its SHA-256), and says which entry it is', () => {
    const entry = add();
    const again = store.commitLibrary(input({ title: 'Another title', sourceName: 'copy.pptx' }));
    expect(again).toMatchObject({ ok: false, reason: 'same-file', entry: { id: entry.id } });
    expect(store.library()).toHaveLength(1);
    expect(store.findLibraryBySource(SHA('a'))?.id).toBe(entry.id);
    expect(store.findLibraryBySource(SHA('b'))).toBeNull();
    expect(store.findLibraryBySource('not a hash')).toBeNull();
    expect(fs.readdirSync(store.courseRoot).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('keeps titles unique, so that show_document can always name a deck: the same words in another case or with other punctuation are the same title', () => {
    add();
    const r = store.commitLibrary(input({ title: 'week 5 - RAFT!', sha256: SHA('b') }));
    expect(r).toMatchObject({ ok: false, reason: 'same-title' });
    expect(!r.ok && 'message' in r && r.message).toContain('a title of its own');
    expect(store.library()).toHaveLength(1);
  });

  it('refuses more than a hundred decks and more bytes than the library may hold, in words', () => {
    const rows = Array.from({ length: LIBRARY_LIMITS.entries }, (_, i) => ({ id: idOf(1000 + i), title: `Deck ${i}`, week: null, sourceName: '', sha256: i.toString(16).padStart(64, '0'), pages: 1, bytes: 1, createdAt: 1 }));
    fs.mkdirSync(store.courseRoot, { recursive: true });
    for (const row of rows) {
      fs.mkdirSync(path.join(store.courseRoot, row.id));
      fs.writeFileSync(path.join(store.courseRoot, row.id, 'meta.json'), JSON.stringify({ id: row.id, title: row.title, pages: 1, origin: 'course', createdAt: 1, bytes: 1 }));
    }
    fs.writeFileSync(indexFile(), serializeLibraryIndex(rows));
    expect(store.library()).toHaveLength(LIBRARY_LIMITS.entries);
    expect(store.commitLibrary(input({ sha256: SHA('f') }))).toMatchObject({ ok: false, reason: 'full' });
    fs.writeFileSync(indexFile(), serializeLibraryIndex([{ ...rows[0], bytes: LIBRARY_LIMITS.bytes - 100 }]));
    expect(store.commitLibrary(input({ sha256: SHA('e') }))).toMatchObject({ ok: false, reason: 'too-big' });
  });

  it('refuses what is not a deck: no pages, too many, a title that is empty or long, a hash that is not one; nothing is written', () => {
    for (const over of [{ title: '   ' }, { title: 'x'.repeat(500) }, { sha256: 'xyz' }]) expect(store.commitLibrary(input(over)), JSON.stringify(over)).toMatchObject({ ok: false, reason: 'failed' });
    expect(store.commitLibrary({ ...input(), pages: [] })).toMatchObject({ ok: false, reason: 'failed' });
    expect(store.commitLibrary(input({}, 121))).toMatchObject({ ok: false, reason: 'failed' });
    expect(fs.existsSync(store.courseRoot) ? fs.readdirSync(store.courseRoot) : []).toEqual([]);
  });

  it('gives a deck an id that no student\'s document has either (the ids are unique across both places), and fails when it cannot', () => {
    const own = store.commit({ folder: ANA, title: 'Mine', origin: 'upload', pages: [{ image: png(), ext: 'png', words }] });
    expect(own.ok).toBe(true);
    counter = 0; // the next id the store would make is the id of the student's document
    const entry = add({ sha256: SHA('d') });
    expect(entry.id).not.toBe(own.ok ? own.meta.id : '');
    const stuck = new DocStore(dir, { now: () => clock, newId: () => (own.ok ? own.meta.id : 'x') });
    expect(stuck.commitLibrary(input({ sha256: SHA('e'), title: 'Other' }))).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('leaves no half made directory and no row when a write fails in the middle', () => {
    const real = fs.writeFileSync;
    let calls = 0;
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes('w002.json') && ++calls === 1) throw new Error('disk full');
      return (real as (...a: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync;
    try {
      expect(store.commitLibrary(input())).toMatchObject({ ok: false, reason: 'failed' });
    } finally {
      (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = real;
    }
    expect(fs.readdirSync(store.courseRoot)).toEqual([]);
    expect(store.library()).toEqual([]);
    expect(add().title).toBe('Week 5 Raft'); // and the library still works
  });

  it('holds the library to one writer at a time (a lock that a run that died leaves is taken over after five minutes)', () => {
    fs.mkdirSync(store.courseRoot, { recursive: true });
    const lock = path.join(store.courseRoot, '.lock');
    fs.mkdirSync(lock);
    const stale = (clock - 6 * 60_000) / 1000;
    fs.utimesSync(lock, stale, stale);
    expect(store.commitLibrary(input()).ok).toBe(true); // the old lock is taken over
    expect(fs.existsSync(lock)).toBe(false); // and let go
    fs.mkdirSync(lock);
    expect(store.commitLibrary(input({ title: 'Blocked', sha256: SHA('c') }))).toMatchObject({ ok: false, reason: 'failed' });
    expect((store.commitLibrary(input({ title: 'Blocked', sha256: SHA('c') })) as { message: string }).message).toContain('another command');
    fs.rmSync(lock, { recursive: true });
  });
});

describe('removing a deck', () => {
  it('takes the row out first, then the directory, and an entry that is not there is "no such deck"', () => {
    const a = add({ title: 'A', sha256: SHA('1') });
    const b = add({ title: 'B', sha256: SHA('2') });
    expect(store.removeLibrary(a.id)).toBe(true);
    expect(store.library().map((e) => e.title)).toEqual(['B']);
    expect(fs.existsSync(path.join(store.courseRoot, a.id))).toBe(false);
    expect(store.meta(ANA, a.id)).toBeNull();
    expect(store.removeLibrary(a.id)).toBe(false);
    expect(store.removeLibrary('../etc')).toBe(false);
    expect(store.removeLibrary(idOf(777))).toBe(false);
    expect(store.library().map((e) => e.id)).toEqual([b.id]);
  });

  it('never removes a directory that is not a row of the index: a student\'s document or something put there by hand', () => {
    const own = store.commit({ folder: ANA, title: 'Mine', origin: 'upload', pages: [{ image: png(), ext: 'png', words }] });
    if (!own.ok) throw new Error('not kept');
    fs.mkdirSync(path.join(store.courseRoot, idOf(555)), { recursive: true });
    expect(store.removeLibrary(own.meta.id)).toBe(false);
    expect(store.removeLibrary(idOf(555))).toBe(false);
    expect(fs.existsSync(path.join(store.courseRoot, idOf(555)))).toBe(true);
    expect(store.meta(ANA, own.meta.id)).not.toBeNull();
  });
});

describe('renaming a deck', () => {
  it("writes a new title into the deck's own meta.json and into its row, and a new week into its row: every reader sees it at once and the pages are as they were", () => {
    const a = add({ title: 'day5-apis', week: null, sourceName: 'Day 5 APIs and Load Balancers.pdf', sha256: SHA('a') });
    const firstPage = fs.readFileSync(store.pageFile(ANA, a.id, 1)!.file);
    const listed = store.library();
    const r = store.renameLibrary(a.id, { title: 'Day 5 - APIs and Load Balancers', week: 5 });
    expect(r).toMatchObject({ ok: true, changed: true, before: { title: 'day5-apis', week: null }, entry: { id: a.id, title: 'Day 5 - APIs and Load Balancers', week: 5, sourceName: 'Day 5 APIs and Load Balancers.pdf', pages: 2, origin: 'course' } });
    expect(store.library()).not.toBe(listed); // the index changed, so what is built from the array is built again
    expect(store.library().map((e) => [e.title, e.week])).toEqual([['Day 5 - APIs and Load Balancers', 5]]);
    expect(store.meta(ANA, a.id)?.title).toBe('Day 5 - APIs and Load Balancers'); // what a student's reads give
    expect(JSON.parse(fs.readFileSync(path.join(store.courseRoot, a.id, 'meta.json'), 'utf8')).title).toBe('Day 5 - APIs and Load Balancers');
    expect(parseLibraryIndex(fs.readFileSync(indexFile(), 'utf8'))).toMatchObject([{ id: a.id, title: 'Day 5 - APIs and Load Balancers', week: 5, sha256: SHA('a'), pages: 2 }]);
    expect(fs.readFileSync(store.pageFile(ANA, a.id, 1)!.file).equals(firstPage)).toBe(true);
    expect(store.text(ANA, a.id, 1)).not.toBeNull();
    // nothing else was touched and nothing is left behind: no temporary file, no lock
    expect(fs.readdirSync(path.join(store.courseRoot, a.id)).sort()).toEqual(['meta.json', 'p001.png', 'p002.jpg', 'source.json', 'w001.json', 'w002.json']);
    expect(fs.readdirSync(store.courseRoot).sort()).toEqual([a.id, 'index.json']);
  });

  it('changes only what is given, and writes nothing (and keeps the same array) when nothing differs', () => {
    const a = add({ title: 'Raft', week: 5 });
    expect(store.renameLibrary(a.id, { week: 6 })).toMatchObject({ ok: true, changed: true, entry: { title: 'Raft', week: 6 } });
    expect(store.renameLibrary(a.id, { title: 'Raft, the slides' })).toMatchObject({ ok: true, changed: true, entry: { title: 'Raft, the slides', week: 6 } });
    expect(store.renameLibrary(a.id, { week: null })).toMatchObject({ ok: true, changed: true, entry: { week: null } });
    const listed = store.library();
    const index = fs.readFileSync(indexFile(), 'utf8');
    expect(store.renameLibrary(a.id, {})).toMatchObject({ ok: true, changed: false });
    expect(store.renameLibrary(a.id, { title: 'Raft, the slides', week: null })).toMatchObject({ ok: true, changed: false });
    expect(store.library()).toBe(listed);
    expect(fs.readFileSync(indexFile(), 'utf8')).toBe(index);
  });

  it('refuses a title another deck has (case and punctuation do not matter), and lets a deck change the case of its own title', () => {
    const a = add({ title: 'Raft', sha256: SHA('1') });
    const b = add({ title: 'Paxos', sha256: SHA('2') });
    const refused = store.renameLibrary(b.id, { title: 'raft!' });
    expect(refused).toMatchObject({ ok: false, reason: 'same-title' });
    expect((refused as { message: string }).message).toContain('a title of its own');
    expect(store.library().map((e) => e.title).sort()).toEqual(['Paxos', 'Raft']);
    expect(store.renameLibrary(a.id, { title: 'RAFT' })).toMatchObject({ ok: true, changed: true, entry: { title: 'RAFT' } });
    expect(store.meta(ANA, b.id)?.title).toBe('Paxos');
  });

  it('refuses in words what is not usable, and writes nothing: an id that is not a deck, an empty title, a week that is not one', () => {
    const a = add({ title: 'Raft', week: 5 });
    const index = fs.readFileSync(indexFile(), 'utf8');
    for (const id of ['../etc', '', 'xyz', idOf(999)]) expect(store.renameLibrary(id, { title: 'x' }), id).toMatchObject({ ok: false, reason: 'not-found' });
    expect(store.renameLibrary(a.id, { title: '   ' })).toMatchObject({ ok: false, reason: 'bad-input', message: 'the title is empty' });
    for (const week of [0, 31, 2.5, NaN]) expect(store.renameLibrary(a.id, { week }), String(week)).toMatchObject({ ok: false, reason: 'bad-input' });
    expect(fs.readFileSync(indexFile(), 'utf8')).toBe(index);
    expect(store.meta(ANA, a.id)?.title).toBe('Raft');
  });

  it('makes a title one line of at most 120 characters, like the title of any deck', () => {
    const a = add({ title: 'Raft' });
    const r = store.renameLibrary(a.id, { title: `Week 5${String.fromCharCode(0x202e)}${String.fromCharCode(10)}  Raft ${'x'.repeat(300)}` });
    if (!r.ok) throw new Error('not renamed');
    expect(r.entry.title).toHaveLength(120);
    expect(r.entry.title.startsWith('Week 5 Raft x')).toBe(true);
    expect(r.entry.title.endsWith(String.fromCharCode(0x2026))).toBe(true);
    expect(r.entry.title.includes(String.fromCharCode(0x202e))).toBe(false);
  });

  it("never changes a directory that is not a row of the index: a student's document or something put there by hand", () => {
    const own = store.commit({ folder: ANA, title: 'Mine', origin: 'upload', pages: [{ image: png(), ext: 'png', words }] });
    if (!own.ok) throw new Error('not kept');
    add({ title: 'Raft' });
    const hand = path.join(store.courseRoot, idOf(555));
    fs.mkdirSync(hand, { recursive: true });
    fs.writeFileSync(path.join(hand, 'meta.json'), JSON.stringify({ id: idOf(555), title: 'By hand', pages: 1, origin: 'course', createdAt: 1, bytes: 1 }));
    expect(store.renameLibrary(own.meta.id, { title: 'Taken' })).toMatchObject({ ok: false, reason: 'not-found' });
    expect(store.renameLibrary(idOf(555), { title: 'Taken' })).toMatchObject({ ok: false, reason: 'not-found' });
    expect(JSON.parse(fs.readFileSync(path.join(hand, 'meta.json'), 'utf8')).title).toBe('By hand');
    expect(store.meta(ANA, own.meta.id)?.title).toBe('Mine');
  });

  it("puts the deck's meta back when the index cannot be written, so that the two still agree, and says it failed", () => {
    const a = add({ title: 'Raft', week: 5 });
    const index = fs.readFileSync(indexFile(), 'utf8');
    const real = fs.writeFileSync;
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).includes('index.json')) throw new Error('disk full');
      return (real as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync;
    let r;
    try {
      r = store.renameLibrary(a.id, { title: 'Raft, the slides', week: 6 });
    } finally {
      (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = real;
    }
    expect(r).toMatchObject({ ok: false, reason: 'failed' });
    expect(store.meta(ANA, a.id)?.title).toBe('Raft');
    expect(fs.readFileSync(indexFile(), 'utf8')).toBe(index);
    expect(fs.readdirSync(store.courseRoot).sort()).toEqual([a.id, 'index.json']);
    expect(store.renameLibrary(a.id, { title: 'Raft, the slides', week: 6 })).toMatchObject({ ok: true, changed: true }); // and the library still works
  });

  it('holds the library to one writer at a time, like every other change', () => {
    const a = add({ title: 'Raft' });
    const lock = path.join(store.courseRoot, '.lock');
    fs.mkdirSync(lock);
    const r = store.renameLibrary(a.id, { title: 'Blocked' });
    expect(r).toMatchObject({ ok: false, reason: 'failed' });
    expect((r as { message: string }).message).toContain('another command');
    fs.rmSync(lock, { recursive: true });
    expect(store.meta(ANA, a.id)?.title).toBe('Raft');
  });
});

describe('what an index file may hold, and what a deck\'s directory may', () => {
  it('leaves out a row whose directory or meta is missing or damaged, and a row that is not a row', () => {
    const a = add({ title: 'A', sha256: SHA('1') });
    const b = add({ title: 'B', sha256: SHA('2') });
    const c = add({ title: 'C', sha256: SHA('3') });
    fs.rmSync(path.join(store.courseRoot, b.id), { recursive: true });
    fs.writeFileSync(path.join(store.courseRoot, c.id, 'meta.json'), 'not json');
    const text = fs.readFileSync(indexFile(), 'utf8');
    const parsed = JSON.parse(text) as { entries: unknown[] };
    parsed.entries.push('junk', { id: '../../x', title: 'T' });
    fs.writeFileSync(indexFile(), JSON.stringify(parsed));
    expect(store.library().map((e) => e.id)).toEqual([a.id]);
  });

  it('is not followed out of the library by a link (a row\'s directory that is a link is no deck) and reads an index only when it is a regular file', () => {
    const a = add({ title: 'A', sha256: SHA('1') });
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'meta.json'), JSON.stringify({ id: a.id, title: 'Outside', pages: 1, origin: 'course', createdAt: 1, bytes: 1 }));
    fs.rmSync(path.join(store.courseRoot, a.id), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(store.courseRoot, a.id), 'dir');
    } catch {
      return; // a platform that does not let this user make links
    }
    const fresh = new DocStore(dir, { now: () => clock }); // (a store that has not read the library before: one that has keeps its list until the index file changes)
    expect(fresh.library()).toEqual([]);
    expect(fresh.meta(ANA, a.id)).toBeNull();
    expect(fresh.pageTexts(a.id)).toBeNull();
  });

  it('gives the text of each page of a deck for the search (an empty string for a page with no words file) and nothing for a name that is not an id or a deck', () => {
    const a = add({ title: 'A', sha256: SHA('1') }, 3);
    fs.rmSync(path.join(store.courseRoot, a.id, 'w002.json'));
    fs.writeFileSync(path.join(store.courseRoot, a.id, 'w003.json'), 'not json');
    expect(store.pageTexts(a.id)).toEqual(['Alpha Beta gamma\nsecond line here', '', '']);
    expect(store.pageTexts('../x')).toBeNull();
    expect(store.pageTexts(idOf(4040))).toBeNull();
    expect(store.pageTexts(undefined as never)).toBeNull();
  });

  it('is not touched by the sweep and not counted for any student', () => {
    const a = add();
    clock += 400 * 86_400_000;
    expect(store.sweep()).toBe(0);
    expect(store.library().map((e) => e.id)).toEqual([a.id]);
    expect(store.usage(ANA)).toEqual({ docs: 0, bytes: 0 });
  });
});
