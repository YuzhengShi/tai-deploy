/** The settings of notifications, and what startNotify builds from them: when push is on, and what the page's server is given. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clockText, notifyConfig, parseClock } from './config.js';
import type { OutboundLike } from './notifier.js';
import { startNotify, type NotifyStartOptions } from './start.js';
import { generateVapidKeys } from './vapid.js';

const ADA = 's_' + 'a1'.repeat(10);
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: 'p', auth: 'a' } };

describe('the settings of notifications', () => {
  it('reads a time of day as minutes after midnight, and refuses what is not one', () => {
    expect([parseClock('22:00'), parseClock('8'), parseClock('08:30'), parseClock(' 7:05 '), parseClock('0:00')]).toEqual([1320, 480, 510, 425, 0]);
    for (const bad of ['24:00', '8:5', '', 'abc', '12:60', '-1', undefined]) expect(parseClock(bad as string | undefined), String(bad)).toBeNull();
    expect([clockText(1320), clockText(480), clockText(0), clockText(425)]).toEqual(['22:00', '08:00', '00:00', '07:05']);
  });

  it('are off, with quiet hours from 22:00 to 08:00, three a day, a 20 second wait and Los Angeles, when nothing is set', () => {
    const config = notifyConfig({}, {});
    expect(config).toMatchObject({ on: false, preview: false, subject: undefined, quiet: { start: '22:00', end: '08:00' }, warnings: [] });
    expect(config.rules).toMatchObject({ quietStart: 1320, quietEnd: 480, dailyMax: 3, replyAfterMs: 20_000, defaultTz: 'America/Los_Angeles' });
  });

  it('are on for 1, true, on or yes, and for nothing else', () => {
    for (const value of ['1', 'true', 'ON', ' yes ']) expect(notifyConfig({ TAI_NOTIFY: value }).on, value).toBe(true);
    for (const value of ['0', 'false', 'off', '', 'maybe', '2']) expect(notifyConfig({ TAI_NOTIFY: value }).on, value).toBe(false);
    expect(notifyConfig({ TAI_PUSH_PREVIEW: '1' }).preview).toBe(true);
    expect(notifyConfig({ TAI_PUSH_PREVIEW: '0' }).preview).toBe(false);
  });

  it('take the VAPID subject from the page\'s own https address, not from anyone\'s e-mail, unless the operator says otherwise', () => {
    expect(notifyConfig({}, { origin: 'https://cs6650.example', basePath: '/tai' }).subject).toBe('https://cs6650.example/tai');
    expect(notifyConfig({}, { origin: 'https://cs6650.example/', basePath: '/' }).subject).toBe('https://cs6650.example');
    expect(notifyConfig({}, { origin: 'http://127.0.0.1:8787', basePath: '/' }).subject).toBeUndefined();
    expect(notifyConfig({}, {}).subject).toBeUndefined();
    expect(notifyConfig({ TAI_PUSH_SUBJECT: 'mailto:ops@example.com' }, {}).subject).toBe('mailto:ops@example.com');
    expect(notifyConfig({ TAI_PUSH_SUBJECT: 'https://tai.example/about' }, { origin: 'https://cs6650.example' }).subject).toBe('https://tai.example/about');
    const wrong = notifyConfig({ TAI_PUSH_SUBJECT: 'ops@example.com' }, { origin: 'https://cs6650.example', basePath: '/tai' });
    expect(wrong.subject).toBe('https://cs6650.example/tai');
    expect(wrong.warnings.join(' ')).toContain('TAI_PUSH_SUBJECT');
    expect(notifyConfig({ TAI_PUSH_SUBJECT: 'http://tai.example' }, {}).subject).toBeUndefined();
  });

  it('take the limits and the quiet hours that are set, and fall back, saying so, for nonsense', () => {
    const set = notifyConfig({ TAI_PUSH_DAILY_MAX: '5', TAI_PUSH_QUIET_START: '23:30', TAI_PUSH_QUIET_END: '7', TAI_PUSH_REPLY_AFTER_SECONDS: '45', TAI_PUSH_DEFAULT_TZ: 'America/Vancouver' });
    expect(set.rules).toMatchObject({ dailyMax: 5, quietStart: 1410, quietEnd: 420, replyAfterMs: 45_000, defaultTz: 'America/Vancouver' });
    expect(set.quiet).toEqual({ start: '23:30', end: '07:00' });
    expect(notifyConfig({ TAI_PUSH_DAILY_MAX: '0' }).rules.dailyMax).toBe(0);
    const bad = notifyConfig({ TAI_PUSH_DAILY_MAX: 'many', TAI_PUSH_QUIET_START: 'evening', TAI_PUSH_QUIET_END: '25:00', TAI_PUSH_REPLY_AFTER_SECONDS: '-3', TAI_PUSH_DEFAULT_TZ: 'Mars/Base' });
    expect(bad.rules).toMatchObject({ dailyMax: 3, quietStart: 1320, quietEnd: 480, replyAfterMs: 20_000, defaultTz: 'America/Los_Angeles' });
    expect(bad.warnings).toHaveLength(5);
  });
});

describe('what startNotify builds', () => {
  const dirs: string[] = [];
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(env: NodeJS.ProcessEnv, extra: Partial<NotifyStartOptions> = {}) {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-notify-start-'));
    dirs.push(storeDir);
    const listeners: Array<(entry: OutboundLike) => void> = [];
    const stopListening = vi.fn();
    const logs: Array<{ level: string; msg?: string }> = [];
    const log = (level: string) => (_obj: object, msg?: string) => void logs.push({ level, msg });
    const sent: Array<{ endpoint: string; options: { ttl: number; urgency: string } }> = [];
    const clock = { now: Date.parse('2026-11-05T18:00:00Z') };
    const started = startNotify({
      env,
      web: { onOutbound: (listener) => (listeners.push(listener), stopListening), bootId: 'b1' },
      storeDir,
      origin: 'https://cs6650.example',
      basePath: '/tai',
      log: { debug: log('debug'), info: log('info'), warn: log('warn') },
      sender: { send: async (sub, _payload, options) => (sent.push({ endpoint: sub.endpoint, options }), { outcome: 'sent' as const, status: 201 }) },
      now: () => clock.now,
      sweepEveryMs: 1_000_000,
      ...extra,
    });
    stops.push(started.stop);
    return { started, listeners, stopListening, logs, sent, clock, storeDir };
  }

  const keyEnv = () => ({ TAI_NOTIFY: '1', VAPID_PRIVATE_KEY: generateVapidKeys().privateKey });
  const answer = (started: ReturnType<typeof startNotify>, pathname: string) => {
    const json = vi.fn();
    void started.routes.find((r) => r.path === pathname && r.method === 'GET')!.handler({ json, user: { folder: ADA } } as never);
    return json.mock.calls[0];
  };

  it('is the preferences alone when TAI_NOTIFY is off: no push, no presence, no listener, and the page is told so', () => {
    const { started, listeners } = setup({ VAPID_PRIVATE_KEY: generateVapidKeys().privateKey });
    expect(started.pushOn).toBe(false);
    expect(started.presence).toBeUndefined();
    expect(started.notifier).toBeUndefined();
    expect(listeners).toHaveLength(0);
    expect(started.features({} as never)).toEqual({ prefs: true, push: false, email: false });
    expect(started.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /api/prefs', 'GET /api/push/key', 'POST /api/prefs', 'POST /api/push/subscribe', 'POST /api/push/unsubscribe']);
    expect(answer(started, '/api/push/key')).toEqual([404, { error: 'push-off' }]);
  });

  it('stays off, with one warning that says why and not the key, when TAI_NOTIFY is on but there is no usable key or no subject', () => {
    const none = setup({ TAI_NOTIFY: '1' });
    expect(none.started.pushOn).toBe(false);
    expect(none.logs.filter((l) => l.level === 'warn').map((l) => l.msg).join('\n')).toContain('no VAPID private key');
    const secret = generateVapidKeys();
    const mismatch = setup({ TAI_NOTIFY: '1', VAPID_PRIVATE_KEY: secret.privateKey, VAPID_PUBLIC_KEY: generateVapidKeys().publicKey });
    expect(mismatch.started.pushOn).toBe(false);
    expect(JSON.stringify(mismatch.logs)).not.toContain(secret.privateKey);
    const noSubject = setup(keyEnv(), { origin: undefined });
    expect(noSubject.started.pushOn).toBe(false);
    expect(noSubject.logs.some((l) => /no TAI_PUSH_SUBJECT/.test(String(l.msg)))).toBe(true);
    expect(noSubject.listeners).toHaveLength(0);
  });

  it('is on with a key: the public key is served, the page is told push is on, a presence is built, and the web channel is listened to', () => {
    const keys = generateVapidKeys();
    const { started, listeners } = setup({ TAI_NOTIFY: '1', VAPID_PRIVATE_KEY: keys.privateKey });
    expect(started.pushOn).toBe(true);
    expect(started.presence).toBeDefined();
    expect(started.features({} as never)).toEqual({ prefs: true, push: true, email: false });
    expect(listeners).toHaveLength(1);
    expect(answer(started, '/api/push/key')).toEqual([200, { key: keys.publicKey }]);
    expect(answer(started, '/api/prefs')?.[1]).toMatchObject({ limits: { quietStart: '22:00', quietEnd: '08:00', dailyMax: 3, maxDevices: 5 } });
  });

  it('pushes what the web channel sends to a student who subscribed, and starts the clock of a reply when a message is handed to TAi', async () => {
    const { started, listeners, sent, clock } = setup(keyEnv());
    started.prefs.addPush(ADA, SUB);
    const web = (text: string, seq: number) => listeners[0]({ kind: 'text', jid: `web:${ADA}`, text, seq });
    // TAi on its own, nobody has the page open
    web('A reminder.', 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ endpoint: SUB.endpoint, options: { ttl: 86_400, urgency: 'normal' } });
    // the student writes, the answer takes 30 s
    const result = { ok: true as const, id: 'x' };
    expect(started.noteSubmit(`web:${ADA}`, result)).toBe(result);
    clock.now += 30_000;
    web('The answer.', 2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(2);
    expect(sent[1].options).toEqual({ ttl: 1800, urgency: 'high' });
  });

  it('does not start a clock for a message TAi did not take, or for a chat that is not a student\'s, and never throws', async () => {
    const { started, listeners, sent, clock } = setup(keyEnv());
    started.prefs.addPush(ADA, SUB);
    const refused = { ok: false as const, status: 503 };
    expect(started.noteSubmit(`web:${ADA}`, refused)).toBe(refused);
    expect(() => started.noteSubmit(undefined as never, { ok: true })).not.toThrow();
    expect(started.noteSubmit('whatsapp:1', { ok: true })).toEqual({ ok: true });
    clock.now += 30_000;
    listeners[0]({ kind: 'text', jid: `web:${ADA}`, text: 'On its own, since nothing was taken.', seq: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent[0].options.urgency).toBe('normal');                    // not a reply
    expect(() => listeners[0](null as never)).not.toThrow();
    expect(() => listeners[0]({ kind: 'text', jid: undefined } as never)).not.toThrow();
  });

  it('lets go of the web channel when it is stopped', () => {
    const { started, stopListening } = setup(keyEnv());
    started.stop();
    expect(stopListening).toHaveBeenCalledTimes(1);
  });
});

describe('the settings of e-mail', () => {
  it('are off, on port 587, one a day after an hour, when nothing is set, and the page\'s link is its https address', () => {
    const config = notifyConfig({}, { origin: 'https://cs6650.example', basePath: '/tai' });
    expect(config.email).toMatchObject({ on: false, port: 587, host: undefined, user: undefined, from: undefined });
    expect(config.email.rules).toMatchObject({ dailyMax: 1, afterMs: 60 * 60_000 });
    expect(config.pageUrl).toBe('https://cs6650.example/tai/');
    expect(notifyConfig({}, { origin: 'https://cs6650.example/', basePath: '/' }).pageUrl).toBe('https://cs6650.example/');
    expect(notifyConfig({}, { origin: 'http://127.0.0.1:8787' }).pageUrl).toBeUndefined();
  });

  it('take what is set, and refuse what is not a host, a port, a login or an address', () => {
    const set = notifyConfig({ TAI_NOTIFY_EMAIL: '1', TAI_SMTP_HOST: 'smtp.school.example', TAI_SMTP_PORT: '465', TAI_SMTP_USER: 'tai@school.example', TAI_NOTIFY_FROM: 'tai@school.example', TAI_EMAIL_DAILY_MAX: '2', TAI_EMAIL_AFTER_MINUTES: '30' });
    expect(set.email).toMatchObject({ on: true, host: 'smtp.school.example', port: 465, user: 'tai@school.example', from: 'tai@school.example' });
    expect(set.email.rules).toMatchObject({ dailyMax: 2, afterMs: 30 * 60_000 });
    expect(set.warnings).toEqual([]);
    const bad = notifyConfig({ TAI_NOTIFY_EMAIL: '1', TAI_SMTP_HOST: 'smtp host;rm', TAI_SMTP_USER: 'a b', TAI_NOTIFY_FROM: 'Tai <tai@school.example>', TAI_EMAIL_DAILY_MAX: 'lots', TAI_EMAIL_AFTER_MINUTES: '0' });
    expect(bad.email).toMatchObject({ host: undefined, user: undefined, from: undefined });
    expect(bad.email.rules).toMatchObject({ dailyMax: 1, afterMs: 60 * 60_000 });
    expect(bad.warnings).toHaveLength(5);
    expect(notifyConfig({ TAI_SMTP_HOST: 'smtp.school.example', TAI_SMTP_PORT: '99999' }).email.host).toBeUndefined();     // a port that is no port: no guessing
    expect(notifyConfig({ TAI_SMTP_HOST: 'smtp.school.example', TAI_SMTP_PORT: 'smtp' }).warnings.join(' ')).toContain('TAI_SMTP_PORT');
  });
});

describe('what startNotify builds for e-mail, and for the speed of the voice', () => {
  const stops: Array<() => void> = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const SECRET = 'SMTP-PASSWORD-12345';
  const MAIL_ENV = { TAI_NOTIFY_EMAIL: '1', TAI_SMTP_HOST: 'smtp.school.example', TAI_SMTP_USER: 'tai-login', TAI_NOTIFY_FROM: 'tai@school.example' };

  function build(env: NodeJS.ProcessEnv, extra: Partial<NotifyStartOptions> = {}) {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-notify-mail-'));
    dirs.push(storeDir);
    const listeners: Array<(entry: OutboundLike) => void> = [];
    const logs: Array<{ level: string; obj: object; msg?: string }> = [];
    const log = (level: string) => (obj: object, msg?: string) => void logs.push({ level, obj, msg });
    const mails: Array<{ to: string; subject: string; text: string }> = [];
    const secretReads: string[] = [];
    const clock = { now: Date.parse('2026-11-05T18:00:00Z') };
    const started = startNotify({
      env,
      web: { onOutbound: (listener) => (listeners.push(listener), () => undefined), bootId: 'b1' },
      storeDir,
      origin: 'https://cs6650.example',
      basePath: '/tai',
      log: { debug: log('debug'), info: log('info'), warn: log('warn') },
      recipientOf: (folder) => (folder === ADA ? 'ada@example.com' : undefined),
      readSecret: (key) => (secretReads.push(key), key === 'SMTP_PASSWORD' ? SECRET : undefined),
      mailer: { send: async (mail) => (mails.push(mail), { ok: true as const }) },
      now: () => clock.now,
      sweepEveryMs: 1_000_000,
      ...extra,
    });
    stops.push(started.stop);
    return { started, listeners, logs, mails, secretReads, clock };
  }
  const warnings = (logs: Array<{ level: string; msg?: string }>) => logs.filter((l) => l.level === 'warn').map((l) => l.msg ?? '').join('\n');
  const routeCall = async (started: ReturnType<typeof startNotify>, pathname: string, method: 'GET' | 'POST', body: Record<string, unknown> = {}) => {
    const json = vi.fn();
    await started.routes.find((r) => r.path === pathname && r.method === method)!.handler({ json, user: { folder: ADA }, readJson: async () => body } as never);
    return json;
  };

  it('is on when everything is there: features.email, the route that lets a student switch it on, and the limits for the dialog; push stays off without a key', async () => {
    const { started, listeners, secretReads } = build(MAIL_ENV);
    expect(started.emailOn).toBe(true);
    expect(started.pushOn).toBe(false);
    expect(started.features({} as never)).toEqual({ prefs: true, push: false, email: true });
    expect(started.presence).toBeDefined();
    expect(listeners).toHaveLength(1);                                           // the web channel is listened to for e-mail alone
    expect(secretReads).toEqual(['SMTP_PASSWORD']);
    expect((await routeCall(started, '/api/prefs', 'GET')).mock.calls[0][1].limits).toMatchObject({ emailAfterMinutes: 60, emailDailyMax: 1 });
  });

  it('is off, and says why once, when something is missing: the host, the from address, the password of a login, an https page, the list of students', async () => {
    const cases: Array<[string, NodeJS.ProcessEnv, Partial<NotifyStartOptions>, string]> = [
      ['no host', { ...MAIL_ENV, TAI_SMTP_HOST: '' }, {}, 'TAI_SMTP_HOST'],
      ['no from address', { ...MAIL_ENV, TAI_NOTIFY_FROM: '' }, {}, 'TAI_NOTIFY_FROM'],
      ['no password', MAIL_ENV, { readSecret: () => undefined }, 'SMTP_PASSWORD'],
      ['no https page', MAIL_ENV, { origin: 'http://127.0.0.1:8787' }, 'TAI_PORTAL_ORIGIN'],
      ['no list of students', MAIL_ENV, { recipientOf: undefined }, 'list of students'],
    ];
    for (const [name, env, extra, word] of cases) {
      const { started, logs, listeners } = build(env, extra);
      expect(started.emailOn, name).toBe(false);
      expect(started.features({} as never), name).toEqual({ prefs: true, push: false, email: false });
      expect(warnings(logs), name).toContain(word);
      expect(listeners, name).toHaveLength(0);
      expect((await routeCall(started, '/api/prefs', 'POST', { notify: { email: { enabled: true } } })).mock.calls[0], name).toEqual([400, { error: 'email-off' }]);
    }
  });

  it('needs no password for a relay with no login, is off unless TAI_NOTIFY_EMAIL is on, and never lets the password into a log', () => {
    const { started } = build({ ...MAIL_ENV, TAI_SMTP_USER: '' }, { readSecret: () => undefined });
    expect(started.emailOn).toBe(true);
    const off = build({ ...MAIL_ENV, TAI_NOTIFY_EMAIL: '0' });
    expect(off.started.emailOn).toBe(false);
    expect(off.secretReads).toEqual([]);                                         // the password is not even read when e-mail is off
    for (const env of [MAIL_ENV, { ...MAIL_ENV, TAI_SMTP_HOST: '' }, { ...MAIL_ENV, TAI_SMTP_PORT: 'nope' }]) {
      expect(JSON.stringify(build(env).logs)).not.toContain(SECRET);
    }
  });

  it('works alongside push: both channels, one notifier', () => {
    const both = build({ ...MAIL_ENV, TAI_NOTIFY: '1', VAPID_PRIVATE_KEY: generateVapidKeys().privateKey }, { sender: { send: async () => ({ outcome: 'sent' as const, status: 201 }) } });
    expect(both.started.pushOn).toBe(true);
    expect(both.started.emailOn).toBe(true);
    expect(both.started.features({} as never)).toEqual({ prefs: true, push: true, email: true });
    expect(both.listeners).toHaveLength(1);
  });

  it('sends one mail, an hour later, to the address the student signed in with, and none to a student who looked at the page meanwhile', async () => {
    const { started, listeners, mails, clock } = build(MAIL_ENV);
    started.prefs.update(ADA, { emailEnabled: true });
    const BOB = 's_' + 'b2'.repeat(10);
    started.prefs.update(BOB, { emailEnabled: true });
    const own = (jid: string, text: string, seq: number) => listeners[0]({ kind: 'text', jid: `web:${jid}`, text, seq });
    own(ADA, 'A nudge for Ada.', 1);
    clock.now += 61 * 60_000;
    started.notifier!.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'ada@example.com', subject: 'TAi has a message for you' });
    expect(mails[0].text).toContain('https://cs6650.example/tai/');
    expect(mails[0].text).not.toContain('nudge');
    // Bob is not on the list: no address, no mail. Ada, who looked in the meantime, is not written to either
    clock.now += 24 * 3_600_000;
    own(BOB, 'A nudge for Bob.', 2);
    own(ADA, 'Another for Ada.', 3);
    clock.now += 30 * 60_000;
    started.presence!.begin(ADA, '11111111-1111-4111-8111-111111111111', true)();
    clock.now += 40 * 60_000;
    started.notifier!.sweep();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mails).toHaveLength(1);
  });

  it('takes the voice speed a call runs at from TAI_VOICE_SPEED, as src/voice does, and says it as the default of GET api/prefs', async () => {
    const speed = async (env: NodeJS.ProcessEnv) => (await routeCall(build(env).started, '/api/prefs', 'GET')).mock.calls[0][1];
    expect((await speed({})).defaults).toEqual({ voiceSpeed: 1.2 });                      // the deployment's default (src/voice/config.ts)
    expect((await speed({})).voiceSpeed).toBeNull();
    expect((await speed({ TAI_VOICE_SPEED: '1' })).defaults.voiceSpeed).toBe(1);
    expect((await speed({ TAI_VOICE_SPEED: '1.1' })).defaults.voiceSpeed).toBe(1.1);
    expect((await speed({ TAI_VOICE_SPEED: '1.15' })).defaults.voiceSpeed).toBe(1.15);
    expect((await speed({ TAI_VOICE_SPEED: '1.5' })).defaults.voiceSpeed).toBe(1.5);
    expect((await speed({ TAI_VOICE_SPEED: 'fast' })).defaults.voiceSpeed).toBe(1.2);        // nonsense: the default, as the voice side reads it
    expect((await speed({ TAI_VOICE_SPEED: '3' })).defaults.voiceSpeed).toBe(1.2);
  });
});
