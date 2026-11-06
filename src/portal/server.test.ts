import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { AuthError, NonceStore, PortalUser, SessionCodec, UserDirectory } from './auth.js';
import { HistoryStore } from './history.js';
import { Portal, PortalCore, PortalOptions } from './server.js';

const ORIGIN = 'https://tai.example';

class FakeCore implements PortalCore {
  registered: PortalUser[] = [];
  sent: Array<{ jid: string; text: string; name: string }> = [];
  private listeners = new Set<(entry: { kind: string; jid: string; text?: string; typing?: boolean }) => void>();
  typing = new Set<string>();
  failSubmit = false;

  ensureStudent(user: PortalUser): string {
    this.registered.push(user);
    return user.jid;
  }
  submit(jid: string, text: string, name: string) {
    if (this.failSubmit) return { ok: false as const, status: 404, error: 'not registered' };
    this.sent.push({ jid, text, name });
    return { ok: true as const };
  }
  onOutbound(listener: (entry: { kind: string; jid: string; text?: string; typing?: boolean }) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  isTyping(jid: string): boolean {
    return this.typing.has(jid);
  }
  emit(entry: { kind: string; jid: string; text?: string; typing?: boolean }): void {
    for (const listener of this.listeners) listener(entry);
  }
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

describe('the student page', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];
  let core: FakeCore;
  let usersFile: string;
  let historyDir: string;
  let clock: { now: number };

  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-portal-'));
    dirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    core = new FakeCore();
    clock = { now: 1_800_000_000_000 };
    const dir = tmp();
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

  async function start(extra: Partial<PortalOptions> = {}): Promise<{ portal: Portal; port: number; users: UserDirectory }> {
    const users = new UserDirectory(usersFile);
    const secret = crypto.createHash('sha256').update('test-secret').digest();
    const portal = new Portal({
      core,
      users,
      verifier: {
        verify: async (credential: string) => {
          if (!credential.startsWith('good:')) throw new AuthError('signature');
          return { email: credential.slice(5), subject: 's' };
        },
      },
      googleClientId: 'client.apps.googleusercontent.com',
      sessions: new SessionCodec(secret, 3600, () => clock.now),
      nonces: new NonceStore(5 * 60_000, 5000, () => clock.now),
      history: new HistoryStore(historyDir),
      staticFiles: {
        '/index.html': { body: Buffer.from('<!doctype html><title>TAi</title>'), type: 'text/html; charset=utf-8' },
        '/app.js': { body: Buffer.from('console.log(1)'), type: 'text/javascript; charset=utf-8' },
      },
      basePath: '/tai',
      origin: ORIGIN,
      trustProxy: true,
      maxMessageChars: 200,
      now: () => clock.now,
      log: { info: () => undefined, warn: () => undefined },
      ...extra,
    });
    await portal.listen({ host: '127.0.0.1', port: 0 });
    portals.push(portal);
    return { portal, port: portal.address()!.port, users };
  }

  function request(port: number, method: string, url: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = options.raw !== undefined ? options.raw : options.body !== undefined ? JSON.stringify(options.body) : undefined;
      const headers: Record<string, string> = { ...(options.headers || {}) };
      if (options.cookie) headers.cookie = options.cookie;
      if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const post = (port: number, url: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    request(port, 'POST', url, { body, cookie, headers: { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers } });

  async function signIn(port: number, email = 'ada@example.com'): Promise<string> {
    const { json } = await request(port, 'GET', '/auth/nonce');
    const reply = await post(port, '/auth/google', { credential: `good:${email}`, nonce: json.nonce });
    expect(reply.status, reply.text).toBe(200);
    const cookie = String(reply.headers['set-cookie']).split(';')[0];
    expect(cookie.startsWith('tai_session=')).toBe(true);
    return cookie;
  }

  it('serves its own files with a content policy, and nothing else from the disk', async () => {
    const { port } = await start();
    const page = await request(port, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(String(page.headers['content-security-policy'])).toContain('https://accounts.google.com/gsi/client');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['x-frame-options']).toBe('DENY');
    // what Google's sign-in popup needs of the page that opens it (with COOP "same-origin" the callback never fires)
    expect(page.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
    expect(page.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    const again = await request(port, 'GET', '/', { headers: { 'if-none-match': String(page.headers.etag) } });
    expect(again.status).toBe(304);
    expect((await request(port, 'GET', '/app.js')).status).toBe(200);
    for (const url of ['/nope.js', '/../package.json', '/%2e%2e/package.json', '/app.js/../../etc/passwd', '/index.html%00.js']) {
      const reply = await request(port, 'GET', url);
      expect(reply.status, url).toBe(404);
    }
  });

  it('answers the unauthenticated questions and nothing about a chat', async () => {
    const { port } = await start();
    expect((await request(port, 'GET', '/api/health')).json).toEqual({ ok: true });
    expect((await request(port, 'GET', '/auth/config')).json).toEqual({ clientId: 'client.apps.googleusercontent.com', enabled: true });
    for (const [method, url] of [['GET', '/api/me'], ['GET', '/api/history'], ['GET', '/api/poll?after=0'], ['POST', '/api/send']] as const) {
      const reply = method === 'POST' ? await post(port, url, { text: 'hi' }) : await request(port, method, url);
      expect(reply.status, url).toBe(401);
      expect(reply.json).toEqual({ error: 'signed-out' });
    }
    expect(core.sent).toEqual([]);
  });

  it('signs a student in with a nonce this server issued, once, and sets a cookie only the page can use', async () => {
    const { port } = await start();
    const { json } = await request(port, 'GET', '/auth/nonce');
    const reply = await post(port, '/auth/google', { credential: 'good:ada@example.com', nonce: json.nonce });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true, user: { email: 'ada@example.com', name: 'Ada', role: 'owner' } });
    const cookie = String(reply.headers['set-cookie']);
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/tai', 'Secure', 'Max-Age=3600']) expect(cookie).toContain(part);
    const replay = await post(port, '/auth/google', { credential: 'good:ada@example.com', nonce: json.nonce });
    expect(replay.status).toBe(401);
    expect(replay.json.reason).toBe('nonce');
  });

  it('refuses a sign-in with an invented nonce, a bad token, or an address that is not on the list', async () => {
    const { port } = await start();
    expect((await post(port, '/auth/google', { credential: 'good:ada@example.com', nonce: 'invented' })).json).toEqual({ error: 'sign-in-failed', reason: 'nonce' });
    let nonce = (await request(port, 'GET', '/auth/nonce')).json.nonce;
    const bad = await post(port, '/auth/google', { credential: 'forged', nonce });
    expect(bad.status).toBe(401);
    expect(bad.json).toEqual({ error: 'sign-in-failed', reason: 'signature' });
    expect(bad.headers['set-cookie']).toBeUndefined();
    nonce = (await request(port, 'GET', '/auth/nonce')).json.nonce;
    const stranger = await post(port, '/auth/google', { credential: 'good:mallory@example.com', nonce });
    expect(stranger.status).toBe(403);
    expect(stranger.json).toEqual({ error: 'not-enrolled', email: 'mallory@example.com' });
    expect(stranger.headers['set-cookie']).toBeUndefined();
    expect((await post(port, '/auth/google', {})).status).toBe(401);
  });

  it('is closed, not open, when Google sign-in is not set up', async () => {
    const { port } = await start({ verifier: null });
    expect((await request(port, 'GET', '/auth/config')).json).toEqual({ clientId: '', enabled: false });
    expect((await post(port, '/auth/google', { credential: 'good:ada@example.com', nonce: 'x' })).status).toBe(503);
  });

  it('only takes a POST from the page itself: JSON, its header, its origin', async () => {
    const { port } = await start();
    const cookie = await signIn(port);
    const text = { text: 'hello' };
    expect((await post(port, '/api/send', text, cookie, { 'x-tai': '' })).json.error).toBe('csrf');
    expect((await post(port, '/api/send', text, cookie, { origin: 'https://evil.example' })).json.error).toBe('origin');
    expect((await request(port, 'POST', '/api/send', { body: text, cookie, headers: { 'x-tai': '1', origin: ORIGIN, 'content-type': 'text/plain' } })).json.error).toBe('content-type');
    expect((await post(port, '/api/send', text, cookie, { 'sec-fetch-site': 'cross-site' })).json.error).toBe('cross-site');
    const noOrigin = await request(port, 'POST', '/api/send', { body: text, cookie, headers: { 'content-type': 'application/json', 'x-tai': '1' } });
    expect(noOrigin.json.error).toBe('origin');
    expect(core.sent).toEqual([]);
    expect((await post(port, '/api/send', text, cookie)).status).toBe(200);
  });

  it('binds a message to the chat the allowlist gives the signed-in student, whatever the request says', async () => {
    const { port } = await start();
    const ada = await signIn(port, 'ada@example.com');
    const reply = await post(port, '/api/send', { text: 'what is raft?', jid: 'web:s_00000000000000000000', folder: 'main', name: 'Professor', canvasUserId: '9999', githubUsername: 'someone' }, ada);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ ok: true, n: 1 });
    expect(core.registered.at(-1)).toMatchObject({ email: 'ada@example.com', canvasUserId: '1001', githubUsername: 'ada-eval', role: 'owner' });
    expect(core.sent).toEqual([{ jid: core.registered.at(-1)!.jid, text: 'what is raft?', name: 'Ada' }]);
    expect(core.sent[0].jid).toMatch(/^web:s_[0-9a-f]{20}$/);
  });

  it('keeps each student\'s conversation to that student', async () => {
    const { port } = await start();
    const ada = await signIn(port, 'ada@example.com');
    const bob = await signIn(port, 'bob@example.com');
    await post(port, '/api/send', { text: 'ada says hi' }, ada);
    await post(port, '/api/send', { text: 'bob says hi' }, bob);
    const adaJid = core.registered.find((u) => u.email === 'ada@example.com')!.jid;
    const bobJid = core.registered.find((u) => u.email === 'bob@example.com')!.jid;
    core.emit({ kind: 'text', jid: adaJid, text: 'reply to ada' });
    core.emit({ kind: 'text', jid: bobJid, text: 'reply to bob' });
    core.emit({ kind: 'text', jid: 'web:ann-eval', text: 'a chat of the evaluation, not a student of this page' });
    const adaSees = (await request(port, 'GET', '/api/history', { cookie: ada })).json.entries.map((e: any) => `${e.role}:${e.text}`);
    const bobSees = (await request(port, 'GET', '/api/history', { cookie: bob })).json.entries.map((e: any) => `${e.role}:${e.text}`);
    expect(adaSees).toEqual(['user:ada says hi', 'assistant:reply to ada']);
    expect(bobSees).toEqual(['user:bob says hi', 'assistant:reply to bob']);
  });

  it('hands a reply to a poll that is already waiting, and tells whether TAi is typing', async () => {
    const { port } = await start();
    const ada = await signIn(port);
    await post(port, '/api/send', { text: 'hello' }, ada);
    const jid = core.registered[0].jid;
    const started = Date.now();
    const waiting = request(port, 'GET', '/api/poll?after=1&wait=10', { cookie: ada });
    await new Promise((r) => setTimeout(r, 150));
    core.typing.add(jid);
    core.emit({ kind: 'text', jid, text: 'a reply' });
    const reply = await waiting;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(reply.json.entries).toEqual([{ n: 2, ts: new Date(clock.now).toISOString(), role: 'assistant', text: 'a reply' }]);
    expect(reply.json.typing).toBe(true);
    expect(reply.json.last).toBe(2);
    const quiet = await request(port, 'GET', '/api/poll?after=2', { cookie: ada });
    expect(quiet.json.entries).toEqual([]);
  });

  it('wakes a waiting poll when typing starts, so the page can show it', async () => {
    const { port } = await start();
    const ada = await signIn(port);
    await request(port, 'GET', '/api/me', { cookie: ada });
    const jid = (await post(port, '/api/send', { text: 'x' }, ada), core.registered[0].jid);
    const waiting = request(port, 'GET', '/api/poll?after=1&wait=10', { cookie: ada });
    await new Promise((r) => setTimeout(r, 150));
    core.typing.add(jid);
    core.emit({ kind: 'typing', jid, typing: true });
    const reply = await waiting;
    expect(reply.json.typing).toBe(true);
    expect(reply.json.entries).toEqual([]);
  });

  it('keeps the conversation across a restart and carries on numbering', async () => {
    let started = await start();
    const ada = await signIn(started.port);
    await post(started.port, '/api/send', { text: 'before the restart' }, ada);
    core.emit({ kind: 'text', jid: core.registered[0].jid, text: 'an answer' });
    await started.portal.close();
    started = await start();
    const history = await request(started.port, 'GET', '/api/history', { cookie: ada });
    expect(history.json.entries.map((e: any) => e.text)).toEqual(['before the restart', 'an answer']);
    const sent = await post(started.port, '/api/send', { text: 'after' }, ada);
    expect(sent.json.n).toBe(3);
  });

  it('keeps a reply that arrives while the student is away, even after a restart', async () => {
    const { port } = await start();
    const ada = await signIn(port);
    await request(port, 'GET', '/api/me', { cookie: ada });
    const jid = `web:${new UserDirectory(usersFile).find('ada@example.com')!.folder}`;
    core.emit({ kind: 'text', jid, text: 'sent while nobody was looking' });
    expect((await request(port, 'GET', '/api/history', { cookie: ada })).json.entries.map((e: any) => e.text)).toEqual(['sent while nobody was looking']);
  });

  it('ends a session when the address is taken off the list', async () => {
    const { port } = await start();
    const bob = await signIn(port, 'bob@example.com');
    expect((await request(port, 'GET', '/api/me', { cookie: bob })).status).toBe(200);
    fs.writeFileSync(usersFile, JSON.stringify({ users: [{ email: 'ada@example.com' }] }));
    fs.utimesSync(usersFile, new Date(), new Date(Date.now() + 5000));
    const reply = await request(port, 'GET', '/api/me', { cookie: bob });
    expect(reply.status).toBe(403);
    expect(reply.json).toEqual({ error: 'not-enrolled' });
  });

  it('ends a session after its time, and on logout', async () => {
    const { port } = await start();
    const ada = await signIn(port);
    const out = await post(port, '/auth/logout', {}, ada);
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    clock.now += 3601 * 1000;
    expect((await request(port, 'GET', '/api/me', { cookie: ada })).status).toBe(401);
  });

  it('limits how fast one student can send, and how many polls one student can hold', async () => {
    const { port } = await start();
    const ada = await signIn(port);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await post(port, '/api/send', { text: `m${i}` }, ada)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const held = [0, 1, 2, 3].map(() => request(port, 'GET', '/api/poll?after=999&wait=2', { cookie: ada }));
    await new Promise((r) => setTimeout(r, 200));
    expect((await request(port, 'GET', '/api/poll?after=999&wait=2', { cookie: ada })).status).toBe(429);
    await Promise.all(held);
  });

  it('refuses what is empty, too long, or not JSON, and tells the page if TAi could not be reached', async () => {
    const { port } = await start();
    const ada = await signIn(port);
    expect((await post(port, '/api/send', { text: '   ' }, ada)).status).toBe(400);
    expect((await post(port, '/api/send', { text: 5 }, ada)).status).toBe(400);
    expect((await post(port, '/api/send', { text: 'x'.repeat(201) }, ada)).status).toBe(413);
    const junk = await request(port, 'POST', '/api/send', { raw: '{not json', cookie: ada, headers: { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN } });
    expect(junk.status).toBe(400);
    const big = await request(port, 'POST', '/api/send', { raw: JSON.stringify({ text: 'x'.repeat(40_000) }), cookie: ada, headers: { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN } });
    expect(big.status).toBe(413);
    core.failSubmit = true;
    expect((await post(port, '/api/send', { text: 'is anyone there' }, ada)).status).toBe(502);
  });

  it('counts a sign-in attempt against the address it came from, as seen by the proxy in front', async () => {
    const { port } = await start();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await post(port, '/auth/google', { credential: 'forged', nonce: 'x' }, undefined, { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' })).status);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes[30]).toBe(429);
    const other = await post(port, '/auth/google', { credential: 'forged', nonce: 'x' }, undefined, { 'x-forwarded-for': '203.0.113.9, 198.51.100.8' });
    expect(other.status).toBe(401);
  });

  it('listens on loopback or a socket and nothing wider', async () => {
    const portal = new Portal({ core, users: new UserDirectory(usersFile), verifier: null, googleClientId: '', sessions: new SessionCodec(crypto.randomBytes(32), 60), nonces: new NonceStore(), history: new HistoryStore(historyDir), staticFiles: {} });
    await expect(portal.listen({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback or a socket/);
  });

  it.skipIf(process.platform === 'win32')('can listen on a unix socket, the way the live deployment does', async () => {
    const socket = path.join(tmp(), 'portal.sock');
    const portal = new Portal({ core, users: new UserDirectory(usersFile), verifier: null, googleClientId: '', sessions: new SessionCodec(crypto.randomBytes(32), 60), nonces: new NonceStore(), history: new HistoryStore(historyDir), staticFiles: { '/index.html': { body: Buffer.from('hi'), type: 'text/html' } } });
    await portal.listen({ socket });
    portals.push(portal);
    const reply = await new Promise<string>((resolve, reject) => {
      http.get({ socketPath: socket, path: '/api/health' }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(JSON.parse(reply)).toEqual({ ok: true });
    await portal.close();
    expect(fs.existsSync(socket)).toBe(false);
  });
});
