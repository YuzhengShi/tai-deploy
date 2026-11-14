/**
 * The document renderer against the REAL image and real Docker (docs/DOCUMENTS.md "Checks"): `node dist/docs/smoke.js` (on the host: `tai_live.sh doc smoke`). It builds a real `createDocs` over a
 * temporary directory (the real renderer container, the real store), makes its own PDFs with a tiny writer (src/docs/testing/tiny-pdf.ts: text where it says it is, a page turned a quarter, a crop box,
 * a scan, a photograph, 10 and 150 pages, files that are not PDFs, damaged and hostile ones), opens them as a student's attached files, and prints PASS or FAIL with what was expected and what was measured
 * for each. The exit code says whether all passed. At the end nothing of the renderer may be left: no container, no run directory, and a canary file beside them untouched.
 *
 *   node dist/docs/smoke.js [--dir DIR] [--only TEXT] [--keep] [--image NAME] [--agent-image NAME]
 *
 * The Office cases (docs/COURSE_DOCS.md) need real PowerPoint, Word and Excel files: python-pptx, python-docx and openpyxl are in the agent image (--agent-image, default tai-agent:live), so
 * src/docs/testing/make_office_samples.py is run in it once (no network, the host's user) and makes a 12 slide deck, a 6 page document, a workbook, a heavy deck, a long document and the files that must
 * be refused. Without that image those cases are SKIPPED, in words, and not counted as passed.
 *
 * What it measures is what the voice side may promise a student: what a document costs to open, split into what starting a container costs on this host (Docker's own StartedAt), what the script took,
 * and the container's peak memory. A case is a pass when the result is the one that is expected, or, for the hostile files, when the result is a clean one (a document or a refusal in words) within the clock.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOC_GATE, createDocs } from './docs.js';
import { createLibraryAdmin } from './library.js';
import { DOC_CONTAINER_PREFIX, DOC_IMAGE, DOC_LABEL, DOC_OPERATOR_LABEL, createRenderer } from './render.js';
import { DocStore } from './store.js';
import { imageInfo } from './readback.js';
import { darkPixels, decodePng } from './testing/png-decode.js';
import { bombPdf, loopPdf, numberedPdf, photoRgb, tinyPdf, truncated } from './testing/tiny-pdf.js';
import { DOC_LIMITS } from './types.js';
import type { DocMeta, DocOpenResult } from './types.js';
import { nearestWord } from './words.js';

interface Verdict {
  pass: boolean;
  expected: string;
  measured?: string;
  /** The case could not be run here (the sample maker's image is not there): said in words, counted as neither passed nor failed. */
  skipped?: boolean;
}
interface Case {
  name: string;
  run: () => Promise<Verdict>;
}

const arg = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at !== -1 ? process.argv[at + 1] : undefined;
};
const dir = path.resolve(arg('--dir') ?? path.join(os.tmpdir(), `doc-smoke-${randomBytes(4).toString('hex')}`));
const only = arg('--only');
const keep = process.argv.includes('--keep');
const image = arg('--image') ?? DOC_IMAGE;
const agentImage = arg('--agent-image') ?? 'tai-agent:live';

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const CANARY = path.join(dir, 'canary.txt');
const CANARY_TEXT = `canary-${randomBytes(6).toString('hex')}`;
fs.writeFileSync(CANARY, CANARY_TEXT);

interface Timing {
  ms?: number;
  startMs?: number;
  runMs?: number;
  memoryBytes?: number;
}
let lastPrepared: Timing | null = null;
const warnings: string[] = [];
const log = {
  info: (fields: Record<string, unknown>, message: string) => {
    if (message === 'docs: a document was prepared') lastPrepared = fields as Timing;
  },
  warn: (fields: Record<string, unknown>, message: string) => void warnings.push(`${message} ${JSON.stringify(fields).slice(0, 200)}`),
  debug: () => undefined,
};
const docs = createDocs({ dir: path.join(dir, 'data'), storeDir: path.join(dir, 'store'), uploadsDir: (folder) => path.join(dir, 'groups', folder, 'uploads'), log, image });

let counter = 0;
const nextFolder = (): string => `s_${(++counter).toString(16).padStart(20, '0')}`;

interface Opened {
  r: DocOpenResult;
  folder: string;
  ms: number;
  timing: Timing | null;
}
/** The student attaches `bytes` as a file and asks for it to be opened. */
async function open(bytes: Buffer, name = 'smoke.pdf', folder = nextFolder()): Promise<Opened> {
  const uploads = path.join(dir, 'groups', folder, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, name), bytes);
  lastPrepared = null;
  const began = Date.now();
  const r = await docs.open({ folder }, { kind: 'upload', name });
  return { r, folder, ms: Date.now() - began, timing: lastPrepared };
}

const secs = (ms: number | undefined): string => (ms === undefined ? '-' : `${Math.round(ms / 100) / 10} s`);
const megabytes = (bytes: number | undefined): string => (bytes === undefined ? '-' : `${Math.round(bytes / 1048576)} MB`);
const timingText = (o: Opened): string => `${secs(o.ms)} in all (container start ${secs(o.timing?.startMs)}, script ${secs(o.timing?.runMs)}, peak memory ${megabytes(o.timing?.memoryBytes)})`;
const show = (r: DocOpenResult): string => (r.ok ? `ok pages=${r.doc.pages}${r.doc.pagesInFile ? ` of ${r.doc.pagesInFile}` : ''} title=${JSON.stringify(r.doc.title)}` : `${r.reason}: ${JSON.stringify(r.message.slice(0, 110))}`);

/** What the pages of a kept document are, from the bytes of their images. */
function pagesOf(folder: string, meta: DocMeta): Array<{ type: string; width: number; height: number; bytes: number }> {
  const out: Array<{ type: string; width: number; height: number; bytes: number }> = [];
  for (let p = 1; p <= meta.pages; p++) {
    const found = docs.pageFile(folder, meta.id, p);
    const bytes = found ? fs.readFileSync(found.file) : Buffer.alloc(0);
    const info = imageInfo(bytes);
    out.push({ type: found?.type ?? 'none', width: info?.width ?? 0, height: info?.height ?? 0, bytes: bytes.length });
  }
  return out;
}
const imageText = (list: ReturnType<typeof pagesOf>): string => `${list.length} image(s): ${[...new Set(list.map((p) => `${p.type.replace('image/', '')} ${p.width}x${p.height}`))].join(', ')}, largest ${Math.round(Math.max(0, ...list.map((p) => p.bytes)) / 1024)} KB`;

/** Whether the word is on the page where it was put: `at` is the point of the page it should cover (fractions, x right, y down). */
function wordAt(folder: string, meta: DocMeta, page: number, at: [number, number], expected: string, maxDist = 0.02): { found: string | null; box?: number[] } {
  const words = docs.words(folder, meta.id, page);
  if (!words) return { found: null };
  const i = nearestWord(words, at[0], at[1], maxDist);
  return i === null ? { found: null } : { found: words.words[i][4], box: words.words[i].slice(0, 4) as number[] };
}

/** A case that must end in a clean answer within a time: a document, or a refusal in words, and nothing hanging. */
const clean = (o: Opened, limitMs: number): boolean => (o.r.ok || (typeof o.r.message === 'string' && o.r.message.length > 20)) && o.ms < limitMs;

const LETTER = { w: 612, h: 792 };

interface SampleManifest {
  pages?: number;
  titles?: string[];
  table?: string[];
  shapes?: string[];
  sheets?: string[];
  words?: string[];
}
interface Samples {
  file(name: string): Buffer;
  manifest: Record<string, SampleManifest>;
}
const skipped = (reason: string): Verdict => ({ pass: true, skipped: true, expected: 'real Office files from the agent image', measured: `SKIPPED: ${reason}` });

/** Makes the samples once, in the agent image (no network, the host's own user): the files, or the reason there are none. */
async function makeSamples(): Promise<Samples | string> {
  const out = path.join(dir, 'office-samples');
  fs.mkdirSync(out, { recursive: true, mode: 0o755 });
  const script = fileURLToPath(new URL('../../src/docs/testing/make_office_samples.py', import.meta.url));
  if (!fs.existsSync(script)) return `the sample maker is not at ${script}`;
  const args = ['run', '--rm', '--network', 'none', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--entrypoint', '/opt/leanrag/bin/python', '-v', `${out}:/out`, '-v', `${script}:/make.py:ro`, agentImage, '/make.py', '/out'];
  const failure = await new Promise<string | null>((resolve) => {
    let said = '';
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d: Buffer) => (said += d.toString('utf8')));
    child.on('error', (err) => resolve(`docker could not be started: ${err.message}`));
    child.on('close', (code) => resolve(code === 0 ? null : `the sample maker failed in ${agentImage} (${said.trim().split('\n').slice(-2).join(' ').slice(0, 200) || `exit ${code}`})`));
  });
  if (failure) return failure;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'samples.json'), 'utf8')) as Record<string, SampleManifest>;
    return { file: (name) => fs.readFileSync(path.join(out, name)), manifest };
  } catch (err) {
    return `the samples were not made: ${(err as Error).message}`;
  }
}
let samplesMade: Promise<Samples | string> | null = null;
const samples = (): Promise<Samples | string> => (samplesMade ??= makeSamples());

const cases: Case[] = [
  {
    name: 'a page of text: the boxes of the words are where the words are (the page image has the ink there, and not where a flipped or turned axis would put it)',
    run: async () => {
      // "Alpha" in the upper left quadrant, "Zulu" low on the right: a flipped y axis, or swapped axes, puts a box where there is nothing
      const o = await open(tinyPdf([{ texts: [{ x: 72, y: 700, size: 24, text: 'Alpha Beta gamma' }, { x: 430, y: 90, size: 24, text: 'Zulu' }] }]));
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const pages = pagesOf(o.folder, meta);
      const alpha = wordAt(o.folder, meta, 1, [0.15, 0.108], 'Alpha');
      const zulu = wordAt(o.folder, meta, 1, [0.72, 0.885], 'Zulu');
      const flipped = wordAt(o.folder, meta, 1, [0.15, 0.892], '', 0.01);
      const turned = wordAt(o.folder, meta, 1, [0.108, 0.15], '', 0.01);
      const file = docs.pageFile(o.folder, meta.id, 1);
      const png = file ? decodePng(fs.readFileSync(file.file)) : null;
      const inkAtAlpha = png && alpha.box ? darkPixels(png, alpha.box as [number, number, number, number]) : -1;
      const inkFlipped = png && alpha.box ? darkPixels(png, [alpha.box[0], 1 - alpha.box[3], alpha.box[2], 1 - alpha.box[1]]) : -1;
      const inkTurned = png && alpha.box ? darkPixels(png, [alpha.box[1], alpha.box[0], alpha.box[3], alpha.box[2]]) : -1;
      const pass =
        meta.pages === 1 &&
        Math.abs((meta.aspect ?? 0) - LETTER.w / LETTER.h) < 0.002 &&
        pages[0].type === 'image/png' &&
        Math.max(pages[0].width, pages[0].height) >= DOC_LIMITS.imagePx - 2 &&
        Math.max(pages[0].width, pages[0].height) <= DOC_LIMITS.imagePx &&
        alpha.found === 'Alpha' &&
        zulu.found === 'Zulu' &&
        flipped.found === null &&
        turned.found === null &&
        Math.abs((alpha.box?.[0] ?? 9) - 72 / LETTER.w) < 0.01 &&
        Math.abs((zulu.box?.[0] ?? 9) - 430 / LETTER.w) < 0.01 &&
        inkAtAlpha >= 100 &&
        inkFlipped <= 15 &&
        inkTurned <= 25 &&
        (docs.text(o.folder, meta.id, 1) ?? '') === 'Alpha Beta gamma\nZulu';
      return {
        pass,
        expected: 'one page, aspect 0.7727, a PNG 1100 px on its long side; nearestWord at the known places finds Alpha (box x near 72/612) and Zulu (near 430/612), nothing at the flipped or turned places; 100+ dark pixels in the box of Alpha, almost none where a flipped or turned box would be; the text reads "Alpha Beta gamma / Zulu"',
        measured: `${show(o.r)}; aspect ${meta.aspect}; ${imageText(pages)}; Alpha ${JSON.stringify(alpha)}; Zulu ${JSON.stringify(zulu)}; flipped ${JSON.stringify(flipped)}; turned ${JSON.stringify(turned)}; ink in the box ${inkAtAlpha}, flipped ${inkFlipped}, turned ${inkTurned}; text ${JSON.stringify(docs.text(o.folder, meta.id, 1))}; ${timingText(o)}`,
      };
    },
  },
  {
    name: 'a page turned a quarter, and a page with a crop box: the boxes are in the frame the page is shown in',
    run: async () => {
      // page 1: /Rotate 90, text at (72, 700) of 612 x 792: shown 792 wide and 612 high, the text near the right edge going down. page 2: a crop box of 400 x 300 points with text at (172, 600).
      const o = await open(tinyPdf([{ rotate: 90, texts: [{ x: 72, y: 700, size: 24, text: 'Turned' }] }, { cropbox: [100, 400, 500, 700], texts: [{ x: 172, y: 600, size: 24, text: 'Cropped' }] }]));
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const pages = pagesOf(o.folder, meta);
      const turned = wordAt(o.folder, meta, 1, [0.89, 0.15], 'Turned', 0.03);
      const cropped = wordAt(o.folder, meta, 2, [0.25, 0.3], 'Cropped', 0.03);
      const png = (n: number) => {
        const f = docs.pageFile(o.folder, meta.id, n);
        return f ? decodePng(fs.readFileSync(f.file)) : null;
      };
      const inkTurned = png(1) && turned.box ? darkPixels(png(1)!, turned.box as [number, number, number, number]) : -1;
      const inkCropped = png(2) && cropped.box ? darkPixels(png(2)!, cropped.box as [number, number, number, number]) : -1;
      const pass =
        meta.pages === 2 &&
        pages[0].width > pages[0].height && // shown turned: wider than high
        pages[0].width === DOC_LIMITS.imagePx &&
        Math.abs((meta.aspect ?? 0) - 792 / 612) < 0.002 &&
        Math.abs(pages[1].width / pages[1].height - 400 / 300) < 0.01 &&
        turned.found === 'Turned' &&
        cropped.found === 'Cropped' &&
        (turned.box?.[2] ?? 9) < 1 &&
        Math.abs((turned.box?.[1] ?? 9) - 72 / 612) < 0.012 &&
        Math.abs((cropped.box?.[0] ?? 9) - 72 / 400) < 0.012 &&
        inkTurned >= 60 &&
        inkCropped >= 60;
      return {
        pass,
        expected: 'two pages; page 1 wider than high (turned), aspect 792/612, the box of "Turned" inside the page near its right edge and 72/612 from the top, with ink in it; page 2 as 4:3 (the crop box), the box of "Cropped" 72/400 from the left, with ink in it',
        measured: `${show(o.r)}; aspect ${meta.aspect}; ${imageText(pages)}; Turned ${JSON.stringify(turned)} ink ${inkTurned}; Cropped ${JSON.stringify(cropped)} ink ${inkCropped}; ${timingText(o)}`,
      };
    },
  },
  {
    name: 'ten pages',
    run: async () => {
      const o = await open(numberedPdf(10));
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const texts = Array.from({ length: 10 }, (_, i) => docs.text(o.folder, meta.id, i + 1) ?? '');
      const pass = meta.pages === 10 && meta.pagesInFile === undefined && texts.every((t, i) => t.includes(`Page number ${i + 1}`) && t.includes(`footer of page ${i + 1}`));
      return { pass, expected: 'ok, 10 pages, each page\'s text has its own number and its footer', measured: `${show(o.r)}; ${imageText(pagesOf(o.folder, meta))}; ${timingText(o)}` };
    },
  },
  {
    name: `a hundred and fifty pages: it stops at ${DOC_LIMITS.pages}`,
    run: async () => {
      const pdf = numberedPdf(150);
      const o = await open(pdf);
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const last = docs.text(o.folder, meta.id, DOC_LIMITS.pages) ?? '';
      const pass = meta.pages === DOC_LIMITS.pages && meta.pagesInFile === 150 && last.includes(`Page number ${DOC_LIMITS.pages}`) && docs.text(o.folder, meta.id, DOC_LIMITS.pages + 1) === null && o.ms < 90_000;
      return { pass, expected: `ok, ${DOC_LIMITS.pages} pages of 150 (pagesInFile 150), the last page is page 120, in less than the 90 s the container is given`, measured: `${show(o.r)}; file ${Math.round(pdf.length / 1024)} KB; ${imageText(pagesOf(o.folder, meta))}; kept ${megabytes(meta.bytes)}; ${timingText(o)}` };
    },
  },
  {
    name: 'a page with no text layer (a scan): an image and no words',
    run: async () => {
      const o = await open(tinyPdf([{ image: { width: 400, height: 520, rgb: photoRgb(400, 520, 3) } }]));
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const words = docs.words(o.folder, o.r.doc.id, 1);
      const pages = pagesOf(o.folder, o.r.doc);
      return { pass: o.r.doc.pages === 1 && words !== null && words.words.length === 0 && words.lines.length === 0 && docs.text(o.folder, o.r.doc.id, 1) === '' && pages[0].bytes > 1000, expected: 'ok, 1 page, an image, an empty list of words, the text is ""', measured: `${show(o.r)}; ${imageText(pages)}; words ${JSON.stringify(words)}; ${timingText(o)}` };
    },
  },
  {
    name: 'a photographic page (a few MB as a PNG) is drawn as a JPEG under the size cap',
    run: async () => {
      const pdf = tinyPdf([{ image: { width: 1000, height: 1300, rgb: photoRgb(1000, 1300) } }, { texts: [{ x: 72, y: 700, size: 24, text: 'After the picture' }] }]);
      const o = await open(pdf);
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const pages = pagesOf(o.folder, o.r.doc);
      return {
        pass: o.r.doc.pages === 2 && pages[0].type === 'image/jpeg' && pages[0].bytes <= DOC_LIMITS.imageBytes && pages[1].type === 'image/png' && (docs.text(o.folder, o.r.doc.id, 2) ?? '').includes('After the picture'),
        expected: `ok, 2 pages, page 1 a JPEG of at most ${DOC_LIMITS.imageBytes / 1024} KB, page 2 (text) a PNG`,
        measured: `${show(o.r)}; file ${Math.round(pdf.length / 1024)} KB; ${imageText(pages)}; ${timingText(o)}`,
      };
    },
  },
  {
    name: 'a page as big as a PDF page can be (14,400 points square) is drawn at the same 1100 px',
    run: async () => {
      const o = await open(tinyPdf([{ mediabox: [0, 0, 14400, 14400], texts: [{ x: 1000, y: 13000, size: 400, text: 'Big' }] }]));
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const pages = pagesOf(o.folder, o.r.doc);
      return { pass: pages[0].width === DOC_LIMITS.imagePx && pages[0].height === DOC_LIMITS.imagePx && Math.abs((o.r.doc.aspect ?? 0) - 1) < 0.002, expected: 'ok, an image 1100 x 1100, aspect 1', measured: `${show(o.r)}; ${imageText(pages)}; ${timingText(o)}` };
    },
  },
  {
    name: `more words than a page keeps: ${DOC_LIMITS.wordsPerPage} of 5,200`,
    run: async () => {
      const texts = Array.from({ length: 5200 }, (_, i) => ({ x: 8 + (i % 55) * 11, y: 780 - Math.floor(i / 55) * 7, size: 3, text: `k${i}` }));
      const o = await open(tinyPdf([{ texts }]));
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const words = docs.words(o.folder, o.r.doc.id, 1);
      const lastLine = words?.lines.at(-1);
      return { pass: words !== null && words.words.length === DOC_LIMITS.wordsPerPage && (lastLine?.[1] ?? -1) <= DOC_LIMITS.wordsPerPage - 1, expected: `ok, ${DOC_LIMITS.wordsPerPage} words kept, the lines cut to match`, measured: `${show(o.r)}; ${words?.words.length} words, ${words?.lines.length} lines, the last line ${JSON.stringify(lastLine)}; ${timingText(o)}` };
    },
  },
  {
    name: 'a file named .pdf that is not a PDF is refused from its bytes, before any container starts',
    run: async () => {
      const o = await open(Buffer.from('This is plain text with a .pdf name. '.repeat(20)));
      return { pass: !o.r.ok && o.r.reason === 'bad-file' && /not a PDF/.test(o.r.message) && o.ms < 2000 && lastPrepared === null, expected: 'bad-file, "not a PDF", within 2 s (no render)', measured: `${show(o.r)}; ${secs(o.ms)}` };
    },
  },
  {
    name: 'a zip named .pdf (what a Word or PowerPoint file is) goes to the container as an Office file, which reads its entry names and refuses it in words: it is no Office file',
    run: async () => {
      const o = await open(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]), Buffer.alloc(500, 1)]));
      return { pass: !o.r.ok && o.r.reason === 'bad-file' && /could not be read as a PowerPoint, Word or Excel file/.test(o.r.message) && o.ms < 150_000, expected: 'bad-file, "could not be read as a PowerPoint, Word or Excel file", within the Office clock', measured: `${show(o.r)}; ${timingText(o)}` };
    },
  },
  {
    name: `a file over the size limit (${DOC_LIMITS.sourceBytes / 1048576} MB) is refused before any container starts`,
    run: async () => {
      const o = await open(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(DOC_LIMITS.sourceBytes)]), 'huge.pdf');
      return { pass: !o.r.ok && o.r.reason === 'too-big' && o.ms < 5000, expected: 'too-big within 5 s', measured: `${show(o.r)}; ${secs(o.ms)}` };
    },
  },
  {
    name: 'a corrupt PDF (the header and then garbage): the renderer refuses it in words, and nothing is kept',
    run: async () => {
      const o = await open(Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(3000)]), 'corrupt.pdf');
      return { pass: !o.r.ok && o.r.reason === 'bad-file' && docs.list(o.folder).length === 0 && o.ms < 90_000, expected: 'bad-file (the file could not be read as a PDF), no document kept', measured: `${show(o.r)}; ${secs(o.ms)}` };
    },
  },
  {
    name: 'a PDF cut off in the middle: a document of the pages before the cut, or a refusal in words, and never a hang',
    run: async () => {
      const whole = numberedPdf(10);
      const o = await open(truncated(whole, Math.floor(whole.length * 0.6)), 'cut.pdf');
      return { pass: clean(o, 90_000), expected: 'ok with the pages that could be read, or bad-file in words, within the clock', measured: `${show(o.r)}; ${secs(o.ms)}` };
    },
  },
  {
    name: 'a decompression bomb (a page whose content stream is a gigabyte of spaces): a clean answer within the clock, and the memory limit holds',
    run: async () => {
      const bomb = await bombPdf(1);
      const o = await open(bomb, 'bomb.pdf');
      return { pass: clean(o, 125_000), expected: 'a document or a refusal in words, within the clock (90 s and a guard of 25), no out-of-memory crash of the host', measured: `file ${Math.round(bomb.length / 1024)} KB; ${show(o.r)}; ${timingText(o)}` };
    },
  },
  {
    name: 'a page tree that contains itself: a clean answer, no hang',
    run: async () => {
      const o = await open(loopPdf(), 'loop.pdf');
      return { pass: clean(o, 100_000), expected: 'a document or a refusal in words within the clock', measured: `${show(o.r)}; ${secs(o.ms)}` };
    },
  },
  {
    name: 'the same file again is the same document: no second container (the time is the store\'s)',
    run: async () => {
      const pdf = numberedPdf(2);
      const first = await open(pdf, 'again.pdf');
      if (!first.r.ok) return { pass: false, expected: 'ok', measured: show(first.r) };
      lastPrepared = null;
      const began = Date.now();
      const second = await docs.open({ folder: first.folder }, { kind: 'upload', name: 'again.pdf' });
      const ms = Date.now() - began;
      return { pass: second.ok && second.doc.id === first.r.doc.id && ms < 1000 && lastPrepared === null, expected: 'the same id at once (under 1 s), no render', measured: `${show(second)}; ${secs(ms)}; the first open took ${secs(first.ms)}` };
    },
  },
  {
    name: 'timing of small documents, three in a row (what the voice side may promise)',
    run: async () => {
      const opened: Opened[] = [];
      for (let i = 0; i < 3; i++) opened.push(await open(numberedPdf(3 + i), `small-${i}.pdf`));
      const okAll = opened.every((o) => o.r.ok && o.ms < 60_000);
      const lines = opened.map((o) => timingText(o)).join('; ');
      return { pass: okAll, expected: 'all three ok, each in under a minute', measured: lines };
    },
  },
  {
    name: `two renders at once on the host, and a third waits: never more than two containers; the third is opened, or told busy when the wait for a place (the gate\'s ${DOC_GATE.waitMs / 1000} s) ends first`,
    run: async () => {
      let peak = 0;
      let sampling = true;
      const sample = async () => {
        while (sampling) {
          peak = Math.max(peak, await countContainers());
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };
      const sampler = sample();
      const began = Date.now();
      const all = await Promise.all([open(numberedPdf(4), 'c1.pdf'), open(numberedPdf(5), 'c2.pdf'), open(numberedPdf(6), 'c3.pdf')]);
      sampling = false;
      await sampler;
      const total = Date.now() - began;
      const opened = all.filter((o) => o.r.ok).length;
      const others = all.filter((o) => !o.r.ok);
      // (on a host where one render takes longer than the gate's wait, which the CS6650 host does under load, the waiting one is told busy: the answer of a gate that works, and a finding for the operator)
      const clean = others.every((o) => !o.r.ok && o.r.reason === 'busy' && o.ms >= DOC_GATE.waitMs - 1_000 && o.ms < DOC_GATE.waitMs + 6_000);
      return {
        pass: opened >= 2 && clean && peak <= 2 && peak >= 1,
        expected: `at least two of the three opened; the other, if any, told busy when the ${DOC_GATE.waitMs / 1000} s wait ended (never an error); at most 2 renderer containers at any moment`,
        measured: `peak ${peak} container(s); ${opened} of 3 opened, ${others.length} told busy; all in ${secs(total)}; each ${all.map((o) => `${o.r.ok ? 'ok' : (o.r as { reason: string }).reason} after ${secs(o.ms)}`).join(', ')}`,
      };
    },
  },
  {
    name: 'one at a time for a student: a second file while the first is being prepared is told the service is busy with theirs',
    run: async () => {
      const folder = nextFolder();
      const a = open(numberedPdf(30), 'a.pdf', folder);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const b = await open(numberedPdf(31), 'b.pdf', folder);
      const first = await a;
      return { pass: first.r.ok && !b.r.ok && b.r.reason === 'busy' && b.ms < 3000, expected: 'the first ok; the second busy within 3 s', measured: `first ${show(first.r)} in ${secs(first.ms)}; second ${show(b.r)} in ${secs(b.ms)}` };
    },
  },
  // ---------------------------------------------------------------- Office files and the course library (docs/COURSE_DOCS.md): real files made by python-pptx, python-docx and openpyxl inside the agent image
  {
    name: 'a 12 slide deck (pptx): twelve pages of the shape of a slide, the words of each slide where they are (titles near the top, a table in a row, shapes with words in them, a picture with none), and the cost of it',
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const o = await open(s.file('deck12.pptx'), 'deck12.pptx');
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const pages = pagesOf(o.folder, meta);
      const titles = s.manifest['deck12.pptx'].titles ?? [];
      const everyTitle = titles.every((title, i) => (docs.text(o.folder, meta.id, i + 1) ?? '').includes(title));
      const titleHigh = titles.every((title, i) => {
        const words = docs.words(o.folder, meta.id, i + 1);
        const first = words?.words.find((w) => w[4] === title.split(' ')[0]);
        return first !== undefined && first[1] < 0.2;
      });
      const table = docs.words(o.folder, meta.id, 4);
      const servers = table?.words.find((w) => w[4] === 'Servers');
      const quorum = table?.words.find((w) => w[4] === 'Quorum');
      const sameRow = servers !== undefined && quorum !== undefined && Math.abs(servers[1] - quorum[1]) < 0.02 && servers[0] < quorum[0];
      const shapes = docs.words(o.folder, meta.id, 5);
      const at = (word: string) => shapes?.words.find((w) => w[4] === word);
      const leader = at('Leader');
      const arrow = at('AppendEntries');
      const follower = at('Follower');
      const inOrder = leader !== undefined && arrow !== undefined && follower !== undefined && leader[0] < arrow[0] && arrow[0] < follower[0];
      const picturePage = docs.pageFile(o.folder, meta.id, 6);
      const picture = picturePage ? decodePng(fs.readFileSync(picturePage.file)) : null;
      const inkInPicture = picture ? darkPixels(picture, [0.25, 0.3, 0.7, 0.7], 235) : -1;
      const inkBesideIt = picture ? darkPixels(picture, [0.85, 0.3, 0.98, 0.9], 235) : -1;
      const pass =
        meta.pages === 12 &&
        meta.pagesInFile === undefined &&
        Math.abs((meta.aspect ?? 0) - 4 / 3) < 0.002 &&
        pages.every((p) => p.type === 'image/png' && p.width === DOC_LIMITS.imagePx && p.height === 825 && p.bytes <= DOC_LIMITS.imageBytes) &&
        everyTitle &&
        titleHigh &&
        sameRow &&
        inOrder &&
        (docs.text(o.folder, meta.id, 6) ?? '') === 'Picture Slide' &&
        inkInPicture > 20_000 &&
        inkBesideIt < 200;
      return {
        pass,
        expected: 'ok, 12 pages 1100 x 825 (aspect 4:3), every title in its page\'s text with its first word in the top fifth, the table\'s Servers and Quorum on one row left to right, Leader / AppendEntries / Follower in that order across slide 5, the picture slide\'s only words its title and its picture\'s ink where the picture is and not beside it',
        measured: `${show(o.r)}; aspect ${meta.aspect}; ${imageText(pages)}; titles ${everyTitle}, high ${titleHigh}; table row ${sameRow}; shapes in order ${inOrder}; slide 6 text ${JSON.stringify(docs.text(o.folder, meta.id, 6))}, ink in the picture ${inkInPicture}, beside it ${inkBesideIt}; ${timingText(o)}`,
      };
    },
  },
  {
    name: 'a 6 page document (docx): six pages of letter shape with their headings, and the words of a table',
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const o = await open(s.file('report6.docx'), 'report6.docx');
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const titles = s.manifest['report6.docx'].titles ?? [];
      const headings = titles.every((title, i) => (docs.text(o.folder, meta.id, i + 1) ?? '').includes(title));
      const tableWords = ['Threads', 'Requests', 'p99', 'latency'].every((w) => (docs.text(o.folder, meta.id, 3) ?? '').includes(w));
      const pass = meta.pages === 6 && Math.abs((meta.aspect ?? 0) - 8.5 / 11) < 0.002 && headings && tableWords;
      return { pass, expected: 'ok, 6 pages of 8.5 x 11 in, each page\'s heading in its text, the table\'s words on page 3', measured: `${show(o.r)}; aspect ${meta.aspect}; headings ${headings}; table ${tableWords}; ${imageText(pagesOf(o.folder, meta))}; ${timingText(o)}` };
    },
  },
  {
    name: 'a workbook with two sheets (xlsx): the cells of both sheets are in the words of its pages',
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const o = await open(s.file('two-sheets.xlsx'), 'two-sheets.xlsx');
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const all = Array.from({ length: meta.pages }, (_, i) => docs.text(o.folder, meta.id, i + 1) ?? '').join('\n');
      const found = (s.manifest['two-sheets.xlsx'].words ?? []).map((w) => [w, all.includes(w)] as const);
      return { pass: meta.pages >= 2 && found.every(([, there]) => there), expected: 'ok, at least 2 pages (a page for each sheet), the words Threads (sheet 1), Topic and Saturation (sheet 2) in the words of the pages', measured: `${show(o.r)}; ${JSON.stringify(found)}; ${timingText(o)}` };
    },
  },
  {
    name: 'a heavy deck (forty slides that are photographs, about 12 MB): the images stay under the size cap and it is ready within the Office clock',
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const bytes = s.file('photos40.pptx');
      const o = await open(bytes, 'photos40.pptx');
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const pages = pagesOf(o.folder, o.r.doc);
      const titles = (docs.text(o.folder, o.r.doc.id, 40) ?? '').includes('Photograph 40');
      return {
        pass: o.r.doc.pages === 40 && pages.every((p) => p.bytes <= DOC_LIMITS.imageBytes) && titles && o.ms < 150_000,
        expected: 'ok, 40 pages, every image at most 900 KB, the last slide\'s title in its words, in less than the 150 s an Office file is given',
        measured: `${show(o.r)}; file ${megabytes(bytes.length)}; ${imageText(pages)}; kept ${megabytes(o.r.doc.bytes)}; ${timingText(o)}`,
      };
    },
  },
  {
    name: `a document of 150 pages (docx): it stops at ${DOC_LIMITS.pages}, as a PDF does`,
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const o = await open(s.file('long150.docx'), 'long150.docx');
      if (!o.r.ok) return { pass: false, expected: 'ok', measured: show(o.r) };
      const meta = o.r.doc;
      const last = docs.text(o.folder, meta.id, DOC_LIMITS.pages) ?? '';
      return { pass: meta.pages === DOC_LIMITS.pages && meta.pagesInFile === 150 && last.includes(`Page number ${DOC_LIMITS.pages}`) && docs.text(o.folder, meta.id, DOC_LIMITS.pages + 1) === null, expected: `ok, ${DOC_LIMITS.pages} pages of 150 (pagesInFile 150), the last page is page 120`, measured: `${show(o.r)}; ${timingText(o)}` };
    },
  },
  {
    name: 'files that are not Office files in the ways that matter are refused in words and nothing is kept: an archive, a deck cut in half, one with macros, with too many parts, one that declares a gigabyte, one that is not a deck inside, one marked as encrypted',
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const wanted: Array<[string, RegExp]> = [
        ['notoffice.zip', /not a PowerPoint \(\.pptx\), Word \(\.docx\) or Excel \(\.xlsx\) file/],
        ['truncated.pptx', /could not be read as a PowerPoint, Word or Excel file/],
        ['macro.docx', /contains macros/],
        ['many-parts.pptx', /too many parts/],
        ['bomb.pptx', /too many parts, or is far bigger than it looks/],
        ['garbage.pptx', /could not convert that file/],
        ['encrypted.docx', /protected with a password/],
      ];
      const results: string[] = [];
      let pass = true;
      for (const [name, message] of wanted) {
        const o = await open(s.file(name), name);
        const okay = !o.r.ok && o.r.reason === 'bad-file' && message.test(o.r.message) && o.ms < 150_000 && docs.list(o.folder).length === 0;
        if (!okay) pass = false;
        results.push(`${name}: ${okay ? 'refused' : 'WRONG'} (${show(o.r)}) in ${secs(o.ms)}`);
      }
      return { pass, expected: 'each refused as bad-file with its own sentence, no document kept, each within the Office clock', measured: results.join('; ') };
    },
  },
  {
    name: 'an empty file with a deck\'s name, and an older Office file or a protected one, are refused from their first bytes before any container starts',
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const empty = await open(s.file('empty.pptx'), 'empty.pptx');
      const old = await open(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600, 2)]), 'old.ppt');
      const pass = !empty.r.ok && empty.r.reason === 'bad-file' && /empty/.test(empty.r.message) && empty.ms < 2000 && !old.r.ok && /older Office file/.test(old.r.message) && old.ms < 2000 && lastPrepared === null;
      return { pass, expected: 'bad-file within 2 s each, "empty" and "older Office file", no render', measured: `${show(empty.r)} in ${secs(empty.ms)}; ${show(old.r)} in ${secs(old.ms)}` };
    },
  },
  {
    name: 'the course library: a deck added by the operator\'s command is found by what a slide says and opens for every student with no render; a second add of the same file is skipped; a removed deck is gone',
    run: async () => {
      const s = await samples();
      if (typeof s === 'string') return skipped(s);
      const store = new DocStore(path.join(dir, 'store'), { log });
      const admin = createLibraryAdmin({ store, renderer: createRenderer({ dir: path.join(dir, 'data-operator'), log, image, operator: true }) });
      const began = Date.now();
      const added = await admin.add({ bytes: s.file('deck12.pptx'), name: 'Week_5_Raft_overview.pptx' });
      const addMs = Date.now() - began;
      if (!added.ok || added.status !== 'added') return { pass: false, expected: 'added', measured: JSON.stringify(added).slice(0, 300) };
      const again = await admin.add({ bytes: s.file('deck12.pptx'), name: 'copy.pptx' });
      const hits = docs.searchLibrary('quorum');
      const hit = hits[0];
      lastPrepared = null;
      const one = await docs.open({ folder: nextFolder() }, { kind: 'existing', id: added.entry.id });
      const two = await docs.open({ folder: nextFolder() }, { kind: 'existing', id: added.entry.id });
      const text = hit ? (docs.text('s_' + '1'.padStart(20, '0'), hit.id, hit.page) ?? '') : '';
      const removed = admin.remove(added.entry.id.slice(0, 8));
      const pass =
        added.entry.title === 'Week 5 Raft overview' &&
        added.entry.week === 5 &&
        added.entry.pages === 12 &&
        again.ok &&
        again.status === 'already' &&
        hit !== undefined &&
        hit.id === added.entry.id &&
        hit.page === 4 &&
        hit.week === 5 &&
        hit.snippet.includes('Quorum') &&
        text.includes(hit.snippet.replace(/\.\.\./g, '').trim().split(' ')[0]) &&
        one.ok &&
        two.ok &&
        one.doc.origin === 'course' &&
        lastPrepared === null &&
        removed.ok &&
        docs.library().length === 0 &&
        docs.searchLibrary('quorum').length === 0;
      return {
        pass,
        expected: 'added as "Week 5 Raft overview" (week 5, 12 pages); the same file again "already"; a search for "quorum" finds slide 4 of it with a snippet that has the word; two students open it by id with no container; removing it empties the library and the search',
        measured: `added in ${secs(addMs)} (${added.timing.convertMs !== undefined ? `conversion ${secs(added.timing.convertMs)}` : 'no conversion time'}); again ${again.ok ? again.status : 'refused'}; hits ${JSON.stringify(hits.slice(0, 2))}; opens ${one.ok} and ${two.ok} with no render ${lastPrepared === null}; removed ${removed.ok}`,
      };
    },
  },
];

/** How many renderer containers are there now (running or not): the service's (label tai-doc) or, with `operator`, the operator's own (label tai-doc-operator). */
function countContainers(operator = false): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('docker', ['ps', '-a', '--filter', `label=${operator ? DOC_OPERATOR_LABEL : DOC_LABEL}=1`, '--format', '{{.Names}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(out.split('\n').filter((n) => n.startsWith(DOC_CONTAINER_PREFIX)).length));
  });
}

async function main(): Promise<number> {
  console.log(`document renderer smoke: image ${image}, directory ${dir}`);
  if (!(await docs.ready())) {
    console.log(`FAIL  the image ${image} is not there (tai_live.sh doc build)`);
    return 1;
  }
  let failed = 0;
  let ran = 0;
  let skippedCases = 0;
  for (const c of cases) {
    if (only && !c.name.toLowerCase().includes(only.toLowerCase())) continue;
    ran++;
    const began = Date.now();
    let verdict: Verdict;
    try {
      verdict = await c.run();
    } catch (err) {
      verdict = { pass: false, expected: 'no exception', measured: (err as Error).stack ?? (err as Error).message };
    }
    const took = Math.round((Date.now() - began) / 100) / 10;
    if (verdict.skipped) {
      ran--;
      skippedCases++;
      console.log(`SKIP  ${c.name}  [${took} s]\n      ${verdict.measured ?? '-'}`);
    } else if (verdict.pass) console.log(`PASS  ${c.name}  [${took} s]\n      expected: ${verdict.expected}\n      measured: ${verdict.measured ?? '-'}`);
    else {
      failed++;
      console.log(`FAIL  ${c.name}  [${took} s]\n      expected: ${verdict.expected}\n      measured: ${verdict.measured ?? '-'}`);
    }
  }
  if (warnings.length) console.log(`\nwarnings from the service (${warnings.length}):\n  ${warnings.slice(0, 12).join('\n  ')}`);

  // nothing of the renderer is left: no container, no run directory, the canary as it was
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await docs.reap();
  const containers = (await countContainers()) + (await countContainers(true));
  const runDirsIn = (sub: string): string[] => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter((n) => n.startsWith('run-')) : []);
  const runDirs = [...runDirsIn('data'), ...runDirsIn('data-operator')];
  const stray = fs.existsSync(path.join(dir, 'store', 'portal', 'docs')) ? fs.readdirSync(path.join(dir, 'store', 'portal', 'docs')).flatMap((f) => fs.readdirSync(path.join(dir, 'store', 'portal', 'docs', f)).filter((n) => n.startsWith('.tmp-'))) : [];
  const canary = fs.readFileSync(CANARY, 'utf8') === CANARY_TEXT;
  if (!only) {
    ran++;
    if (containers === 0 && runDirs.length === 0 && stray.length === 0 && canary) console.log('PASS  nothing is left: no renderer container (the service\'s or the operator\'s), no run directory, no half made document, the canary untouched');
    else {
      failed++;
      console.log(`FAIL  nothing is left\n      measured: containers ${containers}, run directories ${JSON.stringify(runDirs)}, half made ${JSON.stringify(stray)}, canary intact ${canary}`);
    }
  }
  console.log(`\n${ran - failed} of ${ran} passed${failed ? `, ${failed} FAILED` : ''}${skippedCases ? `, ${skippedCases} SKIPPED (no ${agentImage}: the Office files could not be made)` : ''}`);
  return failed ? 1 : 0;
}

main()
  .then((code) => {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  })
  .catch((err) => {
    console.error('the smoke itself failed:', err);
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(2);
  });
