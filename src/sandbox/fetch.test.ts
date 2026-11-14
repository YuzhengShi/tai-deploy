import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchRepoArchive } from './fetch.js';
import type { FetchOptions } from './fetch.js';

const GZIP = Buffer.concat([Buffer.from([0x1f, 0x8b, 8, 0]), Buffer.alloc(200, 7)]);

type Call = { url: string; init: RequestInit };

/** A fake `fetch`: answers each call from the list in order and remembers what it was asked. */
function fakeFetch(answers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const answer = answers[calls.length - 1];
    if (!answer) throw new TypeError('no more answers');
    return answer(call);
  }) as typeof fetch;
  return { impl, calls };
}

const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
const archive = (body: Buffer | Uint8Array = GZIP, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers });
const headerOf = (call: Call, name: string): string | null => {
  const h = (call.init.headers ?? {}) as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : null;
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-fetch-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const opts = (impl: typeof fetch, over: Partial<FetchOptions> = {}): FetchOptions => ({
  owner: 'alice-dev',
  repo: 'cs6650-hw2',
  token: 'ghp_SECRETTOKEN',
  destFile: path.join(dir, 'source.tgz'),
  fetchImpl: impl,
  maxBytes: 20 * 1024 * 1024,
  wallMs: 5000,
  ...over,
});
const CODELOAD = 'https://codeload.github.com/alice-dev/cs6650-hw2/legacy.tar.gz/refs/heads/main';

describe('fetching a repository archive', () => {
  it('asks api.github.com with the token, follows the redirect itself to codeload with NO credentials, and writes one file', async () => {
    const f = fakeFetch([redirect(CODELOAD), archive()]);
    const r = await fetchRepoArchive(opts(f.impl));
    expect(r).toEqual({ ok: true, bytes: GZIP.length });
    expect(fs.readFileSync(path.join(dir, 'source.tgz')).equals(GZIP)).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].url).toBe('https://api.github.com/repos/alice-dev/cs6650-hw2/tarball');
    expect(headerOf(f.calls[0], 'authorization')).toBe('Bearer ghp_SECRETTOKEN');
    expect(headerOf(f.calls[0], 'accept')).toBe('application/vnd.github+json');
    expect(headerOf(f.calls[0], 'user-agent')).toBeTruthy();
    expect(f.calls[0].init.redirect).toBe('manual');
    expect(f.calls[1].url).toBe(CODELOAD);
    expect(headerOf(f.calls[1], 'authorization')).toBeNull();
    expect(f.calls[1].init.redirect).toBe('error');
  });

  it('never lets the token reach any host but api.github.com, whatever the redirect says', async () => {
    for (const location of ['https://evil.example/x.tgz', 'http://codeload.github.com/x', 'https://codeload.github.com.evil.example/x', 'https://user:pw@codeload.github.com/x', 'https://codeload.github.com:8443/x', 'https://api.github.com/other', 'ftp://codeload.github.com/x', '']) {
      const f = fakeFetch([redirect(location), archive()]);
      const r = await fetchRepoArchive(opts(f.impl));
      expect(r.ok, location).toBe(false);
      expect(f.calls, location).toHaveLength(1); // no second request at all
      expect(fs.existsSync(path.join(dir, 'source.tgz'))).toBe(false);
    }
    // and in the good case the secret is in exactly one request, to exactly one host
    const f = fakeFetch([redirect(CODELOAD), archive()]);
    await fetchRepoArchive(opts(f.impl));
    const carrying = f.calls.filter((c) => JSON.stringify(c.init).includes('ghp_SECRETTOKEN') || c.url.includes('ghp_SECRETTOKEN'));
    expect(carrying.map((c) => new URL(c.url).hostname)).toEqual(['api.github.com']);
  });

  it('sends no Authorization header at all when the host has no token (public repositories only)', async () => {
    const f = fakeFetch([redirect(CODELOAD), archive()]);
    await fetchRepoArchive(opts(f.impl, { token: undefined }));
    expect(headerOf(f.calls[0], 'authorization')).toBeNull();
  });

  it('takes the owner from the host, never from anywhere else: no account, or one that is not a login, is "not linked" and nothing is asked', async () => {
    for (const owner of [undefined, '', 'a/b', '../x', 'alice dev', 'x'.repeat(40), '-alice', 'a?b=c', 'alice@evil.example']) {
      const f = fakeFetch([archive()]);
      const r = await fetchRepoArchive(opts(f.impl, { owner }));
      expect(r.ok, String(owner)).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/not linked/);
      expect(f.calls).toHaveLength(0);
    }
  });

  it('refuses a repository or branch name that is not one before any request', async () => {
    for (const over of [{ repo: 'a/b' }, { repo: '..' }, { repo: '.hidden' }, { ref: '../x' }, { ref: 'a b' }, { ref: '-x' }]) {
      const f = fakeFetch([archive()]);
      expect((await fetchRepoArchive(opts(f.impl, over))).ok, JSON.stringify(over)).toBe(false);
      expect(f.calls).toHaveLength(0);
    }
  });

  it('puts a branch in the path one segment at a time (a branch may hold a slash)', async () => {
    const f = fakeFetch([redirect(CODELOAD), archive()]);
    await fetchRepoArchive(opts(f.impl, { ref: 'feature/part-2' }));
    expect(f.calls[0].url).toBe('https://api.github.com/repos/alice-dev/cs6650-hw2/tarball/feature/part-2');
  });

  it('says what happened in plain words: not found, refused or limited, and a server error', async () => {
    const answer = (status: number) => fakeFetch([() => new Response('x', { status })]);
    const say = async (status: number) => {
      const r = await fetchRepoArchive(opts(answer(status).impl));
      return r.ok ? '' : r.message;
    };
    expect(await say(404)).toMatch(/was not found on github.com.*school's own GitHub/);
    expect(await say(403)).toMatch(/would not give the repository/);
    expect(await say(429)).toMatch(/would not give the repository/);
    expect(await say(500)).toMatch(/answered 500/);
    expect(fs.existsSync(path.join(dir, 'source.tgz'))).toBe(false);
  });

  it('stops reading at the cap, and refuses at once when the answer says it is over', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(pulled === 1 ? GZIP : new Uint8Array(1000).fill(1));
      },
    });
    const f = fakeFetch([() => new Response(body, { status: 200 })]);
    const r = await fetchRepoArchive(opts(f.impl, { maxBytes: 5000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/over \d+ MB/);
    expect(pulled).toBeLessThan(20); // an endless body is not read to its end
    const f2 = fakeFetch([() => new Response(GZIP, { status: 200, headers: { 'content-length': '999999999' } })]);
    expect((await fetchRepoArchive(opts(f2.impl))).ok).toBe(false);
  });

  it('refuses what is not a gzip stream, and an empty answer', async () => {
    expect((await fetchRepoArchive(opts(fakeFetch([() => new Response('<html>nope</html>', { status: 200 })]).impl))).ok).toBe(false);
    expect((await fetchRepoArchive(opts(fakeFetch([() => new Response(null, { status: 200 })]).impl))).ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'source.tgz'))).toBe(false);
  });

  it('gives up at its clock, and says so', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const r = await fetchRepoArchive(opts(hang, { wallMs: 60 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/took longer/);
  });

  it('does not throw when the network does', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const r = await fetchRepoArchive(opts(down));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/could not reach GitHub/);
  });

  it('creates the file exclusively: an existing one is not written through', async () => {
    fs.writeFileSync(path.join(dir, 'source.tgz'), 'mine');
    const f = fakeFetch([redirect(CODELOAD), archive()]);
    expect((await fetchRepoArchive(opts(f.impl))).ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'source.tgz'), 'utf8')).toBe('mine');
  });
});
