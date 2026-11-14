import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { think, ThinkError } from './think.js';

let server: http.Server | null = null;
afterEach(async () => {
  if (server) {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<string> {
  server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(parts).toString()));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/voice-llm/v1/chat/completions`;
}

const base = { model: 'voice', messages: [{ role: 'user' as const, content: 'hi' }], clock: () => performance.now() };

describe('think', () => {
  it('streams the words as they come and reports the finish', async () => {
    let received = '';
    const url = await listen((req, res, body) => {
      received = body;
      expect(req.headers.authorization).toBe('Bearer tok');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: 'Raft elects a leader. ' }));
      setTimeout(() => {
        res.write(chunk({ content: 'Then it sends heartbeats.' }));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }, 30);
    });
    const pieces: string[] = [];
    const r = await think({ ...base, url, headers: { authorization: 'Bearer tok' }, signal: new AbortController().signal, temperature: 0.7, onText: (p) => pieces.push(p) });
    expect(pieces).toEqual(['Raft elects a leader. ', 'Then it sends heartbeats.']);
    expect(r.text).toBe('Raft elects a leader. Then it sends heartbeats.');
    expect(r.finish).toBe('stop');
    expect(r.toolCalls).toEqual([]);
    expect(r.firstTokenAt).not.toBeNull();
    expect(JSON.parse(received)).toMatchObject({ model: 'voice', stream: true, temperature: 0.7, messages: [{ role: 'user', content: 'hi' }] });
  });

  it('assembles tool calls from pieces, by index, and gives them ids when the model left one out', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: 'Let me check. ' }));
      res.write(chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'query_canvas', arguments: '{"action":' } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"find"}' } }] }));
      res.write(chunk({ tool_calls: [{ index: 1, function: { name: 'recall_memory', arguments: '{}' } }] }));
      res.write(chunk({}, 'tool_calls'));
      res.end('data: [DONE]\n\n');
    });
    const r = await think({ ...base, url, headers: {}, signal: new AbortController().signal, tools: [{ type: 'function', function: { name: 'query_canvas' } }] });
    expect(r.finish).toBe('tool_calls');
    expect(r.text).toBe('Let me check. ');
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[0]).toEqual({ id: 'call_a', name: 'query_canvas', arguments: '{"action":"find"}' });
    expect(r.toolCalls[1].name).toBe('recall_memory');
    expect(r.toolCalls[1].id).toMatch(/^call_1_/);
  });

  it('copes with lines split across network chunks and with no [DONE]', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const all = chunk({ content: 'Hello there.' }) + chunk({}, 'stop');
      res.write(all.slice(0, 20));
      setTimeout(() => {
        res.write(all.slice(20, 70));
        setTimeout(() => res.end(all.slice(70)), 10);
      }, 10);
    });
    const r = await think({ ...base, url, headers: {}, signal: new AbortController().signal });
    expect(r.text).toBe('Hello there.');
    expect(r.finish).toBe('stop');
  });

  it('an empty answer is an answer (the relay\'s silence after a handoff)', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
    const r = await think({ ...base, url, headers: {}, signal: new AbortController().signal });
    expect(r.text).toBe('');
    expect(r.toolCalls).toEqual([]);
    expect(r.firstTokenAt).toBeNull();
  });

  it('an HTTP error is an error with the status and nothing of the body', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"the language model is unavailable"}}');
    });
    const err = await think({ ...base, url, headers: {}, signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ThinkError);
    expect(err.kind).toBe('http');
    expect(err.status).toBe(502);
    expect(String(err.message)).not.toContain('unavailable');
  });

  it('an error inside the stream is an error of the model', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: 'Well' }));
      res.end('data: {"error":{"message":"the language model failed"}}\n\n');
    });
    const err = await think({ ...base, url, headers: {}, signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ThinkError);
    expect(err.kind).toBe('model');
  });

  it('an abort ends the request at once and is told apart from a failure', async () => {
    let open = true;
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: 'Starting ' }));
      res.on('close', () => (open = false));
    });
    const c = new AbortController();
    const t0 = performance.now();
    setTimeout(() => c.abort(), 80);
    const err = await think({ ...base, url, headers: {}, signal: c.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ThinkError);
    expect(err.kind).toBe('aborted');
    expect(performance.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(open).toBe(false);
    // an already aborted signal never sends
    const done = new AbortController();
    done.abort();
    expect((await think({ ...base, url, headers: {}, signal: done.signal }).catch((e) => e)).kind).toBe('aborted');
  });

  it('a closed port is a network error', async () => {
    const err = await think({ ...base, url: 'http://127.0.0.1:1/v1', headers: {}, signal: new AbortController().signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ThinkError);
    expect(err.kind).toBe('network');
  });
});
