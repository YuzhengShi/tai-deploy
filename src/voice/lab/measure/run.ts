/**
 * One synthetic call, played the way docs/VOICE_SELFBUILT.md 9.2 says, and its raw log.
 *
 * `runCall` connects, sends `start` in the mode under test, waits for `ready` and for the greeting to end, then plays the scenarios one after
 * the other: the scenario's audio into the microphone stream, silence until the agent has answered (an agent audio frame after the end of
 * speech, then `status listening`) or 25 s have passed (90 s for a `tool` scenario of the `tools` set, whose look-up can take a minute), then 1.5 s of quiet (and `listening`) before the next one. A barge-in scenario plays the
 * question, waits for the agent to be audible `afterFirstAudioMs` after the first frame of its answer and puts the interruption into the
 * stream there. It hangs up with `end` and writes the raw log: JSON lines, one file per call. The raw log is the evidence: `analyze.ts` reads
 * nothing else, so everything it needs is in the lines below (their types are exported from here and are all the analysis imports of this file).
 *
 * Times in the log are milliseconds of the call's own clock (t = 0 when the client was created, just before the socket was opened).
 */
import fs from 'fs';
import path from 'path';

import { CallClient, ConnectError, type AgentFrame, type ClientEvent } from './client.js';
import type { CallMode, Fingerprint, ScenarioClass, ScenarioPlan } from './scenario.js';
import { AUDIBLE_SLACK_MS, audibleAt, frameOfSample } from './wav.js';

export const RAW_LOG_VERSION = 1;

// ---------------------------------------------------------------- the raw log's lines

export interface CallHeader {
  k: 'call';
  v: number;
  /** unique per attempt; names the file */
  callId: string;
  /** the label of the chain under test (L, D, H, FD, C ...) */
  chain: string;
  /** the whole route the call was made on, with its query when it had one (`api/voice-lab?chain=h`) */
  path: string;
  mode: CallMode;
  /** the set the scenarios came from (latency, pause, ..., tuning) */
  set: string;
  run: number;
  attempt: number;
  /** the callId of the attempt this one repeats after a client socket error (that one is kept but not counted) */
  retryOf?: string;
  /** wall-clock time at t = 0 */
  wall: string;
  frameMs: number;
  /** how many scenarios the call was asked to play */
  scenarios: number;
  /** the fingerprint of the test set the scenarios were built from */
  testset?: Fingerprint;
  timing: RunTiming;
}

/** The socket opened. */
export interface OpenLine {
  k: 'open';
  t: number;
}

/** `start` was sent: the call's start for C0. */
export interface StartLine {
  k: 'start';
  t: number;
  mode: CallMode;
}

/** The microphone began: frame i was due at t + i * frameMs. */
export interface MicLine {
  k: 'mic';
  t: number;
  frameMs: number;
}

/** A JSON message of the server, with its arrival time (only the fields the analysis needs; `ready` keeps the first 8 characters of the session id). */
export interface EventLine {
  k: 'e';
  t: number;
  type: string;
  [field: string]: unknown;
}

/** One binary frame of the agent's speech arrived. */
export interface AudioLine {
  k: 'a';
  t: number;
  /** bytes of PCM16 24 kHz */
  n: number;
}

/** The send times of consecutive microphone frames i, i + 1, ... (so the pacing of the client can be checked from the log). */
export interface FramesLine {
  k: 'f';
  i: number;
  t: number[];
}

/** How the greeting went: when its first frame arrived and when `listening` followed it, and whether quiet was reached before the first scenario. */
export interface GreetLine {
  k: 'greet';
  audioAt: number | null;
  listeningAt: number | null;
  settled: boolean;
}

export interface SegmentLine {
  text: string;
  /** stream time of the first and last speech sample, ms from the scenario's own first sample (sample-exact: sample / 16) */
  beginMs: number;
  endMs: number;
  /** the microphone frames that carry the first and the last speech sample, and when they were sent */
  beginFrame: number;
  endFrame: number;
  beginSentAt: number | null;
  endSentAt: number | null;
}

export interface InterruptionLine {
  text: string;
  afterFirstAudioMs: number;
  /** arrival of the agent frame the delay was counted from */
  anchorAt: number | null;
  /** the time the clip's first frame was due */
  scheduledAt: number | null;
  firstFrame: number | null;
  firstSentAt: number | null;
  /** the frame that carries the first speech sample of the interruption: its send time is the onset the stop times are measured from */
  onsetFrame: number | null;
  onsetSentAt: number | null;
  /** the frame that carries its last speech sample */
  endFrame: number | null;
  endSentAt: number | null;
  /** the runner's own check at the planned moment (playout of the audio received so far): was the agent still audible */
  audibleAtPlan: boolean | null;
  /** why nothing was said: no agent audio after the question, the agent was never audible at a planned moment, or the call closed */
  skipped?: 'no-answer-audio' | 'agent-not-audible' | 'closed';
  /** how the wait for the answer to the interruption ended */
  wait: 'answered' | 'timeout' | 'closed' | null;
}

export type WaitResult = 'answered' | 'timeout' | 'closed';

export interface ScenarioLine {
  k: 'scn';
  id: string;
  class: ScenarioClass;
  set: string;
  /** 0-based position in the call */
  position: number;
  voice: string;
  /** the send time of the scenario's first frame (the 600 ms of lead silence begin here) */
  begin: number;
  /** when the runner closed the scenario's window: the answer was complete and the quiet time passed, or the cap, or the call closed. The next scenario begins after it. */
  end: number;
  firstFrame: number;
  frames: number;
  /** the end of speech (UE): its stream time in ms (the end of the last speech sample), the frame that carries the last speech sample and its send time */
  ueMs: number;
  ueFrame: number;
  ueSentAt: number | null;
  segments: SegmentLine[];
  wait: WaitResult;
  /** quiet (status listening, no agent audio for the settle time) was reached before the window closed */
  settled: boolean;
  interruption?: InterruptionLine;
}

export interface EndLine {
  k: 'end';
  t: number;
  /** done: every scenario was played and the call hung up; closed: the server ended the call; socket-error: the socket failed; start-failed: no `ready`; time-limit: the session or the day would have run out */
  reason: 'done' | 'closed' | 'socket-error' | 'start-failed' | 'time-limit' | 'error';
  /** the socket's own error message, when it had one */
  socketError?: string;
  /** an `error` event of the server (code and message), or the client's own failure */
  error?: { code: string; message: string };
  /** the `closed` event's reason */
  closedReason?: string;
  /** the ids of the scenarios that were not played */
  skipped?: string[];
}

export type RawLine = CallHeader | OpenLine | StartLine | MicLine | EventLine | AudioLine | FramesLine | GreetLine | ScenarioLine | EndLine;

// ---------------------------------------------------------------- the knobs

/** The waits of a call; the defaults are the document's numbers. Tests shorten them. */
export interface RunTiming {
  /** how long to wait for `ready` after `start` */
  readyTimeoutMs: number;
  /** give up waiting for greeting audio after this long without a frame (docs 9.2: 6 s) */
  greetingWaitMs: number;
  /** how long the greeting may take to end once it began */
  greetingEndMs: number;
  /** no answer within this long of the end of speech: the scenario goes on (docs 9.2: 25 s) */
  answerCapMs: number;
  /**
   * the same for a scenario of class `tool` (the `tools` set, docs A12): a request that makes the model run a look-up that takes a while (a code run takes up to a minute, and the first
   * look-up of a call can wait 30 s or more for its tool host). Also how long the quiet wait of such a scenario reaches, counted from the end of speech, and what a `tool` scenario reserves
   * of the call's time before it begins.
   */
  toolAnswerCapMs: number;
  /** quiet time (status listening, no agent audio) required before the next scenario (docs 9.2: 1.5 s more silence) */
  settleMs: number;
  /** how long to wait for the quiet to be reached before going on anyway */
  quietCapMs: number;
  /** how long to wait for `closed` after `end` */
  closeWaitMs: number;
}

export const DEFAULT_TIMING: RunTiming = {
  readyTimeoutMs: 15_000,
  greetingWaitMs: 6_000,
  greetingEndMs: 20_000,
  answerCapMs: 25_000,
  toolAnswerCapMs: 90_000,
  settleMs: 1_500,
  quietCapMs: 20_000,
  closeWaitMs: 10_000,
};

/** How long a scenario of this class waits for its answer: the usual cap, or a `tool` scenario's own longer one. */
export function answerCapFor(cls: ScenarioClass, timing: RunTiming): number {
  return cls === 'tool' ? timing.toolAnswerCapMs : timing.answerCapMs;
}

export interface RunTarget {
  /** the portal's unix socket (on the host) */
  socket?: string;
  /** or a base URL, ws://host:port (optionally with a path prefix) */
  url?: string;
}

/** The URL of the call's WebSocket: ws+unix:<socket>:/<path> or <base>/<path>. The route may end in a query (`api/voice-lab?chain=h`): it is kept as it is. */
export function callUrl(target: RunTarget, route: string): string {
  const clean = route.replace(/^\/+/, '');
  if (target.socket) return `ws+unix:${target.socket}:/${clean}`;
  if (target.url) return `${target.url.replace(/\/+$/, '')}/${clean}`;
  throw new Error('no target: give a unix socket or a URL');
}

export interface RunOptions {
  chain: string;
  /** the portal route, api/voice (live) or api/voice-lab, optionally with `?chain=d|h|fd|c` (the lab's chain of this call, docs A10) */
  path: string;
  mode: CallMode;
  /** the label of the set the scenarios belong to */
  set: string;
  scenarios: ScenarioPlan[];
  run?: number;
  attempt?: number;
  retryOf?: string;
  target: RunTarget;
  origin: string;
  /** the tai_session cookie's value; never printed, stored or put in the log */
  cookie: string;
  /** where the raw log is written (one file per call); nothing is written when absent */
  outDir?: string;
  testset?: Fingerprint;
  timing?: Partial<RunTiming>;
  frameMs?: number;
  /** progress lines for a person (never the cookie) */
  note?: (line: string) => void;
}

export interface RunResult {
  callId: string;
  /** the raw log's file, when it was written */
  file: string | null;
  lines: RawLine[];
  /** `ready` arrived */
  started: boolean;
  /** the socket failed (refused, reset, closed without a `closed` event): the CLI repeats such a call once */
  socketError: boolean;
  /** the hub answered `busy` (another call of this student is open or still being saved): the CLI waits and tries again */
  busy: boolean;
  played: number;
  answered: number;
  reason: EndLine['reason'];
}

// ---------------------------------------------------------------- helpers

const round2 = (t: number): number => Math.round(t * 100) / 100;
const roundOrNull = (t: number | null | undefined): number | null => (t === null || t === undefined ? null : round2(t));

const clip = (value: unknown, max: number): string => String(value ?? '').slice(0, max);

/** What of a server message goes into the log: the fields the analysis uses, texts cut, the session id cut to 8 characters. */
export function eventLine(e: ClientEvent): EventLine {
  const ev = e.ev;
  const type = clip(ev.type, 40);
  const base = { k: 'e' as const, t: round2(e.t), type };
  switch (type) {
    case 'ready':
      return { ...base, sessionId: clip(ev.sessionId, 8), mode: ev.mode, voice: ev.voice, maxSeconds: ev.maxSeconds, resumed: ev.resumed };
    case 'status':
      return { ...base, state: ev.state };
    case 'transcript':
      return { ...base, role: ev.role, text: clip(ev.text, 300), mode: ev.mode };
    case 'mode':
      return { ...base, mode: ev.mode, voice: ev.voice };
    case 'notice':
      return { ...base, text: clip(ev.text, 200) };
    case 'error':
      return { ...base, code: clip(ev.code, 40), message: clip(ev.message, 200) };
    case 'closed':
      return { ...base, reason: ev.reason };
    default:
      return base;
  }
}

function lastStatus(client: CallClient): string | null {
  for (let i = client.events.length - 1; i >= 0; i--) {
    const ev = client.events[i].ev;
    if (ev.type === 'status') return String(ev.state);
  }
  return null;
}

/** An agent frame arrived at or after `from`, and a `status listening` arrived after it: the agent has answered and is done. */
export function answeredAfter(client: CallClient, from: number): boolean {
  const frame = client.audio.find((a) => a.t >= from);
  if (!frame) return false;
  return client.events.some((e) => e.seq > frame.seq && e.ev.type === 'status' && e.ev.state === 'listening');
}

/**
 * Quiet: the agent's last status is `listening` (or it has none) and no agent audio arrived for `settleMs` (counted from `since` at the earliest).
 * True when it is reached, false when `capMs` (`quietCapMs`, unless the caller says otherwise) pass or the call closes first.
 */
function settle(client: CallClient, timing: RunTiming, since: number, capMs: number = timing.quietCapMs): Promise<boolean> {
  const quiet = (): boolean => {
    const last = client.audio.length ? client.audio[client.audio.length - 1].t : -Infinity;
    const status = lastStatus(client);
    return (status === null || status === 'listening') && client.now() - Math.max(last, since) >= timing.settleMs;
  };
  return client.waitFor(quiet, capMs, 25);
}

export function makeCallId(chain: string, set: string, run: number, attempt: number, wall: string): string {
  return `${chain}-${set}-r${run}-a${attempt}-${wall.replace(/[-:.]/g, '')}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---------------------------------------------------------------- one scenario

interface ScenarioOutcome {
  line: ScenarioLine | null;
  closed: boolean;
}

/** Waits for the answer to speech that ended at `from`, until `capMs` have passed since then (the class's cap, see `answerCapFor`). */
async function waitAnswer(client: CallClient, from: number, capMs: number): Promise<WaitResult> {
  const cap = Math.max(0, capMs - (client.now() - from));
  const ok = await client.waitFor(() => answeredAfter(client, from), cap);
  return ok ? 'answered' : client.closed ? 'closed' : 'timeout';
}

/**
 * The interruption of a barge-in scenario: waits for agent audio after the question's end of speech, then `afterFirstAudioMs` after the first frame of
 * it; if the agent is still audible by the playout clock at that moment the clip goes into the microphone stream there. If not (a filler or a lead-in
 * has ended while a look-up runs), the wait starts again from the next agent frame, until the answer cap since the end of speech is used up.
 */
async function interrupt(client: CallClient, plan: ScenarioPlan, ueSentAt: number, timing: RunTiming): Promise<InterruptionLine> {
  const bi = plan.interruption!;
  const line: InterruptionLine = {
    text: bi.text,
    afterFirstAudioMs: bi.afterFirstAudioMs,
    anchorAt: null,
    scheduledAt: null,
    firstFrame: null,
    firstSentAt: null,
    onsetFrame: null,
    onsetSentAt: null,
    endFrame: null,
    endSentAt: null,
    audibleAtPlan: null,
    wait: null,
  };
  const deadline = ueSentAt + timing.answerCapMs;
  let from = ueSentAt;
  let sawAudio = false;
  let plannedAt = 0;
  for (;;) {
    const anchor: AgentFrame | null = await client.waitForAudio(from, Math.max(0, deadline - client.now()));
    if (!anchor) {
      line.skipped = client.closed ? 'closed' : sawAudio ? 'agent-not-audible' : 'no-answer-audio';
      return line;
    }
    sawAudio = true;
    line.anchorAt = round2(anchor.t);
    plannedAt = anchor.t + bi.afterFirstAudioMs;
    await client.waitFor(() => client.now() >= plannedAt, Math.max(0, plannedAt - client.now()) + 50, 10);
    if (client.closed) {
      line.skipped = 'closed';
      return line;
    }
    const heard = client.audio.filter((a) => a.t >= ueSentAt);
    line.audibleAtPlan = audibleAt(heard, plannedAt, AUDIBLE_SLACK_MS);
    if (line.audibleAtPlan) break;
    from = plannedAt;
  }
  line.scheduledAt = round2(plannedAt);
  const handle = client.injectAt(bi.pcm, plannedAt);
  const fs = client.frameSamples;
  line.firstFrame = handle.firstFrame;
  line.onsetFrame = handle.firstFrame + frameOfSample(bi.firstSample, fs);
  line.endFrame = handle.firstFrame + frameOfSample(bi.lastSample, fs);
  line.endSentAt = roundOrNull(await client.frameSent(line.endFrame));
  line.firstSentAt = roundOrNull(client.sentTimes[line.firstFrame] ?? null);
  line.onsetSentAt = roundOrNull(client.sentTimes[line.onsetFrame] ?? null);
  if (line.endSentAt === null) {
    line.wait = 'closed';
    return line;
  }
  line.wait = await waitAnswer(client, line.endSentAt, timing.answerCapMs);
  return line;
}

async function playScenario(client: CallClient, plan: ScenarioPlan, timing: RunTiming): Promise<ScenarioOutcome> {
  const fs = client.frameSamples;
  const speech = plan.built.speech;
  const last = speech[speech.length - 1];
  const handle = client.play(plan.built.pcm);
  const beginSentAt = await client.frameSent(handle.firstFrame);
  if (beginSentAt === null) return { line: null, closed: true };
  const segments: SegmentLine[] = speech.map((s) => ({
    text: s.text,
    beginMs: s.beginMs,
    endMs: s.endMs,
    beginFrame: handle.firstFrame + frameOfSample(s.beginSample, fs),
    endFrame: handle.firstFrame + frameOfSample(s.endSample - 1, fs),
    beginSentAt: null,
    endSentAt: null,
  }));
  const ueFrame = handle.firstFrame + frameOfSample(last.endSample - 1, fs);
  const ueSentAt = await client.frameSent(ueFrame);
  // every frame up to the end of speech has been sent by now: their times are known
  for (const seg of segments) {
    seg.beginSentAt = roundOrNull(client.sentTimes[seg.beginFrame] ?? null);
    seg.endSentAt = roundOrNull(client.sentTimes[seg.endFrame] ?? null);
  }
  const line: ScenarioLine = {
    k: 'scn',
    id: plan.id,
    class: plan.class,
    set: plan.set,
    position: plan.position,
    voice: plan.voice,
    begin: round2(beginSentAt),
    end: round2(beginSentAt),
    firstFrame: handle.firstFrame,
    frames: handle.frames,
    ueMs: last.endMs,
    ueFrame,
    ueSentAt: roundOrNull(ueSentAt),
    segments,
    wait: 'closed',
    settled: false,
  };
  if (ueSentAt === null) {
    line.end = round2(client.now());
    return { line, closed: true };
  }
  let since = ueSentAt;
  if (plan.interruption) {
    const bi = await interrupt(client, plan, ueSentAt, timing);
    line.interruption = bi;
    line.wait = bi.wait ?? (bi.skipped === 'closed' ? 'closed' : 'timeout');
    if (bi.endSentAt !== null) since = bi.endSentAt;
  } else {
    line.wait = await waitAnswer(client, ueSentAt, answerCapFor(plan.class, timing));
  }
  if (!client.closed) {
    // `listening` can come in the middle of a look-up (a spoken line before the call, say) and the look-up go on for a minute: a `tool` scenario's quiet wait reaches to the end of its own cap,
    // counted from the end of speech, so that the next scenario does not play over the answer
    const quietCap = plan.class === 'tool' ? Math.max(timing.quietCapMs, timing.toolAnswerCapMs - (client.now() - ueSentAt)) : timing.quietCapMs;
    line.settled = await settle(client, timing, since, quietCap);
  }
  line.end = round2(client.now());
  return { line, closed: client.closed };
}

// ---------------------------------------------------------------- one call

function framesLines(sentTimes: number[]): FramesLine[] {
  const out: FramesLine[] = [];
  const CHUNK = 250;
  for (let i = 0; i < sentTimes.length; i += CHUNK) {
    const times: number[] = [];
    for (let j = i; j < Math.min(sentTimes.length, i + CHUNK); j++) times.push(round2(sentTimes[j] ?? NaN));
    out.push({ k: 'f', i, t: times });
  }
  return out;
}

export function writeRawLog(outDir: string, callId: string, lines: RawLine[]): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${callId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** One synthetic call. Never rejects for a call that went wrong: that is in the log and the result. */
export async function runCall(opts: RunOptions): Promise<RunResult> {
  const timing: RunTiming = { ...DEFAULT_TIMING, ...(opts.timing ?? {}) };
  const note = opts.note ?? (() => undefined);
  const wall = new Date().toISOString();
  const run = opts.run ?? 1;
  const attempt = opts.attempt ?? 1;
  const callId = makeCallId(opts.chain, opts.set, run, attempt, wall);
  const frameMs = opts.frameMs ?? 40;
  const header: CallHeader = {
    k: 'call',
    v: RAW_LOG_VERSION,
    callId,
    chain: opts.chain,
    path: opts.path,
    mode: opts.mode,
    set: opts.set,
    run,
    attempt,
    ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    wall,
    frameMs,
    scenarios: opts.scenarios.length,
    ...(opts.testset ? { testset: opts.testset } : {}),
    timing,
  };
  const scenarioLines: ScenarioLine[] = [];
  let client: CallClient | null = null;
  let started = false;
  let reason: EndLine['reason'] = 'done';
  let error: EndLine['error'];
  let socketError: string | undefined;
  let busy = false;
  let skipped: string[] | undefined;
  let greet: GreetLine | null = null;
  const attemptStart = Date.now();

  try {
    try {
      client = await CallClient.connect({ url: callUrl(opts.target, opts.path), origin: opts.origin, cookie: opts.cookie, frameMs });
    } catch (err) {
      if (!(err instanceof ConnectError)) throw err; // a failure of the client's own (no target, say) is recorded below as an error, not as a refused socket
      const ce = err;
      reason = 'start-failed';
      socketError = ce.message;
      error = { code: ce.kind === 'http' ? `http-${ce.status}` : ce.kind, message: ce.message };
      note(`${opts.chain}: could not open the socket (${error.code})`);
    }
    if (client) {
      client.sendStart(opts.mode);
      await client.waitFor(() => client!.events.some((e) => e.ev.type === 'ready' || e.ev.type === 'error'), timing.readyTimeoutMs);
      const ready = client.events.find((e) => e.ev.type === 'ready');
      if (!ready) {
        reason = 'start-failed';
        const serverError = client.events.find((e) => e.ev.type === 'error');
        if (serverError) {
          error = { code: clip(serverError.ev.code, 40), message: clip(serverError.ev.message, 200) };
          busy = error.code === 'busy';
        } else if (client.closed) {
          // the socket went away before `ready`, with no word from the server: a failure of the connection itself, so the call is repeated once
          error = { code: 'closed-before-ready', message: client.socketError ?? `the socket closed before ready (code ${client.closeCode})` };
          socketError = error.message;
        } else {
          error = { code: 'ready-timeout', message: `no ready within ${Math.round(timing.readyTimeoutMs / 1000)} s` };
        }
        if (client.socketError) socketError = client.socketError;
        note(`${opts.chain}: the call did not start (${error?.code})`);
      } else {
        started = true;
        client.startMic();
        // the greeting: a frame (within greetingWaitMs of ready), then `listening` after it; then quiet, as after an answer
        const gotAudio = await client.waitFor(() => client!.audio.length > 0, timing.greetingWaitMs);
        let listeningAt: number | null = null;
        if (gotAudio) {
          const first = client.audio[0];
          await client.waitFor(() => client!.events.some((e) => e.seq > first.seq && e.ev.type === 'status' && e.ev.state === 'listening'), timing.greetingEndMs);
          listeningAt = client.events.find((e) => e.seq > first.seq && e.ev.type === 'status' && e.ev.state === 'listening')?.t ?? null;
        }
        const settled = client.closed ? false : await settle(client, timing, ready.t);
        greet = { k: 'greet', audioAt: roundOrNull(client.audio[0]?.t), listeningAt: roundOrNull(listeningAt), settled };
        const maxSeconds = Number(ready.ev.maxSeconds);
        const readyAt = ready.t;
        for (let i = 0; i < opts.scenarios.length; i++) {
          const plan = opts.scenarios[i];
          if (client.closed) {
            skipped = opts.scenarios.slice(i).map((p) => p.id);
            reason = 'closed';
            break;
          }
          const streamMs = plan.built.pcm.length / 32;
          // what the scenario may still take after its stream: a barge-in has two answers, a `tool` scenario waits as long as its cap allows
          const needed = streamMs + (plan.interruption ? 24_000 : plan.class === 'tool' ? timing.toolAnswerCapMs + timing.settleMs : 12_000);
          if (Number.isFinite(maxSeconds) && maxSeconds > 0 && client.now() - readyAt + needed > maxSeconds * 1000) {
            skipped = opts.scenarios.slice(i).map((p) => p.id);
            reason = 'time-limit';
            break;
          }
          const outcome = await playScenario(client, plan, timing);
          if (outcome.line) scenarioLines.push(outcome.line);
          note(`${opts.chain}: ${plan.id} ${outcome.line ? outcome.line.wait : 'not started'}`);
          if (outcome.closed) {
            skipped = opts.scenarios.slice(i + (outcome.line ? 1 : 0)).map((p) => p.id);
            reason = 'closed';
            break;
          }
        }
        if (!client.closed) await client.end(timing.closeWaitMs);
        else if (!client.sawClosed) {
          reason = 'socket-error';
          socketError = client.socketError ?? `the socket closed without a closed event (code ${client.closeCode})`;
        }
      }
    }
  } catch (err) {
    reason = 'error';
    error = { code: 'client', message: clip((err as Error).message, 200) };
  } finally {
    client?.terminate();
  }

  const closedEvent = client?.events.find((e) => e.ev.type === 'closed');
  const end: EndLine = {
    k: 'end',
    t: round2(client ? client.now() : Date.now() - attemptStart),
    reason,
    ...(socketError ? { socketError } : {}),
    ...(error ? { error } : {}),
    ...(closedEvent ? { closedReason: clip(closedEvent.ev.reason, 40) } : {}),
    ...(skipped && skipped.length ? { skipped } : {}),
  };

  const lines: RawLine[] = [header];
  if (client) {
    lines.push({ k: 'open', t: round2(client.openedAt) });
    if (client.startSentAt !== null) lines.push({ k: 'start', t: round2(client.startSentAt), mode: opts.mode });
    if (client.micStartAt !== null) lines.push({ k: 'mic', t: round2(client.micStartAt), frameMs });
    const records: Array<{ seq: number; line: EventLine | AudioLine }> = [
      ...client.events.map((e) => ({ seq: e.seq, line: eventLine(e) })),
      ...client.audio.map((a) => ({ seq: a.seq, line: { k: 'a' as const, t: round2(a.t), n: a.bytes } })),
    ];
    records.sort((x, y) => x.seq - y.seq);
    for (const r of records) lines.push(r.line);
    if (greet) lines.push(greet);
    lines.push(...framesLines(client.sentTimes));
  }
  lines.push(...scenarioLines);
  lines.push(end);

  const file = opts.outDir ? writeRawLog(opts.outDir, callId, lines) : null;
  return {
    callId,
    file,
    lines,
    started,
    socketError: socketError !== undefined && (reason === 'start-failed' || reason === 'socket-error') && !busy,
    busy,
    played: scenarioLines.length,
    answered: scenarioLines.filter((s) => s.wait === 'answered').length,
    reason,
  };
}
