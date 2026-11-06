/**
 * A small SMTP client (RFC 5321) with node:net and node:tls alone, for the one kind of mail TAi sends: a short plain-text note to a student.
 *
 *   port 465        implicit TLS: the connection is TLS from its first byte
 *   any other port  (587) STARTTLS is REQUIRED: a server that does not offer it, or whose offer is cut out of the EHLO answer by someone in the
 *                   middle, is not talked to any further. Nothing is ever sent, and no AUTH, over an unencrypted connection, and a failed TLS
 *                   handshake or a certificate that does not verify (name, chain, date) ends the attempt: there is no downgrade and no option
 *                   that turns verification off.
 *
 * (The security can also be named in the configuration; the tests need it, their server is on no well-known port.)
 *
 * The dialogue is EHLO, STARTTLS and EHLO again where needed, AUTH PLAIN (or LOGIN) when a user is configured, MAIL FROM, RCPT TO, DATA with
 * dot-stuffing, QUIT; one connection per message; 10 s to connect and 20 s for each answer; one more attempt after a failure that may pass (a
 * connection that failed, a timeout, a 4xx answer) and none after one that will not (a 5xx answer, a refused login, a certificate).
 *
 * What may go into the mail is checked first, before any connection: the recipient and the sender must be plain addresses, and a header value, the
 * subject included, may hold no CR, LF or any other control character (a header injection would let a value add a Bcc: or a body), nor anything
 * outside printable ASCII; the body is plain ASCII text of at most 100 KB. Errors say where it went wrong in a few words; the password never
 * appears in them, in a log or in a reply that is passed on, and the recipient is logged as a hash.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  /** The login; absent: no AUTH (a relay that takes mail from this host without one). With one, the connection is encrypted before it is used. */
  user?: string;
  password?: string;
  /** How the connection is secured: `tls` (TLS from the first byte) or `starttls` (required). Default by the port: 465 is `tls`, any other `starttls`. There is no third kind. */
  security?: 'tls' | 'starttls';
  /** The address mail is sent from: the envelope sender and the From header. */
  from: string;
  /** The name shown beside it; default TAi. */
  fromName?: string;
  /** What EHLO says; default the domain of `from`. */
  ehloName?: string;
  /** Default 10 000. */
  connectTimeoutMs?: number;
  /** Default 20 000, for each answer. */
  commandTimeoutMs?: number;
  /** For tests, whose server has a certificate of its own: authorities to trust besides the system's. Verification itself cannot be switched off. */
  ca?: string | Buffer;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export type SmtpStage = 'invalid' | 'connect' | 'greeting' | 'ehlo' | 'starttls' | 'tls' | 'auth' | 'mail-from' | 'rcpt-to' | 'data' | 'timeout' | 'closed';

export type SmtpResult = { ok: true } | { ok: false; stage: SmtpStage; transient: boolean; detail: string };

/** What the e-mail channel needs of a mailer (a test or the dev server gives it another). */
export interface MailSender {
  send(mail: Mail): Promise<SmtpResult>;
}

export const MAX_MESSAGE_BYTES = 100 * 1024;
const MAX_LINE = 998;
const ADDRESS = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
const TEXT = /^[\x09\x0a\x20-\x7e]*$/;

export class SmtpError extends Error {
  constructor(
    readonly stage: SmtpStage,
    readonly transient: boolean,
    message: string,
  ) {
    super(message);
  }
}

/** An address as it may appear in an SMTP command and a header: one plain address, nothing around it. */
export function validAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && ADDRESS.test(value);
}

/** A header value that cannot start another header or the body: printable ASCII only (no CR, LF, tab or other control character). */
export function validHeaderValue(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && PRINTABLE.test(value);
}

/** What a student's address is called in a log: a short hash, never the address. */
export function addressHash(address: string): string {
  return crypto.createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * The text of the message as it goes over the wire (CRLF lines, dot-stuffed, ending in a line break; the terminating "." line is the caller's).
 * Throws SmtpError('invalid') for anything that may not go in.
 */
export function buildMessage(config: Pick<SmtpConfig, 'from' | 'fromName'>, mail: Mail, now: number, id: string = crypto.randomBytes(12).toString('hex')): string {
  const name = config.fromName ?? 'TAi';
  if (!validAddress(config.from)) throw new SmtpError('invalid', false, 'the sender is not a plain address');
  if (!validAddress(mail.to)) throw new SmtpError('invalid', false, 'the recipient is not a plain address');
  if (!validHeaderValue(name, 60) || /[<>"@,;:\\]/.test(name)) throw new SmtpError('invalid', false, 'the sender\'s name is not plain text');
  if (!validHeaderValue(mail.subject)) throw new SmtpError('invalid', false, 'the subject is not one line of printable ASCII');
  if (typeof mail.text !== 'string' || !TEXT.test(mail.text.replace(/\r\n|\r/g, '\n'))) throw new SmtpError('invalid', false, 'the text is not plain ASCII');
  const domain = config.from.slice(config.from.indexOf('@') + 1);
  const lines = mail.text.replace(/\r\n|\r/g, '\n').split('\n');
  if (lines.some((line) => line.length > MAX_LINE)) throw new SmtpError('invalid', false, 'a line of the text is too long');
  const headers = [
    `From: ${name} <${config.from}>`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    `Date: ${new Date(now).toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=us-ascii',
    'Content-Transfer-Encoding: 7bit',
    'Auto-Submitted: auto-generated',
  ];
  const body = lines.map((line) => (line.startsWith('.') ? `.${line}` : line));
  const message = `${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}${body[body.length - 1] === '' ? '' : '\r\n'}`;
  if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) throw new SmtpError('invalid', false, 'the message is too large');
  return message;
}

interface Reply {
  code: number;
  lines: string[];
}

/**
 * The most one answer of the server may be, however it is cut into lines: real servers send a handful of lines (EHLO is the longest, ten to twenty), so a
 * server that never ends an answer with a last line (a hostile one, or someone in the middle before STARTTLS) must not make us keep lines until the 20 s timeout.
 */
const MAX_REPLY_LINES = 100;
const MAX_REPLY_BYTES = 64 * 1024;
/** Answers nobody has asked for yet: the client sends one command and waits for its answer, so a handful is already a server that is not answering ours. */
const MAX_QUEUED_REPLIES = 4;

/** Reads the server's answers (one or several lines) from a socket, one at a time, each within a time limit. */
class Wire {
  private buffer = '';
  private readonly replies: Reply[] = [];
  private partial: string[] = [];
  private partialBytes = 0;
  private waiter: { resolve: (reply: Reply) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer | string) => {
    if (this.failure) return;                                       // after a failure nothing more is kept: the rest of a flood costs nothing
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    this.parse();
  };
  private readonly onError = (err: Error) => this.fail(err);
  private readonly onClose = () => this.fail(new SmtpError('closed', true, 'the server closed the connection'));

  constructor(
    readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** Lets go of the socket's events (before it is wrapped in TLS). */
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  /** Bytes the server sent that nobody has read: after a STARTTLS "go ahead" there must be none. */
  unread(): boolean {
    return this.buffer.length > 0 || this.replies.length > 0 || this.partial.length > 0;
  }

  private parse(): void {
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      // RFC 5321 4.2.1: `250-text` goes on; `250 text` and a bare `250` (no space, no text) are the last line of an answer
      const match = /^(\d{3})(?:([ -])(.*))?$/.exec(line);
      if (!match) return this.fail(new SmtpError('greeting', true, 'the server said something that is not SMTP'));
      this.partial.push(match[3] ?? '');
      this.partialBytes += line.length + 2;
      if (this.partial.length > MAX_REPLY_LINES || this.partialBytes > MAX_REPLY_BYTES) return this.overflow('an answer from the server is far too long');
      if (match[2] !== '-') {
        if (this.replies.length >= MAX_QUEUED_REPLIES) return this.overflow('the server sends answers nobody asked for');
        this.replies.push({ code: Number(match[1]), lines: this.partial });
        this.partial = [];
        this.partialBytes = 0;
      }
    }
    if (this.buffer.length > 8192) this.fail(new SmtpError('greeting', true, 'a line from the server is far too long'));
    this.settle();
  }

  /** The server sends more than any real one does: all that was held of it is let go (answers not yet read too: the failure must win) and the send fails, with no second try (it will not pass). */
  private overflow(what: string): void {
    this.buffer = '';
    this.partial = [];
    this.partialBytes = 0;
    this.replies.length = 0;
    this.fail(new SmtpError('greeting', false, what));
  }

  private settle(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.replies.length) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(this.replies.shift() as Reply);
    } else if (this.failure) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }

  private fail(err: Error): void {
    this.failure ??= err;
    this.settle();
  }

  reply(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new SmtpError('timeout', true, `no answer from the server in ${Math.round(this.timeoutMs / 1000)} s`));
      }, this.timeoutMs);
      timer.unref?.();
      this.waiter = { resolve, reject, timer };
      this.settle();
    });
  }

  write(data: string): void {
    this.socket.write(data, 'latin1');
  }

  command(line: string): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.reply();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The mailbox of a server's reply text may be the student's own: any address-like word, and every secret of ours, is taken out before it is shown or logged. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 3) out = out.split(secret).join('<hidden>');
  return out.replace(/[^\s<>@]+@[^\s<>]+/g, '<address>').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
}

function capabilities(reply: Reply): { has: Set<string>; auth: Set<string> } {
  const has = new Set<string>();
  const auth = new Set<string>();
  for (const line of reply.lines.slice(1)) {
    const words = line.trim().toUpperCase().split(/\s+/);
    if (words[0] === 'AUTH' || words[0].startsWith('AUTH=')) {
      for (const mechanism of [...(words[0].startsWith('AUTH=') ? [words[0].slice(5)] : []), ...words.slice(1)]) auth.add(mechanism);
    }
    has.add(words[0]);
  }
  return { has, auth };
}

export interface SmtpMailerOptions {
  log?: { warn(obj: object, msg?: string): void };
  /** Wait before the one more attempt (ms). Default 2000. */
  retryDelayMs?: number;
  now?: () => number;
}

export class SmtpMailer implements MailSender {
  private readonly now: () => number;
  private readonly connectMs: number;
  private readonly commandMs: number;

  constructor(
    private readonly config: SmtpConfig,
    private readonly opts: SmtpMailerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.connectMs = config.connectTimeoutMs ?? 10_000;
    this.commandMs = config.commandTimeoutMs ?? 20_000;
  }

  /** Sends one message. Never throws and never leaves a connection open: what happened is the result. */
  async send(mail: Mail): Promise<SmtpResult> {
    const secrets = [this.config.password ?? '', this.config.user ?? '', this.config.from, mail.to];
    let message: string;
    try {
      message = buildMessage(this.config, mail, this.now());
    } catch (err) {
      return this.finish(err instanceof SmtpError ? { ok: false, stage: err.stage, transient: false, detail: err.message } : { ok: false, stage: 'invalid', transient: false, detail: 'the message could not be built' }, mail, secrets);
    }
    let result = await this.attempt(mail, message);
    if (!result.ok && result.transient) {
      await sleep(this.opts.retryDelayMs ?? 2000);
      result = await this.attempt(mail, message);                  // one more, and no more
    }
    return this.finish(result, mail, secrets);
  }

  private finish(result: SmtpResult, mail: Mail, secrets: string[]): SmtpResult {
    if (result.ok) return result;
    const safe: SmtpResult = { ...result, detail: scrub(result.detail, secrets) };
    this.opts.log?.warn({ stage: safe.stage, transient: safe.transient, to: addressHash(mail.to), detail: safe.detail }, 'notify: an e-mail could not be sent');
    return safe;
  }

  private get implicit(): boolean {
    return (this.config.security ?? (this.config.port === 465 ? 'tls' : 'starttls')) === 'tls';
  }

  private connect(): Promise<net.Socket> {
    const { host, port, ca } = this.config;
    const literal = net.isIP(host) !== 0;
    const implicit = this.implicit;
    return new Promise((resolve, reject) => {
      const socket = implicit ? tls.connect({ host, port, ...(literal ? {} : { servername: host }), ...(ca ? { ca } : {}) }) : net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new SmtpError('connect', true, `no connection in ${Math.round(this.connectMs / 1000)} s`));
      }, this.connectMs);
      timer.unref?.();
      socket.once(implicit ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(socket);
      });
      socket.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const certificate = /certificate|self[- ]signed|hostname|altnames|issuer/i.test(err.message) || (err.code ?? '').startsWith('ERR_TLS');
        reject(certificate ? new SmtpError('tls', false, `the server's certificate or TLS did not check out (${err.code ?? 'TLS'})`) : new SmtpError('connect', true, String(err.code ?? 'could not connect')));
      });
    });
  }

  private upgrade(plain: net.Socket): Promise<tls.TLSSocket> {
    const { host, ca } = this.config;
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ socket: plain, ...(net.isIP(host) !== 0 ? {} : { servername: host }), ...(ca ? { ca } : {}) });
      const timer = setTimeout(() => {
        secure.destroy();
        reject(new SmtpError('tls', true, 'the TLS handshake took too long'));
      }, this.connectMs);
      timer.unref?.();
      secure.once('secureConnect', () => {
        clearTimeout(timer);
        secure.removeAllListeners('error');
        resolve(secure);
      });
      secure.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new SmtpError('tls', false, `the server's certificate or TLS did not check out (${err.code ?? 'TLS'})`));
      });
    });
  }

  private async authenticate(wire: Wire, mechanisms: Set<string>): Promise<void> {
    const { user = '', password = '' } = this.config;
    const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64');
    const done = (reply: Reply) => {
      if (reply.code === 235) return;
      throw new SmtpError('auth', reply.code >= 400 && reply.code < 500, `the login was refused (${reply.code})`);
    };
    if (mechanisms.has('PLAIN')) {
      let reply = await wire.command('AUTH PLAIN');
      if (reply.code === 334) reply = await wire.command(b64(`\0${user}\0${password}`));
      return done(reply);
    }
    if (mechanisms.has('LOGIN')) {
      let reply = await wire.command('AUTH LOGIN');
      if (reply.code === 334) reply = await wire.command(b64(user));
      if (reply.code === 334) reply = await wire.command(b64(password));
      return done(reply);
    }
    throw new SmtpError('auth', false, 'the server offers neither AUTH PLAIN nor AUTH LOGIN');
  }

  private async attempt(mail: Mail, message: string): Promise<SmtpResult> {
    const { user, from } = this.config;
    const ehlo = this.config.ehloName ?? from.slice(from.indexOf('@') + 1);
    let wire: Wire | null = null;
    const expect = (reply: Reply, ok: number[], stage: SmtpStage, what: string): Reply => {
      if (ok.includes(reply.code)) return reply;
      throw new SmtpError(stage, reply.code >= 400 && reply.code < 500, `${what} (${reply.code} ${reply.lines[0] ?? ''})`);
    };
    try {
      wire = new Wire(await this.connect(), this.commandMs);
      expect(await wire.reply(), [220], 'greeting', 'the server did not greet us');
      let hello = expect(await wire.command(`EHLO ${ehlo}`), [250], 'ehlo', 'EHLO was refused');
      let caps = capabilities(hello);
      let encrypted = this.implicit;
      if (!encrypted) {
        // never in the clear: a server that does not offer STARTTLS (or whose offer was cut out on the way) is not used, and nothing, no login, is sent
        if (!caps.has.has('STARTTLS')) throw new SmtpError('starttls', false, 'the server does not offer STARTTLS: nothing is sent unencrypted');
        expect(await wire.command('STARTTLS'), [220], 'starttls', 'STARTTLS was refused');
        if (wire.unread()) throw new SmtpError('starttls', false, 'the server sent data before the TLS handshake');
        wire.detach();
        const secure = await this.upgrade(wire.socket);
        wire = new Wire(secure, this.commandMs);
        encrypted = true;
        hello = expect(await wire.command(`EHLO ${ehlo}`), [250], 'ehlo', 'EHLO was refused after STARTTLS');
        caps = capabilities(hello);
      }
      if (user) {
        if (!encrypted) throw new SmtpError('auth', false, 'a login is never sent over an unencrypted connection');
        await this.authenticate(wire, caps.auth);
      }
      expect(await wire.command(`MAIL FROM:<${from}>`), [250], 'mail-from', 'the sender was refused');
      expect(await wire.command(`RCPT TO:<${mail.to}>`), [250, 251], 'rcpt-to', 'the recipient was refused');
      expect(await wire.command('DATA'), [354], 'data', 'DATA was refused');
      wire.write(`${message}.\r\n`);
      expect(await wire.reply(), [250], 'data', 'the message was refused');
      void wire.command('QUIT').catch(() => undefined);
      return { ok: true };
    } catch (err) {
      if (err instanceof SmtpError) return { ok: false, stage: err.stage, transient: err.transient, detail: err.message };
      return { ok: false, stage: 'connect', transient: true, detail: String((err as NodeJS.ErrnoException)?.code ?? 'the connection failed') };
    } finally {
      // the connection lasts one message: closed after QUIT has had a moment to leave
      const socket = wire?.socket;
      if (socket) setTimeout(() => socket.destroy(), 50).unref?.();
    }
  }
}
