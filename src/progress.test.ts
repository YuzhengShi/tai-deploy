import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { masterySnapshot, progressSteps } from './progress.js';

const map = (o: Record<string, number>) => new Map(Object.entries(o));

describe('progressSteps', () => {
  it('names a concept that reached getting there or solid from a lower band', () => {
    const before = map({ 'Raft leader election': 0.2, Docker: 0.5, Terraform: 0.1 });
    const after = map({ 'Raft leader election': 0.45, Docker: 0.9, Terraform: 0.2 });
    expect(progressSteps(before, after)).toEqual([
      { concept: 'Docker', was: 'getting there', now: 'solid' },
      { concept: 'Raft leader election', was: 'just started', now: 'getting there' },
    ]);
  });

  it('says nothing of a first touch, a step inside a band, or slipping back', () => {
    expect(progressSteps(map({ A: 0, B: 0.5, C: 0.8 }), map({ A: 0.2, B: 0.6, C: 0.5 }))).toEqual([]);
  });

  it('counts a concept that was not in the file before as starting from nothing', () => {
    expect(progressSteps(map({ A: 0.1 }), map({ A: 0.1, New: 0.5 }))).toEqual([{ concept: 'New', was: 'not started', now: 'getting there' }]);
  });

  it('has nothing to compare to when the file was not there before, so a file that comes with its values is no progress', () => {
    expect(progressSteps(new Map(), map({ A: 0.9, B: 0.5 }))).toEqual([]);
  });

  it('gives the biggest gains first, and at most three', () => {
    const before = map({ A: 0.1, B: 0.1, C: 0.1, D: 0.1 });
    const after = map({ A: 0.45, B: 0.9, C: 0.6, D: 0.5 });
    expect(progressSteps(before, after).map((s) => s.concept)).toEqual(['B', 'C', 'D']);
    expect(progressSteps(before, after, 1).map((s) => s.concept)).toEqual(['B']);
  });
});

describe('masterySnapshot', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the student\'s concepts and their confidence, and nothing when there is no file', () => {
    const groups = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-progress-'));
    dirs.push(groups);
    expect(masterySnapshot(groups, 's_0123456789abcdef0123').size).toBe(0);
    fs.mkdirSync(path.join(groups, 's_0123456789abcdef0123'));
    fs.writeFileSync(
      path.join(groups, 's_0123456789abcdef0123', 'COMPETENCY.md'),
      '# COMPETENCY\n\n## Mastery\nRaft (leader election, log replication): 0.4 | 0.2 | [theoretical] | [socratic_dialogue] | 2026-11-01\nDocker: 0.0 | 0.0 | [] | [] | never\n',
    );
    const snapshot = masterySnapshot(groups, 's_0123456789abcdef0123');
    expect(snapshot.get('Raft (leader election, log replication)')).toBe(0.4);
    expect(snapshot.get('Docker')).toBe(0);
  });
});
