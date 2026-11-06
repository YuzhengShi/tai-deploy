/**
 * The student page: static files, "Sign in with Google", and a small JSON API for one signed-in student's chat.
 *
 * It is a separate listener from the web channel's own HTTP API (src/channels/web.ts), which has no authentication, stays on
 * loopback and is for tests. Everything here that touches a chat first works out WHICH chat the session owns, from the signed-in
 * e-mail and the allowlist: the chat, the Canvas user and the GitHub account are never read from a request.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { Duplex } from 'stream';

import type { Choice } from '../choices.js';
import { neutralHostLines } from '../reply-shape.js';
import { clipSources, type SourceChip } from '../sources.js';
import { logger } from '../logger.js';
import { AuthError, GoogleIdentity, NonceStore, PortalUser, RateLimiter, SessionCodec } from './auth.js';
import { tapOn } from './choose.js';
import { feedbackLines, feedbackRequest } from './feedback.js';
import { ActivityInput, ADMIN_FOLDER, clipActivity, History, HistoryEntry, HistoryStore, isCallType, isChatFolder, isStudentMessage, STUDENT_FOLDER } from './history.js';
import { suggestReaction } from './autoreact.js';
import { AUDIO_TYPES, MediaStore, MEDIA_ID, MAX_IMAGE_BYTES } from './media.js';
import { MEMORY_ID, PortalMemory } from './memory-view.js';
import { Transcriber } from './transcribe.js';
import { ACCEPTED_EXTENSIONS, UPLOAD_MAX_BYTES, UploadStore, classifyUpload, entryFile } from './uploads.js';

/** One thing TAi sent out through the web channel. */
export interface OutboundEntry {
  kind: string;
  jid: string;
  text?: string;
  typing?: boolean;
  /** image: the id of the stored picture (absent when what was sent is not a picture) and its caption */
  media?: string;
  caption?: string;
  /** reaction: the message it names and the emoji */
  messageId?: string;
  emoji?: string;
  /** text: options the student may tap (src/choices.ts), whether it is a quick check, and what TAi marked as the answer (the host's alone) */
  choices?: Choice[];
  quiz?: boolean;
  secret?: { key?: number; why?: string; doubt?: boolean };
  /** text: what TAi opened to write it (src/sources.ts), as the container said; clipped again here before it is kept (clipSources). */
  sources?: SourceChip[];
}

/**
 * What the page may say TAi is doing for a chat right now (src/turn-status.ts): present only while it works or waits. `label` is one of a fixed
 * set of words, never text from a model, a tool or a student; `ahead` is the number of other students' messages the queue has in line before this one.
 */
export interface PortalStatus {
  state: 'working' | 'queued';
  label?: string;
  ahead?: number;
  /** Streaming only (TAI_PORTAL_STREAM, docs/STREAMING.md): the words of the reply that may be shown so far; never in a status when the flag is off. */
  partial?: string;
}

export interface PortalCore {
  /** Registers (or updates the identity binding of) this student's chat; returns its jid. */
  ensureStudent(user: PortalUser): string;
  submit(jid: string, text: string, name: string, id?: string): { ok: true } | { ok: false; status: number; error: string };
  /** Everything TAi sends out through the web channel, as it happens. Returns the way to stop listening. */
  onOutbound(listener: (entry: OutboundEntry) => void): () => void;
  isTyping(jid: string): boolean;
  /** The status of the chat's turn (a label while TAi works, a place in line while it waits); absent: this core has none, and the page shows the dots only. */
  status?(jid: string): PortalStatus | undefined;
  /** Registers the instructor's admin chat (folder `main`) and returns its jid; absent: this deployment has no admin chat. */
  ensureAdmin?(): string;
}

/** The voice side (src/voice/hub.ts), as far as the page needs to know it: a call is a WebSocket, TAi's thinking is a relay, typed chat can join a call. */
export interface PortalVoice {
  /** The cookie is checked and so is Origin; the hub owns the socket from here. */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, user: PortalUser, query: URLSearchParams): void;
  /** Deepgram's calls for the thinking step: no cookie, the bearer token is the check. */
  relay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
  isActive(folder: string): boolean;
  inject(folder: string, text: string): boolean;
  /** The call button was pressed and the microphone has not been asked for yet: start the student's tool host now (src/portal/voice-routes.ts, POST /api/voice/warm). Optional: a voice side without it just has no head start. */
  warm?(user: PortalUser): { ok: boolean; state: string };
}

/** What a route that a feature module registers is given: the request, the signed-in student, and the helpers the built-in routes use. */
export interface PortalRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  user: PortalUser;
  url: URL;
  /** The JSON body of a POST, at most 16 KB: a larger one answers 413 and a body that is not JSON answers 400 before the next line of the handler runs. */
  readJson(): Promise<Record<string, unknown>>;
  json(status: number, body: unknown, extraHeaders?: Record<string, string | string[]>): void;
  now(): number;
}

/**
 * A route added from outside server.ts (the preferences, the push subscriptions, the teaching view...). The server does what it does for its own
 * routes before the handler runs: a POST must be JSON and carry the page's header and origin (403 otherwise), the cookie is checked (401, or 403
 * not-enrolled), `access: 'owner'` refuses anyone but the owner (403 not-owner), and the per-student read limit applies (429). It is never part of
 * the owner's second chat (/api/admin/...). `path` starts with /api/ and may not be one the server already has.
 */
export interface PortalRoute {
  path: string;
  method: 'GET' | 'POST';
  access?: 'student' | 'owner';
  handler(ctx: PortalRouteContext): void | Promise<void>;
}

/**
 * What the server tells whoever wants to know whether a student's page is there: each poll is a request from one page (`c`, an id the page made
 * up) that says whether its tab is in front (`v`, 0 when it is not). `begin` is called when the request arrives and the function it returns when
 * the request is answered, with `true` when it was not answered because the page went away (a held poll whose connection dropped).
 */
export interface PortalPresence {
  begin(folder: string, client: string | null, visible: boolean): (gone?: boolean) => void;
}

export interface StaticFile {
  body: Buffer;
  type: string;
}

export interface PortalOptions {
  core: PortalCore;
  users: { find(email: string): PortalUser | undefined; count(): number; list?(): PortalUser[] };
  /** null: Google sign-in is not set up (no client id), so nobody can sign in. */
  verifier: { verify(idToken: string, nonce: string): Promise<GoogleIdentity> } | null;
  googleClientId: string;
  sessions: SessionCodec;
  nonces: NonceStore;
  history: HistoryStore;
  /** The pictures TAi sends and the ones students attach; without it there is no /api/media and pictures cannot be attached. */
  media?: MediaStore;
  /** Files students attach (text, code, PDF, Office); without it nothing can be attached. */
  uploads?: UploadStore;
  /** Voice notes to text; null or absent: the microphone button for notes is not offered. */
  transcribe?: Transcriber | null;
  /** Voice calls; null or absent: the page offers none. */
  voice?: PortalVoice | null;
  /** What TAi remembers of a student (their saved notes and their COMPETENCY.md in words); null or absent: no "What TAi remembers" panel. */
  memory?: PortalMemory | null;
  /** Served by URL path; "/" is index.html. */
  staticFiles: Record<string, StaticFile>;
  /** Where the page lives behind the proxy: "/" or "/tai". The session cookie is limited to it. */
  basePath?: string;
  /** The origin browsers see (https://host): POSTs must come from it, and the cookie is Secure when it is https. */
  origin?: string;
  /** The proxy in front sets X-Forwarded-For (its last entry is the client): needed for per-address limits behind it. */
  trustProxy?: boolean;
  maxMessageChars?: number;
  /**
   * How long after a student puts an emoji on one of TAi's messages, without typing anything, TAi answers it (a short reply: the emoji is
   * something said). Default 3000 ms; 0 turns the answer off, and the emoji is told to TAi with the student's next message, as it was before.
   */
  reactReplyDelayMs?: number;
  /** TAi may offer options a student taps (TAI_CHOICES=0: no; they are then a plain list in its words). Default true. */
  choices?: boolean;
  /** Routes from feature modules (see PortalRoute); src/portal/start.ts is where they are listed. */
  routes?: PortalRoute[];
  /** Extra entries of `features` in /api/me, for the page to decide what to draw (the built-in ones win over a key of the same name). */
  features?: (user: PortalUser) => Record<string, unknown>;
  /** The hosts a "looked at" chip may link to (src/sources.ts sourceHosts); absent: none, and every chip is a label. */
  sourceHosts?: ReadonlySet<string>;
  /** Learns from each poll whether the student's page is open and in front (src/notify/presence.ts: it decides whether a push is needed); absent: nobody asks. */
  presence?: PortalPresence;
  now?: () => number;
  log?: Pick<typeof logger, 'info' | 'warn'>;
}

/** The paths the server's own routes use (and the owner's second chat's prefix): a registered route may not shadow one of them. */
const RESERVED_API_PATHS = /^\/api\/(me|history|poll|send|react|feedback|activity|choose|upload|voicenote|memory|media|admin|health)(\/|$)/;

const SESSION_COOKIE = 'tai_session';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_WAIT_SECONDS = 25;
const MAX_POLLS_PER_STUDENT = 4;
const REACTION_TARGET_MAX_AGE_MS = 10 * 60_000;
const EMOJI_MAX_UNITS = 16;
/** How long a voice note may be (the page stops recording there), and the most bytes one may be: at speech quality three minutes is under a megabyte. */
export const VOICENOTE_MAX_SECONDS = 180;
export const VOICENOTE_MAX_BYTES = UPLOAD_MAX_BYTES;
/** What the student may put on one of TAi's messages: six emoji, as the page's picker offers them (a student's reaction is never anything else). */
export const STUDENT_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What the page may load: itself, Google's sign-in script, frame and styles, and the profile pictures Google serves. A voice call is a
// WebSocket to its own origin (written out, because some browsers read 'self' as http only), the microphone is the page's own, pictures
// may also be local previews (blob:), and the AudioWorklet that carries the microphone is a script of this origin.
function buildCsp(origin?: string): string {
  const ws = origin ? origin.replace(/^http/, 'ws') : '';
  return [
    "default-src 'none'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    // 'unsafe-inline' for styles only: Google's button sets inline styles on itself (without it the "G" renders at the size of the page). Scripts stay
    // locked to this origin and Google's one script, and the page never turns text into HTML, so there is no way to get markup in to style.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "img-src 'self' blob: data: https://*.googleusercontent.com",
    "media-src 'self' blob:",
    `connect-src 'self' ${ws} https://accounts.google.com/gsi/`.replace('  ', ' '),
    "worker-src 'self'",
    "manifest-src 'self'",       // portal/web/manifest.webmanifest: what lets the page be added to a home screen (and, on an iPhone, be sent notifications at all)
    'frame-src https://accounts.google.com/gsi/',
    "base-uri 'self'",           // index.html carries <base href="/tai/"> so the page works whether it was opened with or without the trailing slash
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// a pictograph with its skin tone and presentation selector, joined to others by zero-width joiners; a flag; a keycap
const EMOJI = /^(?:\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}️]*(?:‍\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}️]*)*|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)+$/u;

/** The one thing a reaction may be: a few emoji and nothing else, certainly nothing a browser could read as markup. */
export function validEmoji(emoji: unknown): emoji is string {
  return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= EMOJI_MAX_UNITS && EMOJI.test(emoji);
}

/** One of the student's six, in the form the page shows it (a heart sent without its presentation selector is the same heart); '' takes it back; null: not allowed. */
export function studentReaction(emoji: unknown): string | null {
  if (emoji === '') return '';
  if (typeof emoji !== 'string') return null;
  const bare = emoji.replace(/️/g, '');
  return STUDENT_REACTIONS.find((allowed) => allowed.replace(/️/g, '') === bare) ?? null;
}

/** TAI_PORTAL_REACT_REPLY_MS: how long after a student's emoji on one of TAi's messages TAi answers it (unset or nonsense: the default, 3000; 0: it does not). */
export function reactReplyDelay(env: NodeJS.ProcessEnv): number | undefined {
  const raw = (env.TAI_PORTAL_REACT_REPLY_MS ?? '').trim();
  if (!raw) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

/** A length in seconds as a clock, "0:12". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A client's idea of how long a recording was: a number of seconds the page's own clock measured (a WebM from a recorder carries no length). */
function claimedSeconds(raw: string | null): number | undefined {
  const n = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(n) && n > 0 && n <= 900 ? Math.round(n * 10) / 10 : undefined;
}

/** The bars of a recording's waveform, "0,12,40,...": up to 64 whole numbers from 0 to 100, or nothing. */
function peaksOf(raw: string | null): number[] | undefined {
  if (!raw || raw.length > 400 || !/^\d{1,3}(,\d{1,3}){0,63}$/.test(raw)) return undefined;
  const bars = raw.split(',').map(Number);
  return bars.every((n) => n <= 100) ? bars : undefined;
}

/** What the agent is told about the student's emoji on its earlier messages, one line each (nothing when there were none). */
function reactionNotes(history: History): string {
  return history
    .reactionsSinceLastMessage(3)
    .map((r) => `[The student reacted ${r.emoji} to your earlier message${r.excerpt ? `: "${r.excerpt}"` : ''}]\n`)
    .join('');
}

/** What the agent is told about the student's emoji and thumbs on its earlier messages (and a call's summary), ahead of their next message. */
function studentNotes(history: History): string {
  return reactionNotes(history) + feedbackLines(history.feedbackSinceLastMessage(3));
}

/** The range a request asks of a body of `size` bytes (one range only, as `bytes=a-b`, `bytes=a-` or `bytes=-n`): null for all of it, 'bad' when it lies outside the body. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    const last = Number(match[2]);
    if (last === 0) return 'bad';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start >= size || start > end ? 'bad' : { start, end };
}

export const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/**
 * The page's own files, read once at start: only these names are ever served, so no path a request names reaches the disk.
 * index.html's __BASE__ becomes where the page lives behind the proxy ("/" or "/tai/"), so every relative address in it resolves there.
 */
export function loadStaticFiles(dir: string, names: string[], basePath = '/'): Record<string, StaticFile> {
  const base = basePath.replace(/\/+$/, '') + '/';
  const out: Record<string, StaticFile> = {};
  for (const name of names) {
    const type = STATIC_TYPES[path.extname(name)];
    let body = fs.readFileSync(path.join(dir, name));
    if (name === 'index.html') body = Buffer.from(body.toString('utf-8').replace('__BASE__', base.replace(/[^A-Za-z0-9/_.~-]/g, '')), 'utf-8');
    out['/' + name] = { body, type };
  }
  if (!out['/index.html']) throw new Error('the page has no index.html');
  return out;
}

interface Student {
  folder: string;
  waiters: Set<() => void>;
  polling: number;
  /** Counts each change of the chat's status; the page sends the one it has seen (`sv`), so a change between two polls is not waited out. */
  statusVersion: number;
  /** When the long poll was last woken for a status, and the wake that is waiting for the second to be over (status changes come in bursts). */
  statusWokeAt: number;
  statusWake?: NodeJS.Timeout;
}

/** A status change wakes the page's poll at most this often (a student's polls are limited, and a tool call every second would use them up). */
const STATUS_WAKE_MS = 1000;

/** The longest preview of a reply the page is sent (the host never makes one longer than 4,000: src/stream-preview.ts PREVIEW_MAX_INPUT). */
const PARTIAL_MAX = 4000;

export class Portal {
  private server: http.Server | null = null;
  private socketPath: string | null = null;
  private students = new Map<string, Student>();
  private stopListening: (() => void) | null = null;
  private readonly now: () => number;
  private readonly log: Pick<typeof logger, 'info' | 'warn'>;
  private readonly basePath: string;
  private readonly secure: boolean;
  private readonly loginLimit: RateLimiter;
  private readonly nonceLimit: RateLimiter;
  private readonly sendLimit: RateLimiter;
  private readonly readLimit: RateLimiter;
  private readonly uploadLimit: RateLimiter;
  private readonly voiceLimit: RateLimiter;
  private readonly reactLimit: RateLimiter;
  private readonly feedbackLimit: RateLimiter;
  private readonly forgetLimit: RateLimiter;
  private readonly maxChars: number;
  private readonly csp: string;
  /** Voice notes whose recording is kept but whose words never reached TAi (it could not be reached): a retry with the same id tries again. */
  private readonly undelivered = new Map<string, string>();
  /** Voice notes (student folder and id) that are being turned into words right now: the same one sent again waits for the first to be done. */
  private readonly noteRuns = new Set<string>();
  /** Students whose emoji are about to be answered (the wait is restarted by each emoji and ended by a message of theirs). */
  private readonly reactTimers = new Map<string, NodeJS.Timeout>();
  /** Students whose last run was started by their emoji: the page puts none of its own emoji on the reply (there is no message of theirs to put it on). */
  private readonly reactionRuns = new Set<string>();
  private readonly lastReactionRunAt = new Map<string, number>();
  private readonly reactReplyDelayMs: number;
  private readonly choicesOn: boolean;
  /** `METHOD /api/path` of every route a feature module registered, and the paths alone (a wrong method on one of them is a 405, not a 404). */
  private readonly extraRoutes = new Map<string, PortalRoute>();
  private readonly extraPaths = new Set<string>();

  constructor(private readonly opts: PortalOptions) {
    this.now = opts.now ?? Date.now;
    for (const route of opts.routes ?? []) {
      const key = `${route.method} ${route.path}`;
      if (!/^\/api\/[a-z0-9][a-z0-9/_-]*$/.test(route.path) || RESERVED_API_PATHS.test(route.path) || this.extraRoutes.has(key)) {
        throw new Error(`the page cannot take the route ${key}: it is not an /api/ path, one the server already has, or registered twice`);
      }
      this.extraRoutes.set(key, route);
      this.extraPaths.add(route.path);
    }
    this.reactReplyDelayMs = Math.max(0, opts.reactReplyDelayMs ?? 3000);
    this.choicesOn = opts.choices !== false;
    this.log = opts.log ?? logger;
    this.basePath = (opts.basePath || '/').replace(/\/+$/, '') || '/';
    this.secure = (opts.origin || '').startsWith('https://');
    this.loginLimit = new RateLimiter(30, 10 * 60_000, this.now);
    this.nonceLimit = new RateLimiter(60, 10 * 60_000, this.now);
    this.sendLimit = new RateLimiter(30, 10 * 60_000, this.now);
    this.readLimit = new RateLimiter(240, 60_000, this.now);
    this.uploadLimit = new RateLimiter(30, 10 * 60_000, this.now);
    this.voiceLimit = new RateLimiter(20, 10 * 60_000, this.now);
    this.reactLimit = new RateLimiter(60, 60_000, this.now);        // each emoji is a line in the student's history: a button held down must not fill the disk
    this.feedbackLimit = new RateLimiter(60, 60_000, this.now);     // and so is each thumb
    this.forgetLimit = new RateLimiter(20, 60_000, this.now);       // taking notes back is rare: a script that tries every id is not
    this.maxChars = opts.maxMessageChars ?? 6000;
    this.csp = buildCsp(opts.origin);
    // a picture that is taken back or never sent leaves no copy in the media store (the workspace copy goes with the upload itself)
    const pictures = opts.media;
    if (opts.uploads && pictures) opts.uploads.onDrop = (up) => void (up.media && pictures.remove(up.folder, up.media));
  }

  /** Listens on a unix socket (the live deployment: nothing on the network) or on a loopback port (tests, local use). */
  async listen(target: { socket: string } | { host: string; port: number }): Promise<void> {
    if ('host' in target && !['127.0.0.1', '::1', 'localhost'].includes(target.host)) {
      throw new Error(`the page listens on loopback or a socket, not on ${target.host}: the proxy in front is what faces the network`);
    }
    this.stopListening = this.opts.core.onOutbound((entry) => this.onOutbound(entry));
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.warn({ err: (err as Error).message }, 'portal request failed');
        if (!res.headersSent) this.json(res, 500, { error: 'internal' });
        else res.end();
      });
    });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      if ('socket' in target) {
        try {
          fs.unlinkSync(target.socket);
        } catch {
          /* nothing there */
        }
        this.socketPath = target.socket;
        this.server!.listen(target.socket, () => {
          // the proxy container connects as another user, through the directory the socket is in: the page itself is what checks who is who
          fs.chmodSync(target.socket, 0o666);
          resolve();
        });
      } else {
        this.server!.listen(target.port, target.host, () => resolve());
      }
    });
  }

  address(): { port: number } | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? { port: a.port } : null;
  }

  async close(): Promise<void> {
    this.stopListening?.();
    for (const timer of this.reactTimers.values()) clearTimeout(timer);
    this.reactTimers.clear();
    for (const student of this.students.values()) {
      if (student.statusWake) clearTimeout(student.statusWake);
      for (const wake of [...student.waiters]) wake();
    }
    const server = this.server;
    this.server = null;
    if (server) {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.socketPath) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        /* already gone */
      }
    }
  }

  // ---------------------------------------------------------------- what TAi says

  private student(folder: string): Student {
    let student = this.students.get(folder);
    if (!student) {
      student = { folder, waiters: new Set(), polling: 0, statusVersion: 0, statusWokeAt: 0 };
      this.students.set(folder, student);
    }
    return student;
  }

  private wake(folder: string): void {
    const student = this.students.get(folder);
    if (student) for (const wake of [...student.waiters]) wake();
  }

  /** For the voice side: it has written to a student's history, so whoever is polling should look. */
  wakeStudent(folder: string): void {
    this.wake(folder);
  }

  private onOutbound(entry: OutboundEntry): void {
    const folder = entry.jid.startsWith('web:') ? entry.jid.slice(4) : '';
    if (!isChatFolder(folder) || (folder === ADMIN_FOLDER && !this.opts.core.ensureAdmin)) return;      // the evaluation's chats, or anything else on the web channel, are not this page's
    const history = this.opts.history.forFolder(folder);
    const now = new Date(this.now());
    if (entry.kind === 'text' && entry.text && entry.text.trim()) {
      const asks = entry.choices && entry.choices.length >= 2 && folder !== ADMIN_FOLDER ? entry.choices : undefined;
      // what TAi opened for this answer: shaped and held to the hosts the deployment names (an address of any other host is dropped, the label stays)
      const sources = clipSources(entry.sources, this.opts.sourceHosts ?? new Set());
      history.append('assistant', entry.text, now, { ...(asks ? { choices: asks, ...(entry.quiz ? { quiz: true } : {}), ...(entry.secret ? { secret: entry.secret } : {}) } : {}), ...(sources.length > 0 ? { sources } : {}) });
      if (!this.reactionRuns.delete(folder)) this.autoReact(folder, now);       // the answer to an emoji has no message of theirs to put one on
      this.wake(folder);
    } else if (entry.kind === 'image') {
      // a diagram or an illustration: the picture (when the bytes were one) with the caption TAi wrote for it, which is its whole answer
      const caption = (entry.caption || '').trim();
      if (entry.media && MEDIA_ID.test(entry.media)) history.append('assistant', caption, now, { kind: 'image', media: entry.media });
      else if (caption) history.append('assistant', caption, now);
      this.wake(folder);
    } else if (entry.kind === 'reaction') {
      if (this.react(folder, entry.messageId, entry.emoji, now)) this.wake(folder);
    } else if (entry.kind === 'typing') {
      this.wake(folder);
    } else if (entry.kind === 'status') {
      this.statusChanged(folder);
    }
  }

  /**
   * The status of a student's chat changed (a tool started, the queue moved): the version goes up at once, so a poll that has not seen it returns
   * without waiting, and the poll that is waiting is woken, at most once a second (with a trailing wake, so the last change of a burst is not lost).
   */
  private statusChanged(folder: string): void {
    const student = this.student(folder);
    student.statusVersion++;
    const since = this.now() - student.statusWokeAt;
    if (since >= STATUS_WAKE_MS) {
      student.statusWokeAt = this.now();
      this.wake(folder);
    } else if (!student.statusWake) {
      student.statusWake = setTimeout(() => {
        student.statusWake = undefined;
        student.statusWokeAt = this.now();
        this.wake(folder);
      }, STATUS_WAKE_MS - since);
      student.statusWake.unref?.();
    }
  }

  /** The chat's status as the page gets it: present only while TAi works or waits, and only the fields of PortalStatus (nothing else the core knows). */
  private statusOf(jid: string): PortalStatus | undefined {
    const status = this.opts.core.status?.(jid);
    if (!status || (status.state !== 'working' && status.state !== 'queued')) return undefined;
    const ahead = typeof status.ahead === 'number' && Number.isInteger(status.ahead) && status.ahead >= 0 && status.ahead < 1000 ? status.ahead : undefined;
    return {
      state: status.state,
      ...(typeof status.label === 'string' && status.label.length > 0 && status.label.length <= 60 ? { label: status.label } : {}),
      ...(status.state === 'queued' && ahead !== undefined ? { ahead } : {}),
      ...(status.state === 'working' && typeof status.partial === 'string' && status.partial.trim() !== '' && status.partial.length <= PARTIAL_MAX ? { partial: status.partial } : {}),
    };
  }

  /**
   * The reply to a student's message has arrived and TAi put no emoji on it: when the message says in so many words that it worked, says
   * thanks or says the student is stuck, the page puts one on it (autoreact.ts). Never on a message that has one, and never on a third
   * message in a row.
   */
  private autoReact(folder: string, now: Date): void {
    if (folder === ADMIN_FOLDER) return;
    const history = this.opts.history.forFolder(folder);
    const target = history.latestUser(REACTION_TARGET_MAX_AGE_MS, now.getTime());
    if (!target) return;
    const recent = history.tail(40);
    // TAi's emoji on the student's messages only: the student's own emoji on TAi's messages (role user) name TAi's numbers, not theirs
    const tai = (e: HistoryEntry) => e.kind === 'react' && e.role === 'assistant';
    if (recent.some((e) => tai(e) && e.to === target.n)) return;                                   // TAi chose already
    const userTexts = recent.filter(isStudentMessage);
    const lastTwo = userTexts.slice(-3, -1);
    if (lastTwo.length === 2 && lastTwo.every((u) => recent.some((e) => tai(e) && e.to === u.n))) return;   // two reacted to just before
    const emoji = suggestReaction(target.text);
    if (!emoji) return;
    history.append('assistant', '', now, { kind: 'react', to: target.n, emoji });
  }

  /**
   * TAi's emoji on one of the student's messages: a line of its own in the history, naming the message, so a reload and a second tab see it
   * and a client that is polling gets it like anything else. A message id that matches nothing (a model sometimes invents one) goes to the
   * student's newest message when that is recent, and is dropped when it is not.
   */
  private react(folder: string, messageId: string | undefined, emoji: string | undefined, now: Date): boolean {
    if (!validEmoji(emoji)) return false;
    const history = this.opts.history.forFolder(folder);
    const target = (messageId && history.findUserById(messageId)) || history.latestUser(REACTION_TARGET_MAX_AGE_MS, now.getTime());
    if (!target) return false;
    history.append('assistant', '', now, { kind: 'react', to: target.n, emoji });
    return true;
  }

  // ---------------------------------------------------------------- requests

  private headers(res: http.ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Both as Google's "Sign in with Google" guide asks of a page that uses the button: the popup that signs the student in must keep its
    // link to this page (COOP same-origin would cut it and the callback would never fire), and Google's frame is told the origin, not the path
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    // the microphone is the page's own: a voice call and a voice note need it; nothing embedded here may ask for it
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=()');
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store', ...extra });
    res.end(payload);
  }

  private clientIp(req: http.IncomingMessage): string {
    if (this.opts.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[forwarded.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  private cookie(value: string, maxAge: number): string {
    return [`${SESSION_COOKIE}=${value}`, 'HttpOnly', 'SameSite=Lax', `Path=${this.basePath}`, `Max-Age=${maxAge}`, ...(this.secure ? ['Secure'] : [])].join('; ');
  }

  private sessionCookie(req: http.IncomingMessage): string | undefined {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return rest.join('=');
    }
    return undefined;
  }

  /** The signed-in student, or the reply to send instead. */
  private authenticate(req: http.IncomingMessage, res: http.ServerResponse): PortalUser | null {
    const session = this.opts.sessions.verify(this.sessionCookie(req));
    if (!session) {
      this.json(res, 401, { error: 'signed-out' });
      return null;
    }
    const user = this.opts.users.find(session.email);
    if (!user) {
      this.json(res, 403, { error: 'not-enrolled' });
      return null;
    }
    return user;
  }

  /** A POST must be JSON (or, for a file, plain bytes), carry the page's header and come from the page's own origin: a form on another site can do none of that. */
  private postProblem(req: http.IncomingMessage, contentType: string | readonly string[] = 'application/json'): string | null {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (typeof contentType === 'string' ? type !== contentType : !contentType.includes(type)) return 'content-type';
    if (req.headers['x-tai'] !== '1') return 'csrf';
    const origin = req.headers.origin;
    if (this.opts.origin) {
      if (origin !== this.opts.origin) return 'origin';
    } else if (origin && origin !== `http://${req.headers.host}`) {
      return 'origin';
    }
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return 'cross-site';
    return null;
  }

  private readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      let refused = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          // answer first (with Connection: close, see handle()), keep discarding what is still coming: destroying the socket here would
          // cut the answer off
          refused = true;
          chunks.length = 0;
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (refused) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
          resolve(value as Record<string, unknown>);
        } catch {
          reject(Object.assign(new Error('bad json'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  /** A request body as bytes, up to `max`; a longer one is answered with 413 (and the connection closed) as readJson does. */
  private readBytes(req: http.IncomingMessage, max: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let size = 0;
      let refused = false;
      const chunks: Buffer[] = [];
      // a body that says it is too long is refused at once, but still read to its end and thrown away: closing the socket under a client
      // that is still sending would cut the 413 off
      const declared = parseInt(String(req.headers['content-length'] || ''), 10);
      if (Number.isFinite(declared) && declared > max) {
        refused = true;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
      }
      req.on('data', (chunk: Buffer) => {
        if (refused) return;
        size += chunk.length;
        if (size > max) {
          refused = true;
          chunks.length = 0;
          reject(Object.assign(new Error('body too large'), { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!refused) resolve(Buffer.concat(chunks));
      });
      req.on('error', reject);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.headers(res);
    const url = new URL(req.url || '/', 'http://portal');
    const method = req.method || 'GET';
    const pathname = url.pathname;

    if (method === 'GET' || method === 'HEAD') {
      const file = this.opts.staticFiles[pathname === '/' ? '/index.html' : pathname];
      if (file) return this.serveStatic(req, res, pathname, file);
      // the mock interview's link (/interview/<token>) opens the page; the page asks for the call, and the call checks the token
      const shell = this.opts.staticFiles['/index.html'];
      if (shell && /^\/interview\/[A-Za-z0-9_.-]{1,2000}$/.test(pathname)) return this.serveStatic(req, res, '/index.html', shell);
    }
    try {
      return await this.route(req, res, method, pathname, url);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 413) res.setHeader('connection', 'close');
      if (status === 413 || status === 400) return this.json(res, status, { error: status === 413 ? 'too-large' : 'bad-request' });
      throw err;
    }
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, file: StaticFile): void {
    const etag = `"${contentTag(file.body)}"`;
    const headers: Record<string, string> = { 'content-type': file.type, 'cache-control': 'no-cache', etag };
    // every page of the site (index.html, team.html...) carries the policy, not only the first: a page served without one would run with none
    if (pathname === '/' || pathname.endsWith('.html')) headers['content-security-policy'] = this.csp;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return void res.end();
    }
    res.writeHead(200, { ...headers, 'content-length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  /** A route a feature module registered: the checks of the built-in ones (see PortalRoute), then the module's handler. */
  private async extraRoute(req: http.IncomingMessage, res: http.ServerResponse, route: PortalRoute, url: URL): Promise<void> {
    if (route.method === 'POST') {
      const problem = this.postProblem(req);
      if (problem) return this.json(res, 403, { error: problem });
    }
    const user = this.authenticate(req, res);
    if (!user) return;
    if (route.access === 'owner' && user.role !== 'owner') return this.json(res, 403, { error: 'not-owner' });
    if (!this.readLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    await route.handler({
      req,
      res,
      user,
      url,
      readJson: () => this.readJson(req),
      json: (status, body, extraHeaders) => this.json(res, status, body, extraHeaders),
      now: this.now,
    });
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, method: string, pathname: string, url: URL): Promise<void> {
    if (pathname === '/api/health' && method === 'GET') return this.json(res, 200, { ok: true });

    const added = this.extraRoutes.get(`${method} ${pathname}`);
    if (added) return this.extraRoute(req, res, added, url);
    if (this.extraPaths.has(pathname)) return this.json(res, 405, { error: 'method' });

    if (pathname === '/auth/config' && method === 'GET') {
      return this.json(res, 200, { clientId: this.opts.verifier ? this.opts.googleClientId : '', enabled: this.opts.verifier !== null });
    }

    if (pathname === '/auth/nonce' && method === 'GET') {
      if (!this.nonceLimit.allow(this.clientIp(req))) return this.json(res, 429, { error: 'rate-limited' });
      return this.json(res, 200, { nonce: this.opts.nonces.issue() });
    }

    if (pathname === '/auth/google' && method === 'POST') return this.login(req, res);

    if (pathname === '/auth/logout' && method === 'POST') {
      const problem = this.postProblem(req);
      if (problem) return this.json(res, 403, { error: problem });
      return this.json(res, 200, { ok: true }, { 'set-cookie': this.cookie('', 0) });
    }

    // Deepgram's thinking step calls this from the internet: no cookie, the relay checks the bearer token and answers everything itself
    if (pathname.startsWith('/voice-llm/')) {
      if (!this.opts.voice) return this.json(res, 404, { error: 'not-found' });
      if (method !== 'POST') return this.json(res, 405, { error: 'method' });
      return this.opts.voice.relay(req, res);
    }

    if ((pathname.startsWith('/api/media/') || pathname.startsWith('/api/admin/media/')) && method === 'GET') {
      const admin = pathname.startsWith('/api/admin/');
      const real = this.authenticate(req, res);
      if (!real) return;
      if (admin && (!this.opts.core.ensureAdmin || real.role !== 'owner')) return this.json(res, 403, { error: 'not-owner' });
      const user = admin ? this.adminView(real) : real;
      if (!this.readLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
      return this.serveMedia(req, res, user, pathname.slice(admin ? '/api/admin/media/'.length : '/api/media/'.length));
    }

    if (pathname === '/api/upload') {
      if (method !== 'POST') return this.json(res, 405, { error: 'method' });
      return this.upload(req, res, url);
    }

    // a voice note: the recording itself as the body (its own type as the content type), sent as a message. The student's chat only: the
    // teaching-team chat takes text, so there is no api/admin/voicenote
    if (pathname === '/api/voicenote') {
      if (method !== 'POST') return this.json(res, 405, { error: 'method' });
      return this.voiceNote(req, res, url);
    }

    // a student who removes a file's chip before sending gives the upload back: its slot and its file are freed
    if (pathname === '/api/upload/release') {
      if (method !== 'POST') return this.json(res, 405, { error: 'method' });
      const problem = this.postProblem(req);
      if (problem) return this.json(res, 403, { error: problem });
      const user = this.authenticate(req, res);
      if (!user) return;
      const body = await this.readJson(req);
      const id = typeof body.id === 'string' && /^[0-9a-f]{24}$/.test(body.id) ? body.id : '';
      if (!id || !this.opts.uploads) return this.json(res, 400, { error: 'bad-request' });
      return this.json(res, 200, { ok: this.opts.uploads.release(user.folder, id) });
    }

    // what TAi remembers of this student, for the page's "What TAi remembers" panel: their own notes and nobody else's (the folder is the
    // session's), and the one thing they may do to a note. The teaching-team chat has none (api/admin/memory is not a call that exists)
    if (pathname === '/api/memory' || pathname === '/api/memory/forget') {
      const forgetting = pathname === '/api/memory/forget';
      if (method !== (forgetting ? 'POST' : 'GET')) return this.json(res, 405, { error: 'method' });
      if (forgetting) {
        const problem = this.postProblem(req);
        if (problem) return this.json(res, 403, { error: problem });
      }
      const user = this.authenticate(req, res);
      if (!user) return;
      const memory = this.opts.memory;
      if (!memory) return this.json(res, 404, { error: 'not-found' });
      return forgetting ? this.forgetNote(req, res, user, memory) : this.showMemory(res, user, memory);
    }

    // the owner's second chat, with the instructor's admin group, is the same six calls under /api/admin/
    const admin = pathname.startsWith('/api/admin/');
    const apiPath = admin ? '/api/' + pathname.slice('/api/admin/'.length) : pathname;
    if (apiPath.startsWith('/api/') || pathname.startsWith('/auth/')) {
      const known = ['/api/me', '/api/history', '/api/poll', '/api/send', '/api/react', '/api/feedback', '/api/activity', '/api/choose'];
      if (!known.includes(apiPath) || (admin && (!this.opts.core.ensureAdmin || apiPath === '/api/activity' || apiPath === '/api/choose'))) return this.json(res, 404, { error: 'not-found' });
      const wanted = apiPath === '/api/send' || apiPath === '/api/react' || apiPath === '/api/feedback' || apiPath === '/api/choose' ? 'POST' : 'GET';
      if (method !== wanted) return this.json(res, 405, { error: 'method' });
      if (method === 'POST') {
        const problem = this.postProblem(req);
        if (problem) return this.json(res, 403, { error: problem });
      }
      const real = this.authenticate(req, res);
      if (!real) return;
      if (admin && real.role !== 'owner') return this.json(res, 403, { error: 'not-owner' });
      const user = admin ? this.adminView(real) : real;
      if (!this.readLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
      switch (apiPath) {
        case '/api/me':
          return this.me(res, user);
        case '/api/history':
          return this.historyOf(res, user, url);
        case '/api/poll': {
          const seen = admin ? undefined : this.opts.presence?.begin(user.folder, url.searchParams.get('c'), url.searchParams.get('v') !== '0');
          return this.poll(req, res, user, url).finally(() => seen?.(!res.writableEnded));       // not answered: the page went away
        }
        case '/api/react':
          return this.studentReacts(req, res, user);
        case '/api/feedback':
          return this.studentRates(req, res, user);
        case '/api/activity':
          return this.showActivity(res, user, url);
        case '/api/choose':
          return this.studentChooses(req, res, user);
        default:
          return this.send(req, res, user);
      }
    }
    this.json(res, 404, { error: 'not-found' });
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const problem = this.postProblem(req);
    if (problem) return this.json(res, 403, { error: problem });
    if (!this.loginLimit.allow(this.clientIp(req))) return this.json(res, 429, { error: 'rate-limited' });
    if (!this.opts.verifier) return this.json(res, 503, { error: 'sign-in-not-configured' });
    const body = await this.readJson(req);
    const credential = typeof body.credential === 'string' ? body.credential : '';
    const nonce = typeof body.nonce === 'string' ? body.nonce : '';
    if (!credential || !nonce || !this.opts.nonces.consume(nonce)) return this.json(res, 401, { error: 'sign-in-failed', reason: 'nonce' });
    let identity: GoogleIdentity;
    try {
      identity = await this.opts.verifier.verify(credential, nonce);
    } catch (err) {
      const reason = err instanceof AuthError ? err.reason : 'unavailable';
      this.log.warn({ reason }, 'portal sign-in refused');
      return this.json(res, 401, { error: 'sign-in-failed', reason });
    }
    const user = this.opts.users.find(identity.email);
    if (!user) {
      this.log.info({ email: identity.email }, 'portal sign-in: address not on the list');
      return this.json(res, 403, { error: 'not-enrolled', email: identity.email });
    }
    const session = this.opts.sessions.issue(user.email);
    this.log.info({ folder: user.folder, role: user.role }, 'portal sign-in');
    this.json(res, 200, { ok: true, user: { email: user.email, name: user.name, role: user.role } }, { 'set-cookie': this.cookie(session.value, session.maxAgeSeconds) });
  }

  /** The extra `features` of feature modules; a module that throws costs the page its own entry, never the whole /api/me. */
  private extraFeatures(user: PortalUser): Record<string, unknown> {
    try {
      return this.opts.features?.(user) ?? {};
    } catch (err) {
      this.log.warn({ err }, 'portal: a feature module could not say what it offers');
      return {};
    }
  }

  /** `status` (only while TAi works or waits) and `sv`, the version of it, for the payloads of /api/me. */
  private statusFields(user: PortalUser): { status?: PortalStatus; sv: number } {
    const status = this.statusOf(user.jid);
    return { ...(status ? { status } : {}), sv: this.student(user.folder).statusVersion };
  }

  private me(res: http.ServerResponse, user: PortalUser): void {
    const jid = user.jid;
    const inAdmin = user.folder === ADMIN_FOLDER;
    this.json(res, 200, {
      user: { email: user.email, name: user.name, role: user.role },
      last: this.opts.history.forFolder(user.folder).last,
      typing: this.opts.core.isTyping(jid),
      ...this.statusFields(user),
      maxChars: this.maxChars,
      // what the page may offer: a button that does nothing is not drawn (the admin chat takes text and shows pictures, nothing else)
      features: {
        ...this.extraFeatures(user),
        files: !inAdmin && !!this.opts.uploads,
        pictures: !inAdmin && !!this.opts.uploads && !!this.opts.media,
        voiceNotes: !inAdmin && !!this.opts.transcribe && !!this.opts.media,
        voiceCalls: !inAdmin && !!this.opts.voice,
        memory: !inAdmin && !!this.opts.memory,
        activity: !inAdmin,
        choices: !inAdmin && this.choicesOn,
        voiceNoteSeconds: VOICENOTE_MAX_SECONDS,
        maxUploadBytes: UPLOAD_MAX_BYTES,
        accept: ACCEPTED_EXTENSIONS,
        admin: user.role === 'owner' && !!this.opts.core.ensureAdmin,
      },
    });
  }

  /** The owner as the admin chat sees them: the same person and session, the admin group's folder and chat. */
  private adminView(user: PortalUser): PortalUser {
    return { ...user, folder: ADMIN_FOLDER, jid: `web:${ADMIN_FOLDER}` };
  }

  private serveMedia(req: http.IncomingMessage, res: http.ServerResponse, user: PortalUser, id: string): void {
    const found = this.opts.media?.open(user.folder, id);
    if (!found) return this.json(res, 404, { error: 'not-found' });
    const headers = {
      'content-type': found.mime,
      // a picture never changes under its id; sandbox and no sources: nothing in it can run or load, even if it were opened on its own
      'cache-control': 'private, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; sandbox",
      // a voice note is played by a media element, which asks for pieces of it (Safari will not play a recording that cannot be asked for in pieces)
      'accept-ranges': 'bytes',
    };
    const size = found.body.length;
    const range = byteRange(req.headers.range, size);
    if (range === 'bad') {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 });
      return void res.end();
    }
    if (range) {
      res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
      return void res.end(found.body.subarray(range.start, range.end + 1));
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    res.end(found.body);
  }

  /** A WebSocket for a voice call: the same session cookie as the page, and an Origin that is the page's own (a page of another site must not be able to open one). */
  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, reason: string) => {
      socket.on('error', () => undefined);
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const voice = this.opts.voice;
    const url = new URL(req.url || '/', 'http://portal');
    if (!voice || url.pathname !== '/api/voice') return refuse(404, 'Not Found');
    const origin = req.headers.origin;
    const allowed = this.opts.origin ? origin === this.opts.origin : !origin || origin === `http://${req.headers.host}`;
    if (!allowed) return refuse(403, 'Forbidden');
    const session = this.opts.sessions.verify(this.sessionCookie(req));
    if (!session) return refuse(401, 'Unauthorized');
    const user = this.opts.users.find(session.email);
    if (!user) return refuse(403, 'Forbidden');
    if (!this.voiceLimit.allow(user.folder)) return refuse(429, 'Too Many Requests');
    this.opts.core.ensureStudent(user);
    voice.upgrade(req, socket, head, user, url.searchParams);
  }

  /**
   * A file from the page. The body is the file's bytes (its name travels in the query); what comes back is an id for POST /api/send to
   * name. A recording is not a file: voice notes have their own call (POST /api/voicenote).
   */
  private async upload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const problem = this.postProblem(req, 'application/octet-stream');
    if (problem) return this.json(res, 403, { error: problem });
    const user = this.authenticate(req, res);
    if (!user) return;
    if (!this.uploadLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    const { uploads, media } = this.opts;
    if (!uploads) return this.json(res, 404, { error: 'not-found' });
    const name = (url.searchParams.get('name') || '').slice(0, 200);
    if (!name) return this.json(res, 400, { error: 'bad-request' });
    const body = await this.readBytes(req, UPLOAD_MAX_BYTES);
    const kind = classifyUpload(name, body);
    // a recording is not an attachment (the picker does not offer one): it is what POST /api/voicenote is for
    if (!kind || kind === 'audio') return this.json(res, 415, { error: 'unsupported' });

    if (kind === 'image') {
      if (!media || body.length > MAX_IMAGE_BYTES) return this.json(res, 415, { error: 'not-an-image' });
      // the pending limit is asked BEFORE the picture is copied anywhere: a refusal must leave nothing behind (it used to leave the whole picture in the media store)
      if (!uploads.hasRoom(user.folder)) return this.json(res, 429, { error: 'too-many-pending' });
      const kept = media.saveImage(user.folder, body);
      if ('error' in kept) return kept.error === 'quota' ? this.json(res, 413, { error: 'quota' }) : this.json(res, 415, { error: 'not-an-image' });
      const up = uploads.keepPicture(user.folder, name, body.length, kept.id, body);   // its bytes too: the agent reads the text in it (docs/OCR.md)
      if ('error' in up) {
        media.remove(user.folder, kept.id);
        return this.json(res, 429, { error: up.error });
      }
      return this.json(res, 200, { id: up.id, name: up.name, size: up.size, kind: up.kind, media: kept.id });
    }
    const up = uploads.keepFile(user.folder, name, kind, body);
    if ('error' in up) return this.json(res, up.error === 'quota' ? 413 : 429, { error: up.error });
    this.json(res, 200, { id: up.id, name: up.name, size: up.size, kind: up.kind });
  }

  /**
   * A voice note: a recording the student sends as a message. The body is the audio (its own type as the content type, checked against the
   * bytes too); the query says how long it was (`duration`, from the page's clock: a recorder's WebM carries no length), the bars of its
   * waveform (`peaks`) and the id the page gave the message (`id`, so a retry after a lost answer is not a second message). The recording
   * is kept in the media store (served by api/media/<id> to this student and nobody else) and turned into words; the history line carries
   * both, and TAi is sent the words. A recording that could not be turned into words is still kept and still shown, and TAi is told to ask
   * for it typed: a failure on Deepgram's side never loses what the student said.
   */
  private async voiceNote(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const problem = this.postProblem(req, type);               // the page's header, its origin and the fetch site: the type is judged below
    if (problem) return this.json(res, 403, { error: problem });
    const user = this.authenticate(req, res);
    if (!user) return;
    const { media, transcribe } = this.opts;
    if (!media || !transcribe) return this.json(res, 503, { error: 'voice-notes-off' });
    if (!(AUDIO_TYPES as readonly string[]).includes(type)) return this.json(res, 415, { error: 'unsupported' });
    // a voice note is an upload and a message at once: both limits count it
    if (!this.uploadLimit.allow(user.folder) || !this.sendLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    const body = await this.readBytes(req, VOICENOTE_MAX_BYTES);
    const history = this.opts.history.forFolder(user.folder);
    const jid = this.opts.core.ensureStudent(user);
    const asked = url.searchParams.get('id') || '';
    let messageId = CLIENT_ID.test(asked) ? asked : '';
    const earlier = messageId ? history.findUserById(messageId) : undefined;
    if (earlier && earlier.kind === 'audio') {
      // the same note again, because the answer to the first try never arrived: not a second message, but TAi gets it if it never did
      const owed = this.undelivered.get(messageId);
      if (owed !== undefined) {
        const again = this.opts.core.submit(jid, owed, user.name, messageId);
        if (!again.ok) return this.json(res, 502, { error: 'unavailable' });
        this.undelivered.delete(messageId);
      }
      return this.json(res, 200, { ok: true, n: earlier.n, entry: earlier });
    }
    if (earlier) messageId = '';                               // the id of something that is not a voice note: not to be reused
    // the same note again while its first copy is still being turned into words (a connection that dropped while the page waited): not a
    // second message; the page's bubble offers to try again, and by then the first is done
    const running = messageId ? `${user.folder}:${messageId}` : '';
    if (running && this.noteRuns.has(running)) return this.json(res, 409, { error: 'in-progress' });
    if (running) this.noteRuns.add(running);
    try {
      await this.takeNote(res, user, url, body, messageId, jid, media, transcribe);
    } finally {
      if (running) this.noteRuns.delete(running);
    }
  }

  /** The rest of a voice note: kept, turned into words, written to the history, and handed to TAi (or, in a call, to the call). */
  private async takeNote(
    res: http.ServerResponse,
    user: PortalUser,
    url: URL,
    body: Buffer,
    id: string,
    jid: string,
    media: MediaStore,
    transcribe: Transcriber,
  ): Promise<void> {
    const history = this.opts.history.forFolder(user.folder);
    let messageId = id;
    const saved = media.saveAudio(user.folder, body, VOICENOTE_MAX_BYTES);
    if ('error' in saved) return this.json(res, saved.error === 'quota' ? 413 : 415, { error: saved.error });
    let words = '';
    try {
      words = (await transcribe(body, saved.mime)).replace(/\r\n/g, '\n').trim().slice(0, this.maxChars);
    } catch (err) {
      this.log.warn({ folder: user.folder, err: (err as Error).message }, 'portal voice note could not be turned into words');
    }
    const duration = claimedSeconds(url.searchParams.get('duration'));
    this.cancelReactionReply(user.folder);                     // their note carries the emoji they put on TAi's messages
    const noted = studentNotes(history);                       // read before the note is added: it is what the student did since their last message
    messageId = messageId || randomUUID();
    const entry = history.append('user', words, new Date(this.now()), {
      kind: 'audio',
      id: messageId,
      mediaId: saved.id,
      duration,
      peaks: peaksOf(url.searchParams.get('peaks')),
    });
    const toAgent =
      noted +
      (words
        ? `[Voice note${duration ? `, ${clock(duration)}` : ''}] ${words}`
        : `[The student sent a voice note${duration ? ` of ${clock(duration)}` : ''} that could not be transcribed: ask them to type it]`);
    // a call is on: like typed words, a note's words go into the call and the text agent stays out of it (a note with no words has nothing to say to it)
    const voice = this.opts.voice;
    if (voice?.isActive(user.folder) && (!words || voice.inject(user.folder, words))) {
      this.wake(user.folder);
      return this.json(res, 200, { ok: true, n: entry.n, entry });
    }
    const sent = this.opts.core.submit(jid, toAgent, user.name, messageId);
    this.wake(user.folder);
    if (!sent.ok) {
      this.log.warn({ folder: user.folder, status: sent.status }, 'portal could not hand a voice note to TAi');
      this.undelivered.set(messageId, toAgent);
      if (this.undelivered.size > 200) this.undelivered.delete(this.undelivered.keys().next().value as string);
      return this.json(res, 502, { error: 'unavailable' });
    }
    this.json(res, 200, { ok: true, n: entry.n, entry });
  }

  /**
   * The student's emoji on one of TAi's messages, or taking it back (an empty `emoji`): a line in the history, so a reload and a second tab
   * see it and a client that is polling gets it like anything else. It is not a message: no agent run starts, and TAi hears of it with the
   * student's next message. The emoji must be one of the six the page offers and `to` a text or picture message of TAi's in this
   * student's own history (a call's summary is not reacted to); setting what is already there changes nothing.
   */
  private async studentReacts(req: http.IncomingMessage, res: http.ServerResponse, user: PortalUser): Promise<void> {
    const body = await this.readJson(req);
    const to = typeof body.to === 'number' && Number.isInteger(body.to) && body.to > 0 ? body.to : 0;
    const emoji = studentReaction(body.emoji);
    if (!to || emoji === null) return this.json(res, 400, { error: 'bad-request' });
    if (!this.reactLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    const history = this.opts.history.forFolder(user.folder);
    const target = history.get(to);
    if (!target || target.role !== 'assistant' || (target.kind && target.kind !== 'text' && target.kind !== 'image')) return this.json(res, 404, { error: 'not-found' });
    if (history.reactionOn(to) === emoji) return this.json(res, 200, { ok: true, changed: false });
    const entry = history.append('user', '', new Date(this.now()), { kind: 'react', to, emoji });
    this.wake(user.folder);
    this.scheduleReactionReply(user);
    this.json(res, 200, { ok: true, changed: true, n: entry.n });
  }

  /**
   * A student's emoji is something said, and it is answered: the owner found that the first one seemed to get a reply and the next one did
   * not (the first was followed by their own words; no emoji started anything). Now, a few seconds after the last emoji and when they have not
   * typed in the meantime, TAi gets the note of it as a message of its own (the persona says to answer in a few words). Not in the teaching-team
   * chat, not in a voice call, and the wait starts again with every emoji, so three taps are one answer.
   */
  private scheduleReactionReply(user: PortalUser): void {
    const folder = user.folder;
    const delay = this.reactReplyDelayMs;
    if (delay <= 0 || folder === ADMIN_FOLDER) return;
    clearTimeout(this.reactTimers.get(folder));
    const timer = setTimeout(() => {
      this.reactTimers.delete(folder);
      try {
        this.replyToReactions(user);
      } catch (err) {
        this.log.warn({ folder, err: (err as Error).message }, 'portal could not answer a student\'s emoji');
      }
    }, delay);
    timer.unref?.();
    this.reactTimers.set(folder, timer);
  }

  private cancelReactionReply(folder: string): void {
    const timer = this.reactTimers.get(folder);
    if (timer) clearTimeout(timer);
    this.reactTimers.delete(folder);
  }

  private replyToReactions(user: PortalUser): void {
    const folder = user.folder;
    const history = this.opts.history.forFolder(folder);
    if (this.opts.voice?.isActive(folder)) return;                       // in a call their emoji are not a message for the text agent
    if (!reactionNotes(history)) return;                                 // they typed since (the note went with their words), or took the emoji back
    if (this.now() - (this.lastReactionRunAt.get(folder) ?? 0) < this.reactReplyDelayMs) return;       // not twice in a moment: the notes wait for what comes next
    if (!this.sendLimit.allow(folder)) return;                           // an answer is a run like a message is: the same allowance, so a button cannot be a way round it
    const jid = this.opts.core.ensureStudent(user);
    const sent = this.opts.core.submit(jid, studentNotes(history), user.name, randomUUID());
    if (!sent.ok) {
      this.log.warn({ folder, status: sent.status }, 'portal could not hand a student\'s emoji to TAi');
      return;
    }
    history.markTold();                                                  // the next message of theirs does not tell TAi again
    this.lastReactionRunAt.set(folder, this.now());
    this.reactionRuns.add(folder);
  }

  /**
   * For the rest of the orchestrator: something happened for this student that belongs in their activity list (a note TAi kept, a reminder it
   * set): a line in their history, and whoever polls is told. Only a student's chat has one; what does not fit the line's limits is cut.
   */
  recordActivity(folder: string, input: ActivityInput): void {
    if (!STUDENT_FOLDER.test(folder)) return;
    const clipped = clipActivity(input);
    if (!clipped) return;
    this.opts.history.forFolder(folder).append('assistant', clipped.text, new Date(this.now()), clipped.extra);
    this.wake(folder);
  }

  /**
   * A change in the course, for every student on the list who has a conversation here already: a student who has not opened the page yet is
   * greeted and given their places to start, not handed what they missed (the page takes an empty history for a new student). Returns how many.
   */
  recordCourseUpdate(input: ActivityInput): number {
    let told = 0;
    for (const user of this.opts.users.list?.() ?? []) {
      if (this.opts.history.forFolder(user.folder).last === 0) continue;
      this.recordActivity(user.folder, input);
      told++;
    }
    return told;
  }

  /**
   * Something about one student's standing in the course (a grade posted, an assignment marked missing), for the student whose Canvas user id
   * it is, if they are on the list and have a conversation here (as recordCourseUpdate: a student who has not opened the page is greeted
   * first). It goes to that student's history and to nobody else's. Returns whether it was written.
   */
  recordForCanvasUser(canvasUserId: string, input: ActivityInput): boolean {
    const user = (this.opts.users.list?.() ?? []).find((u) => u.canvasUserId === canvasUserId);
    if (!user || this.opts.history.forFolder(user.folder).last === 0) return false;
    this.recordActivity(user.folder, input);
    return true;
  }

  /** The student's activity list, newest first: `limit` of them (1 to 100), those before the line `before` when it is given. */
  private showActivity(res: http.ServerResponse, user: PortalUser, url: URL): void {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 100);
    const before = parseInt(url.searchParams.get('before') || '', 10);
    this.json(res, 200, this.opts.history.forFolder(user.folder).activities(limit, Number.isFinite(before) && before > 0 ? before : undefined));
  }

  /**
   * The student's thumb on one of TAi's replies, or taking it back (an empty `rating`): a line in the history, so a reload and a second tab
   * see it, a client that is polling gets it like anything else, and the humanness report can count it. A thumb down may say what was wrong
   * (`tag`). It is not a message: no agent run starts, and TAi hears of it with the student's next message. `to` is a text message, a
   * picture or a voice call's summary of TAi's in this student's own history; one thumb for a message, a new one takes the old one's
   * place, and setting what is already there changes nothing.
   */
  private async studentRates(req: http.IncomingMessage, res: http.ServerResponse, user: PortalUser): Promise<void> {
    const request = feedbackRequest(await this.readJson(req));
    if (!request) return this.json(res, 400, { error: 'bad-request' });
    if (!this.feedbackLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    const history = this.opts.history.forFolder(user.folder);
    const target = history.get(request.to);
    const rateable = !target?.kind || target.kind === 'text' || target.kind === 'image' || target.kind === 'voice' || (target.kind === 'activity' && isCallType(target.type));
    if (!target || target.role !== 'assistant' || !rateable) return this.json(res, 404, { error: 'not-found' });
    const now = history.feedbackOn(request.to);
    if (now.rating === request.rating && (now.tag ?? '') === (request.tag ?? '')) return this.json(res, 200, { ok: true, changed: false });
    const entry = history.append('user', '', new Date(this.now()), { kind: 'feedback', to: request.to, rating: request.rating, tag: request.tag });
    this.wake(user.folder);
    this.json(res, 200, { ok: true, changed: true, n: entry.n });
  }

  /** What TAi remembers of this student: the notes it kept, and where they stand in words (src/portal/memory-view.ts). */
  private showMemory(res: http.ServerResponse, user: PortalUser, memory: PortalMemory): void {
    if (!this.readLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    this.json(res, 200, memory.view(user.folder));
  }

  /** The student takes one of TAi's notes about them back: only one of theirs (the folder is the session's), only by the id the panel was given. */
  private async forgetNote(req: http.IncomingMessage, res: http.ServerResponse, user: PortalUser, memory: PortalMemory): Promise<void> {
    const body = await this.readJson(req);
    const id = typeof body.id === 'string' && MEMORY_ID.test(body.id) ? body.id : '';
    if (!id) return this.json(res, 400, { error: 'bad-request' });
    if (!this.forgetLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    if (!memory.forget(user.folder, id)) return this.json(res, 404, { error: 'not-found' });
    this.log.info({ folder: user.folder }, 'portal: a student took a note of TAi\'s back');
    this.json(res, 200, { ok: true });
  }

  private historyOf(res: http.ServerResponse, user: PortalUser, url: URL): void {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 200);
    const history = this.opts.history.forFolder(user.folder);
    this.json(res, 200, { entries: history.tail(limit), last: history.last, typing: this.opts.core.isTyping(user.jid) });
  }

  private async poll(req: http.IncomingMessage, res: http.ServerResponse, user: PortalUser, url: URL): Promise<void> {
    const after = Math.max(parseInt(url.searchParams.get('after') || '0', 10) || 0, 0);
    const wait = Math.min(Math.max(parseInt(url.searchParams.get('wait') || '0', 10) || 0, 0), MAX_WAIT_SECONDS);
    const student = this.student(user.folder);
    const history = this.opts.history.forFolder(user.folder);
    let entries: HistoryEntry[] = history.since(after);
    let typing = this.opts.core.isTyping(user.jid);
    // `sv` is the status version the page has seen: when the status has changed since, there is something to tell and the poll does not wait
    const seenVersion = parseInt(url.searchParams.get('sv') ?? '', 10);
    const statusMoved = Number.isInteger(seenVersion) && seenVersion !== student.statusVersion;
    if (entries.length === 0 && wait > 0 && !statusMoved) {
      if (student.polling >= MAX_POLLS_PER_STUDENT) return this.json(res, 429, { error: 'rate-limited' });
      student.polling++;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          student.waiters.delete(done);
          req.off('close', done);
          resolve();
        };
        const timer = setTimeout(done, wait * 1000);
        student.waiters.add(done);
        req.on('close', done);
      }).finally(() => {
        student.polling--;
      });
      if (res.destroyed || req.destroyed) return;
      entries = history.since(after);
      typing = this.opts.core.isTyping(user.jid);
    }
    const status = this.statusOf(user.jid);
    this.json(res, 200, { entries, last: history.last, typing, ...(status ? { status } : {}), sv: student.statusVersion });
  }

  /**
   * The student taps one of the options TAi offered (src/choices.ts): their message is the letter and the option, as if they had typed it,
   * and TAi gets it with a note of which option it was and, when TAi marked an answer, whether it was that one. The host grades, so the
   * answer never goes to the page and TAi need not remember its own question. Only the options of the last thing said can be tapped, and
   * only once; a tap is a message, so it is held to the same allowance, and when TAi cannot be reached nothing is recorded and the student
   * can tap again.
   */
  private async studentChooses(req: http.IncomingMessage, res: http.ServerResponse, user: PortalUser): Promise<void> {
    const body = await this.readJson(req);
    const to = body.to;
    const index = body.index;
    if (!this.choicesOn) return this.json(res, 404, { error: 'not-found' });
    if (typeof to !== 'number' || typeof index !== 'number' || !Number.isInteger(to) || !Number.isInteger(index) || to < 1 || index < 0) return this.json(res, 400, { error: 'bad-request' });
    const history = this.opts.history.forFolder(user.folder);
    const line = history.get(to);
    const tap = line && line.role === 'assistant' ? tapOn(line, index) : null;
    if (!tap) return this.json(res, 404, { error: 'not-found' });
    const state = history.choiceState(to);
    if (state !== 'open') return this.json(res, 409, { error: state });
    if (!this.sendLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    const jid = this.opts.core.ensureStudent(user);
    const messageId = randomUUID();
    this.cancelReactionReply(user.folder);                // their tap carries the emoji they put on TAi's messages
    const noted = studentNotes(history);                  // read before the tap is added: it is what the student did since their last message
    const voice = this.opts.voice;
    const intoCall = !!voice?.isActive(user.folder) && voice.inject(user.folder, tap.text);
    if (!intoCall) {
      const sent = this.opts.core.submit(jid, noted + tap.note + tap.text, user.name, messageId);
      if (!sent.ok) {
        this.log.warn({ folder: user.folder, status: sent.status }, 'portal could not hand a tap on an option to TAi');
        return this.json(res, 502, { error: 'unavailable' });
      }
    }
    const entry = history.append('user', tap.text, new Date(this.now()), {
      id: messageId,
      choice: { to, index, ...(tap.correct !== undefined ? { correct: tap.correct } : {}) },
    });
    this.wake(user.folder);
    this.json(res, 200, { ok: true, n: entry.n, ...(tap.correct !== undefined ? { correct: tap.correct } : {}) });
  }

  private async send(req: http.IncomingMessage, res: http.ServerResponse, user: PortalUser): Promise<void> {
    const body = await this.readJson(req);
    const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n').trim() : '';
    const named = Array.isArray(body.files) ? body.files : [];
    const ids = named.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{24}$/.test(x));
    if (ids.length !== named.length || ids.length > 5 || (body.files !== undefined && !Array.isArray(body.files))) return this.json(res, 400, { error: 'bad-request' });
    if (!text && ids.length === 0) return this.json(res, 400, { error: 'bad-request' });
    if (text.length > this.maxChars) return this.json(res, 413, { error: 'too-large', max: this.maxChars });
    if (!this.sendLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });
    const uploads = this.opts.uploads;
    const files = ids.length ? uploads?.take(user.folder, ids) ?? null : [];
    if (!files) return this.json(res, 400, { error: 'bad-files' });
    const inAdmin = user.folder === ADMIN_FOLDER;
    if (inAdmin && ids.length) return this.json(res, 400, { error: 'bad-request' });
    const jid = inAdmin ? (this.opts.core.ensureAdmin as () => string)() : this.opts.core.ensureStudent(user);
    const messageId = randomUUID();
    const history = this.opts.history.forFolder(user.folder);
    this.cancelReactionReply(user.folder);              // their words carry the emoji they put on TAi's messages: no answer of its own
    const noted = studentNotes(history);                // read before this message is added: it is what the student did since their last one
    const entry = history.append('user', text, new Date(this.now()), {
      id: messageId,
      files: files.length ? files.map(entryFile) : undefined,
    });
    // what they typed, with any line that opens like one of the host's own notes ("[The student answered your multiple-choice question ...") made plain: the
    // notes the host adds itself (their taps, emoji, voice notes, the attachments below) are the only ones that may open that way. Their bubble keeps what they wrote.
    const typed = neutralHostLines(text);
    const toAgent = uploads ? uploads.messageFor(typed, files) : typed;
    // a voice call is on: what is typed goes into the call, and the text agent stays out of it (the call has the floor). The call has no tool that
    // reads a picture, so it is told of one in the words it always was ("you cannot see pictures"); the text agent, if the call cannot take it, gets toAgent.
    const voice = this.opts.voice;
    if (voice?.isActive(user.folder) && voice.inject(user.folder, uploads ? uploads.messageFor(typed, files, 'call') : typed)) {
      this.wake(user.folder);
      return this.json(res, 200, { ok: true, n: entry.n });
    }
    // The name TAi is told is the allowlist's, not Google's display name: that one is the student's to choose and would reach the prompt.
    // The student's emoji and thumbs on TAi's earlier messages go ahead of their words, for TAi only (never into the student's bubble or the call).
    const sent = this.opts.core.submit(jid, noted + toAgent, user.name, messageId);
    this.wake(user.folder);
    if (!sent.ok) {
      this.log.warn({ folder: user.folder, status: sent.status }, 'portal could not hand a message to TAi');
      return this.json(res, 502, { error: 'unavailable' });
    }
    this.json(res, 200, { ok: true, n: entry.n });
  }
}

function contentTag(body: Buffer): string {
  // a cheap content tag for If-None-Match; not a security boundary
  let h = 2166136261;
  for (const byte of body) h = Math.imul(h ^ byte, 16777619) >>> 0;
  return `${body.length.toString(16)}-${h.toString(16)}`;
}
