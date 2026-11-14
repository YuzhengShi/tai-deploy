import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tarGz } from './tar.js';
import type { TarEntry } from './tar.js';

/**
 * The two scripts the containers run (deploy/cs6650/sandbox/sandbox-run, sandbox-modules, with sandbox-common), under bash with a fake `go` that writes down how it was called.
 * What is checked is what the scripts decide: what they refuse, how they put the code in place, and the exact word list of the go command.
 */
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/cs6650/sandbox');
const isWin = process.platform === 'win32';
const BASH = isWin ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe', 'D:/Program Files (x86)/Git/bin/bash.exe'].find((p) => fs.existsSync(p)) : 'bash';
// (on Windows an apostrophe in an argument is taken for a quote by the runtime that starts bash, before the script ever sees it: those cases run on Linux, the host)
const plain = (list: string[]): string[] => list.filter((a) => !(isWin && a.includes("'")));
const posix = (p: string): string => (isWin ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}` : p);

const FAKE_GO = `#!/bin/bash
if [ "$1" = env ] && [ "$2" = GOVERSION ]; then echo go1.27.3; exit 0; fi
{ printf 'cwd=%s\\n' "$PWD"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } >> "$SANDBOX_TEST_LOG"
[ -z "\${SANDBOX_TEST_CAT:-}" ] || cat
[ -z "\${SANDBOX_TEST_SLEEP:-}" ] || exec sleep "$SANDBOX_TEST_SLEEP"
exit \${SANDBOX_TEST_EXIT:-0}
`;

let tmp: string;
let inDir: string;
let work: string;
let bin: string;
let logFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-scripts-'));
  inDir = path.join(tmp, 'in');
  work = path.join(tmp, 'work');
  bin = path.join(tmp, 'bin');
  logFile = path.join(tmp, 'go.log');
  for (const d of [inDir, work, bin]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'go'), FAKE_GO, { mode: 0o755 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const put = (rel: string, text: string, base = path.join(inDir, 'files')) => {
  const p = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

function script(name: 'sandbox-run' | 'sandbox-modules', args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(BASH as string, [posix(path.join(DIR, name)), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${posix(bin)}:${process.env.PATH}`,
      SANDBOX_IN: posix(inDir),
      SANDBOX_WORK: posix(work),
      SANDBOX_WARM_CACHE: posix(path.join(tmp, 'no-warm-cache')),
      GOCACHE: posix(path.join(tmp, 'gocache')),
      SANDBOX_TEST_LOG: posix(logFile),
      ...env,
    },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const run = (args: string[], env?: Record<string, string>) => script('sandbox-run', args, env);
const modules = (args: string[], env?: Record<string, string>) => script('sandbox-modules', args, env);

/** What the fake go was called with: the last call's working directory and words. */
function called(): { cwd: string; args: string[] } | null {
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  const at = lines.map((l, i) => (l.startsWith('cwd=') ? i : -1)).filter((i) => i >= 0).pop() as number;
  const block = lines.slice(at);
  return { cwd: block[0].slice(4), args: block.slice(1).map((l) => l.slice(4)) };
}
const archive = (entries: TarEntry[]) => fs.writeFileSync(path.join(inDir, 'source.tgz'), tarGz(entries));

describe.skipIf(!BASH)('sandbox-run: the go command line', () => {
  beforeEach(() => put('main.go', 'package main\nfunc main(){}\n'));

  it('run: `go run <pkg> <args>` with the program arguments as separate words, in the project directory, under the time limit', () => {
    const r = run(['run', '.', '0', '-', '20', '-', '--', '-n', '5', 'a=b']);
    expect(r.code).toBe(0);
    expect(called()).toEqual({ cwd: posix(work), args: ['run', '.', '-n', '5', 'a=b'] });
    expect(r.out).toBe(''); // nothing of its own
  });

  it('test: -race, -run=<pattern>, -count=1 and a timeout of its own under the wall clock', () => {
    run(['test', './...', '1', 'TestA|TestB', '45', '-', '--']);
    expect(called()?.args).toEqual(['test', '-race', '-run=TestA|TestB', '-count=1', '-timeout=35s', './...']);
    run(['test', './pkg', '0', '-', '15', '-', '--']);
    expect(called()?.args).toEqual(['test', '-count=1', '-timeout=5s', './pkg']);
  });

  it('vet and build: build writes nothing (-o /dev/null)', () => {
    run(['vet', './...', '0', '-', '45', '-', '--']);
    expect(called()?.args).toEqual(['vet', './...']);
    run(['build', './cmd/server', '0', '-', '45', '-', '--']);
    expect(called()?.args).toEqual(['build', '-o', '/dev/null', './cmd/server']);
  });

  it('is the exit code of go, and kills it at the time limit', () => {
    expect(run(['run', '.', '0', '-', '20', '-', '--'], { SANDBOX_TEST_EXIT: '3' }).code).toBe(3);
    const t0 = Date.now();
    const r = run(['run', '.', '0', '-', '1', '-', '--'], { SANDBOX_TEST_SLEEP: '30' });
    expect(Date.now() - t0).toBeLessThan(15_000);
    if (isWin) expect(r.code).not.toBe(0);
    else expect([124, 137]).toContain(r.code);
  });

  it('gives go the student’s stdin, and nothing when there is none', () => {
    fs.writeFileSync(path.join(inDir, 'stdin'), 'hello from stdin\n');
    expect(run(['run', '.', '0', '-', '20', '-', '--'], { SANDBOX_TEST_CAT: '1' }).out).toBe('hello from stdin\n');
    fs.rmSync(path.join(inDir, 'stdin'));
    expect(run(['run', '.', '0', '-', '20', '-', '--'], { SANDBOX_TEST_CAT: '1' }).out).toBe('');
  });

  it('puts the go command line together from words: a shell character in an argument is just a character', () => {
    const r = run(['run', '.', '0', '-', '20', '-', '--', 'x=1,y=2', 'p%q+r@s:t']);
    expect(r.code).toBe(0);
    expect(called()?.args).toEqual(['run', '.', 'x=1,y=2', 'p%q+r@s:t']);
  });

  it('uses -mod=vendor when the project has a vendor folder', () => {
    put('go.mod', 'module x\n\nrequire a v1\n');
    put('vendor/modules.txt', '# a v1\n');
    run(['run', '.', '0', '-', '20', '-', '--']);
    expect(called()?.args).toEqual(['run', '-mod=vendor', '.']);
  });

  it('makes a go.mod (module sandbox, the image’s Go) only when there is none up the tree', () => {
    run(['run', '.', '0', '-', '20', '-', '--']);
    expect(fs.readFileSync(path.join(work, 'go.mod'), 'utf8')).toBe('module sandbox\n\ngo 1.27\n');
    fs.rmSync(work, { recursive: true });
    fs.mkdirSync(work);
    fs.rmSync(path.join(inDir, 'files'), { recursive: true });
    put('main.go', 'package main\n');
    put('go.mod', 'module mine\n\ngo 1.22\n');
    run(['run', '.', '0', '-', '20', '-', '--']);
    expect(fs.readFileSync(path.join(work, 'go.mod'), 'utf8')).toBe('module mine\n\ngo 1.22\n');
  });

  it('links the image’s build cache into the run’s own and writes the time of the last trim as now (Go would otherwise trim what is older than five days)', () => {
    const warm = path.join(tmp, 'warm');
    fs.mkdirSync(path.join(warm, 'ab'), { recursive: true });
    fs.writeFileSync(path.join(warm, 'ab', 'entry-a'), 'x');
    fs.writeFileSync(path.join(warm, 'trim.txt'), '1');
    if (!isWin) fs.chmodSync(path.join(warm, 'ab'), 0o555); // the image's cache is read-only, directories too
    const before = Math.floor(Date.now() / 1000);
    run(['run', '.', '0', '-', '20', '-', '--'], { SANDBOX_WARM_CACHE: posix(warm) });
    const trim = fs.readFileSync(path.join(tmp, 'gocache', 'trim.txt'), 'utf8');
    expect(Number(trim)).toBeGreaterThanOrEqual(before - 1);
    expect(fs.lstatSync(path.join(tmp, 'gocache', 'trim.txt')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(warm, 'trim.txt'), 'utf8')).toBe('1'); // the image's own is not written through
    if (!isWin) {
      expect(fs.lstatSync(path.join(tmp, 'gocache', 'ab', 'entry-a')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(tmp, 'gocache', 'ab', 'entry-a'), 'utf8')).toBe('x');
      // Go must be able to add entries beside the image's: a copy of a read-only directory is made writable (its owner's)
      fs.writeFileSync(path.join(tmp, 'gocache', 'ab', 'new-entry-d'), 'new');
      fs.chmodSync(path.join(warm, 'ab'), 0o755);
    }
  });
});

describe.skipIf(!BASH)('sandbox-run: what it refuses', () => {
  beforeEach(() => put('main.go', 'package main\n'));
  const ok = ['run', '.', '0', '-', '20', '-', '--'];
  const refuses = (args: string[]) => {
    fs.rmSync(logFile, { force: true });
    const r = run(args);
    expect(r.code, args.join(' ')).toBe(2);
    expect(r.out, args.join(' ')).toMatch(/^sandbox: .+\n$/);
    expect(called(), args.join(' ')).toBeNull(); // go was never started
  };

  it('a call that is not what the host sends', { timeout: 60_000 }, () => {
    refuses(['run']);
    refuses(ok.slice(0, 6));
    refuses([...ok.slice(0, 6), 'nope']);
    for (const action of ['fmt', 'get', 'install', 'RUN', 'run;id', '']) refuses([action, ...ok.slice(1)]);
    for (const pkg of ['-x', '--help', '../x', '/abs', 'github.com/x/y', './a b', './a;b', './a$b', './a/../b', '...', './-x', '']) refuses(['test', pkg, '0', '-', '20', '-', '--']);
    for (const race of ['2', 'yes', '', '-1']) refuses(['test', './...', race, '-', '20', '-', '--']);
    for (const secs of ['abc', '1000', '-5', '', '1.5']) refuses(['test', './...', '0', '-', secs, '-', '--']);
    for (const pattern of plain(['-v', '-run=x', 'Test A', 'Test"A"', 'Test;rm', 'a`id`', "a'b"])) refuses(['test', './...', '0', pattern, '20', '-', '--']);
  });

  it('too many or unusual program arguments', () => {
    refuses([...ok, 'a', 'b', 'c', 'd', 'e']);
    for (const a of plain(['a b', 'a"b', "a'b", 'a;b', 'a$b', 'a`b`', 'a|b', 'a>b', 'a&b', 'x'.repeat(61)])) refuses([...ok, a]);
  });

  it('a folder that is not one: a parent, an absolute path, a hidden one, a missing one', () => {
    for (const folder of ['../x', '/etc', 'a/../b', '.git', 'a//b', 'a b', 'nope/missing', 'x;y']) refuses(['run', '.', '0', '-', '20', folder, '--']);
  });
});

describe.skipIf(!BASH)('sandbox-run: putting the code in place', () => {
  it('unpacks an archive into the project, and works inside the one directory GitHub wraps it in', () => {
    archive([
      { name: 'owner-repo-abc123/', type: 'dir' },
      { name: 'owner-repo-abc123/go.mod', data: 'module hw\n\ngo 1.22\n' },
      { name: 'owner-repo-abc123/main.go', data: 'package main\n' },
    ]);
    expect(run(['run', '.', '0', '-', '20', '-', '--']).code).toBe(0);
    expect(called()?.cwd).toBe(posix(path.join(work, 'owner-repo-abc123')));
    expect(fs.existsSync(path.join(work, 'go.mod'))).toBe(false); // the wrapper was the project: no go.mod was made beside it
  });

  it('works in a folder of the project, and finds the go.mod above it; with none, makes one at the top of the project', () => {
    archive([
      { name: 'proj/go.mod', data: 'module hw\n\ngo 1.22\n' },
      { name: 'proj/hw2/server/main.go', data: 'package main\n' },
    ]);
    run(['run', '.', '0', '-', '20', 'hw2/server', '--']);
    expect(called()?.cwd).toBe(posix(path.join(work, 'proj', 'hw2', 'server')));
    expect(fs.readFileSync(path.join(work, 'proj', 'go.mod'), 'utf8')).toBe('module hw\n\ngo 1.22\n');
    fs.rmSync(work, { recursive: true });
    fs.mkdirSync(work);
    archive([{ name: 'proj/hw2/server/main.go', data: 'package main\n' }]);
    run(['run', '.', '0', '-', '20', 'hw2/server', '--']);
    expect(fs.readFileSync(path.join(work, 'proj', 'go.mod'), 'utf8')).toBe('module sandbox\n\ngo 1.27\n');
    expect(fs.existsSync(path.join(work, 'proj', 'hw2', 'server', 'go.mod'))).toBe(false);
  });

  it('does not take a single folder of loose files for a wrapper: only an archive is unwrapped', () => {
    put('cmd/server/main.go', 'package main\n');
    run(['run', './cmd/server', '0', '-', '20', '-', '--']);
    expect(called()?.cwd).toBe(posix(work));
  });

  it('refuses a folder that is a link leading out of the project', () => {
    if (isWin) return;
    archive([
      { name: 'proj/main.go', data: 'package main\n' },
      { name: 'proj/out', type: 'symlink', linkname: '/tmp' },
    ]);
    const r = run(['run', '.', '0', '-', '20', 'out', '--']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/leads out of the project/);
  });

  it('refuses an archive that is not one, has a ".." member, or holds more files than allowed', () => {
    fs.writeFileSync(path.join(inDir, 'source.tgz'), 'this is not gzip');
    expect(run(['run', '.', '0', '-', '20', '-', '--'])).toMatchObject({ code: 2, out: expect.stringMatching(/sandbox: the archive could not be unpacked/) });
    archive([{ name: 'ok/main.go', data: 'package main\n' }, { name: '../escape.txt', data: 'out' }]);
    const r = run(['run', '.', '0', '-', '20', '-', '--']);
    expect(r.code).toBe(2);
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false); // nothing was written outside the work directory
    fs.rmSync(work, { recursive: true });
    fs.mkdirSync(work);
    archive(Array.from({ length: 2001 }, (_, i) => ({ name: `p/f${i}.txt`, data: 'x' })));
    expect(run(['run', '.', '0', '-', '20', '-', '--'])).toMatchObject({ code: 2, out: expect.stringMatching(/more than 2000 files/) });
    expect(called()).toBeNull();
  });

  it('takes an absolute member as a relative one (the leading slash is dropped), and writes nothing through a link that points out', () => {
    if (isWin) return;
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    archive([
      { name: `${posix(tmp)}/abs-target.txt`, data: 'abs' },
      { name: 'p/escape', type: 'symlink', linkname: posix(outside) },
      { name: 'p/escape/planted.txt', data: 'through the link' },
      { name: 'p/main.go', data: 'package main\n' },
    ]);
    run(['run', '.', '0', '-', '20', '-', '--']);
    expect(fs.existsSync(path.join(tmp, 'abs-target.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
  });

  it('refuses a pipe in the archive (it would block whatever opens it)', () => {
    if (isWin) return;
    archive([{ name: 'p/main.go', data: 'package main\n' }, { name: 'p/pipe.go', type: 'fifo' }]);
    expect(run(['run', '.', '0', '-', '20', '-', '--'])).toMatchObject({ code: 2, out: expect.stringMatching(/special file/) });
  });

  it('has no code to run when there is none', () => {
    expect(run(['run', '.', '0', '-', '20', '-', '--'])).toMatchObject({ code: 2, out: expect.stringMatching(/no code to run/) });
  });
});

describe.skipIf(!BASH)('sandbox-modules', () => {
  const args = ['40', '-'];

  it('does `go mod download` in the project directory when there is a go.mod that requires something, and nothing else', () => {
    put('go.mod', 'module x\n\nrequire github.com/google/uuid v1.6.0\n');
    put('main.go', 'package main\n');
    expect(modules(args).code).toBe(0);
    expect(called()).toEqual({ cwd: posix(work), args: ['mod', 'download'] });
  });

  it('does nothing (and says nothing) for no go.mod, a go.mod with no requirements, or a vendor folder', () => {
    put('main.go', 'package main\n');
    expect(modules(args)).toEqual({ code: 0, out: '' });
    put('go.mod', 'module x\n\ngo 1.22\n');
    expect(modules(args)).toEqual({ code: 0, out: '' });
    put('go.mod', 'module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n');
    put('vendor/modules.txt', '# x\n');
    expect(modules(args)).toEqual({ code: 0, out: '' });
    expect(called()).toBeNull();
  });

  it('looks inside an archive for it, in the folder asked for or above', () => {
    archive([{ name: 'w/go.mod', data: 'module x\nrequire a v1\n' }, { name: 'w/sub/main.go', data: 'package main\n' }]);
    modules(['40', 'sub']);
    expect(called()).toEqual({ cwd: posix(path.join(work, 'w')), args: ['mod', 'download'] });
  });

  it('passes the failure of go on, and refuses a call it does not understand', () => {
    put('go.mod', 'module x\nrequire a v1\n');
    expect(modules(args, { SANDBOX_TEST_EXIT: '1' }).code).toBe(1);
    for (const bad of [[], ['40'], ['x', '-'], ['40', '../x'], ['40', '-', 'extra'], ['4000', '-']]) {
      fs.rmSync(logFile, { force: true });
      expect(modules(bad).code, bad.join(' ')).toBe(2);
      expect(called()).toBeNull();
    }
  });
});
