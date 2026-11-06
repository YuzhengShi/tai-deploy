import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import { seedCompetencyFile } from './competency-seed.js';
import { ipcMediaPath } from './ipc-media.js';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'groups', 'global', 'COMPETENCY_TEMPLATE.md');

describe("a student's COMPETENCY.md", () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-seed-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('is made from the template with what the allowlist knows', () => {
    const group = dir();
    expect(seedCompetencyFile(group, TEMPLATE, { name: 'Ada Lovelace', githubUsername: 'ada-eval', canvasUserId: '1001' })).toBe('created');
    const text = fs.readFileSync(path.join(group, 'COMPETENCY.md'), 'utf-8');
    expect(text).toContain('- Name: Ada Lovelace');
    expect(text).toContain('- GitHub: ada-eval\n- Canvas User ID: 1001');
    expect(text).not.toContain('[student name]');
    expect(text).not.toContain('[username]');
    // the rest of the template is as it was: the mastery scores, the sections the model fills in
    expect(text).toContain('## Mastery Scores');
    expect(text).toContain('## Effective Approaches');
    // the lines start_mock_interview reads it by
    expect(/^(?:[-*\s]*)?\**(?:Student name|Student|Name)\**:\s*([^\n\r]+)/im.exec(text)?.[1]).toBe('Ada Lovelace');
    expect(/Canvas User ID:\s*(\d+)/i.exec(text)?.[1]).toBe('1001');
    expect(/GitHub:\s*(\S+)/i.exec(text)?.[1]).toBe('ada-eval');
  });

  it('is completed, never rewritten, when it exists', () => {
    const group = dir();
    expect(seedCompetencyFile(group, TEMPLATE, { name: 'Bob', canvasUserId: '1002' })).toBe('created');
    expect(fs.readFileSync(path.join(group, 'COMPETENCY.md'), 'utf-8')).toContain('- GitHub: (not given yet)\n- Canvas User ID: 1002');
    expect(seedCompetencyFile(group, TEMPLATE, { name: 'Bob', canvasUserId: '1002' })).toBe('kept');
    // the model writes in the file: the student's record is what is there, not what the template says
    const file = path.join(group, 'COMPETENCY.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('## Mastery Scores', '## Mastery Scores\n\nRaft: 0.4 (my own note)'));
    expect(seedCompetencyFile(group, TEMPLATE, { name: 'Someone Else', githubUsername: 'bob-gh', canvasUserId: '9999' })).toBe('completed');
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).toContain('- Name: Bob');                       // already filled: left alone
    expect(text).toContain('- GitHub: bob-gh');                  // was a placeholder: now known
    expect(text).toContain('- Canvas User ID: 1002');            // already there: left alone
    expect(text).toContain('Raft: 0.4 (my own note)');
  });

  it('takes a name as a name and ignores an account that is not one', () => {
    const group = dir();
    seedCompetencyFile(group, TEMPLATE, { name: 'Dollar $& $1 <b>Sign`s', githubUsername: 'not a user!', canvasUserId: '12ab' });
    const text = fs.readFileSync(path.join(group, 'COMPETENCY.md'), 'utf-8');
    expect(text).toContain('- Name: Dollar $& $1 bSigns');
    expect(text).toContain('- GitHub: (not given yet)');
    expect(text).not.toContain('Canvas User ID');
  });

  it('makes the logs COMPETENCY.md sends the agent to, so that its first edit of one has a file, and never touches one that is there', () => {
    const group = dir();
    seedCompetencyFile(group, TEMPLATE, { name: 'Ana' });
    const logs = fs.readdirSync(path.join(group, 'competency')).sort();
    expect(logs).toEqual(['intervention-log.md', 'interviews.md', 'strategy-log.md']);
    expect(fs.readFileSync(path.join(group, 'competency', 'interviews.md'), 'utf-8')).toContain('## Interview History (most recent first)');
    // interaction-summary.md is how the persona knows a student is new: it is not made here
    expect(fs.existsSync(path.join(group, 'competency', 'interaction-summary.md'))).toBe(false);
    fs.writeFileSync(path.join(group, 'competency', 'strategy-log.md'), ['# Teaching Strategy Log', '', '2026-11-02: SOCRATIC on Raft | 0.4 to 0.5', ''].join('\n'));
    seedCompetencyFile(group, TEMPLATE, { name: 'Ana' });
    expect(fs.readFileSync(path.join(group, 'competency', 'strategy-log.md'), 'utf-8')).toContain('SOCRATIC on Raft');
  });

  it('says so when there is no template and nothing to complete', () => {
    expect(seedCompetencyFile(dir(), path.join(os.tmpdir(), 'no-such-template.md'), { name: 'X' })).toBe('no-template');
  });
});

describe('a file a container names for the host to send', () => {
  const data = path.resolve('/srv/tai/data');
  it('is inside that group IPC directory, or nowhere', () => {
    expect(ipcMediaPath('s_abc', '/workspace/ipc/media/diagram-1.png', data)).toBe(path.join(data, 'ipc', 's_abc', 'media', 'diagram-1.png'));
    for (const bad of ['/workspace/ipc/../../../../etc/passwd', '/workspace/ipc/../other/media/x.png', '/etc/passwd', '../../x', '/workspace/ipc/', '/workspace/ipc/media/..', '']) {
      expect(ipcMediaPath('s_abc', bad, data), bad).toBeNull();
    }
    expect(ipcMediaPath('s_abc', '/workspace/ipc/media/../../s_other/media/x.png', data)).toBeNull();
  });
});
