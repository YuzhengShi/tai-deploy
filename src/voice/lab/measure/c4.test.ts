import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseRawLog } from './analyze.js';
import { clientToolTurns, readTrace, renderClient, renderTrace, summarizeClient, summarizeTrace, type TraceRow } from './c4.js';

type Rec = Record<string, unknown>;

/** A raw log of one call with the given records after the header (the same JSON lines the client writes). */
function log(chain: string, scenarios: Rec[], records: Rec[]): string {
  const header = { k: 'call', v: 1, callId: `${chain}-tools-r1-a1-x`, chain, path: 'api/voice', mode: 'chat', set: 'tools', run: 1, attempt: 1, wall: '2026-11-14T10:00:00.000Z', frameMs: 40, scenarios: scenarios.length };
  return [header, ...scenarios, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n';
}
const scn = (id: string, ueSentAt: number, end: number): Rec => ({ k: 'scn', id, class: 'tool', set: 'tools', position: 0, voice: 'V', begin: ueSentAt - 2000, end, firstFrame: 0, frames: 50, ueMs: 2000, ueFrame: 50, ueSentAt, segments: [] });
const status = (t: number, state: string): Rec => ({ k: 'e', t, type: 'status', state });
const audio = (t: number): Rec => ({ k: 'a', t, n: 3000 });

describe('the client\'s view of the fillers (clientToolTurns)', () => {
  it('a filler after 1.5 s of work is a timed one, read against the moment it was due; the answer ends the wait', () => {
    const call = parseRawLog(log('L', [scn('x01', 2000, 20000)], [status(2500, 'thinking'), status(3000, 'working'), status(4600, 'speaking'), audio(4620), audio(4700), status(5200, 'working'), status(8000, 'thinking'), status(9500, 'speaking'), audio(9520), audio(9600)]));
    const [turn] = clientToolTurns(call);
    expect(turn).toMatchObject({ chain: 'L', id: 'x01', workingAt: 3000, waitMs: 6520 });
    expect(turn.fillers).toEqual([{ kind: 'timed', at: 4620, lateMs: 120 }]);
  });

  it('a filler that came at once is an immediate one; a second line five seconds after a timed one is a "still"', () => {
    const quick = parseRawLog(log('D', [scn('x01', 2000, 20000)], [status(3000, 'working'), status(3100, 'speaking'), audio(3150), status(3900, 'working'), status(8000, 'thinking'), status(8200, 'speaking'), audio(8250)]));
    expect(clientToolTurns(quick)[0].fillers).toEqual([{ kind: 'immediate', at: 3150, lateMs: 150 }]);
    const slow = parseRawLog(log('D', [scn('x01', 2000, 40000)], [status(3000, 'working'), status(4600, 'speaking'), audio(4650), status(5200, 'working'), status(9700, 'speaking'), audio(9760), status(10300, 'working'), status(20000, 'thinking'), status(21000, 'speaking'), audio(21050)]));
    const fillers = clientToolTurns(slow)[0].fillers;
    expect(fillers.map((f) => f.kind)).toEqual(['timed', 'still']);
    expect(fillers[1].lateMs).toBe(9760 - (4650 + 5000));
  });

  it('a scenario with no `working` status is not a tool turn, and the lead-in the model speaks before its call is not a filler', () => {
    const plain = parseRawLog(log('L', [scn('x01', 2000, 10000)], [status(2500, 'thinking'), status(3500, 'speaking'), audio(3520), audio(3600)]));
    expect(clientToolTurns(plain)).toEqual([]);
    const lead = parseRawLog(log('L', [scn('x01', 2000, 20000)], [status(2500, 'thinking'), status(3000, 'speaking'), audio(3020), status(3600, 'working'), status(7000, 'thinking'), status(7600, 'speaking'), audio(7620)]));
    const [turn] = clientToolTurns(lead);
    expect(turn.fillers).toEqual([]);                                  // the first run followed `thinking`: the model's own words
    expect(turn.waitMs).toBe(7620 - 3600);
  });

  it('counts long waits with no filler and quick waits with one', () => {
    const turns = [
      { callId: 'c', chain: 'L', id: 'a', workingAt: 0, waitMs: 6000, fillers: [{ kind: 'timed' as const, at: 1600, lateMs: 100 }] },
      { callId: 'c', chain: 'L', id: 'b', workingAt: 0, waitMs: 6000, fillers: [] },
      { callId: 'c', chain: 'L', id: 'c', workingAt: 0, waitMs: 2000, fillers: [] },
      { callId: 'c', chain: 'L', id: 'd', workingAt: 0, waitMs: 2000, fillers: [{ kind: 'immediate' as const, at: 100, lateMs: 100 }] },
      { callId: 'c', chain: 'L', id: 'e', workingAt: 0, waitMs: null, fillers: [] },
    ];
    expect(summarizeClient(turns)).toMatchObject({ toolTurns: 5, withFiller: 2, longWaits: 2, longWithoutFiller: 1, quickWaits: 2, quickWithFiller: 1, timedN: 1, timedLateP50: 100, immediateN: 1, stillN: 0 });
    expect(renderClient('L', summarizeClient(turns))).toContain('a filler in 2');
  });
});

describe('the lab\'s own view (summarizeTrace)', () => {
  const row = (fn: Array<[number, number]>, fillers: Array<[number, number | null]>, extra: Partial<TraceRow> = {}): TraceRow => ({
    functions: fn.map(([startedAt, answeredAt]) => ({ name: 'f', startedAt, answeredAt })),
    fillers: fillers.map(([injectedAt, audioAt]) => ({ text: 'one sec', injectedAt, ...(audioAt === null ? {} : { audioAt }) })),
    ...extra,
  });

  it('reads the injection to first audio of every filler, and the three rules of C4 from the functions\' own durations', () => {
    const rows: TraceRow[] = [
      row([[1000, 4000]], [[2500, 2540]]),                              // 3 s function, filler, audio after 40 ms
      row([[1000, 9000]], [[2500, 2520], [7500, 7560]]),                // 8 s function, two lines
      row([[1000, 1500]], []),                                          // 0.5 s function, no filler
      row([[1000, 5000]], []),                                          // 4 s function and no filler: a miss
      row([[1000, 1400]], [[1100, 1150]]),                              // 0.4 s function with a filler: a miss
      { functions: [], fillers: [] },                                   // not a tool turn
    ];
    expect(summarizeTrace(rows)).toEqual({
      toolTurns: 5,
      fillers: 4,
      audioP50: 40,                                                       // 20, 40, 50, 60 ms
      audioP90: 50,
      noAudio: 0,
      longTurns: 3,
      longWithoutFiller: 1,
      quickTurns: 2,
      quickWithFiller: 1,
      veryLongTurns: 1,
      veryLongWithSecond: 1,
    });
  });

  it('a filler that never got audio is counted apart, and a turn whose function never answered has no duration', () => {
    const s = summarizeTrace([row([[1000, 3000]], [[2500, null]]), { functions: [{ name: 'f', startedAt: 10 }], fillers: [] }]);
    expect(s).toMatchObject({ toolTurns: 2, fillers: 1, noAudio: 1, audioP50: null, longTurns: 1, longWithoutFiller: 0 });
  });

  it('says whether the audio of the fillers was within 300 ms at p90', () => {
    const within = summarizeTrace([row([[0, 3000]], [[1500, 1560]])]);
    const over = summarizeTrace([row([[0, 3000]], [[1500, 1900]])]);
    expect(renderTrace('h', within)).toContain('(within 300)');
    expect(renderTrace('h', over)).toContain('(OVER 300)');
  });
});

describe('readTrace', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('keeps the rows of a window, by chain, and skips a line that is not JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-'));
    dirs.push(dir);
    const file = path.join(dir, 'turns.jsonl');
    const rows = [
      { at: '2026-11-14T09:00:00.000Z', chain: 'd' },
      { at: '2026-11-14T10:00:00.000Z', chain: 'd' },
      { at: '2026-11-14T10:05:00.000Z', chain: 'h' },
      { at: '2026-11-14T10:06:00.000Z' },
      { at: '2026-11-14T12:00:00.000Z', chain: 'h' },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
    const out = readTrace(file, '2026-11-14T10:00:00.000Z', '2026-11-14T11:00:00.000Z');
    expect([...out.keys()].sort()).toEqual(['', 'd', 'h']);
    expect(out.get('d')).toHaveLength(1);
    expect(out.get('h')).toHaveLength(1);
  });
});
