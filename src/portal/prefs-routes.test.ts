/**
 * The calls of the Settings dialog through a real Portal on a loopback port: the preferences and push routes (who may call them, what they
 * refuse, what they keep), the features they switch on, and the three things the page's server itself does for notifications: the manifest in
 * its content policy, the types of the files a home-screen app needs, and what each poll tells the presence hook.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { b64url, endpointHash } from '../notify/webpush.js';
import { AuthError, NonceStore, PortalUser, SessionCodec, UserDirectory } from './auth.js';
import { HistoryStore } from './history.js';
import { PrefsStore } from './prefs.js';
import { prefsRoutes, type PrefsRoutesDeps } from './prefs-routes.js';
import { OutboundEntry, Portal, PortalCore, PortalOptions, loadStaticFiles } from './server.js';

const ORIGIN = 'https://tai.example';
const PUBLIC_KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

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
  ensureAdmin(): string {
    return 'web:main';
  }
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  body: Buffer;
}

/** A browser's subscription: real keys, an endpoint on one of the allowed services. */
function subscription(n: number) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}:token`, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(crypto.randomBytes(16)) } };
}

describe('preferences, push, and what the page\'s server does for them', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];
  let usersFile: string;
  let prefsDir: string;
  let store: PrefsStore;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-prefs-routes-'));
    dirs.push(dir);
    usersFile = path.join(dir, 'users.json');
    prefsDir = path.join(dir, 'prefs');
    store = new PrefsStore(prefsDir);
    fs.writeFileSync(
      usersFile,
      JSON.stringify({ users: [{ email: 'ada@example.com', name: 'Ada', canvasUserId: '1001', role: 'owner' }, { email: 'bob@example.com', name: 'Bob', canvasUserId: '1002' }] }),
    );
  });

  afterEach(async () => {
    for (const portal of portals.splice(0)) await portal.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(extra: Partial<PortalOptions> = {}, deps: Partial<PrefsRoutesDeps> = {}): Portal {
    const routes = prefsRoutes({ prefs: store, push: { publicKey: PUBLIC_KEY }, limits: { quietStart: '22:00', quietEnd: '08:00', dailyMax: 3 }, ...deps });
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
      history: new HistoryStore(path.join(path.dirname(usersFile), 'history')),
      staticFiles: { '/index.html': { body: Buffer.from('<!doctype html><title>TAi</title>'), type: 'text/html; charset=utf-8' } },
      basePath: '/tai',
      origin: ORIGIN,
      trustProxy: true,
      routes,
      features: () => ({ prefs: true, push: !!deps.push || deps.push === undefined, email: false }),
      log: { info: () => undefined, warn: () => undefined },
      ...extra,
    });
  }

  async function start(extra: Partial<PortalOptions> = {}, deps: Partial<PrefsRoutesDeps> = {}): Promise<number> {
    const portal = build(extra, deps);
    await portal.listen({ host: '127.0.0.1', port: 0 });
    portals.push(portal);
    return portal.address()!.port;
  }

  function request(port: number, method: string, url: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string>; abortAfterMs?: number } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
      const headers: Record<string, string> = { ...(options.headers || {}) };
      if (options.cookie) headers.cookie = options.cookie;
      if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
      const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          let json: any;
          try {
            json = JSON.parse(body.toString('utf-8'));
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, json, body });
        });
      });
      req.on('error', (err) => (options.abortAfterMs ? resolve({ status: 0, headers: {}, json: undefined, body: Buffer.alloc(0) }) : reject(err)));
      if (options.abortAfterMs) setTimeout(() => req.destroy(), options.abortAfterMs);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const pageHeaders = { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  const get = (port: number, url: string, cookie?: string) => request(port, 'GET', url, { cookie });
  const post = (port: number, url: string, body: unknown, cookie?: string, headers: Record<string, string> = pageHeaders) => request(port, 'POST', url, { body, cookie, headers });

  async function signIn(port: number, email: string): Promise<string> {
    const { json } = await request(port, 'GET', '/auth/nonce');
    const reply = await post(port, '/auth/google', { credential: `good:${email}`, nonce: json.nonce });
    expect(reply.status).toBe(200);
    return String(reply.headers['set-cookie']).split(';')[0];
  }

  const folderOf = (email: string) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 20);
  const ADA = () => `s_${folderOf('ada@example.com')}`;
  const BOB = () => `s_${folderOf('bob@example.com')}`;

  describe('GET and POST api/prefs', () => {
    it('answer 401 without a session, and give a new student the defaults', async () => {
      const port = await start();
      expect((await get(port, '/api/prefs')).status).toBe(401);
      const bob = await signIn(port, 'bob@example.com');
      const reply = await get(port, '/api/prefs', bob);
      expect(reply.status).toBe(200);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.json).toEqual({
        tz: null,
        voiceSpeed: null,
        defaults: { voiceSpeed: 1 },
        notify: { push: [], email: { enabled: false } },
        limits: { quietStart: '22:00', quietEnd: '08:00', dailyMax: 3, maxDevices: 5 },
      });
    });

    it('keep a time zone and a voice speed, validated, in the file other pieces read', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      const reply = await post(port, '/api/prefs', { tz: 'america/vancouver', voiceSpeed: 1.03 }, bob);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ tz: 'America/Vancouver', voiceSpeed: 1.05 });
      const file = JSON.parse(fs.readFileSync(path.join(prefsDir, `${BOB()}.prefs.json`), 'utf-8'));
      expect(file).toMatchObject({ tz: 'America/Vancouver', voiceSpeed: 1.05 });
      expect((await get(port, '/api/prefs', bob)).json).toMatchObject({ tz: 'America/Vancouver', voiceSpeed: 1.05 });
      await post(port, '/api/prefs', { voiceSpeed: 0.85 }, bob);                       // a partial update leaves the rest
      expect((await get(port, '/api/prefs', bob)).json).toMatchObject({ tz: 'America/Vancouver', voiceSpeed: 0.85 });
    });

    it('say what a call uses until the student chooses: no voiceSpeed (null) and the deployment\'s own pace as the default, which a choice of 1 is not', async () => {
      const port = await start({}, { defaults: { voiceSpeed: 1.2 } });
      const bob = await signIn(port, 'bob@example.com');
      expect((await get(port, '/api/prefs', bob)).json).toMatchObject({ voiceSpeed: null, defaults: { voiceSpeed: 1.2 } });
      expect((await post(port, '/api/prefs', { tz: 'UTC' }, bob)).json).toMatchObject({ voiceSpeed: null, defaults: { voiceSpeed: 1.2 } });      // a time zone is not a speed
      const chosen = await post(port, '/api/prefs', { voiceSpeed: 1 }, bob);
      expect(chosen.json).toMatchObject({ voiceSpeed: 1, defaults: { voiceSpeed: 1.2 } });                // "normal" is a choice: the file holds it, and a call reads it
      expect(JSON.parse(fs.readFileSync(path.join(prefsDir, `${BOB()}.prefs.json`), 'utf-8')).voiceSpeed).toBe(1);
    });

    it('refuse unknown keys, values that are not valid and an empty body, and keep nothing of a request that is partly bad', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      const bad = async (body: unknown) => (await post(port, '/api/prefs', body, bob)).json;
      expect(await bad({ theme: 'night' })).toEqual({ error: 'unknown-key', key: 'theme' });
      expect(await bad({ tz: 'UTC', theme: 'night' })).toEqual({ error: 'unknown-key', key: 'theme' });
      expect(await bad({})).toEqual({ error: 'empty' });
      expect(await bad({ tz: 'Mars/Base' })).toEqual({ error: 'bad-tz' });
      expect(await bad({ tz: '+05:00' })).toEqual({ error: 'bad-tz' });
      expect(await bad({ tz: 5 })).toEqual({ error: 'bad-tz' });
      expect(await bad({ tz: null })).toEqual({ error: 'bad-tz' });
      expect(await bad({ voiceSpeed: 2 })).toEqual({ error: 'bad-voice-speed' });
      expect(await bad({ voiceSpeed: '1.1' })).toEqual({ error: 'bad-voice-speed' });
      expect(await bad({ voiceSpeed: 0.5 })).toEqual({ error: 'bad-voice-speed' });
      expect(await bad({ tz: 'UTC', voiceSpeed: 9 })).toEqual({ error: 'bad-voice-speed' });
      expect(await bad({ notify: 'yes' })).toEqual({ error: 'bad-notify' });
      expect(await bad({ notify: { push: [] } })).toEqual({ error: 'unknown-key', key: 'notify.push' });
      expect(await bad({ notify: { push: [{ endpoint: 'https://fcm.googleapis.com/x' }] } })).toEqual({ error: 'unknown-key', key: 'notify.push' });
      expect(await bad({ notify: {} })).toEqual({ error: 'empty' });
      expect(await bad({ notify: { email: { enabled: 'yes' } } })).toEqual({ error: 'bad-email' });
      expect(await bad({ notify: { email: { enabled: true, address: 'x@y.z' } } })).toEqual({ error: 'unknown-key', key: 'notify.email.address' });
      expect(await bad({ ['x'.repeat(100) + '\u0000']: 1 })).toMatchObject({ error: 'unknown-key' });
      expect(fs.existsSync(path.join(prefsDir, `${BOB()}.prefs.json`))).toBe(false);
    });

    it('do not let a student switch e-mail on while there is no e-mail, and do when there is', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      expect((await post(port, '/api/prefs', { notify: { email: { enabled: true } } }, bob)).json).toEqual({ error: 'email-off' });
      expect(store.read(BOB()).notify.email.enabled).toBe(false);
      const withMail = await start({}, { emailAvailable: () => true });
      const ada = await signIn(withMail, 'ada@example.com');
      const reply = await post(withMail, '/api/prefs', { notify: { email: { enabled: true } } }, ada);
      expect(reply.json.notify.email).toEqual({ enabled: true });
      expect(store.read(ADA()).notify.email.enabled).toBe(true);
    });

    it('refuse a POST without the page\'s header, from another origin or that is not JSON, before anything is kept', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      expect((await post(port, '/api/prefs', { tz: 'UTC' }, bob, { ...pageHeaders, 'x-tai': '0' })).json).toEqual({ error: 'csrf' });
      expect((await post(port, '/api/prefs', { tz: 'UTC' }, bob, { ...pageHeaders, origin: 'https://evil.example' })).json).toEqual({ error: 'origin' });
      expect((await post(port, '/api/prefs', { tz: 'UTC' }, bob, { ...pageHeaders, 'content-type': 'text/plain' })).json).toEqual({ error: 'content-type' });
      expect((await post(port, '/api/prefs', { tz: 'UTC' })).status).toBe(401);                       // the page's own headers but no session
      expect(fs.existsSync(path.join(prefsDir, `${BOB()}.prefs.json`))).toBe(false);
    });

    it('are about the signed-in student alone: one student\'s choices are not another\'s', async () => {
      const port = await start();
      const ada = await signIn(port, 'ada@example.com');
      const bob = await signIn(port, 'bob@example.com');
      await post(port, '/api/prefs', { tz: 'Asia/Tokyo', voiceSpeed: 1.2 }, ada);
      expect((await get(port, '/api/prefs', bob)).json).toMatchObject({ tz: null, voiceSpeed: null });
      expect((await get(port, '/api/prefs', ada)).json).toMatchObject({ tz: 'Asia/Tokyo', voiceSpeed: 1.2 });
      expect((await get(port, '/api/admin/prefs', ada)).status).toBe(404);                      // never part of the owner's second chat
    });
  });

  describe('the push routes', () => {
    it('serve the public key to a student who is signed in', async () => {
      const port = await start();
      expect((await get(port, '/api/push/key')).status).toBe(401);
      const reply = await get(port, '/api/push/key', await signIn(port, 'bob@example.com'));
      expect(reply.json).toEqual({ key: PUBLIC_KEY });
    });

    it('keep a browser\'s subscription and show the student only its name, never the address or the keys', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      const sub = subscription(1);
      const reply = await post(port, '/api/push/subscribe', { ...sub, expirationTime: null }, bob);
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ ok: true, id: endpointHash(sub.endpoint), devices: 1 });
      expect(store.read(BOB()).notify.push.map((s) => s.endpoint)).toEqual([sub.endpoint]);
      const view = await get(port, '/api/prefs', bob);
      expect(view.json.notify.push).toEqual([{ id: endpointHash(sub.endpoint), added: expect.any(String) }]);
      expect(view.body.toString()).not.toContain('fcm.googleapis.com');
      expect(view.body.toString()).not.toContain(sub.keys.auth);
      expect(view.body.toString()).not.toContain(sub.keys.p256dh);
      await post(port, '/api/push/subscribe', sub, bob);                                           // the same browser again: still one
      expect((await get(port, '/api/prefs', bob)).json.notify.push).toHaveLength(1);
    });

    it('refuse an endpoint that is not one of the push services (the server would connect to it), whatever else is right', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      const keys = subscription(1).keys;
      for (const endpoint of [
        'http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data/',
        'https://tai-live-litellm/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evilfcm.googleapis.com/x', 'https://fcm.googleapis.com@evil.example/x',
        'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com./x', 'https://evil.example/x', '', 'not a url',
      ]) {
        const reply = await post(port, '/api/push/subscribe', { endpoint, keys }, bob);
        expect(reply.status, endpoint).toBe(400);
        expect(reply.json, endpoint).toEqual({ error: 'bad-endpoint' });
      }
      expect((await post(port, '/api/push/subscribe', { endpoint: 12, keys }, bob)).json).toEqual({ error: 'bad-endpoint' });
      expect(store.read(BOB()).notify.push).toEqual([]);
    });

    it('refuse keys that are not a point of the curve and a secret of the right size, a body with other keys, and an expired subscription', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      const sub = subscription(1);
      const bad = async (body: unknown) => (await post(port, '/api/push/subscribe', body, bob)).json;
      expect(await bad({ endpoint: sub.endpoint })).toEqual({ error: 'bad-keys' });
      expect(await bad({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh } })).toEqual({ error: 'bad-keys' });
      expect(await bad({ endpoint: sub.endpoint, keys: { p256dh: b64url(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: sub.keys.auth } })).toEqual({ error: 'bad-keys' });
      expect(await bad({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: b64url(crypto.randomBytes(8)) } })).toEqual({ error: 'bad-keys' });
      expect(await bad({ ...sub, extra: 1 })).toEqual({ error: 'unknown-key', key: 'extra' });
      expect(await bad({ ...sub, expirationTime: Date.now() - 1000 })).toEqual({ error: 'expired' });
      expect(await bad({ ...sub, expirationTime: 'soon' })).toEqual({ error: 'bad-request' });
      expect((await post(port, '/api/push/subscribe', { ...sub, expirationTime: Date.now() + 86_400_000 }, bob)).status).toBe(200);
    });

    it('keep five browsers a student: a sixth takes the place of the oldest', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      for (let n = 1; n <= 6; n++) expect((await post(port, '/api/push/subscribe', subscription(n), bob)).status).toBe(200);
      const listed = store.read(BOB()).notify.push.map((s) => s.endpoint);
      expect(listed).toHaveLength(5);
      expect(listed).not.toContain(subscription(1).endpoint);
      expect(listed).toContain('https://fcm.googleapis.com/fcm/send/device-6:token');
    });

    it('give a browser to one student at a time: the one who turned it on last has it (a shared computer)', async () => {
      const port = await start();
      const ada = await signIn(port, 'ada@example.com');
      const bob = await signIn(port, 'bob@example.com');
      const shared = subscription(7);
      await post(port, '/api/push/subscribe', shared, ada);
      expect(store.read(ADA()).notify.push).toHaveLength(1);
      await post(port, '/api/push/subscribe', shared, bob);
      expect(store.read(ADA()).notify.push).toEqual([]);
      expect(store.read(BOB()).notify.push).toHaveLength(1);
    });

    it('allow a student 20 subscriptions in ten minutes, and then say so', async () => {
      const port = await start();
      const bob = await signIn(port, 'bob@example.com');
      for (let n = 1; n <= 20; n++) expect((await post(port, '/api/push/subscribe', subscription(n), bob)).status, String(n)).toBe(200);
      const reply = await post(port, '/api/push/subscribe', subscription(21), bob);
      expect(reply.status).toBe(429);
      expect(reply.json).toEqual({ error: 'rate-limited' });
    });

    it('take a browser off by its address or by its name, quietly when it is not there, and only from the student who asks', async () => {
      const port = await start();
      const ada = await signIn(port, 'ada@example.com');
      const bob = await signIn(port, 'bob@example.com');
      const one = subscription(1);
      const two = subscription(2);
      await post(port, '/api/push/subscribe', one, bob);
      await post(port, '/api/push/subscribe', two, bob);
      await post(port, '/api/push/subscribe', subscription(3), ada);
      expect((await post(port, '/api/push/unsubscribe', { endpoint: subscription(3).endpoint }, bob)).json).toEqual({ ok: true, removed: false, devices: 2 });    // Ada's is not Bob's to take off
      expect((await post(port, '/api/push/unsubscribe', { endpoint: one.endpoint }, bob)).json).toEqual({ ok: true, removed: true, devices: 1 });
      expect((await post(port, '/api/push/unsubscribe', { id: endpointHash(two.endpoint) }, bob)).json).toEqual({ ok: true, removed: true, devices: 0 });
      expect((await post(port, '/api/push/unsubscribe', { id: endpointHash(two.endpoint) }, bob)).json).toEqual({ ok: true, removed: false, devices: 0 });
      expect(store.read(ADA()).notify.push).toHaveLength(1);
      expect((await post(port, '/api/push/unsubscribe', {}, bob)).json).toEqual({ error: 'bad-request' });
      expect((await post(port, '/api/push/unsubscribe', { id: 'xyz' }, bob)).json).toEqual({ error: 'bad-request' });
      expect((await post(port, '/api/push/unsubscribe', { endpoint: one.endpoint, extra: 1 }, bob)).json).toEqual({ error: 'unknown-key', key: 'extra' });
    });

    it('say that push is off when there is no key: 404 for the key and for a subscription, while a browser can still be taken off', async () => {
      const port = await start({}, { push: null });
      const bob = await signIn(port, 'bob@example.com');
      expect((await get(port, '/api/push/key', bob)).json).toEqual({ error: 'push-off' });
      expect((await post(port, '/api/push/subscribe', subscription(1), bob)).status).toBe(404);
      store.addPush(BOB(), subscription(1));
      expect((await post(port, '/api/push/unsubscribe', { endpoint: subscription(1).endpoint }, bob)).json).toMatchObject({ ok: true, removed: true });
      expect((await get(port, '/api/me', bob)).json.features).toMatchObject({ prefs: true, push: false, email: false });
    });

    it('add prefs, push and email to what GET api/me says the page may draw', async () => {
      const port = await start();
      const features = (await get(port, '/api/me', await signIn(port, 'bob@example.com'))).json.features;
      expect(features).toMatchObject({ prefs: true, push: true, email: false });
    });
  });

  describe('what the page\'s server itself does for them', () => {
    it('lets the page load its manifest: manifest-src \'self\' is its own directive of the content policy', async () => {
      const port = await start();
      const reply = await get(port, '/');
      const policy = String(reply.headers['content-security-policy']);
      expect(policy.split('; ')).toContain("manifest-src 'self'");
      expect(policy).toContain("worker-src 'self'");
      expect(policy).toContain("default-src 'none'");
    });

    it('serves the service worker, the manifest and the icons with their own types, without caching, and the bytes as they are', async () => {
      const files = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-static-'));
      dirs.push(files);
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(300)]);
      fs.writeFileSync(path.join(files, 'index.html'), '<!doctype html><link rel="manifest" href="manifest.webmanifest"><base href="__BASE__">');
      fs.writeFileSync(path.join(files, 'sw.js'), "self.addEventListener('push', () => {});");
      fs.writeFileSync(path.join(files, 'manifest.webmanifest'), '{"name":"TAi"}');
      fs.writeFileSync(path.join(files, 'icon-192.png'), png);
      const port = await start({ staticFiles: loadStaticFiles(files, ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png'], '/tai') });
      const sw = await get(port, '/sw.js');
      expect(sw.status).toBe(200);
      expect(sw.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(sw.headers['cache-control']).toBe('no-cache');                                          // a new worker is picked up at the next visit
      expect(sw.headers.etag).toBeTruthy();
      const manifest = await get(port, '/manifest.webmanifest');
      expect(manifest.headers['content-type']).toBe('application/manifest+json');
      expect(manifest.headers['cache-control']).toBe('no-cache');
      expect(manifest.json).toEqual({ name: 'TAi' });
      const icon = await get(port, '/icon-192.png');
      expect(icon.headers['content-type']).toBe('image/png');
      expect(icon.headers['cache-control']).toBe('no-cache');
      expect(icon.body.equals(png)).toBe(true);
      expect(icon.headers['content-security-policy']).toBeUndefined();                                // only the page itself carries the policy
      expect((await request(port, 'GET', '/icon-192.png', { headers: { 'if-none-match': String(icon.headers.etag) } })).status).toBe(304);
      expect((await get(port, '/icon-512.png')).status).toBe(404);                                    // only the names that were listed
    });

    describe('tells the presence hook what each poll says', () => {
      interface Begun { folder: string; client: string | null; visible: boolean; ended?: boolean; gone?: boolean }
      const PAGE = '11111111-1111-4111-8111-111111111111';

      function presence() {
        const begun: Begun[] = [];
        return {
          begun,
          hook: {
            begin(folder: string, client: string | null, visible: boolean) {
              const entry: Begun = { folder, client, visible };
              begun.push(entry);
              return (gone?: boolean) => {
                entry.ended = true;
                entry.gone = gone === true;
              };
            },
          },
        };
      }
      const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

      it('which page it is and whether its tab is in front, and that it was answered', async () => {
        const p = presence();
        const port = await start({ presence: p.hook });
        const bob = await signIn(port, 'bob@example.com');
        await get(port, `/api/poll?after=999999&wait=0&c=${PAGE}&v=1`, bob);
        await get(port, `/api/poll?after=999999&wait=0&c=${PAGE}&v=0`, bob);
        await get(port, '/api/poll?after=999999&wait=0', bob);
        await settle();
        expect(p.begun).toEqual([
          { folder: BOB(), client: PAGE, visible: true, ended: true, gone: false },
          { folder: BOB(), client: PAGE, visible: false, ended: true, gone: false },
          { folder: BOB(), client: null, visible: true, ended: true, gone: false },
        ]);
      });

      it('and that the page went away when a held poll was dropped (the tab was closed)', async () => {
        const p = presence();
        const port = await start({ presence: p.hook });
        const bob = await signIn(port, 'bob@example.com');
        await request(port, 'GET', `/api/poll?after=999999&wait=5&c=${PAGE}&v=1`, { cookie: bob, abortAfterMs: 150 });
        await settle();
        expect(p.begun).toHaveLength(1);
        expect(p.begun[0]).toMatchObject({ client: PAGE, visible: true, ended: true, gone: true });
      });

      it('only for a signed-in student\'s own chat: not for a request without a session, and not for the owner\'s second chat', async () => {
        const p = presence();
        const port = await start({ presence: p.hook });
        expect((await get(port, `/api/poll?after=0&wait=0&c=${PAGE}&v=1`)).status).toBe(401);
        const ada = await signIn(port, 'ada@example.com');
        await get(port, `/api/admin/poll?after=999999&wait=0&c=${PAGE}&v=1`, ada);
        expect(p.begun).toEqual([]);
      });

      it('and works as before when there is no hook', async () => {
        const port = await start();
        const bob = await signIn(port, 'bob@example.com');
        expect((await get(port, '/api/poll?after=999999&wait=0', bob)).status).toBe(200);
      });
    });
  });
});
