/**
 * The teaching-team view on the page's server: who may call it (the owner and nobody else), what the two calls answer, `features.team`, and
 * that the page that draws it (team.html) is served under the content policy like the first page is. Model: src/portal/routes.test.ts.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { AuthError, NonceStore, SessionCodec, UserDirectory, studentFolder } from './auth.js';
import type { PortalUser } from './auth.js';
import { HistoryStore } from './history.js';
import { Portal, loadStaticFiles } from './server.js';
import type { OutboundEntry, PortalCore, PortalOptions, StaticFile } from './server.js';
import { teamModule, teamRoutes } from './team-routes.js';
import { TeamView } from './team.js';
import { writeTeamFixture } from './testing/team-fixture.js';
import type { TeamFixture } from './testing/team-fixture.js';

const ORIGIN = 'https://tai.example';
const NOW = Date.parse('2026-11-04T20:00:00Z');
const TEMPLATE = fs.readFileSync(path.resolve(process.cwd(), 'groups', 'global', 'COMPETENCY_TEMPLATE.md'), 'utf-8');
const folderOf = (key: string): string => studentFolder(`${key}@example.com`);

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
  text: string;
  json: any;
}

describe('the teaching-team view on the page\'s server', () => {
  const dirs: string[] = [];
  const portals: Portal[] = [];
  let fixture: TeamFixture;
  let usersFile: string;

  const tmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-team-routes-'));
    dirs.push(dir);
    return dir;
  };

  beforeEach(() => {
    const dir = tmp();
    fixture = writeTeamFixture(path.join(dir, 'class'), { now: NOW, template: TEMPLATE, folderOf });
    usersFile = path.join(dir, 'users.json');
    fs.writeFileSync(
      usersFile,
      JSON.stringify({
        users: [
          { email: 'ada@example.com', name: 'Ada Lovelace', canvasUserId: '1001', role: 'owner' },
          { email: 'bob@example.com', name: 'Bob Barker', canvasUserId: '1002' },
        ],
      }),
    );
  });

  afterEach(async () => {
    for (const portal of portals.splice(0)) await portal.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(extra: Partial<PortalOptions> = {}): Promise<number> {
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
      history: new HistoryStore(path.join(tmp(), 'history')),
      staticFiles: { '/index.html': { body: Buffer.from('<!doctype html><title>TAi</title>'), type: 'text/html; charset=utf-8' } },
      basePath: '/tai',
      origin: ORIGIN,
      trustProxy: true,
      log: { info: () => undefined, warn: () => undefined },
      ...extra,
    });
    await portal.listen({ host: '127.0.0.1', port: 0 });
    portals.push(portal);
    return portal.address()!.port;
  }

  function request(port: number, method: string, url: string, options: { cookie?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(options.headers || {}) };
      if (options.cookie) headers.cookie = options.cookie;
      if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body));
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
      if (options.body !== undefined) req.write(options.body);
      req.end();
    });
  }

  const pageHeaders = { 'content-type': 'application/json', 'x-tai': '1', origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

  async function signIn(port: number, email: string): Promise<string> {
    const { json } = await request(port, 'GET', '/auth/nonce');
    const reply = await request(port, 'POST', '/auth/google', { headers: pageHeaders, body: JSON.stringify({ credential: `good:${email}`, nonce: json.nonce }) });
    expect(reply.status).toBe(200);
    return String(reply.headers['set-cookie']).split(';')[0];
  }

  const viewOf = (): TeamView => new TeamView(fixture.deps);

  it('answers 401 to someone who is signed out and 403 to a student, on both calls, and runs nothing for either', async () => {
    let asked = 0;
    const counting = viewOf();
    const spy = vi.spyOn(counting, 'overview').mockImplementation(async () => {
      asked++;
      return {} as never;
    });
    const spyStudent = vi.spyOn(counting, 'student').mockImplementation(async () => {
      asked++;
      return null;
    });
    const port = await start({ routes: teamRoutes(counting) });
    for (const url of ['/api/team/overview', `/api/team/student?folder=${folderOf('bob')}`]) {
      const out = await request(port, 'GET', url);
      expect(out.status, url).toBe(401);
      expect(out.json).toEqual({ error: 'signed-out' });
      const refused = await request(port, 'GET', url, { cookie: await signIn(port, 'bob@example.com') });
      expect(refused.status, url).toBe(403);
      expect(refused.json).toEqual({ error: 'not-owner' });
    }
    expect(asked).toBe(0);
    spy.mockRestore();
    spyStudent.mockRestore();
  });

  it('answers the owner the class, never cached, and with the teaching-team accounts only when asked', async () => {
    const port = await start({ routes: teamRoutes(viewOf()) });
    const cookie = await signIn(port, 'ada@example.com');
    const reply = await request(port, 'GET', '/api/team/overview', { cookie });
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.json.students).toHaveLength(12);
    expect(reply.json.class).toMatchObject({ students: 12, staffHidden: 1, includeStaff: false });
    expect(Object.keys(reply.json).sort()).toEqual(['attention', 'bands', 'cacheSeconds', 'class', 'concepts', 'generatedAt', 'misconceptions', 'patrol', 'quickChecks', 'students', 'voice']);
    const withStaff = await request(port, 'GET', '/api/team/overview?staff=1', { cookie });
    expect(withStaff.json.students).toHaveLength(13);
    expect(withStaff.json.class.includeStaff).toBe(true);
    // the whole answer is one JSON document that holds none of what the files hold that is not the view's to tell
    for (const canary of fixture.canaries) expect(reply.text.includes(canary), canary).toBe(false);
  });

  it('answers one student\'s detail: 400 for a folder that is not one, 404 for one that is not on the list, 200 for one that is', async () => {
    const port = await start({ routes: teamRoutes(viewOf()) });
    const cookie = await signIn(port, 'ada@example.com');
    for (const url of ['/api/team/student', '/api/team/student?folder=', '/api/team/student?folder=main', '/api/team/student?folder=../../etc/passwd', `/api/team/student?folder=${folderOf('bob')}x`]) {
      expect((await request(port, 'GET', url, { cookie })).status, url).toBe(400);
    }
    const unknown = await request(port, 'GET', `/api/team/student?folder=${folderOf('nobody')}`, { cookie });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: 'not-found' });
    const known = await request(port, 'GET', `/api/team/student?folder=${folderOf('carol')}`, { cookie });
    expect(known.status).toBe(200);
    expect(known.json).toMatchObject({ name: 'Carol Shaw', record: 'ok' });
    expect(known.json.concepts.some((c: { verbalGap: boolean }) => c.verbalGap)).toBe(true);
    expect(known.headers['cache-control']).toBe('no-store');
  });

  it('takes no write: the wrong method on either path is a 405, and nothing else is under api/team', async () => {
    const port = await start({ routes: teamRoutes(viewOf()) });
    const cookie = await signIn(port, 'ada@example.com');
    expect((await request(port, 'POST', '/api/team/overview', { cookie, headers: pageHeaders, body: '{}' })).status).toBe(405);
    expect((await request(port, 'POST', '/api/team/student', { cookie, headers: pageHeaders, body: '{}' })).status).toBe(405);
    expect((await request(port, 'GET', '/api/team/anything', { cookie })).status).toBe(404);
    expect((await request(port, 'GET', '/api/admin/team/overview', { cookie })).status).toBe(404);
  });

  it('says `features.team` for the owner and not for a student', async () => {
    const team = teamModule({ env: {}, groupsDir: fixture.deps.groupsDir, users: new UserDirectory(usersFile) });
    const port = await start({ routes: team.routes, features: team.features });
    const ada = await request(port, 'GET', '/api/me', { cookie: await signIn(port, 'ada@example.com') });
    const bob = await request(port, 'GET', '/api/me', { cookie: await signIn(port, 'bob@example.com') });
    expect(ada.json.features.team).toBe(true);
    expect(bob.json.features.team).toBe(false);
  });

  it('makes its roster from the allowlist: the name, the folder, the owner as teaching team, and when each chat was registered', async () => {
    const users = new UserDirectory(usersFile);
    const registered = { [users.find('bob@example.com')!.jid]: { added_at: new Date(Date.now() - 2 * 86_400_000).toISOString() } };
    const team = teamModule({ env: { TAI_PORTAL_HISTORY_DIR: fixture.deps.historyDir }, groupsDir: fixture.deps.groupsDir, users, registeredGroups: () => registered });
    const o = await team.view.overview();
    expect(o.students.map((s) => [s.name, s.id, s.record])).toEqual([['Bob Barker', folderOf('bob'), 'ok']]);
    expect(o.class.staffHidden).toBe(1);
    expect((await team.view.overview(true)).students.map((s) => [s.name, s.staff])).toEqual([['Ada Lovelace', true], ['Bob Barker', false]]);
    // the quick checks of that student's history, read from the directory the page keeps it in
    expect(o.quickChecks.asked).toBe(0);                                      // bob has no quick check in the fixture
    const kai = teamModule({ env: { TAI_PORTAL_HISTORY_DIR: fixture.deps.historyDir }, groupsDir: fixture.deps.groupsDir, users: { list: () => [{ email: 'kai@example.com', name: 'Kai', role: 'student', folder: folderOf('kai'), jid: `web:${folderOf('kai')}` }] } });
    expect((await kai.view.overview()).quickChecks.answered).toBe(8 - 2);       // kai's six answers: not frank's, not june's
    expect(team.features({ role: 'owner' } as PortalUser)).toEqual({ team: true });
    expect(team.features({ role: 'student' } as PortalUser)).toEqual({ team: false });
  });

  // ------------------------------------------------------------ the content policy of the page that draws it

  it('serves the real page files of the teaching view under the base path: team.html as it is, the script, the module and the style by their types', async () => {
    const dir = path.resolve(process.cwd(), 'portal', 'web');
    const port = await start({ staticFiles: loadStaticFiles(dir, ['index.html', 'team.html', 'team.js', 'team-data.js', 'team.css', 'style.css', 'mark.svg'], '/tai') });
    const page = await request(port, 'GET', '/team.html');
    expect(page.status).toBe(200);
    expect(page.text).toBe(fs.readFileSync(path.join(dir, 'team.html'), 'utf-8'));              // nothing to rewrite: its addresses are relative to where it is served
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.text).not.toContain('__BASE__');
    expect((await request(port, 'GET', '/')).text).toContain('<base href="/tai/">');             // index.html is the one that carries the base
    const types: Record<string, string> = { '/team.js': 'text/javascript; charset=utf-8', '/team-data.js': 'text/javascript; charset=utf-8', '/team.css': 'text/css; charset=utf-8' };
    for (const [url, type] of Object.entries(types)) {
      const reply = await request(port, 'GET', url);
      expect(reply.status, url).toBe(200);
      expect(reply.headers['content-type'], url).toBe(type);
    }
  });

  const html = (title: string): StaticFile => ({ body: Buffer.from(`<!doctype html><title>${title}</title>`), type: 'text/html; charset=utf-8' });

  it('serves team.html under the content policy that index.html has, on the first answer and on a 304, and puts none on a script', async () => {
    const port = await start({
      staticFiles: { '/index.html': html('TAi'), '/team.html': html('Teaching view'), '/team.js': { body: Buffer.from('export {}'), type: 'text/javascript; charset=utf-8' } },
    });
    const first = await request(port, 'GET', '/index.html');
    const policy = String(first.headers['content-security-policy']);
    expect(policy).toContain("default-src 'none'");
    for (const url of ['/team.html', '/']) {
      const reply = await request(port, 'GET', url);
      expect(reply.status, url).toBe(200);
      expect(reply.headers['content-security-policy'], url).toBe(policy);
    }
    const team = await request(port, 'GET', '/team.html');
    expect(team.headers['content-type']).toBe('text/html; charset=utf-8');
    const again = await request(port, 'GET', '/team.html', { headers: { 'if-none-match': String(team.headers.etag) } });
    expect(again.status).toBe(304);
    expect(again.headers['content-security-policy']).toBe(policy);
    expect((await request(port, 'HEAD', '/team.html')).headers['content-security-policy']).toBe(policy);
    expect(policy).toMatch(/script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client(;|$)/);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("connect-src 'self'");                          // the page's own calls (fetch) and nothing else
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'none'");
    expect((await request(port, 'GET', '/team.js')).headers['content-security-policy']).toBeUndefined();
    expect((await request(port, 'GET', '/team.html', { headers: { 'x-forwarded-for': '1.2.3.4' } })).headers['x-frame-options']).toBe('DENY');
  });
});
