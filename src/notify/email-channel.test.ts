/**
 * The e-mail channel: to whom, what it says, and when (an hour unseen, one a day, not for what was pushed or looked at), with a fake mail server
 * (a recording sender), a fake clock and a fake page probe. The dialogue with a real SMTP server is smtp.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Prefs } from '../portal/prefs.js';
import { DEFAULT_EMAIL_RULES } from './core.js';
import { EMAIL_SUBJECT, EmailChannel, emailBody } from './email-channel.js';
import { buildMessage, type Mail, type SmtpResult } from './smtp.js';

const ADA = 's_' + 'a1'.repeat(10);
const BOB = 's_' + 'b2'.repeat(10);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const t0 = Date.parse('2026-11-05T18:00:00Z');                  // 10:00 in Los Angeles
const URL = 'https://cs6650.example/tai/';

const prefsWith = (enabled: boolean, extra: Record<string, unknown> = {}): Prefs => ({ notify: { push: [], email: { enabled, ...extra } } }) as Prefs;

function setup(options: { prefs?: Record<string, Prefs>; lastVisible?: Record<string, number>; result?: () => SmtpResult | Promise<SmtpResult>; recipients?: Record<string, string> } = {}) {
  const sent: Mail[] = [];
  const logs: Array<{ level: string; obj: object; msg?: string }> = [];
  const prefs: Record<string, Prefs> = options.prefs ?? { [ADA]: prefsWith(true), [BOB]: prefsWith(true) };
  const visible: Record<string, number> = options.lastVisible ?? {};
  const recipients: Record<string, string> = options.recipients ?? { [ADA]: 'ada@example.com', [BOB]: 'bob@example.com' };
  const log = (level: string) => (obj: object, msg?: string) => void logs.push({ level, obj, msg });
  const mailer = {
    send: vi.fn(async (mail: Mail) => {
      sent.push(mail);
      return options.result ? options.result() : ({ ok: true } as SmtpResult);
    }),
  };
  const channel = new EmailChannel({
    mailer,
    recipientOf: (folder) => recipients[folder],
    prefs: { read: (folder) => prefs[folder] ?? prefsWith(false) },
    page: { lastVisibleAt: (folder) => visible[folder] ?? 0 },
    pageUrl: URL,
    defaultTz: 'America/Los_Angeles',
    log: { debug: log('debug'), info: log('info'), warn: log('warn') },
  });
  return { channel, mailer, sent, logs, prefs, visible, recipients };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the e-mail channel', () => {
  it('is wanted by a student who switched it on, and by nobody else', () => {
    const { channel } = setup();
    expect(channel.name).toBe('email');
    expect(channel.mode).toBe('own');
    expect(channel.wants(prefsWith(true))).toBe(true);
    expect(channel.wants(prefsWith(false))).toBe(false);
    expect(channel.wants({ notify: { push: [], email: { enabled: 'yes' as unknown as boolean } } })).toBe(false);
  });

  it('is never given a message by the push rules: its own deliver sends nothing', async () => {
    const { channel, sent } = setup();
    expect(await channel.deliver()).toEqual({ delivered: 0 });
    expect(sent).toEqual([]);
  });

  describe('what it says', () => {
    it('is the same note for everyone, with the page\'s address and how to stop, and no word of any message', async () => {
      const { channel, sent } = setup();
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe('TAi has a message for you');
      expect(EMAIL_SUBJECT).toBe('TAi has a message for you');
      expect(sent[0].text).toBe(emailBody(URL));
      expect(sent[0].text).toContain(URL);
      expect(sent[0].text).toMatch(/turn "Email me when I miss a message" off/);
      expect(sent[0].text).toMatch(/Settings/);
      expect(sent[0].text).not.toMatch(/Ada|Bob|ada@|bob@|HW\d|grade|due/i);                        // nothing personal, nothing about the course's work
      expect(sent[0].text).not.toMatch(/https?:\/\/[^\s]*\?/);                                       // no query: no tracking
      expect(sent[0].text.match(/https?:\/\//g)).toHaveLength(1);                                    // one link, the page
      expect(sent[0].text.length).toBeLessThan(500);
    });

    it('is a mail the SMTP client accepts: plain ASCII, short lines, no header it could be tricked into', () => {
      const text = buildMessage({ from: 'tai@school.example' }, { to: 'ada@example.com', subject: EMAIL_SUBJECT, text: emailBody(URL) }, t0);
      expect(text).toContain('Subject: TAi has a message for you');
      expect(text.split('\r\n').every((line) => line.length <= 998)).toBe(true);
      expect(emailBody(URL)).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    });
  });

  describe('to whom', () => {
    it('is the address the student signed in with, from the list of students, whatever the preferences say', async () => {
      const { channel, sent } = setup({ prefs: { [ADA]: prefsWith(true, { address: 'evil@example.com', to: 'evil@example.com' }), [BOB]: prefsWith(true) } });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.noticed({ folder: BOB, id: 'b:2', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent.map((m) => m.to).sort()).toEqual(['ada@example.com', 'bob@example.com']);
      expect(JSON.stringify(sent)).not.toContain('evil@example.com');
    });

    it('is nobody when the student is not on the list, and nothing is sent', async () => {
      const { channel, sent } = setup({ recipients: {} });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toEqual([]);
      expect(channel.heldCount()).toBe(0);
    });
  });

  describe('when', () => {
    it('is an hour after the message, not before', async () => {
      const { channel, sent } = setup();
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR - 1);
      await settle();
      expect(sent).toHaveLength(0);
      expect(channel.heldCount()).toBe(1);                                  // still held
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toHaveLength(1);
      expect(channel.heldCount()).toBe(0);
    });

    it('is one mail for everything that is unseen, counted from the oldest', async () => {
      const { channel, sent } = setup();
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.noticed({ folder: ADA, id: 'b:2', at: t0 + 20 * MINUTE });
      channel.noticed({ folder: ADA, id: 'b:3', at: t0 + 40 * MINUTE });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toHaveLength(1);
    });

    it('is not for a message the student has looked at: a page in front after it was written, and not one that is merely open', async () => {
      const seen = setup({ lastVisible: { [ADA]: t0 + 10 * MINUTE } });
      seen.channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      seen.channel.sweep(t0 + HOUR);
      await settle();
      expect(seen.sent).toEqual([]);
      expect(seen.channel.heldCount()).toBe(0);
      const before = setup({ lastVisible: { [ADA]: t0 - MINUTE } });          // looked before it was written
      before.channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      before.channel.sweep(t0 + HOUR);
      await settle();
      expect(before.sent).toHaveLength(1);
    });

    it('is not for a message a push was delivered for, and is for one it was not (a push that failed, or none was sent)', async () => {
      const { channel, sent } = setup();
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.delivered(ADA, 'b:1', 'push');
      channel.noticed({ folder: BOB, id: 'b:2', at: t0 });
      channel.delivered(BOB, 'b:2', 'email');                              // its own is no push
      channel.delivered(BOB, 'b:other', 'push');                           // another message's
      channel.delivered('s_' + 'c3'.repeat(10), 'b:2', 'push');            // another student's
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent.map((m) => m.to)).toEqual(['bob@example.com']);
    });

    it('is one a day, by the student\'s own calendar, and another the next day', async () => {
      const { channel, sent } = setup();
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toHaveLength(1);
      channel.noticed({ folder: ADA, id: 'b:2', at: t0 + 3 * HOUR });
      channel.sweep(t0 + 4 * HOUR);                                          // the same day in Los Angeles: no
      await settle();
      expect(sent).toHaveLength(1);
      const tomorrow = Date.parse('2026-11-06T18:00:00Z');
      channel.noticed({ folder: ADA, id: 'b:3', at: tomorrow });
      channel.sweep(tomorrow + HOUR);
      await settle();
      expect(sent).toHaveLength(2);
    });

    it('does not count a mail that failed against the day, and does not send twice for one sweep that runs again before the first is done', async () => {
      let ok = false;
      const { channel, sent, logs } = setup({ result: () => (ok ? { ok: true } : { ok: false, stage: 'connect', transient: true, detail: 'ECONNREFUSED' }) });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      channel.sweep(t0 + HOUR + 1000);
      await settle();
      expect(sent).toHaveLength(1);                                          // the second sweep found nothing held
      expect(logs.some((l) => l.level === 'warn' && /could not be sent/.test(String(l.msg)))).toBe(true);
      ok = true;
      channel.noticed({ folder: ADA, id: 'b:2', at: t0 + 2 * HOUR });
      channel.sweep(t0 + 3 * HOUR);
      await settle();
      expect(sent).toHaveLength(2);                                          // the failure did not use up the day
    });

    it('is dropped when the student turns it off before it is time, and for a message more than a day old', async () => {
      const { channel, sent, prefs } = setup();
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      prefs[ADA] = prefsWith(false);
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toEqual([]);
      expect(channel.heldCount()).toBe(0);
      prefs[ADA] = prefsWith(true);
      channel.noticed({ folder: ADA, id: 'b:2', at: t0 });
      channel.sweep(t0 + 25 * HOUR);
      await settle();
      expect(sent).toEqual([]);
    });

    it('is told apart for each student', async () => {
      const { channel, sent } = setup({ lastVisible: { [BOB]: t0 + MINUTE } });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.noticed({ folder: BOB, id: 'b:2', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent.map((m) => m.to)).toEqual(['ada@example.com']);
    });

    it('takes its wait and its limit from the rules it is given', async () => {
      const sent: Mail[] = [];
      const channel = new EmailChannel({
        mailer: { send: async (mail) => (sent.push(mail), { ok: true }) },
        recipientOf: () => 'ada@example.com',
        prefs: { read: () => prefsWith(true) },
        page: { lastVisibleAt: () => 0 },
        pageUrl: URL,
        rules: { ...DEFAULT_EMAIL_RULES, afterMs: 10 * MINUTE, dailyMax: 2 },
        defaultTz: 'America/Los_Angeles',
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      });
      for (const [n, at] of [[1, t0], [2, t0 + HOUR], [3, t0 + 2 * HOUR]] as const) {
        channel.noticed({ folder: ADA, id: `b:${n}`, at });
        channel.sweep(at + 10 * MINUTE);
        await settle();
      }
      expect(sent).toHaveLength(2);
    });
  });

  describe('a mail that could not be sent', () => {
    const MAY_PASS: SmtpResult = { ok: false, stage: 'connect', transient: true, detail: 'ECONNREFUSED' };

    it('is held and tried again an hour later, three tries in all, and then let go (what TAi writes later starts again)', async () => {
      const { channel, sent, logs } = setup({ result: () => MAY_PASS });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toHaveLength(1);
      expect(channel.heldCount()).toBe(1);                                   // not lost: the server may be back in a while
      channel.sweep(t0 + HOUR + 30_000);
      channel.sweep(t0 + 2 * HOUR - 1);
      await settle();
      expect(sent).toHaveLength(1);                                          // the sweeps that follow do not spend the other tries in a minute
      channel.sweep(t0 + 2 * HOUR);
      await settle();
      expect(sent).toHaveLength(2);
      channel.sweep(t0 + 3 * HOUR);
      await settle();
      expect(sent).toHaveLength(3);
      expect(channel.heldCount()).toBe(0);                                   // given up on
      expect(logs.some((l) => /given up/.test(String(l.msg)))).toBe(true);
      channel.sweep(t0 + 4 * HOUR);
      channel.sweep(t0 + 20 * HOUR);
      await settle();
      expect(sent).toHaveLength(3);
      channel.noticed({ folder: ADA, id: 'b:2', at: t0 + 5 * HOUR });         // a new message starts a new round
      channel.sweep(t0 + 6 * HOUR);
      await settle();
      expect(sent).toHaveLength(4);
    });

    it('is sent when a later try works: once, for everything that was unseen by then, and the day is used up only then', async () => {
      let ok = false;
      const { channel, sent } = setup({ result: () => (ok ? { ok: true } : MAY_PASS) });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(sent).toHaveLength(1);
      channel.noticed({ folder: ADA, id: 'b:2', at: t0 + 90 * MINUTE });         // arrives while the first waits for its next try
      ok = true;
      channel.sweep(t0 + 2 * HOUR);
      await settle();
      expect(sent).toHaveLength(2);
      expect(channel.heldCount()).toBe(0);
      channel.noticed({ folder: ADA, id: 'b:3', at: t0 + 2 * HOUR });
      channel.sweep(t0 + 3 * HOUR);
      await settle();
      expect(sent).toHaveLength(2);                                          // the one e-mail of the day has gone
    });

    it('is held again when the sender itself rejects, and when the server said something that may pass; not for one that will not (a refused login)', async () => {
      let how: 'reject' | 'refuse' = 'reject';
      const { channel, sent } = setup({
        result: () => {
          if (how === 'reject') throw new Error('the server melted');
          return { ok: false, stage: 'auth', transient: false, detail: 'the login was refused (535)' };
        },
      });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      expect(channel.heldCount()).toBe(1);
      how = 'refuse';
      channel.sweep(t0 + 2 * HOUR);
      await settle();
      expect(sent).toHaveLength(2);
      expect(channel.heldCount()).toBe(0);                                   // a 535 will not pass by waiting: not repeated
      channel.sweep(t0 + 3 * HOUR);
      await settle();
      expect(sent).toHaveLength(2);
    });

    it('is not tried again when the student has looked at the page since, or has turned e-mail off', async () => {
      const looked = setup({ result: () => MAY_PASS });
      looked.channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      looked.channel.sweep(t0 + HOUR);
      await settle();
      looked.visible[ADA] = t0 + 90 * MINUTE;
      looked.channel.sweep(t0 + 2 * HOUR);
      await settle();
      expect(looked.sent).toHaveLength(1);
      expect(looked.channel.heldCount()).toBe(0);
      const off = setup({ result: () => MAY_PASS });
      off.channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      off.channel.sweep(t0 + HOUR);
      await settle();
      off.prefs[ADA] = prefsWith(false);
      off.channel.sweep(t0 + 2 * HOUR);
      await settle();
      expect(off.sent).toHaveLength(1);
      expect(off.channel.heldCount()).toBe(0);
    });

    it('is not scheduled for later than three hours after the first try, however late the sweeps run', async () => {
      const { channel, sent } = setup({ result: () => MAY_PASS });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      channel.sweep(t0 + 5 * HOUR);                                          // the process was stopped for hours: the second try is late
      await settle();
      expect(sent).toHaveLength(2);
      expect(channel.heldCount()).toBe(0);                                   // a third would be 5 hours after the first: let go
      channel.sweep(t0 + 7 * HOUR);
      await settle();
      expect(sent).toHaveLength(2);
    });
  });

  describe('a channel that must not hurt anything', () => {
    it('never throws: a preferences file that cannot be read, a sender that rejects or throws', async () => {
      const thrower = setup();
      thrower.prefs[BOB] = new Proxy({}, { get: () => { throw new Error('disk gone'); } }) as never;
      thrower.channel.noticed({ folder: BOB, id: 'b:1', at: t0 });
      thrower.channel.noticed({ folder: ADA, id: 'b:2', at: t0 });
      expect(() => thrower.channel.sweep(t0 + HOUR)).not.toThrow();
      await settle();
      expect(thrower.sent.map((m) => m.to)).toEqual(['ada@example.com']);         // the one that could be read still went
      expect(thrower.logs.some((l) => l.level === 'warn')).toBe(true);
      const rejecting = new EmailChannel({
        mailer: { send: () => Promise.reject(new Error('the server melted')) },
        recipientOf: () => 'ada@example.com',
        prefs: { read: () => prefsWith(true) },
        page: { lastVisibleAt: () => 0 },
        pageUrl: URL,
        defaultTz: 'America/Los_Angeles',
        log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      });
      rejecting.noticed({ folder: ADA, id: 'b:1', at: t0 });
      expect(() => rejecting.sweep(t0 + HOUR)).not.toThrow();
      await settle();
    });

    it('logs the folder and what happened, never the address or the words', async () => {
      const { channel, logs } = setup({ result: () => ({ ok: false, stage: 'rcpt-to', transient: false, detail: '550 <address> unknown' }) });
      channel.noticed({ folder: ADA, id: 'b:1', at: t0 });
      channel.sweep(t0 + HOUR);
      await settle();
      const text = JSON.stringify(logs);
      expect(text).toContain(ADA);
      expect(text).not.toContain('ada@example.com');
    });
  });
});
