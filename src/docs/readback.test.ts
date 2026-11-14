import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { META_FILE_BYTES, WORDS_FILE_BYTES, imageInfo, readbackOutput, sniffType } from './readback.js';
import { ALPHA_WORDS, jpeg, png, wordsFile, writeOutput } from './testing/harness.js';
import { DOC_LIMITS } from './types.js';

let out: string;
beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-readback-'));
});
afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

const put = (name: string, body: Buffer | string) => fs.writeFileSync(path.join(out, name), body);
/** An empty output directory again (a test that builds several outputs one after the other). */
const reset = () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
};
const limits = { maxPages: DOC_LIMITS.pages, maxBytes: DOC_LIMITS.perStudentBytes };

describe('what an image is, from its first bytes', () => {
  it('reads the size a PNG says in its header and the size of a JPEG\'s frame (baseline, extended and progressive), and nothing else', () => {
    expect(imageInfo(png(850, 1100))).toEqual({ type: 'image/png', ext: 'png', width: 850, height: 1100 });
    for (const marker of [0xc0, 0xc1, 0xc2]) expect(imageInfo(jpeg(1100, 825, 400, marker))).toEqual({ type: 'image/jpeg', ext: 'jpg', width: 1100, height: 825 });
    expect(sniffType(png().subarray(0, 16))).toBe('image/png');
    expect(sniffType(jpeg().subarray(0, 16))).toBe('image/jpeg');
    for (const bad of [Buffer.alloc(0), Buffer.from('GIF89a' + 'x'.repeat(40)), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('%PDF-1.4'), Buffer.alloc(100, 0)]) {
      expect(imageInfo(bad)).toBeNull();
      expect(sniffType(bad)).toBeNull();
    }
  });

  it('refuses a PNG whose first chunk is not a 13 byte IHDR or whose size is zero, and a JPEG with no frame header, a lossless or arithmetic one, or one cut short', () => {
    const broken = png();
    broken.writeUInt32BE(12, 8);
    expect(imageInfo(broken)).toBeNull();
    const notIhdr = png();
    notIhdr.write('IDAT', 12, 'latin1');
    expect(imageInfo(notIhdr)).toBeNull();
    expect(imageInfo(png(0, 100))).toBeNull();
    expect(imageInfo(png(100, 0))).toBeNull();
    expect(imageInfo(jpeg(100, 100, 400, 0xc3))).toBeNull(); // lossless
    expect(imageInfo(jpeg(100, 100, 400, 0xc9))).toBeNull(); // arithmetic coding
    expect(imageInfo(jpeg(0, 100))).toBeNull();
    expect(imageInfo(jpeg().subarray(0, 40))).toBeNull(); // cut before the frame header
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]))).toBeNull(); // data before any frame
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('gives up on a JPEG whose segments never end instead of looping', () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 400 }, () => Buffer.from([0xff, 0xe1, 0x00, 0x04, 0x41, 0x41]))]);
    expect(imageInfo(body)).toBeNull();
  });
});

describe('the output directory of a render', () => {
  it('takes the pages in order with their words, the aspect from page 1 itself and the number of pages the file has', () => {
    writeOutput(out, 3, { inFile: 9, image: (n) => (n === 2 ? jpeg(1100, 825) : png(850, 1100)) });
    const r = readbackOutput(out, limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages.map((p) => p.info.ext)).toEqual(['png', 'jpg', 'png']);
    expect(r.pages.map((p) => `${p.info.width}x${p.info.height}`)).toEqual(['850x1100', '1100x825', '850x1100']);
    expect(r.pages[0].words.words[0][4]).toBe('Alpha');
    expect(r.pages[0].words.lines).toEqual([[0, 2], [3, 5]]);
    expect(r.aspect).toBe(0.7727);
    expect(r.pagesInFile).toBe(9);
    expect(r.drawn).toBe(3);
    expect(r.cutByRoom).toBe(false);
    expect(r.wordsRejected).toBe(0);
  });

  it('does not take the container\'s word for the aspect or the number of pages: both come from the images, and pagesInFile only when it is a whole number above the pages kept', () => {
    writeOutput(out, 2, { meta: { pages: 99, pagesInFile: 2, aspect: 7 } });
    let r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(2);
    expect(r.ok && r.aspect).toBe(0.7727);
    expect(r.ok && 'pagesInFile' in r).toBe(false); // not above the pages kept: nothing to say
    for (const odd of [{ pagesInFile: 2.5 }, { pagesInFile: -4 }, { pagesInFile: '40' }, { pagesInFile: 1e12 }, { pagesInFile: null }, [], 'x']) {
      put('meta.json', JSON.stringify(odd));
      r = readbackOutput(out, limits);
      expect(r.ok && 'pagesInFile' in r).toBe(false);
    }
    put('meta.json', '{"pagesInFile": 40');
    expect(readbackOutput(out, limits).ok).toBe(true); // meta.json that does not parse is no meta
    put('meta.json', JSON.stringify({ pagesInFile: 40, padding: 'x'.repeat(META_FILE_BYTES) }));
    expect(readbackOutput(out, limits)).toMatchObject({ ok: true }); // too big to read: no meta
    const big = readbackOutput(out, limits);
    expect(big.ok && 'pagesInFile' in big).toBe(false);
  });

  it('keeps the run of pages up to the first one that is missing, bad or ambiguous, and nothing after it', () => {
    writeOutput(out, 5);
    fs.rmSync(path.join(out, 'p003.png'));
    let r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(2);
    expect(r.ok && r.drawn).toBe(2);
    reset();
    writeOutput(out, 5);
    put('p003.jpg', jpeg()); // a PNG and a JPEG for page 3: which is the page?
    r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(2);
    reset();
    writeOutput(out, 5);
    put('p004.png', Buffer.from('<html><script>alert(1)</script></html>'));
    r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(3);
  });

  it('stops at an image over the size of a page image and at one that says it is bigger than a page image may be (a small file can say it is 50000 pixels wide)', () => {
    writeOutput(out, 4, { image: (n) => (n === 3 ? png(850, 1100, DOC_LIMITS.imageBytes + 1) : png()) });
    expect(readbackOutput(out, limits)).toMatchObject({ ok: true, pages: expect.any(Array) });
    let r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(2);
    reset();
    writeOutput(out, 4, { image: (n) => (n === 2 ? png(50_000, 50_000) : png()) });
    r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(1);
    reset();
    writeOutput(out, 4, { image: (n) => (n === 2 ? jpeg(1100 + 5, 100) : n === 3 ? jpeg(1100 + 4, 100) : png()) });
    r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(1);
    reset();
    writeOutput(out, 2, { image: () => png(1104, 800) });
    expect(readbackOutput(out, limits)).toMatchObject({ ok: true }); // the last pixel of rounding is allowed
  });

  it('fails when the first page is not there or does not pass', () => {
    expect(readbackOutput(out, limits)).toMatchObject({ ok: false, reason: 'no-pages' });
    put('meta.json', '{"pages":3,"pagesInFile":3}');
    put('p002.png', png()); // a gap before the first page is no page
    expect(readbackOutput(out, limits)).toMatchObject({ ok: false, reason: 'no-pages' });
    put('p001.png', Buffer.from('not an image at all, ' + 'x'.repeat(100)));
    expect(readbackOutput(out, limits)).toMatchObject({ ok: false, reason: 'no-pages' });
    expect(readbackOutput(path.join(out, 'nope'), limits)).toMatchObject({ ok: false, reason: 'bad-output' });
  });

  it('takes a words file only through validateWords: what does not pass is no words, and counted; a missing one is no words (a scan)', () => {
    writeOutput(out, 5, {
      words: (n) =>
        n === 1
          ? wordsFile(ALPHA_WORDS)
          : n === 2
            ? '{"words": "not a list"}'
            : n === 3
              ? JSON.stringify({ words: Array.from({ length: DOC_LIMITS.wordsPerPage + 1 }, () => [0, 0, 1, 1, 'w']) })
              : n === 4
                ? 'not json at all'
                : null,
    });
    const r = readbackOutput(out, limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pages.map((p) => p.words.words.length)).toEqual([6, 0, 0, 0, 0]);
    expect(r.wordsRejected).toBe(3);
    // numbers outside the page are clamped by the gate, words with no text are dropped, a box turned round is put right
    reset();
    writeOutput(out, 1, { words: () => JSON.stringify({ words: [[-3, 0.5, 9, 0.2, 'wide'], [0.1, 0.1, 0.2, 0.2, '   '], [0.3, 0.3, 'x', 0.4, 'bad']], lines: [[0, 2]] }) });
    const clamped = readbackOutput(out, limits);
    expect(clamped.ok && clamped.pages[0].words.words).toEqual([[0, 0.2, 1, 0.5, 'wide']]);
    put('w001.json', Buffer.alloc(WORDS_FILE_BYTES + 1, 0x20));
    const huge = readbackOutput(out, limits);
    expect(huge.ok && huge.wordsRejected).toBe(1); // too big to read
  });

  it('never opens a file whose name is not one of the three it looks for, and counts every entry against a cap', () => {
    writeOutput(out, 2);
    put('p001.png.bak', 'x');
    put('p01.png', png());
    put('P001.png', png());
    put('w001.json.tmp', '{}');
    put('secret.txt', 'x');
    fs.mkdirSync(path.join(out, 'p003.png')); // a directory with a page's name: not a regular file
    const r = readbackOutput(out, limits);
    expect(r.ok && r.pages.length).toBe(2);
    const crowded = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-readback-many-'));
    try {
      writeOutput(crowded, 1);
      for (let i = 0; i < 2 * DOC_LIMITS.pages + 8; i++) fs.writeFileSync(path.join(crowded, `junk-${i}`), '');
      expect(readbackOutput(crowded, limits)).toMatchObject({ ok: false, reason: 'bad-output' });
    } finally {
      fs.rmSync(crowded, { recursive: true, force: true });
    }
  });

  it('does not follow a link: a page that is a link to a file of the host is not a page', () => {
    const secret = path.join(os.tmpdir(), `doc-readback-secret-${process.pid}.png`);
    fs.writeFileSync(secret, png());
    try {
      writeOutput(out, 3);
      fs.rmSync(path.join(out, 'p002.png'));
      try {
        fs.symlinkSync(secret, path.join(out, 'p002.png'));
      } catch {
        return; // (a platform that does not let this user make links: the check is the same code on the host, where it can be made)
      }
      const r = readbackOutput(out, limits);
      expect(r.ok && r.pages.length).toBe(1);
      fs.rmSync(path.join(out, 'p002.png'));
      writeOutput(out, 3);
      fs.rmSync(path.join(out, 'w001.json'));
      fs.symlinkSync(secret, path.join(out, 'w001.json'));
      const words = readbackOutput(out, limits);
      expect(words.ok && words.pages[0].words.words).toEqual([]);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  it('keeps only the pages that fit the room and says it did, with how many were drawn', () => {
    writeOutput(out, 6, { inFile: 6, image: () => png(850, 1100, 200_000) });
    const roomFor3 = 3 * (200_000 + JSON.stringify(JSON.parse(wordsFile(ALPHA_WORDS))).length) + 10;
    const r = readbackOutput(out, { maxPages: 120, maxBytes: roomFor3 });
    expect(r.ok && r.pages.length).toBe(3);
    expect(r.ok && r.cutByRoom).toBe(true);
    expect(r.ok && r.drawn).toBe(6);
    expect(r.ok && r.pagesInFile).toBe(6);
    const cap = readbackOutput(out, { maxPages: 6, maxBytes: 1e9 });
    expect(cap.ok && cap.pages.length).toBe(6);
    expect(cap.ok && cap.cutByRoom).toBe(false);
    reset();
    writeOutput(out, 4);
    const few = readbackOutput(out, { maxPages: 2, maxBytes: 1e9 }); // the renderer was asked for 2 pages and made 4: a directory with more than 2 x 2 + 8 entries is refused whole
    expect(few.ok && few.pages.length).toBe(2);
    reset();
    writeOutput(out, 6);
    expect(readbackOutput(out, { maxPages: 2, maxBytes: 1e9 })).toMatchObject({ ok: false, reason: 'bad-output' });
  });
});
