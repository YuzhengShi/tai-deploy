import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUN_DIR, removeRunDir, stageRun } from './stage.js';
import type { StageOptions } from './stage.js';
import type { SandboxRequest } from './types.js';

const posix = process.platform !== 'win32';
let root: string; // <deps.dir>
let groups: string; // groups/<folder>
let uploads: string;
let n = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-stage-'));
  groups = path.join(root, 'groups', 'ana');
  uploads = path.join(groups, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(path.join(root, 'sandbox'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const runDir = () => path.join(root, 'sandbox', `run-${(++n).toString(16).padStart(16, '0')}`);
const files = (...f: Array<[string, string]>): SandboxRequest => ({ action: 'run', source: { kind: 'files', files: f.map(([p, c]) => ({ path: p, content: c })) }, pkg: '.', race: false, args: [] });
const opts = (request: SandboxRequest, over: Partial<StageOptions> = {}): StageOptions => ({
  runDir: runDir(),
  request,
  who: { folder: 'ana', githubUsername: 'ana-dev' },
  uploadsDir: uploads,
  githubToken: undefined,
  fetchImpl: (() => Promise.reject(new Error('no network in this test'))) as unknown as typeof fetch,
  fetchWallMs: 1000,
  ...over,
});
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [`${e.name}/`, ...walk(path.join(dir, e.name)).map((x) => `${e.name}/${x}`)] : [e.name]));
const symlinkOk = (() => {
  try {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-ln-'));
    fs.symlinkSync(t, path.join(t, 'l'));
    fs.rmSync(t, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe('staging inline files', () => {
  it('makes the run directory (0700) with in/ holding exactly the files, each created exclusively with mode 0644', async () => {
    const o = opts(files(['main.go', 'package main\n'], ['store/store.go', 'package store\n'], ['go.mod', 'module x\n']));
    expect(await stageRun(o)).toEqual({ ok: true, modules: false });
    expect(walk(o.runDir).sort()).toEqual(['in/', 'in/files/', 'in/files/go.mod', 'in/files/main.go', 'in/files/store/', 'in/files/store/store.go']);
    expect(fs.readFileSync(path.join(o.runDir, 'in/files/store/store.go'), 'utf8')).toBe('package store\n');
    if (posix) {
      expect(fs.statSync(o.runDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(o.runDir, 'in')).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(o.runDir, 'in/files/main.go')).mode & 0o777).toBe(0o644);
    }
  });

  it('never writes outside in/: a path that was not validated is refused, and nothing is created beside the run directory', async () => {
    const before = fs.readdirSync(path.join(root, 'sandbox'));
    for (const bad of ['../evil.go', '/abs/evil.go', 'a/../../evil.go', '.hidden.go', 'a b.go']) {
      const o = opts(files(['ok.go', 'x'], [bad, 'x']));
      const r = await stageRun(o);
      expect(r.ok, bad).toBe(false);
      expect(fs.existsSync(path.join(root, 'sandbox', 'evil.go'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'evil.go'))).toBe(false);
      fs.rmSync(o.runDir, { recursive: true, force: true });
    }
    expect(fs.readdirSync(path.join(root, 'sandbox'))).toEqual(before);
  });

  it('does not write through what is already there: the second file of one name fails and the first stays as it was', async () => {
    const o = opts(files(['a.go', 'first'], ['a.go', 'second']));
    const r = await stageRun(o);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(o.runDir, 'in/files/a.go'), 'utf8')).toBe('first');
  });

  it.skipIf(!symlinkOk)('does not follow a link planted at the file or in the folder', async () => {
    const o = opts(files(['a.go', 'x']));
    fs.mkdirSync(path.join(o.runDir, 'in/files'), { recursive: true });
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'safe');
    fs.symlinkSync(outside, path.join(o.runDir, 'in/files/a.go'));
    // the run directory exists already: stageRun refuses to reuse it, which is the stronger answer
    expect((await stageRun(o)).ok).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('safe');
  });

  it('writes stdin as in/stdin, and decides that modules are needed only for a go.mod that requires something and no vendor folder', async () => {
    const withReq = opts({ ...files(['main.go', 'x'], ['go.mod', 'module x\n\nrequire github.com/google/uuid v1.6.0\n']), stdin: 'hello\n' });
    expect(await stageRun(withReq)).toEqual({ ok: true, modules: true });
    expect(fs.readFileSync(path.join(withReq.runDir, 'in/stdin'), 'utf8')).toBe('hello\n');
    expect(await stageRun(opts(files(['main.go', 'x'], ['go.mod', 'module x\n\ngo 1.22\n'])))).toEqual({ ok: true, modules: false });
    expect(await stageRun(opts(files(['go.mod', 'module x\nrequire (\n\ta v1\n)\n'], ['vendor/modules.txt', '# a v1\n'])))).toEqual({ ok: true, modules: false });
    expect(await stageRun(opts(files(['main.go', 'x'])))).toEqual({ ok: true, modules: false });
  });
});

describe('staging an attached file', () => {
  it('copies a .go file as in/files/main.go', async () => {
    fs.writeFileSync(path.join(uploads, 'hello.go'), 'package main\n');
    const o = opts({ action: 'run', source: { kind: 'upload', name: 'hello.go' }, pkg: '.', race: false, args: [] });
    expect(await stageRun(o)).toEqual({ ok: true, modules: false });
    expect(fs.readFileSync(path.join(o.runDir, 'in/files/main.go'), 'utf8')).toBe('package main\n');
  });

  it('hands an archive over as ONE file, byte for byte, and never unpacks it', async () => {
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7 + 3) % 256)); // not text: not valid UTF-8
    bytes[0] = 0x1f;
    bytes[1] = 0x8b;
    fs.writeFileSync(path.join(uploads, 'proj.tgz'), bytes);
    const o = opts({ action: 'test', source: { kind: 'upload', name: 'proj.tgz' }, pkg: './...', race: false, args: [] });
    expect(await stageRun(o)).toEqual({ ok: true, modules: true });
    expect(walk(o.runDir).sort()).toEqual(['in/', 'in/source.tgz']);
    expect(fs.readFileSync(path.join(o.runDir, 'in/source.tgz')).equals(bytes)).toBe(true);
  });

  it('says so when the file is not there, is empty, or is too big for what it is', async () => {
    const req = (name: string): SandboxRequest => ({ action: 'run', source: { kind: 'upload', name }, pkg: '.', race: false, args: [] });
    fs.writeFileSync(path.join(uploads, 'empty.go'), '');
    fs.writeFileSync(path.join(uploads, 'big.go'), 'x'.repeat(128 * 1024 + 1));
    for (const name of ['missing.go', 'empty.go', 'big.go']) {
      const r = await stageRun(opts(req(name)));
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r).toMatchObject({ phase: 'stage', message: expect.stringMatching(/not there under that name/) });
    }
  });

  it.skipIf(!symlinkOk)('does not read through a link: not at the file, and not when uploads/ itself was replaced by one', async () => {
    const secret = path.join(root, 'groups', 'secret.go');
    fs.writeFileSync(secret, 'package secret\n');
    fs.symlinkSync(secret, path.join(uploads, 'link.go'));
    const r = await stageRun(opts({ action: 'run', source: { kind: 'upload', name: 'link.go' }, pkg: '.', race: false, args: [] }));
    expect(r.ok).toBe(false);
    // uploads/ is a link to another student's folder
    const other = path.join(root, 'groups', 'bo', 'uploads');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'theirs.go'), 'package theirs\n');
    fs.rmSync(uploads, { recursive: true, force: true });
    fs.symlinkSync(other, uploads);
    const r2 = await stageRun(opts({ action: 'run', source: { kind: 'upload', name: 'theirs.go' }, pkg: '.', race: false, args: [] }));
    expect(r2.ok).toBe(false);
  });

  it.skipIf(!posix)('does not block on a FIFO named like the file', async () => {
    execFileSync('mkfifo', [path.join(uploads, 'pipe.go')]);
    const r = await stageRun(opts({ action: 'run', source: { kind: 'upload', name: 'pipe.go' }, pkg: '.', race: false, args: [] }));
    expect(r.ok).toBe(false);
  });
});

describe('staging a repository', () => {
  it('has the host fetch it from the account the host bound, into in/source.tgz, and asks for modules (the archive stays closed)', async () => {
    const urls: string[] = [];
    const gz = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(50)]);
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return urls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/ana-dev/hw/legacy.tar.gz/refs/heads/main' } }) : new Response(gz, { status: 200 });
    }) as unknown as typeof fetch;
    const o = opts({ action: 'test', source: { kind: 'repo', name: 'hw', path: 'server' }, pkg: './...', race: false, args: [] }, { fetchImpl, githubToken: 'tok' });
    expect(await stageRun(o)).toEqual({ ok: true, modules: true });
    expect(urls[0]).toBe('https://api.github.com/repos/ana-dev/hw/tarball');
    expect(walk(o.runDir).sort()).toEqual(['in/', 'in/source.tgz']);
  });

  it('is "fetch" when GitHub does not give it, and "not linked" without an account', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const req: SandboxRequest = { action: 'test', source: { kind: 'repo', name: 'hw' }, pkg: './...', race: false, args: [] };
    expect(await stageRun(opts(req, { fetchImpl: down }))).toMatchObject({ ok: false, phase: 'fetch' });
    const r = await stageRun(opts(req, { who: { folder: 'ana' } }));
    expect(r).toMatchObject({ ok: false, phase: 'fetch', message: expect.stringMatching(/not linked/) });
  });
});

describe('removing a run directory', () => {
  it('removes only a run-<16 hex> directory directly inside the sandbox directory', async () => {
    const o = opts(files(['main.go', 'x']));
    await stageRun(o);
    const sandbox = path.join(root, 'sandbox');
    expect(RUN_DIR.test(path.basename(o.runDir))).toBe(true);
    fs.mkdirSync(path.join(sandbox, 'gomodcache'));
    fs.mkdirSync(path.join(sandbox, 'run-notahexnumber00'));
    expect(removeRunDir(path.join(sandbox, 'gomodcache'), sandbox)).toBe(false);
    expect(removeRunDir(path.join(sandbox, 'run-notahexnumber00'), sandbox)).toBe(false);
    expect(removeRunDir(o.runDir, path.join(root, 'groups'))).toBe(false); // not in the directory it is said to be in
    expect(fs.existsSync(o.runDir)).toBe(true);
    expect(removeRunDir(o.runDir, sandbox)).toBe(true);
    expect(fs.existsSync(o.runDir)).toBe(false);
    expect(removeRunDir(o.runDir, sandbox)).toBe(true); // already gone is fine
    expect(fs.existsSync(path.join(sandbox, 'gomodcache'))).toBe(true);
  });

  it.skipIf(!symlinkOk)('does not follow a link named like a run directory', () => {
    const sandbox = path.join(root, 'sandbox');
    const keep = path.join(root, 'keep');
    fs.mkdirSync(keep);
    fs.writeFileSync(path.join(keep, 'precious'), 'x');
    const link = path.join(sandbox, 'run-0123456789abcdef');
    fs.symlinkSync(keep, link, 'dir');
    expect(removeRunDir(link, sandbox)).toBe(false);
    expect(fs.existsSync(path.join(keep, 'precious'))).toBe(true);
  });
});
