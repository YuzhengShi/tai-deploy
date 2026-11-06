/**
 * A stand-in for Deepgram's Voice Agent endpoint, for tests: a `ws` server on loopback that speaks the V1 protocol of docs/VOICE.md.
 * It sends Welcome on connect, answers Settings with SettingsApplied (or an Error the test chooses), acknowledges UpdateThink /
 * UpdateSpeak / UpdatePrompt, records everything the client sends, and lets the test script the agent's side: ConversationText,
 * FunctionCallRequest, AgentStartedSpeaking, binary audio, AgentAudioDone, InjectionRefused, Warning, Error, a close.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { WebSocket, WebSocketServer } from 'ws';

export type SettingsVerdict = 'apply' | 'ignore' | { code: string; description: string; close?: boolean };

export class FakeDeepgramConnection {
  readonly messages: Array<Record<string, unknown>> = [];
  audioBytes = 0;
  audioFrames = 0;
  closed = false;
  closeCode = 0;
  private waiters: Array<{ type: string; pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = [];

  constructor(
    readonly ws: WebSocket,
    readonly headers: http.IncomingHttpHeaders,
    private readonly owner: FakeDeepgram,
  ) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.audioBytes += (data as Buffer).length;
        this.audioFrames++;
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.messages.push(msg);
      this.react(msg);
      for (const w of [...this.waiters]) {
        if (w.type === msg.type && w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
    });
    ws.on('error', () => undefined);
  }

  private react(msg: Record<string, unknown>): void {
    const o = this.owner;
    if (msg.type === 'Settings') {
      const verdict = o.settingsVerdict(msg, this);
      if (verdict === 'apply') this.send({ type: 'SettingsApplied' });
      else if (verdict !== 'ignore') {
        this.send({ type: 'Error', code: verdict.code, description: verdict.description });
        if (verdict.close !== false) setTimeout(() => this.close(1011), 20);
      }
      return;
    }
    const acks: Record<string, string> = { UpdateThink: 'ThinkUpdated', UpdateSpeak: 'SpeakUpdated', UpdatePrompt: 'PromptUpdated', UpdateListen: 'ListenUpdated' };
    const ack = typeof msg.type === 'string' ? acks[msg.type] : undefined;
    if (ack && !o.withheldAcks.has(ack)) setTimeout(() => this.send({ type: ack }), 5);
    if ((msg.type === 'InjectUserMessage' || msg.type === 'InjectAgentMessage') && o.refuseInjections > 0) {
      o.refuseInjections--;
      setTimeout(() => this.send({ type: 'InjectionRefused', message: 'busy' }), 5);
    }
  }

  send(event: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event));
  }

  sendAudio(bytes: number | Buffer = 4800): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(typeof bytes === 'number' ? Buffer.alloc(bytes, 1) : bytes, { binary: true });
  }

  /** The agent speaks a turn: AgentStartedSpeaking (the live protocol sends none: `announce` false), audio, its transcript, AgentAudioDone. */
  agentSays(text: string, audioBytes = 4800, announce = true): void {
    if (announce) this.send({ type: 'AgentStartedSpeaking', total_latency: 0.5, tts_latency: 0.1, ttt_latency: 0.4 });
    this.sendAudio(audioBytes);
    this.send({ type: 'ConversationText', role: 'assistant', content: text });
    this.send({ type: 'AgentAudioDone' });
  }

  /** The student says something: UserStartedSpeaking, then the transcript of the turn. */
  userSays(text: string): void {
    this.send({ type: 'UserStartedSpeaking' });
    this.send({ type: 'ConversationText', role: 'user', content: text });
  }

  callFunction(id: string, name: string, args: Record<string, unknown> = {}): void {
    this.send({ type: 'FunctionCallRequest', functions: [{ id, name, arguments: JSON.stringify(args), client_side: true }] });
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.messages.filter((m) => m.type === type);
  }

  /** The next client message of this type (or one already received and matching, when `seen` allows it). */
  waitFor(type: string, pred: (m: Record<string, unknown>) => boolean = () => true, timeoutMs = 3000, seen = true): Promise<Record<string, unknown>> {
    if (seen) {
      const found = this.messages.find((m) => m.type === type && pred(m));
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`fake Deepgram: no ${type} within ${timeoutMs} ms (got ${this.messages.map((m) => m.type).join(', ')})`));
      }, timeoutMs);
      const done = (m: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push({ type, pred, resolve: done });
    });
  }

  close(code = 1000): void {
    try {
      this.ws.close(code);
    } catch {
      /* gone */
    }
  }
}

export class FakeDeepgram {
  readonly connections: FakeDeepgramConnection[] = [];
  /** What to do with a Settings message (default: apply it). */
  onSettings: (settings: Record<string, unknown>, conn: FakeDeepgramConnection) => SettingsVerdict = () => 'apply';
  /** Acknowledgements that are not sent (to test a switch that is never confirmed). */
  withheldAcks = new Set<string>();
  /** How many of the next injections are refused. */
  refuseInjections = 0;
  private connWaiters: Array<{ n: number; resolve: (c: FakeDeepgramConnection) => void }> = [];

  private constructor(
    private readonly server: http.Server,
    private readonly wss: WebSocketServer,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeDeepgram> {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const fake = new FakeDeepgram(server, wss, `ws://127.0.0.1:${port}/v1/agent/converse`);
    wss.on('connection', (ws, req) => {
      const conn = new FakeDeepgramConnection(ws, req.headers, fake);
      fake.connections.push(conn);
      conn.send({ type: 'Welcome', request_id: `req-${fake.connections.length}` });
      for (const w of [...fake.connWaiters]) {
        if (fake.connections.length >= w.n) {
          fake.connWaiters.splice(fake.connWaiters.indexOf(w), 1);
          w.resolve(fake.connections[w.n - 1]);
        }
      }
    });
    return fake;
  }

  settingsVerdict(settings: Record<string, unknown>, conn: FakeDeepgramConnection): SettingsVerdict {
    return this.onSettings(settings, conn);
  }

  /** The n-th connection (1-based), once it exists. */
  connection(n = 1, timeoutMs = 3000): Promise<FakeDeepgramConnection> {
    if (this.connections.length >= n) return Promise.resolve(this.connections[n - 1]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake Deepgram: no connection #${n}`)), timeoutMs);
      this.connWaiters.push({
        n,
        resolve: (c) => {
          clearTimeout(timer);
          resolve(c);
        },
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.connections) {
      try {
        c.ws.terminate();
      } catch {
        /* gone */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
