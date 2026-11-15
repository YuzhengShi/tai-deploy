/**
 * The voice lab through the whole hub (docs/VOICE_SELFBUILT.md): with TAI_VOICE_LAB unset nothing of it exists (C11); with it set, the owner can place a call on the stand-in and nobody
 * else can, the stand-in answers only the token the hub gave the session, and a lab call is the ordinary session on another chain: the relay, the functions, the mode switches.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { PassThrough } from 'stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { functionsFor, type FunctionDef } from '../functions.js';
import { streamed } from '../testing/fake-gateway.js';
import { BrowserClient, TEST_KEY, createHarness, type Harness } from '../testing/harness.js';
import { VOICE_ENV_KEYS } from '../config.js';
import { LAB_ENV_KEYS, loadLabConfig } from './config.js';
import { createLabHarness, type LabHarness } from './testing/lab-harness.js';

// Real-time tests with short numbers: on a busy machine every wait takes several times longer, so the limits are generous (they cost nothing when the test passes).
vi.setConfig({ testTimeout: 30_000 });

let lab: LabHarness | null = null;
let live: Harness | null = null;
afterEach(async () => {
  await lab?.close();
  await live?.close();
  lab = null;
  live = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
};

/** A student's speech and then quiet, in real time, over the browser's socket. */
async function speak(b: BrowserClient, ms: number, amp: number): Promise<void> {
  const frames = Math.round(ms / 40);
  const start = performance.now();
  for (let f = 0; f < frames; f++) {
    const buf = Buffer.alloc(1280);
    for (let i = 0; i < 640; i++) buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * (f * 640 + i)) / 16000)), i * 2);
    b.sendAudio(buf);
    const wait = start + (f + 1) * 40 - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

const toolCall = (name: string, args: Record<string, unknown> = {}, id = 'call_x') => ({
  sse: [
    JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ],
});

/** The call is on: ready, the greeting spoken, and a little silence for the VAD to learn from. */
async function placeCall(h: LabHarness, start: Record<string, unknown> = { type: 'start', mode: 'chat' }, path?: string): Promise<BrowserClient> {
  const b = await h.browser(h.owner(), path);
  b.send(start);
  await b.next('ready');
  await until(() => h.ears.length > 0 && h.ears[0].connected);
  await b.next('status', (e) => e.state === 'listening');
  await sleep(700);                                                                  // the greeting
  await speak(b, 560, 0);
  return b;
}

describe('with TAI_VOICE_LAB unset nothing of the lab exists (C11)', () => {
  it('has no stand-in, refuses /api/voice-lab with 404, and a live call is what it was', async () => {
    live = await createHarness();
    const hub = live.hub as unknown as { lab: unknown; labEngine: unknown };
    expect(hub.lab).toBeNull();
    expect(hub.labEngine).toBeNull();
    const socket = new PassThrough();
    const written: string[] = [];
    socket.on('data', (c) => written.push(String(c)));
    live.hub.upgradeLab!({ headers: { origin: live.origin } } as http.IncomingMessage, socket, Buffer.alloc(0), { ...live.user(1), role: 'owner' }, new URLSearchParams());
    await sleep(20);
    expect(written.join('')).toContain('404');
    const b = await live.browser(live.user(1));
    b.send({ type: 'start', mode: 'chat' });
    const conn = await live.dg.connection(1);
    await b.next('ready');
    expect(conn.headers.authorization).toBe(`Token ${TEST_KEY}`);                    // the real Deepgram, with the real key
    b.close();
  });

  it('reads no lab setting from the files and builds a disabled configuration from an empty environment', () => {
    expect(loadLabConfig(() => undefined).enabled).toBe(false);
    expect(loadLabConfig((k) => (k === 'TAI_VOICE_LAB' ? '0' : undefined)).enabled).toBe(false);
    expect(loadLabConfig((k) => (k === 'TAI_VOICE_LAB' ? 'yes' : undefined)).enabled).toBe(false);          // only "1"
    for (const k of LAB_ENV_KEYS) expect(VOICE_ENV_KEYS).not.toContain(k);
  });

  it('a lab setting without the relay is no lab', async () => {
    lab = await createLabHarness({ lab: false, env: { TAI_VOICE_LAB: '1', TAI_VOICE_THINK: 'deepgram' } });
    expect((lab.hub as unknown as { lab: unknown }).lab).toBeNull();
    expect(lab.logs.some((l) => l.level === 'warn' && /needs TAI_VOICE_THINK=relay/.test(l.msg))).toBe(true);
  });
});

describe('who may use the lab (C11)', () => {
  it('the owner may, a student may not, a page of another origin may not', async () => {
    lab = await createLabHarness();
    expect(lab.engine()).not.toBeNull();
    const student = await lab.browser(lab.student(), '/api/voice-lab').catch((e) => e);
    expect((student as { status?: number }).status).toBe(403);
    const origin = await lab.browser(lab.owner(), '/api/voice-lab', { Origin: 'https://evil.example' }).catch((e) => e);
    expect((origin as { status?: number }).status).toBe(403);
    const ok = await lab.browser(lab.owner());
    ok.close();
  });

  it('the stand-in answers only the token the hub gave the session: not the Deepgram key, not nothing', async () => {
    lab = await createLabHarness();
    const url = lab.engine()!.agentUrl;
    for (const auth of [`Token ${TEST_KEY}`, 'Token nope', '']) {
      const closed = await new Promise<number>((resolve) => {
        const ws = new WebSocket(url, auth ? { headers: { authorization: auth } } : undefined);
        ws.on('close', (code) => resolve(code));
        ws.on('error', () => undefined);
      });
      expect(closed).toBe(1008);
    }
    // and it listens on loopback only
    expect(new URL(url).hostname).toBe('127.0.0.1');
    expect(new URL(lab.engine()!.relayUrl).hostname).toBe('127.0.0.1');
  });
});

describe('a call on the lab', () => {
  it('is the ordinary session: ready, the greeting, a turn answered through the real relay, the transcript, the status and the audio', async () => {
    lab = await createLabHarness();
    lab.gw.respond = () => streamed('A mutex is a lock. It guards shared data.');
    const b = await placeCall(lab);
    expect(b.ofType('ready')[0]).toMatchObject({ mode: 'conversational' });
    expect(b.ofType('transcript').some((e) => e.role === 'agent')).toBe(true);        // the greeting
    expect(lab.gw.requests).toHaveLength(0);                                            // spoken without the model
    await speak(b, 400, 6000);
    await speak(b, 160, 0);
    lab.ears[0].partial('What is a mutex?');
    await b.next('transcript', (e) => e.role === 'user' && e.text === 'What is a mutex?');
    await b.next('transcript', (e) => e.role === 'agent' && e.text === 'It guards shared data.');
    expect(lab.gw.requests).toHaveLength(1);
    const body = lab.gw.requests[0].body as { model: string; stream: boolean; messages: Array<{ role: string; content: string }>; tools: unknown[] };
    expect(body.model).toBe('gpt-oss');                                                 // the relay's rewrite: the model is the deployment's, not the Settings'
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[body.messages.length - 1]).toMatchObject({ role: 'user', content: 'What is a mutex?' });
    expect(body.tools.length).toBeGreaterThan(10);
    expect(lab.gw.requests[0].headers.authorization).toBe('Bearer sk-gateway-secret-key-xyz');
    await b.next('status', (e) => e.state === 'speaking');
    await until(() => lab!.logs.some((l) => /voice turn latency/.test(l.msg)));       // the stand-in's LatencyReport, in the journal's own line
    const line = lab.logs.find((l) => /voice turn latency/.test(l.msg))!;
    expect(line.obj.total as number).toBeGreaterThan(0);
    expect(line.obj.total as number).toBeLessThan(2500);
    // the Deepgram key never reached the stand-in's world: the session was given the engine's token, and the logs hold neither
    expect(JSON.stringify(lab.logs)).not.toContain(TEST_KEY);
    expect(JSON.stringify(lab.logs)).not.toContain(lab.engine()!.token);
    b.send({ type: 'end' });
    await b.next('closed');
    // the sink appends asynchronously: the file exists a moment before its first line is in it (a busy machine showed it), so wait for a whole line
    const traceFile = path.join(lab.dataDir, 'voice-lab', 'turns.jsonl');
    await until(() => fs.existsSync(traceFile) && fs.readFileSync(traceFile, 'utf8').endsWith('\n'));
    const rows = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn: 1, mode: 'chat', ears: 'labgpu', mouth: 'labgpu', userText: 'What is a mutex?' });
    expect(rows[0].derived.total).toBeGreaterThan(0);
  });

  it('one call per student across the live path and the lab', async () => {
    lab = await createLabHarness();
    const owner = lab.owner();
    const a = await lab.browser(owner);
    a.send({ type: 'start', mode: 'chat' });
    await a.next('ready');
    const b = await lab.browser(owner, '/api/voice');
    b.send({ type: 'start', mode: 'chat' });
    const err = await b.next('error');
    expect(err.code).toBe('busy');
    a.close();
  });

  it('a lab call falls back to the other recognizer, and a call with none is refused', async () => {
    lab = await createLabHarness({ earsFail: new Set(['labgpu']) });
    const b = await lab.browser(lab.owner());
    b.send({ type: 'start', mode: 'chat' });
    await b.next('ready');
    expect(lab.ears.map((e) => e.name)).toEqual(['labgpu', 'flux']);
    await b.next('notice', (e) => /reported a problem/.test(String(e.text)));      // the page's notice of the switch
    b.close();
    await lab.close();
    lab = await createLabHarness({ earsFail: new Set(['labgpu', 'flux']) });
    const c = await lab.browser(lab.owner());
    c.send({ type: 'start', mode: 'chat' });
    const e = await c.next('error');
    expect(e.code).toBe('deepgram');
  });
});

describe('functions and modes on the lab (C5, C10)', () => {
  const NAMES = (mode: 'conversational' | 'interviewer' | 'listener'): string[] => functionsFor(mode).map((f: FunctionDef) => f.name);
  const HANDOFF = new Set(['start_interview', 'end_interview', 'start_talk_through', 'end_talk_through', 'end_session']);

  /** Every function of a mode that is not a hand-over (those are tried below, as mode switches): the model calls it, the session runs it, its result reaches the next request, an answer is spoken. */
  async function roundTrips(mode: 'conversational' | 'interviewer' | 'listener', start: Record<string, unknown>, minimum: number): Promise<void> {
    const generic = { ok: true as const, text: '[]' };
    lab = await createLabHarness({
      mouthMs: 150,
      toolHandlers: { canvas_query: () => generic, github_query: () => generic, piazza_query: () => generic, query_knowledge: () => generic, start_mock_interview: () => ({ ok: true, text: 'Mock interview ready' }), browse_url: () => generic, read_file: () => generic, render_diagram: () => generic },
    });
    const names = NAMES(mode).filter((n) => !HANDOFF.has(n));
    expect(names.length).toBeGreaterThanOrEqual(minimum);
    let current = '';
    lab.gw.respond = (body) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const system = String(messages[0]?.content ?? '');
      if (system.includes('teaching evaluator') || system.includes('You write the note')) return { json: { choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] } };
      if (messages[messages.length - 1].role === 'tool') return streamed('Done.');
      return toolCall(current, {}, `call_${current}`);
    };
    const b = await placeCall(lab, start);
    const owner = lab.owner();
    const seen: string[] = [];
    for (const name of names) {
      current = name;
      const before = lab.gw.requests.filter((r) => !/teaching evaluator|You write the note/.test(String((r.body.messages as Array<{ content?: string }>)[0]?.content ?? ''))).length;
      expect(lab.hub.inject(owner.folder, `please use ${name}`)).toBe(true);
      await until(() => lab!.gw.requests.filter((r) => !/teaching evaluator|You write the note/.test(String((r.body.messages as Array<{ content?: string }>)[0]?.content ?? ''))).length >= before + 2, 8000);
      const turns = lab.gw.requests.filter((r) => !/teaching evaluator|You write the note/.test(String((r.body.messages as Array<{ content?: string }>)[0]?.content ?? '')));
      const second = turns[before + 1].body.messages as Array<{ role: string; tool_call_id?: string; content?: string }>;
      const tool = second[second.length - 1];
      expect(tool.role, `${mode}: ${name}`).toBe('tool');
      expect(tool.tool_call_id).toBe(`call_${name}`);
      expect(typeof tool.content).toBe('string');
      seen.push(name);
      await until(() => b.ofType('transcript').filter((x) => x.role === 'agent' && x.text === 'Done.').length >= seen.length, 8000);
      await until(() => b.ofType('status').slice(-1)[0]?.state === 'listening', 8000);
    }
    expect(seen).toEqual(names);
    b.close();
  }

  it('every function of the conversation round-trips (C5)', async () => {
    await roundTrips('conversational', { type: 'start', mode: 'chat' }, 19);
  }, 120_000);

  it('every function of the interviewer round-trips (C5)', async () => {
    await roundTrips('interviewer', { type: 'start', mode: 'interview' }, 5);
  }, 120_000);

  it('every function of the talk-it-through round-trips (C5)', async () => {
    await roundTrips('listener', { type: 'start', mode: 'talk' }, 3);
  }, 120_000);

  it('the model starts an interview: the mode switch completes (UpdateThink, UpdateSpeak, UpdateListen are acknowledged), the interviewer speaks, and the hold-off follows the mode', async () => {
    lab = await createLabHarness({
      mouthMs: 200,
      toolHandlers: {
        canvas_query: () => ({ ok: true, text: JSON.stringify([{ id: 3527597, name: 'HW3 Concurrency', due_at: '2026-11-04T17:00:00Z' }]) }),
        github_query: () => ({ ok: true, text: '[]' }),
        start_mock_interview: () => ({ ok: true, text: 'Mock interview ready for Yuzheng: HW3 Concurrency' }),
      },
    });
    let calls = 0;
    lab.gw.respond = (body) => {
      const messages = body.messages as Array<{ role: string; content?: string }>;
      const sys = String(messages[0]?.content ?? '');
      if (sys.includes('teaching evaluator') || sys.includes('You write the note')) return { json: { choices: [{ index: 0, message: { role: 'assistant', content: 'Ok.' }, finish_reason: 'stop' }] } };
      if (messages[messages.length - 1].role === 'user' && calls++ === 0) return toolCall('start_interview', { topic: 'HW3 concurrency' }, 'call_iv');
      return streamed('Okay.');
    };
    const b = await placeCall(lab);
    await speak(b, 400, 6000);
    await speak(b, 160, 0);
    lab.ears[0].partial('Homework three, the concurrency one, I want a mock interview.');
    await b.next('mode', (e) => e.mode === 'interviewer');
    await until(() => lab!.ears[0].turnFields.some((f) => f.eotThreshold === 0.88 && f.eotTimeoutMs === 8000));
    expect(b.ofType('error').filter((e) => e.code !== undefined)).toHaveLength(0);
    // the interviewer's opener is spoken by the stand-in
    await b.next('transcript', (e) => e.role === 'agent' && /interview|ready|question|HW3/i.test(String(e.text)), 5000);
    // and the voice for the interviewer is the interviewer's (LabGPU's has one English voice: the stand-in asks for it all the same)
    expect(lab.mouths.labgpu.requests.length).toBeGreaterThan(1);
    b.close();
  }, 30_000);

  it('a call that starts as a talk-it-through takes the patient turn fields from the first Settings', async () => {
    lab = await createLabHarness({ mouthMs: 150 });
    const b = await lab.browser(lab.owner());
    b.send({ type: 'start', mode: 'talk', topic: 'goroutines' });
    await b.next('ready');
    expect(b.ofType('ready')[0]).toMatchObject({ mode: 'listener' });
    await b.next('status', (e) => e.state === 'listening');
    // the stand-in learned the profile from the Settings' fields (0.9 / 10000): a text that looks finished is held for the talk's 2 s
    await sleep(500);
    await speak(b, 560, 0);
    await speak(b, 400, 6000);
    await speak(b, 160, 0);
    lab.ears[0].partial('A goroutine is a lightweight thread.');
    await sleep(900);
    expect(lab.gw.requests).toHaveLength(0);                                          // 1 s of quiet: the talk-through is still listening
    b.close();
  }, 20_000);
});

describe('the chain of a call (A10)', () => {
  it('?chain= on the lab route picks the chain of the call; an unknown name is the process\'s own settings; a student gets nothing either way', async () => {
    const kinds: Array<[string, string[]]> = [
      ['h', ['labgpu', 'flux']],
      ['c', ['flux', 'labgpu']],
      ['fd', ['flux', 'labgpu']],
      ['cf', ['flux', 'labgpu']],
      ['lf', ['labgpu']],
      ['d', ['labgpu', 'flux']],
      ['nonsense', ['labgpu']],
    ];
    for (const [chain, expected] of kinds) {
      lab = await createLabHarness();
      const b = await lab.browser(lab.owner(), `/api/voice-lab?chain=${chain}`);
      b.send({ type: 'start', mode: 'chat' });
      await b.next('ready');
      await until(() => lab!.ears.length >= expected.length);
      expect(lab.ears.map((e) => e.name), chain).toEqual(expected);
      b.close();
      await lab.close();
      lab = null;
    }
    lab = await createLabHarness();
    const student = await lab.browser(lab.student(), '/api/voice-lab?chain=h').catch((e) => e);
    expect((student as { status?: number }).status).toBe(403);
  });

  it('the stand-in\'s address for a chain is its own address with the chain, and the token still decides who may connect', async () => {
    lab = await createLabHarness();
    const engine = lab.engine()!;
    expect(engine.agentUrlFor('h')).toBe(`${engine.agentUrl}?chain=h`);
    expect(engine.agentUrlFor('fd')).toBe(`${engine.agentUrl}?chain=fd`);
    for (const x of [undefined, null, '', 'x', 'H']) expect(engine.agentUrlFor(x)).toBe(engine.agentUrl);
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(engine.agentUrlFor('h'), { headers: { authorization: `Token ${TEST_KEY}` } });
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => undefined);
    });
    expect(closed).toBe(1008);
  });

  it('chain h through the whole hub: the eager text asks the real relay before the turn is confirmed, and the page hears the student and the answer only after', async () => {
    lab = await createLabHarness();
    lab.gw.respond = () => streamed('A mutex is a lock.');
    const b = await placeCall(lab, { type: 'start', mode: 'chat' }, '/api/voice-lab?chain=h');
    await until(() => lab!.ears.length === 2 && lab!.ears[1].connected);
    expect(lab.ears.map((e) => e.name)).toEqual(['labgpu', 'flux']);
    await speak(b, 400, 6000);
    await speak(b, 100, 0);
    const heard = b.ofType('transcript').length;
    lab.ears[1].eager('What is a mutex?');
    await until(() => lab!.gw.requests.length === 1);
    const asked = lab.gw.requests[0].body as { messages: Array<{ role: string; content: string }> };
    expect(asked.messages[asked.messages.length - 1]).toMatchObject({ role: 'user', content: 'What is a mutex?' });
    await speak(b, 400, 0);
    expect(b.ofType('transcript').length).toBe(heard);                                 // nothing of the held answer, and no student line yet
    lab.ears[0].partial('What is a mutex?');
    await b.next('transcript', (e) => e.role === 'user' && e.text === 'What is a mutex?');
    await b.next('transcript', (e) => e.role === 'agent' && e.text === 'A mutex is a lock.');
    expect(lab.gw.requests).toHaveLength(1);                                           // asked once
    b.send({ type: 'end' });
    await b.next('closed');
    const traceFile = path.join(lab.dataDir, 'voice-lab', 'turns.jsonl');
    await until(() => fs.existsSync(traceFile) && fs.readFileSync(traceFile, 'utf8').endsWith('\n'));
    const rows = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ turn: 1, chain: 'h', ears: 'labgpu', userText: 'What is a mutex?' });
    expect(rows[0].specs[0]).toMatchObject({ outcome: 'adopted', source: 'flux-shadow' });
    expect(rows[0].derived.headStart).toBeGreaterThan(300);
  });

  it('chain cf through the whole hub: Flux ears decide the turn, the answer is spoken through the Flux mouth and not through the others, and the trace says chain cf and mouth flux', async () => {
    lab = await createLabHarness();
    lab.gw.respond = () => streamed('A mutex is a lock. It protects shared data.');
    const b = await placeCall(lab, { type: 'start', mode: 'chat' }, '/api/voice-lab?chain=cf');
    await until(() => lab!.ears.length >= 1 && lab!.ears[0].connected);
    expect(lab.ears[0].name).toBe('flux');
    await speak(b, 400, 6000);
    await speak(b, 160, 0);
    lab.ears[0].final('What is a mutex?', { trigger: 'model', confidence: 0.9 });
    await b.next('transcript', (e) => e.role === 'agent' && e.text === 'A mutex is a lock.');
    await b.next('transcript', (e) => e.role === 'agent' && e.text === 'It protects shared data.');
    expect(lab.mouths.flux.requests.map((r) => r.text)).toEqual(expect.arrayContaining(['A mutex is a lock.', 'It protects shared data.']));
    expect(lab.mouths.flux.requests.every((r) => r.voice === 'flux-hannah-en')).toBe(true);
    expect(lab.mouths.labgpu.requests.filter((r) => /mutex|shared data/.test(r.text))).toEqual([]);
    expect(lab.mouths.aura.requests.filter((r) => /mutex|shared data/.test(r.text))).toEqual([]);
    b.send({ type: 'end' });
    await b.next('closed');
    const traceFile = path.join(lab.dataDir, 'voice-lab', 'turns.jsonl');
    await until(() => fs.existsSync(traceFile) && fs.readFileSync(traceFile, 'utf8').endsWith('\n'));
    const rows = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ turn: 1, chain: 'cf', ears: 'flux', mouth: 'flux', userText: 'What is a mutex?' });
  });
});
