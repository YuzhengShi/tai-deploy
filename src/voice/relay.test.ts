import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RelayTokens, createRelay, questionLast, rewriteChatRequest, scrubSseLine } from './relay.js';
import { FakeGateway, streamed } from './testing/fake-gateway.js';

const KEY = 'sk-gateway-SECRET-123';
const secret = crypto.randomBytes(32);

describe('questionLast', () => {
  const sys = (c: string) => ({ role: 'system', content: c });
  const user = (c: string) => ({ role: 'user', content: c });
  const bot = (c: string) => ({ role: 'assistant', content: c });

  it('moves a system message that ends the history in front of the student\'s lines right before it', () => {
    expect(questionLast([sys('a'), bot('x'), user('q1'), user('q2'), sys('b'), sys('c')])).toEqual([sys('a'), bot('x'), sys('b'), sys('c'), user('q1'), user('q2')]);
  });

  it('leaves a history that does not end in a system message after a student line, or has nothing else, as it is', () => {
    const plain = [sys('a'), bot('x'), user('q')];
    expect(questionLast(plain)).toBe(plain);
    const afterTool = [sys('a'), user('q'), bot('call'), { role: 'tool', content: '{}' }, sys('b')];
    expect(questionLast(afterTool)).toBe(afterTool);                                    // a prompt that follows a function result is where it was meant to be
    const onlySystem = [sys('a'), sys('b')];
    expect(questionLast(onlySystem)).toBe(onlySystem);
    expect(questionLast('not messages')).toBe('not messages');
    expect(questionLast([])).toEqual([]);
  });
});

describe('relay tokens', () => {
  const tokens = new RelayTokens(secret);
  const sid = 'AbCdEfGhIjKlMnOpQrStUv';

  it('verifies its own token until it expires', () => {
    const tok = tokens.mint(sid, 2_000_000_000_000);
    expect(tok).toMatch(/^v1\.AbCdEfGhIjKlMnOpQrStUv\.2000000000000\.[0-9a-f]{64}$/);
    expect(tokens.verify(tok, 1_900_000_000_000)).toBe(sid);
    expect(tokens.verify(tok, 2_000_000_000_001)).toBeNull();
  });

  it('refuses a forged, altered, malformed or foreign token', () => {
    const tok = tokens.mint(sid, 2_000_000_000_000);
    const [v, s, exp, mac] = tok.split('.');
    expect(tokens.verify(`${v}.${s}.${Number(exp) + 1}.${mac}`, 0)).toBeNull(); // a later expiry
    expect(tokens.verify(`${v}.ZZCdEfGhIjKlMnOpQrStUv.${exp}.${mac}`, 0)).toBeNull(); // another session
    expect(tokens.verify(`${v}.${s}.${exp}.${'0'.repeat(64)}`, 0)).toBeNull();
    expect(tokens.verify('v1.short.1.abc', 0)).toBeNull();
    expect(tokens.verify(undefined, 0)).toBeNull();
    expect(tokens.verify('x'.repeat(500), 0)).toBeNull();
    expect(new RelayTokens(crypto.randomBytes(32)).verify(tok, 0)).toBeNull();
  });

  it('derives its key with domain separation: the raw portal secret does not sign it', () => {
    const tok = tokens.mint(sid, 2_000_000_000_000);
    const body = tok.split('.').slice(0, 3).join('.');
    const naive = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(tok.endsWith(naive)).toBe(false);
  });
});

describe('request rewriting', () => {
  it('keeps only the allowed fields, sets the model, the stream and the token cap', () => {
    const out = rewriteChatRequest(
      {
        model: 'gpt-4o',
        stream: false,
        max_tokens: 9000,
        temperature: 9,
        user: 'leak',
        metadata: { a: 1 },
        tools: [{ type: 'function', function: { name: 'query_canvas', description: 'd', parameters: { type: 'object' } }, extra: 1 }],
        tool_choice: 'auto',
        messages: [
          { role: 'system', content: 'be TAi' },
          { role: 'assistant', content: null, reasoning: 'secret thoughts', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query_canvas', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'due monday', name: 'query_canvas' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'x' } }] },
        ],
      },
      { model: 'gpt-oss', maxTokens: 400 },
    );
    expect(out).toEqual({
      model: 'gpt-oss',
      stream: true,
      max_tokens: 400,
      temperature: 2,
      tools: [{ type: 'function', function: { name: 'query_canvas', description: 'd', parameters: { type: 'object' } } }],
      parallel_tool_calls: false,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: 'be TAi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query_canvas', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'due monday', name: 'query_canvas' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    });
  });

  it('takes max_completion_tokens, leaves parallel_tool_calls out without tools, and refuses what is not a chat request', () => {
    expect(rewriteChatRequest({ messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 120 }, { model: 'm', maxTokens: 400 })).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      max_tokens: 120,
    });
    expect(rewriteChatRequest({ messages: [] }, { model: 'm', maxTokens: 400 })).toBeNull();
    expect(rewriteChatRequest({ messages: [{ role: 'root', content: 'x' }] }, { model: 'm', maxTokens: 400 })).toBeNull();
    expect(rewriteChatRequest([1, 2], { model: 'm', maxTokens: 400 })).toBeNull();
    expect(rewriteChatRequest('x', { model: 'm', maxTokens: 400 })).toBeNull();
  });

  it('replaces an SSE line that carries an error', () => {
    expect(scrubSseLine('data: {"error":{"message":"litellm.APIError: https://api.cerebras.ai key sk-123"}}')).toBe('data: {"error":{"message":"the language model failed"}}');
    expect(scrubSseLine('data: {"choices":[{"delta":{"content":"error is fine as a word"}}]}')).toBe('data: {"choices":[{"delta":{"content":"error is fine as a word"}}]}');
    expect(scrubSseLine('data: [DONE]')).toBe('data: [DONE]');
  });
});

describe('the relay endpoint', () => {
  let gw: FakeGateway;
  let server: http.Server;
  let base: string;
  const tokens = new RelayTokens(secret);
  const live = new Set<string>();
  const sid = 'Session0123456789abcdef';
  let clock = 1_000_000;

  beforeEach(async () => {
    gw = await FakeGateway.start();
    live.clear();
    live.add(sid);
    clock = 1_000_000;
    const relay = createRelay({
      tokens,
      isLive: (s) => live.has(s),
      upstreamUrl: `${gw.url}/v1/chat/completions`,
      upstreamKey: KEY,
      model: 'gpt-oss',
      maxTokens: 400,
      now: () => clock,
      perMinute: 5,
      maxBodyBytes: 4096,
    });
    server = http.createServer((req, res) => void relay(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/voice-llm/v1/chat/completions`;
  });

  afterEach(async () => {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await gw.close();
  });

  const post = (body: unknown, token: string | null = tokens.mint(sid, clock + 60_000), extra: Record<string, string> = {}) =>
    fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const chat = { messages: [{ role: 'user', content: 'what is raft?' }], model: 'x' };

  it('refuses without a token, with a bad one, an expired one, or one of a call that is over, before reading the body', async () => {
    for (const token of [null, 'garbage', tokens.mint(sid, clock - 1), tokens.mint('Other0123456789abcdefgh', clock + 60_000)]) {
      const res = await post(chat, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { message: 'unauthorized' } });
    }
    live.delete(sid);
    expect((await post(chat)).status).toBe(401);
    expect(gw.requests).toHaveLength(0);
  });

  it('streams the gateway answer back and sends the gateway the rewritten request with its own key', async () => {
    gw.respond = () => streamed('A leader needs a majority.');
    const res = await post({ ...chat, max_tokens: 2000, stream: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const text = await res.text();
    // an answer goes out a sentence at a time (speech-governor.ts): the two chunks of the gateway arrive as the one sentence they make
    expect(text).toContain('"content":"A leader needs a majority."');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    expect(gw.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(gw.requests[0].body).toEqual({ model: 'gpt-oss', messages: chat.messages, stream: true, max_tokens: 400 });
  });

  it('puts the system message of a prompt update in front of the question it landed after, so that the model answers the student', async () => {
    gw.respond = () => streamed('Yes, I can see Canvas.');
    const messages = [
      { role: 'system', content: 'You are TAi (the interviewer).' },
      { role: 'assistant', content: 'nice work, that is the interview done!' },
      { role: 'user', content: 'Can you see canvas?' },
      { role: 'system', content: 'You are TAi, a fellow TA. (the conversation)' },
    ];
    const res = await post({ model: 'gpt-oss', messages, stream: true });
    expect(res.status).toBe(200);
    await res.text();
    expect((gw.requests[0].body as { messages: Array<{ role: string; content: string }> }).messages.map((m) => `${m.role}: ${m.content.slice(0, 13)}`)).toEqual([
      'system: You are TAi (',
      'assistant: nice work, th',
      'system: You are TAi, ',
      'user: Can you see c',
    ]);
  });

  it('never passes on the gateway\'s own words: no key, no host, no model provider in any error', async () => {
    const leak = `upstream https://api.cerebras.ai/v1 refused key ${KEY} at ${gw.url}`;
    const cases: Array<() => void> = [
      () => (gw.respond = () => ({ status: 500, text: leak })),
      () => (gw.respond = () => ({ status: 400, json: { error: { message: leak } } })),
      () => (gw.respond = () => ({ status: 200, json: { error: { message: leak } } })),
      () => (gw.respond = () => ({ sse: [JSON.stringify({ error: { message: leak } })] })),
      () => (gw.respond = () => ({ status: 429, text: leak })),
    ];
    for (const arrange of cases) {
      arrange();
      const res = await post(chat);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('cerebras');
      expect(text).not.toContain(gw.url.replace('http://', ''));
      expect(text).not.toContain('127.0.0.1');
    }
  });

  it('answers 502 when the gateway is down, without naming it', async () => {
    await gw.close();
    const res = await post(chat);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toBe('{"error":{"message":"the language model is unavailable"}}');
    gw = await FakeGateway.start(); // for afterEach
  });

  it('limits a call to its requests a minute, and the body to its size', async () => {
    gw.respond = () => streamed('ok');
    for (let i = 0; i < 5; i++) expect((await post(chat)).status).toBe(200);
    expect((await post(chat)).status).toBe(429);
    clock += 61_000;
    const big = { messages: [{ role: 'user', content: 'x'.repeat(5000) }] };
    expect((await post(big, tokens.mint(sid, clock + 60_000))).status).toBe(413);
    expect((await post('{not json', tokens.mint(sid, clock + 60_000))).status).toBe(400);
    expect((await post({ prompt: 'not chat' }, tokens.mint(sid, clock + 60_000))).status).toBe(400);
  });

  it('answers only POST', async () => {
    const res = await fetch(base, { method: 'GET', headers: { authorization: `Bearer ${tokens.mint(sid, clock + 60_000)}` } });
    expect(res.status).toBe(405);
  });

  const sseEvents = (text: string) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(5)) as { choices: Array<{ delta: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string | null }> });
  const withTools = { ...chat, tools: [{ type: 'function', function: { name: 'send_to_chat', parameters: { type: 'object' } } }] };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'gpt-oss', choices: [{ index: 0, delta, finish_reason: finish }] });

  it('takes Markdown out of what is said, and sends a call the model wrote as text on as a real call', async () => {
    gw.respond = () => ({ sse: [chunk({ role: 'assistant', content: '**Sure**, I will.{"function":"send_to_chat","arguments":{"message":"hi **there**"}}' }), chunk({}, 'stop')] });
    const res = await post(withTools);
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = sseEvents(text);
    expect(events.map((e) => e.choices[0].delta.content ?? '').join('')).toBe('Sure, I will.');
    const calls = events.flatMap((e) => e.choices[0].delta.tool_calls ?? []);
    expect(calls).toHaveLength(1);
    expect(calls[0].function).toEqual({ name: 'send_to_chat', arguments: '{"message":"hi **there**"}' });
    expect(events[events.length - 1].choices[0].finish_reason).toBe('tool_calls');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('answers with silence, without asking the model, after a function that changes the call', async () => {
    gw.respond = () => streamed('First question: can you explain service discovery?');
    const handoff = {
      ...withTools,
      messages: [
        { role: 'user', content: "let's do a mock interview on homework three" },
        { role: 'assistant', content: null, tool_calls: [{ id: 'fc1', type: 'function', function: { name: 'start_interview', arguments: '{"topic":"homework 3"}' } }] },
        { role: 'tool', tool_call_id: 'fc1', content: '{"status":"switching to interview mode","note":"say nothing more [[handoff]]"}' },
      ],
    };
    const res = await post(handoff);
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text());
    expect(events.map((e) => e.choices[0].delta.content ?? '').join('')).toBe('');
    expect(events[events.length - 1].choices[0].finish_reason).toBe('stop');
    expect(gw.requests).toHaveLength(0);
    // an ordinary function result is answered by the model as usual
    const ordinary = { ...handoff, messages: [...handoff.messages.slice(0, 2), { role: 'tool', tool_call_id: 'fc1', content: '{"status":"done"}' }] };
    expect(sseEvents(await (await post(ordinary)).text()).map((e) => e.choices[0].delta.content ?? '').join('')).toContain('First question');
    expect(gw.requests).toHaveLength(1);
  });

  it('does not make a call of text that names a function the request did not offer', async () => {
    gw.respond = () => ({ sse: [chunk({ role: 'assistant', content: 'Ok.{"function":"delete_everything","arguments":{}}' }), chunk({}, 'stop')] });
    const events = sseEvents(await (await post(withTools)).text());
    expect(events.map((e) => e.choices[0].delta.content ?? '').join('')).toBe('Ok.');
    expect(events.flatMap((e) => e.choices[0].delta.tool_calls ?? [])).toHaveLength(0);
    expect(events[events.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('lets one answer say two sentences at most and nothing after a question: a monologue of the model is not spoken', async () => {
    const monologue = 'Okay, a server times out and asks for votes, and if most say yes it becomes leader, clear?Great, what part is confusing?{"concept":"Raft"}Want a diagram?We need to call query piazza.I put a diagram in the chat.';
    gw.respond = () => ({ sse: [chunk({ role: 'assistant', content: monologue }), chunk({}, 'stop')] });
    const events = sseEvents(await (await post(withTools)).text());
    expect(events.map((e) => e.choices[0].delta.content ?? '').join('')).toBe('Okay, a server times out and asks for votes, and if most say yes it becomes leader, clear?');
  });

  it('does not let a sentence say something is in the chat when nothing went there, and tells the session; it does when something did', async () => {
    const told: string[] = [];
    const relay = createRelay({ tokens, isLive: () => true, upstreamUrl: `${gw.url}/v1/chat/completions`, upstreamKey: KEY, model: 'gpt-oss', maxTokens: 400, now: () => clock, onClaimDropped: (s) => told.push(s) });
    const claiming = http.createServer((req, res) => void relay(req, res));
    await new Promise<void>((r) => claiming.listen(0, '127.0.0.1', () => r()));
    const ask = async (messages: unknown[]) => {
      const res = await fetch(`http://127.0.0.1:${(claiming.address() as AddressInfo).port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.mint(sid, clock + 60_000)}` },
        body: JSON.stringify({ ...withTools, messages }),
      });
      return sseEvents(await res.text()).map((e) => e.choices[0].delta.content ?? '').join('');
    };
    try {
      gw.respond = () => ({ sse: [chunk({ role: 'assistant', content: 'It is due on Friday.I put it in the chat.' }), chunk({}, 'stop')] });
      expect(await ask([{ role: 'user', content: 'when is it due?' }])).toBe('It is due on Friday.');
      expect(told).toEqual([sid]);
      expect(
        await ask([
          { role: 'user', content: 'put it in the chat' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_to_chat', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: 'It is in the chat now.' },
        ]),
      ).toBe('It is due on Friday. I put it in the chat.');
      expect(told).toHaveLength(1);
    } finally {
      (claiming as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => claiming.close(() => r()));
    }
  });

  it('lets the call\'s mode set what an answer may say on top of the usual limits, asked with every request; a mode that fails changes nothing', async () => {
    const asked: Array<{ sid: string; messages: unknown }> = [];
    let limits: Record<string, number> | undefined;
    let fail = false;
    const serve = async (speech: Record<string, number> | false) => {
      const relay = createRelay({
        tokens,
        isLive: () => true,
        upstreamUrl: `${gw.url}/v1/chat/completions`,
        upstreamKey: KEY,
        model: 'gpt-oss',
        maxTokens: 400,
        now: () => clock,
        speech,
        speechFor: (s, messages) => {
          asked.push({ sid: s, messages });
          if (fail) throw new Error('the session is gone');
          return limits;
        },
      });
      const server = http.createServer((req, res) => void relay(req, res));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const ask = async () => {
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.mint(sid, clock + 60_000)}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'so a leader needs votes' }] }),
        });
        return sseEvents(await res.text()).map((e) => e.choices[0].delta.content ?? '').join('');
      };
      const close = async () => {
        (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
      };
      return { ask, close };
    };
    gw.respond = () => ({ sse: [chunk({ role: 'assistant', content: 'Right, votes decide it. And a majority is what counts.' }), chunk({}, 'stop')] });
    const usual = await serve({ maxSentences: 2, maxWords: 40 });
    try {
      expect((await usual.ask()).trim()).toBe('Right, votes decide it. And a majority is what counts.');
      limits = { maxSentences: 1 };
      expect((await usual.ask()).trim()).toBe('Right, votes decide it.'); // this call's mode allows a sentence
      expect(asked.at(-1)).toMatchObject({ sid, messages: [{ role: 'user', content: 'so a leader needs votes' }] });
      fail = true;
      expect((await usual.ask()).trim()).toBe('Right, votes decide it. And a majority is what counts.'); // a mode that throws leaves the usual limits
    } finally {
      await usual.close();
    }
    // with the governor off nothing is asked and nothing is cut
    const before = asked.length;
    fail = false;
    const off = await serve(false);
    try {
      expect((await off.ask()).trim()).toBe('Right, votes decide it. And a majority is what counts.');
      expect(asked).toHaveLength(before);
    } finally {
      await off.close();
    }
  });

  it('writes one line per request to the diagnostic file when it is switched on, and nothing otherwise', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dump-'));
    const file = path.join(dir, 'dump.jsonl');
    const relay = createRelay({ tokens, isLive: () => true, upstreamUrl: `${gw.url}/v1/chat/completions`, upstreamKey: KEY, model: 'gpt-oss', maxTokens: 400, now: () => clock, dumpFile: file });
    const dumping = http.createServer((req, res) => void relay(req, res));
    await new Promise<void>((r) => dumping.listen(0, '127.0.0.1', () => r()));
    try {
      gw.respond = () => ({ sse: [chunk({ role: 'assistant', content: '**Hi** there{"function":"send_to_chat","arguments":{"message":"m"}}' }), chunk({}, 'stop')] });
      const res = await fetch(`http://127.0.0.1:${(dumping.address() as AddressInfo).port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.mint(sid, clock + 60_000)}` },
        body: JSON.stringify({ ...withTools, messages: [{ role: 'system', content: 'S'.repeat(5000) }, { role: 'user', content: 'what is raft?' }], extra: 1 }),
      });
      await res.text();
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.request.fields).toContain('extra');
      expect(record.request.tools).toEqual(['send_to_chat']);
      expect(record.request.messages[0]).toMatchObject({ role: 'system', chars: 5000 });
      expect(record.request.messages[0].content.length).toBeLessThan(400);
      expect(record.answer).toMatchObject({ finish: 'stop', text: '**Hi** there{"function":"send_to_chat","arguments":{"message":"m"}}', spoken: 'Hi there' });
      expect(record.answer.writtenAsText).toEqual([{ name: 'send_to_chat', arguments: '{"message":"m"}' }]);
      expect(JSON.stringify(record)).not.toContain(KEY);
    } finally {
      (dumping as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => dumping.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
