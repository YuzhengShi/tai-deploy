/**
 * The relay's screen note (relay.ts `screenFor`, docs/VIEWER_VOICE.md "The relay"): for one request only, a system message right before the last user message, after the question has been put
 * last and before the gateway is asked; nothing added to what Deepgram keeps; none for a request that is answered with silence; the caps on a request still hold; and the diagnostic dump records
 * how long the note was and never what it said.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_MESSAGES, RelayTokens, SCREEN_NOTE_MAX_CHARS, createRelay, withScreenNote } from './relay.js';
import type { RelayOptions } from './relay.js';
import { HANDOFF_MARK } from './prompts.js';
import { FakeGateway, streamed } from './testing/fake-gateway.js';

const tokens = new RelayTokens(crypto.randomBytes(32));
const sid = 'Session0123456789abcdef';
const NOTE = 'THEIR SCREEN, as of just now (only what is open in this chat page, not their whole screen):\n- The document "Raft slides" is open in their viewer at page 7 of 32.';

type Msg = { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };
const sys = (content: string): Msg => ({ role: 'system', content });
const user = (content: string): Msg => ({ role: 'user', content });
const bot = (content: string): Msg => ({ role: 'assistant', content });
const call = (id: string): Msg => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'query_canvas', arguments: '{}' } }] });
const tool = (id: string, content: string): Msg => ({ role: 'tool', tool_call_id: id, content });

describe('withScreenNote', () => {
  it('puts the note right before the last user message and nowhere else', () => {
    expect(withScreenNote([sys('p'), bot('hi'), user('what is this?')], NOTE)).toEqual([sys('p'), bot('hi'), sys(NOTE), user('what is this?')]);
    // with an earlier user message, the last one is the one
    expect(withScreenNote([sys('p'), user('q1'), bot('a1'), user('q2')], NOTE)).toEqual([sys('p'), user('q1'), bot('a1'), sys(NOTE), user('q2')]);
    // a function result after the question: the note goes in front of the question, so the call and its result stay together
    const afterTool = withScreenNote([sys('p'), user('q'), call('c1'), tool('c1', '{}')], NOTE) as Msg[];
    expect(afterTool).toEqual([sys('p'), sys(NOTE), user('q'), call('c1'), tool('c1', '{}')]);
  });

  it('adds nothing when there is no user message, no note, nothing to add it to, or this very note is there', () => {
    const only = [sys('p'), bot('hi')];
    expect(withScreenNote(only, NOTE)).toBe(only);
    const plain = [sys('p'), user('q')];
    expect(withScreenNote(plain, '')).toBe(plain);
    expect(withScreenNote(plain, '   \n ')).toBe(plain);
    expect(withScreenNote('not messages', NOTE)).toBe('not messages');
    const has = [sys('p'), sys(NOTE), user('q')];
    expect(withScreenNote(has, NOTE)).toBe(has);                     // never twice
  });

  it('clips a note that is too long, and never takes a request past the most messages', () => {
    const long = withScreenNote([user('q')], 'x'.repeat(SCREEN_NOTE_MAX_CHARS + 500)) as Msg[];
    expect(String(long[0].content)).toHaveLength(SCREEN_NOTE_MAX_CHARS);
    expect(String(long[0].content).endsWith('…')).toBe(true);
    const almost = Array.from({ length: MAX_MESSAGES - 1 }, (_, i) => (i % 2 ? bot(`a${i}`) : user(`q${i}`)));
    expect((withScreenNote(almost, NOTE) as Msg[]).length).toBe(MAX_MESSAGES);
    const full = Array.from({ length: MAX_MESSAGES }, (_, i) => (i % 2 ? bot(`a${i}`) : user(`q${i}`)));
    expect(withScreenNote(full, NOTE)).toBe(full);
  });
});

describe('the relay with a screen note', () => {
  let gw: FakeGateway;
  let server: http.Server;
  let base: string;
  let asked: string[];
  let note: string | undefined | (() => string | undefined);
  let clock = 1_000_000;
  let dir: string;
  const live = new Set<string>([sid]);

  async function serve(extra: Partial<RelayOptions> = {}): Promise<void> {
    const relay = createRelay({
      tokens,
      isLive: (s) => live.has(s),
      upstreamUrl: `${gw.url}/v1/chat/completions`,
      upstreamKey: 'sk-test',
      model: 'gpt-oss',
      maxTokens: 400,
      now: () => clock,
      maxBodyBytes: 20_000,
      screenFor: (s) => {
        asked.push(s);
        return typeof note === 'function' ? note() : note;
      },
      ...extra,
    });
    server = http.createServer((req, res) => void relay(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/voice-llm/v1/chat/completions`;
  }

  beforeEach(async () => {
    gw = await FakeGateway.start();
    gw.respond = () => streamed('Right, that is the leader election slide.');
    asked = [];
    note = NOTE;
    clock = 1_000_000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-screen-'));
    await serve();
  });

  afterEach(async () => {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await gw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (messages: unknown[], extra: Record<string, unknown> = {}) =>
    fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.mint(sid, clock + 60_000)}` },
      body: JSON.stringify({ model: 'x', messages, ...extra }),
    });
  const sentMessages = (n = 0) => (gw.requests[n].body as { messages: Msg[] }).messages;

  it('adds it as a system message right before the last user message, for the call asked about, after the question has been put last', async () => {
    const res = await post([sys('You are TAi.'), bot('hey'), user('what does this slide say?')]);
    expect(res.status).toBe(200);
    await res.text();
    expect(asked).toEqual([sid]);
    expect(sentMessages()).toEqual([sys('You are TAi.'), bot('hey'), sys(NOTE), user('what does this slide say?')]);
    // a prompt update that landed after the question is moved in front of it (questionLast) and the note goes between: the question is still the last thing the model reads
    gw.requests.length = 0;
    await (await post([sys('You are TAi (interviewer).'), bot('nice'), user('what is this?'), sys('You are TAi, a fellow TA.')])).text();
    expect(sentMessages().map((m) => `${m.role}: ${String(m.content).slice(0, 12)}`)).toEqual(['system: You are TAi ', 'assistant: nice', 'system: You are TAi,', 'system: THEIR SCREEN', 'user: what is this']);
  });

  it('keeps a function call and its result together, with the note in front of the question they answer', async () => {
    await (await post([sys('p'), user('when is it due?'), call('c1'), tool('c1', '{"due":"Friday"}')])).text();
    const sent = sentMessages();
    expect(sent.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'tool']);
    expect(sent[1].content).toBe(NOTE);
    expect(sent[3].tool_calls).toBeTruthy();
    expect(sent[4]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it('adds nothing, and the gateway gets what it always got, when there is no note (none to tell, or a listener that fails)', async () => {
    const messages = [sys('p'), user('hello')];
    for (const none of [undefined, '', () => { throw new Error('the store is down'); }] as Array<string | undefined | (() => string | undefined)>) {
      note = none;
      gw.requests.length = 0;
      const res = await post(messages);
      expect(res.status).toBe(200);
      await res.text();
      expect(sentMessages()).toEqual(messages);
    }
  });

  it('is made again for every request and never kept: the same history sent twice gets one note each time, and a changed note is the new one', async () => {
    const history = [sys('p'), user('q1'), bot('a1'), user('q2')];
    await (await post(history)).text();
    await (await post(history)).text();
    note = NOTE.replace('page 7', 'page 8');
    await (await post(history)).text();
    for (const n of [0, 1, 2]) expect(sentMessages(n).filter((m) => m.role === 'system' && String(m.content).startsWith('THEIR SCREEN'))).toHaveLength(1);
    expect(String(sentMessages(2)[3].content)).toContain('page 8 of 32');
    // a note that is already in what Deepgram sent is not put in a second time
    gw.requests.length = 0;
    await (await post([sys('p'), sys(NOTE), user('q')])).text();
    expect(sentMessages().filter((m) => m.content === NOTE)).toHaveLength(1);
  });

  it('is not asked for, and the gateway is not asked, after a function that changes the call: the answer is silence', async () => {
    const res = await post([sys('p'), user('start'), call('c9'), tool('c9', `ok ${HANDOFF_MARK}`)]);
    const text = await res.text();
    expect(text).toContain('chatcmpl-silence');
    expect(asked).toEqual([]);
    expect(gw.requests).toHaveLength(0);
  });

  it('adds nothing to a request that has no user message to put it in front of', async () => {
    await (await post([sys('p'), bot('hello')])).text();
    expect(sentMessages()).toEqual([sys('p'), bot('hello')]);
  });

  it('leaves the caps on a request as they were: the most messages, and the size of the body', async () => {
    const pad = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? sys(`s${i}`) : bot(`a${i}`)));
    // 499 messages and the note: 500 go to the gateway
    await (await post([...pad(MAX_MESSAGES - 2), user('q')])).text();
    expect(sentMessages(0)).toHaveLength(MAX_MESSAGES);
    expect(sentMessages(0).filter((m) => m.content === NOTE)).toHaveLength(1);
    // 500 messages: the request is let through, and the note is the one thing left out, so that what goes to the gateway never has more than 500
    gw.requests.length = 0;
    await (await post([...pad(MAX_MESSAGES - 1), user('q')])).text();
    expect(sentMessages(0)).toHaveLength(MAX_MESSAGES);
    expect(sentMessages(0).some((m) => m.content === NOTE)).toBe(false);
    // 501: refused as before
    gw.requests.length = 0;
    expect((await post([...pad(MAX_MESSAGES), user('q')])).status).toBe(400);
    expect(gw.requests).toHaveLength(0);
    // a body over the size limit is refused as before; one that leaves no room for the note goes without it
    const big = await post([sys('p'), user('x'.repeat(21_000))]);
    expect(big.status).toBe(413);
    gw.requests.length = 0;
    const room = 20_000 - JSON.stringify({ model: 'x', messages: [sys('p'), user('')] }).length;
    note = 'N'.repeat(500);
    await (await post([sys('p'), user('y'.repeat(room - 100))])).text();
    expect(sentMessages(0).some((m) => m.content === note)).toBe(false);
    expect(sentMessages(0)).toHaveLength(2);
    await (await post([sys('p'), user('y'.repeat(room - 2_000))])).text();
    expect(sentMessages(1).some((m) => m.content === note)).toBe(true);
  });

  it('clips what it is given to the longest note it puts in', async () => {
    note = 'z'.repeat(SCREEN_NOTE_MAX_CHARS * 2);
    await (await post([sys('p'), user('q')])).text();
    expect(String(sentMessages()[1].content)).toHaveLength(SCREEN_NOTE_MAX_CHARS);
  });

  it('never puts the note in the diagnostic dump: its length is there, its words are not, and the messages are what Deepgram sent', async () => {
    await (async () => {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    })();
    const file = path.join(dir, 'dump.jsonl');
    const secret = 'Leader election in Raft SECRET-DOCUMENT-WORDS';
    note = `THEIR SCREEN, as of just now:\n- The document "Raft" is open at page 7 of 32.\nTEXT OF PAGE 7: ${secret}`;
    await serve({ dumpFile: file });
    await (await post([sys('S'.repeat(500)), user('what is this?')])).text();
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain('SECRET-DOCUMENT-WORDS');
    expect(text).not.toContain('THEIR SCREEN');
    const record = JSON.parse(text.trim().split('\n')[0]);
    expect(record.request.screen_note_chars).toBe((note as string).length);
    expect(record.request.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    // and a request that got no note says nothing about one
    fs.rmSync(file);
    note = undefined;
    await (await post([sys('S'), user('hello')])).text();
    expect(JSON.parse(fs.readFileSync(file, 'utf-8').trim().split('\n')[0]).request).not.toHaveProperty('screen_note_chars');
  });

  it('does not touch the answer: what the model says goes through the same filters', async () => {
    gw.respond = () => streamed('Sure. That is **leader election**.');
    const res = await post([sys('p'), user('what is this?')]);
    const text = await res.text();
    expect(text).toContain('That is leader election.');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });
});
