/**
 * Test helpers of the document service: image bytes that pass the host's header checks (a PNG or a JPEG that says how big it is; nothing here can be drawn), a words file, and a Docker that
 * does what the test says (src/sandbox/runner.test.ts has the same kind of fake for the Go sandbox). Used by the tests of src/docs and src/portal/doc-routes.ts only.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ContainerSpec, DockerClient, DockerInspect } from '../../sandbox/docker.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's first bytes (signature and IHDR) and `extra` more bytes: `size` bytes in all when it is at least 33. */
export function png(width = 850, height = 1100, size = 120): Buffer {
  const head = Buffer.alloc(33);
  PNG_SIGNATURE.copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head[24] = 8;
  head[25] = 2;
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - 33), 7)]);
}

/** A JPEG's first bytes: SOI, a JFIF segment, a quantisation table, then the frame header (SOF0 or SOF2) with the size, then `size` bytes in all when that is more. */
export function jpeg(width = 850, height = 1100, size = 400, marker = 0xc0): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 8)]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, marker, 0x00, 0x11, 8], 0);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 9);
  const body = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sof]);
  return Buffer.concat([body, Buffer.alloc(Math.max(0, size - body.length), 9), Buffer.from([0xff, 0xd9])]);
}

export type Word = [number, number, number, number, string];

/** What the renderer's words file looks like for these words (one line per run of `perLine` words). */
export function wordsFile(words: Word[], perLine = 3): string {
  const lines: Array<[number, number]> = [];
  for (let i = 0; i < words.length; i += perLine) lines.push([i, Math.min(words.length, i + perLine) - 1]);
  return JSON.stringify({ words, lines });
}

export const ALPHA_WORDS: Word[] = [
  [0.1176, 0.0944, 0.2179, 0.1224, 'Alpha'],
  [0.2288, 0.0944, 0.3095, 0.1224, 'Beta'],
  [0.3204, 0.0944, 0.4511, 0.1224, 'gamma'],
  [0.1176, 0.2315, 0.1809, 0.2456, 'second'],
  [0.1863, 0.2315, 0.2168, 0.2456, 'line'],
  [0.2223, 0.2315, 0.2615, 0.2456, 'here'],
];

/** A few bytes that begin like a PDF. */
export const pdfBytes = (extra = 200, seed = 1): Buffer => Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(extra, seed), Buffer.from('\n%%EOF\n')]);

/** What the fake renderer writes into the output directory: `pages` pages, the words of each, and a meta.json. */
export function writeOutput(outDir: string, pages: number, options: { inFile?: number; image?: (n: number) => Buffer; words?: (n: number) => string | null; meta?: unknown } = {}): void {
  for (let n = 1; n <= pages; n++) {
    const image = options.image ? options.image(n) : png();
    const ext = image[0] === 0xff ? 'jpg' : 'png';
    fs.writeFileSync(path.join(outDir, `p${String(n).padStart(3, '0')}.${ext}`), image);
    const words = options.words ? options.words(n) : wordsFile(ALPHA_WORDS);
    if (words !== null) fs.writeFileSync(path.join(outDir, `w${String(n).padStart(3, '0')}.json`), words);
  }
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(options.meta ?? { pages, pagesInFile: options.inFile ?? pages, aspect: 0.7727 }));
}

export type Verdict = { exitCode?: number; oom?: boolean; error?: string; missing?: boolean; startedAtMs?: number; finishedAtMs?: number };

/** What a container's `run` is given: its spec, the host directories it was given, and what it may print or wait for. */
export interface Ctl {
  spec: ContainerSpec;
  inDir: string;
  outDir: string;
  /** What `docker run` was asked to run, after the image: [script, kind, maxPages, maxPx]. */
  command: string[];
  write(text: string | Buffer): void;
  /** Resolves when the host kills the container. */
  killed: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FakeDocker implements DockerClient {
  image = true;
  imageError = false;
  specs: ContainerSpec[] = [];
  calls: string[] = [];
  removed: string[] = [];
  killedNames: string[] = [];
  listing: Array<{ name: string; startedMs: number | null }> = [];
  listError = false;
  /** What the "container" does: by default it writes one page and ends 0. */
  behave: (ctl: Ctl) => Promise<Verdict> = async (ctl) => {
    writeOutput(ctl.outDir, 1);
    return { exitCode: 0 };
  };
  private verdicts = new Map<string, Verdict>();
  private killers = new Map<string, () => void>();

  async imageExists(): Promise<boolean> {
    this.calls.push('image');
    if (this.imageError) throw new Error('docker is gone');
    return this.image;
  }
  async run(spec: ContainerSpec, onOutput: (c: Buffer) => void, onDiag?: (c: Buffer) => void): Promise<{ exitCode: number | null; error?: string }> {
    this.calls.push('run');
    this.specs.push(spec);
    const killed = new Promise<void>((resolve) => this.killers.set(spec.name, resolve));
    const mount = (suffix: string): string => {
      const v = spec.args.find((a, i) => spec.args[i - 1] === '-v' && a.endsWith(suffix)) as string;
      return v.slice(0, v.length - suffix.length);
    };
    const image = spec.args.indexOf('tai-doc:live');
    const ctl: Ctl = { spec, inDir: mount(':/in:ro'), outDir: mount(':/out:rw'), command: spec.args.slice(image + 1), write: (t) => onOutput(Buffer.from(t)), killed };
    const v = await this.behave(ctl);
    this.verdicts.set(spec.name, v);
    if (v.error) {
      onDiag?.(Buffer.from(`docker: Error response from daemon: ${v.error}`));
      return { exitCode: null, error: v.error };
    }
    return { exitCode: v.exitCode ?? 0 };
  }
  async inspect(name: string): Promise<DockerInspect | null> {
    const v = this.verdicts.get(name);
    if (!v || v.missing) return null;
    return { exitCode: v.exitCode ?? 0, oomKilled: v.oom === true, ...(v.startedAtMs !== undefined ? { startedAtMs: v.startedAtMs } : {}), ...(v.finishedAtMs !== undefined ? { finishedAtMs: v.finishedAtMs } : {}) };
  }
  async kill(name: string): Promise<boolean> {
    this.killedNames.push(name);
    this.killers.get(name)?.();
    return true;
  }
  async remove(name: string): Promise<boolean> {
    this.removed.push(name);
    return true;
  }
  async list(): Promise<Array<{ name: string; startedMs: number | null }>> {
    if (this.listError) throw new Error('docker ps failed');
    return this.listing;
  }
  /** A container that takes `ms` and then ends as `verdict`, or ends 137 when it is killed first. */
  static runsFor(ms: number, verdict: Verdict = { exitCode: 0 }, after?: (ctl: Ctl) => void) {
    return async (ctl: Ctl): Promise<Verdict> => {
      const result = await Promise.race([sleep(ms).then(() => verdict), ctl.killed.then(() => ({ exitCode: 137 }))]);
      if (result === verdict) after?.(ctl);
      return result;
    };
  }
}
