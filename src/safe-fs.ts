/**
 * The host's reads and writes of files that a container can also write: a student's group folder (COMPETENCY.md, competency/, uploads/) and the other
 * directories a container has mounted read-write. Plain `fs.readFileSync` / `fs.writeFileSync` on such a path trust the container's agent, and that agent
 * has `bash` with no guard against `ln -s`, `mkfifo` or `rm -r <relative>`. What a student's agent (it does what the student asks) can leave there:
 *
 *   - a symbolic link to a file of the host (`competency/interviews.md -> ../../../.env`). A read follows it, and the host then writes what it read into a
 *     regular file of the student's workspace, where `cat` shows it. A write through a link to a path that does not exist yet creates a file anywhere
 *     the orchestrator can write; through a link to one that exists it overwrites it. A link on the directory itself (`uploads -> ../..`) does the same
 *     for every name inside it;
 *   - a FIFO: `open(2)` for reading blocks until someone opens the other end, and `fs.readFileSync` does it on the one thread every student shares;
 *   - a very large file (`ulimit -f` lets a command write 50 MB): read and hashed again and again on every exchange.
 *
 * `readTextSafe` opens without following a link and without blocking, only a regular file, only up to a size. `writeFileAtomicSafe` and
 * `createFileExclusive` refuse a directory that leads out of `root` (a student's folder), a target that is a link or not a regular file, and never write
 * through anything: a temporary file made with `wx` and a rename, or an exclusive create. Every refusal is "no file" for a reader and an Error for a writer.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

/** The most a host reader takes of one file of a student's folder. Real ones are a few KB (COMPETENCY.md, a log); the 2 MB of the team view's reader. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

// (not defined on Windows: the lstat before the open is what stands there)
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The real path of `dir` when it is `root` or inside it once every link is followed; null when it leads out, dangles or is not there. */
export function realDirInside(dir: string, root: string): string | null {
  try {
    const real = fs.realpathSync(dir);
    return within(fs.realpathSync(root), real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * The file's text, or null: not there, a link, not a regular file (a FIFO, a device, a directory), bigger than `maxBytes`, unreadable, or (with `root`)
 * in a directory that leads out of `root`. Never blocks and never follows a link at the file.
 */
export function readTextSafe(file: string, maxBytes: number = MAX_READ_BYTES, root?: string): string | null {
  const bytes = readBytesSafe(file, maxBytes, root);
  return bytes === null ? null : bytes.toString('utf-8');
}

/**
 * The file's bytes (for a file that is not text: an archive a student attached), under the same rules as `readTextSafe`, which this is the body of. The caller names
 * its own `maxBytes`; there is no default here because an archive's limit is not a log's.
 */
export function readBytesSafe(file: string, maxBytes: number, root?: string): Buffer | null {
  let fd: number | undefined;
  try {
    if (root !== undefined && realDirInside(path.dirname(file), root) === null) return null;
    if (!fs.lstatSync(file).isFile()) return null;
    // the file may have been swapped since the lstat: the open does not follow a link or wait for a writer, and the descriptor is checked again
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const n = fs.readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** The directory made (when missing) and checked to stay inside `root`; the real directory. Throws when it leads out: nothing is created beside a link that leads out. */
function ensureDirInside(dir: string, root: string): string {
  if (!within(path.resolve(root), path.resolve(dir))) throw new Error('refused: the directory is not inside the folder');
  fs.mkdirSync(root, { recursive: true });                         // the root is the host's own (groups/<folder>): made when it is not there yet, as the writers always did
  const realRoot = fs.realpathSync(root);
  let probe = dir;
  while (path.resolve(probe) !== path.resolve(root)) {
    try {
      fs.lstatSync(probe);
      break;
    } catch {
      probe = path.dirname(probe);                                 // (it stops at the root at the latest: `dir` is inside it)
    }
  }
  // (a link that dangles is there for lstat and not for realpath: that throws, which is the refusal)
  if (!within(realRoot, fs.realpathSync(probe))) throw new Error('refused: the directory leads outside the folder');
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  if (!within(realRoot, real)) throw new Error('refused: the directory leads outside the folder');
  return real;
}

/**
 * Writes `text` to `file` through a temporary file and a rename (a reader never sees half a file). Refuses, with an Error, a directory that leads out
 * of `root` and a file that is there as a link, a FIFO or a directory: the rename would replace a link, but the student's own link is no business of
 * the host's, and nothing is ever written through one.
 */
export function writeFileAtomicSafe(file: string, text: string | Buffer, root: string): void {
  const dir = ensureDirInside(path.dirname(file), root);
  const name = path.basename(file);
  const target = path.join(dir, name);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing && !existing.isFile()) throw new Error('refused: the file is a link or not a regular file');
  const tmp = path.join(dir, `${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: 'utf-8', flag: 'wx', mode: 0o644 });
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

/**
 * Creates `file` and fails (EEXIST) when anything is there, a link that dangles included (`wx` is O_EXCL: it never follows a link at the file). A directory
 * that leads out of `root` is an Error. For a file the host names itself, such as an upload under a free name.
 */
export function createFileExclusive(file: string, body: Buffer | string, root: string, mode = 0o644): void {
  const dir = ensureDirInside(path.dirname(file), root);
  const target = path.join(dir, path.basename(file));
  // lstat first: O_EXCL refuses a link that dangles on Linux (the host), but Windows follows it and creates the file it points at
  let taken = true;
  try {
    fs.lstatSync(target);
  } catch {
    taken = false;
  }
  if (taken) {
    const err = new Error(`EEXIST: ${path.basename(file)} is there already`) as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    throw err;
  }
  fs.writeFileSync(target, body, { flag: 'wx', mode });
}

/** Removes a file of a student's folder; a link is removed itself and never followed, a directory that leads out of `root` is left alone. Whether it did. */
export function unlinkSafe(file: string, root: string): boolean {
  try {
    if (realDirInside(path.dirname(file), root) === null) return false;
    if (fs.lstatSync(file).isDirectory()) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
