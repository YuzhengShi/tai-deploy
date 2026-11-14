import { describe, expect, it, vi } from 'vitest';

import { chooseDoc, resolveDocName } from './resolve.js';
import type { CanvasFilesResult, DocMeta } from './types.js';

// The course's Canvas files as the last place a name is looked for (docs/COURSE_DOCS.md, "Canvas files"): what the student has, the library's decks and their attached files come first, and only a name that
// matches none of those reaches Canvas.

const meta = (n: number, title: string): DocMeta => ({ id: n.toString(16).padStart(32, '0'), title, pages: 10, origin: 'upload', createdAt: n, bytes: 1 });
const CANVAS = [
  { id: 41, name: 'Day 4 ACID 2PC and Consensus.pdf' },
  { id: 52, name: 'Homework 5 spec.pdf' },
  { id: 53, name: 'Homework 5 starter notes.docx' },
  { id: 60, name: 'Syllabus.pdf' },
  { id: 61, name: 'syllabus.pdf' },
];
const listed = (): CanvasFilesResult => ({ ok: true, files: CANVAS.map((c) => ({ ...c, kind: 'pdf' as const, size: 1000 })) });

describe('a name that is a Canvas file', () => {
  it('is found by the file name (the extension, the case and the punctuation do not matter), and by a part of it', () => {
    const have = { titles: [], uploads: [], canvas: CANVAS };
    expect(resolveDocName('Day 4 ACID 2PC and Consensus.pdf', have)).toEqual({ kind: 'canvas', id: 41, name: 'Day 4 ACID 2PC and Consensus.pdf' });
    expect(resolveDocName('day 4: acid, 2pc and consensus', have)).toMatchObject({ kind: 'canvas', id: 41 });
    expect(resolveDocName('homework 5 spec', have)).toMatchObject({ kind: 'canvas', id: 52 });
    expect(resolveDocName('2PC', have)).toMatchObject({ kind: 'canvas', id: 41 });
  });

  it('is the newest of two files with the same name', () => {
    expect(resolveDocName('syllabus', { titles: [], uploads: [], canvas: CANVAS })).toMatchObject({ kind: 'canvas', id: 61 });
  });

  it('is not guessed when several fit: the model is to ask, and told which', () => {
    const r = resolveDocName('homework 5', { titles: [], uploads: [], canvas: CANVAS });
    expect(r).toMatchObject({ kind: 'none', several: true });
    expect(r.kind === 'none' && r.hint).toContain('"Homework 5 spec.pdf", "Homework 5 starter notes.docx"');
    expect(r.kind === 'none' && r.hint).toContain('Ask which one they mean');
  });

  it('comes after everything the student has: their own document, the library\'s deck and their attached file win over a Canvas file of the same name', () => {
    const own = [meta(1, 'Homework 5 spec')];
    expect(resolveDocName('homework 5 spec', { titles: own, uploads: [], canvas: CANVAS })).toEqual({ kind: 'existing', id: own[0].id, title: 'Homework 5 spec' });
    expect(resolveDocName('Homework 5 spec.pdf', { titles: [], uploads: ['Homework_5_spec.pdf'], canvas: CANVAS })).toMatchObject({ kind: 'upload' });
    expect(resolveDocName('Homework_5_spec.pdf', { titles: [], uploads: ['Homework_5_spec.pdf'], canvas: CANVAS })).toEqual({ kind: 'upload', name: 'Homework_5_spec.pdf' });
  });

  it('is not looked for in a list that is not given: the answer is what it always was', () => {
    const r = resolveDocName('homework 5 spec', { titles: [meta(1, 'Raft paper')], uploads: [] });
    expect(r).toMatchObject({ kind: 'none' });
    expect(r.kind === 'none' && r.hint).toBe('Nothing matches that name. Prepared documents: "Raft paper". Ask them which one they mean, or to attach the file.');
  });

  it('is listed in the hint of a name that matches nothing, as quoted data, a few of them', () => {
    const r = resolveDocName('quantum computing', { titles: [], uploads: [], canvas: CANVAS });
    expect(r.kind === 'none' && r.hint).toContain('Files of the course on Canvas (some of them): "Day 4 ACID 2PC and Consensus.pdf"');
    expect(r.kind === 'none' && r.several).toBeUndefined();
  });
});

describe('the two steps of choosing a document', () => {
  it('looks at Canvas only when nothing of the student\'s matched, and says what it found', async () => {
    const canvasFiles = vi.fn(async () => listed());
    // a match among their own: Canvas is not asked
    expect((await chooseDoc('raft paper', [meta(1, 'Raft paper')], [], canvasFiles)).choice).toMatchObject({ kind: 'existing' });
    expect(canvasFiles).not.toHaveBeenCalled();
    // nothing matched: Canvas is asked, once, and its file is the choice
    const found = await chooseDoc('homework 5 spec', [meta(1, 'Raft paper')], [], canvasFiles);
    expect(found).toEqual({ choice: { kind: 'canvas', id: 52, name: 'Homework 5 spec.pdf' }, note: '' });
    expect(canvasFiles).toHaveBeenCalledTimes(1);
  });

  it('does not look at Canvas for a name that several of the student\'s own fit: the model asks which', async () => {
    const canvasFiles = vi.fn(async () => listed());
    const r = await chooseDoc('notes', [meta(1, 'Raft notes'), meta(2, 'Paxos notes')], [], canvasFiles);
    expect(r.choice).toMatchObject({ kind: 'none', several: true });
    expect(canvasFiles).not.toHaveBeenCalled();
  });

  it('says that Canvas could not be looked at, after the hint, when it did not answer, and is the local answer when there is no Canvas', async () => {
    const down = await chooseDoc('homework 5 spec', [meta(1, 'Raft paper')], [], async () => ({ ok: false, message: 'Canvas did not answer just now. Say so in one short sentence.' }));
    expect(down.choice).toMatchObject({ kind: 'none' });
    expect(down.note).toBe(' Canvas did not answer just now. Say so in one short sentence.');
    const thrown = await chooseDoc('homework 5 spec', [meta(1, 'Raft paper')], [], async () => {
      throw new Error('boom');
    });
    expect(thrown.choice).toMatchObject({ kind: 'none' });
    expect(thrown.note).toBe('');
    const none = await chooseDoc('homework 5 spec', [meta(1, 'Raft paper')], [], undefined);
    expect(none.choice).toMatchObject({ kind: 'none' });
    expect(none.note).toBe('');
    // Canvas set up but with no file that fits: the hint is the local one, with the names there are
    const empty = await chooseDoc('homework 5 spec', [], [], async () => ({ ok: true, files: [] }));
    expect(empty.choice).toMatchObject({ kind: 'none' });
  });
});
