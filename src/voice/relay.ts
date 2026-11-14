/**
 * The Think step's way back in. Deepgram's Voice Agent calls a custom LLM endpoint for every turn: ours is
 * POST <publicBase>/voice-llm/v1/chat/completions, reachable from the internet, with the bearer token the call's Settings carried.
 * This module checks that token, rewrites the request into exactly what the gateway (LiteLLM -> Cerebras) should get, and streams the
 * answer back. Every byte of the request is treated as hostile: the token is checked before the body is read, the body is capped, and
 * only the fields named here reach the gateway, with the model, the stream flag and the token cap set by us.
 *
 *   token   v1.<sid>.<expiresAtMs>.<hmac>   HMAC-SHA256 over "v1.<sid>.<expiresAtMs>" with a key derived (HKDF, label tai-voice-relay)
 *           from the portal's secret file, so it is good for one live call, until the call's end plus five minutes.
 *   limits  120 requests a minute and 4 at once per call, 1 MB of body.
 *   errors  plain JSON {error:{message}}, never the gateway's own words: they can name the real model host, and Deepgram may log them.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';

import { RateLimiter } from '../portal/auth.js';
import { chatSentThisTurn } from './chat-claim.js';
import { HANDOFF_MARK, SYSTEM_NOTE } from './prompts.js';
import { SseSpeechTransform } from './speech-filter.js';
import type { GovernorOptions } from './speech-governor.js';
import type { VoiceLog } from './types.js';
import { silentLog } from './types.js';

const TOKEN = /^v1\.([A-Za-z0-9_-]{16,64})\.(\d{1,16})\.([0-9a-f]{64})$/;

export class RelayTokens {
  private readonly key: Buffer;

  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error('the relay secret must be at least 32 bytes');
    // domain separation: the portal's cookie HMAC uses the secret itself; the relay uses a key derived from it for this purpose only
    this.key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'tai-voice-relay', 32));
  }

  private sign(body: string): string {
    return crypto.createHmac('sha256', this.key).update(body).digest('hex');
  }

  mint(sid: string, expiresAtMs: number): string {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(sid)) throw new Error('bad session id');
    const body = `v1.${sid}.${Math.floor(expiresAtMs)}`;
    return `${body}.${this.sign(body)}`;
  }

  /** The session id the token is for, or null (malformed, forged, expired). */
  verify(token: string | undefined, now: number): string | null {
    if (typeof token !== 'string' || token.length > 200) return null;
    const m = TOKEN.exec(token);
    if (!m) return null;
    const expected = Buffer.from(this.sign(`v1.${m[1]}.${m[2]}`), 'utf-8');
    const given = Buffer.from(m[3], 'utf-8');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    if (Number(m[2]) < now) return null;
    return m[1];
  }
}

export function newSessionId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// ---------------------------------------------------------------- the request the gateway gets

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
/** The most messages a request may have (a longer one is refused, and the screen note is never what takes one past it). */
export const MAX_MESSAGES = 500;
/** The longest screen note the relay puts into a request, whatever it is given (describeView's own limit is 2,000 characters). */
export const SCREEN_NOTE_MAX_CHARS = 2_400;

function cleanContent(content: unknown): unknown {
  if (typeof content === 'string' || content === null) return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((p) => p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => ({ type: 'text', text: (p as { text: string }).text }));
    return parts;
  }
  return undefined;
}

function cleanToolCalls(calls: unknown): unknown[] | undefined {
  if (!Array.isArray(calls)) return undefined;
  const out: unknown[] = [];
  for (const c of calls.slice(0, 16)) {
    if (!c || typeof c !== 'object') continue;
    const call = c as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof call.id !== 'string' || !call.function || typeof call.function.name !== 'string') continue;
    out.push({
      id: call.id.slice(0, 128),
      type: 'function',
      function: { name: call.function.name.slice(0, 64), arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) },
    });
  }
  return out.length ? out : undefined;
}

function cleanTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out = tools
    .slice(0, 64)
    .filter(
      (t) =>
        t &&
        typeof t === 'object' &&
        (t as { type?: unknown }).type === 'function' &&
        (t as { function?: { name?: unknown } }).function &&
        typeof (t as { function: { name?: unknown } }).function.name === 'string',
    )
    .map((t) => {
      const fn = (t as { function: { name: string; description?: unknown; parameters?: unknown } }).function;
      return {
        type: 'function',
        function: {
          name: fn.name.slice(0, 64),
          ...(typeof fn.description === 'string' ? { description: fn.description.slice(0, 4000) } : {}),
          ...(fn.parameters && typeof fn.parameters === 'object' ? { parameters: fn.parameters } : {}),
        },
      };
    });
  return out.length ? out : undefined;
}

function cleanToolChoice(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice && typeof choice === 'object' && (choice as { type?: unknown }).type === 'function') {
    const name = (choice as { function?: { name?: unknown } }).function?.name;
    if (typeof name === 'string') return { type: 'function', function: { name: name.slice(0, 64) } };
  }
  return undefined;
}

/**
 * The body the gateway gets: only messages, tools, tool_choice, temperature, max_tokens, stream and (with tools) parallel_tool_calls,
 * with model = TAI_VOICE_MODEL, stream = true and max_tokens at most the clamp (max_completion_tokens counts as max_tokens). Null when
 * it is not a chat request at all. Message fields other than role, content, name, tool_calls and tool_call_id are dropped (a replayed
 * `reasoning` field is one the gateway refuses).
 */
/**
 * Deepgram puts the message of a prompt update after whatever was said before the update landed. When that was the student's question (they
 * spoke before the switch back from an interview had finished), the model's last message is the system prompt and not the question, and it
 * answers the prompt: in the owner's call of 2026-11-02 22:47 "Can you see canvas?" was answered with this week's deadlines. A system message
 * at the end of the history goes in front of the student's lines that come right before it; a history that ends in anything else is left alone.
 */
export function questionLast(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const roleAt = (i: number) => (messages[i] as { role?: unknown } | null)?.role;
  let end = messages.length;
  while (end > 0 && roleAt(end - 1) === 'system') end--;
  if (end === messages.length || end === 0) return messages;
  let start = end;
  while (start > 0 && roleAt(start - 1) === 'user') start--;
  if (start === end) return messages;
  return [...messages.slice(0, start), ...messages.slice(end), ...messages.slice(start, end)];
}

/**
 * The messages with the note about the student's screen (screen.ts) as a system message right before the LAST user message, for this request only: nothing of it is in Deepgram's own
 * conversation (it never accumulates, and an UpdatePrompt, which appends for good, is not used). Put after `questionLast` has run, so that the question stays last, and before the last
 * user line, so that an assistant message with its function calls and the tool message that answers it stay together and the prefix of the request is the same from one turn to the next. Nothing
 * is added when there is no user message to attach it to, when the request already has this very note, or when it would take the request past MAX_MESSAGES. The note is clipped to SCREEN_NOTE_MAX_CHARS.
 */
export function withScreenNote(messages: unknown, note: string): unknown {
  if (!Array.isArray(messages) || !note.trim() || messages.length >= MAX_MESSAGES) return messages;
  const text = note.length > SCREEN_NOTE_MAX_CHARS ? note.slice(0, SCREEN_NOTE_MAX_CHARS - 1) + '…' : note;
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: unknown } | null)?.role === 'user') {
      at = i;
      break;
    }
  }
  if (at < 0) return messages;
  if (messages.some((m) => (m as { role?: unknown; content?: unknown } | null)?.role === 'system' && (m as { content?: unknown }).content === text)) return messages;
  return [...messages.slice(0, at), { role: 'system', content: text }, ...messages.slice(at)];
}

export function rewriteChatRequest(body: unknown, opts: { model: string; maxTokens: number }): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MAX_MESSAGES) return null;
  const messages: Record<string, unknown>[] = [];
  for (const raw of b.messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.role !== 'string' || !ROLES.has(m.role)) return null;
    const out: Record<string, unknown> = { role: m.role };
    const content = cleanContent(m.content);
    if (content !== undefined) out.content = content;
    if (typeof m.name === 'string') out.name = m.name.slice(0, 64);
    const toolCalls = m.role === 'assistant' ? cleanToolCalls(m.tool_calls) : undefined;
    if (toolCalls) out.tool_calls = toolCalls;
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') out.tool_call_id = m.tool_call_id.slice(0, 128);
    if (out.content === undefined && !toolCalls) out.content = '';
    messages.push(out);
  }
  const asked = [b.max_tokens, b.max_completion_tokens].map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)).find((v) => v > 0);
  const out: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true,
    max_tokens: Math.min(asked || opts.maxTokens, opts.maxTokens),
  };
  const tools = cleanTools(b.tools);
  if (tools) {
    out.tools = tools;
    out.parallel_tool_calls = false; // one function at a time: the call's functions are sequential by nature (and a mode switch is one of them)
    const choice = cleanToolChoice(b.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }
  if (typeof b.temperature === 'number' && Number.isFinite(b.temperature)) out.temperature = Math.max(0, Math.min(2, b.temperature));
  return out;
}

// ---------------------------------------------------------------- the handler

export interface RelayOptions {
  tokens: RelayTokens;
  /** Is this session id a call that is on right now? */
  isLive: (sid: string) => boolean;
  /** The gateway's chat completions URL (config.chatCompletionsUrl(TAI_VOICE_LLM_URL)). */
  upstreamUrl: string;
  upstreamKey: string;
  model: string;
  maxTokens: number;
  now?: () => number;
  log?: VoiceLog;
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  perMinute?: number;
  maxInFlight?: number;
  timeoutMs?: number;
  /** Told about every request that passed the checks (the session counts its turns). */
  onRequest?: (sid: string) => void;
  /**
   * A diagnostic, off unless set (TAI_VOICE_RELAY_DUMP): one JSON line per request, appended to this file: what Deepgram sent (the messages,
   * cut short) and what the model answered (its text and calls as they came, before the speech filter). It holds the student's words:
   * for finding out why a call went wrong, then removed.
   */
  dumpFile?: string;
  /** Answer the model's turn after a function that changes the call (start_interview, end_interview, end_session) with silence. Default on. */
  muteHandoff?: boolean;
  /** How much one answer may say (speech-governor.ts): the limits, or false to speak whatever the model says. Default: two sentences, 40 words, nothing after a question. */
  speech?: Partial<GovernorOptions> | false;
  /**
   * What this call's mode allows on top of `speech` (a talk-it-through is mostly nudges, then feedback): asked at every request, with the
   * messages Deepgram sent, so that it can follow the call.
   */
  speechFor?: (sid: string, messages: unknown) => Partial<GovernorOptions> | undefined;
  /** The model for this call's next request when it is not `model` (a talk-it-through has its own): asked at every request. */
  modelFor?: (sid: string) => string | undefined;
  /**
   * The note about what the student has open and selected on their page (screen.ts, docs/CHAT_OBJECTS.md "The view"), asked at every request that goes to the model: when it returns text it is put
   * into THAT request as a system message right before the last user message (`withScreenNote`), and nowhere else. Nothing is added to Deepgram's own context, and the diagnostic dump
   * records only its length. A listener that throws leaves the turn without a note.
   */
  screenFor?: (sid: string) => string | undefined;
  /** Told when an answer said something was in the chat and nothing had gone there (the sentence was not spoken). */
  onClaimDropped?: (sid: string) => void;
}

/** Is the last message the result of a function that changes the call (it carries the HANDOFF_MARK)? */
export function endsInHandoff(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown };
  if (last.role !== 'tool') return false;
  const text = typeof last.content === 'string' ? last.content : Array.isArray(last.content) ? last.content.map((p) => (p as { text?: unknown }).text ?? '').join('') : '';
  return text.includes(HANDOFF_MARK);
}

const clipText = (value: unknown, max: number): string | null => (typeof value === 'string' ? (value.length > max ? `${value.slice(0, max)}... [${value.length} characters]` : value) : null);

/** What goes into the diagnostic for a request: the roles and the first words of each message, never the system prompt in full. */
function describeRequest(sent: Record<string, unknown>, received: unknown): Record<string, unknown> {
  const messages = Array.isArray(sent.messages) ? (sent.messages as Array<Record<string, unknown>>) : [];
  return {
    fields: received && typeof received === 'object' ? Object.keys(received as object) : [],
    max_tokens: sent.max_tokens,
    temperature: sent.temperature,
    tool_choice: sent.tool_choice,
    tools: Array.isArray(sent.tools) ? (sent.tools as Array<{ function?: { name?: unknown } }>).map((t) => t.function?.name) : [],
    messages: messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? clipText(m.content, m.role === 'system' ? 300 : 700) : m.content === null ? null : '[parts]',
      ...(Array.isArray(m.tool_calls) ? { tool_calls: (m.tool_calls as Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>).map((c) => ({ id: c.id, name: c.function?.name, arguments: clipText(c.function?.arguments, 300) })) } : {}),
      ...(typeof m.tool_call_id === 'string' ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.role === 'system' ? { chars: typeof m.content === 'string' ? m.content.length : 0 } : {}),
    })),
  };
}

const SSE_ERROR = 'data: {"error":{"message":"the language model failed"}}';

/** A data line of the stream that carries an error is replaced by a plain one; everything else passes untouched. */
export function scrubSseLine(line: string): string {
  if (!line.startsWith('data:') || !line.includes('"error"')) return line;
  const payload = line.slice(5).trim();
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (value && typeof value === 'object' && 'error' in value) return SSE_ERROR;
  } catch {
    /* not JSON: leave it to the client */
  }
  return line;
}

function reply(res: http.ServerResponse, status: number, message: string, close = false): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ error: { message } });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | 'too-large' | 'aborted'> {
  return new Promise((resolve) => {
    const declared = parseInt(String(req.headers['content-length'] || ''), 10);
    if (Number.isFinite(declared) && declared > max) {
      req.resume(); // drain and drop: closing under a sender that is still sending would cut our 413 off
      return resolve('too-large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        chunks.length = 0;
        resolve('too-large');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve('aborted');
      }
    });
    req.on('aborted', () => {
      if (!done) {
        done = true;
        resolve('aborted');
      }
    });
  });
}

export function createRelay(opts: RelayOptions): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? silentLog;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limiter = new RateLimiter(opts.perMinute ?? 120, 60_000, now);
  const inFlight = new Map<string, number>();
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;

  return async (req, res) => {
    try {
      if (req.method !== 'POST') return reply(res, 405, 'method not allowed');
      const auth = String(req.headers.authorization || '');
      const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
      const sid = opts.tokens.verify(token, now());
      // the body of a request without a good token is never read
      if (!sid || !opts.isLive(sid)) return reply(res, 401, 'unauthorized', true);
      if (!limiter.allow(sid)) return reply(res, 429, 'rate limited', true);
      if ((inFlight.get(sid) ?? 0) >= (opts.maxInFlight ?? 4)) return reply(res, 429, 'too many requests at once', true);
      inFlight.set(sid, (inFlight.get(sid) ?? 0) + 1);
      try {
        await forward(sid, req, res);
      } finally {
        const left = (inFlight.get(sid) ?? 1) - 1;
        if (left > 0) inFlight.set(sid, left);
        else inFlight.delete(sid);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'voice relay failed');
      reply(res, 502, 'the language model is unavailable');
    }
  };

  async function forward(sid: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readBody(req, maxBody);
    if (raw === 'too-large') return reply(res, 413, 'request too large', true);
    if (raw === 'aborted') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      return reply(res, 400, 'not a chat completions request');
    }
    const model = opts.modelFor?.(sid) || opts.model;
    const body = rewriteChatRequest(parsed, { model, maxTokens: opts.maxTokens });
    if (!body) return reply(res, 400, 'not a chat completions request');
    body.messages = questionLast(body.messages);
    opts.onRequest?.(sid);

    if ((opts.muteHandoff ?? true) && endsInHandoff(body.messages)) {
      // an empty answer: the mode that is about to go has nothing to add, and the new one speaks next (the session injects its opening)
      log.debug({ sid: sid.slice(0, 6) }, 'voice relay: silence after a function that changes the call');
      const meta = { id: 'chatcmpl-silence', object: 'chat.completion.chunk', created: Math.floor(now() / 1000), model };
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      res.write(`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...meta, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }

    // what the student has open on their page, for this request only; asked after the silence for a handoff (a request that is not sent needs no note)
    const beforeNote = body.messages;
    let screenChars = 0;
    try {
      const note = opts.screenFor?.(sid);
      if (typeof note === 'string' && note.trim() && raw.length + Buffer.byteLength(note.slice(0, SCREEN_NOTE_MAX_CHARS)) <= maxBody) {
        const withNote = withScreenNote(body.messages, note);
        if (withNote !== body.messages) {
          body.messages = withNote;
          screenChars = Math.min(note.length, SCREEN_NOTE_MAX_CHARS);
        }
      }
    } catch {
      /* a note that cannot be made is a turn without one */
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
    const onClose = () => controller.abort();
    res.on('close', onClose);
    const started = now();
    try {
      let upstream: Response;
      try {
        upstream = await fetchImpl(opts.upstreamUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(opts.upstreamKey ? { authorization: `Bearer ${opts.upstreamKey}` } : {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (res.destroyed) return;
        const timedOut = (err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError';
        log.warn({ sid: sid.slice(0, 6), err: (err as Error).message }, 'voice relay: gateway unreachable');
        return reply(res, timedOut ? 504 : 502, 'the language model is unavailable');
      }
      if (!upstream.ok) {
        let detail = '';
        try {
          detail = (await upstream.text()).slice(0, 300);
        } catch {
          /* nothing to show */
        }
        // our log only: the gateway's words stay here
        log.warn({ sid: sid.slice(0, 6), status: upstream.status, detail }, 'voice relay: gateway refused');
        return reply(res, upstream.status === 429 ? 429 : 502, upstream.status === 429 ? 'rate limited' : 'the language model is unavailable');
      }
      const type = upstream.headers.get('content-type') || '';
      if (!upstream.body) return reply(res, 502, 'the language model is unavailable');
      if (!/text\/event-stream/i.test(type)) {
        // a gateway that answered in one piece: pass it on as JSON, with an error inside it replaced like a streamed one
        const text = (await upstream.text()).slice(0, 4 * 1024 * 1024);
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          return reply(res, 502, 'the language model is unavailable');
        }
        if (value && typeof value === 'object' && 'error' in (value as object)) return reply(res, 502, 'the language model failed');
        const payload = JSON.stringify(value);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
        res.end(payload);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', connection: 'keep-alive' });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let partial = '';
      // what is said is spoken as it arrives: Markdown, list numbers and symbols come out, and a function call the model wrote as text
      // goes on as a real call (speech-filter.ts)
      const toolNames = new Set<string>(Array.isArray(body.tools) ? (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name) : []);
      let forThisCall: Partial<GovernorOptions> | undefined;
      try {
        forThisCall = opts.speech === false ? undefined : opts.speechFor?.(sid, body.messages);
      } catch {
        /* a listener that fails leaves the call's usual limits */
      }
      const speech = new SseSpeechTransform(toolNames, opts.speech === false ? null : { ...(opts.speech ?? {}), ...(forThisCall ?? {}), chatClaimsAllowed: chatSentThisTurn(body.messages, SYSTEM_NOTE) });
      const write = (text: string): Promise<void> | void => {
        if (!text || res.destroyed) return;
        if (!res.write(text)) return new Promise<void>((resolve) => res.once('drain', resolve));
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        const nl = partial.lastIndexOf('\n');
        if (nl === -1) continue;
        const complete = partial.slice(0, nl + 1);
        partial = partial.slice(nl + 1);
        await write(complete.split('\n').flatMap((l) => speech.line(scrubSseLine(l))).join('\n'));
      }
      partial += decoder.decode();
      if (partial) await write(speech.line(scrubSseLine(partial)).join('\n'));
      const rest = speech.close();
      if (rest.length) await write(rest.join('\n') + '\n');
      res.end();
      if (speech.textCalls.length && !speech.madeCalls) {
        log.info({ sid: sid.slice(0, 6), calls: speech.textCalls.map((c) => c.name) }, 'voice relay: the model wrote a function call as text; it was sent on as a call');
      }
      if (speech.dropped.length) log.info({ sid: sid.slice(0, 6), count: speech.dropped.length }, 'voice relay: sentences of the answer were not spoken');
      if (speech.droppedChatClaims) {
        log.warn({ sid: sid.slice(0, 6) }, 'voice relay: the answer said something was in the chat and nothing had been sent; that sentence was not spoken');
        try {
          opts.onClaimDropped?.(sid);
        } catch {
          /* a listener that fails must not fail the answer */
        }
      }
      if (opts.dumpFile) {
        try {
          fs.appendFileSync(
            opts.dumpFile,
            JSON.stringify({
              at: new Date(now()).toISOString(),
              sid: sid.slice(0, 6),
              ms: now() - started,
              // the request as Deepgram sent it, and how long the screen note was: never its text (it holds what a document says)
              request: { ...describeRequest({ ...body, messages: beforeNote }, parsed), ...(screenChars ? { screen_note_chars: screenChars } : {}) },
              answer: { finish: speech.finishReason, text: speech.rawContent, calls: [...speech.rawCalls.values()], writtenAsText: speech.textCalls, spoken: speech.spoken, notSpoken: speech.dropped },
            }) + '\n',
            { mode: 0o600 },
          );
        } catch {
          /* a diagnostic that cannot be written is not worth a failed call */
        }
      }
      log.debug({ sid: sid.slice(0, 6), ms: now() - started }, 'voice relay: answered');
    } catch (err) {
      if (!res.destroyed) {
        log.warn({ sid: sid.slice(0, 6), err: (err as Error).message }, 'voice relay: stream broke');
        reply(res, 502, 'the language model is unavailable');
      }
    } finally {
      clearTimeout(timeout);
      res.off('close', onClose);
    }
  }
}
