import { describe, expect, it } from 'vitest';

import { cleanObject, clipObject, objectSummary } from './clean.js';
import { OBJECT_JSON_MAX, RUN_OUTPUT_CHARS } from './types.js';

const DOC = 'a'.repeat(32);

describe('cleanObject: run', () => {
  const run = { t: 'run', command: 'go test ./...', ok: true, exitCode: 1, timedOut: false, durationMs: 14_200, output: '--- FAIL: TestAdd (0.00s)\nFAIL', truncated: false };

  it('keeps a well formed card as it is', () => {
    expect(cleanObject(run)).toEqual(run);
  });

  it('drops fields it does not know and cleans the rest', () => {
    const bel = String.fromCharCode(7);
    const esc = String.fromCharCode(27);
    const got = cleanObject({ ...run, command: `go${bel} run   .`, html: '<b>x</b>', output: `a${esc}[31mred${esc}[0m\r\nb`, note: '  ran out of memory  ' });
    expect(got).toEqual({ ...run, command: 'go run .', output: 'ared\nb', note: 'ran out of memory' });
    expect(got && 'html' in got).toBe(false);
  });

  it('puts numbers in range and says null for a missing exit code', () => {
    expect(cleanObject({ ...run, exitCode: null })).toMatchObject({ exitCode: null });
    expect(cleanObject({ ...run, exitCode: 99_999 })).toMatchObject({ exitCode: null });
    expect(cleanObject({ ...run, exitCode: 1.5 })).toMatchObject({ exitCode: null });
    expect(cleanObject({ ...run, durationMs: -5 })).toMatchObject({ durationMs: 0 });
    expect(cleanObject({ ...run, durationMs: 1e12 })).toMatchObject({ durationMs: 600_000 });
    expect(cleanObject({ ...run, ok: 'yes', timedOut: 1 })).toMatchObject({ ok: false, timedOut: false });
  });

  it('cuts a long output in the middle and says it was cut', () => {
    const long = 'x'.repeat(RUN_OUTPUT_CHARS * 3);
    const got = cleanObject({ ...run, output: long });
    expect(got?.t === 'run' && got.output.length).toBeLessThanOrEqual(RUN_OUTPUT_CHARS + 80);
    expect(got).toMatchObject({ truncated: true });
  });

  it('is nothing without a command', () => {
    expect(cleanObject({ ...run, command: '   ' })).toBeNull();
    expect(cleanObject({ ...run, command: 42 })).toBeNull();
  });
});

describe('cleanObject: doc', () => {
  const doc = { t: 'doc', doc: DOC, title: 'Raft slides', pages: 32, page: 7, origin: 'canvas' };

  it('keeps a well formed card', () => {
    expect(cleanObject(doc)).toEqual(doc);
    expect(cleanObject({ t: 'doc', doc: DOC, title: 'T', pages: 1 })).toEqual({ t: 'doc', doc: DOC, title: 'T', pages: 1 });
  });

  it('is nothing for an id that is not a prepared document, a title that says nothing or a page count out of range', () => {
    expect(cleanObject({ ...doc, doc: '../etc/passwd' })).toBeNull();
    expect(cleanObject({ ...doc, doc: 'A'.repeat(32) })).toBeNull();
    expect(cleanObject({ ...doc, title: '' })).toBeNull();
    expect(cleanObject({ ...doc, pages: 0 })).toBeNull();
    expect(cleanObject({ ...doc, pages: 501 })).toBeNull();
  });

  it('forgets a start page past the end and an origin it does not know', () => {
    expect(cleanObject({ ...doc, page: 40 })).toEqual({ t: 'doc', doc: DOC, title: 'Raft slides', pages: 32, origin: 'canvas' });
    expect(cleanObject({ ...doc, origin: 'elsewhere' })).toEqual({ t: 'doc', doc: DOC, title: 'Raft slides', pages: 32, page: 7 });
  });
});

describe('cleanObject: the rest', () => {
  it('says null for what is not an object of a known type', () => {
    for (const raw of [null, undefined, 'run', 5, [], {}, { t: 'video' }, { t: 'RUN' }, { type: 'run' }]) expect(cleanObject(raw)).toBeNull();
  });

  it('refuses a chart, a trace or a prediction that has nothing in it (their own tests are in batch-c-objects.test.ts)', () => {
    for (const t of ['chart', 'trace', 'predict']) expect(cleanObject({ t })).toBeNull();
  });

  it('keeps the whole to at most OBJECT_JSON_MAX', () => {
    expect(OBJECT_JSON_MAX).toBe(24_000);
    const big = { t: 'run', command: 'go run .', ok: true, exitCode: 0, timedOut: false, durationMs: 1, output: 'y'.repeat(RUN_OUTPUT_CHARS), truncated: false };
    expect(JSON.stringify(cleanObject(big)).length).toBeLessThan(OBJECT_JSON_MAX);
  });
});

describe('objectSummary and clipObject', () => {
  it('say what a card is on one line', () => {
    expect(objectSummary({ t: 'run', command: 'go test ./...', ok: true, exitCode: 1, timedOut: false, durationMs: 14_200, output: '', truncated: false })).toBe('Ran go test ./... (exit 1, 14.2 s)');
    expect(objectSummary({ t: 'run', command: 'go run .', ok: true, exitCode: null, timedOut: true, durationMs: 20_000, output: '', truncated: false })).toBe('Ran go run . (stopped at the time limit, 20 s)');
    expect(objectSummary({ t: 'run', command: 'go run .', ok: false, exitCode: null, timedOut: false, durationMs: 0, output: '', truncated: false, note: 'busy' })).toBe('Did not run go run .');
    expect(objectSummary({ t: 'doc', doc: DOC, title: 'Raft slides', pages: 32 })).toBe('Document: Raft slides (32 pages)');
    expect(objectSummary({ t: 'doc', doc: DOC, title: 'One', pages: 1 })).toBe('Document: One (1 page)');
  });

  it('clipObject is the cleaned object with its summary, or null', () => {
    const got = clipObject({ t: 'doc', doc: DOC, title: 'Raft slides', pages: 32, extra: 1 });
    expect(got).toEqual({ text: 'Document: Raft slides (32 pages)', obj: { t: 'doc', doc: DOC, title: 'Raft slides', pages: 32 } });
    expect(clipObject({ t: 'doc' })).toBeNull();
  });
});
