import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeDirs,
  analyzeLogs,
  callFacts,
  DEFINITIONS,
  FROZEN_SHA256,
  parseRawLog,
  quantileCheck,
  rateCheck,
  readRawLogs,
  renderReport,
  runOf,
  statusList,
  zeroCheck,
  type Check,
  type RawCall,
  type Report,
} from './analyze.js';
import { DEFAULT_TIMING, type CallHeader, type EventLine, type AudioLine, type RawLine, type ScenarioLine, type WaitResult } from './run.js';
import type { CallMode, ScenarioClass } from './scenario.js';

// ---------------------------------------------------------------- a hand-written timeline of a call, in the raw log's own lines

const WALL0 = Date.parse('2026-11-13T10:00:00.000Z');
const TESTSET = { sha256: FROZEN_SHA256, blob: '5066b76d5863429013bebd953f4305b5771f834b' };

interface CallOpts {
  mode?: CallMode;
  set?: string;
  /** wall-clock minutes after 10:00 at which the call started */
  minute?: number;
  callId?: string;
  retryOf?: string;
  testset?: { sha256: string; blob: string } | null;
  /** ms from `start` to `ready`; null: the call never became ready */
  readyMs?: number | null;
  /** ms from `start` to the first greeting frame; null: no greeting */
  greetingMs?: number | null;
  readyMode?: string;
  /** milliseconds each microphone frame was sent late (frame i), for the pacing line */
  late?: number[];
}

interface TurnSpec {
  at: number;
  id?: string;
  cls?: ScenarioClass;
  /** [begin, end] of each speech segment, ms after `at` (default one segment of 1200 ms after the 600 ms lead and 40 ms margin) */
  segments?: Array<[number, number]>;
  /** first agent frame after UE (null: no answer) */
  latency?: number | null;
  /** user transcript after UE (null: none) */
  eot?: number | null;
  answerMs?: number;
  /** a `status working` at this many ms after UE; true: 300 */
  tool?: boolean | number;
  /** an agent frame at this many ms after UE (negative: before it) */
  early?: number;
  /** another user transcript at this many ms after UE */
  extraTranscript?: number;
  settled?: boolean;
  wait?: WaitResult;
  quietMs?: number;
}

interface BargeSpec {
  at: number;
  id?: string;
  /** first answer frame, ms after the question's UE */
  answerFrom?: number;
  /** the delay the runner counts from the first answer frame */
  plan?: number;
  /** agent_interrupted this long after the onset; null: the agent is never interrupted */
  stop?: number | null;
  /** the last agent frame this long after the onset (when it is interrupted) */
  audioStop?: number;
  /** how long the agent's answer is when nothing stops it */
  answerMs?: number;
  interruptionMs?: number;
}

class CallBuilder {
  private recs: Array<{ t: number; n: number; line: EventLine | AudioLine }> = [];
  private counter = 0;
  private scenarios: ScenarioLine[] = [];
  private greetLine: RawLine | null = null;
  readonly header: CallHeader;
  readonly startAt = 10;
  private readonly readyAt: number | null;
  private lastT = 0;

  constructor(
    readonly chain: string,
    private readonly o: CallOpts = {},
  ) {
    const mode = o.mode ?? 'chat';
    this.header = {
      k: 'call',
      v: 1,
      callId: o.callId ?? `${chain}-${o.set ?? 'latency'}-${Math.round((o.minute ?? 0) * 100)}-${Math.random().toString(36).slice(2, 8)}`,
      chain,
      path: 'api/voice',
      mode,
      set: o.set ?? 'latency',
      run: 1,
      attempt: 1,
      ...(o.retryOf ? { retryOf: o.retryOf } : {}),
      wall: new Date(WALL0 + (o.minute ?? 0) * 60_000).toISOString(),
      frameMs: 40,
      scenarios: 0,
      ...(o.testset === null ? {} : { testset: o.testset ?? TESTSET }),
      timing: DEFAULT_TIMING,
    };
    const readyMs = o.readyMs === undefined ? 800 : o.readyMs;
    this.readyAt = readyMs === null ? null : this.startAt + readyMs;
    if (this.readyAt !== null) {
      const modeName = o.readyMode ?? (mode === 'interview' ? 'interviewer' : mode === 'talk' ? 'listener' : 'conversational');
      this.ev(this.readyAt, 'ready', { sessionId: 'abcd1234', mode: modeName, voice: 'v', maxSeconds: 1800, resumed: false });
      this.ev(this.readyAt, 'status', { state: 'listening' });
      const greetingMs = o.greetingMs === undefined ? 1500 : o.greetingMs;
      if (greetingMs !== null) this.speak(this.startAt + greetingMs, 1500);
    } else {
      this.ev(this.startAt + 300, 'error', { code: 'busy', message: 'a call is open' });
    }
  }

  ev(t: number, type: string, fields: Record<string, unknown> = {}): this {
    this.recs.push({ t, n: this.counter++, line: { k: 'e', t, type, ...fields } });
    this.lastT = Math.max(this.lastT, t);
    return this;
  }

  audio(t: number, n = 1920): this {
    this.recs.push({ t, n: this.counter++, line: { k: 'a', t, n } });
    this.lastT = Math.max(this.lastT, t);
    return this;
  }

  /** The agent speaks: status speaking, a 1920-byte (40 ms) frame every 40 ms, status listening just after the last. Returns when `listening` arrives. */
  speak(from: number, ms: number): number {
    this.ev(from, 'status', { state: 'speaking' });
    let last = from;
    for (let t = from; t < from + ms; t += 40) {
      this.audio(t);
      last = t;
    }
    const done = last + 5;
    this.ev(done, 'status', { state: 'listening' });
    return done;
  }

  /** A scenario of one question (or several segments) and the agent's answer; returns the end of its window. */
  turn(s: TurnSpec): number {
    const at = s.at;
    const segs = s.segments ?? [[640, 1840]];
    const abs = segs.map(([b, e]) => [at + b, at + e] as const);
    const ue = abs[abs.length - 1][1];
    const latency = s.latency === undefined ? 1500 : s.latency;
    const eot = s.eot === undefined ? 700 : s.eot;
    const answerMs = s.answerMs ?? 2000;
    let windowEnd = ue + 25_000;
    if (eot !== null) {
      this.ev(ue + eot, 'transcript', { role: 'user', text: 'what the student said', mode: 'conversational' });
      this.ev(ue + eot + 20, 'status', { state: 'thinking' });
    }
    if (s.extraTranscript !== undefined) this.ev(ue + s.extraTranscript, 'transcript', { role: 'user', text: 'a first part', mode: 'conversational' });
    if (s.tool) this.ev(ue + (s.tool === true ? 300 : s.tool), 'status', { state: 'working' });
    if (s.early !== undefined) this.audio(ue + s.early);
    if (latency !== null) windowEnd = this.speak(ue + latency, answerMs) + (s.quietMs ?? 1500);
    const line: ScenarioLine = {
      k: 'scn',
      id: s.id ?? 'l01',
      class: s.cls ?? 'latency',
      set: this.header.set,
      position: this.scenarios.length,
      voice: 'Voice A',
      begin: at,
      end: windowEnd,
      firstFrame: 0,
      frames: 100,
      ueMs: segs[segs.length - 1][1],
      ueFrame: 50,
      ueSentAt: ue,
      segments: abs.map(([b, e], i) => ({ text: `segment ${i + 1}`, beginMs: 0, endMs: 0, beginFrame: 0, endFrame: 0, beginSentAt: b, endSentAt: e })),
      wait: s.wait ?? (latency === null ? 'timeout' : 'answered'),
      settled: s.settled ?? true,
    };
    this.scenarios.push(line);
    this.lastT = Math.max(this.lastT, windowEnd);
    return windowEnd;
  }

  /** A barge-in scenario: the question, a long answer, the interruption over it, the agent's reply to it; returns the end of its window. */
  bargeIn(s: BargeSpec): number {
    const at = s.at;
    const ue = at + 640 + 1200;
    const first = ue + (s.answerFrom ?? 1200);
    const plan = s.plan ?? 2000;
    const firstSentAt = first + plan;
    const onset = firstSentAt + 40;
    const endSentAt = onset + (s.interruptionMs ?? 800);
    const stop = s.stop === undefined ? 300 : s.stop;
    this.ev(ue + 600, 'transcript', { role: 'user', text: 'tell me everything', mode: 'conversational' });
    this.ev(first, 'status', { state: 'speaking' });
    const lastAt = onset + (s.audioStop ?? 250);
    const answerEnd = stop === null ? first + (s.answerMs ?? 3500) : lastAt;
    for (let t = first; t <= answerEnd; t += 40) this.audio(t);
    if (stop !== null) {
      if ((lastAt - first) % 40 !== 0) this.audio(lastAt); // the last frame exactly where asked (the 40 ms grid of the others could not make +300 ms)
      this.ev(onset + stop, 'agent_interrupted');
      this.ev(onset + stop + 1, 'status', { state: 'listening' });
    } else {
      this.ev(answerEnd + 5, 'status', { state: 'listening' });
    }
    this.ev(endSentAt + 600, 'transcript', { role: 'user', text: 'hold on', mode: 'conversational' });
    const done = this.speak(endSentAt + 1500, 1500);
    const windowEnd = done + 1500;
    this.scenarios.push({
      k: 'scn',
      id: s.id ?? 'b1',
      class: 'bargein',
      set: this.header.set,
      position: this.scenarios.length,
      voice: 'Voice A',
      begin: at,
      end: windowEnd,
      firstFrame: 0,
      frames: 100,
      ueMs: 1840,
      ueFrame: 46,
      ueSentAt: ue,
      segments: [{ text: 'tell me everything', beginMs: 0, endMs: 0, beginFrame: 0, endFrame: 0, beginSentAt: at + 640, endSentAt: ue }],
      wait: 'answered',
      settled: true,
      interruption: {
        text: 'hold on',
        afterFirstAudioMs: plan,
        anchorAt: first,
        scheduledAt: firstSentAt,
        firstFrame: 60,
        firstSentAt,
        onsetFrame: 61,
        onsetSentAt: onset,
        endFrame: 80,
        endSentAt,
        audibleAtPlan: true,
        wait: 'answered',
      },
    });
    this.lastT = Math.max(this.lastT, windowEnd);
    return windowEnd;
  }

  /** The text of the raw log, as the runner writes it. */
  text(): string {
    const sorted = [...this.recs].sort((a, b) => a.t - b.t || a.n - b.n);
    const lines: RawLine[] = [this.header, { k: 'open', t: 3 }, { k: 'start', t: this.startAt, mode: this.header.mode }];
    if (this.readyAt !== null) {
      lines.push({ k: 'mic', t: this.readyAt, frameMs: 40 });
    }
    lines.push(...sorted.map((r) => r.line));
    if (this.greetLine) lines.push(this.greetLine);
    if (this.o.late && this.readyAt !== null) lines.push({ k: 'f', i: 0, t: this.o.late.map((l, i) => this.readyAt! + i * 40 + l) });
    lines.push(...this.scenarios);
    lines.push({ k: 'end', t: this.lastT + 100, reason: this.readyAt === null ? 'start-failed' : 'done' });
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  build(): RawCall {
    return parseRawLog(this.text(), `${this.header.callId}.jsonl`);
  }
}

/** One chat call of the given turns, one after the other. */
function chatCall(chain: string, specs: Array<Omit<TurnSpec, 'at'>>, o: CallOpts = {}): RawCall {
  const b = new CallBuilder(chain, o);
  let at = 6000;
  for (const s of specs) at = b.turn({ ...s, at });
  return b.build();
}

const A = 'L';
const B = 'D';
/** minutes that make the two chains' calls alternate: A at 2i, B at 2i + 1 */
const mA = (i: number) => 2 * i;
const mB = (i: number) => 2 * i + 1;

const lat = (n: number, v: number | ((i: number) => number)) => Array.from({ length: n }, (_, i) => (typeof v === 'number' ? v : v(i)));
/** per-turn overrides: the i-th of n turns gets f(i) */
const per = (n: number, f: (i: number) => Partial<Omit<TurnSpec, 'at'>>) => Array.from({ length: n }, (_, i) => f(i));

/** 3 calls of the 10 latency prompts: 30 turns per chain, the i-th with the i-th latency */
function latencyChain(chain: string, minute: (i: number) => number, latencies: number[], extra: Array<Partial<Omit<TurnSpec, 'at'>>> = []): RawCall[] {
  return [0, 1, 2].map((call) =>
    chatCall(
      chain,
      latencies.slice(call * 10, call * 10 + 10).map((latency, k) => ({ id: `l${k + 1}`, cls: 'latency' as const, latency, ...(extra[call * 10 + k] ?? {}) })),
      { set: 'latency', minute: minute(call) },
    ),
  );
}

const check = (r: Report, id: string): Check => {
  const found = r.criteria.flatMap((c) => c.checks).find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- facts of one trial

describe('the facts of a trial', () => {
  const facts = (spec: Omit<TurnSpec, 'at'>, scnIndex = 0) => callFacts(chatCall(A, [spec])).trials[scnIndex];

  it('reads a plain turn: the first agent frame after UE minus UE, and the user transcript after UE minus UE', () => {
    const f = facts({ latency: 1500, eot: 700 });
    expect(f.incomplete).toBe(false);
    expect(f.ue).toBe(6000 + 1840);
    expect(f.latencyMs).toBe(1500);
    expect(f.eotMs).toBe(700);
    expect(f.answered).toBe(true);
    expect(f.tool).toBe(false);
    expect(f.cutIn).toBe(false);
    expect(f.tooLong).toBe(false);
    expect(f.userTranscripts).toBe(1);
  });

  it('calls a turn a tool turn only when a `working` status came between UE and the first agent audio', () => {
    expect(facts({ tool: true }).tool).toBe(true); // working at UE + 300, first audio at UE + 1500
    expect(facts({ tool: 1499 }).tool).toBe(true);
    expect(facts({ tool: 1500 }).tool).toBe(false); // at the first frame, not between
    expect(facts({ tool: 1700 }).tool).toBe(false); // after the lead-in began: a plain turn by the document's rule
    const early = facts({ tool: -100 });
    expect(early.tool).toBe(false); // before UE: a look-up of an earlier turn
  });

  it('is a cut-in when an agent audio frame arrives before UE + 300 ms (strictly before): amendment A1', () => {
    expect(facts({ early: 299 }).cutIn).toBe(true);
    expect(facts({ early: 300 }).cutIn).toBe(false);
    expect(facts({ early: -600 }).cutIn).toBe(true);
    expect(facts({ early: 299 }).early).toBe(true);
    expect(facts({}).cutIn).toBe(false);
  });

  it('no longer calls a second user turn a cut-in: it is a split line, counted apart (the lab commits early and takes the commit back before any audio)', () => {
    const f = facts({ extraTranscript: -900 });
    expect(f.userTranscripts).toBe(2);
    expect(f.split).toBe(true);
    expect(f.cutIn).toBe(false);
    expect(f.early).toBe(false);
    expect(facts({}).split).toBe(false);
    const both = facts({ extraTranscript: -900, early: -700 }); // audio as well: a cut-in, and split
    expect([both.cutIn, both.split]).toEqual([true, true]);
  });

  it('counts agent audio that begins after the scenario began, even before the student\'s first word (it is a cut-in; `stray` says it came before the first word)', () => {
    // the scenario begins at 6000 and the student's first word is at 6640
    const b = new CallBuilder(A);
    b.audio(6100);
    b.turn({ at: 6000 });
    const f = callFacts(b.build()).trials[0];
    expect(f.stray).toBe(true);
    expect(f.early).toBe(true);
    expect(f.cutIn).toBe(true);
    expect(facts({ early: -600 }).stray).toBe(false); // in the middle of the student's words: a cut-in, not stray
  });

  it('does not count the greeting, a run of speech that began before the scenario did, or a filler the session injected while a function ran', () => {
    // the greeting is before the scenario: outside its window
    const greeting = new CallBuilder(A, { greetingMs: 5000 }); // frames from 5010 to 6500: still arriving after the scenario began at 6000
    greeting.turn({ at: 6000 });
    expect(callFacts(greeting.build()).trials[0].cutIn).toBe(false); // a run that began before the scenario did
    // a late answer: status speaking at 5900, frames to 6900
    const late = new CallBuilder(A);
    late.ev(5900, 'status', { state: 'speaking' });
    for (let t = 5900; t <= 6900; t += 40) late.audio(t);
    late.ev(6905, 'status', { state: 'listening' });
    late.turn({ at: 6000 });
    expect(callFacts(late.build()).trials[0].cutIn).toBe(false);
    // a filler: working, then a run of speech, then back to working; all before UE + 300
    const filler = new CallBuilder(A);
    filler.ev(7000, 'status', { state: 'working' });
    filler.speak(7200, 600); // "one sec": speaking 7200 to ~7800, UE is 7840
    filler.ev(7850, 'status', { state: 'working' });
    filler.turn({ at: 6000, latency: 3000 });
    expect(callFacts(filler.build()).trials[0].cutIn).toBe(false);
    // the same audio after `thinking` is not a filler but the start of an answer: a cut-in (a lead-in the model spoke before its call counts)
    const leadIn = new CallBuilder(A);
    leadIn.ev(7000, 'status', { state: 'thinking' });
    leadIn.speak(7200, 600);
    leadIn.turn({ at: 6000, latency: 3000 });
    expect(callFacts(leadIn.build()).trials[0].cutIn).toBe(true);
  });

  it('knows how a run of speech began from the status events: its start, and whether it followed `working` (a filler)', () => {
    const call = new CallBuilder(A);
    call.ev(1000, 'status', { state: 'thinking' });
    call.ev(1100, 'status', { state: 'speaking' });
    call.audio(1100);
    call.audio(1140);
    call.ev(1200, 'status', { state: 'working' });
    call.audio(1210); // the tail of a lead-in after the status went to working
    call.ev(1300, 'status', { state: 'speaking' });
    call.audio(1300);
    const parsed = call.build();
    const list = statusList(parsed);
    const frames = parsed.audio.filter((a) => a.t >= 1100);
    expect(runOf(list, frames[0])).toEqual({ startedAt: 1100, filler: false });
    expect(runOf(list, frames[1])).toEqual({ startedAt: 1100, filler: false });
    expect(runOf(list, frames[2])).toEqual({ startedAt: 1210, filler: false }); // no speaking before it: a run of its own
    expect(runOf(list, frames[3])).toEqual({ startedAt: 1300, filler: true }); // speaking right after working
  });

  it('measures the end-of-turn wait to the first transcript at or after UE, and calls more than 3.0 s (strictly) too long', () => {
    expect(facts({ eot: 3000 }).tooLong).toBe(false);
    expect(facts({ eot: 3001 }).tooLong).toBe(true);
    expect(facts({ eot: 3001 }).eotMs).toBe(3001);
    expect(facts({ eot: 3001 }).committed).toBe(true);
    // a line before UE belongs to a fragment: the wait is to the line at or after UE
    const split = facts({ extraTranscript: -900, eot: 2000 });
    expect(split.eotMs).toBe(2000);
    expect(split.tooLong).toBe(false);
    expect(facts({ eot: 0 }).eotMs).toBe(0); // a line exactly at UE counts
  });

  it('has no end-of-turn latency for a scenario with no user line at or after UE: it is not committed, and that is a too-long wait (amendment A4)', () => {
    const none = facts({ eot: null });
    expect(none.eotMs).toBeNull();
    expect(none.committed).toBe(false);
    expect(none.tooLong).toBe(true);
    // a line only BEFORE UE (a fragment) leaves the scenario not committed too
    const fragmentOnly = facts({ eot: null, extraTranscript: -900 });
    expect(fragmentOnly.userTranscripts).toBe(1);
    expect(fragmentOnly.committed).toBe(false);
    expect(fragmentOnly.eotMs).toBeNull();
    expect(fragmentOnly.tooLong).toBe(true);
  });

  it('keeps a turn that never got an answer: no latency, and a tool turn if a look-up began', () => {
    const none = facts({ latency: null, tool: true });
    expect(none.answered).toBe(false);
    expect(none.latencyMs).toBeNull();
    expect(none.tool).toBe(true);
    expect(facts({ latency: null }).tool).toBe(false);
  });

  it('sets aside a scenario the server cut off (the call closed under it) and one whose end of speech was never sent', () => {
    expect(facts({ latency: null, wait: 'closed' }).incomplete).toBe(true);
    const b = new CallBuilder(A);
    b.turn({ at: 6000 });
    const call = b.build();
    call.scenarios[0].ueSentAt = null;
    expect(callFacts(call).trials[0].incomplete).toBe(true);
  });

  it('notes a scenario that began before the one before it reached quiet', () => {
    const b = new CallBuilder(A);
    b.turn({ at: 6000, settled: false });
    b.turn({ at: 40_000, id: 'l02' });
    const trials = callFacts(b.build()).trials;
    expect(trials[0].afterUnsettled).toBe(false);
    expect(trials[1].afterUnsettled).toBe(true);
  });

  it('reads the start of the call: start to ready, start to the first agent frame, the mode ready named', () => {
    const f = callFacts(new CallBuilder(A, { readyMs: 812, greetingMs: 2210 }).build());
    expect(f.started).toBe(true);
    expect(f.readyMs).toBe(812);
    expect(f.greetingMs).toBe(2210);
    expect(f.readyMode).toBe('conversational');
    const failed = callFacts(new CallBuilder(A, { readyMs: null }).build());
    expect(failed.started).toBe(false);
    expect(failed.readyMs).toBeNull();
    expect(callFacts(new CallBuilder(A, { greetingMs: null }).build()).greetingMs).toBeNull();
  });
});

// ---------------------------------------------------------------- checks

describe('quantile checks (B must be within the tolerance of A at a percentile)', () => {
  const q = (a: number[], b: number[], over: Partial<Parameters<typeof quantileCheck>[0]> = {}) => quantileCheck({ id: 'x', label: 'x', a, b, p: 0.5, tolerance: 300, minimum: 30, rule: 'r', ...over });

  it('passes exactly at the tolerance and fails one millisecond over it', () => {
    expect(q(lat(30, 1000), lat(30, 1300)).verdict).toBe('PASS');
    expect(q(lat(30, 1000), lat(30, 1300)).diff).toBe(300);
    expect(q(lat(30, 1000), lat(30, 1301)).verdict).toBe('FAIL');
    expect(q(lat(30, 1000), lat(30, 900)).verdict).toBe('PASS'); // a faster lab is within any tolerance
  });

  it('takes the 90th percentile at index floor((n-1)p): 26 of 30 within the line is not enough when the 27th is over', () => {
    // sorted index floor(29 * 0.9) = 26 is the 27th smallest
    const b = (slow: number) => [...lat(26, 1000), ...lat(4, slow)];
    expect(q(lat(30, 1000), b(1600), { p: 0.9, tolerance: 600 }).verdict).toBe('PASS');
    expect(q(lat(30, 1000), b(1601), { p: 0.9, tolerance: 600 }).verdict).toBe('FAIL');
    const b27 = [...lat(27, 1000), ...lat(3, 5000)]; // only 3 slow turns: the 27th smallest (index 26) is still 1000
    expect(q(lat(30, 1000), b27, { p: 0.9, tolerance: 600 }).b).toBe(1000);
  });

  it('is INSUFFICIENT when it would pass on fewer turns than the document asks for, and says so; a failure stays a failure', () => {
    const thin = q(lat(29, 1000), lat(30, 1000));
    expect(thin.verdict).toBe('INSUFFICIENT');
    expect(thin.notes.join(' ')).toMatch(/below the minimum.*n 29 \/ 30.*minimum 30/);
    const either = q(lat(30, 1000), lat(12, 1000));
    expect(either.verdict).toBe('INSUFFICIENT');
    const thinFail = q(lat(10, 1000), lat(10, 2000));
    expect(thinFail.verdict).toBe('FAIL');
    expect(thinFail.notes).toContain('sample below the minimum');
  });

  it('has no data to judge when a chain has no turns', () => {
    expect(q([], lat(30, 1000)).verdict).toBe('NO DATA');
    expect(q(lat(30, 1000), []).verdict).toBe('NO DATA');
    expect(q([], []).notes.join(' ')).toMatch(/either chain/);
    expect(q([], []).a).toBeNull();
  });

  it('never drops a turn with no answer: it is an infinite latency, so enough of them fail B and make A\'s baseline unusable', () => {
    const answered = lat(26, 1000);
    const bad = q(lat(30, 1000), [...answered, Infinity, Infinity, Infinity, Infinity], { p: 0.9, tolerance: 600 }); // 4 of 30 never answered: p90 is one of them
    expect(bad.verdict).toBe('FAIL');
    expect(bad.bCensored).toBe(true);
    expect(bad.b).toBeNull();
    expect(bad.notes.join(' ')).toMatch(/no answer/);
    const few = q(lat(30, 1000), [...lat(27, 1000), Infinity, Infinity, Infinity], { p: 0.9, tolerance: 600 }); // 3 of 30: p90 is still an answered turn
    expect(few.verdict).toBe('PASS');
    const baseline = q([...answered, Infinity, Infinity, Infinity, Infinity], lat(30, 1000), { p: 0.9, tolerance: 600 });
    expect(baseline.verdict).toBe('INSUFFICIENT');
    expect(baseline.aCensored).toBe(true);
    expect(baseline.notes.join(' ')).toMatch(/outage/);
    expect(q([Infinity, Infinity, 1000], [Infinity, Infinity, 1000], { p: 0.9 }).verdict).toBe('FAIL'); // both unusable: B is, so it fails
  });

  it('says "not distinguishable at this n" when the interval of the difference contains zero, and not when it does not', () => {
    const noisy = [900, 1500, 1100, 2100, 1300, 1700, 1000, 1900, 1200, 1600, 1400, 2000, 1050, 1750, 1250, 1950, 1150, 1650, 1350, 1850, 950, 1450, 1250, 1550, 1050, 1350, 1650, 1850, 1150, 1450];
    const same = q(noisy, noisy.map((v) => v + 30));
    expect(same.interval).not.toBeNull();
    expect(same.interval!.method).toMatch(/bootstrap, 2000 resamples/);
    expect(same.notDistinguishable).toBe(true);
    const clear = q(lat(30, (i) => 1000 + (i % 5) * 10), lat(30, (i) => 1250 + (i % 5) * 10));
    expect(clear.notDistinguishable).toBe(false);
    expect(clear.interval!.lo).toBeGreaterThan(0);
  });
});

describe('rate checks (B may exceed A by a number of percentage points)', () => {
  const r = (kA: number, nA: number, kB: number, nB: number, over: Partial<Parameters<typeof rateCheck>[0]> = {}) =>
    rateCheck({ id: 'x', label: 'x', kA, nA, kB, nB, tolerancePoints: 10, minimum: 30, rule: 'r', ...over });

  it('is exact on the edge: 3/30 over 0/30 is 10 points, within; 4/30 is not', () => {
    expect(r(0, 30, 3, 30).verdict).toBe('PASS');
    expect(r(0, 30, 4, 30).verdict).toBe('FAIL');
    expect(r(9, 60, 15, 60).verdict).toBe('PASS'); // 15 % against 25 %... B minus A = +10.0 exactly (a float says 10.000000000000002)
    expect(r(6, 60, 12, 60).verdict).toBe('PASS'); // 10 % to 20 %
    expect(r(6, 60, 13, 60).verdict).toBe('FAIL');
    expect(r(10, 30, 0, 30).verdict).toBe('PASS'); // better than live
  });

  it('carries k/n with Wilson intervals, the difference in points, and the Newcombe interval', () => {
    const c = r(3, 30, 6, 30);
    expect(c.a).toBeCloseTo(10, 10);
    expect(c.b).toBeCloseTo(20, 10);
    expect(c.diff).toBeCloseTo(10, 10);
    expect(c.aRate).toMatchObject({ k: 3, n: 30 });
    expect(c.bRate!.lo).toBeGreaterThan(0.08);
    expect(c.bRate!.hi).toBeLessThan(0.38);
    expect(c.interval!.method).toMatch(/Newcombe/);
    expect(c.notDistinguishable).toBe(true); // 3/30 against 6/30 cannot be told from equal
    const far = r(0, 60, 30, 60);
    expect(far.notDistinguishable).toBe(false);
    expect(far.verdict).toBe('FAIL');
  });

  it('is INSUFFICIENT on a thin sample and NO DATA with none', () => {
    expect(r(0, 29, 0, 30).verdict).toBe('INSUFFICIENT');
    expect(r(0, 0, 0, 30).verdict).toBe('NO DATA');
    expect(r(0, 30, 0, 0).verdict).toBe('NO DATA');
  });
});

describe('absolute checks (zero bad outcomes on chain B)', () => {
  const z = (badA: number, nA: number, badB: number, nB: number, over: Partial<Parameters<typeof zeroCheck>[0]> = {}) => zeroCheck({ id: 'x', label: 'x', badA, nA, badB, nB, minimum: 20, rule: 'r', ...over });

  it('passes with none on B whatever A had, fails with one, and keeps the Wilson interval of what zero means', () => {
    expect(z(3, 20, 0, 20).verdict).toBe('PASS');
    expect(z(0, 20, 1, 20).verdict).toBe('FAIL');
    const c = z(0, 20, 0, 20);
    expect(c.bRate!.hi).toBeCloseTo(0.1611, 3); // 0 of 20 still allows a rate of 16 %
    expect(c.diff).toBeNull();
    expect(c.tolerance).toBeNull();
  });

  it('is INSUFFICIENT with too few trials and judges B alone when A has none', () => {
    expect(z(0, 20, 0, 19).verdict).toBe('INSUFFICIENT');
    const noA = z(0, 0, 0, 20);
    expect(noA.verdict).toBe('INSUFFICIENT'); // A's sample is below the minimum too
    expect(noA.notes.join(' ')).toMatch(/no data in chain A/);
    expect(z(0, 0, 2, 20).verdict).toBe('FAIL');
    expect(z(0, 20, 0, 0).verdict).toBe('NO DATA');
  });
});

// ---------------------------------------------------------------- the criteria over whole logs

describe('C0, the start of the call', () => {
  const calls = (chain: string, minute: (i: number) => number, readyMs: number, greetingMs: number, n = 20) => lat(n, 0).map((_, i) => new CallBuilder(chain, { minute: minute(i), readyMs, greetingMs }).build());

  it('passes at +500 ms (ready) and +700 ms (greeting) on the medians and fails one millisecond over', () => {
    const edge = analyzeLogs(calls(A, mA, 800, 1500), calls(B, mB, 1300, 2200));
    expect(check(edge, 'C0.ready.p50')).toMatchObject({ a: 800, b: 1300, diff: 500, verdict: 'PASS', nA: 20, nB: 20 });
    expect(check(edge, 'C0.greeting.p50')).toMatchObject({ a: 1500, b: 2200, diff: 700, verdict: 'PASS' });
    expect(check(edge, 'C0.starts').verdict).toBe('PASS');
    expect(edge.criteria[0].verdict).toBe('PASS');
    const over = analyzeLogs(calls(A, mA, 800, 1500), calls(B, mB, 1301, 2201));
    expect(check(over, 'C0.ready.p50').verdict).toBe('FAIL');
    expect(check(over, 'C0.greeting.p50').verdict).toBe('FAIL');
    expect(over.criteria[0].verdict).toBe('FAIL');
  });

  it('fails when a call of B never started, and leaves that call out of the ready times', () => {
    const b = [...calls(B, mB, 800, 1500, 19), new CallBuilder(B, { minute: 41, readyMs: null }).build()];
    const r = analyzeLogs(calls(A, mA, 800, 1500), b);
    expect(check(r, 'C0.starts')).toMatchObject({ a: 0, b: 1, verdict: 'FAIL', nB: 20 });
    expect(check(r, 'C0.ready.p50').nB).toBe(19);
    expect(check(r, 'C0.ready.p50').verdict).toBe('INSUFFICIENT'); // 19 ready times: below the 20 calls the document asks for
  });

  it('counts a call that never greeted as an infinite greeting time, so a chain that stays silent cannot pass', () => {
    const silent = lat(20, 0).map((_, i) => new CallBuilder(B, { minute: mB(i), greetingMs: i < 11 ? null : 1500 }).build()); // 11 of 20 never greeted
    const r = analyzeLogs(calls(A, mA, 800, 1500), silent);
    expect(check(r, 'C0.greeting.p50').bCensored).toBe(true);
    expect(check(r, 'C0.greeting.p50').verdict).toBe('FAIL');
    const some = lat(20, 0).map((_, i) => new CallBuilder(B, { minute: mB(i), greetingMs: i < 9 ? null : 1500 }).build()); // 9 of 20: the median is a real greeting
    expect(check(analyzeLogs(calls(A, mA, 800, 1500), some), 'C0.greeting.p50').verdict).toBe('PASS');
  });
});

describe('C1, end of speech to first audio', () => {
  it('judges the plain turns of the latency prompts at +300 ms (p50) and +600 ms (p90)', () => {
    const live = latencyChain(A, mA, lat(30, 1000));
    const same = analyzeLogs(live, latencyChain(B, mB, lat(30, 1300)));
    expect(check(same, 'C1.plain.p50')).toMatchObject({ a: 1000, b: 1300, diff: 300, verdict: 'PASS', nA: 30, nB: 30 });
    expect(check(same, 'C1.plain.p90').verdict).toBe('PASS');
    const over = analyzeLogs(live, latencyChain(B, mB, lat(30, 1301)));
    expect(check(over, 'C1.plain.p50').verdict).toBe('FAIL');
    // p90 is the 27th smallest of 30: four slow turns at +600 are exactly at the line, +601 is not
    const tail = (slow: number) => [...lat(26, 1000), ...lat(4, 1000 + slow)];
    expect(check(analyzeLogs(live, latencyChain(B, mB, tail(600))), 'C1.plain.p90')).toMatchObject({ b: 1600, diff: 600, verdict: 'PASS' });
    expect(check(analyzeLogs(live, latencyChain(B, mB, tail(601))), 'C1.plain.p90').verdict).toBe('FAIL');
    expect(check(analyzeLogs(live, latencyChain(B, mB, tail(601))), 'C1.plain.p50').verdict).toBe('PASS');
  });

  it('reports a thin sample as INSUFFICIENT, not as a pass', () => {
    const live = latencyChain(A, mA, lat(30, 1000));
    const thin = [chatCall(B, lat(10, 1000).map((latency, k) => ({ id: `l${k}`, cls: 'latency' as const, latency })), { minute: 1 })];
    const r = analyzeLogs(live, thin);
    expect(check(r, 'C1.plain.p50')).toMatchObject({ verdict: 'INSUFFICIENT', nA: 30, nB: 10 });
    expect(r.criteria[1].verdict).toBe('INSUFFICIENT');
  });

  it('leaves tool turns out of the plain line and judges them on their own (n >= 15), at +300 ms', () => {
    const mk = (chain: string, minute: (i: number) => number, plain: number, tool: number) => {
      const turns = [...lat(30, plain).map((latency, k) => ({ id: `l${k}`, cls: 'latency' as const, latency })), ...lat(16, tool).map((latency, k) => ({ id: `e-p${k}`, cls: 'pause' as const, latency, tool: true }))];
      return [chatCall(chain, turns.slice(0, 20), { minute: minute(0) }), chatCall(chain, turns.slice(20), { minute: minute(1) })];
    };
    const r = analyzeLogs(mk(A, mA, 1000, 3000), mk(B, mB, 1000, 3300));
    expect(check(r, 'C1.plain.p50')).toMatchObject({ nA: 30, nB: 30, diff: 0, verdict: 'PASS' });
    expect(check(r, 'C1.tool.p50')).toMatchObject({ a: 3000, b: 3300, diff: 300, nA: 16, nB: 16, verdict: 'PASS' });
    const slow = analyzeLogs(mk(A, mA, 1000, 3000), mk(B, mB, 1000, 3301));
    expect(check(slow, 'C1.tool.p50').verdict).toBe('FAIL');
    const few = analyzeLogs(mk(A, mA, 1000, 3000), [chatCall(B, [...lat(30, 1000).map((latency, k) => ({ id: `l${k}`, cls: 'latency' as const, latency })), ...lat(14, 3000).map((latency, k) => ({ id: `e${k}`, cls: 'pause' as const, latency, tool: true }))], { minute: 1 })]);
    expect(check(few, 'C1.tool.p50')).toMatchObject({ nB: 14, verdict: 'INSUFFICIENT' });
  });

  it('judges interview answers that start a look-up (calls started in interview mode) at +300 ms with n >= 10', () => {
    const interview = (chain: string, minute: number, latency: number, n: number) =>
      chatCall(chain, lat(n, latency).map((l, k) => ({ id: `i-p${k}`, cls: 'pause' as const, latency: l, tool: true })), { mode: 'interview', set: 'interview', minute });
    const r = analyzeLogs([interview(A, 0, 2000, 10), interview(A, 2, 2000, 5)], [interview(B, 1, 2300, 10), interview(B, 3, 2300, 5)]);
    expect(check(r, 'C1.interviewTool.p50')).toMatchObject({ a: 2000, b: 2300, nA: 15, nB: 15, verdict: 'PASS' });
    const over = analyzeLogs([interview(A, 0, 2000, 10)], [interview(B, 1, 2301, 10)]);
    expect(check(over, 'C1.interviewTool.p50').verdict).toBe('FAIL');
    const thin = analyzeLogs([interview(A, 0, 2000, 9)], [interview(B, 1, 2000, 10)]);
    expect(check(thin, 'C1.interviewTool.p50').verdict).toBe('INSUFFICIENT');
  });

  it('does not count a latency prompt answered before UE + 300 ms, and says how many', () => {
    const live = latencyChain(A, mA, lat(30, 1000));
    const early = latencyChain(B, mB, lat(30, 1000), [{ early: 100 }, { early: 100 }]); // two turns the agent began to answer 100 ms after the end of speech
    const r = analyzeLogs(live, early);
    expect(check(r, 'C1.plain.p50').nB).toBe(28);
    const row = r.criteria[1].info.find((i) => i.label.includes('answered before UE + 300 ms'))!;
    expect([row.a, row.b]).toEqual([0, 2]);
    expect(check(r, 'C1.plain.p50').verdict).toBe('INSUFFICIENT'); // 28 plain turns
  });

  it('keeps a turn that was never answered as an infinite latency of the plain line (never dropped), and reports how many', () => {
    const live = latencyChain(A, mA, lat(30, 1000));
    const broken = latencyChain(B, mB, lat(30, 1000), per(30, (i) => (i < 4 ? { latency: null, eot: null } : {})));
    const r = analyzeLogs(live, broken);
    expect(check(r, 'C1.plain.p90')).toMatchObject({ bCensored: true, verdict: 'FAIL', nB: 30 });
    expect(check(r, 'C1.plain.p50').verdict).toBe('PASS');
    const row = r.criteria[1].info.find((i) => i.label.startsWith('turns with no answer'))!;
    expect(row.b).toBe(4);
  });

  it('reports the end-of-turn latency (the transcript after UE) without a tolerance', () => {
    const r = analyzeLogs(latencyChain(A, mA, lat(30, 1000)), latencyChain(B, mB, lat(30, 1000), per(30, () => ({ eot: 1500 }))));
    const p50 = r.criteria[1].info.find((i) => i.label.includes('end-of-turn latency') && i.label.endsWith('p50'))!;
    expect([p50.a, p50.b]).toEqual([700, 1500]);
  });
});

describe('the `tools` set (class `tool`, round 2)', () => {
  /** A call of the `tools` set: n prompts of class `tool`, each a tool turn (a `working` status before the first audio) with this latency, unless `over` says otherwise. */
  const toolsCall = (chain: string, minute: number, n: number, latency: number, over: (i: number) => Partial<Omit<TurnSpec, 'at'>> = () => ({})): RawCall =>
    chatCall(chain, lat(n, latency).map((l, i) => ({ id: `x0${i + 1}`, cls: 'tool' as const, latency: l, tool: true, ...over(i) })), { set: 'tools', minute });
  /** the tool line's row, or the row of the `tool` prompts it leaves out */
  const leftOutRow = (r: Report) => r.criteria[1].info.find((i) => i.label.startsWith('tool prompts left out of the tool line'));

  it('counts the `tool` prompts in C1\'s tool-turn line (n >= 15), judges them at +300 ms, and pools them with the tool turns of the conversation classes', () => {
    const live = [toolsCall(A, mA(0), 8, 3000), toolsCall(A, mA(1), 8, 3000)];
    const r = analyzeLogs(live, [toolsCall(B, mB(0), 8, 3300), toolsCall(B, mB(1), 8, 3300)]);
    expect(check(r, 'C1.tool.p50')).toMatchObject({ a: 3000, b: 3300, diff: 300, nA: 16, nB: 16, verdict: 'PASS' });
    expect(check(r, 'C1.tool.p50').label).toContain('the `tools` set'); // the line says what it is made of
    expect(check(analyzeLogs(live, [toolsCall(B, mB(0), 8, 3301), toolsCall(B, mB(1), 8, 3301)]), 'C1.tool.p50').verdict).toBe('FAIL');
    expect(check(analyzeLogs(live, [toolsCall(B, mB(0), 7, 3000), toolsCall(B, mB(1), 7, 3000)]), 'C1.tool.p50')).toMatchObject({ nB: 14, verdict: 'INSUFFICIENT' }); // never a pass on 14
    // the tool turns of the other sets (here four pause scenarios of another session) are in the same line
    const pausesA = chatCall(A, lat(4, 3000).map((latency, k) => ({ id: `e-p${k}`, cls: 'pause' as const, latency, tool: true })), { minute: mA(2) });
    const pausesB = chatCall(B, lat(4, 3000).map((latency, k) => ({ id: `e-p${k}`, cls: 'pause' as const, latency, tool: true })), { minute: mB(2) });
    const pooled = analyzeLogs([...live, pausesA], [toolsCall(B, mB(0), 6, 3000), toolsCall(B, mB(1), 6, 3000), pausesB]);
    expect(check(pooled, 'C1.tool.p50')).toMatchObject({ nA: 20, nB: 16, verdict: 'PASS' });
    // a prompt that began a look-up and was never answered is an infinite latency in that line (never dropped), as for every class
    const stuck = analyzeLogs(live, [toolsCall(B, mB(0), 8, 3000, (i) => (i < 5 ? { latency: null, eot: null } : {})), toolsCall(B, mB(1), 8, 3000, (i) => (i < 4 ? { latency: null, eot: null } : {}))]);
    expect(check(stuck, 'C1.tool.p50')).toMatchObject({ nB: 16, bCensored: true, verdict: 'FAIL' }); // 9 of 16: the median is a turn with no answer
  });

  it('is no plain turn, no cut-in, no barge-in and no mode trial: a `tools` log, however bad, moves none of the other lines of the report', () => {
    const calls = (chain: string, minute: (i: number) => number) => [
      ...latencyChain(chain, minute, lat(30, 1000)),
      chatCall(chain, lat(30, 0).map((_, i) => ({ id: `e-p${i}`, cls: 'pause' as const })), { minute: minute(3) }),
      chatCall(chain, lat(30, 0).map((_, i) => ({ id: `e-s${i}`, cls: 'short' as const })), { minute: minute(4) }),
    ];
    // very slow, one with agent audio before the end of speech (a cut-in if it counted), one with no answer and no look-up, one with two user lines
    const nasty = (chain: string, minute: number) => toolsCall(chain, minute, 8, 40_000, (i) => (i === 0 ? { early: -700 } : i === 1 ? { latency: null, eot: null, tool: false } : i === 2 ? { extraTranscript: -1000 } : {}));
    const base = analyzeLogs(calls(A, mA), calls(B, mB));
    const withTools = analyzeLogs([...calls(A, mA), nasty(A, mA(5))], [...calls(B, mB), nasty(B, mB(5))]);
    for (const id of ['C1.plain.p50', 'C1.plain.p90', 'C2.cutin', 'C2.toolong', 'C2.short', 'C3.interrupted.p50', 'C3.audioStop.p90', 'C10.interview.cutin', 'C10.talk.cutin']) {
      const x = check(base, id);
      const y = check(withTools, id);
      expect([id, y.a, y.b, y.nA, y.nB, y.verdict]).toEqual([id, x.a, x.b, x.nA, x.nB, x.verdict]);
    }
    expect(check(withTools, 'C2.cutin')).toMatchObject({ nA: 30, nB: 30, bRate: { k: 0, n: 30 } }); // the 30 pause scenarios: the tool prompt with audio before the end of speech is no cut-in
    expect(check(withTools, 'C2.short').nB).toBe(30); // only the 30 short scenarios
    expect(check(withTools, 'C2.toolong')).toMatchObject({ nB: 60, bRate: { k: 0, n: 60 } }); // pause and short: the tool prompt that was never committed is no too-long wait
    expect(check(withTools, 'C3.falseBarge').b).toBe(0); // (its denominator, the agent's turns outside scripted speech, does grow: the tool answers are agent turns)
    const row = (r: Report, label: string) => r.criteria.flatMap((c) => c.info).find((i) => i.label.startsWith(label))!;
    for (const label of [
      'end-of-turn latency (transcript after UE), chat turns, p50',
      'end-of-turn latency (transcript after UE), chat turns, p90',
      'plain turns of all conversation scenarios (latency, pause, short, filler), p50',
      'plain turns of all conversation scenarios (latency, pause, short, filler), p90',
      'turns with no answer',
      'latency prompts answered before UE + 300 ms',
      'split lines, pause and filler scenarios',
      'not committed: no user line at or after UE (pause, short, filler)',
    ]) {
      const x = row(base, label);
      const y = row(withTools, label);
      expect([label, y.a, y.b]).toEqual([label, x.a, x.b]);
    }
    // what the tool prompts do change is the tool line and the row that accounts for the ones it leaves out: 6 of the 8 are tool turns of the line (the early one and the one with no look-up are not)
    expect(check(withTools, 'C1.tool.p50')).toMatchObject({ nA: 6, nB: 6, a: 40_000, b: 40_000 });
    expect(check(base, 'C1.tool.p50')).toMatchObject({ nA: 0, nB: 0, verdict: 'NO DATA' });
    expect(leftOutRow(withTools)).toMatchObject({ aRate: { k: 2, n: 8 }, bRate: { k: 2, n: 8 } });
  });

  it('puts a `tool` prompt that is not a tool turn by 9.2 in one row of its own: no `working` before the first audio, a spoken line before the look-up, no answer and no look-up, or an answer before UE + 300 ms', () => {
    const turns = (chain: string, minute: number) =>
      toolsCall(chain, minute, 6, 3000, (i) => [{}, { tool: false }, { tool: 3500 }, { latency: null, eot: null, tool: false }, { early: 100 }, { latency: null, eot: null }][i]);
    const r = analyzeLogs([turns(A, mA(0))], [turns(B, mB(0))]);
    // x01 is a tool turn; x02 had no look-up; x03 said a line first (first audio at UE + 3000, `working` at UE + 3500: a plain turn by the rule); x04 was never answered and had no look-up;
    // x05 was answered at UE + 100; x06 began a look-up and was never answered (an infinite latency of the tool line, not left out)
    expect(check(r, 'C1.tool.p50')).toMatchObject({ nA: 2, nB: 2, bCensored: false }); // x01, and x06 as an infinite latency: the median of two is the smaller
    const row = leftOutRow(r)!;
    expect([row.aRate!.k, row.aRate!.n, row.bRate!.k, row.bRate!.n]).toEqual([4, 6, 4, 6]);
    expect(row.note).toMatch(/counted in no latency line/);
    expect(renderReport(r)).toMatch(/\| tool prompts left out of the tool line \(the `tools` set\): .* \| 4\/6 = 66\.7 % \[30\.0, 90\.3\] \| 4\/6 = 66\.7 % \[30\.0, 90\.3\] \| 6 \/ 6 \|/);
    // the unanswered prompt without a look-up is not in the "no answer" row of the conversation classes either
    const unanswered = r.criteria[1].info.find((i) => i.label.startsWith('turns with no answer'))!;
    expect([unanswered.a, unanswered.b]).toEqual([0, 0]);
  });

  it('adds no row to a report with no `tool` prompt in it (a round-1 directory reads as it did)', () => {
    const r = analyzeLogs(latencyChain(A, mA, lat(30, 1000)), latencyChain(B, mB, lat(30, 1000)));
    expect(leftOutRow(r)).toBeUndefined();
    expect(renderReport(r)).not.toContain('tool prompts left out');
  });

  it('reads logs of the `tools` set as evaluation logs (never as tuning), counts the set, and takes any labels: a chain called FD against L, or H against C', () => {
    const r = analyzeLogs([toolsCall('L', 0, 8, 3000)], [toolsCall('FD', 1, 8, 3000)]);
    expect([r.a.label, r.b.label]).toEqual(['L', 'FD']);
    expect(r.a.bySet).toEqual({ tools: 1 });
    expect(r.excluded.otherSets).toBe(0);
    expect(r.warnings.join(' ')).not.toMatch(/both directories hold chain/);
    expect(renderReport(r)).toMatch(/- Chain FD: 1 call\(s\) \(1 chat; sets: tools 1\), 8 scenarios/);
    const labels = analyzeLogs([toolsCall('H', 0, 8, 3000)], [toolsCall('C', 1, 8, 3000)]);
    expect([labels.a.label, labels.b.label]).toEqual(['H', 'C']);
    expect(check(labels, 'C1.tool.p50')).toMatchObject({ nA: 8, nB: 8, a: 3000, b: 3000 });
    const tuning = analyzeLogs([toolsCall('L', 0, 8, 3000)], [toolsCall('FD', 1, 8, 3000)], { tuning: true });
    expect(tuning.a.calls).toBe(0);
    expect(tuning.excluded.otherSets).toBe(2);
  });

  it('says in the warning and in the report line that a test set is not the frozen round-1 one, with its whole sha256; the frozen one is still known by its first characters', () => {
    const sha = 'ab'.repeat(32);
    const testset = { sha256: sha, blob: 'a'.repeat(40) };
    const other = analyzeLogs([new CallBuilder(A, { testset }).build()], [new CallBuilder(B, { testset }).build()]);
    expect(other.warnings.join(' ')).toMatch(/NOT the frozen one of docs 9\.7 \(the frozen round-1 set is sha256 89b4b8d2a105; these logs carry sha256 ab/);
    expect(other.warnings.join(' ')).toContain(`these logs carry sha256 ${sha})`);
    expect(other.warnings.join(' ')).toContain('do not read this as a round-1 criterion result');
    expect(renderReport(other)).toContain(`Test set: ${sha} (NOT the frozen one: not the frozen round-1 set of 9.7, sha256 89b4b8d2a105).`);
    const frozen = analyzeLogs([new CallBuilder(A).build()], [new CallBuilder(B).build()]);
    expect(renderReport(frozen)).toContain('Test set: 89b4b8d2a1056898 (the frozen one of 9.7).');
  });
});

describe('C2, turn-taking in conversation', () => {
  /** n trials of a class, the first `cut` of them cut in on (agent audio in the pause, and the line of a commit that was taken back) */
  const trials = (cls: 'pause' | 'filler' | 'short', n: number, cut = 0, over: Partial<TurnSpec> = {}): Array<Omit<TurnSpec, 'at'>> =>
    lat(n, 0).map((_, i) => ({
      id: `${cls}${i}`,
      cls,
      segments: cls === 'short' ? undefined : ([[640, 1840], [3340, 4540]] as Array<[number, number]>),
      latency: 1500,
      eot: 700,
      ...(i < cut ? { extraTranscript: -1000, early: -700 } : {}),
      ...over,
    }));
  const chain = (label: string, minute: (i: number) => number, parts: Array<Array<Omit<TurnSpec, 'at'>>>) => parts.map((p, i) => chatCall(label, p, { minute: minute(i) }));

  it('judges the cut-in rate of pause and filler scenarios at +10 points, exactly', () => {
    const live = chain(A, mA, [trials('pause', 30, 3), trials('filler', 30, 0)]); // 3 of 60
    const r = analyzeLogs(live, chain(B, mB, [trials('pause', 30, 9), trials('filler', 30, 0)])); // 9 of 60: +10.0 points
    expect(check(r, 'C2.cutin')).toMatchObject({ nA: 60, nB: 60, verdict: 'PASS' });
    expect(check(r, 'C2.cutin').aRate).toMatchObject({ k: 3, n: 60 });
    expect(check(r, 'C2.cutin').bRate).toMatchObject({ k: 9, n: 60 });
    expect(check(r, 'C2.cutin').diff).toBeCloseTo(10, 9);
    const over = analyzeLogs(live, chain(B, mB, [trials('pause', 30, 10), trials('filler', 30, 0)]));
    expect(check(over, 'C2.cutin').verdict).toBe('FAIL');
    expect(over.criteria[2].verdict).toBe('FAIL');
  });

  it('does not count short scenarios in the cut-in rate, and counts a cut-in by agent audio only (amendment A1)', () => {
    const live = chain(A, mA, [trials('pause', 30), trials('filler', 30), trials('short', 30)]);
    const audioOnly = trials('pause', 30).map((t, i) => (i < 2 ? { ...t, early: -700 } : t));
    const turnOnly = trials('filler', 30).map((t, i) => (i < 2 ? { ...t, extraTranscript: -1000 } : t));
    const r = analyzeLogs(live, chain(B, mB, [audioOnly, turnOnly, trials('short', 30, 30)])); // every short answer is "cut in" and must not count
    expect(check(r, 'C2.cutin').bRate).toMatchObject({ k: 2, n: 60 }); // the two second user lines are not cut-ins
    expect(check(r, 'C2.cutin').aRate).toMatchObject({ k: 0, n: 60 });
    expect(check(r, 'C2.cutin').verdict).toBe('PASS');
  });

  it('reports split lines (more than one user transcript) next to the cut-in rate for both chains, as k/n, and never as pass/fail', () => {
    // the lab commits early and takes the commit back before any audio: two lines, nothing audible
    const live = chain(A, mA, [trials('pause', 30), trials('filler', 30)]);
    const lab = chain(B, mB, [trials('pause', 30, 0).map((t) => ({ ...t, extraTranscript: -1000 })), trials('filler', 30).map((t, i) => (i < 6 ? { ...t, extraTranscript: -1000 } : t))]); // 36 of 60 split, none cut in
    const r = analyzeLogs(live, lab);
    expect(check(r, 'C2.cutin')).toMatchObject({ verdict: 'PASS' });
    expect(check(r, 'C2.cutin').bRate).toMatchObject({ k: 0, n: 60 });
    expect(r.criteria[2].checks.some((c) => c.verdict === 'FAIL')).toBe(false); // 60 % split lines move no verdict (the criterion is only INSUFFICIENT: no short or too-long trials here)
    expect(check(r, 'C2.toolong').verdict).toBe('INSUFFICIENT');
    const row = r.criteria[2].info.find((i) => i.label.startsWith('split lines'))!;
    expect(row.aRate).toMatchObject({ k: 0, n: 60 });
    expect(row.bRate).toMatchObject({ k: 36, n: 60 });
    expect(row.a).toBe(0);
    expect(row.b).toBeCloseTo(60, 9);
    expect(row.bRate!.lo).toBeGreaterThan(0.47);
    expect(row.bRate!.hi).toBeLessThan(0.72);
    expect(row.note).toMatch(/not pass\/fail/);
    // it is in the report with its k/n and interval, and in the JSON
    expect(renderReport(r)).toMatch(/\| split lines, pause and filler scenarios \| 0\/60 = 0\.0 % \[0\.0, 6\.0\] \| 36\/60 = 60\.0 % \[47\.4, 71\.4\] \| 60 \/ 60 \|/);
    const back = JSON.parse(JSON.stringify(r)) as Report;
    expect(back.criteria[2].info.find((i) => i.label.startsWith('split lines'))!.bRate).toMatchObject({ k: 36, n: 60 });
  });

  it('does not let a filler or the greeting count as a cut-in in the criterion either', () => {
    const withFiller = (label: string, minute: (i: number) => number) =>
      [0, 1].map((c) => {
        const b = new CallBuilder(label, { minute: minute(c) });
        let at = 6000;
        for (let i = 0; i < 30; i++) {
          // a premature commit at the pause ran a look-up: "one sec" is said while it runs (status working, then a run of speech after it), before UE + 300 ms
          b.ev(at + 2500, 'status', { state: 'working' });
          b.speak(at + 2700, 600);
          b.ev(at + 3320, 'status', { state: 'working' });
          at = b.turn({ at, id: `pause${i}`, cls: 'pause', segments: [[640, 1840], [3340, 4540]], latency: 3000 });
        }
        return b.build();
      });
    const r = analyzeLogs(chain(A, mA, [trials('pause', 30), trials('filler', 30)]), withFiller(B, mB));
    expect(check(r, 'C2.cutin').bRate).toMatchObject({ k: 0, n: 60 });
  });

  it('judges the too-long waits (end-of-turn latency over 3.0 s, or never committed, all three classes) at +5 points; a scenario that was not committed is also reported apart (amendment A4)', () => {
    const mk = (label: string, minute: (i: number) => number, slow: number, never = 0) =>
      chain(label, minute, [
        trials('pause', 30).map((t, i) => (i < slow ? { ...t, eot: 3001 } : i < slow + never ? { ...t, eot: null } : t)),
        trials('filler', 30),
        trials('short', 30),
      ]);
    const live = mk(A, mA, 0);
    expect(check(analyzeLogs(live, mk(B, mB, 4)), 'C2.toolong')).toMatchObject({ nA: 90, nB: 90, verdict: 'PASS' }); // 4/90 = 4.4 points
    expect(check(analyzeLogs(live, mk(B, mB, 5)), 'C2.toolong').verdict).toBe('FAIL'); // 5/90 = 5.6 points
    const notCommitted = analyzeLogs(live, mk(B, mB, 3, 2)); // 3 waits over 3.0 s and 2 scenarios with no user line at or after UE: 5 too-long waits in all
    expect(check(notCommitted, 'C2.toolong').bRate).toMatchObject({ k: 5, n: 90 });
    expect(check(notCommitted, 'C2.toolong').verdict).toBe('FAIL'); // 5/90 = 5.6 points
    expect(check(analyzeLogs(live, mk(B, mB, 2, 2)), 'C2.toolong')).toMatchObject({ verdict: 'PASS', bRate: { k: 4, n: 90 } }); // a chain that never commits two scenarios is not given a free pass
    expect(check(analyzeLogs(live, mk(B, mB, 0, 5)), 'C2.toolong').verdict).toBe('FAIL');
    const row = notCommitted.criteria[2].info.find((i) => i.label.startsWith('not committed'))!;
    expect(row.aRate).toMatchObject({ k: 0, n: 90 });
    expect(row.bRate).toMatchObject({ k: 2, n: 90 });
    expect(notCommitted.warnings.join(' ')).toMatch(/chain D: 2 of 90 scenario\(s\) were not committed \(no user line at or after UE\)/);
    expect(check(notCommitted, 'C2.short').verdict).toBe('PASS'); // the two were pause scenarios: not a failure of the short-answer check
    expect(analyzeLogs(live, mk(B, mB, 0)).warnings.join(' ')).not.toMatch(/not committed/);
    const exact3000 = chain(B, mB, [trials('pause', 30, 0, { eot: 3000 }), trials('filler', 30), trials('short', 30)]);
    expect(check(analyzeLogs(live, exact3000), 'C2.toolong').bRate).toMatchObject({ k: 0, n: 90 });
  });

  it('requires every short answer of B to be committed (a user line at or after UE), and reports A for reference', () => {
    const live = chain(A, mA, [trials('short', 30, 0)]);
    const all = analyzeLogs(live, chain(B, mB, [trials('short', 30)]));
    expect(check(all, 'C2.short')).toMatchObject({ a: 0, b: 0, verdict: 'PASS', nB: 30 });
    const missing = analyzeLogs(live, chain(B, mB, [trials('short', 30).map((t, i) => (i === 7 ? { ...t, eot: null } : t))]));
    expect(check(missing, 'C2.short')).toMatchObject({ b: 1, verdict: 'FAIL' });
    expect(missing.criteria[2].verdict).toBe('FAIL');
    // a line only BEFORE UE (a fragment) is not a commit of the complete utterance
    const fragment = analyzeLogs(live, chain(B, mB, [trials('short', 30).map((t, i) => (i === 7 ? { ...t, eot: null, extraTranscript: -300 } : t))]));
    expect(check(fragment, 'C2.short')).toMatchObject({ b: 1, verdict: 'FAIL' });
    // committed but never answered: the check holds, and the reference row counts it
    const silent = analyzeLogs(live, chain(B, mB, [trials('short', 30).map((t, i) => (i === 7 ? { ...t, latency: null } : t))]));
    expect(check(silent, 'C2.short')).toMatchObject({ b: 0, verdict: 'PASS' });
    expect(silent.criteria[2].info.find((i) => i.label.startsWith('short answers with no agent answer'))!.b).toBe(1);
    const aMissing = analyzeLogs(chain(A, mA, [trials('short', 30).map((t, i) => (i === 7 ? { ...t, eot: null } : t))]), chain(B, mB, [trials('short', 30)]));
    expect(check(aMissing, 'C2.short')).toMatchObject({ a: 1, b: 0, verdict: 'PASS' }); // the lab does not have to beat live's failure
    const thin = analyzeLogs(live, chain(B, mB, [trials('short', 29)]));
    expect(check(thin, 'C2.short').verdict).toBe('INSUFFICIENT');
  });

  it('counts only conversation-mode pause, short and filler scenarios; the interview and talk ones belong to C10', () => {
    const b = new CallBuilder(B, { mode: 'interview', set: 'interview' });
    let at = 6000;
    for (let i = 0; i < 5; i++) at = b.turn({ at, id: `i${i}`, cls: 'pause', segments: [[640, 1840], [4340, 5540]], early: -1000 });
    const r = analyzeLogs([], [b.build()]);
    expect(check(r, 'C2.cutin').nB).toBe(0);
    expect(check(r, 'C10.interview.cutin').nB).toBe(5);
  });
});

describe('C3, barge-in', () => {
  const callOf = (chain: string, minute: number, specs: BargeSpec[]) => {
    const b = new CallBuilder(chain, { set: 'bargein', minute });
    let at = 6000;
    for (const [i, s] of specs.entries()) at = b.bargeIn({ id: `b${i + 1}`, ...s, at });
    return b.build();
  };
  /** 24 interruptions per chain: three calls of eight */
  const chain = (label: string, minute: (i: number) => number, spec: (i: number) => Omit<BargeSpec, 'at'>) => [0, 1, 2].map((c) => callOf(label, minute(c), lat(8, 0).map((_, k) => ({ at: 0, ...spec(c * 8 + k) }))));

  it('measures agent_interrupted from the onset (the frame that carries the first speech sample) and the last agent frame after it', () => {
    const r = analyzeLogs(chain(A, mA, () => ({ stop: 300, audioStop: 250 })), chain(B, mB, () => ({ stop: 400, audioStop: 450 })));
    expect(check(r, 'C3.interrupted.p50')).toMatchObject({ a: 300, b: 400, diff: 100, verdict: 'PASS', nA: 24, nB: 24 });
    expect(check(r, 'C3.interrupted.p90')).toMatchObject({ a: 300, b: 400, diff: 100, verdict: 'PASS' });
    expect(check(r, 'C3.audioStop.p90')).toMatchObject({ a: 250, b: 450, diff: 200, verdict: 'PASS' });
  });

  it('passes at +100 ms (p50), +200 ms (p90) and +300 ms (audio stop) and fails one millisecond over', () => {
    const live = chain(A, mA, () => ({ stop: 300, audioStop: 250 }));
    expect(check(analyzeLogs(live, chain(B, mB, () => ({ stop: 401, audioStop: 250 }))), 'C3.interrupted.p50').verdict).toBe('FAIL');
    // p90 is index floor(23 * 0.9) = 20, the 21st smallest of 24: four slow ones decide it
    const tail = (slow: number) => (i: number) => ({ stop: i % 24 < 20 ? 300 : slow, audioStop: 250 });
    expect(check(analyzeLogs(live, chain(B, mB, tail(500))), 'C3.interrupted.p90')).toMatchObject({ b: 500, diff: 200, verdict: 'PASS' });
    expect(check(analyzeLogs(live, chain(B, mB, tail(501))), 'C3.interrupted.p90').verdict).toBe('FAIL');
    expect(check(analyzeLogs(live, chain(B, mB, tail(501))), 'C3.interrupted.p50').verdict).toBe('PASS');
    const audio = (stop: number) => (i: number) => ({ stop: 300, audioStop: i % 24 < 20 ? 250 : stop });
    expect(check(analyzeLogs(live, chain(B, mB, audio(550))), 'C3.audioStop.p90')).toMatchObject({ b: 550, diff: 300, verdict: 'PASS' });
    expect(check(analyzeLogs(live, chain(B, mB, audio(551))), 'C3.audioStop.p90').verdict).toBe('FAIL');
  });

  it('counts a barge-in the agent never stopped for as an infinite stop time, never as a missing one', () => {
    const live = chain(A, mA, () => ({ stop: 300, audioStop: 250 }));
    const four = chain(B, mB, (i) => (i < 4 ? { stop: null } : { stop: 300, audioStop: 250 })); // 4 of 24 never interrupted: the 21st smallest is one of them
    const r = analyzeLogs(live, four);
    expect(check(r, 'C3.interrupted.p90')).toMatchObject({ bCensored: true, verdict: 'FAIL' });
    expect(check(r, 'C3.audioStop.p90').bCensored).toBe(true);
    expect(check(r, 'C3.interrupted.p50').verdict).toBe('PASS');
    const row = r.criteria[3].info.find((i) => i.label.startsWith('barge-ins after which'))!;
    expect(row.b).toBe(4);
    const one = analyzeLogs(live, chain(B, mB, (i) => (i < 1 ? { stop: null } : { stop: 300, audioStop: 250 })));
    expect(check(one, 'C3.interrupted.p90')).toMatchObject({ bCensored: false, verdict: 'PASS' });
  });

  it('leaves out an interruption over an agent that was not audible at the onset, and counts it', () => {
    const live = chain(A, mA, () => ({ stop: 300, audioStop: 250 }));
    const quiet = chain(B, mB, (i) => (i < 3 ? { stop: null, answerMs: 600 } : { stop: 300, audioStop: 250 })); // the agent finished at +600 ms; the onset is at +2040 ms
    const q = analyzeLogs(live, quiet);
    expect(check(q, 'C3.interrupted.p50').nB).toBe(21);
    expect(q.criteria[3].info.find((i) => i.label.startsWith('interruptions over an agent that was not audible'))!.b).toBe(3);
    expect(check(q, 'C3.interrupted.p50').verdict).toBe('INSUFFICIENT'); // 21 valid barge-ins: below the 24 asked for
  });

  it('is exact about "the last audio frame after the onset": frames after the first user transcript answer the interruption and do not count', () => {
    const call = callOf(A, 0, [{ at: 0, stop: 300, audioStop: 250 }]);
    const f = callFacts(call).barges[0];
    expect(f.invalid).toBeNull();
    expect(f.interruptedMs).toBe(300);
    expect(f.audioStopMs).toBe(250);
    // the reply to the interruption (a burst of frames more than a second after the onset, after the user transcript) is not part of it
    const reply = call.audio.filter((a) => a.t > f.onset! + 2000);
    expect(reply.length).toBeGreaterThan(10);
    expect(f.audioStopMs).toBeLessThan(reply[0].t - f.onset!);
  });

  it('takes 0 when no agent frame arrived after the onset (the audio had stopped just before it), not "missing"', () => {
    const b = new CallBuilder(A, { set: 'bargein' });
    b.bargeIn({ at: 6000, stop: 300, audioStop: -40, plan: 2000 }); // the last frame is 40 ms before the onset: still audible by the playout clock
    const f = callFacts(b.build()).barges[0];
    expect(f.invalid).toBeNull();
    expect(f.audioStopMs).toBe(0);
    expect(f.interruptedMs).toBe(300);
  });

  it('treats an interruption that was never said (skipped) as not measured, and a call closed under it as incomplete', () => {
    const b = new CallBuilder(A, { set: 'bargein' });
    b.bargeIn({ at: 6000 });
    const call = b.build();
    call.scenarios[0].interruption!.skipped = 'agent-not-audible';
    call.scenarios[0].interruption!.onsetSentAt = null;
    expect(callFacts(call).barges[0].invalid).toBe('skipped');
    const b2 = new CallBuilder(A, { set: 'bargein' });
    b2.bargeIn({ at: 6000, stop: null });
    const closed = b2.build();
    closed.scenarios[0].wait = 'closed';
    closed.events = closed.events.filter((e) => e.type !== 'agent_interrupted');
    expect(callFacts(closed).barges[0].invalid).toBe('incomplete');
  });
});

describe('C3, false barge-ins', () => {
  it('explains the agent_interrupted that every scripted utterance brings (the hub sends one on every speech onset) and counts the rest', () => {
    const b = new CallBuilder(B, { readyMs: 800, greetingMs: 1500 });
    // a scenario: the speech [6640, 7840]; the hub's agent_interrupted at the onset + 200 ms is explained
    b.ev(6840, 'agent_interrupted');
    b.turn({ at: 6000 });
    // answered at 7840 + 1500 = 9340 for 2000 ms; an agent_interrupted at 10000 with nobody speaking is false
    b.ev(10_000, 'agent_interrupted');
    // one in the middle of the greeting is false too
    b.ev(2000, 'agent_interrupted');
    const f = callFacts(b.build());
    expect(f.falseBarges.map((x) => x.t).sort((x, y) => x - y)).toEqual([2000, 10_000]);
    expect(f.falseBarges.find((x) => x.t === 10_000)!.state).toBe('speaking');
    expect(f.falseBarges.find((x) => x.t === 2000)!.state).toBe('speaking');
  });

  it('explains from 100 ms before the first frame of a scripted utterance to 1 s after its last, and no further', () => {
    const at = (t: number) => {
      const b = new CallBuilder(B);
      b.turn({ at: 6000, segments: [[640, 1840]] }); // speech 6640 to 7840
      b.ev(t, 'agent_interrupted');
      return callFacts(b.build()).falseBarges.length;
    };
    expect(at(6540)).toBe(0); // 100 ms before the first speech frame
    expect(at(6539)).toBe(1);
    expect(at(7840 + 1000)).toBe(0); // 1 s after the last
    expect(at(7840 + 1001)).toBe(1);
  });

  it('explains the interruption of a barge-in scenario, and an agent_interrupted in the pause of a pause scenario that no speech explains is false', () => {
    const b = new CallBuilder(B, { set: 'bargein' });
    b.bargeIn({ at: 6000, stop: 300 });
    expect(callFacts(b.build()).falseBarges).toHaveLength(0);
    const c = new CallBuilder(B, { set: 'pause' });
    c.turn({ at: 6000, cls: 'pause', segments: [[640, 1840], [4540, 5740]] }); // 6640..7840, silence 7840..10540, speech 10540..11740
    c.ev(9500, 'agent_interrupted'); // 1660 ms into the pause: no student speech anywhere near
    c.ev(10_700, 'agent_interrupted'); // the second part's onset: explained
    expect(callFacts(c.build()).falseBarges.map((x) => x.t)).toEqual([9500]);
  });

  it('judges 0 false barge-ins against the agent turns that began with a silent student, at least 40 of them', () => {
    const turns = (chain: string, minute: number, n: number, falseAt: number[] = []) => {
      const b = new CallBuilder(chain, { minute });
      let at = 6000;
      for (let i = 0; i < n; i++) at = b.turn({ at, id: `l${i}` });
      for (const t of falseAt) b.ev(t, 'agent_interrupted');
      return b.build();
    };
    // each call: the greeting + n answers, every one an agent turn with a silent student
    const live = [turns(A, 0, 20), turns(A, 2, 20)];
    const clean = analyzeLogs(live, [turns(B, 1, 20), turns(B, 3, 20)]);
    expect(check(clean, 'C3.falseBarge')).toMatchObject({ a: 0, b: 0, nA: 42, nB: 42, verdict: 'PASS' });
    const thin = analyzeLogs([turns(A, 0, 10)], [turns(B, 1, 10)]);
    expect(check(thin, 'C3.falseBarge')).toMatchObject({ nA: 11, nB: 11, verdict: 'INSUFFICIENT' });
    // one on B, in the middle of an answer
    const bad = analyzeLogs(live, [turns(B, 1, 20, [9800]), turns(B, 3, 20)]);
    expect(check(bad, 'C3.falseBarge')).toMatchObject({ b: 1, verdict: 'FAIL' });
    expect(bad.criteria[3].verdict).toBe('FAIL');
    expect(bad.criteria[3].info.find((i) => i.label.startsWith('false barge-ins by the agent status'))!.note).toBe('A: none; B: speaking: 1');
  });
});

describe('C10, interview and talk-through turn-taking', () => {
  const modeCall = (chain: string, mode: 'interview' | 'talk', minute: number, n: number, cut: number, over: CallOpts = {}) => {
    const b = new CallBuilder(chain, { mode, set: mode, minute, ...over });
    let at = 6000;
    for (let i = 0; i < n; i++) at = b.turn({ at, id: `${mode[0]}-p${i}`, cls: 'pause', segments: [[640, 1840], [5340, 6540]], ...(i < cut ? { early: -1500 } : {}) });
    return b.build();
  };

  it('judges the cut-in rate of each mode at +10 points on 15 interview and 9 talk trials', () => {
    const live = [modeCall(A, 'interview', 0, 5, 1), modeCall(A, 'interview', 2, 5, 0), modeCall(A, 'interview', 4, 5, 0), modeCall(A, 'talk', 6, 3, 0), modeCall(A, 'talk', 8, 3, 0), modeCall(A, 'talk', 10, 3, 0)];
    const lab = (cutI: number, cutT: number) => [modeCall(B, 'interview', 1, 5, cutI), modeCall(B, 'interview', 3, 5, 0), modeCall(B, 'interview', 5, 5, 0), modeCall(B, 'talk', 7, 3, cutT), modeCall(B, 'talk', 9, 3, 0), modeCall(B, 'talk', 11, 3, 0)];
    const r = analyzeLogs(live, lab(2, 1)); // interview 1/15 -> 2/15 (+6.7); talk 0/9 -> 1/9 (+11.1)
    expect(check(r, 'C10.interview.cutin')).toMatchObject({ nA: 15, nB: 15, verdict: 'PASS' });
    expect(check(r, 'C10.talk.cutin')).toMatchObject({ nA: 9, nB: 9, verdict: 'FAIL' });
    expect(check(r, 'C10.talk.cutin').diff).toBeCloseTo(11.11, 1);
    const edge = analyzeLogs(live, lab(3, 0)); // interview 1/15 -> 3/15: +13.3
    expect(check(edge, 'C10.interview.cutin').verdict).toBe('FAIL');
    expect(r.criteria[4].verdict).toBe('FAIL');
  });

  it('reports split lines beside the cut-in rates of both modes (not pass/fail), and a second user line is not a cut-in there either', () => {
    const splitCall = (chain: string, mode: 'interview' | 'talk', minute: number, n: number, split: number) => {
      const b = new CallBuilder(chain, { mode, set: mode, minute });
      let at = 6000;
      for (let i = 0; i < n; i++) at = b.turn({ at, id: `${mode[0]}-p${i}`, cls: 'pause', segments: [[640, 1840], [5340, 6540]], ...(i < split ? { extraTranscript: -1500 } : {}) });
      return b.build();
    };
    const live = [splitCall(A, 'interview', 0, 15, 0), splitCall(A, 'talk', 2, 9, 0)];
    const lab = [splitCall(B, 'interview', 1, 15, 15), splitCall(B, 'talk', 3, 9, 3)];
    const r = analyzeLogs(live, lab);
    expect(check(r, 'C10.interview.cutin').bRate).toMatchObject({ k: 0, n: 15 });
    expect(check(r, 'C10.talk.cutin').bRate).toMatchObject({ k: 0, n: 9 });
    expect(r.criteria[4].verdict).toBe('PASS');
    const rows = r.criteria[4].info.filter((i) => i.label.startsWith('split lines'));
    expect(rows.map((i) => [i.label, i.aRate!.k, i.aRate!.n, i.bRate!.k, i.bRate!.n])).toEqual([
      ['split lines, interview pause scenarios', 0, 15, 15, 15],
      ['split lines, talk-through pause scenarios', 0, 9, 3, 9],
    ]);
    expect(renderReport(r)).toMatch(/\| split lines, interview pause scenarios \| 0\/15 = 0\.0 % \[0\.0, 20\.4\] \| 15\/15 = 100\.0 % \[79\.6, 100\.0\] \| 15 \/ 15 \|/);
  });

  it('checks that the call started in the mode asked for (what ready names), on chain B', () => {
    const live = [modeCall(A, 'interview', 0, 5, 0), modeCall(A, 'talk', 2, 3, 0)];
    const ok = analyzeLogs(live, [modeCall(B, 'interview', 1, 5, 0), modeCall(B, 'talk', 3, 3, 0)]);
    expect(check(ok, 'C10.mode')).toMatchObject({ a: 0, b: 0, nB: 2 });
    const wrong = analyzeLogs(live, [modeCall(B, 'interview', 1, 5, 0, { readyMode: 'conversational' }), modeCall(B, 'talk', 3, 3, 0)]);
    expect(check(wrong, 'C10.mode')).toMatchObject({ b: 1, verdict: 'FAIL' });
  });
});

// ---------------------------------------------------------------- selection, warnings, the report

describe('which logs count', () => {
  it('leaves out a call repeated after a client socket error (it is kept, named, and not counted) and keeps the repeat', () => {
    const failed = new CallBuilder(B, { minute: 1, readyMs: null, callId: 'B-failed' }).build();
    const repeat = new CallBuilder(B, { minute: 1.5, retryOf: 'B-failed', callId: 'B-repeat' }).build();
    const r = analyzeLogs([new CallBuilder(A, { minute: 0 }).build()], [failed, repeat]);
    expect(r.excluded.superseded).toEqual(['B-failed']);
    expect(r.b.calls).toBe(1);
    expect(check(r, 'C0.starts').nB).toBe(1);
    expect(check(r, 'C0.starts').b).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/repeated after a client socket error.*B-failed/);
    // when the repeat failed too, it counts as a failed start
    const failedAgain = new CallBuilder(B, { minute: 1.5, retryOf: 'B-failed', readyMs: null, callId: 'B-repeat2' }).build();
    expect(check(analyzeLogs([], [failed, failedAgain]), 'C0.starts').b).toBe(1);
  });

  it('never lets the tuning set into a criterion, and analyses only it when asked', () => {
    const tuning = (chain: string, minute: number) => chatCall(chain, lat(10, 1000).map((latency, k) => ({ id: `t${k}`, cls: 'latency' as const, latency })), { set: 'tuning', minute });
    const evalLive = latencyChain(A, mA, lat(30, 1000));
    const r = analyzeLogs([...evalLive, tuning(A, 20)], [...latencyChain(B, mB, lat(30, 1000)), tuning(B, 21)]);
    expect(r.a.calls).toBe(3);
    expect(r.excluded.otherSets).toBe(2);
    expect(check(r, 'C1.plain.p50').nA).toBe(30);
    expect(r.tuningOnly).toBe(false);
    const t = analyzeLogs([...evalLive, tuning(A, 20)], [tuning(B, 21)], { tuning: true });
    expect(t.tuningOnly).toBe(true);
    expect(t.a.calls).toBe(1);
    expect(check(t, 'C1.plain.p50').nA).toBe(10);
    expect(t.warnings.join(' ')).toMatch(/TUNING LOGS ONLY/);
    expect(renderReport(t)).toMatch(/TUNING LOGS ONLY/);
  });

  it('says whether the frozen test set was used', () => {
    const one = (testset: CallOpts['testset']) => analyzeLogs([new CallBuilder(A, { testset }).build()], [new CallBuilder(B, { testset }).build()]);
    expect(one(undefined).testset.frozen).toBe(true);
    expect(one(undefined).warnings.join(' ')).not.toMatch(/frozen/);
    const other = one({ sha256: 'f'.repeat(64), blob: 'a'.repeat(40) });
    expect(other.testset.frozen).toBe(false);
    expect(other.warnings.join(' ')).toMatch(/NOT the frozen one/);
    const none = one(null);
    expect(none.testset.fingerprints).toEqual([]);
    expect(none.warnings.join(' ')).toMatch(/no raw log carries a test-set fingerprint/);
  });
});

describe('warnings', () => {
  it('flags calls that are not interleaved, a session longer than two hours, and the same label on both sides', () => {
    const run = (aMin: number[], bMin: number[]) => analyzeLogs(aMin.map((m) => new CallBuilder(A, { minute: m }).build()), bMin.map((m) => new CallBuilder(B, { minute: m }).build()));
    const good = run([0, 2, 4], [1, 3, 5]);
    expect(good.interleaving).toMatchObject({ calls: 6, longestRun: 1, alternations: 5, spanMinutes: 5 });
    expect(good.warnings.join(' ')).not.toMatch(/interleaved|two hours/);
    const blocks = run([0, 1, 2, 3], [10, 11, 12, 13]);
    expect(blocks.interleaving.longestRun).toBe(4);
    expect(blocks.warnings.join(' ')).toMatch(/not interleaved: up to 4 in a row/);
    expect(run([0], [130]).warnings.join(' ')).toMatch(/130 minutes.*two hours/);
    expect(run([0], [120]).warnings.join(' ')).not.toMatch(/two hours/);
    const same = analyzeLogs([new CallBuilder('X', { minute: 0 }).build()], [new CallBuilder('X', { minute: 1 }).build()]);
    expect(same.warnings.join(' ')).toMatch(/both directories hold chain "X"/);
  });

  it('flags scenarios cut off by the server, scenarios that began before quiet, a cut log line, and a live baseline with no answers', () => {
    const b = new CallBuilder(B);
    b.turn({ at: 6000, wait: 'closed', latency: null });
    b.turn({ at: 40_000, id: 'l02', settled: false });
    b.turn({ at: 80_000, id: 'l03' });
    const r = analyzeLogs([chatCall(A, [{ latency: null, cls: 'latency' }, ...lat(12, 1000).map(() => ({ cls: 'latency' as const }))])], [b.build()]);
    expect(r.b.incompleteScenarios).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/chain D: 1 scenario\(s\) were cut off by the server/);
    expect(r.warnings.join(' ')).toMatch(/1 scenario\(s\) began before the previous one reached quiet/);
    const cut = new CallBuilder(B).text() + '{"k":"e","t":99,"ty';
    const parsed = parseRawLog(cut, 'cut.jsonl');
    expect(parsed.truncated).toBe(true);
    expect(analyzeLogs([], [parsed]).warnings.join(' ')).toMatch(/1 raw log\(s\) end in a cut line/);
    const dead = analyzeLogs([chatCall(A, lat(30, 0).map((_, i) => (i < 4 ? { latency: null, cls: 'latency' as const } : { cls: 'latency' as const })))], [chatCall(B, lat(30, 1000).map(() => ({ cls: 'latency' as const })))]);
    expect(dead.warnings.join(' ')).toMatch(/live baseline.*outage/);
  });

  it('measures the client\'s own pacing from the frame times in the log and warns when it was late', () => {
    const steady = analyzeLogs([new CallBuilder(A, { late: lat(200, 0.5) }).build()], [new CallBuilder(B, { late: lat(200, 1) }).build()]);
    expect(steady.a.pacing).toMatchObject({ frames: 200, p50: 0.5, max: 0.5 });
    expect(steady.warnings.join(' ')).not.toMatch(/late/);
    const late = analyzeLogs([new CallBuilder(A, { late: lat(200, (i) => (i === 100 ? 80 : 1)) }).build()], [new CallBuilder(B).build()]);
    expect(late.a.pacing.max).toBe(80);
    expect(late.warnings.join(' ')).toMatch(/chain L: the client sent microphone frames late/);
  });
});

describe('the report', () => {
  const sample = () => {
    const live = latencyChain(A, mA, lat(30, 1000));
    return analyzeLogs(live, latencyChain(B, mB, lat(30, (i) => 1000 + (i % 5) * 60)), { now: () => new Date('2026-11-13T12:00:00.000Z') });
  };

  it('has a verdict table, the checks with both chains, the difference, the tolerance and the sample against its minimum, and the definitions', () => {
    const md = renderReport(sample());
    expect(md).toMatch(/^# Voice lab: measurement report/);
    expect(md).toContain('Generated 2026-11-13T12:00:00.000Z');
    expect(md).toContain('| C0 Call start | INSUFFICIENT |');
    expect(md).toContain('| C1 End of speech to first audio |');
    expect(md).toContain('## C1: End of speech to first audio');
    expect(md).toMatch(/\| plain turns \(latency prompts\), p50 \(B p50 <= A p50 \+ 300 ms\) \| 1000 ms \| 1120 ms \| \+120 ms \| <= \+300 ms \| \[.*\] ms \(bootstrap\) \| 30 \/ 30 \(min 30\) \| PASS/);
    expect(md).toMatch(/NOT MET/); // C0's 20 calls are not there
    expect(md).toContain('## Definitions used');
    for (const d of DEFINITIONS.slice(0, 2)) expect(md).toContain(d.slice(0, 40));
    expect(md).toContain('INSUFFICIENT: it would pass, but a sample is below the minimum');
    expect(md).toContain('A difference is B minus A');
  });

  it('writes "not distinguishable at this n" next to a verdict whose interval contains zero, and k/n with the Wilson interval for rates', () => {
    const noisy = (chain: string, minute: (i: number) => number, shift: number) => latencyChain(chain, minute, lat(30, (i) => 900 + ((i * 7) % 11) * 100 + shift));
    const r = analyzeLogs(noisy(A, mA, 0), noisy(B, mB, 20));
    expect(check(r, 'C1.plain.p50').notDistinguishable).toBe(true);
    expect(renderReport(r)).toMatch(/PASS \(not distinguishable at this n\)/);
    const rates = analyzeLogs(
      [chatCall(A, lat(60, 0).map((_, i) => ({ id: `p${i}`, cls: 'pause' as const, ...(i < 3 ? { early: -1000 } : {}) })), { minute: 0 })],
      [chatCall(B, lat(60, 0).map((_, i) => ({ id: `p${i}`, cls: 'pause' as const, ...(i < 6 ? { early: -1000 } : {}) })), { minute: 1 })],
    );
    expect(renderReport(rates)).toMatch(/3\/60 = 5\.0 % \[1\.7, 13\.7\] \| 6\/60 = 10\.0 % \[4\.7, 20\.1\] \| \+5\.0 points/);
  });

  it('is the same numbers as JSON, with no Infinity or NaN in it and the censored values marked', () => {
    const live = latencyChain(A, mA, lat(30, 1000));
    const broken = analyzeLogs(live, latencyChain(B, mB, lat(30, 1000), per(30, (i) => (i < 4 ? { latency: null, eot: null } : {}))));
    const json = JSON.stringify(broken);
    expect(json).not.toMatch(/Infinity|NaN/);
    const back = JSON.parse(json) as Report;
    expect(back.criteria.map((c) => c.id)).toEqual(['C0', 'C1', 'C2', 'C3', 'C10']);
    const p90 = back.criteria[1].checks.find((c) => c.id === 'C1.plain.p90')!;
    expect(p90.b).toBeNull();
    expect(p90.bCensored).toBe(true);
    expect(p90.verdict).toBe('FAIL');
    expect(renderReport(broken)).toContain('no answer');
    expect(back.a.label).toBe('L');
    expect(back.b.label).toBe('D');
  });

  it('reads the raw logs of a directory and reports them (the CLI\'s path)', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-an-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-an-b-'));
    dirs.push(dirA, dirB);
    const write = (dir: string, chain: string, minute: (i: number) => number, latency: number) =>
      [0, 1, 2].forEach((call) => {
        const b = new CallBuilder(chain, { set: 'latency', minute: minute(call) });
        let at = 6000;
        for (let k = 0; k < 10; k++) at = b.turn({ at, id: `l${k}`, latency });
        fs.writeFileSync(path.join(dir, `call${call}.jsonl`), b.text());
      });
    write(dirA, A, mA, 1000);
    write(dirB, B, mB, 1250);
    fs.writeFileSync(path.join(dirB, 'notes.txt'), 'not a log');
    expect(readRawLogs(dirA)).toHaveLength(3);
    const r = analyzeDirs(dirA, dirB);
    expect(check(r, 'C1.plain.p50')).toMatchObject({ a: 1000, b: 1250, diff: 250, nA: 30, nB: 30, verdict: 'PASS' });
  });
});

describe('reading a raw log', () => {
  const ok = () => new CallBuilder(A).text();

  it('ignores line kinds it does not know (a newer log), reads every kind it does, and numbers lines in file order', () => {
    const text = ok().replace('\n', '\n{"k":"future","x":1}\n');
    const call = parseRawLog(text);
    expect(call.header.chain).toBe('L');
    expect(call.open!.t).toBe(3);
    expect(call.start!.t).toBe(10);
    expect(call.mic!.frameMs).toBe(40);
    expect(call.events.every((e, i) => i === 0 || e.seq > call.events[i - 1].seq)).toBe(true);
    expect(call.end!.reason).toBe('done');
    expect(call.truncated).toBe(false);
  });

  it('refuses a log with no header or with a broken line that is not the last', () => {
    expect(() => parseRawLog('{"k":"open","t":1}\n', 'x.jsonl')).toThrow(/x\.jsonl: no call header/);
    const lines = ok().trim().split('\n');
    lines.splice(2, 0, '{not json');
    expect(() => parseRawLog(lines.join('\n'), 'bad.jsonl')).toThrow(/bad\.jsonl: line 3 is not JSON/);
  });
});
