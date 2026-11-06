// The host's access to files a container can also write (src/safe-fs.ts). The container's agent has bash and its group folder is mounted read-write; a link or a
// FIFO it plants is what a plain readFileSync / writeFileSync of the host would follow or wait on. Links and FIFOs are skipped where the machine cannot make one
// (Windows without the privilege, no mkfifo): the live host (Linux) runs them.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_READ_BYTES, createFileExclusive, readTextSafe, realDirInside, unlinkSafe, writeFileAtomicSafe } from './safe-fs.js';

let root: string;
let group: string;
let outside: string;

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-safefs-'));
  dirs.push(dir);
  return dir;
}

function canLink(): boolean {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'a'), 'x');
    fs.symlinkSync('a', path.join(dir, 'b'));
    return true;
  } catch {
    return false;
  }
}
function canFifo(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('mkfifo', [path.join(tmp(), 'f')]);
    return true;
  } catch {
    return false;
  }
}
const LINKS = canLink();
const FIFOS = canFifo();

beforeEach(() => {
  root = tmp();
  group = path.join(root, 'groups', 's_x');
  outside = path.join(root, 'outside');
  fs.mkdirSync(group, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'secret.env'), 'GATEWAY_KEY=sk-not-real\n');
});

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readTextSafe', () => {
  it('reads a regular file, an empty one, and answers null for what is not there', () => {
    fs.writeFileSync(path.join(group, 'a.md'), 'hello ünï');
    fs.writeFileSync(path.join(group, 'empty.md'), '');
    expect(readTextSafe(path.join(group, 'a.md'))).toBe('hello ünï');
    expect(readTextSafe(path.join(group, 'a.md'), undefined, group)).toBe('hello ünï');
    expect(readTextSafe(path.join(group, 'empty.md'))).toBe('');
    expect(readTextSafe(path.join(group, 'missing.md'))).toBeNull();
    expect(readTextSafe(group)).toBeNull();                                  // a directory
  });

  it('refuses a file over the size cap, whole, not cut', () => {
    fs.writeFileSync(path.join(group, 'big.md'), 'x'.repeat(MAX_READ_BYTES + 1));
    fs.writeFileSync(path.join(group, 'edge.md'), 'y'.repeat(MAX_READ_BYTES));
    expect(readTextSafe(path.join(group, 'big.md'))).toBeNull();
    expect(readTextSafe(path.join(group, 'edge.md'))?.length).toBe(MAX_READ_BYTES);
    expect(readTextSafe(path.join(group, 'big.md'), 10 * 1024 * 1024)?.length).toBe(MAX_READ_BYTES + 1);
  });

  it.skipIf(!LINKS)('does not follow a link at the file: what it points at is not read', () => {
    fs.symlinkSync(path.join(root, 'secret.env'), path.join(group, 'abs.md'));
    fs.symlinkSync('../../secret.env', path.join(group, 'rel.md'));
    expect(readTextSafe(path.join(group, 'abs.md'))).toBeNull();
    expect(readTextSafe(path.join(group, 'rel.md'), undefined, group)).toBeNull();
  });

  it.skipIf(!LINKS)('does not read through a directory that leads out of the root, when it is given one', () => {
    fs.writeFileSync(path.join(outside, 'interviews.md'), 'someone else\'s file');
    fs.symlinkSync(outside, path.join(group, 'competency'), 'dir');
    expect(readTextSafe(path.join(group, 'competency', 'interviews.md'), undefined, group)).toBeNull();
    expect(realDirInside(path.join(group, 'competency'), group)).toBeNull();
    expect(realDirInside(group, group)).not.toBeNull();
  });

  it.skipIf(!FIFOS)('answers at once for a FIFO instead of waiting for a writer (a plain readFileSync never comes back)', () => {
    execFileSync('mkfifo', [path.join(group, 'strategy-log.md')]);
    const began = Date.now();
    expect(readTextSafe(path.join(group, 'strategy-log.md'), undefined, group)).toBeNull();
    expect(Date.now() - began).toBeLessThan(1000);
  });
});

describe('writeFileAtomicSafe', () => {
  it('writes, replaces and creates directories inside the root, leaving no temporary file', () => {
    const file = path.join(group, 'competency', 'log.md');
    writeFileAtomicSafe(file, 'one', group);
    writeFileAtomicSafe(file, 'two', group);
    expect(fs.readFileSync(file, 'utf-8')).toBe('two');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['log.md']);
    writeFileAtomicSafe(path.join(group, 'bytes.bin'), Buffer.from([1, 2, 3]), group);
    expect([...fs.readFileSync(path.join(group, 'bytes.bin'))]).toEqual([1, 2, 3]);
  });

  it.skipIf(!LINKS)('refuses a file that is a link: the host writes nothing through it and does not replace it', () => {
    const link = path.join(group, 'memory_store.json');
    fs.symlinkSync(path.join(root, 'secret.env'), link);
    expect(() => writeFileAtomicSafe(link, '{}', group)).toThrow(/refused/);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(root, 'secret.env'), 'utf-8')).toBe('GATEWAY_KEY=sk-not-real\n');
    expect(fs.readdirSync(group)).toEqual(['memory_store.json']);              // not even a temporary file is left
  });

  it.skipIf(!LINKS)('refuses a directory that leads out of the root, and creates nothing beside a link that leads out', () => {
    fs.symlinkSync(outside, path.join(group, 'competency'), 'dir');
    expect(() => writeFileAtomicSafe(path.join(group, 'competency', 'interviews.md'), 'x', group)).toThrow(/refused/);
    expect(() => writeFileAtomicSafe(path.join(group, 'competency', 'deeper', 'a.md'), 'x', group)).toThrow(/refused/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.skipIf(!LINKS)('refuses a directory link that dangles', () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(group, 'uploads'), 'dir');
    expect(() => writeFileAtomicSafe(path.join(group, 'uploads', 'a.txt'), 'x', group)).toThrow();
    expect(fs.existsSync(path.join(root, 'nowhere'))).toBe(false);
  });
});

describe('createFileExclusive', () => {
  it('creates a file and fails with EEXIST for what is there', () => {
    const file = path.join(group, 'uploads', 'a.txt');
    createFileExclusive(file, 'one', group);
    expect(fs.readFileSync(file, 'utf-8')).toBe('one');
    expect(() => createFileExclusive(file, 'two', group)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readFileSync(file, 'utf-8')).toBe('one');
  });

  it.skipIf(!LINKS)('fails for a link that dangles (existsSync calls its name free) and creates nothing where it points', () => {
    fs.mkdirSync(path.join(group, 'uploads'));
    fs.symlinkSync('../../../outside/new.txt', path.join(group, 'uploads', 'pwn.txt'));
    expect(fs.existsSync(path.join(group, 'uploads', 'pwn.txt'))).toBe(false);           // the old "is this name free?" test
    expect(() => createFileExclusive(path.join(group, 'uploads', 'pwn.txt'), 'attacker bytes', group)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });

  it.skipIf(!LINKS)('refuses a folder that is a link to a directory outside', () => {
    fs.symlinkSync(root, path.join(group, 'uploads'), 'dir');
    expect(() => createFileExclusive(path.join(group, 'uploads', 'brand-new.txt'), 'x', group)).toThrow(/refused/);
    expect(fs.existsSync(path.join(root, 'brand-new.txt'))).toBe(false);
  });
});

describe('unlinkSafe', () => {
  it('removes a regular file, and says whether it did', () => {
    fs.writeFileSync(path.join(group, 'a.txt'), 'x');
    expect(unlinkSafe(path.join(group, 'a.txt'), group)).toBe(true);
    expect(unlinkSafe(path.join(group, 'a.txt'), group)).toBe(false);
  });

  it.skipIf(!LINKS)('removes a link itself, never what it points at, and leaves a directory that leads out alone', () => {
    fs.symlinkSync(path.join(root, 'secret.env'), path.join(group, 'link.txt'));
    expect(unlinkSafe(path.join(group, 'link.txt'), group)).toBe(true);
    expect(fs.existsSync(path.join(root, 'secret.env'))).toBe(true);
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'keep me');
    fs.symlinkSync(outside, path.join(group, 'uploads'), 'dir');
    expect(unlinkSafe(path.join(group, 'uploads', 'victim.txt'), group)).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf-8')).toBe('keep me');
  });
});
