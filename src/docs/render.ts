/**
 * The document renderer (docs/DOCUMENTS.md, docs/COURSE_DOCS.md): one PDF (or one PowerPoint, Word or Excel file) in, the images and the words of its pages out, made by a DISPOSABLE container that the host
 * starts and nothing else ever parses the file. An Office file is a zip, which the HOST never opens: it is staged under a neutral name (`source.bin`) and the container's own script reads its entry
 * names, decides what it is and makes a PDF of it with LibreOffice before the steps a PDF goes through, so what comes back is the same. It has limits of its own (more memory, a longer clock); the flags are
 * the same. The container has the Go sandbox's flags (src/sandbox/docker.ts `hardening()` is the model; the list is built here, flag by flag, and tested flag by flag): no network, no
 * capabilities, no new privileges, a read-only root file system, a limit on processes, 1 GB of memory with the same swap, one CPU, ulimits, no log driver, a size-limited memory-backed
 * /tmp, the host's own user, the source mounted READ-ONLY, one output directory that is the only other writable place, a fixed `-e` environment (nothing is inherited from the host's own),
 * a name that matches one pattern and a label the reaper looks for. Arguments go to `docker` as an array (src/sandbox/docker.ts spawns it with no shell): nothing a student wrote is on a command
 * line but two integers the host chose.
 *
 *   <deps.dir>/run-<16 hex>/        mode 0700, made by the host, removed when the render ends (the reaper removes one that was left)
 *     in/source.pdf | source.bin    the bytes, created exclusively by the host (src/safe-fs.ts createFileExclusive); source.bin for an Office file
 *     out/                          what the container writes: read back only through src/docs/readback.ts, after the container is gone
 *
 * `render` never throws and never takes longer than the wall clock plus a short guard: the host's own clock is the last word (it kills the container at WALL_MS whatever happens inside, and a
 * guard answers when Docker itself hangs). What the container printed is data the host does not believe: a refusal line is matched against the few the script can say, and only the matching
 * sentence of the host's own is passed on; the rest goes to the log, cleaned and cut.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { createDockerClient, mountable } from '../sandbox/docker.js';
import type { ContainerSpec, DockerClient, DockerInspect, HostUser } from '../sandbox/docker.js';
import { RUN_DIR, removeRunDir } from '../sandbox/stage.js';
import type { SandboxLog } from '../sandbox/types.js';
import { createFileExclusive } from '../safe-fs.js';
import { readbackOutput } from './readback.js';
import type { Readback } from './readback.js';
import { DOC_LIMITS } from './types.js';

export const DOC_IMAGE = 'tai-doc:live';
export const DOC_CONTAINER_PREFIX = 'tai-doc-';
/** The only names the host ever kills, inspects or removes by name. */
export const DOC_CONTAINER_NAME = /^tai-doc-[0-9a-f]{12}$/;
export const DOC_LABEL = 'tai-doc';
export const DOC_LABEL_STARTED = 'tai-doc-started';
/** The operator's own renders (`course-docs add`, src/docs/library.ts) carry these instead: the running service's reaper lists only the labels above, so it never takes a long conversion of the operator's for a leftover. */
export const DOC_OPERATOR_LABEL = 'tai-doc-operator';
export const DOC_OPERATOR_LABEL_STARTED = 'tai-doc-operator-started';
export const RENDER_SCRIPT = '/usr/local/bin/doc-render';

export type RenderKind = 'pdf' | 'office';

export const RENDER_LIMITS = {
  /** The host kills the container this long after it started whatever happens (the script holds its own steps to 70 s). */
  wallMs: 90_000,
  /** Docker itself hanging: the guard answers this long after the wall clock. */
  guardMs: 25_000,
  memoryMb: 1024,
  pids: 64,
  cpus: 1,
  /** /tmp: memory-backed, charged to the container's memory (fontconfig's cache, nothing else). */
  tmpfsMb: 64,
  /** No single file the container writes may be bigger (`--ulimit fsize`): a page image is at most 900 KB, a PNG that is too big is thrown away. */
  fsizeBytes: 64 * 1024 * 1024,
  nofile: 256,
  /** What the host keeps of what the container printed: the head of it. */
  printedBytes: 4096,
} as const;

/**
 * What an Office file is given beyond a PDF's (renderContainerSpec): LibreOffice needs more memory (1.5 GB, with the same amount as swap: none) and a longer clock (the script holds its steps to 130 s, the
 * host kills the container at 150 s). Nothing else differs, which is what the CS6650 host's measurements allow (src/docs/smoke.ts, docs/COURSE_DOCS.md): at most 18 threads, a /tmp that held 3.6 MB at
 * its fullest (the profile is 0.3 MB, a deck of forty photographs made a PDF of 3 MB), one CPU, no network.
 */
export const OFFICE_RENDER_LIMITS = {
  wallMs: 150_000,
  memoryMb: 1536,
  pids: 64,
  tmpfsMb: 64,
} as const;

interface KindLimits {
  wallMs: number;
  memoryMb: number;
  pids: number;
  tmpfsMb: number;
}
export const limitsOf = (kind: RenderKind): KindLimits => (kind === 'office' ? OFFICE_RENDER_LIMITS : RENDER_LIMITS);

/** The name the source has in the container's /in (and so in the host's run directory): neutral for an Office file, the script decides what it is. */
export const sourceNameOf = (kind: RenderKind): string => (kind === 'office' ? 'source.bin' : 'source.pdf');

/** The environment of the render container: exactly this. */
export const RENDER_ENV: readonly string[] = ['HOME=/tmp', 'LC_ALL=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1', 'TZ=UTC', 'XDG_CACHE_HOME=/tmp'];

/** A container or a run directory older than this is a leftover: the longest render, with its queue, is under two minutes. */
export const RENDER_REAP_MS = 120_000;
const IMAGE_CACHE_MS = 30_000;
/** What `docker run` costs before the script starts is a property of the host (6 to 14 s on the CS6650 one): the clock of the container is Docker's own StartedAt. */
export const newRenderContainerName = (): string => `${DOC_CONTAINER_PREFIX}${randomBytes(6).toString('hex')}`;

export interface RenderSpecOptions {
  name: string;
  startedMs: number;
  image: string;
  user: HostUser;
  /** The run directory's `in` (source.pdf): read-only in the container. */
  inDir: string;
  /** The run directory's `out`: the one place the container writes. */
  outDir: string;
  maxPages: number;
  maxPx: number;
  /** What the file is (default a PDF): the script is told, and an Office file has the limits of OFFICE_RENDER_LIMITS. */
  kind?: RenderKind;
  /** The operator's render (labelled apart: DOC_OPERATOR_LABEL), not the service's. */
  operator?: boolean;
}

const envFlags = (env: readonly string[]): string[] => env.flatMap((e) => ['-e', e]);

/** The `docker run` words of the render container. Every number that reaches them is checked here, whoever built it. */
export function renderContainerSpec(o: RenderSpecOptions): ContainerSpec {
  const whole = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max;
  if (!DOC_CONTAINER_NAME.test(o.name)) throw new RangeError('the renderer container name is not one of its own');
  if (!whole(o.maxPages, 1, 500) || !whole(o.maxPx, 200, 4000) || !whole(o.user.uid, 0, 2 ** 31) || !whole(o.user.gid, 0, 2 ** 31) || !whole(o.startedMs, 0, 2 ** 53)) {
    throw new RangeError('a number of the render container is out of range');
  }
  if (!mountable(o.inDir) || !mountable(o.outDir)) throw new RangeError('a directory of the render container cannot be mounted');
  const kind: RenderKind = o.kind ?? 'pdf';
  if (kind !== 'pdf' && kind !== 'office') throw new RangeError('the kind of the render is not one of its own');
  const limits = limitsOf(kind);
  const args = [
    'run',
    '--name', o.name,
    '--label', `${o.operator ? DOC_OPERATOR_LABEL : DOC_LABEL}=1`,
    '--label', `${o.operator ? DOC_OPERATOR_LABEL_STARTED : DOC_LABEL_STARTED}=${o.startedMs}`,
    '--pull', 'never',
    '--init',
    '--log-driver', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--network', 'none',
    '--pids-limit', String(limits.pids),
    '--memory', `${limits.memoryMb}m`,
    '--memory-swap', `${limits.memoryMb}m`,
    '--cpus', String(RENDER_LIMITS.cpus),
    '--user', `${o.user.uid}:${o.user.gid}`,
    '--ulimit', `nofile=${RENDER_LIMITS.nofile}:${RENDER_LIMITS.nofile}`,
    '--ulimit', `fsize=${RENDER_LIMITS.fsizeBytes}:${RENDER_LIMITS.fsizeBytes}`,
    '--ulimit', 'core=0',
    '--hostname', 'doc',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsMb}m`,
    '--workdir', '/tmp',
    '-v', `${o.inDir}:/in:ro`,
    '-v', `${o.outDir}:/out:rw`,
    ...envFlags(RENDER_ENV),
    o.image,
    RENDER_SCRIPT,
    kind,
    String(o.maxPages),
    String(o.maxPx),
  ];
  return { name: o.name, args };
}

// ---------------------------------------------------------------- what the container says

export const RENDER_FAILED = 'The document service could not prepare that file: something is wrong on the server, not with their file. Say so in a short sentence and go on without the viewer.';

export const RENDER_TOO_SLOW_OFFICE = `Preparing that file took longer than ${OFFICE_RENDER_LIMITS.wallMs / 1000} seconds, so it was dropped. A very large or complex file can do that. Say so in a short sentence and suggest a PDF export or a shorter file.`;

/** The refusals the script can print (deploy/cs6650/doc-render/doc-render), and what the host says for each. Anything else it prints is not passed on. */
const REFUSALS: Array<{ says: string; reason: 'bad-file' | 'failed'; message: string }> = [
  { says: 'the file is protected with a password.', reason: 'bad-file', message: 'That file is protected with a password, so it cannot be opened. Say so in a short sentence and ask the student for a copy without a password.' },
  { says: 'the file could not be read as a PDF.', reason: 'bad-file', message: 'That file could not be read as a PDF (it may be damaged, or not a real PDF). Say so in a short sentence and ask the student to attach it again, or another copy.' },
  { says: 'the file has no pages.', reason: 'bad-file', message: 'That file has no pages, so there is nothing to show. Say so in a short sentence.' },
  { says: 'no page of the file could be drawn.', reason: 'bad-file', message: 'None of the pages of that file could be drawn (it may be damaged or use something the viewer cannot draw). Say so in a short sentence and go on without it.' },
  // (an Office file: what office-kind.py and the conversion can say)
  { says: 'the file is not a PowerPoint, Word or Excel file.', reason: 'bad-file', message: 'That file is a zip, but not a PowerPoint (.pptx), Word (.docx) or Excel (.xlsx) file, so the viewer cannot show it. Say so in a short sentence and suggest a PDF, or one of those.' },
  { says: 'the file could not be read as an Office file.', reason: 'bad-file', message: 'That file could not be read as a PowerPoint, Word or Excel file (it may be damaged or cut off). Say so in a short sentence and ask the student to attach it again, or to export a PDF.' },
  { says: 'the file has too many parts or is too big when unpacked.', reason: 'bad-file', message: 'That file has too many parts, or is far bigger than it looks once it is unpacked, so the viewer will not open it. Say so in a short sentence and suggest a PDF export or a smaller file.' },
  { says: 'the file contains macros.', reason: 'bad-file', message: 'That file contains macros, which the viewer does not run or open. Say so in a short sentence and suggest saving it without macros, or exporting a PDF.' },
  { says: 'the file could not be converted.', reason: 'bad-file', message: 'The viewer could not convert that file (it may be damaged, or use something it cannot draw). Say so in a short sentence and suggest exporting it as a PDF.' },
  { says: 'converting the file took too long.', reason: 'failed', message: RENDER_TOO_SLOW_OFFICE },
  { says: 'there is nowhere to convert the file.', reason: 'failed', message: RENDER_FAILED },
];

export const RENDER_TOO_SLOW = `Preparing that file took longer than ${RENDER_LIMITS.wallMs / 1000} seconds, so it was dropped. A very large or complex file can do that. Say so in a short sentence and suggest a shorter file or a few pages of it.`;
export const RENDER_OUT_OF_MEMORY = 'Preparing that file used more memory than the service allows, so it was dropped. It is probably very large or complex. Say so in a short sentence and suggest a shorter file.';
export const RENDER_BAD_OUTPUT = 'The document service could not use what it made of that file. Say so in a short sentence and go on without the viewer.';
export const RENDER_NOT_SET_UP = 'Showing documents is not set up on this server yet. Say so in a short sentence and go on without it.';

/** The head of what the container printed as one short line for a log: no control characters. */
export const excerpt = (text: string, max = 200): string => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The peak memory the script reports on its last line (`doc-mem <bytes>`), for the log and the smoke only. */
export function reportedMemory(printed: string): number | undefined {
  const m = /^doc-mem (\d{1,13})\s*$/m.exec(printed);
  return m ? Number(m[1]) : undefined;
}

/** What the conversion of an Office file took, as the script reports it on a line of its own (`doc-conv <ms>`): for the log and the smoke only. */
export function reportedConvertMs(printed: string): number | undefined {
  const m = /^doc-conv (\d{1,9})\s*$/m.exec(printed);
  return m ? Number(m[1]) : undefined;
}

function refusalOf(printed: string): (typeof REFUSALS)[number] | undefined {
  const line = /^doc: (.{1,200})$/m.exec(printed);
  return line ? REFUSALS.find((r) => r.says === line[1]) : undefined;
}

// ---------------------------------------------------------------- the renderer

export interface RendererDeps {
  /** The directory the renderer owns: the run directories (`run-<id>`). */
  dir: string;
  log: SandboxLog;
  docker?: DockerClient;
  image?: string;
  hostUser?: HostUser;
  now?: () => number;
  /** The operator's renderer (the `course-docs` commands): its containers are labelled apart (DOC_OPERATOR_LABEL) and it reaps only those. */
  operator?: boolean;
  /** Tests: shorter clocks than RENDER_LIMITS' (and `officeWallMs`: than OFFICE_RENDER_LIMITS'). */
  limits?: { wallMs?: number; guardMs?: number; officeWallMs?: number };
}

export interface RenderTiming {
  /** From the call to the end of the container's removal. */
  totalMs: number;
  /** What starting the container cost, by Docker's own clock (from `docker run` to the script's first instruction), when Docker said. */
  startMs?: number;
  /** What the script itself took (Docker's StartedAt to FinishedAt), when Docker said. */
  runMs?: number;
  /** The container's peak memory as the script reported it: for the log and the smoke only. */
  memoryBytes?: number;
  /** An Office file: what LibreOffice's conversion took, as the script reported it (the rest of `runMs` is the pages). */
  convertMs?: number;
}

export type RenderResult =
  | { ok: true; readback: Extract<Readback, { ok: true }>; timing: RenderTiming }
  | { ok: false; reason: 'bad-file' | 'failed'; message: string; timing: RenderTiming };

export interface Renderer {
  /** `kind` is what the bytes are by their first bytes (src/docs/docs.ts kindOfBytes): a PDF (default) or a zip the container decides about. */
  render(bytes: Buffer, options?: { maxPages?: number; maxPx?: number; kind?: RenderKind }): Promise<RenderResult>;
  /** Whether the image is there (the operator built it with `tai_live.sh doc build`). */
  ready(): Promise<boolean>;
  /** Removes renderer containers and run directories that outlived their time; the number removed. Never throws. */
  reap(): Promise<number>;
  /** Renders in progress (the service's gate bounds them; this is for the log and the tests). */
  active(): number;
}

const defaultUser = (): HostUser => ({ uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 });

async function attempt<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

/**
 * Removes a directory the container wrote in. A directory it made with no permission for its owner would stop `rm -r` (the host's own user owns it, so it can always be made writable again):
 * on a failure the tree is walked once with `lstat` (never through a link) to give directories their permissions back, and removed again.
 */
export function removeTree(dir: string): boolean {
  const fix = (d: string, depth: number): void => {
    if (depth > 8) return;
    let names: string[];
    try {
      fs.chmodSync(d, 0o700);
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const child = path.join(d, name);
      try {
        if (fs.lstatSync(child).isDirectory()) fix(child, depth + 1);
      } catch {
        /* gone */
      }
    }
  };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    fix(dir, 0);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      return false;
    }
  }
  return !fs.existsSync(dir);
}

export function createRenderer(deps: RendererDeps): Renderer {
  const docker =
    deps.docker ??
    createDockerClient(deps.operator ? { label: DOC_OPERATOR_LABEL, startedLabel: DOC_OPERATOR_LABEL_STARTED, namePattern: DOC_CONTAINER_NAME } : { label: DOC_LABEL, startedLabel: DOC_LABEL_STARTED, namePattern: DOC_CONTAINER_NAME });
  const now = deps.now ?? Date.now;
  const image = deps.image ?? DOC_IMAGE;
  const user = deps.hostUser ?? defaultUser();
  const log = deps.log;
  const wallMsOf = (kind: RenderKind): number => (kind === 'office' ? (deps.limits?.officeWallMs ?? OFFICE_RENDER_LIMITS.wallMs) : (deps.limits?.wallMs ?? RENDER_LIMITS.wallMs));
  const guardMs = deps.limits?.guardMs ?? RENDER_LIMITS.guardMs;
  /** The run directories and containers of renders in progress: the reaper leaves them alone. */
  const inflight = new Set<string>();
  let running = 0;
  let imageSeen: { at: number; there: boolean } | null = null;
  let imageChecking: Promise<boolean> | null = null;

  async function ready(): Promise<boolean> {
    if (imageSeen && now() - imageSeen.at < IMAGE_CACHE_MS) return imageSeen.there;
    // renders that begin together share one question to Docker
    imageChecking ??= (async () => {
      const there = (await attempt(() => docker.imageExists(image))) === true;
      imageSeen = { at: now(), there };
      return there;
    })().finally(() => {
      imageChecking = null;
    });
    return imageChecking;
  }

  interface Ended {
    startFailed: boolean;
    exitCode: number | null;
    timedOut: boolean;
    oom: boolean;
    printed: string;
    timing: Omit<RenderTiming, 'totalMs'>;
  }

  /** The one container, from `docker run` to its removal. The host's clock is the last word. */
  async function runContainer(spec: ContainerSpec, abandoned: { value: boolean }, wallMs: number): Promise<Ended> {
    const name = spec.name;
    inflight.add(name);
    let printed = '';
    let hostFired = false;
    const began = now();
    const timer = setTimeout(() => {
      hostFired = true;
      void attempt(() => docker.kill(name));
    }, wallMs);
    let ended: { exitCode: number | null; error?: string } = { exitCode: null, error: 'not started' };
    let info: DockerInspect | null = null;
    let diag = '';
    try {
      ended = await docker.run(
        spec,
        (chunk) => {
          if (printed.length < RENDER_LIMITS.printedBytes) printed += chunk.toString('utf8', 0, RENDER_LIMITS.printedBytes);
        },
        (d) => {
          if (diag.length < 1024) diag += d.toString('utf8');
        },
      );
      clearTimeout(timer);
      info = abandoned.value ? null : await attempt(() => docker.inspect(name));
    } catch (err) {
      ended = { exitCode: null, error: (err as Error).message };
    } finally {
      clearTimeout(timer);
      await attempt(() => docker.remove(name));
      inflight.delete(name);
    }
    const timing: Ended['timing'] = {};
    let elapsedMs = now() - began;
    if (info?.startedAtMs !== undefined && info.finishedAtMs !== undefined && info.finishedAtMs >= info.startedAtMs) {
      timing.startMs = Math.min(60_000, Math.max(0, info.startedAtMs - began));
      timing.runMs = info.finishedAtMs - info.startedAtMs;
      elapsedMs = timing.runMs;
    }
    const memory = reportedMemory(printed);
    if (memory !== undefined) timing.memoryBytes = memory;
    const converted = reportedConvertMs(printed);
    if (converted !== undefined) timing.convertMs = converted;
    const startFailed = ended.error !== undefined || info === null;
    if (startFailed && !abandoned.value) log.warn({ container: name, error: ended.error, exit: ended.exitCode, docker: excerpt(diag, 300) }, 'docs: docker did not run the renderer');
    const exit = info ? info.exitCode : ended.exitCode;
    const oom = info?.oomKilled === true;
    const killedCode = exit === 124 || exit === 137 || exit === null;
    const timedOut = !oom && killedCode && (hostFired || elapsedMs >= wallMs - 500);
    return { startFailed, exitCode: exit, timedOut, oom, printed, timing };
  }

  async function inner(bytes: Buffer, kind: RenderKind, maxPages: number, maxPx: number, abandoned: { value: boolean }, t0: number): Promise<RenderResult> {
    const timingOf = (t: Omit<RenderTiming, 'totalMs'> = {}): RenderTiming => ({ totalMs: now() - t0, ...t });
    if (!mountable(deps.dir)) return { ok: false, reason: 'failed', message: RENDER_FAILED, timing: timingOf() };
    const runName = `run-${randomBytes(8).toString('hex')}`;
    const runDir = path.join(deps.dir, runName);
    const inDir = path.join(runDir, 'in');
    const outDir = path.join(runDir, 'out');
    inflight.add(runName);
    try {
      try {
        fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(runDir, { mode: 0o700 });
        fs.chmodSync(runDir, 0o700);
        fs.mkdirSync(inDir, { mode: 0o755 });
        fs.chmodSync(inDir, 0o755); // (whatever the umask: the container's user must be able to read it)
        fs.mkdirSync(outDir, { mode: 0o755 });
        fs.chmodSync(outDir, 0o755);
        createFileExclusive(path.join(inDir, sourceNameOf(kind)), bytes, inDir, 0o644);
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'docs: the source could not be staged');
        return { ok: false, reason: 'failed', message: RENDER_FAILED, timing: timingOf() };
      }
      if (abandoned.value) return { ok: false, reason: 'failed', message: RENDER_FAILED, timing: timingOf() };

      const spec = renderContainerSpec({ name: newRenderContainerName(), startedMs: now(), image, user, inDir, outDir, maxPages, maxPx, kind, operator: deps.operator === true });
      const r = await runContainer(spec, abandoned, wallMsOf(kind));
      const timing = timingOf(r.timing);
      if (r.startFailed) return { ok: false, reason: 'failed', message: RENDER_FAILED, timing };
      if (r.oom) return { ok: false, reason: 'failed', message: RENDER_OUT_OF_MEMORY, timing };
      if (r.timedOut) return { ok: false, reason: 'failed', message: kind === 'office' ? RENDER_TOO_SLOW_OFFICE : RENDER_TOO_SLOW, timing };
      if (r.exitCode !== 0) {
        const refusal = r.exitCode === 2 ? refusalOf(r.printed) : undefined;
        if (refusal) return { ok: false, reason: refusal.reason, message: refusal.message, timing };
        log.warn({ exit: r.exitCode, printed: excerpt(r.printed) }, 'docs: the renderer failed');
        return { ok: false, reason: 'failed', message: RENDER_FAILED, timing };
      }
      // the container is gone (removed in runContainer): only now is its directory read
      const readback = readbackOutput(outDir);
      if (!readback.ok) {
        log.warn({ reason: readback.reason, detail: readback.detail, printed: excerpt(r.printed) }, 'docs: the renderer output did not pass the checks');
        return { ok: false, reason: readback.reason === 'no-pages' ? 'bad-file' : 'failed', message: readback.reason === 'no-pages' ? REFUSALS[3].message : RENDER_BAD_OUTPUT, timing };
      }
      if (readback.wordsRejected > 0) log.warn({ rejected: readback.wordsRejected }, 'docs: some words files did not pass the checks and were dropped');
      return { ok: true, readback, timing };
    } finally {
      // whatever happened: the directory goes
      if (!removeTree(runDir) && RUN_DIR.test(runName)) log.warn({ dir: runName }, 'docs: a run directory could not be removed (the reaper will)');
      inflight.delete(runName);
    }
  }

  async function render(bytes: Buffer, options: { maxPages?: number; maxPx?: number; kind?: RenderKind } = {}): Promise<RenderResult> {
    const t0 = now();
    const maxPages = options.maxPages ?? DOC_LIMITS.pages;
    const maxPx = options.maxPx ?? DOC_LIMITS.imagePx;
    const kind: RenderKind = options.kind === 'office' ? 'office' : 'pdf';
    const wallMs = wallMsOf(kind);
    running++;
    const abandoned = { value: false };
    let guard: ReturnType<typeof setTimeout> | undefined;
    const guarded = new Promise<RenderResult>((resolve) => {
      guard = setTimeout(() => {
        abandoned.value = true;
        resolve({ ok: false, reason: 'failed', message: kind === 'office' ? RENDER_TOO_SLOW_OFFICE : RENDER_TOO_SLOW, timing: { totalMs: now() - t0 } });
      }, wallMs + guardMs);
    });
    try {
      return await Promise.race([inner(bytes, kind, maxPages, maxPx, abandoned, t0), guarded]);
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'docs: a render failed unexpectedly');
      return { ok: false, reason: 'failed', message: RENDER_FAILED, timing: { totalMs: now() - t0 } };
    } finally {
      clearTimeout(guard);
      running--;
    }
  }

  async function reap(): Promise<number> {
    let removed = 0;
    const t = now();
    try {
      for (const c of await docker.list()) {
        if (!DOC_CONTAINER_NAME.test(c.name) || inflight.has(c.name)) continue;
        const age = c.startedMs === null ? Infinity : t - c.startedMs;
        if (age > RENDER_REAP_MS && (await docker.remove(c.name))) removed++;
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'docs: the reaper could not list containers');
    }
    try {
      for (const name of fs.readdirSync(deps.dir)) {
        if (!RUN_DIR.test(name) || inflight.has(name)) continue;
        const dir = path.join(deps.dir, name);
        const info = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
        if (t - info.mtimeMs > RENDER_REAP_MS && (removeRunDir(dir, deps.dir) || removeTree(dir))) removed++;
      }
    } catch {
      /* no directory yet: nothing to remove */
    }
    return removed;
  }

  return { render, ready, reap, active: () => running };
}
