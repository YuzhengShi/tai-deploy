/**
 * What the page's server says of a chat's turn (docs/PROGRESS.md): `status` and `sv` in /api/me and /api/poll, a poll that is woken by a change
 * (at most once a second) or returns at once when the page has not seen the latest one, and the "looked at" chips on an answer's history line.
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
import { OutboundEntry, Portal, PortalCore, PortalOptions, PortalStatus } from './server.js';

const ORIGIN = 'https://tai.example';

class StatusCore implements PortalCore {
  typing = new Set<string>();
  statuses = new Map<string, unknown>();
  listener: ((entry: OutboundEntry) => void) | null = null;
  ensureStudent(user: PortalUser): string {
    return user.jid;
  }
  submit() {
    return { ok: true as const };
  }
  onOutbound(listener: (entry: OutboundEntry) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  isTyping(jid: string): boolean {
    return this.typing.has(jid);
  }
  status(jid: string): PortalStatus | undefined {
    return this.statuses.get(jid) as PortalStatus | undefined;
  }
  /** What the web channel does when the status of a chat changes: the listeners hear of it (it is not in the outbox). */
  changed(jid: string): void {
    this.listener?.({ kind: 'status', jid });
  }
}

interface Reply {
  status: number;
  json: any;
}

describe('the status of a turn on the student page', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];
  let usersFile: string;
  let historyDir: string;
  let core: StatusCore;
  const ada = 'web:s_' + crypto.createHash('sha256').update('ada@example.com').digest('hex').slice(0, 20);

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-status-'));
    dirs.push(dir);
    usersFile = path.join(dir, 'users.json');
    historyDir = path.join(dir, 'history');
    fs.writeFileSync(usersFile, JSON.stringify({ users: [{ email: 'ada@example.com', name: 'Ada', canvasUserId: '1001', githubUsername: 'ada-eval', role: 'owner' }] }));
    core = new StatusCore();
  });

  afterEach(async () => {
    for (const portal of portals.splice(0)) await portal.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(extra: Partial<PortalOptions> = {}): Promise<{ port: number; cookie: string; jid: string }> {
    const portal = new Portal({
      core,
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
      log: { info: () => undefined, warn: () => undefined },
      ...extra,
    });
    await portal.listen({ host: '127.0.0.1', port: 0 });
    portals.push(portal);
    const port = portal.address()!.port;
    const nonce = (await request(port, 'GET', '/auth/nonce')).json.nonce;
    const login = await request(port, 'POST', '/auth/google', { body: { credential: 'good:ada@example.com', nonce }, headers: { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin' } });
    expect(login.status).toBe(200);
    const cookie = String(login.headers!['set-cookie']).split(';')[0];
    return { port, cookie, jid: new UserDirectory(usersFile).find('ada@example.com')!.jid };
  }

  function request(port: number, method: string, url: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Reply & { headers?: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
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
          resolve({ status: res.statusCode || 0, json, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  it('is in /api/me and /api/poll only while TAi works or waits, with the version of it', async () => {
    const { port, cookie, jid } = await start();
    const idle = await request(port, 'GET', '/api/me', { cookie });
    expect(idle.json.status).toBeUndefined();
    expect(idle.json.sv).toBe(0);
    expect(idle.json.typing).toBe(false);                                   // `typing` stays as older pages read it
    core.typing.add(jid);
    core.statuses.set(jid, { state: 'working', label: 'Checking Canvas' });
    const working = await request(port, 'GET', '/api/me', { cookie });
    expect(working.json.status).toEqual({ state: 'working', label: 'Checking Canvas' });
    expect(working.json.typing).toBe(true);
    const polled = await request(port, 'GET', '/api/poll?after=0', { cookie });
    expect(polled.json.status).toEqual({ state: 'working', label: 'Checking Canvas' });
    expect(polled.json.typing).toBe(true);
    core.statuses.set(jid, { state: 'queued', ahead: 3 });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toEqual({ state: 'queued', ahead: 3 });
    core.statuses.delete(jid);
    core.typing.delete(jid);
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toBeUndefined();
  });

  it('hands the page only the fields of a status, and nothing a core might add or get wrong', async () => {
    const { port, cookie, jid } = await start();
    core.statuses.set(jid, { state: 'working', label: 'Checking Canvas', secret: 'x', ahead: 4, args: { user_id: '1001' } });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toEqual({ state: 'working', label: 'Checking Canvas' });
    core.statuses.set(jid, { state: 'queued', ahead: -1, label: 'x'.repeat(200) });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toEqual({ state: 'queued' });
    core.statuses.set(jid, { state: 'queued', ahead: 2.5 });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toEqual({ state: 'queued' });
    core.statuses.set(jid, { state: 'sleeping' });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toBeUndefined();
  });

  it('is absent when the core has no status at all (the dots only)', async () => {
    core.status = undefined as unknown as StatusCore['status'];
    const { port, cookie } = await start();
    const reply = await request(port, 'GET', '/api/poll?after=0', { cookie });
    expect(reply.status).toBe(200);
    expect(reply.json.status).toBeUndefined();
  });

  it('wakes a poll that is waiting when the status changes, and says what it is now', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    const started = Date.now();
    const waiting = request(port, 'GET', '/api/poll?after=0&wait=5', { cookie });
    await new Promise((resolve) => setTimeout(resolve, 80));
    core.statuses.set(jid, { state: 'working', label: 'Searching Piazza' });
    core.changed(jid);
    const reply = await waiting;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(reply.json.status).toEqual({ state: 'working', label: 'Searching Piazza' });
    expect(reply.json.sv).toBe(1);
  });

  it('does not wait when the page has not seen the latest change (a change between two polls is not lost)', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.sv).toBe(0);
    core.statuses.set(jid, { state: 'working', label: 'Thinking' });
    core.changed(jid);                                                      // the page's next poll is not there yet
    const started = Date.now();
    const reply = await request(port, 'GET', '/api/poll?after=0&wait=5&sv=0', { cookie });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reply.json.status).toEqual({ state: 'working', label: 'Thinking' });
    expect(reply.json.sv).toBe(1);
  });

  it('waits as before when the page has the latest version, or says nothing of one (an older page)', async () => {
    const { port, cookie } = await start();
    const started = Date.now();
    const upToDate = await request(port, 'GET', '/api/poll?after=0&wait=1&sv=0', { cookie });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(upToDate.json.entries).toEqual([]);
    const older = Date.now();
    await request(port, 'GET', '/api/poll?after=0&wait=1', { cookie });
    expect(Date.now() - older).toBeGreaterThanOrEqual(900);
  });

  it('wakes a poll at most once a second, and the last change of a burst is still told', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    core.changed(jid);                                                      // the first change wakes at once (nobody is waiting yet)
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    const waiting = request(port, 'GET', '/api/poll?after=0&wait=5&sv=1', { cookie });
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (let i = 0; i < 4; i++) {
      core.statuses.set(jid, { state: 'working', label: i === 3 ? 'Reading a web page' : 'Thinking' });
      core.changed(jid);
    }
    const reply = await waiting;
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(700);                               // held to the second since the last wake
    expect(took).toBeLessThan(2500);
    expect(reply.json.status).toEqual({ state: 'working', label: 'Reading a web page' });
    expect(reply.json.sv).toBe(5);
  });

  it('puts the status of nobody else in a student\'s answer: each chat\'s own', async () => {
    const { port, cookie } = await start();
    core.typing.add('web:s_someoneelse');
    core.statuses.set('web:s_someoneelse', { state: 'working', label: 'Checking Canvas' });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toBeUndefined();
  });

  it('keeps no line in the history for a status', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    core.changed(jid);
    core.changed(jid);
    expect((await request(port, 'GET', '/api/history?limit=10', { cookie })).json.entries).toEqual([]);
  });

  // the preview of a reply being written (TAI_PORTAL_STREAM, docs/STREAMING.md): a field of the status, clipped here
  it('carries a preview of the reply in the status while TAi works, in /api/me and /api/poll, and no other kind of status carries one', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    core.statuses.set(jid, { state: 'working', label: 'Thinking', partial: 'Raft elects a leader. A candidate needs votes.' });
    const polled = await request(port, 'GET', '/api/poll?after=0', { cookie });
    expect(polled.json.status).toEqual({ state: 'working', label: 'Thinking', partial: 'Raft elects a leader. A candidate needs votes.' });
    expect((await request(port, 'GET', '/api/me', { cookie })).json.status.partial).toBe('Raft elects a leader. A candidate needs votes.');
    core.statuses.set(jid, { state: 'queued', ahead: 1, partial: 'Not while a message waits.' });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status).toEqual({ state: 'queued', ahead: 1 });
  });

  it('does not pass on a preview that is empty, not a string, or longer than the host ever makes one', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    for (const partial of ['', '   \n ', 7, null, ['x'], { text: 'x' }, 'x'.repeat(4001)]) {
      core.statuses.set(jid, { state: 'working', label: 'Thinking', partial });
      expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status, JSON.stringify(partial)?.slice(0, 20)).toEqual({ state: 'working', label: 'Thinking' });
    }
    core.statuses.set(jid, { state: 'working', label: 'Thinking', partial: 'x'.repeat(4000) });
    expect((await request(port, 'GET', '/api/poll?after=0', { cookie })).json.status.partial).toHaveLength(4000);
  });

  it('is byte for byte what it was without a preview when the status has none (the flag off): same fields, same order, same version', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    core.statuses.set(jid, { state: 'working', label: 'Checking Canvas' });
    const poll = await request(port, 'GET', '/api/poll?after=0', { cookie });
    expect(Object.keys(poll.json.status)).toEqual(['state', 'label']);
    expect(Object.keys(poll.json)).toEqual(['entries', 'last', 'typing', 'status', 'sv']);
    expect(JSON.stringify(poll.json.status)).toBe('{"state":"working","label":"Checking Canvas"}');
    expect(JSON.stringify((await request(port, 'GET', '/api/me', { cookie })).json)).not.toContain('partial');
  });

  it('wakes a waiting poll for a preview like for any status change, and the page gets the words that changed', async () => {
    const { port, cookie, jid } = await start();
    core.typing.add(jid);
    core.statuses.set(jid, { state: 'working', label: 'Thinking' });
    const first = await request(port, 'GET', '/api/poll?after=0', { cookie });
    const waiting = request(port, 'GET', `/api/poll?after=0&wait=5&sv=${first.json.sv}`, { cookie });
    await new Promise((resolve) => setTimeout(resolve, 100));
    core.statuses.set(jid, { state: 'working', label: 'Thinking', partial: 'One is first.' });
    core.changed(jid);
    const woken = await waiting;
    expect(woken.json.status.partial).toBe('One is first.');
    expect(woken.json.sv).toBeGreaterThan(first.json.sv);
  });
});

describe('the chips on an answer\'s history line', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];

  afterEach(async () => {
    for (const portal of portals.splice(0)) await portal.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('are clipped to the hosts the deployment names: another host\'s address goes, the label stays; four at most; the page gets them, and nothing else is changed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-sources-'));
    dirs.push(dir);
    const usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify({ users: [{ email: 'ada@example.com', name: 'Ada', canvasUserId: '1001', githubUsername: 'ada-eval', role: 'owner' }] }));
    const core = new StatusCore();
    const history = new HistoryStore(path.join(dir, 'history'));
    const portal = new Portal({
      core,
      users: new UserDirectory(usersFile),
      verifier: null,
      googleClientId: '',
      sessions: new SessionCodec(crypto.createHash('sha256').update('s').digest(), 3600),
      nonces: new NonceStore(5 * 60_000, 5000),
      history,
      staticFiles: {},
      basePath: '/',
      sourceHosts: new Set(['canvas.example.edu', 'github.com']),
      log: { info: () => undefined, warn: () => undefined },
    });
    await portal.listen({ host: '127.0.0.1', port: 0 });
    portals.push(portal);
    const user = new UserDirectory(usersFile).find('ada@example.com')!;
    core.listener!({
      kind: 'text',
      jid: user.jid,
      text: 'Homework 6 is due Friday.',
      sources: [
        { kind: 'canvas', label: 'Homework 6: Scalability?', url: 'https://canvas.example.edu/courses/1/assignments/107' },
        { kind: 'github', label: 'ann/cs6650-hw3', url: 'https://github.com/ann/cs6650-hw3' },
        { kind: 'canvas', label: 'phish', url: 'https://canvas.example.edu.evil.example/login' },
        { kind: 'piazza', label: '@45 Raft timeouts' },
        { kind: 'canvas', label: 'a fifth chip' },
        { kind: 'bogus', label: 'dropped' } as never,
      ],
    });
    const lines = history.forFolder(user.folder).since(0);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Homework 6 is due Friday.');
    expect(lines[0].sources).toEqual([
      { kind: 'canvas', label: 'Homework 6: Scalability?', url: 'https://canvas.example.edu/courses/1/assignments/107' },
      { kind: 'github', label: 'ann/cs6650-hw3', url: 'https://github.com/ann/cs6650-hw3' },
      { kind: 'canvas', label: 'phish' },
      { kind: 'piazza', label: '@45 Raft timeouts' },
    ]);
  });

  it('are not on a line that has none, and every address is dropped when the deployment names no host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-sources-'));
    dirs.push(dir);
    const usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(usersFile, JSON.stringify({ users: [{ email: 'ada@example.com', name: 'Ada', canvasUserId: '1001', role: 'owner' }] }));
    const core = new StatusCore();
    const history = new HistoryStore(path.join(dir, 'history'));
    const portal = new Portal({ core, users: new UserDirectory(usersFile), verifier: null, googleClientId: '', sessions: new SessionCodec(crypto.createHash('sha256').update('s').digest(), 3600), nonces: new NonceStore(5 * 60_000, 5000), history, staticFiles: {}, basePath: '/', log: { info: () => undefined, warn: () => undefined } });
    await portal.listen({ host: '127.0.0.1', port: 0 });
    portals.push(portal);
    const user = new UserDirectory(usersFile).find('ada@example.com')!;
    core.listener!({ kind: 'text', jid: user.jid, text: 'Plain answer.' });
    core.listener!({ kind: 'text', jid: user.jid, text: 'With a link.', sources: [{ kind: 'canvas', label: 'HW', url: 'https://canvas.example.edu/x' }] });
    const [plain, linked] = history.forFolder(user.folder).since(0);
    expect('sources' in plain).toBe(false);
    expect(linked.sources).toEqual([{ kind: 'canvas', label: 'HW' }]);
  });
});
