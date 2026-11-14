/**
 * The HOST fetches a student's repository for the sandbox (docs/GO_SANDBOX.md): the archive's bytes, from GitHub, and nothing else. It never unpacks them (the run container
 * does, inside its own size-limited memory); it writes one file.
 *
 *   - The owner is the account the host bound to the student; the model only ever names the repository. An account that is not a GitHub login is "not linked".
 *   - `GET https://api.github.com/repos/<owner>/<repo>/tarball[/<ref>]` carries the host's token, and ONLY that request does: redirects are never followed by `fetch` (`manual`),
 *     the one place the API may send us is `https://codeload.github.com/...`, and that second request carries no credentials at all (and may not redirect again).
 *   - The body is read as a stream with a cap (20 MB) and a clock; a body that is not a gzip stream is refused.
 *   - GitHub only: the school's own GitHub server is not reachable from here, and a repository there is "not found" in the plain words the model is told.
 */
import fs from 'node:fs';

import { REPO_NAME } from '../work-facts.js';

export type FetchOutcome = { ok: true; bytes: number } | { ok: false; message: string };

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const USER_AGENT = 'tai-sandbox';
const CODELOAD = 'codeload.github.com';

const NOT_LINKED = "Not run: their GitHub account is not linked to this chat, so there is no repository of theirs to fetch. Say so, and ask them to attach the file or paste the code instead.";

export interface FetchOptions {
  /** The account the host bound to the student (not the model's word). */
  owner: string | undefined;
  repo: string;
  ref?: string;
  /** The host's token for github.com; none: only public repositories can be fetched. */
  token: string | undefined;
  /** Where to write the archive: a new file (created exclusively). */
  destFile: string;
  fetchImpl: typeof fetch;
  maxBytes: number;
  wallMs: number;
}

const encodePath = (ref: string): string => ref.split('/').map(encodeURIComponent).join('/');

/** What a model is told when GitHub did not give the archive, by what GitHub answered. */
function describeStatus(status: number, repo: string): string {
  if (status === 404) {
    return `Not run: the repository ${repo} was not found on github.com under their account (it may be private, named differently, or on the school's own GitHub server, which the sandbox cannot reach). Say so, and ask them to attach the file or paste the code.`;
  }
  if (status === 401 || status === 403 || status === 429) {
    return 'Not run: GitHub would not give the repository (it may be private, or GitHub is limiting requests for a while). Say so, and ask them to attach the file or paste the code, or to try again later.';
  }
  return `Not run: GitHub did not give the repository (it answered ${status}). Say so, and try again in a minute, or ask them to attach the file instead.`;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function fetchRepoArchive(o: FetchOptions): Promise<FetchOutcome> {
  if (typeof o.owner !== 'string' || !LOGIN.test(o.owner)) return { ok: false, message: NOT_LINKED };
  if (!REPO_NAME.test(o.repo) || o.repo.startsWith('.')) return { ok: false, message: 'Not run: that is not a repository name.' };
  if (o.ref !== undefined && (o.ref.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(o.ref))) return { ok: false, message: 'Not run: that is not a branch or tag name.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, o.wallMs));
  let fd: number | undefined;
  try {
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}/tarball${o.ref ? `/${encodePath(o.ref)}` : ''}`;
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    let res = await o.fetchImpl(apiUrl, { method: 'GET', redirect: 'manual', headers, signal: controller.signal });

    if (REDIRECTS.has(res.status)) {
      const location = res.headers.get('location');
      void res.body?.cancel().catch(() => undefined);
      let next: URL | null = null;
      try {
        next = location ? new URL(location, apiUrl) : null;
      } catch {
        next = null;
      }
      if (!next || next.protocol !== 'https:' || next.hostname !== CODELOAD || next.port !== '' || next.username !== '' || next.password !== '') {
        return { ok: false, message: 'Not run: GitHub sent the download somewhere the sandbox does not use, so it was not fetched. Say so and try again in a minute.' };
      }
      // the second request: no credentials of any kind, and it may not be sent on to a third place
      res = await o.fetchImpl(next.href, { method: 'GET', redirect: 'error', headers: { Accept: 'application/x-gzip, application/octet-stream', 'User-Agent': USER_AGENT }, signal: controller.signal });
    }

    if (res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, message: describeStatus(res.status, o.repo) };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, message: `Not run: the repository's archive is over ${Math.round(o.maxBytes / (1024 * 1024))} MB, which is more than the sandbox takes. Say so, and ask them to attach just the part to run.` };
    }
    if (!res.body) return { ok: false, message: describeStatus(502, o.repo) };

    const reader = res.body.getReader();
    let total = 0;
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (first) {
        first = false;
        if (value.length < 2 || value[0] !== 0x1f || value[1] !== 0x8b) {
          void reader.cancel().catch(() => undefined);
          return { ok: false, message: 'Not run: what GitHub sent is not an archive. Say so and try again in a minute.' };
        }
        fd = fs.openSync(o.destFile, 'wx', 0o644);
      }
      total += value.length;
      if (total > o.maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, message: `Not run: the repository's archive is over ${Math.round(o.maxBytes / (1024 * 1024))} MB, which is more than the sandbox takes. Say so, and ask them to attach just the part to run.` };
      }
      let written = 0;
      while (written < value.length) written += fs.writeSync(fd as number, value, written, value.length - written);
    }
    if (total === 0) return { ok: false, message: 'Not run: GitHub sent an empty archive. Say so and try again in a minute.' };
    return { ok: true, bytes: total };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, message: `Not run: fetching the repository took longer than ${Math.round(o.wallMs / 1000)} seconds. Say so and try again in a minute.` };
    return { ok: false, message: `Not run: the sandbox could not reach GitHub (${(err as Error).name === 'TypeError' ? 'the connection failed' : 'an error'}). Say so and try again in a minute.` };
  } finally {
    clearTimeout(timer);
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}
