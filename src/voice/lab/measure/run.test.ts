import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { analyzeLogs, callFacts, parseRawLog, type RawCall } from './analyze.js';
import type { CallClient } from './client.js';
import { answerCapFor, answeredAfter, callUrl, DEFAULT_TIMING, eventLine, makeCallId, runCall, type RawLine, type RunResult, type RunTiming, type ScenarioLine } from './run.js';
import { AudioLibrary, planSet, type ScenarioPlan, type ScenarioSpec, type TestSet } from './scenario.js';

// ---------------------------------------------------------------- generated audio and a mini test set

function wavOf(pcm: Buffer): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(pcm.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + head.length + pcm.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, head, pcm]);
}

/** silence, then speech at amplitude 4000, then silence (sample counts); speech lengths below are whole frames of 640 samples, so that a frame is wholly loud or wholly silent */
function clip(before: number, speech: number, after: number): Buffer {
  const buf = Buffer.alloc((before + speech + after) * 2);
  for (let i = 0; i < speech; i++) buf.writeInt16LE(Math.floor(i / 8) % 2 === 0 ? 4000 : -4000, (before + i) * 2);
  return buf;
}

const seg = (text: string, pauseAfterMs?: number) => ({ text, ...(pauseAfterMs ? { pauseAfterMs } : {}) });
const MINI: TestSet = {
  version: 1,
  voices: ['Voice A', 'Voice B'],
  recognition: [],
  latency: [
    { id: 'l01', text: 'hello there' },
    { id: 'l02', text: 'what is raft' },
  ],
  turntaking: {
    tuning: [],
    eval: [{ id: 'e-p01', class: 'pause', segments: [seg('seg one', 700), seg('seg two')] }] as ScenarioSpec[],
  },
  bargein: { ask: 'tell me everything', afterFirstAudioMs: 200, tuning: [], eval: ['hold on'] },
  modes: { interview: { eval: [] }, talk: { eval: [] } },
};
/** round 2's shape: the same, with a `tools` list (the set of the `tool` class) */
const MINI_TOOLS: TestSet = { ...MINI, tools: [{ id: 'x01', text: 'search it' }, { id: 'x02', text: 'run it' }] };
const SPEECH: Record<string, number> = { 'hello there': 640, 'what is raft': 640, 'seg one': 640, 'seg two': 640, 'tell me everything': 640, 'hold on': 1280, 'search it': 640, 'run it': 640 };
const LEAD_MS = 120; // 3 frames: with the 640-sample margin the speech starts and ends on a frame boundary

// Several calls run at the same time in this file (they are real-time and mostly waiting), so every test cleans up after itself.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-lab-run-'));
  dirs.push(dir);
  return dir;
};

function library(): AudioLibrary {
  const dir = tmp();
  const manifest: Record<string, string> = {};
  let n = 0;
  for (const voice of MINI.voices) {
    for (const [text, speech] of Object.entries(SPEECH)) {
      const name = `c${n++}.wav`;
      fs.writeFileSync(path.join(dir, name), wavOf(clip(1000, speech, 1000)));
      manifest[`${voice}|${text}`] = name;
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), '﻿' + JSON.stringify(manifest), 'utf8');
  return new AudioLibrary(dir);
}

const plans = (set: Parameters<typeof planSet>[1], ts: TestSet = MINI): ScenarioPlan[] => planSet(ts, set, library(), 0, LEAD_MS);

/** The waits of a call, short: the scripted server below is quick. */
const FAST: Partial<RunTiming> = { readyTimeoutMs: 1500, greetingWaitMs: 800, greetingEndMs: 1500, answerCapMs: 2500, toolAnswerCapMs: 6000, settleMs: 60, quietCapMs: 1500, closeWaitMs: 800 };

// ---------------------------------------------------------------- a scripted server: it hears the microphone and answers on a fixed rhythm

interface Script {
  readyMs: number;
  /** the agent speaks this long right after ready (0: no greeting) */
  greetingMs: number;
  /** silent frames after speech before the turn is committed (the end-of-turn wait is 40 ms times this) */
  holdFrames: number;
  /** from the commit to the first audio of the answer */
  thinkMs: number;
  /** the extra wait of a turn the script calls a tool turn, with `working` shown */
  toolMs: number;
  tool: (turn: number) => boolean;
  /** a tool turn begins with this much speech ("one sec"), 60 ms after the commit, and goes back to `working` (0: none) */
  fillerMs: number;
  /**
   * a tool turn begins with a spoken line instead: `ms` of speech `atMs` after the commit that ends in `listening` (the status of the line that is all a student has heard), and the look-up is only
   * shown (`working`) `workingAfterMs` after that, with no `working` before it; the answer comes after `thinkMs + toolMs` as for any tool turn
   */
  leadIn?: { atMs: number; ms: number; workingAfterMs: number };
  /** how long the answer is */
  answerMs: (turn: number) => number;
  /** from the first loud frame while the agent speaks to its agent_interrupted */
  interruptMs: number;
  /** what the server does on `start`: answer it, or fail in one of the ways a real one can */
  onStart: 'ready' | 'busy' | 'silent' | 'drop';
  /** after this many commits the server ends the call: `closed` (budget) or an abrupt drop */
  endAfter?: { commits: number; how: 'closed' | 'drop' };
  maxSeconds: number;
}

const DEFAULT_SCRIPT: Script = {
  readyMs: 30,
  greetingMs: 120,
  holdFrames: 3,
  thinkMs: 280, // an answer that came sooner than UE + 300 ms would be a cut-in by the document's own rule
  toolMs: 100,
  tool: () => false,
  fillerMs: 0,
  answerMs: () => 120,
  interruptMs: 40,
  onStart: 'ready',
  maxSeconds: 600,
};

interface Scripted {
  url: string;
  paths: string[];
  cookies: string[];
  origins: string[];
  starts: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function scripted(base: Partial<Script> = {}): Promise<Scripted> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const out: Scripted = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    paths: [],
    cookies: [],
    origins: [],
    starts: [],
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
  const cfg: Script = { ...DEFAULT_SCRIPT, ...base };
  wss.on('connection', (ws: ServerSocket, req) => {
    out.paths.push(String(req.url));
    out.cookies.push(String(req.headers.cookie ?? ''));
    out.origins.push(String(req.headers.origin ?? ''));
    const send = (o: Record<string, unknown>) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
    let agentSpeaking = false;
    let agentTimer: NodeJS.Timeout | null = null;
    let studentSpeaking = false;
    let silent = 0;
    let turns = 0;
    let commits = 0;
    let pending: NodeJS.Timeout[] = [];
    const stopAgent = () => {
      if (agentTimer) clearInterval(agentTimer);
      agentTimer = null;
      agentSpeaking = false;
    };
    const speak = (ms: number, text: string, then: 'listening' | 'working' = 'listening') => {
      send({ type: 'status', state: 'speaking' });
      agentSpeaking = true;
      let sent = 0;
      const tick = () => {
        if (sent * 40 >= ms) {
          stopAgent();
          if (then === 'listening') send({ type: 'transcript', role: 'agent', text, mode: 'conversational' });
          send({ type: 'status', state: then });
          return;
        }
        if (ws.readyState === ws.OPEN) ws.send(Buffer.alloc(1920, 1), { binary: true });
        sent++;
      };
      tick();
      agentTimer = setInterval(tick, 40);
    };
    ws.on('close', () => {
      stopAgent();
      pending.forEach(clearTimeout);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'start') {
          out.starts.push(msg);
          if (cfg.onStart === 'busy') {
            send({ type: 'error', code: 'busy', message: 'a call of this student is still being saved' });
            setTimeout(() => ws.close(), 20);
          } else if (cfg.onStart === 'drop') ws.terminate();
          else if (cfg.onStart === 'ready') {
            setTimeout(() => {
              send({ type: 'ready', sessionId: 'abcdefgh12345678', mode: msg.mode === 'interview' ? 'interviewer' : msg.mode === 'talk' ? 'listener' : 'conversational', voice: 'v', maxSeconds: cfg.maxSeconds, resumed: false });
              send({ type: 'status', state: 'listening' });
              if (cfg.greetingMs > 0) speak(cfg.greetingMs, 'hello');
            }, cfg.readyMs);
          }
        } else if (msg.type === 'end') {
          send({ type: 'closed', reason: 'user', summary: 'Voice session.' });
          setTimeout(() => ws.close(), 10);
        }
        return;
      }
      const samples = new Int16Array((data as Buffer).buffer, (data as Buffer).byteOffset, Math.floor((data as Buffer).length / 2));
      let sum = 0;
      for (const s of samples) sum += s * s;
      const loud = Math.sqrt(sum / Math.max(1, samples.length)) > 300;
      if (loud) {
        silent = 0;
        if (!studentSpeaking) {
          studentSpeaking = true;
          pending.forEach(clearTimeout); // a commit that has not been answered yet is taken back
          pending = [];
          if (agentSpeaking) {
            stopAgent();
            setTimeout(() => {
              send({ type: 'agent_interrupted' });
              send({ type: 'status', state: 'listening' });
            }, cfg.interruptMs);
          } else send({ type: 'agent_interrupted' }); // the hub sends one on every speech onset
        }
      } else if (studentSpeaking && ++silent >= cfg.holdFrames) {
        studentSpeaking = false;
        silent = 0;
        const turn = ++turns;
        commits++;
        if (cfg.endAfter && commits >= cfg.endAfter.commits) {
          if (cfg.endAfter.how === 'closed') {
            send({ type: 'closed', reason: 'budget' });
            setTimeout(() => ws.close(), 10);
          } else ws.terminate();
          return;
        }
        send({ type: 'transcript', role: 'user', text: `turn ${turn}`, mode: 'conversational' });
        send({ type: 'status', state: 'thinking' });
        const tool = cfg.tool(turn);
        const leadIn = tool ? cfg.leadIn : undefined;
        if (leadIn) {
          pending.push(setTimeout(() => speak(leadIn.ms, 'let me check', 'listening'), leadIn.atMs));
          pending.push(setTimeout(() => send({ type: 'status', state: 'working' }), leadIn.atMs + leadIn.ms + leadIn.workingAfterMs));
        } else if (tool) pending.push(setTimeout(() => send({ type: 'status', state: 'working' }), 40));
        if (tool && !leadIn && cfg.fillerMs > 0) pending.push(setTimeout(() => speak(cfg.fillerMs, 'one sec', 'working'), 60));
        pending.push(
          setTimeout(() => {
            if (tool) send({ type: 'status', state: 'thinking' });
            speak(cfg.answerMs(turn), 'an answer');
          }, cfg.thinkMs + (tool ? cfg.toolMs : 0)),
        );
      }
    });
  });
  return out;
}

/** A scripted server for the length of one test. */
async function withServer<T>(script: Partial<Script>, body: (server: Scripted) => Promise<T>): Promise<T> {
  const server = await scripted(script);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

async function call(server: { url: string }, scenarios: ScenarioPlan[], over: { mode?: 'chat' | 'interview' | 'talk'; timing?: Partial<RunTiming>; set?: string; path?: string; outDir?: string } = {}): Promise<RunResult> {
  return runCall({
    chain: 'T',
    path: over.path ?? 'api/voice',
    mode: over.mode ?? 'chat',
    set: over.set ?? 'latency',
    scenarios,
    target: { url: server.url },
    origin: 'https://lab.example',
    cookie: 'secret-cookie-value-xyz',
    ...(over.outDir ? { outDir: over.outDir } : {}),
    timing: { ...FAST, ...(over.timing ?? {}) },
  });
}

const parsed = (r: RunResult): RawCall => parseRawLog(r.lines.map((l) => JSON.stringify(l)).join('\n'), r.callId);
const scn = (r: RunResult, id: string): ScenarioLine => r.lines.find((l): l is ScenarioLine => l.k === 'scn' && l.id === id)!;
const endLine = (r: RunResult) => r.lines.find((l): l is Extract<RawLine, { k: 'end' }> => l.k === 'end')!;

// ---------------------------------------------------------------- the whole call

describe.concurrent('runCall: a whole call against a scripted server', () => {
  it('plays plain, tool and cut-in scenarios, and leaves a raw log the analysis reads the right numbers from', async () => {
    await withServer({ tool: (turn) => turn === 2 }, async (server) => {
      const outDir = tmp();
      const scenarios = [...plans('latency'), ...plans('pause')]; // l01 (plain), l02 (the script runs a look-up), e-p01 (a 700 ms pause: the script commits at 120 ms and answers, at about 400 ms, before the student goes on)
      const result = await call(server, scenarios, { outDir });
      expect(result.started).toBe(true);
      expect(result.reason).toBe('done');
      expect(result.played).toBe(3);
      expect(result.answered).toBe(3);
      expect(result.socketError).toBe(false);
      expect(result.busy).toBe(false);
      expect(server.paths).toEqual(['/api/voice']);
      expect(server.origins[0]).toBe('https://lab.example');
      expect(server.cookies[0]).toBe('tai_session=secret-cookie-value-xyz');
      expect(server.starts[0]).toEqual({ type: 'start', mode: 'chat' });

      // the raw log is a file of JSON lines, and the cookie is nowhere in it
      expect(result.file).toBe(path.join(outDir, `${result.callId}.jsonl`));
      const text = fs.readFileSync(result.file!, 'utf8');
      expect(text).not.toContain('secret-cookie-value-xyz');
      const call1 = parseRawLog(text, 'file');
      expect(call1.header).toMatchObject({ k: 'call', v: 1, chain: 'T', path: 'api/voice', mode: 'chat', set: 'latency', run: 1, attempt: 1, scenarios: 3, frameMs: 40 });
      expect(Date.parse(call1.header.wall)).toBeGreaterThan(Date.now() - 60_000);
      expect(call1.end).toMatchObject({ k: 'end', reason: 'done' });
      expect(call1.open!.t).toBeGreaterThan(0);
      expect(call1.start!.t).toBeGreaterThanOrEqual(call1.open!.t);
      expect(call1.mic!.t).toBeGreaterThan(call1.start!.t);
      expect(call1.greet).toMatchObject({ settled: true });
      const ready = call1.events.find((e) => e.type === 'ready')!;
      expect(call1.greet!.audioAt).toBeGreaterThanOrEqual(ready.t); // the greeting came after ready
      expect(call1.greet!.listeningAt).toBeGreaterThan(call1.greet!.audioAt!);
      expect(ready.sessionId).toBe('abcdefgh'); // eight characters, never the whole id
      expect(call1.scenarios.map((s) => s.id)).toEqual(['l01', 'l02', 'e-p01']);
      expect(call1.scenarios.every((s) => s.wait === 'answered' && s.settled)).toBe(true);
      expect(call1.scenarios[1].begin).toBeGreaterThanOrEqual(call1.scenarios[0].end); // the next scenario begins after the window of the one before

      // the client's pacing is in the log: frame i was due at mic + i * 40
      const times = call1.frames.flatMap((f) => f.t.map((t, j) => ({ i: f.i + j, t })));
      expect(times.length).toBeGreaterThan(50);
      const late = times.map(({ i, t }) => t - (call1.mic!.t + i * 40)).sort((a, b) => a - b);
      expect(late[0]).toBeGreaterThanOrEqual(-1e-6);                         // (never early; the difference of two large floats can come out at -1e-13)
      expect(late[Math.floor((late.length - 1) * 0.9)]).toBeLessThan(60); // (other calls run beside this one in this file; client.test.ts holds the tight bound)

      // UE is the send time of the frame that carries the last speech sample, and every mark agrees with the frame times
      const at = (frame: number) => times.find((x) => x.i === frame)!.t;
      const l01 = call1.scenarios[0];
      const plan = scenarios[0];
      const lastSample = plan.built.speech[0].endSample - 1;
      expect(l01.ueFrame).toBe(l01.firstFrame + Math.floor(lastSample / 640));
      expect(l01.ueSentAt).toBe(at(l01.ueFrame));
      expect(l01.begin).toBe(at(l01.firstFrame));
      expect(l01.ueMs).toBe(plan.built.speech[0].endMs);
      expect(l01.segments[0].beginSentAt).toBe(at(l01.segments[0].beginFrame));
      expect(l01.segments[0].endSentAt).toBe(l01.ueSentAt);
      expect(l01.voice).toBe('Voice A');
      expect(call1.scenarios[1].voice).toBe('Voice B'); // the voices alternate by position
      // the two segments of the pause scenario, their pause between them
      const pause = call1.scenarios[2];
      expect(pause.segments).toHaveLength(2);
      expect(pause.segments[1].beginSentAt! - pause.segments[0].endSentAt!).toBeGreaterThan(700);
      expect(pause.segments[1].beginSentAt! - pause.segments[0].endSentAt!).toBeLessThan(900);

      // what the analysis reads from that log: the end-of-turn wait is the server's 3 silent frames, the latency adds its thinking time
      const facts = callFacts(call1);
      const [plain, tool, cut] = facts.trials;
      expect(plain.eotMs!).toBeGreaterThan(0); // about 120 ms (3 silent frames) on a quiet machine; a stalled client sends overdue frames in a burst, so only the order is exact
      expect(plain.eotMs!).toBeLessThan(450);
      expect(plain.latencyMs!).toBeGreaterThan(plain.eotMs! + 200); // the script thinks 280 ms after it commits
      expect(plain.latencyMs!).toBeLessThan(plain.eotMs! + 700);
      expect(plain.latencyMs!).toBeGreaterThan(250); // and so, on a quiet machine, it does not answer before UE + 300 ms
      expect([plain.tool, plain.cutIn, plain.split]).toEqual([false, false, false]);
      expect(tool.tool).toBe(true); // `working` came between UE and the first agent audio
      expect(tool.latencyMs!).toBeGreaterThan(plain.latencyMs! + 30); // the script adds 100 ms of look-up
      expect(cut.cutIn).toBe(true); // the script answered at the pause
      expect(cut.split).toBe(true); // and committed twice: two user lines
      expect(cut.userTranscripts).toBe(2);
      expect(cut.committed).toBe(true);
      expect(cut.eotMs!).toBeGreaterThan(0);
      // the hub's agent_interrupted at every speech onset is explained by the scripted speech: no false barge-in
      expect(facts.falseBarges).toEqual([]);
      expect(facts.started).toBe(true);
      expect(facts.readyMs!).toBeGreaterThan(20);
      expect(facts.greetingMs!).toBeGreaterThan(facts.readyMs! - 5);
      expect(facts.readyMode).toBe('conversational');
      // and the report takes the file as it is
      expect(analyzeLogs([call1], [call1]).criteria[1].checks.find((c) => c.id === 'C1.plain.p50')!.nA).toBe(1); // the latency prompts: l01 is plain, l02 a tool turn
    });
  }, 15_000);

  it('plays a barge-in scenario: the question, the interruption over the answer, and the answer to the interruption', async () => {
    await withServer({ answerMs: (turn) => (turn === 1 ? 1000 : 120) }, async (server) => {
      const result = await call(server, plans('bargein'), { set: 'bargein' });
      expect(result.played).toBe(1);
      expect(result.reason).toBe('done');
      const line = scn(result, 'b1');
      expect(line.class).toBe('bargein');
      const bi = line.interruption!;
      expect(bi.skipped).toBeUndefined();
      expect(bi.wait).toBe('answered');
      expect(bi.audibleAtPlan).toBe(true);
      // placed afterFirstAudioMs after the first frame of the answer, as a frame boundary of the one stream
      const call1 = parsed(result);
      const firstAnswerFrame = call1.audio.find((a) => a.t >= line.ueSentAt!)!;
      expect(bi.anchorAt).toBe(firstAnswerFrame.t);
      expect(bi.scheduledAt!).toBeCloseTo(firstAnswerFrame.t + 200, 0);
      expect(bi.firstSentAt!).toBeGreaterThanOrEqual(bi.scheduledAt! - 1);
      expect(bi.firstSentAt!).toBeLessThan(bi.scheduledAt! + 200); // the next frame due, plus what a busy machine adds
      // the onset is the frame that carries the first speech sample: one frame (the 40 ms margin) after the clip's first frame
      expect(bi.onsetFrame).toBe(bi.firstFrame! + 1);
      expect(bi.endFrame).toBe(bi.firstFrame! + 2); // two frames of speech: frames 1 and 2 of the clip
      // (one frame apart: 40 ms on a quiet machine; a machine that stalls the process sends the overdue frames back to back, so only the order is exact)
      expect(bi.endSentAt! - bi.onsetSentAt!).toBeGreaterThanOrEqual(0);
      expect(bi.endSentAt! - bi.onsetSentAt!).toBeLessThan(120);
      expect(bi.onsetSentAt! - bi.firstSentAt!).toBeGreaterThanOrEqual(0);
      expect(bi.onsetSentAt! - bi.firstSentAt!).toBeLessThan(120);
      // the analysis: the script interrupts 40 ms after it hears the speech
      const facts = callFacts(call1);
      expect(facts.barges[0].invalid).toBeNull();
      expect(facts.barges[0].onset).toBe(bi.onsetSentAt);
      expect(facts.barges[0].interruptedMs!).toBeGreaterThan(30);
      expect(facts.barges[0].interruptedMs!).toBeLessThan(400);
      expect(facts.barges[0].audioStopMs!).toBeLessThan(250);
      expect(facts.falseBarges).toEqual([]);
      expect(facts.trials[0].committed).toBe(true);
    });
  }, 12_000);

  it('counts the delay of an interruption from the answer, not from a filler that ended while the look-up ran', async () => {
    const later: TestSet = { ...MINI, bargein: { ...MINI.bargein, afterFirstAudioMs: 270 } };
    // the question starts a look-up: "one sec" (80 ms) at +180 ms after the end of speech, then nothing audible until the answer at about +800 ms
    await withServer({ tool: (turn) => turn === 1, fillerMs: 80, toolMs: 400, answerMs: (turn) => (turn === 1 ? 1000 : 120) }, async (server) => {
      const result = await call(server, plans('bargein', later), { set: 'bargein' });
      const line = scn(result, 'b1');
      const bi = line.interruption!;
      expect(bi.skipped).toBeUndefined();
      const call1 = parsed(result);
      const frames = call1.audio.filter((a) => a.t >= line.ueSentAt!);
      const filler = frames[0];
      const answerFirst = frames.find((a) => a.t - filler.t > 300)!;
      // +270 ms after the filler's first frame falls in the silence between the filler and the answer: the agent is not audible there, so the runner starts again from the answer
      expect(answerFirst.t - filler.t).toBeGreaterThan(500);
      expect(bi.anchorAt).toBe(answerFirst.t);
      expect(bi.scheduledAt!).toBeCloseTo(answerFirst.t + 270, 0);
      expect(bi.audibleAtPlan).toBe(true);
      // and it is a real barge-in over the answer, measured as one
      const facts = callFacts(call1);
      expect(facts.trials[0].tool).toBe(true);
      expect(facts.barges[0].invalid).toBeNull();
      expect(facts.barges[0].interruptedMs!).toBeGreaterThan(30);
      expect(facts.barges[0].interruptedMs!).toBeLessThan(400);
      expect(facts.falseBarges).toEqual([]);
    });
  }, 12_000);

  it('skips the interruption when the agent never speaks after the question, and says why', async () => {
    await withServer({ answerMs: () => 0 }, async (server) => {
      // an answer with no audio at all
      const result = await call(server, plans('bargein'), { set: 'bargein', timing: { answerCapMs: 300 } });
      const bi = scn(result, 'b1').interruption!;
      expect(bi.skipped).toBe('no-answer-audio');
      expect(bi.onsetSentAt).toBeNull();
      expect(callFacts(parsed(result)).barges[0].invalid).toBe('skipped');
    });
  }, 8000);
});

// ---------------------------------------------------------------- calls that go wrong

describe.concurrent('runCall: calls that go wrong', () => {
  it('records a start the hub answered with busy, and says so (the CLI waits and tries again)', async () => {
    await withServer({ onStart: 'busy' }, async (server) => {
      const r = await call(server, plans('latency'));
      expect(r.started).toBe(false);
      expect(r.busy).toBe(true);
      expect(r.socketError).toBe(false);
      expect(r.reason).toBe('start-failed');
      expect(r.played).toBe(0);
      expect(endLine(r).error).toMatchObject({ code: 'busy' });
      expect(parsed(r).start).not.toBeNull(); // the start was sent
      expect(r.lines.some((l) => l.k === 'scn')).toBe(false);
    });
  });

  it('records a refused upgrade as a socket-level failure (the CLI repeats the call once) and a call that is never ready as a failed start', async () => {
    const refuser = http.createServer();
    refuser.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
    await new Promise<void>((resolve) => refuser.listen(0, '127.0.0.1', () => resolve()));
    try {
      const r = await call({ url: `ws://127.0.0.1:${(refuser.address() as AddressInfo).port}` }, plans('latency'));
      expect(r.started).toBe(false);
      expect(r.socketError).toBe(true);
      expect(r.reason).toBe('start-failed');
      expect(endLine(r).error).toMatchObject({ code: 'http-403' });
      expect(JSON.stringify(r.lines)).not.toContain('secret-cookie-value-xyz');
      expect(r.lines.some((l) => l.k === 'open')).toBe(false);
    } finally {
      await new Promise<void>((resolve) => refuser.close(() => resolve()));
    }
    await withServer({ onStart: 'silent' }, async (mute) => {
      const m = await call(mute, plans('latency'), { timing: { readyTimeoutMs: 200 } });
      expect(m.started).toBe(false);
      expect(m.socketError).toBe(false); // no ready, but the socket is fine: a failed start the criteria count
      expect(endLine(m).error).toMatchObject({ code: 'ready-timeout' });
    });
  });

  it('treats a socket that goes away before ready, with no word from the server, as a connection failure', async () => {
    await withServer({ onStart: 'drop' }, async (server) => {
      const r = await call(server, plans('latency'));
      expect(r.started).toBe(false);
      expect(r.socketError).toBe(true);
      expect(endLine(r).error).toMatchObject({ code: 'closed-before-ready' });
    });
  });

  it('when the server ends the call under a scenario (budget), marks that scenario and the rest incomplete, and it is not a socket failure', async () => {
    await withServer({ endAfter: { commits: 1, how: 'closed' } }, async (server) => {
      const r = await call(server, plans('latency'));
      expect(r.started).toBe(true);
      expect(r.reason).toBe('closed');
      expect(r.socketError).toBe(false);
      expect(r.played).toBe(1); // l01 begun and cut off
      expect(scn(r, 'l01').wait).toBe('closed');
      expect(endLine(r).closedReason).toBe('budget');
      expect(endLine(r).skipped).toEqual(['l02']);
      // the analysis leaves the cut scenario out and says so
      const facts = callFacts(parsed(r));
      expect(facts.trials.map((t) => t.incomplete)).toEqual([true]);
      expect(analyzeLogs([], [parsed(r)]).warnings.join(' ')).toMatch(/1 scenario\(s\) were cut off by the server/);
    });
  }, 8000);

  it('when the socket drops mid-call with no closed event, ends with a socket error (the CLI repeats it once)', async () => {
    await withServer({ endAfter: { commits: 1, how: 'drop' } }, async (server) => {
      const r = await call(server, plans('latency'));
      expect(r.reason).toBe('socket-error');
      expect(r.socketError).toBe(true);
      expect(scn(r, 'l01').wait).toBe('closed');
      expect(endLine(r).skipped).toEqual(['l02']);
    });
  }, 8000);

  it('does not begin a scenario that the session or the day has no time left for, and hangs up cleanly', async () => {
    await withServer({ maxSeconds: 2 }, async (server) => {
      // a scenario needs its stream plus 12 s
      const r = await call(server, plans('latency'));
      expect(r.started).toBe(true);
      expect(r.played).toBe(0);
      expect(r.reason).toBe('time-limit');
      expect(endLine(r).skipped).toEqual(['l01', 'l02']);
      expect(parsed(r).events.some((e) => e.type === 'closed')).toBe(true); // it hung up with end and the server said closed
    });
  });

  it('never rejects: a failure of its own is in the log', async () => {
    const r = await runCall({ chain: 'T', path: 'api/voice', mode: 'chat', set: 'latency', scenarios: [], target: {}, origin: 'https://x', cookie: 'c', timing: FAST });
    expect(r.started).toBe(false);
    expect(r.reason).toBe('error');
    expect(endLine(r).error).toMatchObject({ code: 'client' });
  });
});

// ---------------------------------------------------------------- the `tool` class and a route with a query

describe('runCall: scenarios of the `tool` class (the `tools` set) and a route with a query', () => {
  it('gives a `tool` scenario its own, longer cap for the answer: a look-up that outlasts the usual cap is answered, and the same delay on a latency scenario is a timeout', async () => {
    await withServer({ tool: () => true, toolMs: 1300 }, async (server) => {
      const timing = { answerCapMs: 700, toolAnswerCapMs: 5000 };
      const tool = await call(server, plans('tools', MINI_TOOLS).slice(0, 1), { set: 'tools', timing });
      const line = scn(tool, 'x01');
      expect(line).toMatchObject({ class: 'tool', set: 'tools', wait: 'answered', settled: true });
      expect(line.end - line.ueSentAt!).toBeGreaterThan(1500); // it waited for the look-up: the answer began about 1.7 s after the end of speech
      const facts = callFacts(parsed(tool)).trials[0];
      expect([facts.class, facts.tool, facts.answered, facts.incomplete]).toEqual(['tool', true, true, false]);
      expect(facts.latencyMs!).toBeGreaterThan(1200);
      // the same delay on a latency scenario is cut at the usual cap
      const plain = await call(server, plans('latency').slice(0, 1), { timing });
      expect(scn(plain, 'l01').wait).toBe('timeout');
    });
  }, 15_000);

  it('honours the cap it is given: a look-up that outlasts `toolAnswerCapMs` is a timeout, and the scenario is not held for it any longer', async () => {
    await withServer({ tool: () => true, toolMs: 3000 }, async (server) => {
      const r = await call(server, plans('tools', MINI_TOOLS).slice(0, 1), { set: 'tools', timing: { toolAnswerCapMs: 1000, quietCapMs: 600 } });
      const line = scn(r, 'x01');
      expect(line.wait).toBe('timeout');
      expect(line.settled).toBe(false);
      expect(line.end - line.ueSentAt!).toBeLessThan(2800); // about 1 s of cap and 0.6 s of quiet wait, not the 3.4 s the answer takes
    });
  }, 12_000);

  it('holds a `tool` scenario open through a look-up that goes on after a spoken line and `listening`, longer than the usual quiet wait: the next scenario must not play over its answer', async () => {
    // a line is said and the status goes to `listening`, `working` follows 100 ms later, and the answer comes 2.3 s after the commit: the first `listening` is not the end of the turn
    await withServer({ tool: () => true, leadIn: { atMs: 100, ms: 80, workingAfterMs: 100 }, toolMs: 2000 }, async (server) => {
      const timing = { answerCapMs: 600, quietCapMs: 500, settleMs: 500, toolAnswerCapMs: 6000 };
      const r = await call(server, plans('tools', MINI_TOOLS).slice(0, 1), { set: 'tools', timing });
      const line = scn(r, 'x01');
      expect(line.wait).toBe('answered'); // the spoken line and the `listening` after it
      expect(line.settled).toBe(true); // and quiet only after the real answer
      expect(line.end - line.ueSentAt!).toBeGreaterThan(2500);
      const audio = parsed(r).audio;
      const last = audio[audio.length - 1];
      expect(last.t).toBeLessThan(line.end); // the answer is inside the scenario's window
      expect(last.t - line.ueSentAt!).toBeGreaterThan(2000);
      // the same turn on a latency scenario is cut at the usual caps (answered at the first `listening`, quiet wait of 0.5 s): the contrast
      const plain = await call(server, plans('latency').slice(0, 1), { timing });
      expect(scn(plain, 'l01').settled).toBe(false);
    });
  }, 20_000);

  it('reserves the look-up\'s own cap of the call\'s time before it begins a `tool` scenario, where any other scenario needs 12 s', async () => {
    await withServer({ maxSeconds: 30 }, async (server) => {
      const tools = plans('tools', MINI_TOOLS).slice(0, 1);
      const long = await call(server, tools, { set: 'tools', timing: { toolAnswerCapMs: 40_000 } });
      expect(long.started).toBe(true);
      expect(long.played).toBe(0);
      expect(long.reason).toBe('time-limit');
      expect(endLine(long).skipped).toEqual(['x01']);
      const short = await call(server, tools, { set: 'tools', timing: { toolAnswerCapMs: 5000 } });
      expect(short.played).toBe(1);
      expect(short.reason).toBe('done');
      const plain = await call(server, plans('latency').slice(0, 1), { timing: { toolAnswerCapMs: 40_000 } });
      expect(plain.played).toBe(1); // 12 s of the 30, whatever the cap of the tool class
    });
  }, 15_000);

  it('keeps the query of a route all the way: the server sees /api/voice-lab?chain=h, and the log header records the whole route and the caps in force', async () => {
    await withServer({}, async (server) => {
      const r = await call(server, plans('latency').slice(0, 1), { path: 'api/voice-lab?chain=h', timing: { toolAnswerCapMs: 4321 } });
      expect(r.reason).toBe('done');
      expect(server.paths).toEqual(['/api/voice-lab?chain=h']);
      const header = parsed(r).header;
      expect(header.path).toBe('api/voice-lab?chain=h');
      expect(header.timing).toMatchObject({ toolAnswerCapMs: 4321, answerCapMs: 2500 });
    });
  }, 10_000);
});

// ---------------------------------------------------------------- helpers

describe('the pieces of a call', () => {
  it('gives class `tool` its own answer cap (90 s by default, in the timing object beside the others, overridable like them) and every other class the usual one', () => {
    expect(DEFAULT_TIMING.toolAnswerCapMs).toBe(90_000);
    expect(DEFAULT_TIMING.answerCapMs).toBe(25_000);
    expect(answerCapFor('tool', DEFAULT_TIMING)).toBe(90_000);
    for (const cls of ['latency', 'pause', 'short', 'filler', 'bargein'] as const) expect(answerCapFor(cls, DEFAULT_TIMING)).toBe(25_000);
    expect(answerCapFor('tool', { ...DEFAULT_TIMING, toolAnswerCapMs: 5 })).toBe(5);
    expect(answerCapFor('latency', { ...DEFAULT_TIMING, toolAnswerCapMs: 5 })).toBe(25_000);
  });

  it('has answered when an agent frame came at or after a moment and a status listening came after that frame', () => {
    const client = {
      audio: [{ t: 50, seq: 3, bytes: 1920 }],
      events: [{ t: 10, seq: 1, ev: { type: 'status', state: 'listening' } }],
    } as unknown as CallClient;
    expect(answeredAfter(client, 20)).toBe(false); // a frame, but only a listening from before it (the student's own onset)
    (client.events as Array<{ t: number; seq: number; ev: Record<string, unknown> }>).push({ t: 70, seq: 4, ev: { type: 'status', state: 'speaking' } });
    expect(answeredAfter(client, 20)).toBe(false); // still speaking
    (client.events as Array<{ t: number; seq: number; ev: Record<string, unknown> }>).push({ t: 90, seq: 5, ev: { type: 'status', state: 'listening' } });
    expect(answeredAfter(client, 20)).toBe(true);
    expect(answeredAfter(client, 50)).toBe(true); // a frame exactly at the moment counts
    expect(answeredAfter(client, 51)).toBe(false); // no frame at or after it
  });

  it('builds the URL of a portal socket or of a base address, with the route and no doubled slash', () => {
    expect(callUrl({ socket: '/run/portal.sock' }, 'api/voice')).toBe('ws+unix:/run/portal.sock:/api/voice');
    expect(callUrl({ socket: '/run/portal.sock' }, '/api/voice-lab')).toBe('ws+unix:/run/portal.sock:/api/voice-lab');
    expect(callUrl({ url: 'ws://127.0.0.1:3000' }, 'api/voice')).toBe('ws://127.0.0.1:3000/api/voice');
    expect(callUrl({ url: 'ws://host/tai/' }, '/api/voice-lab')).toBe('ws://host/tai/api/voice-lab');
    // the query of a lab chain stays on the route, for a portal socket and for a base address alike
    expect(callUrl({ socket: '/run/portal.sock' }, 'api/voice-lab?chain=h')).toBe('ws+unix:/run/portal.sock:/api/voice-lab?chain=h');
    expect(callUrl({ socket: '/run/portal.sock' }, '/api/voice-lab?chain=fd')).toBe('ws+unix:/run/portal.sock:/api/voice-lab?chain=fd');
    expect(callUrl({ url: 'ws://127.0.0.1:3000/' }, 'api/voice-lab?chain=c')).toBe('ws://127.0.0.1:3000/api/voice-lab?chain=c');
    expect(callUrl({ url: 'ws://host/tai' }, '/api/voice?chain=d')).toBe('ws://host/tai/api/voice?chain=d');
    // and the socket library reads such an address the way the portal's socket needs: the socket path before the colon, the route and its query after it
    const parsedUrl = new URL(callUrl({ socket: '/run/portal.sock' }, 'api/voice-lab?chain=h'));
    expect((parsedUrl.pathname + parsedUrl.search).split(':')).toEqual(['/run/portal.sock', '/api/voice-lab?chain=h']);
    expect(() => callUrl({}, 'api/voice')).toThrow(/no target/);
  });

  it('names a call by chain, set, run, attempt and time, with nothing that is not safe in a file name', () => {
    expect(makeCallId('L', 'latency', 2, 1, '2026-11-13T21:05:07.123Z')).toBe('L-latency-r2-a1-20261113T210507123Z');
    expect(makeCallId('a/b c', 'x:y', 1, 2, '2026-11-13T21:05:07.123Z')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('keeps only what the analysis needs of a server message, cuts texts, and shows eight characters of the session id', () => {
    const e = (ev: Record<string, unknown>) => eventLine({ t: 12.3456, seq: 0, ev });
    expect(e({ type: 'ready', sessionId: 'abcdefgh12345678', mode: 'interviewer', voice: 'v', maxSeconds: 600, resumed: false, extra: 1 })).toEqual({ k: 'e', t: 12.35, type: 'ready', sessionId: 'abcdefgh', mode: 'interviewer', voice: 'v', maxSeconds: 600, resumed: false });
    expect(e({ type: 'status', state: 'working', other: 1 })).toEqual({ k: 'e', t: 12.35, type: 'status', state: 'working' });
    const t = e({ type: 'transcript', role: 'user', text: 'x'.repeat(500), mode: 'conversational' });
    expect(String(t.text)).toHaveLength(300);
    expect(e({ type: 'timer', elapsedSec: 5 })).toEqual({ k: 'e', t: 12.35, type: 'timer' });
    expect(e({ type: 'closed', reason: 'user', summary: 'long text' })).toEqual({ k: 'e', t: 12.35, type: 'closed', reason: 'user' });
    expect(e({ type: 'error', code: 'busy', message: 'm'.repeat(300) }).message).toHaveLength(200);
  });
});
