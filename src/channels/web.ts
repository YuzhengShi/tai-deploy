/**
 * Web channel: a student's chat over HTTP instead of WhatsApp.
 *
 * A chat is the jid "web:<id>". Inbound messages go through the same storeMessage path as WhatsApp's, so the router, the debounce,
 * the piping into a warm container and the cursors behave identically; outbound texts (and reactions, images, voice notes) are
 * captured in an outbox that a page or a test reads with a long poll.
 *
 * The HTTP API here is for driving the real orchestrator in the evaluation (eval/) and for checks from the host. It has NO authentication
 * and binds to 127.0.0.1 by default: never expose it, and never proxy it. The student page (src/portal) is the front that faces the
 * network: it signs students in, works out which chat is theirs, and calls submit() / onOutbound() / isTyping() below in the same process.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';

import { Choice, ParsedChoices, parseChoices, shuffleQuiz } from '../choices.js';
import { Solver, checkKey, makeSolvers } from '../choices-check.js';
import { ASSISTANT_NAME, REPLY_RULE, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { SourceNotes, type SourceChip } from '../sources.js';
import { PreviewTurn } from '../stream-preview.js';
import { portalStreamOn, type ChatStatus, type MessageExtras, type TextEvent, type TurnView } from '../turn-status.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export const WEB_JID_PREFIX = 'web:';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WAIT_SECONDS = 60;
// The outbox is memory: the last entries are enough for a long poll, and the page (src/portal) keeps its own history per student.
const MAX_OUTBOX_ENTRIES = 2000;

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Register a chat as a student group (index.ts's registerGroup: folder, identity binding, bootstrap seeding). */
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  /** Keeps the pictures TAi sends (the student page's media store); without it only their size is recorded, as the evaluation's chats need. */
  media?: { save(folder: string, buf: Buffer): { id: string; mime: string } | null };
  /** The independent solvers that check the answer TAi marked on a quick check; absent: the ones TAI_CHOICES_CHECK_MODELS names on the gateway (none without its key). */
  solvers?: Solver[];
  /**
   * Where a student's message stands when it waits for a container (the queue's own answer, GroupQueue.queuePosition), read when the page asks:
   * the status is "queued" with that many ahead for as long as it says so, and never a number the queue did not give.
   */
  queuePosition?: (jid: string) => { ahead: number } | null;
  port?: number;
  host?: string;
}

export interface OutboxEntry {
  seq: number;
  ts: string;
  jid: string;
  kind: 'text' | 'reaction' | 'image' | 'audio' | 'typing' | 'status';
  text?: string;
  messageId?: string;
  emoji?: string;
  caption?: string;
  bytes?: number;
  /** image: the id the media store gave the picture (absent when the bytes were not a picture or nothing keeps them) */
  media?: string;
  typing?: boolean;
  /**
   * text: options the student may tap, whether it is a quick check, and what TAi marked as the answer. `text` is then the words around the
   * options; `secret` is the host's alone (the page's history does not pass it on).
   */
  choices?: Choice[];
  quiz?: boolean;
  /** `doubt`: the answer TAi marked was dropped because independent solvers did not agree with it. */
  secret?: { key?: number; why?: string; doubt?: boolean };
  /** text: what TAi opened to write it ("Looked at": src/sources.ts), as the container reported it; the page's history clips them again. */
  sources?: SourceChip[];
}

export type SubmitResult = { ok: true; id: string; timestamp: string } | { ok: false; status: number; error: string };

export class WebChannel implements Channel {
  name = 'web';
  /** New at every start of the process: `seq` restarts at 0 with it, so a client holding a position must start over when this changes. */
  readonly bootId = randomUUID();

  private opts: WebChannelOpts;
  private server: http.Server | null = null;
  private outbox: OutboxEntry[] = [];
  private seq = 0;
  private waiters: Array<() => void> = [];
  private typingState = new Map<string, boolean>();
  private listeners = new Set<(entry: OutboxEntry) => void>();
  private outboxFile: string;
  /** What each chat's runner last said it is doing (a label from src/turn-status.ts); only meaningful while the chat is typing (getStatus). */
  private statuses = new Map<string, ChatStatus>();
  private sourceNotes = new SourceNotes();
  /**
   * Streaming (TAI_PORTAL_STREAM, docs/STREAMING.md): each typing chat's reply as far as it may be shown. Not the outbox, not the history, not
   * on disk: a preview is a part of the status the page reads while the chat types, and it goes with the first of: the answer, the end of typing,
   * the end of the turn. Empty unless the flag is on.
   */
  private previews = new Map<string, PreviewTurn>();

  /**
   * What the orchestrator tells this channel about a chat's turn, apart from its words: the status the page shows while TAi works, and the chips
   * the answer carries. None of it is in the outbox or on disk (the evaluation reads the outbox, and a status is gone a moment later).
   */
  readonly turn: TurnView = {
    setStatus: (jid, status) => this.setStatus(jid, status),
    refreshStatus: (jid) => this.notifyStatus(jid),
    addSources: (jid, seq, items) => this.sourceNotes.add(jid, seq, items),
    takeSources: (jid) => this.sourceNotes.take(jid),
    resetSources: (jid) => this.sourceNotes.reset(jid),
    beginTurn: (jid) => {
      this.previews.delete(jid);
    },
    previewEvent: (jid, event) => this.previewEvent(jid, event),
    previewClear: (jid) => this.previewClear(jid),
  };

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
    this.outboxFile = path.join(STORE_DIR, 'web-outbox.jsonl');
  }

  async connect(): Promise<void> {
    const port = this.opts.port ?? parseInt(process.env.TAI_WEB_PORT || '8099', 10);
    const host = this.opts.host ?? process.env.TAI_WEB_HOST ?? '127.0.0.1';
    fs.mkdirSync(STORE_DIR, { recursive: true });
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        logger.error({ err }, 'Web channel request failed');
        this.reply(res, 500, { error: 'internal error' });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    logger.info({ host, port }, 'Web channel listening');
  }

  async sendMessage(jid: string, text: string, extras?: MessageExtras): Promise<void> {
    // options a student can tap (src/choices.ts) come out of TAi's words here, for every student's chat; the instructor's admin chat gets TAi's text as it is.
    // The answer TAi marked and its note go in `secret`: the page's history keeps them from the page (src/portal/history.ts)
    let parsed: ParsedChoices & { doubt?: boolean } = jid === `${WEB_JID_PREFIX}main` ? { text } : parseChoices(text, process.env.TAI_CHOICES !== '0');
    if (parsed.choices && parsed.key !== undefined) parsed = await this.vet(parsed);
    this.push({
      jid,
      kind: 'text',
      text: parsed.text,
      ...(parsed.choices
        ? {
            choices: parsed.choices,
            ...(parsed.quiz ? { quiz: true } : {}),
            ...(parsed.key !== undefined || parsed.why || parsed.doubt
              ? { secret: { ...(parsed.key !== undefined ? { key: parsed.key } : {}), ...(parsed.why ? { why: parsed.why } : {}), ...(parsed.doubt ? { doubt: true } : {}) } }
              : {}),
          }
        : {}),
      ...(extras?.sources && extras.sources.length > 0 ? { sources: extras.sources } : {}),
    });
  }

  /**
   * A quick check with an answer marked: the options in a random order (a model marks the second one nearly every time), then a second opinion
   * from models that have not seen the key (src/choices-check.ts). When they disagree the key is dropped and TAi hears of it with the tap.
   */
  private async vet(parsed: ParsedChoices): Promise<ParsedChoices & { doubt?: boolean }> {
    const shuffled = shuffleQuiz(parsed);
    const solvers = this.opts.solvers ?? makeSolvers(process.env);
    const verdict = await checkKey(shuffled, solvers);
    if (verdict === 'doubt') {
      logger.info('A quick check was sent without its answer: the independent solvers did not agree with the one TAi marked');
      const { key: _marked, ...rest } = shuffled;
      return { ...rest, doubt: true };
    }
    if (verdict === 'agree') logger.info('A quick check was sent: the independent solvers agree with the answer TAi marked');
    return shuffled;
  }

  isConnected(): boolean {
    return this.server?.listening === true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WEB_JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // The orchestrator refreshes the indicator every 20 s; record only the changes.
    if (this.typingState.get(jid) === isTyping) return;
    this.typingState.set(jid, isTyping);
    this.statuses.delete(jid);                             // typing starts or stops: what was said about the last stretch of work is not about this one
    this.previews.delete(jid);                             // (and no reply that was being written: the typing entry below wakes the page)
    this.push({ jid, kind: 'typing', typing: isTyping });
  }

  async sendReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    this.push({ jid, kind: 'reaction', messageId, emoji });
  }

  async sendAudioMessage(jid: string, audioBuffer: Buffer): Promise<void> {
    this.push({ jid, kind: 'audio', bytes: audioBuffer.length });
  }

  async sendImageMessage(jid: string, imageBuffer: Buffer, caption?: string): Promise<void> {
    // the picture itself is kept for the page (which serves it to the one student it was sent to); the outbox carries its id, not its bytes
    const folder = jid.startsWith(WEB_JID_PREFIX) ? jid.slice(WEB_JID_PREFIX.length) : '';
    const kept = this.opts.media?.save(folder, imageBuffer);
    this.push({ jid, kind: 'image', bytes: imageBuffer.length, caption, ...(kept ? { media: kept.id } : {}) });
  }

  /**
   * A message from a chat's student, through the same path as the HTTP API's POST /api/message: stored, debounced, piped into a warm
   * container or a new one. The page (src/portal) calls this after it has worked out WHICH chat the signed-in student owns.
   */
  submit(jid: string, text: string, opts: { id?: string; name?: string; sender?: string } = {}): SubmitResult {
    if (!this.ownsJid(jid) || !text) return { ok: false, status: 400, error: 'jid (web:...) and text are required' };
    if (!this.opts.registeredGroups()[jid]) return { ok: false, status: 404, error: `${jid} is not registered` };
    const timestamp = new Date().toISOString();
    const id = opts.id || randomUUID();
    const name = opts.name || opts.sender || jid.slice(WEB_JID_PREFIX.length);
    this.opts.onChatMetadata(jid, timestamp, name, 'web', false);
    this.opts.onMessage(jid, {
      id,
      chat_jid: jid,
      sender: opts.sender || jid,
      sender_name: name,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
    return { ok: true, id, timestamp };
  }

  /** Everything TAi sends out through this channel, as it happens (the page keeps a history per student from it). Returns the way to stop listening. */
  onOutbound(listener: (entry: OutboxEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isTyping(jid: string): boolean {
    return this.typingState.get(jid) === true;
  }

  /**
   * What the page may say TAi is doing for this chat: only while it is typing (a label that outlives the work would be a lie), "queued" with its
   * place when the queue says the message waits (read now, so it is never stale), otherwise what the runner reported, if it has.
   */
  getStatus(jid: string): ChatStatus | undefined {
    if (this.typingState.get(jid) !== true) return undefined;
    const waiting = this.opts.queuePosition?.(jid);
    if (waiting) return { state: 'queued', ahead: waiting.ahead };
    const status = this.statuses.get(jid);
    const partial = this.previews.get(jid)?.shown;
    return status && partial ? { ...status, partial } : status;     // (a status the flag never touched is the very object it always was)
  }

  private setStatus(jid: string, status: ChatStatus | null): void {
    const before = JSON.stringify(this.statuses.get(jid) ?? null);
    if (status) this.statuses.set(jid, status);
    else {
      this.statuses.delete(jid);
      this.previews.delete(jid);                           // the turn is over: nothing of it is shown, and the next one starts clean
    }
    if (JSON.stringify(status) !== before) this.notifyStatus(jid);
  }

  /**
   * The runner's account of the reply it is writing (src/stream-preview.ts decides what of it may be seen). Only for a student's chat that is typing,
   * with the flag on; anything else is ignored, so a line a container should not have written never reaches the page. The page is woken when what
   * may be shown changed. Never logs the words: when a preview is dropped the reason (a word) is at debug level.
   */
  private previewEvent(jid: string, event: TextEvent): void {
    if (!portalStreamOn() || jid === `${WEB_JID_PREFIX}main` || this.typingState.get(jid) !== true) return;
    let turn = this.previews.get(jid);
    if (!turn) {
      turn = new PreviewTurn({ trimClosing: REPLY_RULE });
      this.previews.set(jid, turn);
    }
    const wasDropped = turn.dropped;
    const shown = turn.apply(event);
    if (turn.dropped && !wasDropped) logger.debug({ jid, reason: turn.reason }, 'The reply preview was dropped for this turn');
    if (shown !== undefined) this.notifyStatus(jid);
  }

  /** A model request begins or a tool starts: what was written before it is not the reply. Nothing is told when nothing is shown (the flag off: never). */
  private previewClear(jid: string): void {
    const turn = this.previews.get(jid);
    if (turn && turn.clear() !== undefined) this.notifyStatus(jid);
  }

  /** Tells the listeners (the page's server, which wakes the student's long poll) that the status of a chat changed. Not stored, not numbered. */
  private notifyStatus(jid: string): void {
    const entry: OutboxEntry = { seq: this.seq, ts: new Date().toISOString(), jid, kind: 'status' };
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        logger.warn({ err }, 'Web channel listener failed');
      }
    }
  }

  // ---- internals ----

  private push(entry: Omit<OutboxEntry, 'seq' | 'ts'>): void {
    const full: OutboxEntry = { seq: ++this.seq, ts: new Date().toISOString(), ...entry };
    if (full.kind === 'text' || full.kind === 'image') this.previews.delete(full.jid);      // the answer is here: it takes the preview's place, and the page is woken by it
    this.outbox.push(full);
    if (this.outbox.length > MAX_OUTBOX_ENTRIES) this.outbox.splice(0, this.outbox.length - MAX_OUTBOX_ENTRIES);
    // TAI_WEB_OUTBOX_LOG=0: no second, never-rotated copy of the conversations on disk (the live deployment keeps its history in the page's own store)
    if (process.env.TAI_WEB_OUTBOX_LOG !== '0') {
      try {
        fs.appendFileSync(this.outboxFile, JSON.stringify(full) + '\n');
      } catch {
        /* the file is a convenience for later analysis, not part of delivery */
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch (err) {
        logger.warn({ err }, 'Web channel listener failed');
      }
    }
    const waiting = this.waiters.splice(0);
    for (const wake of waiting) wake();
  }

  private reply(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
  }

  private readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return this.reply(res, 200, { ok: true, channel: this.name, outbox: this.seq, boot: this.bootId });
    }

    if (req.method === 'POST' && url.pathname === '/api/register') {
      const body = await this.readJson(req);
      const jid = String(body.jid || '');
      const folder = String(body.folder || '');
      if (!jid.startsWith(WEB_JID_PREFIX) || !/^[a-zA-Z0-9_-]{1,64}$/.test(folder)) {
        return this.reply(res, 400, { error: `jid must start with ${WEB_JID_PREFIX} and folder must be [a-zA-Z0-9_-]{1,64}` });
      }
      this.opts.registerGroup(jid, {
        name: String(body.name || folder),
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        canvasUserId: body.canvasUserId ? String(body.canvasUserId) : undefined,
        githubUsername: body.githubUsername ? String(body.githubUsername) : undefined,
      });
      return this.reply(res, 200, { ok: true, jid, folder });
    }

    if (req.method === 'POST' && url.pathname === '/api/message') {
      const body = await this.readJson(req);
      const sent = this.submit(String(body.jid || ''), String(body.text || ''), {
        id: body.id ? String(body.id) : undefined,
        name: body.name ? String(body.name) : undefined,
        sender: body.sender ? String(body.sender) : undefined,
      });
      if (!sent.ok) return this.reply(res, sent.status, { error: sent.error });
      return this.reply(res, 200, { ok: true, id: sent.id, timestamp: sent.timestamp });
    }

    if (req.method === 'GET' && url.pathname === '/api/outbox') {
      const jid = url.searchParams.get('jid') || '';
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const wait = Math.min(parseInt(url.searchParams.get('wait') || '0', 10) || 0, MAX_WAIT_SECONDS);
      const pick = () => this.outbox.filter((e) => e.seq > after && (!jid || e.jid === jid));
      let entries = pick();
      if (entries.length === 0 && wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait * 1000);
          this.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        entries = pick();
      }
      return this.reply(res, 200, { entries, last: this.seq, boot: this.bootId });
    }

    this.reply(res, 404, { error: 'not found' });
  }
}
