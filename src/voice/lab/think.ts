/**
 * The think step of the stand-in: one streamed chat completion against the relay (the hub's own `relay()` behind a loopback listener: src/voice/relay.ts does the rewriting,
 * the speech filter and governor, the handoff silence and the screen note, so a lab turn gets exactly the answer a live one would). The text is handed on as it arrives, the tool
 * calls are assembled, and an abort (the student spoke) ends the request at once.
 */
import type { ChatMessage } from './history.js';
import type { LabClock } from './types.js';

export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

export interface ThinkRequest {
  url: string;
  headers: Record<string, string>;
  model: string;
  temperature?: number;
  tools?: ToolDef[];
  messages: ChatMessage[];
  signal: AbortSignal;
  clock: LabClock;
  fetchImpl?: typeof fetch;
  /** Called with each piece of the answer's words as it arrives (the relay sends sentences; the engine cuts the rest). */
  onText?(piece: string, at: number): void;
  /** A hard stop for a request that never ends. */
  timeoutMs?: number;
}

export interface ThinkCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ThinkResult {
  finish: string;
  text: string;
  toolCalls: ThinkCall[];
  sentAt: number;
  firstTokenAt: number | null;
  doneAt: number;
}

export type ThinkErrorKind = 'http' | 'network' | 'model' | 'aborted';

/** Never carries the gateway's own words, a header or a token: only what kind of failure it was, and the HTTP status the relay answered with. */
export class ThinkError extends Error {
  constructor(
    readonly kind: ThinkErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ThinkError';
  }
}

export async function think(req: ThinkRequest): Promise<ThinkResult> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const sentAt = req.clock();
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (req.signal.aborted) throw new ThinkError('aborted', 'aborted before it was sent');
  req.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), req.timeoutMs ?? 90_000);
  timer.unref?.();
  try {
    let res: Response;
    try {
      res = await fetchImpl(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...req.headers },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.tools?.length ? { tools: req.tools } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw wrap(err, req.signal);
    }
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* nothing to read */
      }
      throw new ThinkError('http', `the relay answered ${res.status}`, res.status);
    }
    if (!res.body) throw new ThinkError('network', 'the relay sent no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finish = '';
    let firstTokenAt: number | null = null;
    const calls = new Map<number, ThinkCall>();
    const line = (raw: string): boolean => {
      const l = raw.trim();
      if (!l.startsWith('data:')) return false;
      const payload = l.slice(5).trim();
      if (payload === '[DONE]') return true;
      let ev: { choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>; error?: unknown };
      try {
        ev = JSON.parse(payload);
      } catch {
        return false;
      }
      if (ev && typeof ev === 'object' && 'error' in ev && ev.error) throw new ThinkError('model', 'the language model failed');
      const choice = ev.choices?.[0];
      if (!choice) return false;
      const delta = choice.delta;
      if (delta && typeof delta.content === 'string' && delta.content) {
        const at = req.clock();
        if (firstTokenAt === null) firstTokenAt = at;
        text += delta.content;
        try {
          req.onText?.(delta.content, at);
        } catch {
          /* a listener that throws must not break the stream */
        }
      }
      if (delta && Array.isArray(delta.tool_calls)) {
        if (firstTokenAt === null) firstTokenAt = req.clock();
        for (const tc of delta.tool_calls as Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const seen = calls.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof tc.id === 'string' && tc.id) seen.id = tc.id;
          if (typeof tc.function?.name === 'string' && tc.function.name) seen.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') seen.arguments += tc.function.arguments;
          calls.set(index, seen);
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
      return false;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        let ended = false;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const one = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line(one)) {
            ended = true;
            break;
          }
        }
        if (ended) break;
      }
      buffer += decoder.decode();
      if (buffer.trim()) line(buffer);
    } catch (err) {
      if (err instanceof ThinkError) throw err;
      throw wrap(err, req.signal);
    } finally {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        /* closed */
      }
    }
    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${sentAt.toString(36)}` }))
      .filter((c) => c.name);
    return { finish: finish || (toolCalls.length ? 'tool_calls' : 'stop'), text, toolCalls, sentAt, firstTokenAt, doneAt: req.clock() };
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', stop);
  }
}

function wrap(err: unknown, signal: AbortSignal): ThinkError {
  if (signal.aborted) return new ThinkError('aborted', 'aborted');
  const e = err as { name?: string; message?: string };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new ThinkError('network', 'the relay did not answer in time');
  return new ThinkError('network', 'the relay could not be reached');
}
