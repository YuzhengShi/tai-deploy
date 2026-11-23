/**
 * Staging: the one directory a run's code is put in (docs/GO_SANDBOX.md), made by the host's user and removed when the run ends.
 *
 *   <deps.dir>/run-<16 hex>/            mode 0700: nobody else on the host reads a student's code
 *     in/                               what the containers mount read-only as /in
 *       files/<path>                    inline files (each created exclusively, mode 0644, never through a link), or one attached `.go` file as main.go
 *       source.tgz                      a repository's archive (fetched by the host) or an attached archive: ONE file, never unpacked here
 *       stdin                           what a program reads, when it was given any
 *
 * Nothing else is ever written by the host into a run directory, and the host never extracts an archive: the run container does, into its own memory-backed, size-limited /work.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createFileExclusive, readBytesSafe } from '../safe-fs.js';
import { fetchRepoArchive } from './fetch.js';
import { SANDBOX_LIMITS, cleanSandboxPath } from './types.js';
import type { SandboxRequest } from './types.js';

export const RUN_DIR = /^run-[0-9a-f]{16}$/;

/** `goMod`: for inline files that need modules, the text of the go.mod the modules container would read (the top one), so that the runner can see whether the cache holds it all. */
export type StageResult = { ok: true; modules: boolean; goMod?: string } | { ok: false; phase: 'fetch' | 'stage'; message: string };

export interface StageOptions {
  /** `<deps.dir>/run-<id>`: made here (it must not exist). */
  runDir: string;
  request: SandboxRequest;
  who: { folder: string; githubUsername?: string };
  /** groups/<folder>/uploads: the student's attached files. */
  uploadsDir: string;
  githubToken: string | undefined;
  fetchImpl: typeof fetch;
  /** How long the fetch of a repository may take at most (the budget's share). */
  fetchWallMs: number;
}

const within = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// the modules script's own test, line by line: grep -Eq '^[[:space:]]*require[[:space:](]'
const REQUIRE_LINE = /^[ \t\v\f\r]*require[ \t\v\f\r(]/m;

/**
 * Whether inline code needs its modules downloaded first, by the modules script's own rule (deploy/cs6650/sandbox/sandbox-modules): inline files are worked on at their
 * top, so only a go.mod there counts, and only when it has a `require` line and there is no vendor folder beside it; otherwise the script would start, find nothing to
 * download and exit, which costs a container start for nothing. The go.mod's text comes along for the runner's look at the cache.
 */
function inlineNeedsModules(files: Array<{ path: string; content: string }>): { modules: boolean; goMod?: string } {
  const goMod = files.find((f) => f.path === 'go.mod');
  if (!goMod || !REQUIRE_LINE.test(goMod.content) || files.some((f) => f.path.startsWith('vendor/'))) return { modules: false };
  return { modules: true, goMod: goMod.content };
}

const UPLOAD_TEXT = 'Not run: the file they attached is not there under that name, or it is not a regular file of a size the sandbox takes. Say so and ask them to attach it again.';

/** Makes `runDir` and puts the request's code (and stdin) in it. Never throws: a failure is the phase and a sentence. The directory is left for the caller to remove. */
export async function stageRun(o: StageOptions): Promise<StageResult> {
  const { runDir, request } = o;
  const inDir = path.join(runDir, 'in');
  const filesDir = path.join(inDir, 'files');
  try {
    fs.mkdirSync(path.dirname(runDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(runDir, { mode: 0o700 });
    fs.chmodSync(runDir, 0o700);
    fs.mkdirSync(inDir, { mode: 0o755 });
    fs.chmodSync(inDir, 0o755); // (whatever the umask: the container's user must be able to read it)
  } catch {
    return { ok: false, phase: 'stage', message: 'Not run: the sandbox could not make room for the code on the server. Say so and try again in a minute.' };
  }

  let modules = false;
  let goMod: string | undefined;
  const source = request.source;
  try {
    if (source.kind === 'files') {
      fs.mkdirSync(filesDir, { mode: 0o755 });
      for (const f of source.files) {
        const clean = cleanSandboxPath(f.path);
        if (clean === null) return { ok: false, phase: 'stage', message: 'Not run: a file name is not allowed.' };
        const target = path.join(filesDir, ...clean.split('/'));
        if (!within(filesDir, target)) return { ok: false, phase: 'stage', message: 'Not run: a file name is not allowed.' };
        createFileExclusive(target, f.content, filesDir, 0o644);
      }
      ({ modules, goMod } = inlineNeedsModules(source.files));
    } else if (source.kind === 'repo') {
      const fetched = await fetchRepoArchive({
        owner: o.who.githubUsername,
        repo: source.name,
        ref: source.ref,
        token: o.githubToken,
        destFile: path.join(inDir, 'source.tgz'),
        fetchImpl: o.fetchImpl,
        maxBytes: SANDBOX_LIMITS.archiveBytes,
        wallMs: o.fetchWallMs,
      });
      if (!fetched.ok) return { ok: false, phase: 'fetch', message: fetched.message };
      modules = true; // the archive stays closed here: the modules container looks inside it and downloads only when there is something to download
    } else {
      // an attached file: read with the group folder (the parent of uploads/) as the root, because the student's own agent can replace uploads/ itself with a link
      const isGo = /\.go$/i.test(source.name);
      const bytes = readBytesSafe(path.join(o.uploadsDir, source.name), isGo ? SANDBOX_LIMITS.maxFileBytes : SANDBOX_LIMITS.archiveBytes, path.dirname(o.uploadsDir));
      if (bytes === null || bytes.length === 0) return { ok: false, phase: 'stage', message: UPLOAD_TEXT };
      if (isGo) {
        fs.mkdirSync(filesDir, { mode: 0o755 });
        createFileExclusive(path.join(filesDir, 'main.go'), bytes, filesDir, 0o644);
      } else {
        createFileExclusive(path.join(inDir, 'source.tgz'), bytes, inDir, 0o644);
        modules = true;
      }
    }
    if (request.stdin !== undefined) createFileExclusive(path.join(inDir, 'stdin'), request.stdin, inDir, 0o644);
  } catch {
    return { ok: false, phase: 'stage', message: 'Not run: the sandbox could not put the code in place on the server. Say so and try again in a minute.' };
  }
  return goMod === undefined ? { ok: true, modules } : { ok: true, modules, goMod };
}

/** Removes a run directory (and only one: the name and its place are checked again). Whether it is gone. */
export function removeRunDir(runDir: string, root: string): boolean {
  try {
    if (!RUN_DIR.test(path.basename(runDir)) || path.resolve(path.dirname(runDir)) !== path.resolve(root)) return false;
    const info = fs.lstatSync(runDir, { throwIfNoEntry: false });
    if (!info) return true;
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    fs.rmSync(runDir, { recursive: true, force: true });
    return !fs.existsSync(runDir);
  } catch {
    return false;
  }
}
