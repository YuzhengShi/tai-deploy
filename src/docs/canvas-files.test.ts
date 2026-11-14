import { describe, expect, it } from 'vitest';

import { CANVAS_FILE_HOST_SUFFIXES, downloadCanvasFile, hostUnder, hostsOf, kindOfCanvasFile, listCanvasFiles, nextPage, parseBase } from './canvas-files.js';
import type { CanvasFile, CanvasOptions } from './canvas-files.js';

const BASE = 'https://canvas.example.edu/api/v1';
const TOKEN = 'canvas-token-1234567890-SECRET';
const PDF = Buffer.from('%PDF-1.4\nbody\n%%EOF\n');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect?: string;
  method?: string;
}
type Handler = (call: Call) => Response | Promise<Response>;

function fake(handler: Handler): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) }, redirect: init?.redirect, method: init?.method };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const options = (fetchImpl: typeof fetch, over: Partial<CanvasOptions> = {}): CanvasOptions => ({ base: BASE, token: TOKEN, course: '260797', fetchImpl, maxBytes: 20 * 1024 * 1024, wallMs: 5_000, ...over });
const item = (id: number, name: string, size = 1000, extra: Record<string, unknown> = {}) => ({ id, display_name: name, filename: name, 'content-type': 'application/octet-stream', size, url: `https://canvas.example.edu/files/${id}/download?download_frd=1&verifier=KEY${id}`, ...extra });

describe('what a name or a content type says a file is', () => {
  it('is a PDF, PowerPoint, Word or Excel file by the end of its name (any case) or by its content type, and nothing else (not an older .ppt, a picture, a video)', () => {
    for (const [name, kind] of [['a.pdf', 'pdf'], ['Week 5.PPTX', 'pptx'], ['x.docx', 'docx'], ['sheet.XLSX', 'xlsx']] as const) expect(kindOfCanvasFile(name, ''), name).toBe(kind);
    expect(kindOfCanvasFile('download', 'application/pdf')).toBe('pdf');
    expect(kindOfCanvasFile('download', 'application/vnd.openxmlformats-officedocument.presentationml.presentation; charset=binary')).toBe('pptx');
    for (const name of ['old.ppt', 'old.doc', 'pic.png', 'clip.mp4', 'notes.txt', 'pdf', 'a.pdf.zip']) expect(kindOfCanvasFile(name, 'application/octet-stream'), name).toBeNull();
  });

  it('checks the API\'s address: https, a host name (not an address, no user name, no port, no query), and keeps the path', () => {
    expect(parseBase(BASE)).toEqual({ origin: 'https://canvas.example.edu', host: 'canvas.example.edu', path: '/api/v1' });
    expect(parseBase('https://canvas.example.edu/api/v1/')?.path).toBe('/api/v1');
    for (const bad of ['http://canvas.example.edu/api/v1', 'https://canvas.example.edu:8443/api/v1', 'https://user:pw@canvas.example.edu/api/v1', 'https://127.0.0.1/api/v1', 'https://localhost/api/v1', 'https://canvas.example.edu/api/v1?x=1', 'not a url', '', 'ftp://canvas.example.edu']) expect(parseBase(bad), bad).toBeNull();
  });

  it('knows a host under a domain, and not one that only ends in the same letters', () => {
    expect(hostUnder('a.b.instructure.com', 'instructure.com')).toBe(true);
    expect(hostUnder('instructure.com', 'instructure.com')).toBe(true);
    expect(hostUnder('notinstructure.com', 'instructure.com')).toBe(false);
    expect(hostUnder('instructure.com.evil.net', 'instructure.com')).toBe(false);
    expect(CANVAS_FILE_HOST_SUFFIXES).toContain('inscloudgate.net');
  });

  it('takes the next page of a listing from the Link header only when it is on the API\'s own host, https, with no port or user name', () => {
    const link = (url: string) => `<${url}>; rel="next", <https://canvas.example.edu/x>; rel="last"`;
    expect(nextPage(link('https://canvas.example.edu/api/v1/courses/1/files?page=2'), 'canvas.example.edu')).toBe('https://canvas.example.edu/api/v1/courses/1/files?page=2');
    for (const bad of ['https://evil.example.com/steal', 'http://canvas.example.edu/api', 'https://canvas.example.edu:444/api', 'https://u:p@canvas.example.edu/api']) expect(nextPage(link(bad), 'canvas.example.edu'), bad).toBeNull();
    expect(nextPage(null, 'canvas.example.edu')).toBeNull();
    expect(nextPage('<https://canvas.example.edu/x>; rel="last"', 'canvas.example.edu')).toBeNull();
  });
});

describe('the list of a course\'s files', () => {
  it('lists the PDF, PowerPoint, Word and Excel files with their names, sizes, types and weeks, from every page of the listing, and sends the token to the API\'s host only', async () => {
    const f = fake((c) => {
      if (c.url.includes('/modules')) {
        return json([{ name: 'Week 8: Tradeoffs', items: [{ type: 'File', content_id: 4 }, { type: 'Page', content_id: 99 }] }, { name: 'Introduction', items: [{ type: 'File', content_id: 3 }] }]);
      }
      if (c.url.includes('page=2')) return json([item(3, 'Syllabus.pdf', 2_000_000), item(4, 'Consistency models.pptx', 3_000_000), item(5, 'clip.mp4', 9)]);
      return json([item(1, 'Week 5 - Raft.pptx', 5_000_000), item(2, 'W6 Paxos.PDF', 1_500_000), item(6, 'old.ppt', 10)], { link: '<https://canvas.example.edu/api/v1/courses/260797/files?page=2&per_page=100>; rel="next"' });
    });
    const r = await listCanvasFiles(options(f.fetchImpl));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((x) => [x.name, x.size, x.kind, x.week])).toEqual([
      ['Week 5 - Raft.pptx', 5_000_000, 'pptx', 5],
      ['W6 Paxos.PDF', 1_500_000, 'pdf', 6],
      ['Syllabus.pdf', 2_000_000, 'pdf', null],
      ['Consistency models.pptx', 3_000_000, 'pptx', 8], // (its module is "Week 8")
    ]);
    expect(r.modules).toBe(2);
    expect(f.calls.length).toBe(3);
    for (const c of f.calls) {
      expect(new URL(c.url).hostname).toBe('canvas.example.edu');
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.redirect).toBe('manual');
      expect(c.method).toBe('GET');
    }
    expect(f.calls[0].url).toBe('https://canvas.example.edu/api/v1/courses/260797/files?per_page=100&sort=name');
  });

  it('puts a reason on a file Canvas hides from students, one that is too big and one that is empty: it is listed and not taken', async () => {
    const f = fake((c) =>
      c.url.includes('/modules')
        ? json([])
        : json([item(1, 'hidden.pdf', 10, { hidden: true }), item(2, 'locked.pdf', 10, { locked_for_user: true }), item(3, 'big.pdf', 30 * 1024 * 1024), item(4, 'empty.pdf', 0), item(5, 'fine.pdf', 10), item(6, 'unlisted.pdf', 10, { hidden_for_user: true })]),
    );
    const r = await listCanvasFiles(options(f.fetchImpl));
    if (!r.ok) throw new Error(r.message);
    expect(r.files.map((x) => [x.name, x.skip ?? 'taken'])).toEqual([
      ['hidden.pdf', 'hidden or locked for students'],
      ['locked.pdf', 'hidden or locked for students'],
      ['big.pdf', 'over 20 MB'],
      ['empty.pdf', 'empty'],
      ['fine.pdf', 'taken'],
      ['unlisted.pdf', 'hidden or locked for students'],
    ]);
  });

  it('does not follow the next page to another host, and does not follow a redirect of the API at all', async () => {
    const f = fake((c) => (c.url.includes('/modules') ? json([]) : json([item(1, 'a.pdf')], { link: '<https://evil.example.com/steal?x=1>; rel="next"' })));
    const r = await listCanvasFiles(options(f.fetchImpl));
    expect(r.ok && r.files).toHaveLength(1);
    expect(f.calls.every((c) => new URL(c.url).hostname === 'canvas.example.edu')).toBe(true);
    const moved = fake(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }));
    const refused = await listCanvasFiles(options(moved.fetchImpl));
    expect(refused).toMatchObject({ ok: false });
    expect(moved.calls).toHaveLength(1);
  });

  it('says what went wrong in plain words and never prints the token: a refused token, a course that is not there, a service that is down, one that never answers', async () => {
    for (const [status, text] of [[401, 'refused the token'], [403, 'refused the token'], [404, 'is the course id right'], [500, 'HTTP 500']] as const) {
      const r = await listCanvasFiles(options(fake(() => json({ errors: [] }, {}, status)).fetchImpl));
      expect(r).toMatchObject({ ok: false });
      expect(!r.ok && r.message).toContain(text);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    const down = await listCanvasFiles(options((async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch));
    expect(!down.ok && down.message).toContain('could not be reached');
    const slow = await listCanvasFiles(options(((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch, { wallMs: 30 }));
    expect(!slow.ok && slow.message).toContain('did not answer');
    const notAList = await listCanvasFiles(options(fake(() => json({ not: 'a list' })).fetchImpl));
    expect(notAList).toMatchObject({ ok: false });
  });

  it('refuses before any request what cannot work: an address that is not https, a course id that is not a number, no token', async () => {
    const f = fake(() => json([]));
    expect(await listCanvasFiles(options(f.fetchImpl, { base: 'http://canvas.example.edu/api/v1' }))).toMatchObject({ ok: false });
    expect(await listCanvasFiles(options(f.fetchImpl, { course: '12/../x' }))).toMatchObject({ ok: false });
    expect(await listCanvasFiles(options(f.fetchImpl, { token: '' }))).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
  });
});

describe('downloading one file', () => {
  const file = (over: Partial<CanvasFile> = {}): CanvasFile => ({ id: 7, name: 'deck.pptx', size: 1000, kind: 'pptx', week: 5, url: 'https://canvas.example.edu/files/7/download?download_frd=1&verifier=ONETIMEKEY', ...over });

  it('sends the token to the first request only: a download that Canvas moves to its file host is asked for there with no credentials at all', async () => {
    const f = fake((c) => {
      if (c.url.startsWith('https://canvas.example.edu/')) return new Response(null, { status: 302, headers: { location: 'https://inst-fs-pdx-prod.inscloudgate.net/files/abc/download?token=JWT' } });
      return new Response(ZIP, { status: 200, headers: { 'content-length': String(ZIP.length) } });
    });
    const r = await downloadCanvasFile(options(f.fetchImpl), file());
    expect(r).toEqual({ ok: true, bytes: ZIP });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.calls[1].url).toContain('inst-fs-pdx-prod.inscloudgate.net');
    expect(f.calls[1].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(f.calls[1].headers)).not.toContain(TOKEN);
    for (const c of f.calls) expect(c.redirect).toBe('manual');
  });

  it('takes a file Canvas gives directly (no redirect), and a PDF as well as a zip', async () => {
    expect(await downloadCanvasFile(options(fake(() => new Response(PDF, { status: 200 })).fetchImpl), file({ kind: 'pdf', name: 'a.pdf' }))).toEqual({ ok: true, bytes: PDF });
  });

  it('follows a redirect to a host of Canvas\' own, of the listing\'s addresses or one the operator allowed, and to no other: it says which host it would not go to', async () => {
    const to = (location: string) => fake((c) => (c.url.includes('/download') ? new Response(null, { status: 302, headers: { location } }) : new Response(PDF, { status: 200 })));
    for (const allowed of ['https://canvas.example.edu/files/7/other', 'https://x.instructure.com/f', 'https://bucket.inscloudgate.net/f', 'https://cdn.canvas-user-content.com/f']) {
      expect((await downloadCanvasFile(options(to(allowed).fetchImpl), file())).ok, allowed).toBe(true);
    }
    const evil = to('https://evil.example.com/steal?x=1');
    const refused = await downloadCanvasFile(options(evil.fetchImpl), file());
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.message).toContain('evil.example.com');
    expect(!refused.ok && refused.message).toContain('--allow-host evil.example.com');
    expect(evil.calls).toHaveLength(1); // nothing was asked of it
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
    expect(JSON.stringify(refused)).not.toContain('ONETIMEKEY');
    expect((await downloadCanvasFile(options(to('https://evil.example.com/f').fetchImpl, { allowHosts: ['example.com'] }), file())).ok).toBe(true);
    expect((await downloadCanvasFile(options(to('https://files.school.example/f').fetchImpl), file(), new Set(['files.school.example']))).ok).toBe(true);
  });

  it('does not follow a redirect to http, to a port, to an address with a user name, or one that goes on and on', async () => {
    const to = (location: string) => fake((c) => (c.url.startsWith('https://canvas.example.edu/') || c.url.includes('hop') ? new Response(null, { status: 302, headers: { location } }) : new Response(PDF, { status: 200 })));
    for (const bad of ['http://canvas.example.edu/f', 'https://canvas.example.edu:8443/f', 'https://user:pw@canvas.example.edu/f', 'file:///etc/passwd', 'ftp://canvas.example.edu/f']) {
      const f = to(bad);
      expect((await downloadCanvasFile(options(f.fetchImpl), file())).ok, bad).toBe(false);
      expect(f.calls, bad).toHaveLength(1);
    }
    const loop = fake((c) => new Response(null, { status: 302, headers: { location: `https://canvas.example.edu/hop${c.url.length}` } }));
    const r = await downloadCanvasFile(options(loop.fetchImpl), file());
    expect(!r.ok && r.message).toContain('too many times');
    expect(loop.calls.length).toBe(4);
    expect(loop.calls.slice(1).every((c) => c.headers.Authorization === undefined)).toBe(true);
    const bare = fake(() => new Response(null, { status: 302 }));
    expect(await downloadCanvasFile(options(bare.fetchImpl), file())).toMatchObject({ ok: false });
  });

  it('asks for nothing when the file\'s own address is not on the API\'s host, is not https, has a port or a user name, or the file was marked as not taken', async () => {
    const f = fake(() => new Response(PDF));
    for (const url of ['https://evil.example.com/files/7/download', 'http://canvas.example.edu/files/7', 'https://canvas.example.edu:8443/files/7', 'https://u:p@canvas.example.edu/files/7', 'nonsense']) {
      expect((await downloadCanvasFile(options(f.fetchImpl), file({ url }))).ok, url).toBe(false);
    }
    expect(await downloadCanvasFile(options(f.fetchImpl), file({ skip: 'hidden or locked for students' }))).toEqual({ ok: false, message: 'not taken: hidden or locked for students' });
    expect(f.calls).toEqual([]);
  });

  it('takes at most 20 MB, by what Canvas says and by what it sends, and only a PDF or a zip: a login page is not a deck', async () => {
    const big = fake(() => new Response(PDF, { status: 200, headers: { 'content-length': String(30 * 1024 * 1024) } }));
    expect(await downloadCanvasFile(options(big.fetchImpl), file())).toMatchObject({ ok: false, message: 'the file is over 20 MB' });
    const lying = fake(() => new Response(new Uint8Array(2048).fill(0x25), { status: 200 }));
    expect(await downloadCanvasFile(options(lying.fetchImpl, { maxBytes: 1024 }), file())).toMatchObject({ ok: false });
    expect(await downloadCanvasFile(options(fake(() => new Response('<html><body>Log in to Canvas</body></html>')).fetchImpl), file())).toEqual({ ok: false, message: 'what Canvas sent is not a PDF, PowerPoint, Word or Excel file' });
    expect(await downloadCanvasFile(options(fake(() => new Response(new Uint8Array(0))).fetchImpl), file())).toMatchObject({ ok: false });
    for (const [status, text] of [[401, 'refused the token'], [404, 'HTTP 404']] as const) {
      const r = await downloadCanvasFile(options(fake(() => new Response('x', { status })).fetchImpl), file());
      expect(!r.ok && r.message).toContain(text);
    }
  });

  it('gives up on a download that takes too long and one whose connection fails, without a word of the address or the token', async () => {
    const slow = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const r = await downloadCanvasFile(options(slow, { wallMs: 30 }), file());
    expect(!r.ok && r.message).toContain('longer than');
    const down = await downloadCanvasFile(options((async () => Promise.reject(new TypeError('fetch failed: https://canvas.example.edu/files/7?verifier=ONETIMEKEY'))) as unknown as typeof fetch), file());
    expect(!down.ok && down.message).toBe('the download failed (the connection failed)');
    expect(JSON.stringify([r, down])).not.toContain('ONETIMEKEY');
    expect(JSON.stringify([r, down])).not.toContain(TOKEN);
  });

  it('collects the hosts a listing names for its files', () => {
    expect([...hostsOf([file(), file({ url: 'https://files.school.example/x' }), file({ url: 'garbage' })])].sort()).toEqual(['canvas.example.edu', 'files.school.example']);
  });
});

describe('what a token that works but a role that cannot list files, and files that open later, do to the list', () => {
  const NOW = Date.parse('2026-11-07T12:00:00Z');

  it('does not take a file that opens later or has closed, which a teacher\'s or a TA\'s token sees and a student does not: the solutions of an assignment open after its deadline', async () => {
    const f = fake((c) =>
      c.url.includes('/modules')
        ? json([])
        : json([
            item(1, 'solutions-hw5.pdf', 100, { unlock_at: '2026-12-01T08:00:00Z' }),
            item(2, 'old-handout.pdf', 100, { lock_at: '2026-10-01T08:00:00Z' }),
            item(3, 'open-now.pdf', 100, { unlock_at: '2026-10-01T08:00:00Z', lock_at: '2026-12-31T08:00:00Z' }),
            item(4, 'plain.pdf', 100, { unlock_at: null, lock_at: null }),
            item(5, 'odd-dates.pdf', 100, { unlock_at: 'not a date', lock_at: 12345 }),
          ]),
    );
    const r = await listCanvasFiles(options(f.fetchImpl, { now: () => NOW }));
    if (!r.ok) throw new Error(r.message);
    expect(r.files.map((x) => [x.name, x.skip ?? 'taken'])).toEqual([
      ['solutions-hw5.pdf', 'not released to students yet (unlocks 2026-12-01)'],
      ['old-handout.pdf', 'no longer available to students (locked 2026-10-01)'],
      ['open-now.pdf', 'taken'],
      ['plain.pdf', 'taken'],
      ['odd-dates.pdf', 'taken'],
    ]);
    expect(r.via).toBe('files');
  });

  it('asks the account who it is before it blames the token for a refused listing: a token Canvas does not know is the token\'s fault', async () => {
    const f = fake(() => json({ errors: [{ message: 'user authorisation required' }] }, {}, 401));
    const r = await listCanvasFiles(options(f.fetchImpl));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toContain('refused the token');
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/courses/260797/files', '/api/v1/users/self']);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('takes the files from the course\'s modules when the account is known but may not list the course\'s files, each by its id, with the week of its module', async () => {
    const f = fake((c) => {
      const path = new URL(c.url).pathname;
      if (path.endsWith('/files')) return json({ errors: [] }, {}, 403);
      if (path.endsWith('/users/self')) return json({ id: 7, name: 'A TA' });
      if (path.endsWith('/modules')) return json([{ name: 'Week 5', items: [{ type: 'File', content_id: 11 }, { type: 'Page', content_id: 3 }] }, { name: 'Week 6', items: [{ type: 'File', content_id: 12 }, { type: 'File', content_id: 11 }, { type: 'File', content_id: 13 }] }]);
      if (path.endsWith('/files/11')) return json(item(11, 'Raft overview.pptx', 5_000_000));
      if (path.endsWith('/files/12')) return json(item(12, 'Paxos notes.pdf', 2_000_000, { hidden_for_user: true }));
      return json({ errors: [] }, {}, 404); // (file 13 cannot be read by this account)
    });
    const r = await listCanvasFiles(options(f.fetchImpl, { now: () => NOW }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe('modules');
    expect(r.files.map((x) => [x.name, x.kind, x.week, x.skip ?? 'taken'])).toEqual([
      ['Raft overview.pptx', 'pptx', 5, 'taken'],
      ['Paxos notes.pdf', 'pdf', 6, 'hidden or locked for students'],
    ]);
    expect(f.calls.every((c) => c.headers.Authorization === `Bearer ${TOKEN}` && new URL(c.url).hostname === 'canvas.example.edu')).toBe(true);
    expect(f.calls.filter((c) => c.url.includes('/files/')).map((c) => new URL(c.url).pathname)).toEqual(['/api/v1/courses/260797/files/11', '/api/v1/courses/260797/files/12', '/api/v1/courses/260797/files/13']);
  });

  it('says what it knows when neither the files nor the modules give it a file: the token is fine and this role sees none', async () => {
    const f = fake((c) => (new URL(c.url).pathname.endsWith('/files') ? json({}, {}, 403) : new URL(c.url).pathname.endsWith('/users/self') ? json({ id: 7 }) : json([])));
    const r = await listCanvasFiles(options(f.fetchImpl));
    expect(!r.ok && r.message).toMatch(/Canvas knows the token, but this account cannot list the course's files/);
    expect(!r.ok && r.message).toMatch(/Files may be hidden from its role/);
  });

  it('does not ask who the account is for any other failure of the listing (a service that is down, a course that is not there)', async () => {
    for (const status of [404, 500]) {
      const f = fake(() => json({}, {}, status));
      await listCanvasFiles(options(f.fetchImpl));
      expect(f.calls, String(status)).toHaveLength(1);
    }
  });
});
