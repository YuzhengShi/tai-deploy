/**
 * The SMTP client against a stand-in server on a loopback port that speaks the protocol, with TLS (a certificate made in the test, testing/test-cert.ts):
 * the dialogue as it goes, STARTTLS and AUTH, what is never sent in the clear, dot-stuffing, what may not go into a mail, the retries and the timeouts,
 * and that nothing that is secret or personal gets into an error or a log. Not covered: a real mail server and a real mailbox (docs/NOTIFICATIONS.md).
 */
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_MESSAGE_BYTES, SmtpMailer, addressHash, buildMessage, validAddress, validHeaderValue, type SmtpConfig } from './smtp.js';
import { makeTestCertificate } from './testing/test-cert.js';

const CERT = makeTestCertificate();                         // the server's, and the one the client is told to trust
const STRANGER = makeTestCertificate();                     // a certificate nobody was told to trust
const PASSWORD = 'S3CRET-pass-word';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const PLAIN_CREDENTIALS = b64(`\0tai-login\0${PASSWORD}`);

interface Behaviour {
  greeting?: string;
  /** What EHLO lists before and after TLS (lines after the first). */
  caps?: string[];
  capsAfterTls?: string[];
  starttls?: 'ok' | 'refuse';
  /** Extra bytes in the same segment as the STARTTLS go-ahead: what a man in the middle might add. */
  injectAfterStarttls?: boolean;
  auth?: 'ok' | 'bad';
  mailFrom?: string;
  rcpt?: string | ((connection: number) => string);
  data?: string;
  silent?: boolean;
  /** Greet this many connections with 421 before behaving. */
  busyFor?: number;
}

interface Line {
  text: string;
  secure: boolean;
  connection: number;
}

class FakeSmtp {
  lines: Line[] = [];
  messages: string[] = [];
  connections = 0;
  private server!: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    readonly mode: 'plain' | 'implicit',
    readonly behaviour: Behaviour = {},
    private readonly certificate = CERT,
  ) {}

  async start(): Promise<number> {
    const onConnection = (socket: net.Socket) => {
      this.connections++;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      this.attach(socket, this.mode === 'implicit', this.connections, true);
    };
    this.server = this.mode === 'implicit' ? tls.createServer({ key: this.certificate.key, cert: this.certificate.cert }, onConnection) : net.createServer(onConnection);
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Lines the client sent that start with this (case-insensitively). */
  sent(prefix: string): Line[] {
    return this.lines.filter((l) => l.text.toUpperCase().startsWith(prefix.toUpperCase()));
  }

  private attach(socket: net.Socket, secure: boolean, n: number, greet: boolean): void {
    const b = this.behaviour;
    socket.on('error', () => undefined);
    const say = (text: string) => socket.write(`${text}\r\n`);
    if (greet) {
      if (b.silent) return;
      if (n <= (b.busyFor ?? 0)) {
        say('421 4.3.2 busy, try later');
        socket.end();
        return;
      }
      say(b.greeting ?? '220 fake.example ESMTP ready');
    }
    let buffer = '';
    let inData = false;
    let auth: 'plain' | 'login-user' | 'login-pass' | null = null;
    const authReply = () => say(b.auth === 'bad' ? '535 5.7.8 authentication failed' : '235 2.7.0 accepted');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          this.messages.push(buffer.slice(0, end + 2));
          buffer = buffer.slice(end + 5);
          inData = false;
          say(b.data ?? '250 2.0.0 queued');
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const text = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        this.lines.push({ text, secure, connection: n });
        if (auth === 'plain') { auth = null; authReply(); continue; }
        if (auth === 'login-user') { auth = 'login-pass'; say('334 UGFzc3dvcmQ6'); continue; }
        if (auth === 'login-pass') { auth = null; authReply(); continue; }
        const upper = text.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          const caps = secure ? (b.capsAfterTls ?? ['AUTH PLAIN LOGIN']) : (b.caps ?? ['STARTTLS', 'AUTH PLAIN LOGIN']);
          say(`250${caps.length ? '-' : ' '}fake.example hello`);
          caps.forEach((cap, i) => say(`250${i === caps.length - 1 ? ' ' : '-'}${cap}`));
        } else if (upper === 'STARTTLS') {
          if (b.starttls === 'refuse') { say('454 4.7.0 TLS not available'); continue; }
          socket.write(`220 2.0.0 go ahead\r\n${b.injectAfterStarttls ? '250 INJECTED\r\n' : ''}`);
          socket.removeAllListeners('data');
          const wrapped = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext({ key: this.certificate.key, cert: this.certificate.cert }) });
          this.sockets.add(wrapped);
          this.attach(wrapped, true, n, false);
          return;
        } else if (upper === 'AUTH PLAIN') { auth = 'plain'; say('334 '); }
        else if (upper === 'AUTH LOGIN') { auth = 'login-user'; say('334 VXNlcm5hbWU6'); }
        else if (upper.startsWith('MAIL FROM:')) say(b.mailFrom ?? '250 2.1.0 ok');
        else if (upper.startsWith('RCPT TO:')) say(typeof b.rcpt === 'function' ? b.rcpt(n) : (b.rcpt ?? '250 2.1.5 ok'));
        else if (upper === 'DATA') { inData = true; say('354 end with <CRLF>.<CRLF>'); }
        else if (upper === 'QUIT') { say('221 2.0.0 bye'); socket.end(); return; }
        else say('502 5.5.2 not understood');
      }
    });
  }
}

const MAIL = { to: 'ada@example.com', subject: 'TAi has a message for you', text: 'Hello.\n.hidden line\n..two dots\nlast' };

describe('the SMTP client', () => {
  const servers: FakeSmtp[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
  });

  async function serve(mode: 'plain' | 'implicit', behaviour: Behaviour = {}, certificate = CERT): Promise<{ server: FakeSmtp; port: number }> {
    const server = new FakeSmtp(mode, behaviour, certificate);
    servers.push(server);
    return { server, port: await server.start() };
  }

  const config = (port: number, extra: Partial<SmtpConfig> = {}): SmtpConfig => ({
    host: '127.0.0.1',
    port,
    user: 'tai-login',
    password: PASSWORD,
    from: 'tai@school.example',
    ca: CERT.cert,
    commandTimeoutMs: 3000,
    connectTimeoutMs: 3000,
    ...extra,
  });
  const mailer = (cfg: SmtpConfig, logs: object[] = []) => new SmtpMailer(cfg, { retryDelayMs: 0, log: { warn: (obj) => void logs.push(obj) } });

  describe('the dialogue', () => {
    it('does EHLO, STARTTLS, EHLO again, AUTH PLAIN, MAIL FROM, RCPT TO, DATA and QUIT, with the login only after the TLS handshake', async () => {
      const { server, port } = await serve('plain');
      const result = await mailer(config(port)).send(MAIL);
      expect(result).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.connections).toBe(1);
      expect(server.lines.map((l) => [l.text.split(' ').slice(0, 2).join(' '), l.secure])).toEqual([
        ['EHLO school.example', false],
        ['STARTTLS', false],
        ['EHLO school.example', true],
        ['AUTH PLAIN', true],
        [PLAIN_CREDENTIALS, true],                           // sent over TLS, and decodes to \0user\0password
        ['MAIL FROM:<tai@school.example>', true],
        ['RCPT TO:<ada@example.com>', true],
        ['DATA', true],
        ['QUIT', true],
      ]);
      expect(Buffer.from(PLAIN_CREDENTIALS, 'base64').toString()).toBe(`\0tai-login\0${PASSWORD}`);
      expect(server.lines.filter((l) => !l.secure).map((l) => l.text).join('\n')).not.toContain(PLAIN_CREDENTIALS);
    });

    it('uses AUTH LOGIN when that is all the server offers, over implicit TLS (port 465)', async () => {
      const { server, port } = await serve('implicit', { capsAfterTls: ['AUTH LOGIN'], caps: ['AUTH LOGIN'] });
      const result = await mailer(config(port, { security: 'tls' })).send(MAIL);
      expect(result).toEqual({ ok: true });
      expect(server.lines.slice(0, 4).map((l) => [l.text, l.secure])).toEqual([['EHLO school.example', true], ['AUTH LOGIN', true], [b64('tai-login'), true], [b64(PASSWORD), true]]);
      expect(server.sent('STARTTLS')).toHaveLength(0);
      expect(server.lines.every((l) => l.secure)).toBe(true);
    });

    it('sends no login at all when none is configured (a relay), but is still encrypted first', async () => {
      const { server, port } = await serve('plain');
      expect(await mailer(config(port, { user: undefined, password: undefined })).send(MAIL)).toEqual({ ok: true });
      expect(server.sent('AUTH')).toHaveLength(0);
      expect(server.sent('MAIL FROM')[0].secure).toBe(true);
    });

    it('sends the message with its headers, CRLF lines and dot-stuffing, and the dot that ends it', async () => {
      const { server, port } = await serve('plain');
      await mailer(config(port)).send(MAIL);
      const [message] = server.messages;
      const [head, body] = message.split('\r\n\r\n');
      const headers = head.split('\r\n');
      expect(headers[0]).toBe('From: TAi <tai@school.example>');
      expect(headers).toContain('To: ada@example.com');
      expect(headers).toContain('Subject: TAi has a message for you');
      expect(headers.find((h) => h.startsWith('Date: '))).toMatch(/^Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
      expect(headers.find((h) => h.startsWith('Message-ID: '))).toMatch(/^Message-ID: <[0-9a-f]{24}@school\.example>$/);
      expect(headers).toContain('Content-Type: text/plain; charset=us-ascii');
      expect(headers).toContain('Auto-Submitted: auto-generated');
      expect(headers.filter((h) => /^(bcc|cc|reply-to):/i.test(h))).toEqual([]);
      expect(body).toBe('Hello.\r\n..hidden line\r\n...two dots\r\nlast\r\n');           // each line that began with a dot has one more; the server takes it off
      expect(message).not.toContain('\n.hidden');
    });

    it('opens one connection for each message and says QUIT', async () => {
      const { server, port } = await serve('plain');
      const sender = mailer(config(port));
      await sender.send(MAIL);
      await sender.send({ ...MAIL, to: 'bob@example.com' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.connections).toBe(2);
      expect(server.sent('QUIT')).toHaveLength(2);
      expect(server.sent('RCPT TO').map((l) => l.text)).toEqual(['RCPT TO:<ada@example.com>', 'RCPT TO:<bob@example.com>']);
    });
  });

  describe('never in the clear, and no downgrade', () => {
    it('does not talk on to a server that does not offer STARTTLS, and sends no login, even one that offers AUTH before the handshake', async () => {
      const { server, port } = await serve('plain', { caps: ['AUTH PLAIN LOGIN'] });
      const result = await mailer(config(port)).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'starttls', transient: false });
      expect(server.sent('AUTH')).toHaveLength(0);
      expect(server.sent('MAIL')).toHaveLength(0);
      expect(server.lines.map((l) => l.text).join('\n')).not.toContain(PLAIN_CREDENTIALS);
      expect(server.connections).toBe(1);                                  // refusing is not a failure that may pass: no second try
    });

    it('stops when the server refuses STARTTLS, and when it sends something before the handshake', async () => {
      const refused = await serve('plain', { starttls: 'refuse' });
      expect(await mailer(config(refused.port)).send(MAIL)).toMatchObject({ ok: false, stage: 'starttls' });
      expect(refused.server.sent('AUTH')).toHaveLength(0);
      const injected = await serve('plain', { injectAfterStarttls: true });
      expect(await mailer(config(injected.port)).send(MAIL)).toMatchObject({ ok: false, stage: 'starttls', transient: false });
      expect(injected.server.sent('AUTH')).toHaveLength(0);
      expect(injected.server.sent('MAIL')).toHaveLength(0);
    });

    it('stops when the certificate is not one it was told to trust, and when it is for another name: there is no way to carry on', async () => {
      const untrusted = await serve('plain', {}, STRANGER);
      const result = await mailer(config(untrusted.port)).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'tls', transient: false });
      expect(untrusted.server.sent('AUTH')).toHaveLength(0);
      expect(untrusted.server.sent('MAIL')).toHaveLength(0);
      expect(untrusted.server.connections).toBe(1);
      const implicit = await serve('implicit', {}, STRANGER);
      expect(await mailer(config(implicit.port, { security: 'tls' })).send(MAIL)).toMatchObject({ ok: false, stage: 'tls' });
      expect(implicit.server.lines).toHaveLength(0);
      const elsewhere = makeTestCertificate({ dns: ['other.example'], ips: ['10.9.8.7'] });
      const wrongName = await serve('plain', {}, elsewhere);
      expect(await mailer(config(wrongName.port, { ca: elsewhere.cert })).send(MAIL)).toMatchObject({ ok: false, stage: 'tls' });
      expect(wrongName.server.sent('MAIL')).toHaveLength(0);
    });

    it('does not offer a login to a server that has no mechanism it knows, and says so', async () => {
      const { server, port } = await serve('plain', { capsAfterTls: [] });
      expect(await mailer(config(port)).send(MAIL)).toMatchObject({ ok: false, stage: 'auth', transient: false });
      expect(server.sent('MAIL')).toHaveLength(0);
    });
  });

  describe('what goes wrong, and how it is told', () => {
    it('does not try again after a refused login, keeps the password out of the answer and the log, and logs the recipient as a hash', async () => {
      const { server, port } = await serve('plain', { auth: 'bad' });
      const logs: object[] = [];
      const result = await mailer(config(port), logs).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'auth', transient: false });
      expect(server.connections).toBe(1);
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ stage: 'auth', transient: false, to: addressHash('ada@example.com') });
      const text = JSON.stringify(logs);
      for (const secret of [PASSWORD, 'ada@example.com', 'tai-login', PLAIN_CREDENTIALS]) expect(text).not.toContain(secret);
      expect(addressHash('ada@example.com')).toMatch(/^[0-9a-f]{16}$/);
      expect(addressHash(' ADA@example.com ')).toBe(addressHash('ada@example.com'));
    });

    it('tries once more after a failure that may pass (a 421 at the greeting, a 451 for the recipient) and never a third time', async () => {
      const busy = await serve('plain', { busyFor: 1 });
      expect(await mailer(config(busy.port)).send(MAIL)).toEqual({ ok: true });
      expect(busy.server.connections).toBe(2);
      const later = await serve('plain', { rcpt: '451 4.3.0 try again later' });
      const result = await mailer(config(later.port)).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'rcpt-to', transient: true });
      expect(later.server.connections).toBe(2);
      const flaky = await serve('plain', { rcpt: (connection) => (connection === 1 ? '451 4.3.0 try again' : '250 ok') });
      expect(await mailer(config(flaky.port)).send(MAIL)).toEqual({ ok: true });
      expect(flaky.server.connections).toBe(2);
    });

    it('does not try again after a refusal that will not pass (a 550), and the server\'s words never carry the recipient into the answer or the log', async () => {
      const { server, port } = await serve('plain', { rcpt: '550 5.1.1 <ada@example.com>: Recipient address rejected: ada@example.com unknown' });
      const logs: object[] = [];
      const result = await mailer(config(port), logs).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'rcpt-to', transient: false });
      expect(server.connections).toBe(1);
      expect(JSON.stringify(result)).not.toContain('ada@example.com');
      expect(JSON.stringify(logs)).not.toContain('ada@example.com');
      expect(JSON.stringify(logs)).toContain(addressHash('ada@example.com'));
      expect((result as { detail: string }).detail).toContain('550');
    });

    it('gives up on a server that says nothing, after the time it was given and one more try', async () => {
      const { server, port } = await serve('plain', { silent: true });
      const started = Date.now();
      const result = await mailer(config(port, { commandTimeoutMs: 150 })).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'timeout', transient: true });
      expect(server.connections).toBe(2);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it('reports a server that is not there', async () => {
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const result = await mailer(config(port)).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'connect', transient: true });
    });

    it('reports a refused message (a 554 after DATA) and a refused sender', async () => {
      const data = await serve('plain', { data: '554 5.6.0 message refused' });
      expect(await mailer(config(data.port)).send(MAIL)).toMatchObject({ ok: false, stage: 'data', transient: false });
      const sender = await serve('plain', { mailFrom: '553 5.7.1 sender not allowed' });
      expect(await mailer(config(sender.port)).send(MAIL)).toMatchObject({ ok: false, stage: 'mail-from', transient: false });
    });
  });

  describe('what a server may send', () => {
    const junk = (count: number, width = 12) => Array.from({ length: count }, (_, i) => `X-EXT${i}`.padEnd(width, 'x'));

    it('is an answer of one line or several, and the last line may be a bare code (RFC 5321 4.2.1: no space, no text)', async () => {
      const bare = await serve('plain', { greeting: '220', mailFrom: '250', rcpt: '250', data: '250' });
      expect(await mailer(config(bare.port)).send(MAIL)).toEqual({ ok: true });
      expect(bare.server.messages).toHaveLength(1);
      const long = await serve('plain', { caps: ['STARTTLS', 'AUTH PLAIN LOGIN', ...junk(40)] });          // a real EHLO list is ten to twenty lines
      expect(await mailer(config(long.port)).send(MAIL)).toEqual({ ok: true });
    });

    it('is cut off at 100 lines to an answer: a server that goes on and on is a failed send at once, not a wait until the answer times out', async () => {
      const { server, port } = await serve('plain', { caps: ['STARTTLS', 'AUTH PLAIN LOGIN', ...junk(150)] });
      const started = Date.now();
      const result = await mailer(config(port)).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'greeting', transient: false });
      expect((result as { detail: string }).detail).toMatch(/far too long/);
      expect(server.connections).toBe(1);                                  // it will not pass: no second try
      expect(server.sent('STARTTLS')).toHaveLength(0);                     // and nothing more is said to it
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('is cut off at 64 KB to an answer, however few lines it takes', async () => {
      const { server, port } = await serve('plain', { caps: ['STARTTLS', ...junk(20, 4000)] });
      const result = await mailer(config(port)).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'greeting', transient: false });
      expect(server.connections).toBe(1);
      expect(server.sent('MAIL')).toHaveLength(0);
    });

    it('does not keep a flood of answers that nobody asked for (one line each, so no single answer is long)', async () => {
      const { server, port } = await serve('plain', { greeting: `220 ok\r\n${'250 x\r\n'.repeat(500)}`.trimEnd() });
      const result = await mailer(config(port)).send(MAIL);
      expect(result).toMatchObject({ ok: false, stage: 'greeting', transient: false });
      expect((result as { detail: string }).detail).toMatch(/nobody asked/);
      expect(server.connections).toBe(1);
      expect(server.sent('EHLO')).toHaveLength(0);                         // it did not get as far as a dialogue with what was queued
    });
  });

  describe('what may go into a mail', () => {
    it('is checked before any connection: no CR, LF or other control character in a header value, one plain address each way', async () => {
      const { server, port } = await serve('plain');
      const sender = mailer(config(port));
      const bad: Array<[string, Partial<typeof MAIL>]> = [
        ['a CR LF and a Bcc in the subject', { subject: 'Hi\r\nBcc: evil@example.com' }],
        ['a LF in the subject', { subject: 'Hi\nBcc: evil@example.com' }],
        ['a CR in the subject', { subject: 'Hi\rBcc: evil@example.com' }],
        ['a NUL in the subject', { subject: 'Hi\u0000' }],
        ['a tab in the subject', { subject: 'Hi\tthere' }],
        ['a line separator in the subject', { subject: 'Hi there' }],
        ['non-ASCII in the subject', { subject: 'Héllo' }],
        ['an empty subject', { subject: '' }],
        ['a subject that is too long', { subject: 'x'.repeat(201) }],
        ['a recipient with a second command in it', { to: 'ada@example.com>\r\nRCPT TO:<evil@example.com' }],
        ['a recipient with a header in it', { to: 'ada@example.com\r\nBcc: evil@example.com' }],
        ['a recipient with a LF', { to: 'ada@example.com\n' }],
        ['two recipients', { to: 'ada@example.com, evil@example.com' }],
        ['a recipient in angle brackets', { to: '<ada@example.com>' }],
        ['a recipient with a space', { to: ' ada@example.com' }],
        ['a recipient with a display name', { to: 'Ada <ada@example.com>' }],
        ['a recipient without a domain suffix', { to: 'ada@example' }],
        ['an empty recipient', { to: '' }],
        ['a text with a NUL', { text: 'a\u0000b' }],
        ['a text with non-ASCII', { text: 'café' }],
        ['a text with a line that is too long', { text: 'x'.repeat(1000) }],
        ['a text that is too large', { text: `${'x'.repeat(900)}\n`.repeat(120) }],
      ];
      for (const [name, change] of bad) {
        const result = await sender.send({ ...MAIL, ...change });
        expect(result, name).toMatchObject({ ok: false, stage: 'invalid', transient: false });
      }
      expect(server.connections).toBe(0);                                    // none of them reached the network
    });

    it('is checked for the sender too: an address, a name that is plain text', async () => {
      const { server, port } = await serve('plain');
      for (const change of [{ from: 'tai@school.example\r\nRCPT TO:<evil@example.com>' }, { from: 'not an address' }, { from: '' }, { fromName: 'TAi\r\nBcc: evil@example.com' }, { fromName: 'TAi <evil@example.com>' }, { fromName: '' }]) {
        expect(await mailer(config(port, change)).send(MAIL), JSON.stringify(change)).toMatchObject({ ok: false, stage: 'invalid' });
      }
      expect(server.connections).toBe(0);
    });

    it('knows a plain address, and a header value that cannot start another header', () => {
      for (const good of ['ada@example.com', 'a.b+c@sub.example.co.uk', "o'brien@example.com", 'x_y%z@e-x.org']) expect(validAddress(good), good).toBe(true);
      for (const bad of ['', 'ada', 'ada@', '@example.com', 'ada@example', 'ada@example..com', 'ada@-example.com', 'a b@example.com', 'ada@example.com ', `${'a'.repeat(65)}@example.com`, null, 5]) expect(validAddress(bad), String(bad)).toBe(false);
      expect(validHeaderValue('TAi has a message for you')).toBe(true);
      for (const bad of ['', 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb', 'héllo', 'x'.repeat(201), 5]) expect(validHeaderValue(bad), String(bad)).toBe(false);
    });

    it('builds the message with its dots doubled, CRLF line ends and nothing after the last line but its break', () => {
      const text = buildMessage({ from: 'tai@school.example' }, MAIL, Date.parse('2026-11-05T12:00:00Z'), 'abc123');
      expect(text.startsWith('From: TAi <tai@school.example>\r\nTo: ada@example.com\r\nSubject: TAi has a message for you\r\nDate: Thu, 05 Nov 2026 12:00:00 +0000\r\nMessage-ID: <abc123@school.example>\r\n')).toBe(true);
      expect(text.endsWith('\r\nlast\r\n')).toBe(true);
      expect(text.split('\r\n\r\n')[1]).toBe('Hello.\r\n..hidden line\r\n...two dots\r\nlast\r\n');
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      expect(buildMessage({ from: 'tai@school.example' }, { ...MAIL, text: 'one\ntwo\n' }, 0, 'x').endsWith('\r\n\r\none\r\ntwo\r\n')).toBe(true);
      expect(buildMessage({ from: 'tai@school.example' }, { ...MAIL, text: '.' }, 0, 'x').endsWith('\r\n\r\n..\r\n')).toBe(true);
      expect(MAX_MESSAGE_BYTES).toBe(102_400);
    });
  });
});
