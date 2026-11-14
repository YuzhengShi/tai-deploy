/**
 * The document viewer's routes (docs/CHAT_OBJECTS.md section 4, docs/DOCUMENTS.md), added to the page's server as PortalRoutes (src/portal/server.ts does the checks of its own routes before a
 * handler runs: the cookie, a POST that is JSON from the page's origin with its header, the read limit). All are `access: 'student'` and answer for the signed-in student's own documents
 * only: the folder comes from the session, never from the request, and a document of another student is "not found", as if it did not exist.
 *
 *   GET  /api/doc/meta?d=<id>              the DocMeta
 *   GET  /api/doc/page?d=<id>&p=<n>        the page image: its bytes, the type sniffed from them, `private` cache, `default-src 'none'; sandbox`
 *   GET  /api/doc/words?d=<id>&p=<n>       the PageWords of that page
 *   POST /api/doc/open                     { n, index }  the file `index` of the student's OWN message `n` (the stored name is found HERE, in their history: the browser never names a path or a file),
 *                                          or { doc: id } a document that is kept already
 *   GET  /api/doc/job?j=<job>              while a document is being prepared in the background
 *
 * `open` answers 200 `{ ok: true, state: 'ready', doc: <id>, page, meta: <DocMeta> }`, or, when the render takes longer than `waitMs` (about three seconds), 202
 * `{ ok: true, state: 'preparing', job }`: the render goes on in the background, the job (in memory, ten minutes, the student's own) says how it ended, and when a document was prepared
 * that way the host leaves a `doc` card in the student's chat and wakes their page. An error is `{ error: 'off' | 'busy' | 'limit' | 'bad-file' | 'too-big' | 'failed' | 'not-found', message }`
 * (status: off and busy 503, limit 429, bad-file 415, too-big 413, failed 502, not-found 404; a request that does not make sense is 400 `{ error: 'bad-request' }`). `message` is the sentence the
 * service gave for a model, which also reads for a student.
 */
import { randomBytes } from 'node:crypto';

import { readBytesSafe } from '../safe-fs.js';
import { DOC_ID, DOC_LIMITS } from '../docs/types.js';
import type { DocMeta, DocOpenResult, DocSource, DocsApi } from '../docs/types.js';
import type { HistoryStore } from './history.js';
import type { PortalRoute, PortalRouteContext } from './server.js';

export const DOC_JOB_TTL_MS = 10 * 60_000;
/** How long `open` waits for the render before it answers "preparing". */
export const DOC_OPEN_WAIT_MS = 3_000;
const MAX_JOBS = 200;
/**
 * What the viewer's page and words requests may come to for one student: a viewer that prefetches the pages around the one on screen makes four to six requests for each page turn, so these two
 * routes have a limit of their own that is wider than the shared 240 a minute of the server's reads (which also holds the page's poll). The server skips its shared limit for a route that says
 * `ownLimit` (the two-line change in docs/DOCUMENTS.md); until then this one only adds to it.
 */
export const DOC_READ_LIMIT = { max: 600, windowMs: 60_000 } as const;
type DocRoute = PortalRoute & { ownLimit?: boolean };
const JOB_ID = /^[0-9a-f]{24}$/;
/** The most files one message of a student's can have (src/portal/uploads.ts MAX_PENDING). */
const MAX_FILES_PER_MESSAGE = 10;

export const DOC_ERROR_STATUS: Readonly<Record<Extract<DocOpenResult, { ok: false }>['reason'], number>> = {
  off: 503,
  busy: 503,
  limit: 429,
  'bad-file': 415,
  'too-big': 413,
  failed: 502,
  'not-found': 404,
};

export interface DocRoutesDeps {
  docs: DocsApi;
  /** The students' chats: `open` finds the file of a message here. */
  history: HistoryStore;
  /** Leaves a card in a student's chat and wakes their page (src/portal/start.ts: History.appendObject, then the page's wake-up); best effort. */
  postObject: (folder: string, obj: unknown) => void;
  /** Tests: the clock, and how long `open` waits for a render. */
  now?: () => number;
  waitMs?: number;
  /** Tests: the limit of the page and words routes. */
  readLimit?: { max: number; windowMs: number };
}

interface Job {
  folder: string;
  at: number;
  /** undefined while the document is being prepared. */
  result?: DocOpenResult;
}

const badRequest = (ctx: PortalRouteContext, what = 'bad-request'): void => ctx.json(400, { error: what, message: 'That request does not make sense.' });

/** A query parameter that is a document id, or null. */
const docIdOf = (url: URL): string | null => {
  const d = url.searchParams.get('d');
  return d !== null && DOC_ID.test(d) ? d : null;
};
/** A query parameter that is a page number (1 to the most a document has), or null. */
const pageOf = (url: URL): number | null => {
  const p = url.searchParams.get('p');
  if (p === null || !/^\d{1,3}$/.test(p)) return null;
  const n = Number(p);
  return n >= 1 && n <= DOC_LIMITS.pages ? n : null;
};

const notFound = (ctx: PortalRouteContext): void => ctx.json(404, { error: 'not-found' });

function sendOpen(ctx: PortalRouteContext, result: DocOpenResult): void {
  if (result.ok) {
    ctx.json(200, { ok: true, state: 'ready', doc: result.doc.id, page: result.page, meta: result.doc });
  } else {
    ctx.json(DOC_ERROR_STATUS[result.reason] ?? 502, { error: result.reason, message: result.message });
  }
}

export function docRoutes(deps: DocRoutesDeps): PortalRoute[] {
  const now = deps.now ?? Date.now;
  const waitMs = deps.waitMs ?? DOC_OPEN_WAIT_MS;
  const jobs = new Map<string, Job>();
  const readLimit = deps.readLimit ?? DOC_READ_LIMIT;
  const reads = new Map<string, number[]>();
  /** Counts one page or words request of the student; false when they have made too many in the window. */
  const mayRead = (folder: string): boolean => {
    const t = now();
    const recent = (reads.get(folder) ?? []).filter((at) => t - at < readLimit.windowMs);
    if (recent.length >= readLimit.max) {
      reads.set(folder, recent);
      return false;
    }
    recent.push(t);
    reads.set(folder, recent);
    if (reads.size > 500) for (const [key, list] of reads) if (list.every((at) => t - at >= readLimit.windowMs)) reads.delete(key);
    return true;
  };

  const sweep = (): void => {
    const t = now();
    for (const [id, job] of jobs) if (t - job.at > DOC_JOB_TTL_MS) jobs.delete(id);
    // a student who opens many in a row (each is rate limited by the service) cannot grow the table without end
    while (jobs.size > MAX_JOBS) {
      const oldest = jobs.keys().next().value;
      if (oldest === undefined) break;
      jobs.delete(oldest);
    }
  };

  /** What the body of an open request means, or null (and the 400 is sent). The browser says WHICH message and file, never a name. */
  function sourceOf(ctx: PortalRouteContext, body: Record<string, unknown>): DocSource | null {
    const hasDoc = body.doc !== undefined;
    const hasFile = body.n !== undefined || body.index !== undefined;
    if (hasDoc === hasFile) return badRequest(ctx), null;
    const folder = ctx.user.folder;
    if (hasDoc) {
      if (typeof body.doc !== 'string' || !DOC_ID.test(body.doc)) return badRequest(ctx), null;
      return { kind: 'existing', id: body.doc };
    }
    const { n, index } = body;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 2_000_000_000 || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_FILES_PER_MESSAGE) {
      return badRequest(ctx), null;
    }
    // the line is the STUDENT'S OWN (this session's folder) and one of their messages; the name of the file is what the host stored it under
    let entry;
    try {
      entry = deps.history.forFolder(folder).get(n);
    } catch {
      entry = undefined;
    }
    const file = entry && entry.role === 'user' ? entry.files?.[index] : undefined;
    if (!file || typeof file.name !== 'string') return notFound(ctx), null;
    return { kind: 'upload', name: file.name };
  }

  const routes: DocRoute[] = [
    {
      path: '/api/doc/meta',
      method: 'GET',
      access: 'student',
      handler(ctx) {
        const id = docIdOf(ctx.url);
        if (!id) return badRequest(ctx);
        const meta: DocMeta | null = deps.docs.meta(ctx.user.folder, id);
        if (!meta) return notFound(ctx);
        ctx.json(200, meta, { 'cache-control': 'private, no-cache' });
      },
    },
    {
      path: '/api/doc/words',
      method: 'GET',
      access: 'student',
      ownLimit: true,
      handler(ctx) {
        if (!mayRead(ctx.user.folder)) return ctx.json(429, { error: 'rate-limited' });
        const id = docIdOf(ctx.url);
        const page = pageOf(ctx.url);
        if (!id || page === null) return badRequest(ctx);
        const words = deps.docs.words(ctx.user.folder, id, page);
        if (!words) return notFound(ctx);
        // (a page's words never change under its id: the browser may keep them for a while, and only this student's browser)
        ctx.json(200, words, { 'cache-control': 'private, max-age=3600' });
      },
    },
    {
      path: '/api/doc/page',
      method: 'GET',
      access: 'student',
      ownLimit: true,
      handler(ctx) {
        if (!mayRead(ctx.user.folder)) return ctx.json(429, { error: 'rate-limited' });
        const id = docIdOf(ctx.url);
        const page = pageOf(ctx.url);
        if (!id || page === null) return badRequest(ctx);
        const found = deps.docs.pageFile(ctx.user.folder, id, page);
        const bytes = found ? readBytesSafe(found.file, DOC_LIMITS.imageBytes) : null;
        if (!found || !bytes) return notFound(ctx);
        // an image of a PDF: it can run and load nothing even if it were opened on its own (the type is the one sniffed from its bytes; nosniff is the server's)
        ctx.res.writeHead(200, {
          'content-type': found.type,
          'content-length': bytes.length,
          'cache-control': 'private, max-age=3600',
          'content-security-policy': "default-src 'none'; sandbox",
        });
        ctx.res.end(bytes);
      },
    },
    {
      path: '/api/doc/open',
      method: 'POST',
      access: 'student',
      async handler(ctx) {
        const body = await ctx.readJson();
        const source = sourceOf(ctx, body);
        if (!source) return;
        const folder = ctx.user.folder;
        sweep();
        // the service never throws and never takes longer than its own limits: a render that is slow is answered "preparing" and goes on
        const work = deps.docs.open({ folder }, source);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const quick = await Promise.race([
          work,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), waitMs);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
        if (quick) return sendOpen(ctx, quick);

        const jobId = randomBytes(12).toString('hex');
        const job: Job = { folder, at: now() };
        jobs.set(jobId, job);
        void work
          .then((result) => {
            job.result = result;
            if (result.ok) {
              // prepared in the background: the student may have left the viewer, so the document goes into the chat as a card (and the page wakes to show it)
              try {
                deps.postObject(folder, { t: 'doc', doc: result.doc.id, title: result.doc.title, pages: result.doc.pages, page: result.page, origin: result.doc.origin });
              } catch {
                /* the card is a convenience: the job still says it is ready */
              }
            }
          })
          .catch(() => {
            job.result = { ok: false, reason: 'failed', message: 'The document could not be prepared.' };
          });
        ctx.json(202, { ok: true, state: 'preparing', job: jobId });
      },
    },
    {
      path: '/api/doc/job',
      method: 'GET',
      access: 'student',
      handler(ctx) {
        sweep();
        const j = ctx.url.searchParams.get('j');
        if (j === null || !JOB_ID.test(j)) return badRequest(ctx);
        const job = jobs.get(j);
        // a job of another student is not found, as if there were none
        if (!job || job.folder !== ctx.user.folder) return notFound(ctx);
        if (!job.result) return ctx.json(200, { ok: true, state: 'preparing' });
        sendOpen(ctx, job.result);
      },
    },
  ];
  return routes;
}
