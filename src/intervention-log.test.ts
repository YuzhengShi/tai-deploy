import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { interventionLine, logPatrolDecision, takeSendFlag, type PatrolRecord } from './intervention-log.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-intervention-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const DAY = '2026-11-05';
const ran = (over: Partial<Extract<PatrolRecord, { kind: 'ran' }>> = {}): PatrolRecord => ({ kind: 'ran', sent: false, keys: ['inactive'], weekly: false, seconds: 41.4, gate: 'on', shadowSkip: false, ...over });

describe('a line of the patrol\'s decision log', () => {
  it('says a skip, with the signals still open and whether the weekly check was due', () => {
    expect(interventionLine(DAY, { kind: 'skipped', keys: ['inactive', 'due-last:1234', 'misconception:ab12cd34'], weekly: false })).toBe(
      '- 2026-11-05: no-action — the gate skipped the run (no container, no model) | open signals: inactive, due-last:1234, misconception:ab12cd34 | weekly check not due',
    );
    expect(interventionLine(DAY, { kind: 'skipped', keys: [], weekly: true })).toBe('- 2026-11-05: no-action — the gate skipped the run (no container, no model) | open signals: none | weekly check due');
  });

  it('says whether a run that finished sent a message, with the seconds it took', () => {
    expect(interventionLine(DAY, ran({ sent: true }))).toBe('- 2026-11-05: intervene — the model ran and sent the student a message | signals: inactive | new signal | gate on | 41 s');
    expect(interventionLine(DAY, ran({ keys: [], weekly: true }))).toBe('- 2026-11-05: no-action — the model ran and sent no message | signals: none | weekly check | gate on | 41 s');
    expect(interventionLine(DAY, ran({ gate: 'shadow', shadowSkip: true }))).toContain('gate shadow (it would have skipped)');
    expect(interventionLine(DAY, ran({ gate: 'off', keys: [] }))).toContain('gate off | 41 s');
  });

  it('says how a run failed: the model could not be reached, it never finished, or it broke; and whether a message had gone out before', () => {
    const base = { sent: false, keys: ['inactive'], weekly: false, seconds: 12, gate: 'on' };
    expect(interventionLine(DAY, { kind: 'failed', why: 'model', apiFailure: 'busy', ...base })).toBe(
      '- 2026-11-05: failed — the model could not be reached (busy) | signals: inactive | no message sent | nothing kept, the next patrol looks again | gate on | 12 s',
    );
    expect(interventionLine(DAY, { kind: 'failed', why: 'unfinished', ...base })).toContain('failed — the run did not finish (its container was stopped, or it ran out of time)');
    expect(interventionLine(DAY, { kind: 'failed', why: 'error', sent: true, keys: [], weekly: false, seconds: 3, gate: 'on' })).toContain('failed — the run failed | signals: none | a message had already been sent');
  });

  it('is made of keys, numbers and fixed words: a key cannot carry a line break, a quote, a bar or a space, and there are twelve at most', () => {
    const line = interventionLine(DAY, { kind: 'skipped', keys: ['due-last:9\n- 2026-11-06: intervene | "hi"', ...Array.from({ length: 20 }, (_v, i) => `k${i}`)], weekly: false });
    expect(line.split('\n')).toHaveLength(1);
    expect(line).not.toContain('"');
    expect(line.match(/ \| /g)).toHaveLength(2);                                     // the three fields it has, and no fourth made by a key
    expect(line.split('open signals: ')[1].split(' | ')[0].split(', ')).toHaveLength(12);
    expect(line).toContain('due-last:9-2026-11-06:intervene');
  });
});

describe('writing it', () => {
  const file = () => path.join(root, 'competency', 'intervention-log.md');

  it('starts the file with a heading when there is none, and puts the newest line first under it', () => {
    logPatrolDecision(root, { kind: 'skipped', keys: [], weekly: false }, new Date(2026, 10, 3, 9).getTime());
    logPatrolDecision(root, ran({ sent: true }), new Date(2026, 10, 4, 9).getTime());
    const text = fs.readFileSync(file(), 'utf-8');
    expect(text.startsWith('# Intervention Log\n\n- 2026-11-04: intervene')).toBe(true);
    expect(text.indexOf('2026-11-04')).toBeLessThan(text.indexOf('2026-11-03'));
  });

  it('keeps the heading of the file the seed made, and everything the model wrote there', () => {
    fs.mkdirSync(path.join(root, 'competency'), { recursive: true });
    fs.writeFileSync(file(), '# Intervention Log\n\n- 2026-11-02: no-action — the model\'s own line\n');
    logPatrolDecision(root, ran(), new Date(2026, 10, 3, 9).getTime());
    const text = fs.readFileSync(file(), 'utf-8');
    expect(text).toMatch(/^# Intervention Log\n\n- 2026-11-03: no-action — the model ran and sent no message[^\n]*\n- 2026-11-02: no-action — the model's own line\n$/);
  });

  it('never throws: a log that cannot be written is a warning, not a failed patrol', () => {
    const blocked = path.join(root, 'a-file');
    fs.writeFileSync(blocked, 'x');
    const warnings: string[] = [];
    expect(() => logPatrolDecision(path.join(blocked, 'group'), ran(), Date.now(), (m) => warnings.push(m))).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/could not write the patrol's decision/);
  });
});

describe('the marker a send tool leaves', () => {
  const marker = (folder: string) => path.join(root, 'ipc', folder, 'messages', '.send_message_used');
  const make = (folder: string) => {
    fs.mkdirSync(path.dirname(marker(folder)), { recursive: true });
    fs.writeFileSync(marker(folder), '');
  };

  it('is taken once: true when it was there, and gone afterwards', () => {
    make('s_ada');
    expect(takeSendFlag('s_ada', root)).toBe(true);
    expect(fs.existsSync(marker('s_ada'))).toBe(false);
    expect(takeSendFlag('s_ada', root)).toBe(false);
  });

  it('is only that student\'s: another folder\'s marker stays, and a name that is not a plain folder is nothing', () => {
    make('s_ada');
    make('s_bob');
    expect(takeSendFlag('s_ada', root)).toBe(true);
    expect(fs.existsSync(marker('s_bob'))).toBe(true);
    expect(takeSendFlag('../s_bob', root)).toBe(false);
    expect(takeSendFlag('', root)).toBe(false);
    expect(fs.existsSync(marker('s_bob'))).toBe(true);
  });
});
