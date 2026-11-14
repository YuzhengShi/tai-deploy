import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileSink, finishDerived, newTurnTrace, nullSink } from './trace.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-trace-'));
  dirs.push(d);
  return d;
};

const base = { sid: 's1', mode: 'chat', ears: 'labgpu', mouth: 'labgpu', turn: 1, at: '2026-11-14T06:00:00.000Z' };

function logger() {
  const warns: Array<{ obj: unknown; msg: string }> = [];
  return {
    warns,
    log: { debug: () => undefined, info: () => undefined, warn: (obj: unknown, msg: string) => warns.push({ obj, msg }), error: () => undefined },
  };
}

describe('the lab trace', () => {
  it('starts empty: no functions, no rounds, no fillers, no fallbacks', () => {
    const t = newTurnTrace(base);
    expect(t).toMatchObject({ ...base, functions: [], rounds: [], fillers: [], fallbacks: [], derived: {} });
  });

  it('derives the waits from the moments it holds, and only those it can', () => {
    const t = newTurnTrace(base);
    finishDerived(t);
    expect(t.derived).toEqual({});
    t.speechEnd = 1000;
    t.commit = 1900.4;
    t.firstAudioOut = 3100.6;
    finishDerived(t);
    expect(t.derived).toEqual({ eotWait: 900, total: 1200, fromSpeechEnd: 2101 });
  });

  it('nullSink takes anything', () => {
    expect(() => nullSink.write(newTurnTrace(base))).not.toThrow();
  });

  it('fileSink appends one JSON line a turn, numbers rounded to whole milliseconds, in a directory it makes', async () => {
    const file = path.join(tmp(), 'voice-lab', 'turns.jsonl');
    const { log, warns } = logger();
    const sink = fileSink(file, log as never);
    const t = newTurnTrace(base);
    t.commit = 1234.56;
    t.rounds.push({ thinkSent: 1300.4, firstToken: 1700.5 }, { thinkSent: 4000.2, afterAnswerMs: 12.7 });
    sink.write(t);
    sink.write({ ...t, turn: 2 });
    const deadline = Date.now() + 2000;
    while ((!fs.existsSync(file) || fs.readFileSync(file, 'utf8').split('\n').length < 3) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ turn: 1, commit: 1235, rounds: [{ thinkSent: 1300, firstToken: 1701 }, { thinkSent: 4000, afterAnswerMs: 13 }] });
    expect(lines[1].turn).toBe(2);
    expect(warns).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a file it cannot write is one warning, never an error in the call', async () => {
    const dir = tmp();
    const blocker = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    const { log, warns } = logger();
    const sink = fileSink(path.join(blocker, 'sub', 'turns.jsonl'), log as never);
    expect(() => sink.write(newTurnTrace(base))).not.toThrow();
    expect(() => sink.write(newTurnTrace(base))).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toMatch(/trace could not be written/);
  });
});

describe('finishDerived: the head start of an eager request', () => {
  it('is how long before the commit the model was asked, and is absent when it was asked at or after the commit', () => {
    const early = newTurnTrace({ sid: 'abc123', mode: 'chat', ears: 'labgpu', mouth: 'labgpu', turn: 1, at: '2026-11-14T12:00:00.000Z' });
    Object.assign(early, { speechEnd: 1000, thinkSent: 1400, commit: 1900, firstAudioOut: 3100 });
    finishDerived(early);
    expect(early.derived).toEqual({ eotWait: 900, total: 1200, fromSpeechEnd: 2100, headStart: 500 });
    const late = newTurnTrace({ sid: 'abc123', mode: 'chat', ears: 'labgpu', mouth: 'labgpu', turn: 2, at: '2026-11-14T12:00:10.000Z' });
    Object.assign(late, { speechEnd: 1000, thinkSent: 1900, commit: 1900, firstAudioOut: 3100 });
    finishDerived(late);
    expect(late.derived.headStart).toBeUndefined();
  });
});
