import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_CACHED_REQUIRES, cacheHolds, escapeForCache, goModFingerprint, missedModule, modulesCached, plainRequires } from './modcache.js';

const WARM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/cs6650/sandbox/warm');
const posix = process.platform !== 'win32';

let cache: string;
beforeEach(() => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-modcache-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cache, { recursive: true, force: true });
});

/** What `go mod download` leaves for one module (measured on the host: the unpacked directory, and .info .lock .mod .zip .ziphash beside a list file). */
function put(modPath: string, version: string, leave: { dir?: boolean; mod?: boolean; ziphash?: boolean; partial?: boolean } = {}): void {
  const p = escapeForCache(modPath)!;
  const v = escapeForCache(version)!;
  if (leave.dir !== false) fs.mkdirSync(path.join(cache, `${p}@${v}`), { recursive: true });
  const at = path.join(cache, 'cache', 'download', p, '@v');
  fs.mkdirSync(at, { recursive: true });
  for (const ext of ['info', 'lock', 'zip']) fs.writeFileSync(path.join(at, `${v}.${ext}`), '');
  if (leave.mod !== false) fs.writeFileSync(path.join(at, `${v}.mod`), 'module x\n');
  if (leave.ziphash !== false) fs.writeFileSync(path.join(at, `${v}.ziphash`), 'h1:x');
  if (leave.partial === true) fs.writeFileSync(path.join(at, `${v}.partial`), '');
}

const GO_MOD = 'module x\n\ngo 1.27\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n\tgithub.com/BurntSushi/toml v1.4.0 // indirect\n)\n';

describe('reading a go.mod (plainRequires)', () => {
  it('reads the warm list\'s go.mod files: two require blocks, comments, pseudo-versions', () => {
    const web = plainRequires(fs.readFileSync(path.join(WARM, 'web', 'go.mod'), 'utf8'));
    expect(web).not.toBeNull();
    expect(web!.length).toBeGreaterThan(30);
    expect(web).toContainEqual({ path: 'github.com/gin-gonic/gin', version: 'v1.12.0' });
    expect(web).toContainEqual({ path: 'github.com/modern-go/concurrent', version: 'v0.0.0-20180306012644-bacd9c7ef1dd' });
    for (const dir of fs.readdirSync(WARM)) expect(plainRequires(fs.readFileSync(path.join(WARM, dir, 'go.mod'), 'utf8')), dir).not.toBeNull();
  });

  it('takes single lines, blocks, CRLF, tabs, a toolchain, godebug, retract and tool lines, and quotes inside comments', () => {
    expect(plainRequires('module x\ngo 1.17\nrequire a.com/b v1.0.0\n')).toEqual([{ path: 'a.com/b', version: 'v1.0.0' }]);
    expect(plainRequires('module x\r\n\r\ngo 1.27.3\r\ntoolchain go1.27.3\r\n\r\nrequire (\r\n\ta.com/b v1.0.0 // indirect\r\n)\r\n')).toEqual([{ path: 'a.com/b', version: 'v1.0.0' }]);
    const busy = 'module x // "quoted" in a comment, `and back-quoted`, /* and this */\n\ngo 1.21rc1\n\ngodebug (\n\tdefault=go1.21\n)\n\nretract [v1.0.0, v1.0.5]\n\ntool a.com/b/cmd/gen\n\nrequire a.com/b v2.0.0+incompatible\n';
    expect(plainRequires(busy)).toEqual([{ path: 'a.com/b', version: 'v2.0.0+incompatible' }]);
    expect(plainRequires('module x\ngo 1.27\nrequire (\n)\n')).toEqual([]);
  });

  it('says no to anything that is not plain: then the modules container decides, as before', () => {
    const no = [
      'module x\nrequire a.com/b v1.0.0\n', // no go line: Go takes 1.16, and `go mod download` then fetches more than the go.mod names
      'module x\ngo 1.16\nrequire a.com/b v1.0.0\n',
      'module x\ngo 1.27\ngo 1.27\nrequire a.com/b v1.0.0\n',
      'module x\ngo 1.27\nrequire a.com/b v1.0.0\nreplace a.com/b => ./b\n',
      'module x\ngo 1.27\nrequire a.com/b v1.0.0\nexclude a.com/b v1.0.1\n',
      'module x\ngo 1.27\nrequire a.com/b v1.0.0\nfrobnicate a.com/b\n',
      'module x\ngo 1.27\nrequire "a.com/b" v1.0.0\n',
      'module x\ngo 1.27\nrequire `a.com/b` v1.0.0\n',
      'module x\ngo 1.27\n/* require a.com/c v1.0.0 */\nrequire a.com/b v1.0.0\n',
      'module x\ngo 1.27\nrequire (\n\ta.com/b v1.0.0\n', // the block never ends
      'module x\ngo 1.27\nrequire(\n\ta.com/b v1.0.0\n)\n', // Go reads it; this does not, and need not
      'module x\ngo 1.27\nrequire (\n\ta.com/b v1.0.0 extra\n)\n',
      'module x\ngo 1.27\nrequire a.com/b\n',
      'module x\ngo 1.27\nrequire a.com/b v1.2\n', // not canonical
      'module x\ngo 1.27\nrequire a.com/b v1.2.3+build\n',
      'module x\ngo 1.27\nrequire a.com/b latest\n',
      'module x\ngo 1.27\nrequire a.com/../../etc v1.0.0\n',
      'module x\ngo 1.27\nrequire ../../etc v1.0.0\n',
      'module x\ngo 1.27\nrequire /etc/passwd v1.0.0\n',
      'module x\ngo 1.27\nrequire a.com\\b v1.0.0\n',
      'module x\ngo 1.27\nrequire a.com/b! v1.0.0\n',
      'module x\ngo 1.27\nrequire A.com/b v1.0.0\n', // the host name is small letters
      'module x\ngo 1.27\nrequire a.com/.b v1.0.0\n',
      'module x\ngo 1.27\nrequire a.com/b. v1.0.0\n',
      'module x\ngo 1.27\nrequire a.com//b v1.0.0\n',
      'module x\ngo 1.27\n)\n',
      `module x\ngo 1.27\nrequire (\n${Array.from({ length: MAX_CACHED_REQUIRES + 1 }, (_, i) => `\ta.com/m${i} v1.0.0\n`).join('')})\n`,
      `module x\ngo 1.27\n${'// x\n'.repeat(20_000)}`,
    ];
    for (const text of no) expect(plainRequires(text), JSON.stringify(text.slice(0, 80))).toBeNull();
  });
});

describe('escaping and looking at the cache', () => {
  it('escapes capitals as Go does (github.com/!burnt!sushi/toml, seen in a real cache) and refuses a "!" of its own', () => {
    expect(escapeForCache('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml');
    expect(escapeForCache('v1.0.0-RC1')).toBe('v1.0.0-!r!c1');
    expect(escapeForCache('github.com/x!y')).toBeNull();
  });

  it('holds a go.mod\'s modules only when each has its directory, .mod and .ziphash and no .partial (the .zip and .info are not needed)', () => {
    put('github.com/google/uuid', 'v1.6.0');
    put('github.com/BurntSushi/toml', 'v1.4.0');
    expect(modulesCached(cache, GO_MOD)).toBe(true);
    expect(fs.existsSync(path.join(cache, 'github.com', '!burnt!sushi', 'toml@v1.4.0'))).toBe(true);
    for (const leave of [{ dir: false }, { mod: false }, { ziphash: false }, { partial: true }]) {
      fs.rmSync(cache, { recursive: true, force: true });
      fs.mkdirSync(cache);
      put('github.com/google/uuid', 'v1.6.0');
      put('github.com/BurntSushi/toml', 'v1.4.0', leave);
      expect(modulesCached(cache, GO_MOD), JSON.stringify(leave)).toBe(false);
    }
    expect(modulesCached(path.join(cache, 'not-there'), GO_MOD)).toBe(false);
    expect(modulesCached(cache, GO_MOD.replace('go 1.27', 'go 1.16'))).toBe(false);
  });

  it('wants the directory to be a directory and the files to be files, not links', () => {
    put('github.com/google/uuid', 'v1.6.0');
    put('github.com/BurntSushi/toml', 'v1.4.0', { dir: false });
    fs.mkdirSync(path.join(cache, 'github.com', '!burnt!sushi'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'github.com', '!burnt!sushi', 'toml@v1.4.0'), 'a file where the directory should be');
    expect(modulesCached(cache, GO_MOD)).toBe(false);
  });

  it.skipIf(!posix)('does not take a link for a module directory', () => {
    put('github.com/google/uuid', 'v1.6.0');
    put('github.com/BurntSushi/toml', 'v1.4.0', { dir: false });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-elsewhere-'));
    try {
      fs.mkdirSync(path.join(cache, 'github.com', '!burnt!sushi'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(cache, 'github.com', '!burnt!sushi', 'toml@v1.4.0'));
      expect(modulesCached(cache, GO_MOD)).toBe(false);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('never looks outside the cache, even for a requirement that did not come through plainRequires', () => {
    const looked: string[] = [];
    const real = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => (looked.push(String(p)), real(p, o))) as typeof fs.lstatSync);
    expect(cacheHolds(cache, [{ path: '../../../etc', version: 'v1.0.0' }])).toBe(false);
    expect(cacheHolds(cache, [{ path: 'a.com/b', version: '../../../../etc/passwd' }])).toBe(false);
    for (const p of looked) expect(path.relative(cache, p).startsWith('..'), p).toBe(false);
  });
});

describe('a run that missed a module, and the fingerprint', () => {
  it('reads what Go 1.27.3 printed with a file of a module missing (measured), only from a run that failed', () => {
    expect(missedModule(1, '# facts\nrouter.go:3:8: module lookup disabled by GOPROXY=off\nFAIL\tfacts [setup failed]\n')).toBe(true);
    expect(missedModule(1, 'router.go:3:8: open /gomodcache/cache/download/github.com/gin-gonic/gin/@v/v1.12.0.lock: read-only file system\n')).toBe(true);
    expect(missedModule(0, 'module lookup disabled by GOPROXY=off')).toBe(false);
    expect(missedModule(null, 'module lookup disabled by GOPROXY=off')).toBe(false);
    expect(missedModule(1, '--- FAIL: TestPing\nopen /work/x.lock: read-only file system\n')).toBe(false);
  });

  it('tells go.mod files apart by their whole text', () => {
    expect(goModFingerprint(GO_MOD)).toMatch(/^[0-9a-f]{64}$/);
    expect(goModFingerprint(GO_MOD)).toBe(goModFingerprint(`${GO_MOD}`));
    expect(goModFingerprint(GO_MOD)).not.toBe(goModFingerprint(`${GO_MOD}\n`));
  });
});
