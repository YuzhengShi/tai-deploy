/**
 * The voice hub with the lab switched on and everything around it faked, for the tests of the lab through the hub: the real hub, the real relay, the real `VoiceSession`, the stand-in
 * (src/voice/lab/engine.ts) with doubles for its ears and mouth, a fake gateway, fake tool hosts, a temporary groups/data/store tree, and a small HTTP server that plays the portal's part
 * (it routes /api/voice and /api/voice-lab upgrades to the hub with a test user, as src/portal/server.ts does, and /voice-llm/ to the relay).
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { createVoiceHub, type VoiceHub, type VoiceDeps } from '../../hub.js';
import { FakeGateway } from '../../testing/fake-gateway.js';
import { BrowserClient, GATEWAY_KEY, INTERVIEW_SECRET, TEST_KEY, makeUser } from '../../testing/harness.js';
import { FakeToolHost, type ToolResult } from '../../tool-host.js';
import type { Caller, VoiceLog } from '../../types.js';
import type { LabEngine } from '../engine.js';
import { FakeEars, FakeMouth } from './fake-parts.js';

export interface LabHarnessOptions {
  /** TAI_VOICE_LAB (default on). */
  lab?: boolean;
  env?: Record<string, string>;
  toolHandlers?: Record<string, (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>>;
  mouthMs?: number;
  deps?: Partial<VoiceDeps>;
  /** Make the doubles of the ears fail to connect, by kind. */
  earsFail?: Set<string>;
  /** Use the real ears and mouth classes (point them at loopback fakes with the TAI_VOICE_LAB_*_URL settings) instead of the doubles. */
  real?: boolean;
}

export interface LabHarness {
  hub: VoiceHub;
  gw: FakeGateway;
  ears: FakeEars[];
  mouths: { labgpu: FakeMouth; aura: FakeMouth };
  toolHosts: FakeToolHost[];
  chat: Array<{ folder: string; role: string; text: string; kind?: string }>;
  logs: Array<{ level: string; msg: string; obj: Record<string, unknown> }>;
  root: string;
  dataDir: string;
  origin: string;
  port: number;
  owner(): Caller;
  student(n?: number): Caller;
  /** A browser on `/api/voice-lab` (or the given path), as that user. */
  browser(user: Caller, path?: string, headers?: Record<string, string>): Promise<BrowserClient>;
  /** The engine the hub started (null with the lab off or before it is up). */
  engine(): LabEngine | null;
  close(): Promise<void>;
}

export async function createLabHarness(opts: LabHarnessOptions = {}): Promise<LabHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-voice-lab-'));
  const groupsDir = path.join(root, 'groups');
  const dataDir = path.join(root, 'data');
  const storeDir = path.join(root, 'store');
  for (const d of [groupsDir, dataDir, storeDir, path.join(groupsDir, 'global')]) fs.mkdirSync(d, { recursive: true });
  const secretFile = path.join(root, 'portal-secret');
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));

  const gw = await FakeGateway.start();
  const toolHosts: FakeToolHost[] = [];
  const chat: LabHarness['chat'] = [];
  const logs: LabHarness['logs'] = [];
  const log: VoiceLog = {
    debug: (obj, msg) => logs.push({ level: 'debug', msg: msg ?? '', obj }),
    info: (obj, msg) => logs.push({ level: 'info', msg: msg ?? '', obj }),
    warn: (obj, msg) => logs.push({ level: 'warn', msg: msg ?? '', obj }),
    error: (obj, msg) => logs.push({ level: 'error', msg: msg ?? '', obj }),
  };
  const users = new Map<string, Caller>();
  const ears: FakeEars[] = [];
  const mouths = { labgpu: new FakeMouth({ name: 'labgpu', ms: opts.mouthMs ?? 400 }), aura: new FakeMouth({ name: 'aura', takesSpeed: true, ms: opts.mouthMs ?? 400 }) };
  const hubRef: { hub: VoiceHub | null } = { hub: null };
  const doubles: NonNullable<VoiceDeps['labFactories']> = {
    makeEars: (kind, handlers) => {
      const e = new FakeEars(kind, kind === 'flux', handlers, () => performance.now());
      if (opts.earsFail?.has(kind)) e.connectError = new Error('connect failed');
      ears.push(e);
      return e;
    },
    makeMouth: (kind) => mouths[kind],
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname.startsWith('/voice-llm/')) {
      void hubRef.hub!.relay(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    const user = users.get(String(req.headers['x-test-user'] || ''));
    if (!user) return void socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    if (url.pathname === '/api/voice') return hubRef.hub!.upgrade(req, socket, head, user, url.searchParams);
    if (url.pathname === '/api/voice-lab' && hubRef.hub!.upgradeLab) return hubRef.hub!.upgradeLab(req, socket, head, user, url.searchParams);
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  const readEnv: Record<string, string> = { DEEPGRAM_API_KEY: TEST_KEY, VOICE_INTERVIEW_SECRET: INTERVIEW_SECRET };
  hubRef.hub = createVoiceHub({
    groupsDir,
    dataDir,
    storeDir,
    publicBase: `${origin}/tai`,
    publicOrigin: origin,
    secretFile,
    appendChat: (folder, role, text, extra) => chat.push({ folder, role, text, kind: extra?.kind }),
    recentChat: () => [],
    recordVoiceSummary: () => undefined,
    preemptTextAgent: () => undefined,
    spawnToolHost: () => {
      const th = new FakeToolHost({ ...(opts.toolHandlers ?? {}) });
      toolHosts.push(th);
      return th;
    },
    readEnv: (keys) => Object.fromEntries(keys.filter((k) => k in readEnv).map((k) => [k, readEnv[k]])),
    env: {
      TAI_VOICE: '1',
      TAI_VOICE_WARM_COURSE: '0',
      TAI_VOICE_LLM_URL: gw.url,
      TAI_VOICE_LLM_KEY: GATEWAY_KEY,
      TAI_VOICE_TOOLHOST_KEEP_SEC: '0',
      ...(opts.lab === false
        ? {}
        : {
            TAI_VOICE_LAB: '1',
            TAI_VOICE_LAB_COVER_MS: '100',
            TAI_VOICE_LAB_BARGE_MS: '120',
            TAI_VOICE_LAB_LEAD_MS: '200',
            TAI_VOICE_LAB_HOLD_CHAT: '0,700',
            TAI_VOICE_LAB_TEMPO: '0',
            TAI_VOICE_LAB_SHADOW_EARS: 'none',
          }),
      ...(opts.env ?? {}),
    },
    log,
    ...(opts.real ? {} : { labFactories: doubles }),
    ...(opts.deps ?? {}),
    timing: { keepAliveMs: 200, tickMs: 20, timerEventMs: 100, updateWaitMs: 800, handoffPauseMs: 10, farewellMinMs: 50, farewellMaxMs: 300, closingDelayMs: 100, injectAckMs: 150, injectRetryMs: 300, summaryTimeoutMs: 1000, toolHostWaitMs: 500, claimCheckMs: 80, graceMs: 300 },
  });
  if (!hubRef.hub) throw new Error('the hub did not start');
  // the stand-in listens a moment after the hub is made
  for (let i = 0; i < 100 && opts.lab !== false && !(hubRef.hub as unknown as { labEngine: LabEngine | null }).labEngine; i++) await new Promise((r) => setTimeout(r, 10));

  const person = (n: number, role: 'owner' | 'student'): Caller => {
    const u = { ...makeUser(n), role };
    users.set(u.folder, u);
    fs.mkdirSync(path.join(groupsDir, u.folder), { recursive: true });
    return u;
  };
  return {
    hub: hubRef.hub,
    gw,
    ears,
    mouths,
    toolHosts,
    chat,
    logs,
    root,
    dataDir,
    origin,
    port,
    owner: () => person(1, 'owner'),
    student: (n = 2) => person(n, 'student'),
    browser: (user, p = '/api/voice-lab', headers = {}) => {
      users.set(user.folder, user);
      return BrowserClient.connect(`ws://127.0.0.1:${port}${p}`, { Origin: origin, 'x-test-user': user.folder, ...headers });
    },
    engine: () => (hubRef.hub as unknown as { labEngine: LabEngine | null }).labEngine,
    close: async () => {
      await hubRef.hub!.close();
      await gw.close();
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
