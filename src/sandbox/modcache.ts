/**
 * Whether the shared module cache already holds what an inline project's go.mod asks for, so that the modules container (a network, `go mod download` and nothing else)
 * can be left out of a run: one container start less, which on the CS6650 host costs 2.5 to 42 s of the minute a run has (docs/GO_SANDBOX.md, "Module step skipped").
 *
 * The host reads only the go.mod TEXT the request carried (it never opens an archive), and only looks at the cache: `lstat` of names it built from checked parts, inside
 * the cache directory, never a read or a write. Anything unusual in the go.mod is a "no", and the two containers run as before. What it looks for is what Go 1.27.3 needs
 * in the cache to build with no network, measured on the host on 2026-11-23 by putting one file of a module aside at a time (docs/GO_SANDBOX.md): the unpacked directory
 * (`<path>@<version>`), `cache/download/<path>/@v/<version>.mod` and `.ziphash`, and no `.partial`; the `.zip` and `.info` are not needed. Without the `.mod` Go says
 * "module lookup disabled by GOPROXY=off"; without the directory or the `.ziphash`, or with a `.partial`, it tries to unpack the zip again and fails on the read-only cache
 * (".../@v/<version>.lock: read-only file system"). Either way the runner then downloads and runs again (runner.ts).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** More requirements than this and the go.mod is not looked at closely: the modules container decides, as before. */
export const MAX_CACHED_REQUIRES = 200;
/** The oldest `go` line whose go.mod lists every module the build needs (module graph pruning, Go 1.17): below it, `go mod download` fetches more than the go.mod names. */
const MIN_GO_MINOR = 17;

export interface GoModRequire {
  path: string;
  version: string;
}

// The parts of a module path (Go's module.CheckPath, kept narrower): elements of letters, digits and -._~, none starting or ending with a dot; the first one a host name.
const FIRST_ELEMENT = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ELEMENT = /^[A-Za-z0-9_~-]([A-Za-z0-9._~-]*[A-Za-z0-9_~-])?$/;
// A canonical semantic version as go.mod writes it (pseudo-versions included): v, three numbers, an optional pre-release, an optional +incompatible.
const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+incompatible)?$/;
const GO_LINE = /^1\.([0-9]+)(\.[0-9]+)?((rc|beta)[0-9]+)?$/;
// Verbs whose content does not change which modules a build takes from the cache.
const IGNORED_VERBS = new Set(['module', 'toolchain', 'godebug', 'retract', 'tool', 'ignore']);

const validModulePath = (p: string): boolean => {
  if (p.length === 0 || p.length > 255) return false;
  const parts = p.split('/');
  if (parts.length > 20 || !FIRST_ELEMENT.test(parts[0])) return false;
  return parts.every((e) => ELEMENT.test(e));
};
const validVersion = (v: string): boolean => v.length <= 100 && VERSION.test(v);

/** Go's escaping of a module path or version in the cache (module.EscapePath): a capital letter becomes "!" and the small one. A "!" of its own is refused (null). */
export function escapeForCache(s: string): string | null {
  let out = '';
  for (const ch of s) {
    if (ch === '!') return null;
    out += ch >= 'A' && ch <= 'Z' ? `!${ch.toLowerCase()}` : ch;
  }
  return out;
}

/**
 * The requirements of a go.mod that is plain enough for the cache to be looked at, or null: a `go` line of 1.17 or later, `require` lines and blocks of a checked path and
 * a canonical version, at most MAX_CACHED_REQUIRES of them, and nothing else that changes which modules are built (no `replace`, no `exclude`, no verb this does not know,
 * no quoted string, no block comment, no line it cannot read).
 */
export function plainRequires(text: string): GoModRequire[] | null {
  if (text.length > 64 * 1024) return null;
  const requires: GoModRequire[] = [];
  let goMinor: number | null = null;
  let block: string | null = null;
  for (const raw of text.split('\n')) {
    const at = raw.indexOf('//');
    const line = (at === -1 ? raw : raw.slice(0, at)).trim();
    if (line === '') continue;
    // (what a comment says is its own business; in the go.mod itself a quote, a back-quote or a block comment is not plain)
    if (/["`]|\/\*/.test(line)) return null;
    const words = line.split(/\s+/);
    if (block !== null) {
      if (words.length === 1 && words[0] === ')') {
        block = null;
        continue;
      }
      if (block === 'require') {
        if (words.length !== 2) return null;
        requires.push({ path: words[0], version: words[1] });
      } else if (words.includes('(') || words.includes(')')) {
        return null;
      }
      continue;
    }
    const verb = words[0];
    const opens = words.length === 2 && words[1] === '(';
    if (verb === 'require') {
      if (opens) block = 'require';
      else if (words.length === 3) requires.push({ path: words[1], version: words[2] });
      else return null;
    } else if (verb === 'go') {
      const m = words.length === 2 ? GO_LINE.exec(words[1]) : null;
      if (!m || goMinor !== null) return null;
      goMinor = Number(m[1]);
    } else if (IGNORED_VERBS.has(verb)) {
      if (opens) block = verb;
      else if (words.length < 2 || words.includes('(') || words.includes(')')) return null;
    } else {
      return null; // replace, exclude, or anything else
    }
  }
  if (block !== null || goMinor === null || goMinor < MIN_GO_MINOR) return null;
  if (requires.length > MAX_CACHED_REQUIRES) return null;
  if (!requires.every((r) => validModulePath(r.path) && validVersion(r.version))) return null;
  return requires;
}

/** A name inside `root`, or null when it would not be (it never is for checked parts; this is the last word all the same). */
function inside(root: string, ...parts: string[]): string | null {
  const full = path.resolve(root, ...parts);
  const rel = path.relative(root, full);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? full : null;
}

const kind = (p: string): 'dir' | 'file' | 'other' | 'none' => {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  } catch {
    return 'none';
  }
};

/** Whether every requirement is in the cache the way Go would take it without a network: the unpacked directory, the `.mod`, the `.ziphash`, and no `.partial`. */
export function cacheHolds(cacheDir: string, requires: GoModRequire[]): boolean {
  const root = path.resolve(cacheDir);
  if (kind(root) !== 'dir') return false;
  for (const r of requires) {
    const p = escapeForCache(r.path);
    const v = escapeForCache(r.version);
    if (p === null || v === null) return false;
    const dir = inside(root, `${p}@${v}`);
    const mod = inside(root, 'cache', 'download', p, '@v', `${v}.mod`);
    const ziphash = inside(root, 'cache', 'download', p, '@v', `${v}.ziphash`);
    const partial = inside(root, 'cache', 'download', p, '@v', `${v}.partial`);
    if (dir === null || mod === null || ziphash === null || partial === null) return false;
    if (kind(dir) !== 'dir' || kind(mod) !== 'file' || kind(ziphash) !== 'file' || kind(partial) !== 'none') return false;
  }
  return true;
}

/** Whether the modules container can be left out for this go.mod: it is plain (plainRequires) and the cache holds all it requires (cacheHolds). */
export function modulesCached(cacheDir: string, goMod: string): boolean {
  const requires = plainRequires(goMod);
  return requires !== null && cacheHolds(cacheDir, requires);
}

/** What the runner remembers a go.mod by (when the cache looked complete for it and was not). */
export const goModFingerprint = (goMod: string): string => createHash('sha256').update(goMod).digest('hex');

/**
 * Whether a run that was started without the modules container failed for want of a module, by what Go 1.27.3 printed when a file of one was missing (measured, see the
 * top): "module lookup disabled by GOPROXY=off", or a lock file it could not make in the read-only cache. Printed by a student's program on purpose, either only makes
 * their own run download first: no harm.
 */
const MISSED_MODULE = /disabled by GOPROXY=off|\/gomodcache\/cache\/download\/\S+\.lock: read-only file system/;
export const missedModule = (exitCode: number | null, output: string): boolean => exitCode !== null && exitCode !== 0 && MISSED_MODULE.test(output);
