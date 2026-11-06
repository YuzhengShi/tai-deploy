/**
 * A stand-in for the LiteLLM gateway, for tests: an HTTP server on loopback that records every chat completions request and answers
 * the way the test says: an SSE stream, one JSON answer, an error with words that must never reach Deepgram, or nothing for a while.
 */
import http from 'http';
import type { AddressInfo } from 'net';

export interface GatewayReply {
  status?: number;
  /** SSE data payloads (each becomes "data: <payload>\n\n"); "[DONE]" is added at the end. */
  sse?: string[];
  json?: unknown;
  text?: string;
  delayMs?: number;
}

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A gateway answer for a chat completion that says `content` (what the evaluator and the summary read). */
export function completion(content: string): GatewayReply {
  return { json: { id: 'cmpl-1', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] } };
}

/** An SSE answer streaming `text` in two chunks, the OpenAI way. */
export function streamed(text: string): GatewayReply {
  const half = Math.ceil(text.length / 2);
  return {
    sse: [
      JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'gpt-oss', choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, half) } }] }),
      JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'gpt-oss', choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: 'stop' }] }),
    ],
  };
}

export class FakeGateway {
  readonly requests: RecordedRequest[] = [];
  respond: (body: Record<string, unknown>, req: http.IncomingMessage) => GatewayReply = () => streamed('hello');

  private constructor(
    private readonly server: http.Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeGateway> {
    let fake: FakeGateway | null = null;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        } catch {
          /* recorded as {} */
        }
        fake!.requests.push({ path: req.url || '', headers: req.headers, body });
        const reply = fake!.respond(body, req);
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (res.destroyed) return;
        if (reply.sse) {
          res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' });
          for (const payload of reply.sse) res.write(`data: ${payload}\n\n`);
          res.end('data: [DONE]\n\n');
        } else if (reply.json !== undefined) {
          const text = JSON.stringify(reply.json);
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
          res.end(text);
        } else {
          res.writeHead(reply.status ?? 200, { 'content-type': 'text/plain' });
          res.end(reply.text ?? '');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    fake = new FakeGateway(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return fake;
  }

  async close(): Promise<void> {
    (this.server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
