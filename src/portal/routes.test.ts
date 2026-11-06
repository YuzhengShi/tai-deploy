/**
 * The extension points feature modules use (PortalRoute, PortalOptions.routes and .features): a route added from outside server.ts gets the
 * checks of the built-in ones before its handler runs, and cannot take a path the server already has.
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
import { OutboundEntry, Portal, PortalCore, PortalOptions, PortalRoute } from './server.js';

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

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
}

describe('routes and features that feature modules add to the page', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];
  let usersFile: string;
  let historyDir: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-routes-'));
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

  function build(extra: Partial<PortalOptions> = {}): Portal {
    return new Portal({
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
      log: { info: () => undefined, warn: () => undefined },
      ...extra,
    });
  }

  async function start(extra: Partial<PortalOptions> = {}): Promise<number> {
    const portal = build(extra);
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

  const seen: Array<{ email: string; folder: string; query: string; body?: unknown }> = [];
  const hello: PortalRoute = {
    path: '/api/hello',
    method: 'GET',
    handler: ({ user, url, json }) => {
      seen.push({ email: user.email, folder: user.folder, query: url.search });
      json(200, { hello: user.name });
    },
  };
  const save: PortalRoute = {
    path: '/api/hello/save',
    method: 'POST',
    handler: async ({ user, readJson, json }) => {
      const body = await readJson();
      seen.push({ email: user.email, folder: user.folder, query: '', body });
      json(200, { saved: body });
    },
  };
  const ownerOnly: PortalRoute = { path: '/api/secret', method: 'GET', access: 'owner', handler: ({ json }) => json(200, { ok: true }) };

  beforeEach(() => {
    seen.length = 0;
  });

  it('answers 401 without a session, and gives the handler the signed-in student with a session', async () => {
    const port = await start({ routes: [hello] });
    expect((await request(port, 'GET', '/api/hello')).status).toBe(401);
    const cookie = await signIn(port, 'bob@example.com');
    const reply = await request(port, 'GET', '/api/hello?x=1', { cookie });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ hello: 'Bob' });
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(seen).toHaveLength(1);
    expect(seen[0].email).toBe('bob@example.com');
    expect(seen[0].query).toBe('?x=1');
  });

  it('refuses a POST that lacks the page header, comes from another origin or is not JSON, before the handler runs', async () => {
    const port = await start({ routes: [save] });
    const cookie = await signIn(port, 'bob@example.com');
    expect((await post(port, '/api/hello/save', { a: 1 }, cookie, { ...pageHeaders, 'x-tai': '0' })).json).toEqual({ error: 'csrf' });
    expect((await post(port, '/api/hello/save', { a: 1 }, cookie, { ...pageHeaders, origin: 'https://evil.example' })).json).toEqual({ error: 'origin' });
    expect((await post(port, '/api/hello/save', { a: 1 }, cookie, { ...pageHeaders, 'content-type': 'text/plain' })).json).toEqual({ error: 'content-type' });
    expect((await post(port, '/api/hello/save', { a: 1 }, cookie, { ...pageHeaders, 'sec-fetch-site': 'cross-site' })).json).toEqual({ error: 'cross-site' });
    expect(seen).toHaveLength(0);
    const ok = await post(port, '/api/hello/save', { a: 1 }, cookie);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ saved: { a: 1 } });
    expect(seen).toHaveLength(1);
  });

  it('answers 400 for a body that is not JSON and 413 for one that is too large', async () => {
    const port = await start({ routes: [save] });
    const cookie = await signIn(port, 'bob@example.com');
    expect((await request(port, 'POST', '/api/hello/save', { raw: '{nope', cookie, headers: pageHeaders })).status).toBe(400);
    expect((await request(port, 'POST', '/api/hello/save', { raw: JSON.stringify({ big: 'x'.repeat(20_000) }), cookie, headers: pageHeaders })).status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('keeps an owner-only route from everyone but the owner', async () => {
    const port = await start({ routes: [ownerOnly] });
    expect((await request(port, 'GET', '/api/secret')).status).toBe(401);
    const bob = await signIn(port, 'bob@example.com');
    const refused = await request(port, 'GET', '/api/secret', { cookie: bob });
    expect(refused.status).toBe(403);
    expect(refused.json).toEqual({ error: 'not-owner' });
    const ada = await signIn(port, 'ada@example.com');
    expect((await request(port, 'GET', '/api/secret', { cookie: ada })).status).toBe(200);
  });

  it('answers 405 for the wrong method on a registered path, and 404 for a path nobody registered', async () => {
    const port = await start({ routes: [hello] });
    expect((await post(port, '/api/hello', {})).status).toBe(405);
    expect((await request(port, 'GET', '/api/nothing-here')).status).toBe(404);
  });

  it('is never part of the owner\'s second chat', async () => {
    const port = await start({ routes: [hello] });
    const cookie = await signIn(port, 'ada@example.com');
    expect((await request(port, 'GET', '/api/admin/hello', { cookie })).status).toBe(404);
  });

  it('refuses at start a route that shadows a built-in path, is not an /api/ path or is registered twice', () => {
    const handler = () => undefined;
    for (const path of ['/api/me', '/api/me/extra', '/api/poll', '/api/send', '/api/admin/x', '/api/media/x', '/api/upload', '/api/upload/release', '/api/voicenote', '/api/memory', '/api/health', '/x', '/api/', '/api/../me', '/api/Hello']) {
      expect(() => build({ routes: [{ path, method: 'GET', handler }] }), path).toThrow(/cannot take the route/);
    }
    expect(() => build({ routes: [hello, hello] })).toThrow(/registered twice/);
    // the same path with the other method is another route
    expect(() => build({ routes: [hello, { ...hello, method: 'POST' }] })).not.toThrow();
  });

  it('merges the features of feature modules into /api/me, and the built-in ones win', async () => {
    const port = await start({ features: (user) => ({ team: user.role === 'owner', files: 'not a boolean' }) });
    const bob = await request(port, 'GET', '/api/me', { cookie: await signIn(port, 'bob@example.com') });
    expect(bob.json.features.team).toBe(false);
    expect(bob.json.features.files).toBe(false);
    const ada = await request(port, 'GET', '/api/me', { cookie: await signIn(port, 'ada@example.com') });
    expect(ada.json.features.team).toBe(true);
  });

  it('keeps /api/me working when a feature module throws', async () => {
    const port = await start({
      features: () => {
        throw new Error('boom');
      },
    });
    const reply = await request(port, 'GET', '/api/me', { cookie: await signIn(port, 'bob@example.com') });
    expect(reply.status).toBe(200);
    expect(reply.json.features.activity).toBe(true);
  });
});
