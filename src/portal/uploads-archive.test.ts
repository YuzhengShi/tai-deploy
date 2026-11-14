/**
 * Project archives a student attaches (`.tgz`, `.tar.gz`): what makes a file one, what the picker offers, how one is kept and named so that the Go sandbox's gate takes the name it is given,
 * what the agent and a call are told, and that a waiting one is cleaned up like any other file. (docs/RUN_CARDS.md; the sandbox's own side is src/sandbox/stage.test.ts.)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { readBytesSafe } from '../safe-fs.js';
import { SANDBOX_LIMITS, parseSandboxRequest } from '../sandbox/types.js';
import { ACCEPTED_EXTENSIONS, FOLDER_MAX_FILES, UPLOAD_MAX_BYTES, UploadStore, classifyUpload, isArchiveName, safeUploadName } from './uploads.js';
import type { PendingUpload } from './uploads.js';

const FOLDER = 's_' + 'c'.repeat(20);
/** What a gzip file starts with (the rest does not matter to the check: the sandbox unpacks it in its own container). */
const gz = (size = 64): Buffer => Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(size - 4, 0x41)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

let dirs: string[] = [];
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-uploads-archive-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Whether the sandbox's one gate takes a name as an attached file to run. */
const gateTakes = (name: string): boolean => parseSandboxRequest({ action: 'test', upload: name }).ok;

describe('what makes a file an archive', () => {
  it('is a name that ends .tgz or .tar.gz AND a file that starts like a gzip file', () => {
    for (const name of ['project.tgz', 'project.tar.gz', 'PROJECT.TGZ', 'Project.Tar.Gz', 'hw2-final_v3.tar.gz', 'a.b.c.tgz']) {
      expect(classifyUpload(name, gz()), name).toBe('archive');
      expect(isArchiveName(name), name).toBe(true);
    }
    expect(classifyUpload('tiny.tgz', Buffer.from([0x1f, 0x8b]))).toBe('archive');
  });

  it('is not a plain .gz, which is some other compressed file, with or without the right bytes', () => {
    for (const name of ['data.gz', 'notes.txt.gz', 'project.gz', 'tar.gz', 'project.tar.gzip', 'project.tgz.txt', 'project.tar']) {
      expect(classifyUpload(name, gz()), name).toBeNull();
    }
    expect(isArchiveName('data.gz')).toBe(false);
  });

  it('is not a renamed file: the bytes must be gzip\'s whatever the name says', () => {
    for (const body of [PNG, ZIP, Buffer.from('package main\n'), Buffer.from('%PDF-1.4 x'), Buffer.from([0x8b, 0x1f, 0x08]), Buffer.from([0x1f])]) {
      expect(classifyUpload('project.tgz', body)).toBeNull();
      expect(classifyUpload('project.tar.gz', body)).toBeNull();
    }
    expect(classifyUpload('project.tgz', Buffer.alloc(0))).toBeNull();
  });

  it('is not a name that would be left with no ending once it is made safe (the agent must be given a name the sandbox takes)', () => {
    for (const name of ['.tgz', '_.tgz', '-.tgz', '/.tgz', 'x.tgz ', 'x.tgz\n']) expect(classifyUpload(name, gz()), JSON.stringify(name)).toBeNull();
  });

  it('is no larger than any other file the page takes', () => {
    expect(classifyUpload('big.tgz', gz(UPLOAD_MAX_BYTES))).toBe('archive');
    expect(classifyUpload('big.tgz', gz(UPLOAD_MAX_BYTES + 1))).toBeNull();
    expect(UPLOAD_MAX_BYTES).toBeLessThanOrEqual(SANDBOX_LIMITS.archiveBytes);
  });

  it('leaves the other kinds as they were', () => {
    expect(classifyUpload('main.go', Buffer.from('package main'))).toBe('text');
    expect(classifyUpload('report.pdf', Buffer.from('%PDF-1.4 x'))).toBe('document');
    expect(classifyUpload('shot.png', PNG)).toBe('image');
    expect(classifyUpload('note.webm', Buffer.from('audio'))).toBe('audio');
    expect(classifyUpload('project.zip', ZIP)).toBeNull();
    expect(classifyUpload('tool.exe', Buffer.from('MZ'))).toBeNull();
  });
});

describe('what the picker offers', () => {
  it('has tgz, and gz because the page lists single extensions and a .tar.gz can only be matched by its last', () => {
    expect(ACCEPTED_EXTENSIONS).toContain('tgz');
    expect(ACCEPTED_EXTENSIONS).toContain('gz');
    expect(ACCEPTED_EXTENSIONS).not.toContain('tar.gz');
    // each one is what the page's readFeatures accepts (letters and digits, at most ten, no dot), once, in order
    for (const ext of ACCEPTED_EXTENSIONS) expect(ext).toMatch(/^[A-Za-z0-9]{1,10}$/);
    expect(new Set(ACCEPTED_EXTENSIONS).size).toBe(ACCEPTED_EXTENSIONS.length);
    expect([...ACCEPTED_EXTENSIONS].sort()).toEqual(ACCEPTED_EXTENSIONS);
    for (const ext of ['go', 'pdf', 'png', 'md']) expect(ACCEPTED_EXTENSIONS).toContain(ext);
    for (const ext of ['zip', 'exe', 'svg', 'tar', 'mp3']) expect(ACCEPTED_EXTENSIONS).not.toContain(ext);
  });
});

describe('the name an archive is kept under', () => {
  it('keeps .tar.gz whole, whatever else is done to the name', () => {
    expect(safeUploadName('project.tar.gz')).toBe('project.tar.gz');
    expect(safeUploadName('My Project (v2).tar.gz')).toBe('My_Project_v2_.tar.gz');
    const long = safeUploadName(`${'p'.repeat(200)}.tar.gz`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('.tar.gz')).toBe(true);
    const longTgz = safeUploadName(`${'p'.repeat(200)}.tgz`);
    expect(longTgz.length).toBeLessThanOrEqual(80);
    expect(longTgz.endsWith('.tgz')).toBe(true);
    for (const name of [long, longTgz, 'My_Project_v2_.tar.gz']) expect(gateTakes(name), name).toBe(true);
  });

  it('never starts with a dot, an underscore or a dash: the sandbox wants a letter or a digit first, and a dash can pass for an option', () => {
    expect(safeUploadName('-x.tgz')).toBe('x.tgz');
    expect(safeUploadName('--help.tar.gz')).toBe('help.tar.gz');
    expect(safeUploadName('_-._x.go')).toBe('x.go');
    expect(safeUploadName('---')).toBe('file');
    expect(gateTakes(safeUploadName('-x.tgz'))).toBe(true);
    // the names the other files had are the same
    expect(safeUploadName('main.go')).toBe('main.go');
    expect(safeUploadName('.hidden')).toBe('hidden');
    expect(safeUploadName('../../etc/passwd')).toBe('passwd');
  });

  it('gets its number before the ending when the name is taken: project-2.tar.gz, not project.tar-2.gz (which the sandbox would refuse)', () => {
    const store = new UploadStore(tmp());
    const names = [1, 2, 3].map((i) => (store.keepFile(FOLDER, 'project.tar.gz', 'archive', gz(10 + i)) as PendingUpload).name);
    expect(names).toEqual(['project.tar.gz', 'project-2.tar.gz', 'project-3.tar.gz']);
    const tgz = [1, 2].map(() => (store.keepFile(FOLDER, 'hw.tgz', 'archive', gz()) as PendingUpload).name);
    expect(tgz).toEqual(['hw.tgz', 'hw-2.tgz']);
    for (const name of [...names, ...tgz]) expect(gateTakes(name), name).toBe(true);
    // the others keep their old way
    expect((store.keepFile(FOLDER, 'main.go', 'text', Buffer.from('a')) as PendingUpload).name).toBe('main.go');
    expect((store.keepFile(FOLDER, 'main.go', 'text', Buffer.from('b')) as PendingUpload).name).toBe('main-2.go');
  });
});

describe('an archive in the student\'s workspace', () => {
  const kept = (store: UploadStore, name = 'project.tgz', body = gz(2048)): PendingUpload => store.keepFile(FOLDER, name, 'archive', body) as PendingUpload;

  it('is kept in their uploads/ as it came, and is read by the sandbox\'s own reader under the name the agent is given', () => {
    const groups = tmp();
    const store = new UploadStore(groups);
    const body = gz(2048);
    const up = kept(store, 'project.tar.gz', body);
    expect(up).toMatchObject({ name: 'project.tar.gz', kind: 'archive', size: 2048, folder: FOLDER });
    const uploadsDir = path.join(groups, FOLDER, 'uploads');
    expect(fs.readFileSync(path.join(uploadsDir, up.name)).equals(body)).toBe(true);
    // the sandbox's gate takes the name, and stage.ts reads it with this call
    const parsed = parseSandboxRequest({ action: 'test', upload: up.name });
    expect(parsed.ok && parsed.value.source).toEqual({ kind: 'upload', name: 'project.tar.gz' });
    expect(readBytesSafe(path.join(uploadsDir, up.name), SANDBOX_LIMITS.archiveBytes, path.dirname(uploadsDir))?.equals(body)).toBe(true);
  });

  it('is taken out of the workspace when its student takes it back or its time runs out, and stays when a message took it', () => {
    const groups = tmp();
    let now = 1_000_000;
    const store = new UploadStore(groups, () => now);
    const uploadsDir = path.join(groups, FOLDER, 'uploads');
    const back = kept(store, 'a.tgz');
    const late = kept(store, 'b.tgz');
    const sent = kept(store, 'c.tar.gz');
    expect(store.release(FOLDER, back.id)).toBe(true);
    expect(fs.existsSync(path.join(uploadsDir, 'a.tgz'))).toBe(false);
    expect(store.take(FOLDER, [sent.id])).toHaveLength(1);
    expect(fs.existsSync(path.join(uploadsDir, 'c.tar.gz'))).toBe(true);
    now += 31 * 60_000;
    expect(store.hasRoom(FOLDER)).toBe(true);                               // (asking sweeps what waited too long)
    expect(fs.existsSync(path.join(uploadsDir, 'b.tgz'))).toBe(false);
    expect(late.name).toBe('b.tgz');
    expect(fs.existsSync(path.join(uploadsDir, 'c.tar.gz'))).toBe(true);
  });

  it('counts against the same room as every other file', () => {
    const groups = tmp();
    const store = new UploadStore(groups);
    const uploadsDir = path.join(groups, FOLDER, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    for (let i = 0; i < FOLDER_MAX_FILES - 1; i++) fs.writeFileSync(path.join(uploadsDir, `earlier-${i}.txt`), 'x');
    expect(store.keepFile(FOLDER, 'last-one.tgz', 'archive', gz(16))).toMatchObject({ name: 'last-one.tgz', kind: 'archive' });      // the hundredth file
    expect(store.keepFile(FOLDER, 'one-more.tgz', 'archive', gz(16))).toEqual({ error: 'quota' });
    expect(fs.existsSync(path.join(uploadsDir, 'one-more.tgz'))).toBe(false);
  });

  it('is named to the agent with the tool that runs it, run_go and upload: <name>, in the style of the other files, and its bytes are not shown', () => {
    const store = new UploadStore(tmp());
    const up = kept(store, 'project.tgz', gz(3 * 1024));
    const message = store.messageFor('can you run my project?', [up]);
    expect(message).toContain('[The student attached, saved in your workspace:]');
    const line = message.split('\n').find((l) => l.includes('project.tgz'))!;
    expect(line.startsWith('- /workspace/group/uploads/project.tgz (archive, 3 KB): ')).toBe(true);
    expect(line).toContain('run it with run_go using upload: project.tgz');
    expect(line).toContain('action run, test, vet or build');
    expect(line).not.toContain('(text,');
    expect(line).not.toContain('run_code');
    expect(message.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
    expect(message).not.toContain('---');                                   // no excerpt: it is not text
    expect(message).not.toContain('AAAA');
  });

  it('is named to a call with run_code, where the function is called that', () => {
    const store = new UploadStore(tmp());
    const up = kept(store, 'hw.tar.gz');
    const line = store.messageFor('run this', [up], 'call').split('\n').find((l) => l.includes('hw.tar.gz'))!;
    expect(line).toContain('(archive, 2 KB): ');
    expect(line).toContain('run it with run_code using upload: hw.tar.gz');
    expect(line).not.toContain('run_go');
  });

  it('sits beside the other files without changing their lines', () => {
    const store = new UploadStore(tmp());
    const code = store.keepFile(FOLDER, 'main.go', 'text', Buffer.from('package main\n')) as PendingUpload;
    const pdf = store.keepFile(FOLDER, 'paper.pdf', 'document', Buffer.from('%PDF-1.4 x')) as PendingUpload;
    const message = store.messageFor('all of it', [code, kept(store), pdf]);
    const lines = message.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('- /workspace/group/uploads/main.go (text, 13 B)');
    expect(lines[1]).toMatch(/^- \/workspace\/group\/uploads\/project\.tgz \(archive, 2 KB\): /);
    expect(lines[2]).toBe('- /workspace/group/uploads/paper.pdf (document, 10 B)');
    expect(message).toContain('--- main.go ---\npackage main\n');
  });
});
