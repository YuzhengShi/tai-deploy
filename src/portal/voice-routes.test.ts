/**
 * POST /api/voice/warm: the page tells the server that the call button was pressed, before the browser asks for the microphone, and the voice
 * side starts the student's tool host. The route is the part tested here (a Portal on a loopback port, a fake core and a fake voice side, as
 * routes.test.ts does it); the hub's rules for when a host is started are src/voice/hub-prewarm.test.ts.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { AuthError, NonceStore, PortalUser, SessionCodec, UserDirectory } from './auth.js';
import { HistoryStore } from './history.js';
import { OutboundEntry, Portal, PortalCore, PortalOptions, PortalVoice } from './server.js';
import { voiceRoutes } from './voice-routes.js';

const ORIGIN = 'https://tai.example';

class FakeCore implements PortalCore {
  ensureStudent(user: PortalUser): string {
    return user.jid;
  }
  submit() {
    return { ok: true as const };
  }
  onOutbound(_listener: (entry: OutboundEntry) => void) {
    return () => undefined;
  }
  isTyping(): boolean {
    return false;
  }
}

/** A voice side that only counts what it was asked: who, and what the answer is. */
function fakeVoice(answer: () => { ok: boolean; state: string } = () => ({ ok: true, state: 'warming' })): PortalVoice & { asked: PortalUser[] } {
  const asked: PortalUser[] = [];
  return {
    asked,
    upgrade: () => undefined,
    relay: async () => undefined,
    isActive: () => false,
    inject: () => false,
    warm: (user) => {
      asked.push(user);
      return answer();
    },
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
}

describe('POST /api/voice/warm', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];
  let usersFile: string;
  let historyDir: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-voice-routes-'));
    dirs.push(dir);
    usersFile = path.join(dir, 'users.json');
    historyDir = path.join(dir, 'history');
    fs.writeFileSync(
      usersFile,
      JSON.stringify({
        users: [
          { email: 'ada@example.com', name: 'Ada', canvasUserId: '1001', githubUsername: 'ada-eval', role: 'owner' },
          { email: 'bob@example.com', name: 'Bob', canvasUserId: '1002' },
        ],
      }),
    );
  });

  afterEach(async () => {
    for (const portal of portals.splice(0)) await portal.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(voice: PortalVoice | null, extra: Partial<PortalOptions> = {}): Promise<number> {
    const portal = new Portal({
      core: new FakeCore(),
      users: new UserDirectory(usersFile),
      verifier: {
        verify: async (credential: string) => {
          if (!credential.startsWith('good:')) throw new AuthError('signature');
          return { email: credential.slice(5), subject: 's' };
        },
      },
      googleClientId: 'client.apps.googleusercontent.com',
      sessions: new SessionCodec(crypto.createHash('sha256').update('test-secret').digest(), 3600),
      nonces: new NonceStore(5 * 60_000, 5000),
      history: new HistoryStore(historyDir),
      staticFiles: { '/index.html': { body: Buffer.from('<!doctype html><title>TAi</title>'), type: 'text/html; charset=utf-8' } },
      basePath: '/tai',
      origin: ORIGIN,
      trustProxy: true,
      voice,
      routes: voiceRoutes({ voice }),
      log: { info: () => undefined, warn: () => undefined },
      ...extra,
    });
    await portal.listen({ host: '127.0.0.1', port: 0 });
    portals.push(portal);
    return portal.address()!.port;
  }

  function request(port: number, method: string, url: string, options: { body?: unknown; raw?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = options.raw !== undefined ? options.raw : options.body !== undefined ? JSON.stringify(options.body) : undefined;
      const headers: Record<string, string> = { ...(options.headers || {}) };
      if (options.cookie) headers.cookie = options.cookie;
      if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: any;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, json });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const pageHeaders = { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  const post = (port: number, url: string, body: unknown, cookie?: string, headers: Record<string, string> = pageHeaders) => request(port, 'POST', url, { body, cookie, headers });

  async function signIn(port: number, email: string): Promise<string> {
    const { json } = await request(port, 'GET', '/auth/nonce');
    const reply = await post(port, '/auth/google', { credential: `good:${email}`, nonce: json.nonce });
    expect(reply.status).toBe(200);
    return String(reply.headers['set-cookie']).split(';')[0];
  }

  it('is refused without a session, and with a POST that is not the page\'s (the server checks before the handler runs)', async () => {
    const voice = fakeVoice();
    const port = await start(voice);
    expect((await post(port, '/api/voice/warm', {})).status).toBe(401);
    const cookie = await signIn(port, 'bob@example.com');
    expect((await post(port, '/api/voice/warm', {}, cookie, { ...pageHeaders, 'x-tai': '0' })).json).toEqual({ error: 'csrf' });
    expect((await post(port, '/api/voice/warm', {}, cookie, { ...pageHeaders, origin: 'https://evil.example' })).json).toEqual({ error: 'origin' });
    expect((await post(port, '/api/voice/warm', {}, cookie, { ...pageHeaders, 'content-type': 'text/plain' })).json).toEqual({ error: 'content-type' });
    expect((await request(port, 'POST', '/api/voice/warm', { raw: '{nope', cookie, headers: pageHeaders })).status).toBe(400);
    expect((await request(port, 'GET', '/api/voice/warm', { cookie })).status).toBe(405);
    expect(voice.asked).toHaveLength(0);
  });

  it('warms the signed-in student\'s own host, whatever the body says, and answers what the voice side answered', async () => {
    const voice = fakeVoice();
    const port = await start(voice);
    const cookie = await signIn(port, 'ada@example.com');
    const reply = await post(port, '/api/voice/warm', { folder: 's_someone_else', user: 'bob@example.com', githubUsername: 'someone' }, cookie);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true, state: 'warming' });
    expect(voice.asked).toHaveLength(1);
    // who it is comes from the session and the allowlist: the folder, the Canvas user and the GitHub account the pool keys the host by
    expect(voice.asked[0]).toMatchObject({ email: 'ada@example.com', canvasUserId: '1001', githubUsername: 'ada-eval' });
    expect(voice.asked[0].folder).toMatch(/^s_[0-9a-f]{20}$/);
    expect(voice.asked[0].folder).not.toBe('s_someone_else');
  });

  it('passes on a refusal as it is, and never says more than a state of at most a few letters', async () => {
    const answers = [{ ok: false, state: 'recent' }, { ok: true, state: 'warm' }, { ok: 'yes' as unknown as boolean, state: 'x'.repeat(100) }, { ok: true, state: 7 as unknown as string }];
    const voice = fakeVoice(() => answers.shift()!);
    const port = await start(voice);
    const cookie = await signIn(port, 'bob@example.com');
    expect((await post(port, '/api/voice/warm', {}, cookie)).json).toEqual({ ok: false, state: 'recent' });
    expect((await post(port, '/api/voice/warm', {}, cookie)).json).toEqual({ ok: true, state: 'warm' });
    const odd = (await post(port, '/api/voice/warm', {}, cookie)).json;
    expect(odd.ok).toBe(false); // only a real true is a yes
    expect(odd.state).toHaveLength(24);
    expect((await post(port, '/api/voice/warm', {}, cookie)).json).toEqual({ ok: true, state: 'off' });
  });

  it('answers "off" and 200 when voice calls are not on, when the voice side has no warm, and when it throws', async () => {
    const cookieOf = async (port: number) => signIn(port, 'bob@example.com');
    const noVoice = await start(null);
    expect((await post(noVoice, '/api/voice/warm', {}, await cookieOf(noVoice))).json).toEqual({ ok: false, state: 'off' });

    const bare = fakeVoice();
    const withoutWarm: PortalVoice = { upgrade: bare.upgrade, relay: bare.relay, isActive: bare.isActive, inject: bare.inject };
    const noWarm = await start(withoutWarm);
    expect((await post(noWarm, '/api/voice/warm', {}, await cookieOf(noWarm))).json).toEqual({ ok: false, state: 'off' });

    const throwing = await start(fakeVoice(() => { throw new Error('docker is down'); }));
    const reply = await post(throwing, '/api/voice/warm', {}, await cookieOf(throwing));
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: false, state: 'off' });
  });

  it('is registered next to the server\'s own routes without taking one of theirs', () => {
    const routes = voiceRoutes({ voice: null });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/voice/warm']);
    expect(routes[0].access).toBe('student');
  });
});
