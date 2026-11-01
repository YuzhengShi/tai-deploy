/**
 * Web channel: a student's chat over HTTP instead of WhatsApp.
 *
 * A chat is the jid "web:<id>". Inbound messages go through the same storeMessage path as WhatsApp's, so the router, the debounce,
 * the piping into a warm container and the cursors behave identically; outbound texts (and reactions, images, voice notes) are
 * captured in an outbox that a page or a test reads with a long poll.
 *
 * This is the first cut, used to drive the real orchestrator in the evaluation (eval/). It has NO authentication and binds to
 * 127.0.0.1 by default: put a reverse proxy and real sign-in in front of it before exposing it to anyone.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';

import { ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export const WEB_JID_PREFIX = 'web:';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WAIT_SECONDS = 60;

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Register a chat as a student group (index.ts's registerGroup: folder, identity binding, bootstrap seeding). */
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  port?: number;
  host?: string;
}

export interface OutboxEntry {
  seq: number;
  ts: string;
  jid: string;
  kind: 'text' | 'reaction' | 'image' | 'audio' | 'typing';
  text?: string;
  messageId?: string;
  emoji?: string;
  caption?: string;
  bytes?: number;
  typing?: boolean;
}

export class WebChannel implements Channel {
  name = 'web';

  private opts: WebChannelOpts;
  private server: http.Server | null = null;
  private outbox: OutboxEntry[] = [];
  private seq = 0;
  private waiters: Array<() => void> = [];
  private typingState = new Map<string, boolean>();
  private outboxFile: string;

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

  async sendMessage(jid: string, text: string): Promise<void> {
    this.push({ jid, kind: 'text', text });
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
    this.push({ jid, kind: 'typing', typing: isTyping });
  }

  async sendReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    this.push({ jid, kind: 'reaction', messageId, emoji });
  }

  async sendAudioMessage(jid: string, audioBuffer: Buffer): Promise<void> {
    this.push({ jid, kind: 'audio', bytes: audioBuffer.length });
  }

  async sendImageMessage(jid: string, imageBuffer: Buffer, caption?: string): Promise<void> {
    this.push({ jid, kind: 'image', bytes: imageBuffer.length, caption });
  }

  // ---- internals ----

  private push(entry: Omit<OutboxEntry, 'seq' | 'ts'>): void {
    const full: OutboxEntry = { seq: ++this.seq, ts: new Date().toISOString(), ...entry };
    this.outbox.push(full);
    try {
      fs.appendFileSync(this.outboxFile, JSON.stringify(full) + '\n');
    } catch {
      /* the file is a convenience for later analysis, not part of delivery */
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
      return this.reply(res, 200, { ok: true, channel: this.name, outbox: this.seq });
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
      const jid = String(body.jid || '');
      const text = String(body.text || '');
      if (!this.ownsJid(jid) || !text) return this.reply(res, 400, { error: 'jid (web:...) and text are required' });
      if (!this.opts.registeredGroups()[jid]) return this.reply(res, 404, { error: `${jid} is not registered` });
      const timestamp = new Date().toISOString();
      const id = String(body.id || randomUUID());
      const name = String(body.name || body.sender || jid.slice(WEB_JID_PREFIX.length));
      this.opts.onChatMetadata(jid, timestamp, name, 'web', false);
      this.opts.onMessage(jid, {
        id,
        chat_jid: jid,
        sender: String(body.sender || jid),
        sender_name: name,
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      return this.reply(res, 200, { ok: true, id, timestamp });
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
      return this.reply(res, 200, { entries, last: this.seq });
    }

    this.reply(res, 404, { error: 'not found' });
  }
}
