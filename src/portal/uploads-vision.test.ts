/**
 * What TAi is told about a picture a student attached, with the picture tool on and off (TAI_VISION, src/vision-env.ts, docs/VISION.md). Off, the words
 * are what they were when TAi could only read a picture's text (features.test.ts pins them too). On, a picture that is in the workspace is named with the tool
 * that looks at it as well; a voice call, and a picture that was not kept in the workspace, keep the old words in both states.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UploadStore, type PendingUpload } from './uploads.js';

const PNG = Buffer.alloc(25, 0x41);
const FOLDER = 's_' + 'b'.repeat(20);

const OLD_LINE =
  '- /workspace/group/uploads/pasted-picture.png (a picture, 25 B): read the text in it with read_image_text, giving it this path; ' +
  'you cannot see charts, diagrams or what a screen looks like, so say so if the question is about that';

let dirs: string[] = [];
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-uploads-vision-'));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  delete process.env.TAI_VISION;
});
afterEach(() => {
  delete process.env.TAI_VISION;
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const picture = (store: UploadStore, name = 'pasted-picture.png'): PendingUpload => store.keepPicture(FOLDER, name, PNG.length, 'a'.repeat(32), PNG) as PendingUpload;

describe('a picture kept in the workspace, with the tool off', () => {
  it('is named in the words it has always had: the text can be read, the looks cannot be seen', () => {
    const store = new UploadStore(tmp(), undefined, () => false);
    const message = store.messageFor('what is this error?', [picture(store)]);
    expect(message.split('\n')).toContain(OLD_LINE);
    expect(message).not.toContain('look_at_image');
  });

  it('is the default: nothing in the orchestrator\'s environment, or anything but "1", changes a word', () => {
    for (const flag of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
      if (flag === undefined) delete process.env.TAI_VISION;
      else process.env.TAI_VISION = flag;
      const store = new UploadStore(tmp());
      expect(store.messageFor('x', [picture(store)]).split('\n'), JSON.stringify(flag)).toContain(OLD_LINE);
    }
  });
});

describe('a picture kept in the workspace, with the tool on', () => {
  const on = (): UploadStore => new UploadStore(tmp(), undefined, () => true);

  it('is named with its path, and TAi is told it can look at it and read its exact text, and to say so honestly when it is not clear', () => {
    const store = on();
    const line = store.messageFor('what does this chart show?', [picture(store)]).split('\n').find((l) => l.includes('pasted-picture.png'))!;
    expect(line.startsWith('- /workspace/group/uploads/pasted-picture.png (a picture, 25 B): ')).toBe(true);
    expect(line).toContain('you can look at it with look_at_image (charts, diagrams, interfaces, screenshots');
    expect(line).toContain("give it this path and the student's question");
    expect(line).toContain('read its exact text with read_image_text, giving it this path');
    expect(line).toContain('if a picture is not clear to you, say so honestly');
    expect(line).toContain('never guess what it shows');
    expect(line).not.toContain('you cannot see');
  });

  it('keeps the shape of the line the dev server and the page read: "- <path> (a picture, <size>): "', () => {
    const store = on();
    const message = store.messageFor('', [picture(store), picture(store)]);
    expect(message).toContain('I attached a file.');
    expect(message).toContain('[The student attached, saved in your workspace:]');
    const lines = message.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- \/workspace\/group\/uploads\/pasted-picture\.png \(a picture, 25 B\): /);
    expect(lines[1]).toMatch(/^- \/workspace\/group\/uploads\/pasted-picture-2\.png \(a picture, 25 B\): /);
  });

  it('follows the orchestrator\'s environment when the store is given no setting of its own, asked at each message', () => {
    const store = new UploadStore(tmp());
    const pic = picture(store);
    expect(store.messageFor('x', [pic])).not.toContain('look_at_image');
    process.env.TAI_VISION = '1';
    expect(store.messageFor('x', [pic])).toContain('look_at_image');
    process.env.TAI_VISION = '0';
    expect(store.messageFor('x', [pic]).split('\n')).toContain(OLD_LINE);
  });

  it('leaves a voice call in the old words: the call has no such tool, and the page keys a notice on "(a picture, "', () => {
    const store = on();
    const forCall = store.messageFor('look', [picture(store, 'shot.png')], 'call');
    expect(forCall).toContain('- shot.png (a picture, 25 B): you cannot see pictures; ask the student to paste the text or describe it');
    expect(forCall).not.toContain('look_at_image');
    expect(forCall).not.toContain('read_image_text');
    expect(/\(a picture, /.test(forCall)).toBe(true);
  });

  it('leaves a picture that was not kept in the workspace in the old words too: there is no file to look at', () => {
    const store = on();
    const bare = store.keepPicture(FOLDER, 'bare.png', PNG.length, 'a'.repeat(32)) as PendingUpload;           // (no bytes given: the page keeps it, the workspace does not)
    expect(bare.stored).toBeUndefined();
    const message = store.messageFor('x', [bare]);
    expect(message).toContain('- bare.png (a picture, 25 B): you cannot see pictures; ask the student to paste the text or describe it');
    expect(message).not.toContain('look_at_image');
  });

  it('changes nothing about a text file or a document', () => {
    for (const vision of [false, true]) {
      const store = new UploadStore(tmp(), undefined, () => vision);
      const code = store.keepFile(FOLDER, 'main.go', 'text', Buffer.from('package main\n')) as PendingUpload;
      const pdf = store.keepFile(FOLDER, 'paper.pdf', 'document', Buffer.from('%PDF-1.4 x')) as PendingUpload;
      const message = store.messageFor('why?', [code, pdf]);
      expect(message).toContain('- /workspace/group/uploads/main.go (text, 13 B)');
      expect(message).toContain('- /workspace/group/uploads/paper.pdf (document, 10 B)');
      expect(message).toContain('--- main.go ---\npackage main\n');
      expect(message).not.toContain('look_at_image');
    }
  });
});
