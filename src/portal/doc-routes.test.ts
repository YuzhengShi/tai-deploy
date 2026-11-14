/**
 * The document viewer's routes (src/portal/doc-routes.ts): a Portal on a loopback port, a fake core and a fake documents service, as voice-routes.test.ts does it. The service's own rules
 * (the renderer, the store, the rates) are src/docs/*.test.ts; what is tested here is what the ROUTES decide: whose document it is, which file a message names, the shapes and statuses of the answers,
 * and what happens to a document that takes long.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { ALPHA_WORDS, jpeg, png } from '../docs/testing/harness.js';
import type { DocMeta, DocOpenResult, DocSource, DocsApi, PageWords } from '../docs/types.js';
import { DOC_ERROR_STATUS, DOC_JOB_TTL_MS, DOC_READ_LIMIT, docRoutes } from './doc-routes.js';
import type { DocRoutesDeps } from './doc-routes.js';
import { AuthError, NonceStore, PortalUser, SessionCodec, UserDirectory } from './auth.js';
import { HistoryStore } from './history.js';
import { OutboundEntry, Portal, PortalCore, PortalOptions } from './server.js';

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

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  body: Buffer;
}

describe('the document viewer routes', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];
  let usersFile: string;
  let historyDir: string;
  let store: HistoryStore;
  let files: Map<string, Buffer>;
  let opened: Array<{ folder: string; source: DocSource }>;
  let cards: Array<{ folder: string; obj: unknown }>;
  let docsByFolder: Map<string, Map<string, DocMeta>>;
  let openImpl: (folder: string, source: DocSource) => Promise<DocOpenResult>;
  let metaCalls: Array<{ folder: string; id: string }>;
  let clock: number;

  const folderOf = (email: string): string => new UserDirectory(usersFile).find(email)!.folder;
  const meta = (id: string, title = 'Lecture 3', pages = 3): DocMeta => ({ id, title, pages, origin: 'upload', createdAt: 5, bytes: 1000, aspect: 0.7727 });

  /** A documents service that knows two documents of Ada's and one of Bob's, and answers only to the folder it is asked as. */
  function fakeDocs(): DocsApi {
    const own = (folder: string, id: string) => docsByFolder.get(folder)?.get(id) ?? null;
    return {
      open: (who, source) => {
        opened.push({ folder: who.folder, source });
        return openImpl(who.folder, source);
      },
      meta: (folder, id) => {
        metaCalls.push({ folder, id });
        return own(folder, id);
      },
      words: (folder, id, page): PageWords | null => (own(folder, id) && page >= 1 && page <= own(folder, id)!.pages ? { words: ALPHA_WORDS, lines: [[0, 2], [3, 5]] } : null),
      text: () => null,
      pageFile: (folder, id, page) => {
        const m = own(folder, id);
        if (!m || page < 1 || page > m.pages) return null;
        const file = files.get(`${id}/${page}`);
        return file ? { file: path.join(dirs[0], `${id}-${page}`), type: page === 2 ? 'image/jpeg' : 'image/png' } : null;
      },
      list: () => [],
      library: () => [],
      searchLibrary: () => [],
      ready: async () => true,
      reap: async () => 0,
    };
  }

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-doc-routes-'));
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
    store = new HistoryStore(historyDir);
    clock = 1_800_000_000_000;
    files = new Map([[`${ID_A}/1`, png()], [`${ID_A}/2`, jpeg()], [`${ID_A}/3`, png()]]);
    for (const [key, bytes] of files) fs.writeFileSync(path.join(dir, key.replace('/', '-')), bytes);
    docsByFolder = new Map([
      [folderOf('ada@example.com'), new Map([[ID_A, meta(ID_A)]])],
      [folderOf('bob@example.com'), new Map([[ID_B, meta(ID_B, "Bob's notes", 1)]])],
    ]);
    opened = [];
    cards = [];
    metaCalls = [];
    openImpl = async (_folder, source) => ({ ok: true, doc: meta(source.kind === 'existing' ? source.id : ID_A), page: 1 });
  });

  afterEach(async () => {
    for (const portal of portals.splice(0)) await portal.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(over: Partial<DocRoutesDeps> = {}, withDocs = true): Promise<number> {
    const routes = withDocs ? docRoutes({ docs: fakeDocs(), history: store, postObject: (folder, obj) => void cards.push({ folder, obj }), now: () => clock, waitMs: 40, ...over }) : [];
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
      history: store,
      staticFiles: { '/index.html': { body: Buffer.from('<!doctype html><title>TAi</title>'), type: 'text/html; charset=utf-8' } },
      basePath: '/tai',
      origin: ORIGIN,
      trustProxy: true,
      routes,
      log: { info: () => undefined, warn: () => undefined },
    } as PortalOptions);
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
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  const pageHeaders = { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  const post = (port: number, url: string, body: unknown, cookie?: string, headers: Record<string, string> = pageHeaders) => request(port, 'POST', url, { body, cookie, headers });
  const get = (port: number, url: string, cookie: string) => request(port, 'GET', url, { cookie });

  async function signIn(port: number, email: string): Promise<string> {
    const { json } = await request(port, 'GET', '/auth/nonce');
    const reply = await post(port, '/auth/google', { credential: `good:${email}`, nonce: json.nonce });
    expect(reply.status).toBe(200);
    return String(reply.headers['set-cookie']).split(';')[0];
  }

  /** A line of the student's history with files on it: the message `n` and the stored names. */
  function say(email: string, names: Array<{ name: string; kind?: 'document' | 'text' | 'image' }>, role: 'user' | 'assistant' = 'user'): number {
    const line = store.forFolder(folderOf(email)).append(role, 'here are my files', new Date(), { files: names.map((f) => ({ name: f.name, size: 1234, kind: f.kind ?? 'document' })) });
    return line.n;
  }

  // ---------------------------------------------------------------- who may ask

  it('is for signed-in students only, and a POST must be the page\'s (the server checks before the handler runs)', async () => {
    const port = await start();
    for (const url of ['/api/doc/meta?d=' + ID_A, '/api/doc/page?d=' + ID_A + '&p=1', '/api/doc/words?d=' + ID_A + '&p=1', '/api/doc/job?j=' + 'c'.repeat(24)]) expect((await request(port, 'GET', url)).status).toBe(401);
    expect((await post(port, '/api/doc/open', { doc: ID_A })).status).toBe(401);
    const cookie = await signIn(port, 'bob@example.com');
    expect((await post(port, '/api/doc/open', { doc: ID_B }, cookie, { ...pageHeaders, 'x-tai': '0' })).json).toEqual({ error: 'csrf' });
    expect((await post(port, '/api/doc/open', { doc: ID_B }, cookie, { ...pageHeaders, origin: 'https://evil.example' })).json).toEqual({ error: 'origin' });
    expect((await post(port, '/api/doc/open', { doc: ID_B }, cookie, { ...pageHeaders, 'content-type': 'text/plain' })).json).toEqual({ error: 'content-type' });
    expect((await request(port, 'POST', '/api/doc/open', { raw: '{nope', cookie, headers: pageHeaders })).status).toBe(400);
    expect((await request(port, 'GET', '/api/doc/open', { cookie })).status).toBe(405);
    expect((await post(port, '/api/doc/meta', {}, cookie)).status).toBe(405);
    expect(opened).toEqual([]);
  });

  it('is not there at all when the service is off', async () => {
    const port = await start({}, false);
    const cookie = await signIn(port, 'bob@example.com');
    expect((await get(port, '/api/doc/meta?d=' + ID_B, cookie)).status).toBe(404);
    expect((await post(port, '/api/doc/open', { doc: ID_B }, cookie)).status).toBe(404);
  });

  // ---------------------------------------------------------------- meta, words, page

  it('answers the meta of the student\'s own document as the DocMeta itself, and "not found" for another student\'s, exactly like a document that does not exist', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const bob = await signIn(port, 'bob@example.com');
    const own = await get(port, `/api/doc/meta?d=${ID_A}`, ada);
    expect(own.status).toBe(200);
    expect(own.json).toEqual(meta(ID_A));
    expect(own.headers['cache-control']).toBe('private, no-cache');
    const other = await get(port, `/api/doc/meta?d=${ID_A}`, bob);
    const missing = await get(port, `/api/doc/meta?d=${'c'.repeat(32)}`, bob);
    expect(other.status).toBe(404);
    expect(other.json).toEqual({ error: 'not-found' });
    expect({ status: other.status, json: other.json }).toEqual({ status: missing.status, json: missing.json });
    // the folder is the session's: nothing in the request changes whose document is asked for
    metaCalls.length = 0;
    await request(port, 'GET', `/api/doc/meta?d=${ID_A}&folder=${folderOf('ada@example.com')}&user=ada@example.com`, { cookie: bob, headers: { 'x-folder': folderOf('ada@example.com') } });
    expect(metaCalls).toEqual([{ folder: folderOf('bob@example.com'), id: ID_A }]);
  });

  it('answers 400 for an id that is not one and for a page that is not a page, before asking the service anything', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    metaCalls.length = 0;
    for (const url of ['/api/doc/meta', '/api/doc/meta?d=', '/api/doc/meta?d=../etc', `/api/doc/meta?d=${ID_A.toUpperCase()}`, `/api/doc/meta?d=${ID_A}x`, `/api/doc/page?d=${ID_A}`, `/api/doc/page?d=${ID_A}&p=0`, `/api/doc/page?d=${ID_A}&p=121`, `/api/doc/page?d=${ID_A}&p=1.5`, `/api/doc/page?d=${ID_A}&p=-1`, `/api/doc/page?d=${ID_A}&p=abc`, `/api/doc/words?d=${ID_A}&p=0001`, `/api/doc/words?p=1`]) {
      const r = await get(port, url, ada);
      expect(r.status, url).toBe(400);
      expect(r.json.error, url).toBe('bad-request');
    }
    expect(metaCalls).toEqual([]);
  });

  it('answers the words of a page as the PageWords, for the student\'s own pages only', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const bob = await signIn(port, 'bob@example.com');
    const r = await get(port, `/api/doc/words?d=${ID_A}&p=2`, ada);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ words: ALPHA_WORDS, lines: [[0, 2], [3, 5]] });
    expect(r.headers['cache-control']).toBe('private, max-age=3600');
    expect((await get(port, `/api/doc/words?d=${ID_A}&p=4`, ada)).status).toBe(404);
    expect((await get(port, `/api/doc/words?d=${ID_A}&p=1`, bob)).status).toBe(404);
  });

  it('serves a page image as its own bytes, with the type sniffed from them, nosniff, a private cache and a policy that lets the image run and load nothing', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const bob = await signIn(port, 'bob@example.com');
    const first = await request(port, 'GET', `/api/doc/page?d=${ID_A}&p=1`, { cookie: ada });
    expect(first.status).toBe(200);
    expect(first.body.equals(png())).toBe(true);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.headers['content-length']).toBe(String(png().length));
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect(first.headers['cache-control']).toBe('private, max-age=3600');
    expect(first.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    const second = await request(port, 'GET', `/api/doc/page?d=${ID_A}&p=2`, { cookie: ada });
    expect(second.headers['content-type']).toBe('image/jpeg');
    expect(second.body.equals(jpeg())).toBe(true);
    expect((await request(port, 'GET', `/api/doc/page?d=${ID_A}&p=1`, { cookie: bob })).status).toBe(404);
    expect((await request(port, 'GET', `/api/doc/page?d=${ID_A}&p=9`, { cookie: ada })).status).toBe(404);
    files.delete(`${ID_A}/3`);
    expect((await request(port, 'GET', `/api/doc/page?d=${ID_A}&p=3`, { cookie: ada })).status).toBe(404);
    fs.rmSync(path.join(dirs[0], `${ID_A}-1`));
    expect((await request(port, 'GET', `/api/doc/page?d=${ID_A}&p=1`, { cookie: ada })).status).toBe(404); // the service says there is a file and there is none
  });

  it('has a limit of its own for the page images and the words (the viewer prefetches), counted for each student, that does not touch the meta or the open', async () => {
    const port = await start({ readLimit: { max: 4, windowMs: 60_000 } });
    const ada = await signIn(port, 'ada@example.com');
    const bob = await signIn(port, 'bob@example.com');
    const asks = [`/api/doc/page?d=${ID_A}&p=1`, `/api/doc/words?d=${ID_A}&p=1`, `/api/doc/page?d=${ID_A}&p=2`, `/api/doc/words?d=${ID_A}&p=2`];
    for (const url of asks) expect((await get(port, url, ada)).status, url).toBe(200);
    const over = await get(port, `/api/doc/page?d=${ID_A}&p=3`, ada);
    expect(over.status).toBe(429);
    expect(over.json).toEqual({ error: 'rate-limited' });
    expect((await get(port, `/api/doc/words?d=${ID_A}&p=1`, ada)).status).toBe(429); // pages and words are one count
    expect((await get(port, `/api/doc/meta?d=${ID_A}`, ada)).status).toBe(200); // the meta and the open are not in it
    expect((await post(port, '/api/doc/open', { doc: ID_A }, ada)).status).toBe(200);
    expect((await get(port, `/api/doc/words?d=${ID_B}&p=1`, bob)).status).toBe(200); // another student has their own count
    clock += 60_001; // the window passes
    expect((await get(port, `/api/doc/page?d=${ID_A}&p=1`, ada)).status).toBe(200);
  });

  it('marks the two routes as having their own limit, and only those', () => {
    const routes = docRoutes({ docs: fakeDocs(), history: store, postObject: () => undefined }) as Array<{ path: string; ownLimit?: boolean }>;
    expect(routes.filter((r) => r.ownLimit).map((r) => r.path).sort()).toEqual(['/api/doc/page', '/api/doc/words']);
    expect(DOC_READ_LIMIT).toEqual({ max: 600, windowMs: 60_000 });
  });

  // ---------------------------------------------------------------- open

  it('opens a document that is kept by its id: 200 with the id, the page and the meta', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const r = await post(port, '/api/doc/open', { doc: ID_A }, ada);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, state: 'ready', doc: ID_A, page: 1, meta: meta(ID_A) });
    expect(opened).toEqual([{ folder: folderOf('ada@example.com'), source: { kind: 'existing', id: ID_A } }]);
    expect(cards).toEqual([]); // a document opened at once leaves no card: the student is looking at it
  });

  it('opens the file of a message of the student\'s own, and the name it gives the service is the one stored in their history, never one from the request', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const n = say('ada@example.com', [{ name: 'notes.txt', kind: 'text' }, { name: 'Lecture_3-notes.pdf' }]);
    const r = await post(port, '/api/doc/open', { n, index: 1, name: '../../etc/passwd', path: '/etc/passwd', file: 'x.pdf', title: 'Injected' }, ada);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, state: 'ready', doc: ID_A, page: 1 });
    expect(opened).toEqual([{ folder: folderOf('ada@example.com'), source: { kind: 'upload', name: 'Lecture_3-notes.pdf' } }]);
  });

  it('does not open the file of a message that is not the student\'s own, not one of theirs, or has no such file: "not found"', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const bobLine = say('bob@example.com', [{ name: 'bobs.pdf' }]);
    const adaLine = say('ada@example.com', [{ name: 'mine.pdf' }]);
    const tai = say('ada@example.com', [{ name: 'from-tai.pdf' }], 'assistant');
    for (const body of [{ n: bobLine + 100, index: 0 }, { n: tai, index: 0 }, { n: adaLine, index: 1 }, { n: adaLine, index: 9 }]) {
      const r = await post(port, '/api/doc/open', body, ada);
      expect(r.status, JSON.stringify(body)).toBe(404);
      expect(r.json.error).toBe('not-found');
    }
    // Bob's line number is a line of Bob's history: asked as Ada it is whatever Ada's history has under that number
    const sameNumber = await post(port, '/api/doc/open', { n: bobLine, index: 0 }, ada);
    expect([404, 200]).toContain(sameNumber.status);
    expect(opened.every((o) => o.folder === folderOf('ada@example.com'))).toBe(true);
    expect(opened.some((o) => o.source.kind === 'upload' && o.source.name === 'bobs.pdf')).toBe(false);
  });

  it('answers 400 for a request that does not say which document: neither, both, or numbers that are not numbers', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const n = say('ada@example.com', [{ name: 'a.pdf' }]);
    for (const body of [{}, { doc: ID_A, n, index: 0 }, { doc: ID_A, n }, { doc: 7 }, { doc: 'x' }, { doc: ID_A.toUpperCase() }, { n }, { index: 0 }, { n: '5', index: 0 }, { n, index: '0' }, { n: 1.5, index: 0 }, { n: 0, index: 0 }, { n, index: -1 }, { n, index: 10 }, { n: 1e12, index: 0 }, { n: null, index: null }]) {
      const r = await post(port, '/api/doc/open', body, ada);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe('bad-request');
    }
    expect(opened).toEqual([]);
  });

  it('says what went wrong in the service\'s words, with a status for each kind of failure', async () => {
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    expect(DOC_ERROR_STATUS).toEqual({ off: 503, busy: 503, limit: 429, 'bad-file': 415, 'too-big': 413, failed: 502, 'not-found': 404 });
    for (const [reason, status] of Object.entries(DOC_ERROR_STATUS)) {
      openImpl = async () => ({ ok: false, reason: reason as never, message: `Sentence for ${reason}.` });
      const r = await post(port, '/api/doc/open', { doc: ID_A }, ada);
      expect(r.status, reason).toBe(status);
      expect(r.json).toEqual({ error: reason, message: `Sentence for ${reason}.` });
    }
  });

  // ---------------------------------------------------------------- the background

  it('answers "preparing" with a job when the render takes long, and the job says how it ended; the document goes into the chat as a card when it is ready', async () => {
    let finish!: (r: DocOpenResult) => void;
    openImpl = () => new Promise<DocOpenResult>((resolve) => (finish = resolve));
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const n = say('ada@example.com', [{ name: 'big.pdf' }]);
    const began = Date.now();
    const r = await post(port, '/api/doc/open', { n, index: 0 }, ada);
    expect(Date.now() - began).toBeGreaterThanOrEqual(35); // it waited for the render first
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ ok: true, state: 'preparing' });
    expect(r.json.job).toMatch(/^[0-9a-f]{24}$/);
    const job = r.json.job as string;
    const waiting = await get(port, `/api/doc/job?j=${job}`, ada);
    expect(waiting.status).toBe(200);
    expect(waiting.json).toEqual({ ok: true, state: 'preparing' });
    expect(cards).toEqual([]);
    finish({ ok: true, doc: meta(ID_A, 'big', 40), page: 1 });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    expect(cards[0]).toEqual({ folder: folderOf('ada@example.com'), obj: { t: 'doc', doc: ID_A, title: 'big', pages: 40, page: 1, origin: 'upload' } });
    const done = await get(port, `/api/doc/job?j=${job}`, ada);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ ok: true, state: 'ready', doc: ID_A, page: 1, meta: meta(ID_A, 'big', 40) });
    expect((await get(port, `/api/doc/job?j=${job}`, ada)).json.state).toBe('ready'); // asking again says the same
    expect(cards).toHaveLength(1); // one card, however often it is asked
  });

  it('says in the job what went wrong when the render failed, and leaves no card', async () => {
    openImpl = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { ok: false, reason: 'bad-file', message: 'That file could not be read as a PDF.' };
    };
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const r = await post(port, '/api/doc/open', { doc: ID_A }, ada);
    expect(r.status).toBe(202);
    await vi.waitFor(async () => expect((await get(port, `/api/doc/job?j=${r.json.job}`, ada)).status).toBe(415));
    const failed = await get(port, `/api/doc/job?j=${r.json.job}`, ada);
    expect(failed.json).toEqual({ error: 'bad-file', message: 'That file could not be read as a PDF.' });
    expect(cards).toEqual([]);
  });

  it('survives a service that throws, a card that cannot be left, and a request that gave up waiting', async () => {
    openImpl = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('boom')), 80));
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const r = await post(port, '/api/doc/open', { doc: ID_A }, ada);
    expect(r.status).toBe(202);
    await vi.waitFor(async () => expect((await get(port, `/api/doc/job?j=${r.json.job}`, ada)).status).toBe(502));
    // a card that cannot be left does not make a prepared document unready
    openImpl = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, doc: meta(ID_A), page: 1 }), 80));
    const port2 = await start({ postObject: () => { throw new Error('no chat'); } });
    const ada2 = await signIn(port2, 'ada@example.com');
    const slow = await post(port2, '/api/doc/open', { doc: ID_A }, ada2);
    await vi.waitFor(async () => expect((await get(port2, `/api/doc/job?j=${slow.json.job}`, ada2)).json.state).toBe('ready'));
  });

  it('keeps a job for the student who started it only: another student, an unknown job and a bad job id are "not found" or a bad request', async () => {
    openImpl = () => new Promise(() => undefined);
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const bob = await signIn(port, 'bob@example.com');
    const r = await post(port, '/api/doc/open', { doc: ID_A }, ada);
    expect(r.status).toBe(202);
    const job = r.json.job as string;
    expect((await get(port, `/api/doc/job?j=${job}`, bob)).status).toBe(404);
    expect((await get(port, `/api/doc/job?j=${'f'.repeat(24)}`, ada)).status).toBe(404);
    for (const bad of ['', 'x', job.toUpperCase(), `${job}0`, '../x']) expect((await get(port, `/api/doc/job?j=${bad}`, ada)).status, bad).toBe(400);
    expect((await get(port, '/api/doc/job', ada)).status).toBe(400);
  });

  it('forgets a job after ten minutes', async () => {
    openImpl = () => new Promise<DocOpenResult>((resolve) => setTimeout(() => resolve({ ok: true, doc: meta(ID_A), page: 1 }), 80));
    const port = await start();
    const ada = await signIn(port, 'ada@example.com');
    const r = await post(port, '/api/doc/open', { doc: ID_A }, ada);
    expect((await get(port, `/api/doc/job?j=${r.json.job}`, ada)).status).toBe(200);
    clock += DOC_JOB_TTL_MS + 1;
    expect((await get(port, `/api/doc/job?j=${r.json.job}`, ada)).status).toBe(404);
  });
});
