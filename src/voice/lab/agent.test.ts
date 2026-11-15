/**
 * The stand-in agent, through its socket, with the ears and the mouth replaced by doubles and the relay by a small SSE server: the protocol the session speaks (Welcome, Settings,
 * events, audio), the turn rule, barge-in, function calls, injections, the fallbacks and the trace. Real time, short numbers.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { silentLog } from '../types.js';
import { LabAgent } from './agent.js';
import { forChain, loadLabConfig, type LabConfig } from './config.js';
import { PcmCache } from './mouth/cache.js';
import { FluxTtsMouth, wholeWords } from './mouth/flux.js';
import { nullSink, type TraceSink, type TurnTrace } from './trace.js';
import { FakeFluxTts, type FakeFluxTtsOptions } from './testing/fake-flux-tts.js';
import { FakeEars, FakeMouth, failingMouth } from './testing/fake-parts.js';
import type { Ears, EarsHandlers } from './types.js';

// These tests run in real time with short numbers; on a busy machine (the whole suite runs 24 files at once) every wait takes several times longer, so the limits are generous:
// they cost nothing when the test passes.
vi.setConfig({ testTimeout: 30_000 });

type Msg = Record<string, unknown>;
type Step = { text?: string; tool?: { name: string; args?: unknown }; delayMs?: number };

const TOKEN = 'Bearer v1.abcdefghijklmnop0123.9999999999999.' + 'a'.repeat(64);

interface Rig {
  agent: LabAgent;
  client: WebSocket;
  msgs: Array<{ at: number; m: Msg }>;
  audio: Array<{ at: number; bytes: number }>;
  relay: { requests: Array<{ messages: Array<Record<string, unknown>>; tools?: unknown[]; at: number; aborted: boolean }>; script: (n: number, body: { messages: Array<Record<string, unknown>> }) => Step[] };
  earsMade: FakeEars[];
  /** What the agent asked the factory for, in order: the kind, and the eager threshold it passed. */
  earsAsked: Array<{ kind: string; eagerEot?: number }>;
  mouths: Record<string, FakeMouth>;
  traces: TurnTrace[];
  relayUrl: string;
  send(m: Msg): void;
  of(type: string): Msg[];
  until(cond: () => boolean, ms?: number): Promise<void>;
  feed(ms: number, amp: number): Promise<void>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What DeepSeek and OpenAI answer 400 to: a message with calls not directly followed by a reply to each of them, or a reply with no call before it (the first lab call was lost to it). */
function sequenceProblem(messages: Array<Record<string, unknown>>): string | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const calls = (m.tool_calls as Array<{ id: string }> | undefined) ?? [];
    if (m.role === 'assistant' && calls.length) {
      const open = new Set(calls.map((c) => c.id));
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') open.delete(String(messages[j++].tool_call_id));
      if (open.size) return `message ${i} has calls with no reply directly after it`;
      i = j - 1;
    } else if (m.role === 'tool') return `message ${i} is a reply with no call before it`;
  }
  return null;
}

function sse(steps: Step[], res: http.ServerResponse): void {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  let toolIndex = 0;
  const next = (): void => {
    if (res.destroyed) return;
    const step = steps[i++];
    if (!step) {
      res.write(chunk({}, steps.some((s) => s.tool) ? 'tool_calls' : 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    const emit = () => {
      if (step.text !== undefined) res.write(chunk({ content: step.text }));
      if (step.tool) {
        res.write(chunk({ tool_calls: [{ index: toolIndex++, id: `call_${toolIndex}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args ?? {}) } }] }));
      }
      next();
    };
    if (step.delayMs) setTimeout(emit, step.delayMs);
    else emit();
  };
  next();
}

async function rig(opts: { env?: Record<string, string>; chain?: string; ears?: (kind: string, h: EarsHandlers) => Ears | null; mouths?: Record<string, FakeMouth>; profiles?: boolean; haveKey?: boolean; sink?: TraceSink } = {}): Promise<Rig> {
  const relay = { requests: [] as Rig['relay']['requests'], script: ((): Step[] => [{ text: 'Okay.' }]) as Rig['relay']['script'] };
  const relayServer = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()) as { messages: Array<Record<string, unknown>>; tools?: unknown[] };
      const entry = { ...body, at: performance.now(), aborted: false };
      relay.requests.push(entry);
      res.on('close', () => {
        if (!res.writableFinished) entry.aborted = true;
      });
      const problem = sequenceProblem(body.messages);
      if (problem) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id' (${problem})` } }));
        return;
      }
      let steps: Step[];
      try {
        steps = relay.script(relay.requests.length, body);
      } catch {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"the language model is unavailable"}}');
        return;
      }
      sse(steps, res);
    });
  });
  await new Promise<void>((r) => relayServer.listen(0, '127.0.0.1', () => r()));
  const relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}/voice-llm/v1/chat/completions`;

  const env: Record<string, string> = {
    TAI_VOICE_LAB: '1',
    TAI_VOICE_LAB_COVER_MS: '100',
    TAI_VOICE_LAB_BARGE_MS: '120',
    TAI_VOICE_LAB_LEAD_MS: '200',
    TAI_VOICE_LAB_HOLD_CHAT: '0,700',
    TAI_VOICE_LAB_TEMPO: '0',
    TAI_VOICE_LAB_SHADOW_EARS: 'none',
    ...(opts.env ?? {}),
  };
  const config: LabConfig = forChain(loadLabConfig((k) => env[k]), opts.chain);
  config.earsConnectTimeoutMs = 300;
  config.silentEarsMs = 600;
  config.silentEarsVoicedMs = 450;

  const earsMade: FakeEars[] = [];
  const earsAsked: Rig['earsAsked'] = [];
  const mouths: Record<string, FakeMouth> = opts.mouths ?? { labgpu: new FakeMouth({ name: 'labgpu', ms: 500 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) };
  const traces: TurnTrace[] = [];

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const serverSide = new Promise<WebSocket>((r) => wss.once('connection', (ws) => r(ws)));
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  const msgs: Rig['msgs'] = [];
  const audio: Rig['audio'] = [];
  const t0 = performance.now();
  client.on('message', (data, isBinary) => {
    const at = performance.now() - t0;
    if (isBinary) audio.push({ at, bytes: (data as Buffer).length });
    else msgs.push({ at, m: JSON.parse(data.toString()) });
  });
  await new Promise<void>((r) => client.once('open', () => r()));
  const ws = await serverSide;

  const agent = new LabAgent({
    ws,
    config,
    clock: () => performance.now(),
    log: process.env.LAB_DEBUG ? { ...silentLog, warn: (o, m) => console.log('WARN', m, JSON.stringify(o)), info: (o, m) => console.log('INFO', m, JSON.stringify(o)) } : silentLog,
    relayUrl,
    profiles: { chat: { eotThreshold: 0.75, eotTimeoutMs: 5000 }, interview: { eotThreshold: 0.88, eotTimeoutMs: 8000 }, talk: { eotThreshold: 0.9, eotTimeoutMs: 10000 } },
    makeEars: (kind, handlers, ctx) => {
      earsAsked.push({ kind, eagerEot: ctx.eagerEot });
      const custom = opts.ears?.(kind, handlers);
      if (custom) return custom;
      const e = new FakeEars(kind, kind === 'flux', handlers, () => performance.now());
      earsMade.push(e);
      return e;
    },
    makeMouth: (kind) => mouths[kind],
    haveDeepgramKey: () => opts.haveKey ?? true,
    cache: new PcmCache(),
    trace: opts.sink ?? { write: (t) => void traces.push(t) },
  });

  const r: Rig = {
    agent,
    client,
    msgs,
    audio,
    relay,
    earsMade,
    earsAsked,
    mouths,
    traces,
    relayUrl,
    send: (m) => client.send(JSON.stringify(m)),
    of: (type) => msgs.filter((x) => x.m.type === type).map((x) => x.m),
    until: async (cond, ms = 8000) => {
      const end = performance.now() + ms;
      while (!cond()) {
        if (performance.now() > end) throw new Error(`condition not met in ${ms} ms; got ${msgs.map((x) => x.m.type).join(',')}; errors ${JSON.stringify(msgs.filter((x) => x.m.type === 'Error' || x.m.type === 'Warning').map((x) => x.m))}`);
        await sleep(10);
      }
    },
    feed: async (ms, amp) => {
      const frames = Math.round(ms / 40);
      const start = performance.now();
      for (let f = 0; f < frames; f++) {
        const b = Buffer.alloc(1280);
        for (let i = 0; i < 640; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * (f * 640 + i)) / 16000)), i * 2);
        if (client.readyState === WebSocket.OPEN) client.send(b, { binary: true });
        const wait = start + (f + 1) * 40 - performance.now();
        if (wait > 0) await sleep(wait);
      }
    },
    close: async () => {
      agent.close();
      try {
        client.terminate();
      } catch {
        /* gone */
      }
      await new Promise<void>((r2) => wss.close(() => r2()));
      (relayServer as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r2) => relayServer.close(() => r2()));
    },
  };
  cleanups.push(r.close);
  return r;
}

function settings(r: Rig, over: { think?: Record<string, unknown>; greeting?: string | null; context?: unknown[]; listen?: Record<string, unknown>; speak?: Record<string, unknown>; endpoint?: string } = {}): Msg {
  return {
    type: 'Settings',
    audio: { input: { encoding: 'linear16', sample_rate: 16000 }, output: { encoding: 'linear16', sample_rate: 24000, container: 'none' } },
    agent: {
      listen: { provider: { type: 'deepgram', model: 'flux-general-en', version: 'v2', eot_threshold: 0.75, eot_timeout_ms: 5000, keyterms: ['Raft', 'Paxos'], ...(over.listen ?? {}) } },
      think: {
        provider: { type: 'open_ai', model: 'qwen', temperature: 0.7 },
        endpoint: { url: over.endpoint ?? r.relayUrl, headers: { authorization: TOKEN } },
        prompt: 'You are TAi.',
        functions: [{ name: 'recall_memory', description: 'Look in memory.', parameters: { type: 'object', properties: {} } }],
        ...(over.think ?? {}),
      },
      speak: { provider: { type: 'deepgram', version: 'v2', model: 'flux-hannah-en', speed: 1.2, ...(over.speak ?? {}) } },
      ...(over.greeting === null ? {} : { greeting: over.greeting ?? 'Hi, I am TAi.' }),
      ...(over.context ? { context: { messages: over.context } } : {}),
    },
  };
}

/** Starts the call and waits until the greeting has been spoken and the VAD has had silence to learn from. */
async function started(r: Rig, over: Parameters<typeof settings>[1] = {}): Promise<void> {
  r.send(settings(r, over));
  await r.until(() => r.of('SettingsApplied').length > 0);
  if (over.greeting !== null) await r.until(() => r.of('AgentAudioDone').length > 0);
  await r.feed(560, 0);
}

/** A student turn: speech, then quiet, with the recognizer's text arriving once the quiet has lasted `after` ms. */
async function say(r: Rig, text: string, opts: { speechMs?: number; after?: number } = {}): Promise<void> {
  await r.feed(opts.speechMs ?? 400, 6000);
  await r.feed(opts.after ?? 160, 0);
  r.earsMade[0].partial(text);
}

describe('LabAgent: the protocol', () => {
  it('says Welcome, applies the Settings, speaks the greeting without the model, and keeps it in the history', async () => {
    const r = await rig();
    await r.until(() => r.of('Welcome').length > 0);
    expect(typeof r.of('Welcome')[0].request_id).toBe('string');
    r.send(settings(r, { context: [{ type: 'History', function_calls: [{ id: 'ctx_competency', name: 'read_competency', client_side: true, arguments: '{}', response: 'Docker 0.4' }] }] }));
    await r.until(() => r.of('AgentAudioDone').length > 0);
    const order = r.msgs.map((x) => x.m.type).filter((t) => ['Welcome', 'SettingsApplied', 'ConversationText', 'AgentAudioDone'].includes(t as string));
    expect(order).toEqual(['Welcome', 'SettingsApplied', 'ConversationText', 'AgentAudioDone']);
    expect(r.of('ConversationText')[0]).toMatchObject({ role: 'assistant', content: 'Hi, I am TAi.' });
    expect(r.of('AgentStartedSpeaking')).toHaveLength(0);                       // the live service never sends it
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBeGreaterThan(20_000);
    expect(r.relay.requests).toHaveLength(0);                                    // no model for the greeting
    expect(r.mouths.labgpu.requests[0].voice).toBe('af_bella');
    // and the history reaches the model with the next turn
    r.relay.script = () => [{ text: 'A mutex is a lock.' }];
    await r.feed(560, 0);
    await say(r, 'What is a mutex?');
    await r.until(() => r.relay.requests.length === 1);
    expect(r.relay.requests[0].messages.map((m) => m.role)).toEqual(['system', 'assistant', 'tool', 'assistant', 'user']);
    expect(r.relay.requests[0].messages[0].content).toBe('You are TAi.');
    expect(r.relay.requests[0].messages[3]).toMatchObject({ role: 'assistant', content: 'Hi, I am TAi.' });
    expect(r.relay.requests[0].tools).toHaveLength(1);
  });

  it('refuses a Settings whose think endpoint is not the relay of this host', async () => {
    const r = await rig();
    r.send(settings(r, { endpoint: 'http://169.254.169.254/latest/meta-data' }));
    await r.until(() => r.of('Error').length > 0);
    expect(r.of('Error')[0]).toMatchObject({ code: 'INVALID_SETTINGS' });
    expect(r.of('SettingsApplied')).toHaveLength(0);
  });

  it('refuses audio formats it does not take', async () => {
    const r = await rig();
    const s = settings(r) as { audio: { output: { sample_rate: number } } };
    s.audio.output.sample_rate = 48000;
    r.send(s);
    await r.until(() => r.of('Error').length > 0);
    expect(r.of('Error')[0]).toMatchObject({ code: 'INVALID_SETTINGS' });
  });

  it('acknowledges the updates and applies them: UpdatePrompt is a system note, UpdateThink replaces the prompt, UpdateSpeak the voice', async () => {
    const r = await rig();
    await started(r);
    r.send({ type: 'UpdatePrompt', prompt: 'Be brief.' });
    r.send({ type: 'UpdateThink', think: { provider: { type: 'open_ai', model: 'qwen' }, endpoint: { url: r.relayUrl, headers: { authorization: TOKEN } }, prompt: 'You are the interviewer.', functions: [] } });
    r.send({ type: 'UpdateSpeak', speak: { provider: { type: 'deepgram', model: 'aura-2-mars-en', speed: 1.08 } } });
    r.send({ type: 'UpdateListen', listen: { provider: { type: 'deepgram', version: 'v2', model: 'flux-general-en', eot_threshold: 0.88, eot_timeout_ms: 8000 } } });
    await r.until(() => ['PromptUpdated', 'ThinkUpdated', 'SpeakUpdated', 'ListenUpdated'].every((t) => r.of(t).length === 1));
    r.relay.script = () => [{ text: 'Tell me about Raft.' }];
    await say(r, 'Hello.');
    await r.until(() => r.relay.requests.length === 1);
    const m = r.relay.requests[0].messages;
    expect(m[0]).toMatchObject({ role: 'system', content: 'You are the interviewer.' });
    expect(m.some((x) => x.role === 'system' && x.content === 'Be brief.')).toBe(true);
    expect(r.relay.requests[0].tools).toBeUndefined();
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.mouths.labgpu.requests[r.mouths.labgpu.requests.length - 1].text).toBe('Tell me about Raft.');
    expect(r.earsMade[0].turnFields).toEqual([{ eotThreshold: 0.88, eotTimeoutMs: 8000 }]);
  });
});

describe('LabAgent: a turn', () => {
  it('hears the student begin, commits the turn on the first text that covers the speech, answers by sentences and reports the latency', async () => {
    const r = await rig();
    await started(r);
    r.relay.script = () => [{ text: 'A mutex is a lock. ' }, { delayMs: 40, text: 'It protects shared data.' }];
    const before = r.msgs.length;
    await r.feed(400, 6000);
    expect(r.msgs.slice(before).some((x) => x.m.type === 'UserStartedSpeaking')).toBe(true);
    await r.feed(160, 0);
    r.earsMade[0].partial('What is a mutex?');
    await r.until(() => r.of('ConversationText').some((m) => m.role === 'user'));
    const order = r.msgs.slice(before).map((x) => x.m.type);
    expect(order.indexOf('ConversationText')).toBeGreaterThan(order.indexOf('UserStartedSpeaking'));
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.of('ConversationText').filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Hi, I am TAi.', 'A mutex is a lock.', 'It protects shared data.']);
    expect(r.of('AgentThinking')).toHaveLength(1);
    const lat = r.of('LatencyReport');
    expect(lat).toHaveLength(1);
    expect(lat[0].total_latency as number).toBeGreaterThan(0);
    expect(lat[0].total_latency as number).toBeLessThan(1.5);
    expect(lat[0].ttt_text_latency).toBeDefined();
    expect(r.traces).toHaveLength(1);
    expect(r.traces[0]).toMatchObject({ turn: 1, mode: 'chat', userText: 'What is a mutex?', sid: 'abcdef' });
    expect(r.traces[0].derived.total).toBeGreaterThan(0);
    expect(r.traces[0].firstSentence).toBeDefined();
    // the answer is in the history of the next turn
    r.relay.script = () => [{ text: 'Sure.' }];
    await r.feed(300, 0);
    await say(r, 'And a semaphore?');
    await r.until(() => r.relay.requests.length === 2);
    expect(r.relay.requests[1].messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'system:You are TAi.',
      'assistant:Hi, I am TAi.',
      'user:What is a mutex?',
      'assistant:A mutex is a lock. It protects shared data.',
      'user:And a semaphore?',
    ]);
  });

  it('holds a turn that ends in a dangling word and merges the continuation into one question', async () => {
    const r = await rig();
    await started(r);
    r.relay.script = () => [{ text: 'Yes, the leader does.' }];
    await say(r, 'The leader sends heartbeats to.');
    await sleep(350);
    expect(r.relay.requests).toHaveLength(0);                                  // 0.5 s in: the hold is 0.7 s
    await r.feed(400, 6000);                                                    // the student goes on
    await r.feed(160, 0);
    r.earsMade[0].partial('The leader sends heartbeats to all the followers?');
    await r.until(() => r.relay.requests.length === 1);
    expect(r.relay.requests[0].messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['The leader sends heartbeats to all the followers?']);
  });

  it('never answers a lone filler', async () => {
    const r = await rig();
    await started(r);
    await say(r, 'Um.');
    await sleep(900);
    expect(r.relay.requests).toHaveLength(0);
    expect(r.of('ConversationText').filter((m) => m.role === 'user')).toHaveLength(0);
  });

  it('a student who goes on before the answer has begun gets one answer to the whole of it', async () => {
    const r = await rig();
    await started(r);
    r.relay.script = (n) => (n === 1 ? [{ delayMs: 1500, text: 'First answer that must not be spoken.' }] : [{ text: 'Both parts answered.' }]);
    await say(r, 'Tell me about Raft.');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(400, 6000);                                                    // goes on while the model is thinking
    await r.feed(160, 0);
    r.earsMade[0].partial('And about Paxos too?');
    await r.until(() => r.relay.requests.length === 2);
    expect(r.relay.requests[1].messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['Tell me about Raft. And about Paxos too?']);
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.of('ConversationText').filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Hi, I am TAi.', 'Both parts answered.']);
  });

  it('with ears that decide the turn (Flux) the turn is committed at their final, and their start of turn is the onset', async () => {
    const r = await rig({ env: { TAI_VOICE_LAB_EARS: 'flux', TAI_VOICE_LAB_EARS_FALLBACK: 'none' } });
    await started(r);
    r.relay.script = () => [{ text: 'Sure.' }];
    const ears = r.earsMade[0];
    expect(ears.name).toBe('flux');
    ears.startOfTurn('what');
    await r.until(() => r.of('UserStartedSpeaking').length === 1);
    ears.final('What is a mutex?', { trigger: 'model', confidence: 0.9 });
    await r.until(() => r.relay.requests.length === 1);
    expect(r.relay.requests[0].messages[r.relay.requests[0].messages.length - 1]).toEqual({ role: 'user', content: 'What is a mutex?' });
  });
});

describe('LabAgent: barge-in', () => {
  async function longAnswer(r: Rig): Promise<void> {
    r.relay.script = (n) => (n === 1 ? [{ text: 'Raft elects a leader first. ' }, { text: 'Then the leader sends heartbeats to everyone. ' }, { text: 'That keeps the followers calm.' }] : [{ text: 'Okay, stopping.' }]);
    await say(r, 'Explain Raft.');
    await r.until(() => r.audio.length > 0 && r.of('ConversationText').filter((m) => m.role === 'assistant').length >= 2);
  }

  it('stops the audio, tells the session, aborts the model and keeps only what was spoken', async () => {
    const r = await rig({ mouths: { labgpu: new FakeMouth({ name: 'labgpu', ms: 1400 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) } });
    await started(r, { greeting: null });
    await longAnswer(r);
    const interrupted = r.of('UserStartedSpeaking').length;
    const bytesBefore = r.audio.reduce((a, x) => a + x.bytes, 0);
    await r.feed(360, 7000);                                                    // the student talks over it
    await r.until(() => r.of('UserStartedSpeaking').length > interrupted);
    const at = performance.now();
    await sleep(500);
    const bytesAfter = r.audio.reduce((a, x) => a + x.bytes, 0);
    expect(bytesAfter - bytesBefore).toBeLessThan(200 * 48 * 3);                // at most a lead's worth after the cut, and nothing a second later
    const settled = r.audio.reduce((a, x) => a + x.bytes, 0);
    await sleep(300);
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBe(settled);
    expect(r.of('AgentAudioDone')).toHaveLength(0);
    void at;
    await r.feed(160, 0);
    r.earsMade[0].partial('Wait, stop.');
    await r.until(() => r.relay.requests.length === 2);
    const assistant = r.relay.requests[1].messages.filter((m) => m.role === 'assistant').map((m) => String(m.content));
    expect(assistant).toHaveLength(1);
    expect(assistant[0].startsWith('Raft elects a leader first.')).toBe(true);        // the sentence that played out stays whole
    expect(assistant[0]).not.toContain('everyone');                                    // the one that was playing is cut, and the one after it never began
    expect(assistant[0]).not.toContain('calm');
    const trace = r.traces.find((t) => t.bargeIn);
    expect(trace?.bargeIn?.by).toBe('vad');
    expect(trace?.bargeIn?.spoken.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('a cough is not a barge-in', async () => {
    const r = await rig({ mouths: { labgpu: new FakeMouth({ name: 'labgpu', ms: 1500 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) } });
    await started(r, { greeting: null });
    await longAnswer(r);
    const n = r.of('UserStartedSpeaking').length;
    await r.feed(80, 7000);                                                     // 80 ms: shorter than the 120 ms of the test setting
    await r.feed(400, 0);
    expect(r.of('UserStartedSpeaking').length).toBe(n);
  });

  it('with Flux ears a start of turn while the agent speaks is the barge-in', async () => {
    const r = await rig({ env: { TAI_VOICE_LAB_EARS: 'flux', TAI_VOICE_LAB_EARS_FALLBACK: 'none' }, mouths: { labgpu: new FakeMouth({ name: 'labgpu', ms: 3000 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) } });
    await started(r, { greeting: null });
    r.relay.script = () => [{ text: 'A long answer that goes on for a while.' }];
    r.earsMade[0].final('Explain Raft.');
    await r.until(() => r.audio.length > 0);
    const n = r.of('UserStartedSpeaking').length;
    r.earsMade[0].startOfTurn('wait');
    await r.until(() => r.of('UserStartedSpeaking').length === n + 1);
    const settled = r.audio.reduce((a, x) => a + x.bytes, 0);
    await sleep(300);
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBe(settled);
  });
});

describe('LabAgent: functions', () => {
  it('carries a call to the session and its result to the next request; the words before the call stay with it', async () => {
    const r = await rig();
    await started(r);
    r.relay.script = (n) => (n === 1 ? [{ text: 'Let me check. ' }, { tool: { name: 'recall_memory', args: { query: 'raft' } } }] : [{ text: 'You asked about Raft before.' }]);
    await say(r, 'What did I ask before?');
    await r.until(() => r.of('FunctionCallRequest').length === 1);
    const call = (r.of('FunctionCallRequest')[0].functions as Array<Record<string, unknown>>)[0];
    expect(call).toMatchObject({ name: 'recall_memory', client_side: true, arguments: '{"query":"raft"}' });
    const answeredAt = performance.now();
    r.send({ type: 'FunctionCallResponse', id: call.id, name: 'recall_memory', content: '{"found":"Raft"}' });
    await r.until(() => r.relay.requests.length === 2);
    const secondRequestAt = r.relay.requests[1].at;                              // when the request arrived at the relay, not when the poll noticed it
    const m = r.relay.requests[1].messages;
    expect(m[m.length - 2]).toMatchObject({ role: 'assistant', content: 'Let me check.', tool_calls: [{ id: call.id, function: { name: 'recall_memory' } }] });
    expect(m[m.length - 1]).toEqual({ role: 'tool', tool_call_id: call.id, content: '{"found":"Raft"}' });
    // C5: the engine's part of the round trip, from FunctionCallResponse to the next request. Idle it is a few milliseconds; this bound only guards against a gross
    // regression and does not flake when the machine is busy (the full suite runs 24 files at once). The criterion's 100 ms is read from the trace of the host runs
    // (the next `thinkSent` minus the function's `answeredAt`), where nothing else is running (amendment A3).
    expect(secondRequestAt - answeredAt).toBeLessThan(300);
    await r.until(() => r.of('AgentAudioDone').length === 2);
    const lat = r.of('LatencyReport');
    expect(lat).toHaveLength(1);                                                // one report, at the first audio of the answer ("Let me check." is the first sentence)
    expect(r.traces[0].functions[0].name).toBe('recall_memory');
    expect(r.traces[0].functions[0].answeredAt).toBeGreaterThan(r.traces[0].functions[0].startedAt);
    // the trace holds every request of the turn, and the engine's own part of the round trip (C5, amendment A3: this is what the host runs read)
    const rounds = r.traces[0].rounds;
    expect(rounds).toHaveLength(2);
    expect(rounds[0].thinkSent).toBe(r.traces[0].thinkSent);
    expect(rounds[0].firstToken).toBeGreaterThanOrEqual(rounds[0].thinkSent);
    expect(rounds[0].afterAnswerMs).toBeUndefined();
    expect(rounds[1].firstToken).toBeGreaterThanOrEqual(rounds[1].thinkSent);
    expect(rounds[1].afterAnswerMs).toBeGreaterThanOrEqual(0);
    expect(rounds[1].afterAnswerMs).toBeLessThan(300);
    expect(rounds[1].thinkSent - r.traces[0].functions[0].answeredAt!).toBeCloseTo(rounds[1].afterAnswerMs!, 5);
  });

  it('cancels a call that is still pending when the student talks over the agent, and takes it out of the history', async () => {
    const r = await rig({ mouths: { labgpu: new FakeMouth({ name: 'labgpu', ms: 2500 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) } });
    await started(r, { greeting: null });
    r.relay.script = (n) => (n === 1 ? [{ text: 'Let me check that for you now. ' }, { tool: { name: 'recall_memory' } }] : [{ text: 'Okay.' }]);
    await say(r, 'What did I ask before?');
    await r.until(() => r.of('FunctionCallRequest').length === 1);
    await r.until(() => r.audio.length > 0);
    await r.feed(360, 7000);                                                    // talks over "let me check" while the function runs
    await r.until(() => r.of('FunctionCallCancelled').length === 1);
    expect((r.of('FunctionCallCancelled')[0].functions as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'recall_memory' });
    await r.feed(160, 0);
    r.earsMade[0].partial('Never mind.');
    await r.until(() => r.relay.requests.length === 2, 10_000);                 // (a busy machine takes several times longer than the half second this normally needs)
    expect(r.relay.requests[1].messages.some((m) => m.role === 'tool' || (m.tool_calls as unknown[] | undefined)?.length)).toBe(false);
  }, 20_000);

  it('a filler said while a function runs does not come between the call and its reply: the next request is a valid conversation, and the filler is among the words of the call', async () => {
    const r = await rig();
    await started(r);
    r.relay.script = (n) => (n === 1 ? [{ text: 'Let me check. ' }, { tool: { name: 'recall_memory' } }] : [{ text: 'You asked about Raft.' }]);
    await say(r, 'What did I ask before?');
    await r.until(() => r.of('FunctionCallRequest').length === 1);
    await r.until(() => r.of('AgentAudioDone').length === 2);                  // "Let me check." has been played out: the session may inject its filler now
    r.send({ type: 'InjectAgentMessage', message: 'one sec.', behavior: 'queue' });
    await r.until(() => r.of('ConversationText').some((m) => m.content === 'one sec.'));
    await r.until(() => r.of('AgentAudioDone').length === 3);
    const call = (r.of('FunctionCallRequest')[0].functions as Array<Record<string, unknown>>)[0];
    r.send({ type: 'FunctionCallResponse', id: call.id, name: 'recall_memory', content: '{"found":"Raft"}' });
    await r.until(() => r.relay.requests.length === 2);
    await r.until(() => r.of('ConversationText').some((m) => m.content === 'You asked about Raft.'));
    expect(r.of('Error')).toEqual([]);
    const m = r.relay.requests[1].messages;
    expect(m[m.length - 2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: call.id }] });
    expect(m[m.length - 2].content).toContain('Let me check.');
    expect(m[m.length - 2].content).toContain('one sec.');
    expect(m[m.length - 1]).toMatchObject({ role: 'tool', tool_call_id: call.id });
  });

  it('a student who talks over the filler while a function runs: the call is cancelled and the next request is a valid conversation', async () => {
    const r = await rig({ mouths: { labgpu: new FakeMouth({ name: 'labgpu', ms: 2500 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) } });
    await started(r, { greeting: null });
    r.relay.script = (n) => (n === 1 ? [{ text: 'Let me check that for you now. ' }, { tool: { name: 'recall_memory' } }] : [{ text: 'Okay.' }]);
    await say(r, 'What did I ask before?');
    await r.until(() => r.of('FunctionCallRequest').length === 1);
    await r.until(() => r.of('AgentAudioDone').length === 1, 12_000);          // the sentence before the call has been played out
    r.send({ type: 'InjectAgentMessage', message: 'one sec.', behavior: 'queue' });
    await r.until(() => r.of('ConversationText').some((m) => m.content === 'one sec.'));
    await r.feed(360, 7000);                                                    // talks over the filler while the function still runs
    await r.until(() => r.of('FunctionCallCancelled').length === 1);
    await r.feed(160, 0);
    r.earsMade[0].partial('Never mind.');
    await r.until(() => r.relay.requests.length === 2, 10_000);
    await r.until(() => r.of('ConversationText').some((m) => m.content === 'Okay.'), 10_000);
    expect(r.of('Error')).toEqual([]);
    expect(r.relay.requests[1].messages.some((m) => m.role === 'tool' || (m.tool_calls as unknown[] | undefined)?.length)).toBe(false);
  }, 30_000);

  it('answers a function that never answers with an error after its time, so that the turn goes on', async () => {
    // the real wait is 150 s: the agent's timer is not shortened here; this checks only that an abort ends the wait at once
    const r = await rig();
    await started(r);
    r.relay.script = (n) => (n === 1 ? [{ tool: { name: 'recall_memory' } }] : [{ text: 'Done.' }]);
    await say(r, 'Check my memory.');
    await r.until(() => r.of('FunctionCallRequest').length === 1);
    await r.feed(360, 7000);                                                    // a new turn begins: the pending call is dropped
    await r.feed(160, 0);
    r.earsMade[0].partial('Never mind that.');
    await r.until(() => r.relay.requests.length === 2, 10_000);
    expect(r.of('FunctionCallCancelled')).toHaveLength(1);
  }, 20_000);
});

describe('LabAgent: what the session injects', () => {
  it('speaks an injected line when idle, in the same voice, and puts it in the history', async () => {
    const r = await rig();
    await started(r);
    const n = r.audio.length;
    r.send({ type: 'InjectAgentMessage', message: 'one sec.', behavior: 'queue' });
    await r.until(() => r.of('ConversationText').some((m) => m.content === 'one sec.'));
    await r.until(() => r.audio.length > n);
    await r.until(() => r.of('AgentAudioDone').length === 2);                  // the filler has been played out: speaking over it would be a barge-in, which cuts it
    expect(r.of('InjectionRefused')).toHaveLength(0);
    r.relay.script = () => [{ text: 'Done.' }];
    await r.feed(300, 0);
    await say(r, 'Hello again.');
    await r.until(() => r.relay.requests.length === 1);
    expect(r.relay.requests[0].messages.some((m) => m.role === 'assistant' && String(m.content).includes('one sec.'))).toBe(true);
  });

  it('refuses it while the agent is speaking and while the student is', async () => {
    const r = await rig({ mouths: { labgpu: new FakeMouth({ name: 'labgpu', ms: 1200 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) } });
    await started(r);                                                           // the greeting is 1.2 s here: started() waits it out
    r.relay.script = () => [{ text: 'A long answer is on its way to you.' }];
    await say(r, 'Hi there.');
    await r.until(() => r.audio.length > 0 && r.of('ConversationText').filter((m) => m.role === 'assistant').length >= 2);
    r.send({ type: 'InjectAgentMessage', message: 'still looking.', behavior: 'queue' });
    await r.until(() => r.of('InjectionRefused').length === 1);
    await r.until(() => r.of('AgentAudioDone').length === 2, 6000);
    const feeding = r.feed(300, 6000);
    await sleep(150);
    r.send({ type: 'InjectAgentMessage', message: 'one sec.', behavior: 'queue' });
    await r.until(() => r.of('InjectionRefused').length === 2);
    await feeding;
  }, 60_000);

  it('takes a typed line as a student turn and answers it; refuses one while a turn is on', async () => {
    const r = await rig();
    await started(r);
    r.relay.script = () => [{ text: 'The typed answer.' }];
    r.send({ type: 'InjectUserMessage', content: '[Typed in the chat during the call]\nwhat is a mutex?' });
    await r.until(() => r.of('ConversationText').some((m) => m.role === 'assistant' && m.content === 'The typed answer.'));
    expect(r.of('ConversationText').find((m) => m.role === 'user')?.content).toContain('what is a mutex?');
    expect(r.of('InjectionRefused')).toHaveLength(0);
    r.relay.script = () => [{ delayMs: 800, text: 'Slow.' }];
    r.send({ type: 'InjectUserMessage', content: 'second' });
    await sleep(60);
    r.send({ type: 'InjectUserMessage', content: 'third, while the second is being answered' });
    await r.until(() => r.of('InjectionRefused').length === 1);
  });
});

describe('LabAgent: when something is missing', () => {
  it('uses the fallback recognizer when the first is not reachable, and says so once the call is live', async () => {
    let made = 0;
    const r = await rig({
      ears: (kind, handlers) => {
        const e = new FakeEars(kind, kind === 'flux', handlers, () => performance.now());
        if (kind === 'labgpu') e.connectError = new Error('connect failed');
        made++;
        return e;
      },
    });
    r.send(settings(r));
    await r.until(() => r.of('SettingsApplied').length === 1);
    expect(made).toBe(2);
    await r.until(() => r.of('Error').length === 1);
    expect(r.of('Error')[0]).toMatchObject({ code: 'LAB_EARS_FALLBACK' });
    expect(r.msgs.findIndex((x) => x.m.type === 'SettingsApplied')).toBeLessThan(r.msgs.findIndex((x) => x.m.type === 'Error'));
  });

  it('refuses the Settings with FAILED_TO_START_LISTENING when no recognizer can be reached', async () => {
    const r = await rig({
      ears: (kind, handlers) => {
        const e = new FakeEars(kind, kind === 'flux', handlers, () => performance.now());
        e.connectError = new Error('connect failed');
        return e;
      },
    });
    r.send(settings(r));
    await r.until(() => r.of('Error').length > 0);
    expect(r.of('Error')[0]).toMatchObject({ code: 'FAILED_TO_START_LISTENING' });
    expect(r.of('SettingsApplied')).toHaveLength(0);
  });

  it('no Deepgram key: the fallback is not tried and the LabGPU recognizer alone is used', async () => {
    const r = await rig({ haveKey: false });
    r.send(settings(r));
    await r.until(() => r.of('SettingsApplied').length === 1);
    expect(r.earsMade.map((e) => e.name)).toEqual(['labgpu']);
  });

  it('switches recognizers when the first goes silent while the student speaks', async () => {
    const r = await rig();
    await started(r);
    await r.feed(900, 6000);                                                    // speech, and not a word from the recognizer for longer than the (shortened) 600 ms
    await r.until(() => r.earsMade.length === 2 || r.of('Error').length > 0, 2000);
    expect(r.earsMade.map((e) => e.name)).toContain('flux');
    await r.until(() => r.of('Error').some((m) => m.code === 'LAB_EARS_SWITCHED'));
  });

  // The rig's limits are shortened: 600 ms since the wait began and 450 ms of speech in it (production: 8 s and 5 s).
  const switched = (r: Rig): boolean => r.of('Error').some((m) => m.code === 'LAB_EARS_SWITCHED');

  it('does not give the recognizer up for a short stretch of speech followed by a pause in the audio (less speech than a healthy recognizer always answers)', async () => {
    const r = await rig();
    await started(r);
    await r.feed(360, 7000);                                                    // 300 ms of speech once the onset has opened: under the 450 ms
    await sleep(350);                                                           // the page's audio stops for a moment (a throttled tab): the VAD still says "speaking"
    await r.feed(160, 0);
    await sleep(400);
    expect(r.earsMade.map((e) => e.name)).toEqual(['labgpu']);
    expect(switched(r)).toBe(false);
  });

  it('does not give the recognizer up when a blip started the wait long ago and a real utterance has only just begun: the recognizer has had no time to answer it', async () => {
    const r = await rig();
    await started(r);
    await r.feed(80, 7000);                                                     // a click or a cough that the recognizer rightly ignores: it starts a wait
    await r.feed(1500, 0);                                                      // much longer than the 600 ms: the wait is old by now
    await r.feed(300, 7000);                                                    // the student begins to speak
    await sleep(150);
    expect(r.earsMade.map((e) => e.name)).toEqual(['labgpu']);
    expect(switched(r)).toBe(false);
  });

  it('still gives up a recognizer that is deaf to a student who says short things with pauses in between ("hello?" ... "can you hear me?")', async () => {
    const r = await rig();
    await started(r);
    for (let i = 0; i < 6 && !switched(r); i++) {
      await r.feed(300, 7000);                                                  // a short utterance, no word from the recognizer
      await r.feed(700, 0);
    }
    await r.until(() => switched(r), 2000);
    expect(r.earsMade.map((e) => e.name)).toContain('flux');
  });

  it('does not give the recognizer up for blips of noise spread over many seconds, which it rightly ignores', async () => {
    const r = await rig();
    await started(r);
    for (let i = 0; i < 9; i++) {
      await r.feed(80, 7000);                                                   // a click or a cough: loud enough for an onset, and no words
      await r.feed(1120, 0);
    }
    expect(r.earsMade.map((e) => e.name)).toEqual(['labgpu']);
    expect(switched(r)).toBe(false);
  }, 60_000);

  it('speaks a sentence through the fallback mouth when the first one answers with a substituted voice, and warns', async () => {
    const r = await rig({ mouths: { labgpu: failingMouth('fallback', 'labgpu'), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 400 }) } });
    await started(r, { greeting: null });
    r.relay.script = () => [{ text: 'This goes through Aura.' }];
    await say(r, 'Hello.');
    await r.until(() => r.of('AgentAudioDone').length === 1);
    expect(r.mouths.aura.requests.map((x) => x.text)).toContain('This goes through Aura.');
    expect(r.of('Warning').some((m) => m.code === 'LAB_TTS_SUBSTITUTED')).toBe(true);
    expect(r.traces[0].fallbacks[0]).toBe('labgpu:fallback');
    // Aura speaks the Settings' voice when it is an Aura one, else the mode's: hannah is a Flux voice, so thalia
    expect(r.mouths.aura.requests[0].voice).toBe('aura-2-thalia-en');
  });

  it('a relay that fails is an Error the session turns into a notice, and the page is not left on "thinking"', async () => {
    const r = await rig();
    await started(r);
    r.relay.script = () => {
      throw new Error('boom');
    };
    await say(r, 'Hello.');
    await r.until(() => r.of('Error').length > 0, 4000).catch(() => undefined);
    // the SSE server threw: the agent saw a failed request (HTTP 500 from the framework) and must have ended the turn
    await r.until(() => r.of('AgentAudioDone').length >= 1, 4000);
  });
});

describe('LabAgent: the shadow recognizer', () => {
  it('gets the same audio, never decides, and its finals go into the trace of the turn', async () => {
    const r = await rig({ env: { TAI_VOICE_LAB_SHADOW_EARS: 'flux' } });
    await started(r, { greeting: null });
    await r.until(() => r.earsMade.length === 2);
    const [primary, shadow] = r.earsMade;
    expect(shadow.name).toBe('flux');
    r.relay.script = () => [{ text: 'Sure.' }];
    await say(r, 'What is a mutex?');
    shadow.final('What is a mute x?');                                          // the shadow's final must not start a turn of its own
    await r.until(() => r.of('AgentAudioDone').length === 1);
    expect(r.relay.requests).toHaveLength(1);
    expect(shadow.audio).toBe(primary.audio);
    await r.agent.close();
    expect(r.traces[0].shadow?.ears).toBe('flux');
    expect(r.traces[0].shadow?.finals.map((f) => f.text)).toEqual(['What is a mute x?']);
    void nullSink;
  });
});

describe('LabAgent: the eager end of turn (A10)', () => {
  const FUNCS = [{ name: 'recall_memory', description: 'Look in memory.', parameters: { type: 'object', properties: {} } }];

  /** Chain h: LabGPU's ears (earsMade[0]) with Flux listening beside them (earsMade[1]) once the call is up; the student has just stopped speaking and 100 ms of quiet have gone by. */
  async function afterSpeech(r: Rig, over: Parameters<typeof settings>[1] = {}): Promise<{ labgpu: FakeEars; flux: FakeEars }> {
    await started(r, over);
    await r.until(() => r.earsMade.length === 2);
    await r.feed(400, 6000);
    await r.feed(100, 0);
    return { labgpu: r.earsMade[0], flux: r.earsMade[1] };
  }

  /** What the page and the speech were told after `from` (the greeting and earlier turns do not count). */
  const toldAfter = (r: Rig, from: number, types = ['ConversationText', 'AgentThinking', 'FunctionCallRequest', 'LatencyReport']) => r.msgs.slice(from).filter((x) => types.includes(String(x.m.type)));

  it('asks the model on the eager text, says and does nothing until the turn is confirmed, and then goes out at once without asking again', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r);
    const from = r.msgs.length;
    const audioFrom = r.audio.length;
    r.relay.script = () => [{ delayMs: 100, text: 'A mutex is a lock.' }];
    flux.eager('What is a mutex?');
    await r.until(() => r.relay.requests.length === 1);
    expect(r.relay.requests[0].messages[r.relay.requests[0].messages.length - 1]).toEqual({ role: 'user', content: 'What is a mutex?' });
    await r.feed(500, 0);                                                         // longer than the model takes: the answer is ready, and held
    expect(toldAfter(r, from)).toEqual([]);                                       // the page was told nothing: no student line, no "thinking", no function, no latency
    expect(r.audio.length).toBe(audioFrom);
    labgpu.partial('What is a mutex?');                                            // LabGPU's text covers the speech: the turn is confirmed with the same words
    await r.until(() => r.of('ConversationText').some((m) => m.role === 'user'));
    const commitAt = r.msgs.find((x) => x.m.type === 'ConversationText' && x.m.role === 'user')!.at;
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests).toHaveLength(1);                                     // not asked again
    expect(r.audio.find((a) => a.at > commitAt)!.at - commitAt).toBeLessThan(400); // the held answer went out right at the commit, not a model's wait after it
    expect(r.of('ConversationText').filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Hi, I am TAi.', 'A mutex is a lock.']);
    const trace = r.traces.find((t) => t.turn === 1)!;
    expect(trace.chain).toBe('h');
    expect(trace.specs).toHaveLength(1);
    expect(trace.specs![0]).toMatchObject({ outcome: 'adopted', source: 'flux-shadow' });
    expect(trace.thinkSent!).toBeLessThan(trace.commit!);
    expect(trace.derived.headStart).toBeGreaterThan(300);
    expect(trace.firstSentenceReady!).toBeLessThan(trace.commit!);
    // and the history is the same as if it had been asked at the commit
    r.relay.script = () => [{ text: 'Okay.' }];
    await r.feed(400, 6000);
    await r.feed(300, 0);
    labgpu.partial('And a semaphore?');
    await r.until(() => r.relay.requests.length === 2);
    expect(r.relay.requests[1].messages.map((m) => `${m.role}:${m.content}`).slice(1)).toEqual(['assistant:Hi, I am TAi.', 'user:What is a mutex?', 'assistant:A mutex is a lock.', 'user:And a semaphore?']);
  }, 60_000);

  it('other words at the commit: the held request is aborted and the turn asks again, once, with the words that were confirmed', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r);
    r.relay.script = (n) => (n === 1 ? [{ delayMs: 600, text: 'An answer to the wrong words.' }] : [{ text: 'The right answer.' }]);
    flux.eager('What is a mutex?');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(100, 0);
    labgpu.partial('What is a mutual exclusion?');
    await r.until(() => r.relay.requests.length === 2);
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests[0].aborted).toBe(true);
    expect(r.relay.requests[1].messages[r.relay.requests[1].messages.length - 1]).toEqual({ role: 'user', content: 'What is a mutual exclusion?' });
    expect(r.of('ConversationText').filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Hi, I am TAi.', 'The right answer.']);
    expect(r.traces.find((t) => t.turn === 1)!.specs).toEqual([expect.objectContaining({ outcome: 'dropped', why: 'different words', source: 'flux-shadow' })]);
  }, 60_000);

  it('capital letters, punctuation and spacing are not different words', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r);
    r.relay.script = () => [{ text: 'It is a lock.' }];
    flux.eager('what is a MUTEX');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(100, 0);
    labgpu.partial('What is a mutex?');
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests).toHaveLength(1);
  }, 60_000);

  it('a course term that LabGPU writes in two pieces (A10a: "map reduce" for MapReduce) is the same words as the one piece Flux writes', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r);
    r.relay.script = () => [{ text: 'It splits the work.' }];
    flux.eager('How does MapReduce split the work?');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(100, 0);
    labgpu.partial('How does map reduce split the work?');
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests).toHaveLength(1);
    expect(r.of('ConversationText').find((m) => m.role === 'user')?.content).toBe('How does map reduce split the work?');     // the chat keeps LabGPU's own words
    expect(r.traces.find((t) => t.turn === 1)!.specs![0]).toMatchObject({ outcome: 'adopted' });
  }, 60_000);

  it('Flux taking the turn back (TurnResumed) drops the request without a word to the page; the next turn asks as usual', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r);
    const from = r.msgs.length;
    r.relay.script = (n) => (n === 1 ? [{ delayMs: 800, text: 'Too early.' }] : [{ text: 'Both parts.' }]);
    flux.eager('Tell me about Raft.');
    await r.until(() => r.relay.requests.length === 1);
    flux.resumed();
    await r.until(() => r.relay.requests[0].aborted);
    labgpu.partial('Tell me about');                                               // (what LabGPU's adapter had of the first part: it ends on a dangling word, so it is held)
    await r.feed(200, 0);
    expect(toldAfter(r, from)).toEqual([]);
    expect(r.of('Error')).toEqual([]);
    await r.feed(300, 6000);                                                      // the student goes on
    await r.feed(160, 0);
    labgpu.partial('Tell me about Raft and Paxos.');
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests).toHaveLength(2);
    expect(r.traces.find((t) => t.turn === 1)!.specs).toEqual([expect.objectContaining({ outcome: 'dropped', why: 'resumed' })]);
  }, 60_000);

  it('the engine hearing the student begin again drops it too, whatever Flux says', async () => {
    const r = await rig({ chain: 'h' });
    const { flux } = await afterSpeech(r);
    r.relay.script = () => [{ delayMs: 1000, text: 'Too early.' }];
    flux.eager('What is a mutex?');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(300, 0);                                                         // the room is quiet again: the VAD can see the next onset
    await r.feed(300, 6000);
    await r.until(() => r.relay.requests[0].aborted);
  }, 60_000);

  it('a held answer that asks for a function does not run it (the "Yeah. Sure." that once started a search nobody asked for), and Flux taking the turn back ends it', async () => {
    const r = await rig({ chain: 'h' });
    const { flux } = await afterSpeech(r, { think: { functions: FUNCS } });
    const from = r.msgs.length;
    r.relay.script = () => [{ tool: { name: 'recall_memory' } }];
    flux.eager('Yeah. Sure.');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(500, 0);
    expect(toldAfter(r, from)).toEqual([]);                                       // no FunctionCallRequest: nothing was asked of the session
    flux.resumed();
    await r.feed(300, 0);
    expect(r.of('FunctionCallRequest')).toHaveLength(0);
    expect(r.of('Error')).toEqual([]);
  }, 60_000);

  it('a held answer that asks for a function runs it once the turn is confirmed, and the loop goes on as any turn does', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r, { think: { functions: FUNCS } });
    r.relay.script = (n) => (n === 1 ? [{ text: 'Let me look. ' }, { tool: { name: 'recall_memory' } }] : [{ text: 'You did Docker last week.' }]);
    flux.eager('What did I do last week?');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(300, 0);
    expect(r.of('FunctionCallRequest')).toHaveLength(0);
    labgpu.partial('What did I do last week?');
    await r.until(() => r.of('FunctionCallRequest').length === 1);
    const call = (r.of('FunctionCallRequest')[0].functions as Array<{ id: string; name: string }>)[0];
    expect(call.name).toBe('recall_memory');
    r.send({ type: 'FunctionCallResponse', id: call.id, name: call.name, content: 'Docker.' });
    await r.until(() => r.relay.requests.length === 2);
    expect(r.relay.requests[1].messages.map((m) => m.role).slice(-4)).toEqual(['assistant', 'user', 'assistant', 'tool']);
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.of('ConversationText').filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Hi, I am TAi.', 'Let me look.', 'You did Docker last week.']);
    expect(r.relay.requests).toHaveLength(2);
  }, 60_000);

  it('a conversation that changed between the eager text and the commit is another conversation: the held answer is not used', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r);
    r.relay.script = (n) => (n === 1 ? [{ delayMs: 300, text: 'Before the note.' }] : [{ text: 'After the note.' }]);
    flux.eager('What is a mutex?');
    await r.until(() => r.relay.requests.length === 1);
    r.send({ type: 'UpdatePrompt', prompt: 'Be brief.' });
    await r.until(() => r.of('PromptUpdated').length === 1);
    await r.feed(100, 0);
    labgpu.partial('What is a mutex?');
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests).toHaveLength(2);
    expect(r.relay.requests[1].messages.some((m) => m.role === 'system' && m.content === 'Be brief.')).toBe(true);
    expect(r.traces.find((t) => t.turn === 1)!.specs).toEqual([expect.objectContaining({ outcome: 'dropped', why: 'history changed' })]);
  }, 60_000);

  it('does not ask on words the turn rule would hold, nor while an answer is being spoken, nor in a talk-through', async () => {
    const r = await rig({ chain: 'h', mouths: { labgpu: new FakeMouth({ name: 'labgpu', ms: 2500 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) } });
    const { labgpu, flux } = await afterSpeech(r);
    flux.eager('So the leader sends heartbeats to');                               // ends on a dangling word
    flux.eager('Um.');
    await r.feed(200, 0);
    expect(r.relay.requests).toHaveLength(0);
    // while the agent speaks
    r.relay.script = () => [{ text: 'A long answer that goes on for a while.' }];
    labgpu.partial('Explain Raft.');
    await r.until(() => r.of('ConversationText').filter((m) => m.role === 'assistant').length >= 2);
    flux.eager('And what about Paxos?');
    await sleep(200);
    expect(r.relay.requests).toHaveLength(1);
    // a talk-through: the thresholds of its profile
    const t = await rig({ chain: 'h' });
    await started(t, { listen: { eot_threshold: 0.9, eot_timeout_ms: 10000 } });
    await t.until(() => t.earsMade.length === 2);
    await t.feed(400, 6000);
    await t.feed(100, 0);
    t.earsMade[1].eager('I think the leader replicates the log entry to a majority.');
    await t.feed(300, 0);
    expect(t.relay.requests).toHaveLength(0);
  }, 60_000);

  it('a held request that fails is not an error for the page: the turn asks again when it is confirmed', async () => {
    const r = await rig({ chain: 'h' });
    const { labgpu, flux } = await afterSpeech(r);
    r.relay.script = (n) => {
      if (n === 1) throw new Error('rate limited');
      return [{ text: 'Second time lucky.' }];
    };
    flux.eager('What is a mutex?');
    await r.until(() => r.relay.requests.length === 1);
    await r.feed(300, 0);
    expect(r.of('Error')).toEqual([]);
    labgpu.partial('What is a mutex?');
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests).toHaveLength(2);
    expect(r.traces.find((t) => t.turn === 1)!.specs).toEqual([expect.objectContaining({ outcome: 'dropped', why: 'failed' })]);
  }, 60_000);

  it('chain d (and a process with no chain) never asks early, whatever the second recognizer says', async () => {
    for (const chain of ['d', undefined]) {
      const r = await rig({ chain, env: { TAI_VOICE_LAB_SHADOW_EARS: 'flux' } });
      await started(r);
      await r.until(() => r.earsMade.length === 2);
      await r.feed(400, 6000);
      await r.feed(100, 0);
      r.earsMade[1].eager('What is a mutex?');
      await r.feed(300, 0);
      expect(r.relay.requests).toHaveLength(0);
    }
  }, 60_000);

  it('chain c: Flux ears ask early on their own eager text and the EndOfTurn with the same words confirms it; with other words it asks again', async () => {
    const r = await rig({ chain: 'c' });
    await started(r);
    const flux = r.earsMade[0];
    expect(flux.name).toBe('flux');
    r.relay.script = (n) => (n === 1 ? [{ delayMs: 100, text: 'A lock.' }] : n === 2 ? [{ delayMs: 400, text: 'Wrong.' }] : [{ text: 'Right.' }]);
    flux.eager('What is a mutex?');
    await r.until(() => r.relay.requests.length === 1);
    await sleep(300);
    expect(r.of('ConversationText').some((m) => m.role === 'user')).toBe(false);
    flux.final('What is a mutex?', { trigger: 'model', confidence: 0.9 });
    await r.until(() => r.of('AgentAudioDone').length === 2);
    expect(r.relay.requests).toHaveLength(1);
    expect(r.traces.find((t) => t.turn === 1)!.specs![0]).toMatchObject({ outcome: 'adopted', source: 'flux' });
    flux.eager('And a semaphore?');
    await r.until(() => r.relay.requests.length === 2);
    flux.final('And a semaphore please?', { trigger: 'model', confidence: 0.9 });
    await r.until(() => r.relay.requests.length === 3);
    await r.until(() => r.of('AgentAudioDone').length === 3);
    expect(r.relay.requests[1].aborted).toBe(true);
    expect(r.of('ConversationText').filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Hi, I am TAi.', 'A lock.', 'Right.']);
  }, 60_000);

  it('the recognizer is asked for the eager end of turn only where it is used: Flux ears and a Flux shadow beside LabGPU, with the threshold of the chain', async () => {
    const expected: Record<string, Array<{ kind: string; eagerEot?: number }>> = {
      h: [{ kind: 'labgpu' }, { kind: 'flux', eagerEot: 0.45 }],
      c: [{ kind: 'flux', eagerEot: 0.45 }, { kind: 'labgpu' }],
      d: [{ kind: 'labgpu' }, { kind: 'flux' }],
    };
    for (const chain of ['h', 'c', 'd']) {
      const r = await rig({ chain });
      await started(r);
      await r.until(() => r.earsAsked.length === 2);
      expect(r.earsAsked.map((a) => ({ kind: a.kind, ...(a.eagerEot ? { eagerEot: a.eagerEot } : {}) })), chain).toEqual(expected[chain]);
    }
    const tuned = await rig({ chain: 'h', env: { TAI_VOICE_LAB_EAGER_EOT: '0.6' } });
    await started(tuned);
    await tuned.until(() => tuned.earsAsked.length === 2);
    expect(tuned.earsAsked[1]).toEqual({ kind: 'flux', eagerEot: 0.6 });
  }, 60_000);
});

describe('LabAgent: barge-in does not depend on the recognizer (A10) and reads a window of loud frames (A11)', () => {
  async function speakLong(r: Rig, flux: boolean): Promise<void> {
    r.relay.script = () => [{ text: 'Raft elects a leader first. ' }, { text: 'Then the leader sends heartbeats to everyone.' }];
    if (flux) r.earsMade[0].final('Explain Raft.');
    else await say(r, 'Explain Raft.');
    await r.until(() => r.audio.length > 0);
  }
  const longMouth = () => ({ labgpu: new FakeMouth({ name: 'labgpu', ms: 3000 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 500 }) });

  it('with Flux ears the student speaking over the agent stops it on the engine\'s own VAD, without waiting for the recognizer\'s start of turn', async () => {
    const r = await rig({ env: { TAI_VOICE_LAB_EARS: 'flux', TAI_VOICE_LAB_EARS_FALLBACK: 'none' }, mouths: longMouth() });
    await started(r, { greeting: null });
    await speakLong(r, true);
    const n = r.of('UserStartedSpeaking').length;
    await r.feed(360, 7000);                                                      // Flux says nothing: no startOfTurn is sent
    await r.until(() => r.of('UserStartedSpeaking').length === n + 1);
    const trace = r.traces.find((t) => t.bargeIn);
    expect(trace?.bargeIn?.by).toBe('vad');
    const settled = r.audio.reduce((a, x) => a + x.bytes, 0);
    await sleep(300);
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBe(settled);
  }, 60_000);

  it('a stop consonant inside the first word does not make the barge-in wait for the next one', async () => {
    const r = await rig({ mouths: longMouth(), env: { TAI_VOICE_LAB_BARGE_MS: '200', TAI_VOICE_LAB_BARGE_WINDOW_MS: '300' } });
    await started(r, { greeting: null });
    await speakLong(r, false);
    const n = r.of('UserStartedSpeaking').length;
    const t0 = performance.now();
    await r.feed(160, 7000);                                                      // 160 ms, a closure of 80 ms, 160 ms more
    await r.feed(80, 0);
    await r.feed(160, 7000);
    await r.until(() => r.of('UserStartedSpeaking').length === n + 1);
    expect(performance.now() - t0).toBeLessThan(2000);
    const trace = r.traces.find((t) => t.bargeIn)!;
    expect(trace.bargeIn!.confirmed - trace.bargeIn!.onset).toBeLessThan(500);
  }, 60_000);

  it('with the round-1 window (no longer than the 240 ms asked for) the same dip makes it wait for an unbroken run', async () => {
    const r = await rig({ mouths: longMouth(), env: { TAI_VOICE_LAB_BARGE_MS: '240', TAI_VOICE_LAB_BARGE_WINDOW_MS: '240' } });
    await started(r, { greeting: null });
    await speakLong(r, false);
    const n = r.of('UserStartedSpeaking').length;
    await r.feed(160, 7000);
    await r.feed(80, 0);
    await r.feed(160, 7000);
    await r.feed(100, 0);
    expect(r.of('UserStartedSpeaking').length).toBe(n);                           // 160 + 160 ms with a gap: never 240 in a row
  }, 60_000);

  it('clicks are not a barge-in: loud frames one in four never make 200 ms of speech in 300', async () => {
    const r = await rig({ mouths: longMouth(), env: { TAI_VOICE_LAB_BARGE_MS: '200', TAI_VOICE_LAB_BARGE_WINDOW_MS: '300' } });
    await started(r, { greeting: null });
    await speakLong(r, false);
    const n = r.of('UserStartedSpeaking').length;
    for (let i = 0; i < 12; i++) {
      await r.feed(40, 7000);
      await r.feed(120, 0);
    }
    expect(r.of('UserStartedSpeaking').length).toBe(n);
  }, 60_000);
});

describe('LabAgent: the Flux TTS mouth says an answer as ONE continuous speech (amendment A15)', () => {
  const SENTENCES = ['Raft elects a leader first.', 'Then the leader sends heartbeats to everyone.', 'That keeps the followers calm.'];
  const THREE = [{ text: 'Raft elects a leader first. ' }, { text: 'Then the leader sends heartbeats to everyone. ' }, { text: 'That keeps the followers calm.' }];
  const assistantLines = (r: Rig): string[] => r.of('ConversationText').filter((m) => m.role === 'assistant').map((m) => String(m.content));
  const sentencesAskedOfAura = (r: Rig, among: string[]): string[] => r.mouths.aura.requests.map((x) => x.text).filter((t) => among.includes(t));

  async function fluxRig(behavior: FakeFluxTtsOptions = {}, over: { env?: Record<string, string>; chain?: string } = {}): Promise<{ r: Rig; fake: FakeFluxTts; mouth: FluxTtsMouth }> {
    const fake = await FakeFluxTts.start({ msPerChar: 25, frameAudioMs: 40, frameWallMs: 10, startDelayMs: 5, ...behavior });
    const mouth = new FluxTtsMouth({ apiKey: () => 'dg-test-key-abcdef', baseUrl: fake.url });
    const r = await rig({
      env: { TAI_VOICE_LAB_MOUTH: 'flux', ...(over.env ?? {}) },
      ...(over.chain ? { chain: over.chain } : {}),
      mouths: { flux: mouth as unknown as FakeMouth, labgpu: new FakeMouth({ name: 'labgpu', ms: 300 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 300 }) },
    });
    // (the rig's own cleanup, which closes the agent and so the mouth, was queued first)
    cleanups.push(async () => {
      mouth.close();
      await fake.close();
    });
    return { r, fake, mouth };
  }

  it('three sentences are one speech: a Speak for each, one Flush, the Settings\' voice and pace in the address, and a transcript line for each in order', async () => {
    const { r, fake } = await fluxRig();
    await started(r, { greeting: null });
    r.relay.script = () => THREE;
    await say(r, 'Explain Raft.');
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    expect(fake.connections).toHaveLength(1);
    const c = fake.last;
    expect(c.query.get('model')).toBe('flux-hannah-en');
    expect(c.query.get('speed')).toBe('1.2');
    expect(c.authorization).toBe('Token dg-test-key-abcdef');
    expect(c.turns).toHaveLength(1);
    expect(c.speaks()).toEqual(SENTENCES.map((s) => `${s} `));
    expect(c.clientTypes()).toEqual(['Speak', 'Speak', 'Speak', 'Flush']);
    expect(assistantLines(r)).toEqual(SENTENCES);
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBeGreaterThan(48 * 2400);
    expect(r.traces[0]?.mouth).toBe('flux');
    expect(fake.violations).toEqual([]);
  }, 60_000);

  it('the greeting is a speech of its own, and the fixed lines are not rendered ahead of time: nothing is spoken that nobody asked for', async () => {
    const { r, fake } = await fluxRig();
    await started(r, { greeting: 'Hi, I am TAi.' });
    await sleep(300);
    expect(fake.connections).toHaveLength(1);
    expect(fake.last.turnTexts()).toEqual(['Hi, I am TAi. ']);
    expect(fake.last.clientTypes()).toEqual(['Speak', 'Flush']);
  }, 60_000);

  it('opens the socket when the call starts, before the first sentence, and says nothing on it', async () => {
    const { r, fake } = await fluxRig();
    r.send(settings(r, { greeting: null }));
    await r.until(() => r.of('SettingsApplied').length > 0);
    await r.until(() => fake.connections.length === 1);
    await sleep(200);
    expect(fake.connections).toHaveLength(1);
    expect(fake.last.clientTypes()).toEqual([]);
  }, 60_000);

  it('the words before a function call and the answer after it are two speeches, in order', async () => {
    const { r, fake } = await fluxRig();
    await started(r, { greeting: null });
    r.relay.script = (n) => (n === 1 ? [{ text: 'Let me check. ' }, { tool: { name: 'recall_memory', args: { query: 'raft' } } }] : [{ text: 'You asked about Raft before.' }]);
    await say(r, 'What did I ask before?');
    await r.until(() => r.of('FunctionCallRequest').length === 1);
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    const call = (r.of('FunctionCallRequest')[0].functions as Array<Record<string, unknown>>)[0];
    r.send({ type: 'FunctionCallResponse', id: call.id, name: 'recall_memory', content: '{"found":"Raft"}' });
    await r.until(() => r.of('AgentAudioDone').length === 2, 20_000);
    expect(fake.connections.flatMap((c) => c.turnTexts())).toEqual(['Let me check. ', 'You asked about Raft before. ']);
    expect(assistantLines(r)).toEqual(['Let me check.', 'You asked about Raft before.']);
  }, 60_000);

  it('a call whose voice is an Aura one (the interviewer, as in the live call) is spoken sentence by sentence through Aura, and the Flux socket is not used', async () => {
    const { r, fake } = await fluxRig();
    await started(r, { greeting: null, speak: { model: 'aura-2-mars-en', speed: 1.08, version: undefined } });
    r.relay.script = () => THREE;
    await say(r, 'Explain Raft.');
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    expect(sentencesAskedOfAura(r, SENTENCES)).toEqual(SENTENCES);
    expect(fake.connections).toHaveLength(0);
    expect(r.traces[0]?.mouth).toBe('aura');
  }, 60_000);

  it('UpdateSpeak moves a call between the two voices: Flux (one speech), Aura (sentences), Flux again', async () => {
    const { r, fake } = await fluxRig();
    await started(r, { greeting: null });
    r.relay.script = (n) => (n === 1 ? [{ text: 'Flux says this first. ' }, { text: 'And this second.' }] : n === 2 ? [{ text: 'The interviewer asks one thing. ' }, { text: 'Then another.' }] : [{ text: 'Back to the first voice.' }]);
    await say(r, 'First question.');
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    r.send({ type: 'UpdateSpeak', speak: { provider: { type: 'deepgram', model: 'aura-2-mars-en', speed: 1.08 } } });
    await r.until(() => r.of('SpeakUpdated').length === 1);
    await r.feed(300, 0);
    await say(r, 'Second question.');
    await r.until(() => r.of('AgentAudioDone').length === 2, 20_000);
    expect(sentencesAskedOfAura(r, ['The interviewer asks one thing.', 'Then another.'])).toEqual(['The interviewer asks one thing.', 'Then another.']);
    expect(fake.connections.flatMap((c) => c.turnTexts())).toEqual(['Flux says this first. And this second. ']);
    r.send({ type: 'UpdateSpeak', speak: { provider: { type: 'deepgram', version: 'v2', model: 'flux-hannah-en', speed: 1.2 } } });
    await r.until(() => r.of('SpeakUpdated').length === 2);
    await r.feed(300, 0);
    await say(r, 'Third question.');
    await r.until(() => r.of('AgentAudioDone').length === 3, 20_000);
    expect(fake.connections.flatMap((c) => c.turnTexts())).toEqual(['Flux says this first. And this second. ', 'Back to the first voice. ']);
    expect(fake.violations).toEqual([]);
  }, 60_000);

  it('a student who talks over the answer: the speech is interrupted with the offset of what had played, and the history keeps the words the service says were heard', async () => {
    const { r, fake } = await fluxRig({ msPerChar: 60, frameWallMs: 25 });
    await started(r, { greeting: null });
    r.relay.script = (n) => (n === 1 ? THREE : [{ text: 'Okay, stopping.' }]);
    await say(r, 'Explain Raft.');
    await r.until(() => r.audio.length > 0 && assistantLines(r).length >= 1, 20_000);
    await sleep(400);
    const interrupted = r.of('UserStartedSpeaking').length;
    await r.feed(360, 7000);                                                    // the student talks over it
    await r.until(() => r.of('UserStartedSpeaking').length > interrupted);
    await r.until(() => fake.last.interruptReplies.length === 1, 10_000);
    const settled = r.audio.reduce((a, x) => a + x.bytes, 0);
    await sleep(300);
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBe(settled);              // nothing more is played after the cut
    expect(r.of('AgentAudioDone')).toHaveLength(0);
    await r.feed(160, 0);
    r.earsMade[0].partial('Wait, stop.');
    await r.until(() => r.relay.requests.length === 2, 20_000);
    const reply = fake.last.interruptReplies[0];
    const heard = wholeWords(reply.spoken, reply.remaining).spoken;
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.length).toBeLessThan(SENTENCES.join(' ').length);
    // the model's memory of what it said ends where the service says the audio did, not where the clock guessed
    const assistant = r.relay.requests[1].messages.filter((m) => m.role === 'assistant').map((m) => String(m.content));
    expect(assistant).toEqual([heard]);
    expect(fake.last.interruptCount).toBe(1);
    expect(fake.connections).toHaveLength(1);                                    // the socket is kept for the next speech
    expect(fake.violations).toEqual([]);
    // and the answer to the interruption is a speech like any other, on the same socket
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    expect(fake.last.turnTexts()[fake.last.turnTexts().length - 1]).toBe('Okay, stopping. ');
  }, 60_000);

  it('chain cf: Flux ears, the Flux mouth in one speech, and the trace says so', async () => {
    const { r, fake } = await fluxRig({}, { chain: 'cf' });
    await started(r, { greeting: null });
    const flux = r.earsMade[0];
    expect(flux.name).toBe('flux');
    r.relay.script = () => THREE;
    flux.startOfTurn('explain');
    await r.until(() => r.of('UserStartedSpeaking').length >= 1);
    flux.final('Explain Raft.', { trigger: 'model', confidence: 0.9 });
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    expect(fake.last.turns).toHaveLength(1);
    expect(fake.last.speaks()).toHaveLength(3);
    expect(r.traces[0]).toMatchObject({ chain: 'cf', ears: 'flux', mouth: 'flux' });
    expect(r.earsAsked.map((a) => a.kind)).toEqual(['flux', 'labgpu']);
  }, 60_000);

  it('when the speech fails before any audio the answer is not lost: the same sentences are made one by one through Aura, and the next answer goes straight to Aura', async () => {
    const { r, fake } = await fluxRig({ errorOnSpeak: true });
    await started(r, { greeting: null });
    r.relay.script = (n) => (n === 1 ? THREE : [{ text: 'Second answer.' }]);
    await say(r, 'Explain Raft.');
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    expect(sentencesAskedOfAura(r, SENTENCES)).toEqual(SENTENCES);
    expect(assistantLines(r)).toEqual(SENTENCES);
    expect(r.of('Warning').filter((m) => m.code === 'LAB_SPEECH_FAILED')).toHaveLength(1);
    const connections = fake.connections.length;
    await r.feed(300, 0);
    await say(r, 'And the second question?');
    await r.until(() => r.of('AgentAudioDone').length === 2, 20_000);
    expect(sentencesAskedOfAura(r, ['Second answer.'])).toEqual(['Second answer.']);
    expect(fake.connections).toHaveLength(connections);                          // the mouth is marked down: the second answer did not try it
    expect(assistantLines(r)).toEqual([...SENTENCES, 'Second answer.']);
  }, 60_000);
});

describe('LabAgent: the pace asked of a TTS service that takes one (the local voice service)', () => {
  it('asks for the Settings\' pace times TAI_VOICE_LAB_TTS_SPEED_SCALE, in a conversation and in the interview, and does not stretch what comes back', async () => {
    const labgpu = new FakeMouth({ name: 'labgpu', takesSpeed: true, ms: 400 });
    const r = await rig({ env: { TAI_VOICE_LAB_TTS_SPEED_SCALE: '1.1', TAI_VOICE_LAB_TEMPO: '1' }, mouths: { labgpu, aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 400 }) } });
    await started(r, { greeting: null });
    r.relay.script = (n) => [{ text: n === 1 ? 'A mutex is a lock.' : 'Tell me about Raft.' }];
    await say(r, 'What is a mutex?');
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    const first = labgpu.requests.filter((x) => x.text === 'A mutex is a lock.');
    expect(first).toHaveLength(1);
    expect(first[0].speed).toBeCloseTo(1.2 * 1.1, 5);
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBe(Math.round(400 * 48) & ~1);          // the 400 ms the mouth made, not a time-stretched version of them (TEMPO is on)
    r.send({ type: 'UpdateSpeak', speak: { provider: { type: 'deepgram', model: 'aura-2-mars-en', speed: 1.08 } } });
    await r.until(() => r.of('SpeakUpdated').length === 1);
    await r.feed(300, 0);
    await say(r, 'Next question.');
    await r.until(() => r.of('AgentAudioDone').length === 2, 20_000);
    const second = labgpu.requests.filter((x) => x.text === 'Tell me about Raft.');
    expect(second).toHaveLength(1);
    expect(second[0].speed).toBeCloseTo(1.08 * 1.1, 5);
  }, 60_000);

  it('a TTS service that does not take a pace is asked for none and its audio is stretched as before', async () => {
    const labgpu = new FakeMouth({ name: 'labgpu', takesSpeed: false, ms: 400 });
    const r = await rig({ env: { TAI_VOICE_LAB_TEMPO: '1' }, mouths: { labgpu, aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 400 }) } });
    await started(r, { greeting: null });
    r.relay.script = () => [{ text: 'A mutex is a lock.' }];
    await say(r, 'What is a mutex?');
    await r.until(() => r.of('AgentAudioDone').length === 1, 20_000);
    const asked = labgpu.requests.filter((x) => x.text === 'A mutex is a lock.');
    expect(asked).toHaveLength(1);
    expect(asked[0].speed).toBeUndefined();
    expect(r.audio.reduce((a, x) => a + x.bytes, 0)).toBeLessThan(Math.round(400 * 48) & ~1);  // stretched to the live pace: shorter
  }, 60_000);
});

describe('LabAgent: the fixed lines rendered ahead of time', () => {
  it('are rendered through a mouth that allows it when the call starts, and not through one that says it should not (the local CPU service)', async () => {
    const warm = new FakeMouth({ name: 'labgpu', ms: 100 });
    const a = await rig({ mouths: { labgpu: warm, aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 100 }) } });
    await started(a, { greeting: null });
    await sleep(300);
    expect(warm.requests.length).toBeGreaterThan(5);
    const cold = new FakeMouth({ name: 'labgpu', ms: 100, prewarm: false });
    const b = await rig({ mouths: { labgpu: cold, aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: 100 }) } });
    await started(b, { greeting: null });
    await sleep(300);
    expect(cold.requests).toHaveLength(0);
  }, 60_000);
});
