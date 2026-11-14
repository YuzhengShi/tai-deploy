/**
 * The course's files on Canvas, for the operator's `course-docs canvas` command (docs/COURSE_DOCS.md): a listing of the PDF, PowerPoint, Word and Excel files of a course (name, size, type, week) and,
 * when the operator says so, their bytes. Read-only: only GET requests are made, with the token of the operator's own Canvas account.
 *
 * The token goes where Canvas' API is and nowhere else (the rule of src/sandbox/fetch.ts, adapted to a file that Canvas keeps somewhere else):
 *   - the API's address must be https; every listing request goes to that host and carries the token. The next page of a listing is followed only when it is on the same host.
 *   - a file's own address (`url` in the listing) must be on the same host as the API. The request for it carries the token and is the ONLY one that does: redirects are never followed by `fetch`
 *     (`manual`), and a place Canvas sends the download to is asked for with no credentials at all. It must be https, on the default port, with no user name in it, and a host that is Canvas' own
 *     (the API's host or a host of the listing's addresses), one of Instructure's file hosts (`CANVAS_FILE_HOST_SUFFIXES`), or one the operator named with `--allow-host`. At most three hops.
 *   - the token is never printed or logged; nothing that carries a file's address (they hold a one-time key) is either: only names, sizes and host names appear in what this returns.
 * A file is taken only when it is at most `maxBytes` (20 MB: what the renderer takes), its first bytes are a PDF or a zip, and Canvas does not say it is hidden or locked for students: a library entry is
 * shown to every student, so what a student could not open in Canvas is not added.
 */
import { kindOfBytes } from './docs.js';
import { weekFrom } from './library-index.js';

export type CanvasFileKind = 'pdf' | 'pptx' | 'docx' | 'xlsx';

export interface CanvasFile {
  id: number;
  name: string;
  size: number;
  kind: CanvasFileKind;
  week: number | null;
  /** Where the file is (an address on Canvas' host: never printed, it holds a one-time key). */
  url: string;
  /** Why the file is not taken (hidden, locked, too big), when it is not. */
  skip?: string;
}

/** Hosts (and the hosts under them) that Instructure keeps the files of a Canvas course on; the operator's `--allow-host` adds more. */
export const CANVAS_FILE_HOST_SUFFIXES: readonly string[] = ['instructure.com', 'inscloudgate.net', 'canvas-user-content.com', 'instructuremedia.com'];
const MAX_PAGES = 10;
const MAX_HOPS = 3;
const USER_AGENT = 'tai-course-docs';
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export interface CanvasOptions {
  /** `https://<host>/api/v1`. */
  base: string;
  token: string;
  course: string;
  fetchImpl: typeof fetch;
  /** Extra hosts (or domains) a download may be sent to. */
  allowHosts?: readonly string[];
  maxBytes: number;
  wallMs: number;
  /** Tests: the clock (ms since the epoch) that the release dates of files are compared with. */
  now?: () => number;
}

/** `via`: where the files were listed from: the course's files, or (when the account may not list them) its modules. */
export type Listing = { ok: true; files: CanvasFile[]; modules: number; via: 'files' | 'modules' } | { ok: false; message: string };
export type Download = { ok: true; bytes: Buffer } | { ok: false; message: string };

const KIND_BY_TYPE: Record<string, CanvasFileKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/** What a file is by its name or its content type, or null (a picture, a video, an older .ppt). */
export function kindOfCanvasFile(name: string, contentType: string): CanvasFileKind | null {
  const byName = /\.(pdf|pptx|docx|xlsx)$/i.exec(name);
  if (byName) return byName[1].toLowerCase() as CanvasFileKind;
  return KIND_BY_TYPE[contentType.toLowerCase().split(';')[0].trim()] ?? null;
}

const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The API's address checked: https, a host name (no address, no user name, no port), and the path it ends with. */
export function parseBase(raw: string): { origin: string; host: string; path: string } | null {
  try {
    const u = new URL(raw);
    // (a host name: not an address, which is no place a school's Canvas is named by)
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !HOST.test(u.hostname) || /^\d+(?:\.\d+){3}$/.test(u.hostname) || u.search || u.hash) return null;
    return { origin: u.origin, host: u.hostname, path: u.pathname.replace(/\/+$/, '') };
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Whether `host` is `allowed` itself or a host under it (`a.b.instructure.com` is under `instructure.com`; `notinstructure.com` is not). */
export const hostUnder = (host: string, allowed: string): boolean => host === allowed || host.endsWith(`.${allowed}`);

/** Reads a response's body as text, at most `max` bytes. */
async function readText(res: Response, max: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The address of the next page of a listing from the Link header, when it is on the API's own host; else null. */
export function nextPage(link: string | null, host: string): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]{1,2000})>\s*;\s*rel="?next"?/i.exec(part);
    if (!m) continue;
    try {
      const u = new URL(m[1]);
      return u.protocol === 'https:' && u.hostname === host && !u.port && !u.username && !u.password ? u.href : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function getJson(o: CanvasOptions, url: string, signal: AbortSignal): Promise<{ status: number; json: unknown; link: string | null }> {
  const res = await o.fetchImpl(url, { method: 'GET', redirect: 'manual', headers: { Authorization: `Bearer ${o.token}`, Accept: 'application/json', 'User-Agent': USER_AGENT }, signal });
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel().catch(() => undefined);
    return { status: res.status, json: null, link: null };
  }
  const text = res.status === 200 ? await readText(res, MAX_JSON_BYTES) : null;
  if (res.status !== 200) void res.body?.cancel().catch(() => undefined);
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, link: res.headers.get('link') };
}

function describeStatus(what: string, status: number): string {
  if (status === 401) return `Canvas refused the token (HTTP 401) when asked for ${what}: tai_credentials.sh canvas stores a new one`;
  if (status === 403) return `Canvas would not give ${what} to this account (HTTP 403)`;
  if (status === 404) return `Canvas has no ${what} (HTTP 404): is the course id right? (tai_live.sh course <id>)`;
  if (status === 0) return `Canvas could not be reached for ${what}`;
  return `Canvas answered HTTP ${status} for ${what}`;
}

/** Why a file is not taken, from what Canvas says of it: hidden or locked for students, not released yet, no longer available, too big, empty; null when it is. */
function whySkipped(item: Record<string, unknown>, size: number, maxBytes: number, now: number): string | null {
  if (item.hidden === true || item.hidden_for_user === true || item.locked === true || item.locked_for_user === true) return 'hidden or locked for students';
  // a teacher's or a TA's token sees files that students do not yet: a file that opens later (the solutions of an assignment, after its deadline) is not one a student may have now
  const unlock = typeof item.unlock_at === 'string' ? Date.parse(item.unlock_at) : NaN;
  if (Number.isFinite(unlock) && unlock > now) return `not released to students yet (unlocks ${new Date(unlock).toISOString().slice(0, 10)})`;
  const lock = typeof item.lock_at === 'string' ? Date.parse(item.lock_at) : NaN;
  if (Number.isFinite(lock) && lock <= now) return `no longer available to students (locked ${new Date(lock).toISOString().slice(0, 10)})`;
  if (size > maxBytes) return `over ${Math.round(maxBytes / (1024 * 1024))} MB`;
  if (size === 0) return 'empty';
  return null;
}

/** A file of Canvas' listing (or of `GET /files/<id>`) as a CanvasFile, or null when it is not a PDF, PowerPoint, Word or Excel file or has no address. */
function fileOf(item: unknown, maxBytes: number, now: number): CanvasFile | null {
  if (!isRecord(item) || typeof item.id !== 'number' || !Number.isSafeInteger(item.id)) return null;
  const name = typeof item.display_name === 'string' ? item.display_name : typeof item.filename === 'string' ? item.filename : '';
  const kind = kindOfCanvasFile(name, typeof item['content-type'] === 'string' ? item['content-type'] : '');
  if (!kind || name.length === 0 || typeof item.url !== 'string') return null;
  const size = typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0 ? item.size : 0;
  const skip = whySkipped(item, size, maxBytes, now);
  return { id: item.id, name: name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, 200), size, kind, week: weekFrom(name), url: item.url, ...(skip ? { skip } : {}) };
}

/**
 * The course's files that are PDF, PowerPoint, Word or Excel files, by name, with their sizes and the week their name or their module says. Files Canvas marks hidden or locked, files that are not
 * released yet or not available any more, and files over `maxBytes`, are in the list with a reason in `skip`. When Canvas does not let the account list the course's files (401 or 403: the Files tab may
 * be hidden for that role, and the token can be fine), the account is asked who it is first, and if it is known the files are taken from the course's modules (each `File` item, fetched by its id).
 * Never throws.
 */
export async function listCanvasFiles(o: CanvasOptions): Promise<Listing> {
  const base = parseBase(o.base);
  if (!base) return { ok: false, message: 'the Canvas address is not an https address with a host name: tai_credentials.sh canvas stores it' };
  if (!/^\d{1,12}$/.test(o.course)) return { ok: false, message: 'the course id is a number' };
  if (!o.token || o.token.length < 10) return { ok: false, message: 'there is no Canvas token on this host: tai_credentials.sh canvas stores one' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, o.wallMs));
  const now = (o.now ?? Date.now)();
  try {
    const root = `${base.origin}${base.path}/courses/${o.course}`;
    const files: CanvasFile[] = [];
    let via: 'files' | 'modules' = 'files';
    let url: string | null = `${root}/files?per_page=100&sort=name`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const r = await getJson(o, url, controller.signal);
      if (page === 0 && (r.status === 401 || r.status === 403)) {
        // the listing is refused: is it the token, or what this account may see of the course?
        const me = await getJson(o, `${base.origin}${base.path}/users/self`, controller.signal);
        if (me.status !== 200) return { ok: false, message: describeStatus("the course's files", 401) };
        via = 'modules';
        break;
      }
      if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, message: describeStatus("the course's files", r.status) };
      for (const item of r.json) {
        const f = fileOf(item, o.maxBytes, now);
        if (f) files.push(f);
      }
      url = nextPage(r.link, base.host);
    }
    // the modules: the weeks of the files in them (a module is named "Week 5"), and, when the course's files cannot be listed, the files themselves. Best effort for the weeks.
    let modules = 0;
    const weekOf = new Map<number, number>();
    const inModules: number[] = [];
    try {
      const m = await getJson(o, `${root}/modules?include[]=items&per_page=100`, controller.signal);
      if (m.status === 200 && Array.isArray(m.json)) {
        for (const mod of m.json) {
          if (!isRecord(mod) || typeof mod.name !== 'string' || !Array.isArray(mod.items)) continue;
          modules++;
          const week = weekFrom(mod.name);
          for (const item of mod.items) {
            if (!isRecord(item) || item.type !== 'File' || typeof item.content_id !== 'number') continue;
            if (week !== null && !weekOf.has(item.content_id)) weekOf.set(item.content_id, week);
            if (!inModules.includes(item.content_id) && inModules.length < 100) inModules.push(item.content_id);
          }
        }
      }
    } catch {
      /* the weeks come from the names then */
    }
    if (via === 'modules') {
      for (const id of inModules) {
        const one = await getJson(o, `${root}/files/${id}`, controller.signal);
        const f = one.status === 200 ? fileOf(one.json, o.maxBytes, now) : null;
        if (f) files.push(f);
      }
      if (files.length === 0) {
        return { ok: false, message: `Canvas knows the token, but this account cannot list the course's files (HTTP 403: the course's Files may be hidden from its role), and no module of the course holds a PDF, PowerPoint, Word or Excel file that this account can read` };
      }
    }
    for (const f of files) if (f.week === null) f.week = weekOf.get(f.id) ?? null;
    return { ok: true, files, modules, via };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, message: `Canvas did not answer within ${Math.round(o.wallMs / 1000)} seconds` };
    return { ok: false, message: describeStatus("the course's files", 0) + ((err as Error).name === 'TypeError' ? ' (the connection failed)' : '') };
  } finally {
    clearTimeout(timer);
  }
}

/** The hosts a download may be sent to: Canvas' own (the API's and those of the listing's addresses), Instructure's file hosts and the operator's. */
function allowedHost(host: string, base: string, listed: ReadonlySet<string>, extra: readonly string[]): boolean {
  return host === base || listed.has(host) || CANVAS_FILE_HOST_SUFFIXES.some((s) => hostUnder(host, s)) || extra.some((s) => hostUnder(host, s));
}

/** The hosts of the addresses a listing holds (Canvas' naming of where its files are). */
export const hostsOf = (files: readonly CanvasFile[]): Set<string> => {
  const out = new Set<string>();
  for (const f of files) {
    try {
      out.add(new URL(f.url).hostname);
    } catch {
      /* not an address */
    }
  }
  return out;
};

/** One file's bytes. Never throws; what it says of a failure holds no address and no token. */
export async function downloadCanvasFile(o: CanvasOptions, file: CanvasFile, listedHosts: ReadonlySet<string> = new Set()): Promise<Download> {
  const base = parseBase(o.base);
  if (!base) return { ok: false, message: 'the Canvas address is not an https address with a host name' };
  if (file.skip) return { ok: false, message: `not taken: ${file.skip}` };
  const extra = (o.allowHosts ?? []).map((h) => h.toLowerCase());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, o.wallMs));
  try {
    let first: URL;
    try {
      first = new URL(file.url);
    } catch {
      return { ok: false, message: 'Canvas gave no usable address for the file' };
    }
    // the request that carries the token: the API's own host, https, no user name, no port
    if (first.protocol !== 'https:' || first.hostname !== base.host || first.port !== '' || first.username !== '' || first.password !== '') {
      return { ok: false, message: 'Canvas named a download address that is not on its own host, so it was not fetched' };
    }
    let current = first.href;
    let carry = true;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const headers: Record<string, string> = { Accept: 'application/pdf, application/octet-stream, */*', 'User-Agent': USER_AGENT };
      if (carry) headers.Authorization = `Bearer ${o.token}`;
      res = await o.fetchImpl(current, { method: 'GET', redirect: 'manual', headers, signal: controller.signal });
      if (!(res.status >= 300 && res.status < 400)) break;
      const location = res.headers.get('location');
      void res.body?.cancel().catch(() => undefined);
      let next: URL | null = null;
      try {
        next = location ? new URL(location, current) : null;
      } catch {
        next = null;
      }
      if (!next || next.protocol !== 'https:' || next.port !== '' || next.username !== '' || next.password !== '') return { ok: false, message: 'Canvas sent the download somewhere that is not an https address on the default port, so it was not fetched' };
      if (!allowedHost(next.hostname, base.host, listedHosts, extra)) return { ok: false, message: `Canvas sent the download to ${next.hostname}, which is not one of its own file hosts: it was not fetched (--allow-host ${next.hostname} says it may be)` };
      current = next.href;
      carry = false;
      res = null;
    }
    if (!res) return { ok: false, message: 'Canvas sent the download on too many times, so it was not fetched' };
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, message: describeStatus('that file', res.status) };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      void res.body?.cancel().catch(() => undefined);
      return { ok: false, message: `the file is over ${Math.round(o.maxBytes / (1024 * 1024))} MB` };
    }
    if (!res.body) return { ok: false, message: 'Canvas sent no file' };
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > o.maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, message: `the file is over ${Math.round(o.maxBytes / (1024 * 1024))} MB` };
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length === 0) return { ok: false, message: 'Canvas sent an empty file' };
    if (kindOfBytes(bytes) === 'other') return { ok: false, message: 'what Canvas sent is not a PDF, PowerPoint, Word or Excel file' };
    return { ok: true, bytes };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, message: `the download took longer than ${Math.round(o.wallMs / 1000)} seconds` };
    return { ok: false, message: `the download failed${(err as Error).name === 'TypeError' ? ' (the connection failed)' : ''}` };
  } finally {
    clearTimeout(timer);
  }
}
