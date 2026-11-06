/**
 * The voice hub with everything around it faked, for tests: a fake Deepgram, a fake gateway, fake tool hosts, a temporary groups/data/
 * store tree and a small HTTP server that plays the portal's part (it routes /api/voice upgrades to hub.upgrade with a test user, and
 * /voice-llm/ requests to hub.relay). And a browser that speaks docs/VOICE.md's protocol.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { WebSocket } from 'ws';

import { createVoiceHub, VoiceHub } from '../hub.js';
import type { VoiceTiming } from '../session.js';
import { FakeToolHost, ToolResult } from '../tool-host.js';
import type { Caller, VoiceLog } from '../types.js';
import { FakeDeepgram } from './fake-deepgram.js';
import { FakeGateway } from './fake-gateway.js';

export const TEST_KEY = 'dg-test-key-0123456789';
export const GATEWAY_KEY = 'sk-gateway-secret-key-xyz';
export const INTERVIEW_SECRET = 'interview-secret-for-tests';

export class BrowserClient {
  readonly events: Array<Record<string, unknown>> = [];
  audioBytes = 0;
  closed = false;
  closeCode = 0;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) this.audioBytes += (data as Buffer).length;
      else {
        try {
          this.events.push(JSON.parse(data.toString()));
        } catch {
          /* ignore */
        }
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      for (const wake of this.waiters.splice(0)) wake();
    });
    ws.on('error', () => undefined);
  }

  static connect(url: string, headers: Record<string, string>): Promise<BrowserClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.once('open', () => resolve(new BrowserClient(ws)));
      ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.once('error', reject);
    });
  }

  send(message: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message));
  }

  sendAudio(bytes: number | Buffer = 1280): void {
    this.ws.send(typeof bytes === 'number' ? Buffer.alloc(bytes, 7) : bytes, { binary: true });
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.type === type);
  }

  /** The first event of this type (matching pred) received so far or arriving within the timeout. */
  async next(type: string, pred: (e: Record<string, unknown>) => boolean = () => true, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((e) => e.type === type && pred(e));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`browser: no ${type} within ${timeoutMs} ms (got ${this.events.map((e) => e.type).join(', ')})`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async waitClosed(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('browser: socket not closed');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close(): void {
    this.ws.close();
  }
}

export interface HarnessOptions {
  env?: Record<string, string>;
  timing?: Partial<VoiceTiming>;
  toolHandlers?: Record<string, (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>>;
  toolStartError?: Error;
  /** The tool host takes this long to come up (a real one is a container: ten seconds or more). */
  toolStartDelayMs?: number;
  now?: () => number;
  readEnv?: Record<string, string>;
}

export interface Harness {
  hub: VoiceHub;
  dg: FakeDeepgram;
  gw: FakeGateway;
  toolHosts: FakeToolHost[];
  chat: Array<{ folder: string; role: string; text: string; kind?: string; type?: string; title?: string; detail?: string; items?: unknown; call?: string; event?: string; mode?: string; seconds?: number }>;
  summaries: Array<{ jid: string; text: string }>;
  preempted: string[];
  logs: Array<{ level: string; msg: string; obj: Record<string, unknown> }>;
  root: string;
  groupsDir: string;
  dataDir: string;
  storeDir: string;
  port: number;
  origin: string;
  publicBase: string;
  user(n?: number): Caller;
  browser(user?: Caller, headers?: Record<string, string>): Promise<BrowserClient>;
  close(): Promise<void>;
}

export function makeUser(n = 1): Caller {
  const folder = 's_' + crypto.createHash('sha256').update(`student${n}@example.edu`).digest('hex').slice(0, 20);
  return { email: `student${n}@example.edu`, name: n === 1 ? 'Yuzheng Shi' : `Student ${n}`, role: 'student', folder, jid: `web:${folder}`, githubUsername: `gh-user${n}`, canvasUserId: String(1000 + n) };
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-voice-'));
  const groupsDir = path.join(root, 'groups');
  const dataDir = path.join(root, 'data');
  const storeDir = path.join(root, 'store');
  for (const d of [groupsDir, dataDir, storeDir, path.join(groupsDir, 'global')]) fs.mkdirSync(d, { recursive: true });
  const secretFile = path.join(root, 'portal-secret');
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));

  const dg = await FakeDeepgram.start();
  const gw = await FakeGateway.start();
  const toolHosts: FakeToolHost[] = [];
  const chat: Harness['chat'] = [];
  const summaries: Harness['summaries'] = [];
  const preempted: string[] = [];
  const logs: Harness['logs'] = [];
  const log: VoiceLog = {
    debug: (obj, msg) => logs.push({ level: 'debug', msg: msg ?? '', obj }),
    info: (obj, msg) => logs.push({ level: 'info', msg: msg ?? '', obj }),
    warn: (obj, msg) => logs.push({ level: 'warn', msg: msg ?? '', obj }),
    error: (obj, msg) => logs.push({ level: 'error', msg: msg ?? '', obj }),
  };
  const users = new Map<string, Caller>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname.startsWith('/tai/voice-llm/') || url.pathname.startsWith('/voice-llm/')) {
      void hubRef.hub!.relay(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    // the portal's part: who is calling (here a header, or a "cookie" that is just the folder, for the smoke client)
    const cookie = /tai_session=([^;]+)/.exec(String(req.headers.cookie || ''))?.[1] || '';
    const user = users.get(String(req.headers['x-test-user'] || cookie));
    if (url.pathname !== '/api/voice' || !user) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    hubRef.hub!.upgrade(req, socket, head, user, url.searchParams);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const publicBase = `${origin}/tai`;

  const hubRef: { hub: VoiceHub | null } = { hub: null };
  const readEnv = { DEEPGRAM_API_KEY: TEST_KEY, VOICE_INTERVIEW_SECRET: INTERVIEW_SECRET, ...(opts.readEnv ?? {}) };
  hubRef.hub = createVoiceHub({
    groupsDir,
    dataDir,
    storeDir,
    publicBase,
    publicOrigin: origin,
    secretFile,
    appendChat: (folder, role, text, extra) => chat.push({ folder, role, text, kind: extra?.kind, type: extra?.type, title: extra?.title, detail: extra?.detail, items: extra?.items, call: extra?.call, event: extra?.event, mode: extra?.mode, seconds: extra?.seconds }),
    recentChat: () => [
      { role: 'user', text: 'I am stuck on the Raft election timeout' },
      { role: 'assistant', text: 'What happens when a follower stops hearing from the leader?' },
    ],
    recordVoiceSummary: (jid, text) => summaries.push({ jid, text }),
    preemptTextAgent: (jid) => preempted.push(jid),
    spawnToolHost: () => {
      const th = new FakeToolHost({ ...(opts.toolHandlers ?? {}) });
      if (opts.toolStartError) th.startError = opts.toolStartError;
      if (opts.toolStartDelayMs) th.startDelayMs = opts.toolStartDelayMs;
      toolHosts.push(th);
      return th;
    },
    readEnv: (keys) => Object.fromEntries(keys.filter((k) => k in readEnv).map((k) => [k, (readEnv as Record<string, string>)[k]])),
    env: {
      TAI_VOICE: '1',
      TAI_VOICE_WARM_COURSE: '0',                                  // a test that counts the tool host's calls does not want three more at the start
      TAI_VOICE_LLM_URL: gw.url,
      TAI_VOICE_LLM_KEY: GATEWAY_KEY,
      // a call closes its tool host with it, unless a test asks for the hosts to be kept (the production default keeps them ten minutes)
      TAI_VOICE_TOOLHOST_KEEP_SEC: '0',
      ...(opts.env ?? {}),
    },
    now: opts.now,
    log,
    deepgramUrl: dg.url,
    timing: {
      keepAliveMs: 200,
      tickMs: 20,
      timerEventMs: 100,
      updateWaitMs: 400,
      handoffPauseMs: 10,
      farewellMinMs: 50,
      farewellMaxMs: 300,
      closingDelayMs: 100,
      injectAckMs: 150,
      injectRetryMs: 300,
      summaryTimeoutMs: 1000,
      toolHostWaitMs: 500,
      claimCheckMs: 80,
      graceMs: 300,
      ...(opts.timing ?? {}),
    },
  });
  if (!hubRef.hub) throw new Error('the hub did not start');

  return {
    hub: hubRef.hub,
    dg,
    gw,
    toolHosts,
    chat,
    summaries,
    preempted,
    logs,
    root,
    groupsDir,
    dataDir,
    storeDir,
    port,
    origin,
    publicBase,
    user: (n = 1) => {
      const u = makeUser(n);
      users.set(u.folder, u);
      fs.mkdirSync(path.join(groupsDir, u.folder), { recursive: true });
      return u;
    },
    browser: (user = makeUser(1), headers = {}) => {
      users.set(user.folder, user);
      return BrowserClient.connect(`ws://127.0.0.1:${port}/api/voice`, { Origin: origin, 'x-test-user': user.folder, ...headers });
    },
    close: async () => {
      await hubRef.hub!.close();
      await dg.close();
      await gw.close();
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
