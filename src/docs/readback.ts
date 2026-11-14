/**
 * What the host takes back from the renderer container's output directory (docs/DOCUMENTS.md). The container wrote into a directory of the host's own, from a file nobody trusts, so
 * nothing in it is believed: the directory is walked with a cap on the entries, only files named `p<3 digits>.png|jpg`, `w<3 digits>.json` and `meta.json` are ever opened (anything else is
 * left where it is, never read), each is opened as a regular file without following a link (src/safe-fs.ts readBytesSafe: lstat, no-follow, no-block, size checked on the descriptor), a
 * page image must begin as a PNG or a JPEG and say a size no bigger than a page image may be, every words file goes through `validateWords`, and the numbers of meta.json are range checked.
 * The result is bytes the host then WRITES ITSELF (src/docs/store.ts): nothing the container made is moved or linked into the store.
 *
 * The pages of a document are the run of images from page 1 up to the first one that is missing, bad or over the room there is: `pages` is counted here, from the images, never taken from the
 * container's own count. A page whose words are missing or do not pass has no words (a scan has none either).
 */
import fs from 'node:fs';
import path from 'node:path';

import { readBytesSafe } from '../safe-fs.js';
import { DOC_LIMITS } from './types.js';
import type { PageWords } from './types.js';
import { validateWords } from './words.js';

/** A words file is at most this (4,000 words of at most 40 characters and four numbers each, and the lines, are about 400 KB). */
export const WORDS_FILE_BYTES = 1024 * 1024;
export const META_FILE_BYTES = 4096;
/** A page image may be this much bigger than the size it was asked for (rounding up of the last pixel). */
const SIZE_SLACK_PX = 4;

export interface ImageInfo {
  type: 'image/png' | 'image/jpeg';
  ext: 'png' | 'jpg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether the first bytes are a PNG's or a JPEG's (and nothing about the rest): what a page image is called when it is served. null: neither. */
export function sniffType(head: Buffer): 'image/png' | 'image/jpeg' | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  return null;
}

/** What an image is, from its first bytes alone, and the size it says it is (a PNG's IHDR; a JPEG's baseline or progressive frame header). null: neither. */
export function imageInfo(bytes: Buffer): ImageInfo | null {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { type: 'image/png', ext: 'png', width, height } : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let i = 2;
    for (let markers = 0; markers < 256 && i + 4 <= bytes.length; markers++) {
      if (bytes[i] !== 0xff) return null;
      while (i < bytes.length && bytes[i] === 0xff) i++; // fill bytes
      const marker = bytes[i];
      i++;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (i + 7 > bytes.length) return null;
        const height = bytes.readUInt16BE(i + 3);
        const width = bytes.readUInt16BE(i + 5);
        return width > 0 && height > 0 ? { type: 'image/jpeg', ext: 'jpg', width, height } : null;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // markers with no length
      if (marker === 0xd9 || marker === 0xda) return null; // the end, or the data, before any frame header
      if (i + 2 > bytes.length) return null;
      i += bytes.readUInt16BE(i);
    }
  }
  return null;
}

export interface ReadbackPage {
  image: Buffer;
  info: ImageInfo;
  words: PageWords;
  /** The size of the words file as the host will write it. */
  wordsBytes: number;
}

export type Readback =
  | {
      ok: true;
      pages: ReadbackPage[];
      /** The pages the file has when meta.json said so and it is more than the pages kept. */
      pagesInFile?: number;
      /** Width over height of page 1, from the image itself. */
      aspect: number;
      /** Some pages that were drawn are not here: the room ran out. */
      cutByRoom: boolean;
      /** How many page images the output holds in an unbroken run from page 1 (by name: more than `pages` when the room ran out). */
      drawn: number;
      /** Words files that were there and did not pass. */
      wordsRejected: number;
    }
  | { ok: false; reason: 'no-pages' | 'bad-output'; detail: string };

export interface ReadbackLimits {
  maxPages: number;
  /** The most the pages may weigh together (images and words files): the room one student has. */
  maxBytes: number;
}

export const defaultReadbackLimits = (): ReadbackLimits => ({ maxPages: DOC_LIMITS.pages, maxBytes: DOC_LIMITS.perStudentBytes });

const IMAGE_NAME = /^p(\d{3})\.(png|jpg)$/;
const WORDS_NAME = /^w(\d{3})\.json$/;

const bad = (detail: string): Readback => ({ ok: false, reason: 'bad-output', detail });

/** The numbers of meta.json that are used: pagesInFile only, and only when it is a whole number in range. */
function metaPagesInFile(outDir: string): number | undefined {
  const bytes = readBytesSafe(path.join(outDir, 'meta.json'), META_FILE_BYTES, outDir);
  if (!bytes) return undefined;
  try {
    const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const n = raw.pagesInFile;
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function readbackOutput(outDir: string, limits: ReadbackLimits = defaultReadbackLimits()): Readback {
  const images = new Map<number, string[]>();
  const wordsFiles = new Map<number, string>();
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(outDir);
  } catch {
    return bad('the output directory could not be read');
  }
  const entryCap = 2 * limits.maxPages + 8;
  let seen = 0;
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (++seen > entryCap) return bad('the output holds more files than a document can');
      const image = IMAGE_NAME.exec(entry.name);
      if (image) {
        const list = images.get(Number(image[1])) ?? [];
        list.push(entry.name);
        images.set(Number(image[1]), list);
        continue;
      }
      const words = WORDS_NAME.exec(entry.name);
      if (words) wordsFiles.set(Number(words[1]), entry.name);
      // (meta.json is read by name below; every other name is never opened)
    }
  } catch {
    return bad('the output directory could not be listed');
  } finally {
    try {
      dir.closeSync();
    } catch {
      /* nothing to do */
    }
  }

  let drawn = 0;
  while (drawn < limits.maxPages && images.get(drawn + 1)?.length === 1) drawn++;
  const pages: ReadbackPage[] = [];
  let total = 0;
  let cutByRoom = false;
  let wordsRejected = 0;
  let aspect = 0;
  for (let n = 1; n <= limits.maxPages; n++) {
    const names = images.get(n);
    if (!names || names.length !== 1) break; // missing, or both a PNG and a JPEG: the run of pages ends
    const image = readBytesSafe(path.join(outDir, names[0]), DOC_LIMITS.imageBytes, outDir);
    if (!image) break; // not a regular file, or over the size of a page image
    const info = imageInfo(image);
    if (!info || info.width > DOC_LIMITS.imagePx + SIZE_SLACK_PX || info.height > DOC_LIMITS.imagePx + SIZE_SLACK_PX) break;

    let words: PageWords = { words: [], lines: [] };
    const wordsName = wordsFiles.get(n);
    if (wordsName) {
      const bytes = readBytesSafe(path.join(outDir, wordsName), WORDS_FILE_BYTES, outDir);
      let checked: PageWords | null = null;
      if (bytes) {
        try {
          checked = validateWords(JSON.parse(bytes.toString('utf8')));
        } catch {
          checked = null;
        }
      }
      if (checked) words = checked;
      else wordsRejected++;
    }
    const wordsBytes = Buffer.byteLength(JSON.stringify(words));
    if (total + image.length + wordsBytes > limits.maxBytes) {
      cutByRoom = true;
      break;
    }
    total += image.length + wordsBytes;
    if (n === 1) aspect = Math.round((info.width / info.height) * 10_000) / 10_000;
    pages.push({ image, info, words, wordsBytes });
  }
  if (pages.length === 0) return { ok: false, reason: 'no-pages', detail: 'no page image of the output passed the checks' };
  const inFile = metaPagesInFile(outDir);
  return {
    ok: true,
    pages,
    ...(inFile !== undefined && inFile > pages.length ? { pagesInFile: inFile } : {}),
    aspect,
    cutByRoom,
    drawn,
    wordsRejected,
  };
}
