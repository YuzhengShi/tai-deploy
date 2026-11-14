import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLibraryAdmin, forOperator } from './library.js';
import type { LibraryAdmin } from './library.js';
import { createRenderer } from './render.js';
import { DocStore } from './store.js';
import { FakeDocker, pdfBytes, writeOutput } from './testing/harness.js';
import { DOC_LIMITS } from './types.js';

let dir: string;
let docker: FakeDocker;
let store: DocStore;
let admin: LibraryAdmin;
let counter: number;

const idOf = (n: number): string => n.toString(16).padStart(32, '0');
const zip = (extra = 300): Buffer => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]), Buffer.alloc(extra, 5)]);
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-docs-'));
  docker = new FakeDocker();
  docker.behave = async (ctl) => {
    writeOutput(ctl.outDir, 3, { inFile: 3 });
    return { exitCode: 0 };
  };
  counter = 0;
  store = new DocStore(path.join(dir, 'store'), { newId: () => idOf(++counter), log });
  admin = createLibraryAdmin({ store, renderer: createRenderer({ dir: path.join(dir, 'data'), log, docker, hostUser: { uid: 1000, gid: 1000 }, operator: true }) });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('adding a deck', () => {
  it('renders a PDF and keeps it as a deck of the library: the title from the name, the week from the name, one render, the operator\'s own label on the container', async () => {
    const r = await admin.add({ bytes: pdfBytes(), name: 'Week_5_Raft_consensus.pdf' });
    expect(r).toMatchObject({ ok: true, status: 'added', entry: { title: 'Week 5 Raft consensus', week: 5, pages: 3, sourceName: 'Week_5_Raft_consensus.pdf', origin: 'course' } });
    expect(docker.specs).toHaveLength(1);
    expect(docker.specs[0].args.at(-3)).toBe('pdf');
    expect(docker.specs[0].args.join(' ')).toContain('--label tai-doc-operator=1');
    expect(admin.list().map((e) => e.title)).toEqual(['Week 5 Raft consensus']);
    expect(store.text('s_' + 'a1'.repeat(10), idOf(1), 1)).toBe('Alpha Beta gamma\nsecond line here'); // any student reads it
  });

  it('sends a zip to the container as an Office file, and keeps the deck it makes', async () => {
    const r = await admin.add({ bytes: zip(), name: 'Raft slides.pptx', title: 'Raft, the slides', week: 7 });
    expect(r).toMatchObject({ ok: true, status: 'added', entry: { title: 'Raft, the slides', week: 7, pages: 3 } });
    expect(docker.specs[0].args.slice(-4)[1]).toBe('office');
  });

  it('does not add the same file twice (its SHA-256), whatever it is called, and does not start a container for it', async () => {
    const first = await admin.add({ bytes: pdfBytes(), name: 'a.pdf' });
    const again = await admin.add({ bytes: pdfBytes(), name: 'copy of a.pdf', title: 'Another title' });
    expect(first.ok && again.ok && again.status === 'already' && first.ok && again.entry.id === (first.ok ? first.entry.id : '')).toBe(true);
    expect(docker.specs).toHaveLength(1);
    expect(admin.list()).toHaveLength(1);
  });

  it('takes the week the operator gave, then the one the name says, and none when the operator said none', async () => {
    const a = await admin.add({ bytes: pdfBytes(10, 1), name: 'W3 containers.pdf' });
    const b = await admin.add({ bytes: pdfBytes(10, 2), name: 'W3 other.pdf', week: 9 });
    const c = await admin.add({ bytes: pdfBytes(10, 3), name: 'W3 third.pdf', week: null });
    const d = await admin.add({ bytes: pdfBytes(10, 4), name: 'syllabus.pdf' });
    expect([a, b, c, d].map((r) => (r.ok ? r.entry.week : 'x'))).toEqual([3, 9, null, null]);
  });

  it('says in plain words why it did not add a file, and the container is never started for a file that is not a document, empty or too big', async () => {
    const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
    expect(await admin.add({ bytes: Buffer.alloc(0), name: 'empty.pdf' })).toEqual({ ok: false, message: 'the file is empty' });
    expect(await admin.add({ bytes: Buffer.alloc(DOC_LIMITS.sourceBytes + 1, 1), name: 'huge.pdf' })).toEqual({ ok: false, message: 'the file is over 20 MB' });
    expect(await admin.add({ bytes: Buffer.from('plain text'), name: 'notes.pdf' })).toEqual({ ok: false, message: 'not a PDF, PowerPoint, Word or Excel file' });
    const old = await admin.add({ bytes: OLE, name: 'old.ppt' });
    expect(!old.ok && old.message).toContain('older Office file');
    expect(docker.specs).toEqual([]);
  });

  it('passes on what the renderer said without the instruction it gives a model, and says when the image is not built', async () => {
    docker.behave = async (ctl) => {
      ctl.write('doc: the file contains macros.\n');
      return { exitCode: 2 };
    };
    const r = await admin.add({ bytes: zip(), name: 'macro.docx' });
    expect(r).toEqual({ ok: false, message: 'That file contains macros, which the viewer does not run or open.' });
    expect(admin.list()).toEqual([]);
    docker.image = false;
    const off = createLibraryAdmin({ store, renderer: createRenderer({ dir: path.join(dir, 'data2'), log, docker, hostUser: { uid: 1000, gid: 1000 }, operator: true }) });
    expect(await off.add({ bytes: pdfBytes(), name: 'x.pdf' })).toEqual({ ok: false, message: 'the renderer image is not built: tai_live.sh doc build' });
  });

  it('refuses a second deck with the title of one the library has, naming the way out', async () => {
    await admin.add({ bytes: pdfBytes(10, 1), name: 'Raft.pdf' });
    const r = await admin.add({ bytes: pdfBytes(10, 2), name: 'raft.pdf' });
    expect(!r.ok && r.message).toContain('a title of its own');
    const fine = await admin.add({ bytes: pdfBytes(10, 2), name: 'raft.pdf', title: 'Raft, the second deck' });
    expect(fine.ok).toBe(true);
  });
});

describe('removing a deck', () => {
  it('takes it out by its id or by the start of it (six characters or more that name one deck), and says what it did not understand', async () => {
    const a = await admin.add({ bytes: pdfBytes(10, 1), name: 'A.pdf' });
    const b = await admin.add({ bytes: pdfBytes(10, 2), name: 'B.pdf' });
    if (!a.ok || !b.ok || a.status !== 'added' || b.status !== 'added') throw new Error('not added');
    expect(admin.remove('xyz')).toMatchObject({ ok: false });
    expect(admin.remove('')).toMatchObject({ ok: false });
    expect(admin.remove('../etc')).toMatchObject({ ok: false });
    expect(admin.remove('000000')).toMatchObject({ ok: false, message: 'more than one deck starts with that: give more of the id' }); // (both ids start with 30 zeros)
    expect(admin.remove(idOf(99))).toMatchObject({ ok: false, message: 'no deck of the library has that id' });
    expect(admin.remove(a.entry.id.slice(0, 31).toUpperCase() + '1')).toEqual({ ok: true, title: 'A' });
    expect(admin.list().map((e) => e.title)).toEqual(['B']);
    expect(admin.remove(b.entry.id)).toEqual({ ok: true, title: 'B' });
    expect(admin.list()).toEqual([]);
  });
});

describe('renaming a deck', () => {
  it('changes the title and the week of a deck by its id or the start of it, says what went wrong as removing one does, and starts no container', async () => {
    const a = await admin.add({ bytes: pdfBytes(10, 1), name: 'day5-apis.pdf' });
    const b = await admin.add({ bytes: pdfBytes(10, 2), name: 'B.pdf' });
    if (!a.ok || !b.ok || a.status !== 'added' || b.status !== 'added') throw new Error('not added');
    expect(admin.rename('xyz', { title: 'x' })).toMatchObject({ ok: false });
    expect(admin.rename('', { title: 'x' })).toMatchObject({ ok: false });
    expect(admin.rename('000000', { title: 'x' })).toMatchObject({ ok: false, message: 'more than one deck starts with that: give more of the id' }); // (both ids start with 30 zeros)
    expect(admin.rename(idOf(99), { title: 'x' })).toMatchObject({ ok: false, message: 'no deck of the library has that id' });
    const r = admin.rename(a.entry.id.slice(0, 31).toUpperCase() + '1', { title: 'Day 5 - APIs and Load Balancers', week: 5 });
    expect(r).toMatchObject({ ok: true, changed: true, before: { title: 'day5-apis', week: null }, entry: { id: a.entry.id, title: 'Day 5 - APIs and Load Balancers', week: 5 } });
    expect(admin.list().map((e) => [e.title, e.week])).toEqual([['Day 5 - APIs and Load Balancers', 5], ['B', null]]);
    expect((admin.rename(a.entry.id, { title: 'b' }) as { message: string }).message).toContain('a title of its own');
    expect(admin.rename(a.entry.id, { title: '  ' })).toEqual({ ok: false, message: 'the title is empty' });
    expect(admin.rename(a.entry.id, {})).toMatchObject({ ok: true, changed: false });
    expect(docker.specs).toHaveLength(2); // the two adds; a rename never starts a container
  });
});

describe('what an operator reads', () => {
  it('is the host\'s sentence without the instruction to a model that follows it', () => {
    expect(forOperator('That file is not a PDF. Say so in a short sentence and suggest a PDF.')).toBe('That file is not a PDF.');
    expect(forOperator('Not found.   Say so in one short sentence and go on.')).toBe('Not found.');
    expect(forOperator('Plain sentence')).toBe('Plain sentence');
  });
});
