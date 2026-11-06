/**
 * The notifier end to end with stand-ins: a prefs reader, a page probe, channels that record what they were asked to deliver, and a fake clock.
 * Every rule of core.ts is seen here from the outside: what the web channel hands over, and what is, or is not, delivered.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RULES, type PageState } from './core.js';
import { GENERIC_MESSAGE, Notifier, previewOf, type NotifyChannel, type NotifyJob, type OutboundLike } from './notifier.js';
import type { Prefs } from '../portal/prefs.js';

const ADA = 's_' + 'a1'.repeat(10);
const BOB = 's_' + 'b2'.repeat(10);
const at = (iso: string) => Date.parse(iso);

const noPush: Prefs = { voiceSpeed: 1, notify: { push: [], email: { enabled: false } } };
const withPush = (extra: Partial<Prefs> = {}): Prefs => ({
  voiceSpeed: 1,
  notify: { push: [{ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' }, added: '' }], email: { enabled: false } },
  ...extra,
});

interface World {
  now: number;
  prefs: Record<string, Prefs>;
  page: Record<string, PageState>;
  lastVisible: Record<string, number>;
  jobs: NotifyJob[];
  logs: Array<{ level: string; obj: object; msg?: string }>;
  notifier: Notifier;
  channel: NotifyChannel;
  seq: number;
}

function world(options: { preview?: boolean; channels?: (w: World) => NotifyChannel[]; schedule?: (run: () => void) => void; rules?: Partial<typeof DEFAULT_RULES> } = {}): World {
  const w = { now: at('2026-11-05T18:00:00Z'), prefs: { [ADA]: withPush(), [BOB]: withPush() }, page: {}, lastVisible: {}, jobs: [], logs: [], seq: 0 } as unknown as World;
  w.channel = {
    name: 'push',
    wants: (prefs) => prefs.notify.push.length > 0,
    deliver: async (job) => {
      w.jobs.push(job);
      return { delivered: job.prefs.notify.push.length };
    },
  };
  const log = (level: string) => (obj: object, msg?: string) => void w.logs.push({ level, obj, msg });
  w.notifier = new Notifier({
    rules: { ...DEFAULT_RULES, ...options.rules },
    prefs: { read: (folder) => w.prefs[folder] ?? noPush },
    channels: options.channels ? options.channels(w) : [w.channel],
    page: { state: (folder) => w.page[folder] ?? 'closed', lastVisibleAt: (folder) => w.lastVisible[folder] ?? 0 },
    log: { debug: log('debug'), info: log('info'), warn: log('warn') },
    preview: options.preview,
    bootId: 'boot-1',
    now: () => w.now,
    schedule: options.schedule ?? ((run) => run()),
  });
  return w;
}

const text = (w: World, folder: string, body = 'Here is a hint about your channel.', extra: Partial<OutboundLike> = {}): void =>
  w.notifier.outbound({ kind: 'text', jid: `web:${folder}`, text: body, seq: ++w.seq, ...extra });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the reply to a student', () => {
  let w: World;
  beforeEach(() => {
    w = world();
  });

  it('is pushed, generic and urgent, when the page is closed and the student waited', async () => {
    w.notifier.studentMessage(ADA);
    w.notifier.outbound({ kind: 'typing', jid: `web:${ADA}`, typing: true });
    w.now += 25_000;
    text(w, ADA);
    await flush();
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0]).toMatchObject({ folder: ADA, kind: 'reply', urgency: 'high', ttl: 1800, message: GENERIC_MESSAGE });
    expect(GENERIC_MESSAGE).toEqual({ title: 'TAi', body: 'TAi has a new message' });
  });

  it('is pushed once for an answer that comes in several messages', () => {
    w.notifier.studentMessage(ADA);
    w.now += 25_000;
    text(w, ADA, 'First part.');
    w.now += 2_000;
    text(w, ADA, 'Second part.');
    w.now += 2_000;
    text(w, ADA, 'Third part.');
    expect(w.jobs).toHaveLength(1);
  });

  it('is not pushed when it came in under 20 seconds', () => {
    w.notifier.studentMessage(ADA);
    w.now += 19_000;
    text(w, ADA);
    expect(w.jobs).toHaveLength(0);
  });

  it('is not pushed while the student is looking at the page, however long they waited', () => {
    w.page[ADA] = 'visible';
    w.notifier.studentMessage(ADA);
    w.now += 90_000;
    text(w, ADA);
    expect(w.jobs).toHaveLength(0);
  });

  it('is pushed to a page that is open but behind another tab', () => {
    w.page[ADA] = 'hidden';
    w.notifier.studentMessage(ADA);
    w.now += 30_000;
    text(w, ADA);
    expect(w.jobs).toHaveLength(1);
  });

  it('is never held for quiet hours or counted against the limit of the day', () => {
    w.now = at('2026-11-05T07:00:00Z');                           // 23:00 in Los Angeles
    for (let i = 0; i < 5; i++) {
      w.notifier.studentMessage(ADA);
      w.now += 30_000;
      text(w, ADA, `Answer ${i}.`);
      w.now += 20 * 60_000;
    }
    expect(w.jobs.map((j) => j.kind)).toEqual(['reply', 'reply', 'reply', 'reply', 'reply']);
    expect(w.notifier.heldCount()).toBe(0);
  });

  it('counts the wait from the oldest message that nothing has answered yet', () => {
    w.notifier.studentMessage(ADA);
    w.now += 15_000;
    w.notifier.studentMessage(ADA);                               // wrote again, still no answer
    w.now += 10_000;
    text(w, ADA);                                                 // 25 s since the first
    expect(w.jobs).toHaveLength(1);
  });

  it('is TAi\'s own message, not an answer, when it comes after the typing stopped and a few seconds more', () => {
    w.notifier.studentMessage(ADA);
    w.notifier.outbound({ kind: 'typing', jid: `web:${ADA}`, typing: true });
    w.now += 30_000;
    text(w, ADA, 'The answer.');
    w.notifier.outbound({ kind: 'typing', jid: `web:${ADA}`, typing: false });
    w.now += 60_000;
    text(w, ADA, 'A reminder TAi sets itself.');
    expect(w.jobs.map((j) => j.kind)).toEqual(['reply', 'proactive']);
  });
});

describe('TAi writing on its own', () => {
  it('is pushed when the page is closed, normally, with a day to live', async () => {
    const w = world();
    text(w, ADA, 'Friday is the last day for HW6.');
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0]).toMatchObject({ kind: 'proactive', urgency: 'normal', ttl: 86_400, message: GENERIC_MESSAGE });
  });

  it('is not pushed while the student is looking at the page', () => {
    const w = world();
    w.page[ADA] = 'visible';
    text(w, ADA);
    expect(w.jobs).toHaveLength(0);
  });

  it('is pushed at most three times a day by the student\'s own calendar, and again the next day', () => {
    const w = world();
    for (let i = 0; i < 5; i++) {
      text(w, ADA, `Nudge number ${i}`);
      w.now += 60_000;
    }
    expect(w.jobs).toHaveLength(3);
    text(w, BOB, 'Another student has their own limit');
    expect(w.jobs).toHaveLength(4);
    w.now = at('2026-11-06T18:00:00Z');                             // the next day in Los Angeles
    text(w, ADA, 'A new day');
    expect(w.jobs).toHaveLength(5);
  });

  it('counts the day by the student\'s own time zone: 04:00 UTC is still the evening of the day before in Los Angeles, and the next morning in Tokyo', () => {
    const w = world();
    w.prefs[ADA] = withPush({ tz: 'Asia/Tokyo' });
    w.prefs[BOB] = withPush({ tz: 'America/Los_Angeles' });
    w.now = at('2026-11-06T04:00:00Z');                              // 20:00 on the 5th in Los Angeles, 13:00 on the 6th in Tokyo: not quiet in either
    for (let i = 0; i < 3; i++) {
      text(w, ADA, `Tokyo ${i}`);
      text(w, BOB, `Los Angeles ${i}`);
      w.now += 1000;
    }
    expect(w.jobs).toHaveLength(6);
    w.now = at('2026-11-06T08:30:00Z');                              // 00:30 on the 6th in Los Angeles (quiet), 17:30 on the 6th in Tokyo (the same day as before there)
    text(w, ADA, 'Tokyo again, the same day');
    expect(w.jobs).toHaveLength(6);                                   // Tokyo's day has three already
    w.now = at('2026-11-06T16:30:00Z');                              // 08:30 on the 6th in Los Angeles: a new day there, and not quiet
    text(w, BOB, 'Los Angeles, a new day');
    expect(w.jobs).toHaveLength(7);
  });

  it('is held for quiet hours and pushed once, when they end, if the student has not looked since', () => {
    const w = world();
    w.now = at('2026-11-05T07:00:00Z');                              // 23:00 in Los Angeles
    text(w, ADA, 'First note at night.');
    w.now += 3_600_000;
    text(w, ADA, 'Second note at night.');
    expect(w.jobs).toHaveLength(0);
    expect(w.notifier.heldCount()).toBe(1);
    w.now = at('2026-11-05T15:59:00Z');                              // 07:59
    w.notifier.sweep();
    expect(w.jobs).toHaveLength(0);
    w.now = at('2026-11-05T16:00:00Z');                              // 08:00
    w.notifier.sweep();
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0]).toMatchObject({ kind: 'proactive', message: GENERIC_MESSAGE });
    expect(w.notifier.heldCount()).toBe(0);
    w.notifier.sweep();
    expect(w.jobs).toHaveLength(1);
  });

  it('is dropped at the end of quiet hours when the student looked at the page after it arrived, and kept when they looked only before', () => {
    const w = world();
    w.now = at('2026-11-05T07:00:00Z');
    text(w, ADA, 'Held for the morning');
    text(w, BOB, 'Held for the morning too');
    w.lastVisible[ADA] = at('2026-11-05T07:30:00Z');                 // looked at 23:30: saw it
    w.lastVisible[BOB] = at('2026-11-05T06:30:00Z');                 // looked at 22:30, before it came
    w.now = at('2026-11-05T16:00:00Z');
    w.notifier.sweep();
    expect(w.jobs.map((j) => j.folder)).toEqual([BOB]);
  });

  it('is not pushed at the end of quiet hours to a student whose page is in front by then', () => {
    const w = world();
    w.now = at('2026-11-05T07:00:00Z');
    text(w, ADA, 'Held');
    text(w, BOB, 'Held');
    w.page[ADA] = 'visible';
    w.now = at('2026-11-05T16:00:00Z');
    w.notifier.sweep();
    expect(w.jobs.map((j) => j.folder)).toEqual([BOB]);
  });

  it('is bound at the end of quiet hours by the limit of the day (when the quiet hours do not run across midnight, a day can already be used up)', () => {
    const w = world({ rules: { quietStart: 13 * 60, quietEnd: 14 * 60, dailyMax: 1 } });
    w.now = at('2026-11-05T20:30:00Z');                              // 12:30 in Los Angeles: pushed, the day's one
    text(w, ADA, 'Pushed at half past twelve');
    w.now = at('2026-11-05T21:10:00Z');                              // 13:10: quiet, and held until 14:00
    text(w, ADA, 'Held for the end of the hour');
    expect(w.notifier.heldCount()).toBe(1);
    w.now = at('2026-11-05T22:00:00Z');
    w.notifier.sweep();
    expect(w.jobs).toHaveLength(1);                                   // nothing more today
    expect(w.notifier.heldCount()).toBe(0);
  });

  it('is held by the student\'s clock, whatever the server\'s: the same instant is the small hours for a student in Tokyo and mid-morning in Los Angeles', () => {
    const w = world();
    w.prefs[ADA] = withPush({ tz: 'Asia/Tokyo' });
    w.now = at('2026-11-05T18:00:00Z');                              // 03:00 JST (quiet), 10:00 PST
    text(w, ADA, 'Tokyo at 3 am');
    text(w, BOB, 'Los Angeles at 10 am');
    expect(w.jobs.map((j) => j.folder)).toEqual([BOB]);
    expect(w.notifier.heldCount()).toBe(1);
  });
});

describe('the same message twice, and nobody to tell', () => {
  it('is pushed once when the web channel hands it over twice, and a number that starts again after a restart is another message', () => {
    const w = world();
    const entry: OutboundLike = { kind: 'text', jid: `web:${ADA}`, text: 'Same entry', seq: 7 };
    w.notifier.outbound(entry);
    w.notifier.outbound(entry);
    expect(w.jobs).toHaveLength(1);
    const restarted = new Notifier({
      rules: DEFAULT_RULES,
      prefs: { read: () => withPush() },
      channels: [w.channel],
      page: { state: () => 'closed', lastVisibleAt: () => 0 },
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      bootId: 'boot-2',
      now: () => w.now,
      schedule: (run) => run(),
    });
    restarted.outbound({ ...entry, text: 'A different one after a restart' });
    expect(w.jobs).toHaveLength(2);
  });

  it('is pushed once when TAi says the same thing twice on its own within ten minutes, and again after that', () => {
    const w = world();
    text(w, ADA, 'Do not forget HW6.');
    w.now += 5 * 60_000;
    text(w, ADA, 'Do not forget HW6.');
    expect(w.jobs).toHaveLength(1);
    w.now += 20 * 60_000;
    text(w, ADA, 'Do not forget HW6.');
    expect(w.jobs).toHaveLength(2);
  });

  it('lets two replies with the same words (an "ok") both be pushed when each is an answer of its own', () => {
    const w = world();
    for (let i = 0; i < 2; i++) {
      w.notifier.studentMessage(ADA);
      w.now += 30_000;
      text(w, ADA, 'Ok.');
      w.now += 60_000;
    }
    expect(w.jobs).toHaveLength(2);
  });

  it('does nothing for a student who has nothing to be told by, and does not use up their limit of the day', () => {
    const w = world();
    w.prefs[ADA] = noPush;
    for (let i = 0; i < 5; i++) text(w, ADA, `Nudge ${i}`);
    expect(w.jobs).toHaveLength(0);
    w.prefs[ADA] = withPush();
    for (let i = 0; i < 5; i++) text(w, ADA, `Later nudge ${i}`);
    expect(w.jobs).toHaveLength(3);
  });
});

describe('what the web channel hands over', () => {
  it('is looked at only when it is a text or a picture for a student', () => {
    const w = world();
    w.notifier.outbound({ kind: 'reaction', jid: `web:${ADA}`, text: 'ignored' });
    w.notifier.outbound({ kind: 'audio', jid: `web:${ADA}` });
    w.notifier.outbound({ kind: 'typing', jid: `web:${ADA}`, typing: true });
    w.notifier.outbound({ kind: 'text', jid: `web:${ADA}`, text: '   ' });
    w.notifier.outbound({ kind: 'text', jid: `web:${ADA}` });
    w.notifier.outbound({ kind: 'image', jid: `web:${ADA}`, caption: '' });
    expect(w.jobs).toHaveLength(1);                                  // only the picture with no caption: a picture is a message
  });

  it('is nobody\'s for the owner\'s admin chat, the evaluation\'s and smoke tests\' chats and other channels', () => {
    const w = world();
    w.prefs.main = withPush();
    for (const jid of ['web:main', 'web:smoke-owner-01', 'web:eval-1', 'web:', 'web:../x', 'whatsapp:123@s.whatsapp.net', '', 'web:S_' + 'a1'.repeat(10)]) {
      w.notifier.outbound({ kind: 'text', jid, text: 'hello', seq: ++w.seq });
    }
    expect(w.jobs).toHaveLength(0);
  });

  it('can be a picture with its caption', () => {
    const w = world({ preview: true });
    w.notifier.outbound({ kind: 'image', jid: `web:${ADA}`, caption: 'Here is a Raft election: the candidate asks the others for their votes.', seq: 1 });
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0].message.body).toBe('Here is a Raft election: the candidate asks the others for their votes.');
  });
});

describe('what the notification says', () => {
  it('is only that there is something, unless a preview was switched on', () => {
    const w = world();
    text(w, ADA, 'You have not turned in HW6 and it is due tomorrow at noon.');
    expect(w.jobs[0].message).toEqual({ title: 'TAi', body: 'TAi has a new message' });
    expect(JSON.stringify(w.jobs[0])).not.toContain('HW6');
  });

  it('is the first 80 characters, in plain words, with a preview; the end of quiet hours never has one', () => {
    const w = world({ preview: true });
    text(w, ADA, '**Heads up:** `HW6` is due [tomorrow](https://example.com/hw6) at noon, and the rubric asks for a design note as well as the code you wrote.');
    expect(w.jobs[0].message.title).toBe('TAi');
    expect(w.jobs[0].message.body.length).toBeLessThanOrEqual(81);
    expect(w.jobs[0].message.body).toBe('Heads up: HW6 is due tomorrow at noon, and the rubric asks for a design note as…');
    w.now = at('2026-11-05T07:00:00Z');
    text(w, BOB, 'A night note that must not be shown on a lock screen.');
    w.now = at('2026-11-05T16:00:00Z');
    w.notifier.sweep();
    expect(w.jobs[1].message).toEqual(GENERIC_MESSAGE);
  });

  it('cuts a preview at a word, takes the markup off, and is a plain line', () => {
    expect(previewOf('Short.')).toBe('Short.');
    expect(previewOf('line one\n\nline two')).toBe('line one line two');
    expect(previewOf('```go\nfunc main() {}\n```\nThen run it.')).toBe('Then run it.');
    expect(previewOf('a'.repeat(200))).toBe(`${'a'.repeat(80)}…`);
    expect(previewOf('word '.repeat(40)).endsWith('word…')).toBe(true);
    expect(previewOf('')).toBe('');
  });
});

describe('a notifier that must not hurt a message', () => {
  it('returns before anything is sent: the sending is the next turn of the event loop', async () => {
    const w = world({ schedule: undefined });
    const delivered = vi.fn();
    const slow: NotifyChannel = { name: 'push', wants: () => true, deliver: async (job) => (delivered(job.folder), { delivered: 1 }) };
    const notifier = new Notifier({
      rules: DEFAULT_RULES,
      prefs: { read: () => withPush() },
      channels: [slow],
      page: { state: () => 'closed', lastVisibleAt: () => 0 },
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      now: () => w.now,
    });
    notifier.outbound({ kind: 'text', jid: `web:${ADA}`, text: 'hello', seq: 1 });
    expect(delivered).not.toHaveBeenCalled();
    await flush();
    expect(delivered).toHaveBeenCalledWith(ADA);
  });

  it('never throws: a prefs file that cannot be read, a channel that fails, a message that is not what was promised', async () => {
    const w = world({
      channels: (world) => [
        { name: 'broken', wants: () => true, deliver: () => Promise.reject(new Error('the mail server is down')) },
        world.channel,
      ],
    });
    expect(() => text(w, ADA, 'one')).not.toThrow();
    await flush();
    expect(w.jobs).toHaveLength(1);                                   // the second channel was still told
    expect(w.logs.some((l) => l.level === 'warn' && /a channel failed/.test(String(l.msg)))).toBe(true);
    const throwing = world();
    throwing.prefs = new Proxy({}, { get: () => { throw new Error('disk gone'); } }) as never;
    expect(() => throwing.notifier.outbound({ kind: 'text', jid: `web:${ADA}`, text: 'x', seq: 1 })).not.toThrow();
    expect(() => throwing.notifier.sweep()).not.toThrow();
    expect(() => throwing.notifier.outbound(null as never)).not.toThrow();
    expect(() => throwing.notifier.outbound({ kind: 'text' } as never)).not.toThrow();
    expect(() => throwing.notifier.studentMessage(ADA)).not.toThrow();
    expect(throwing.logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('reads the preferences again just before it delivers: a browser removed a moment ago is not written to', async () => {
    const w = world({ schedule: (run) => void setImmediate(run) });
    text(w, ADA, 'hello');
    w.prefs[ADA] = noPush;
    await flush();
    expect(w.jobs).toHaveLength(0);
  });

  it('logs the folder and the decision, never the words of a message', () => {
    const w = world();
    w.page[ADA] = 'visible';
    text(w, ADA, 'SECRET-WORDS-OF-THE-STUDENT');
    w.page[ADA] = 'closed';
    text(w, ADA, 'SECRET-WORDS-OF-TAI-TWO');
    expect(w.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(w.logs)).not.toContain('SECRET-WORDS');
  });

  it('offers a second channel the same message: the rules decide once, every channel the student has is told', async () => {
    const mail: NotifyJob[] = [];
    const w = world({
      channels: (world) => [world.channel, { name: 'email', wants: (prefs) => prefs.notify.email.enabled, deliver: async (job) => (mail.push(job), { delivered: 1 }) }],
    });
    w.prefs[ADA] = withPush({ notify: { push: withPush().notify.push, email: { enabled: true } } });
    text(w, ADA, 'Both channels');
    await flush();
    expect(w.jobs).toHaveLength(1);
    expect(mail).toHaveLength(1);
    w.prefs[BOB] = noPush;
    w.prefs[BOB] = { voiceSpeed: 1, notify: { push: [], email: { enabled: true } } };                // e-mail only
    text(w, BOB, 'Only mail');
    expect(w.jobs).toHaveLength(1);
    expect(mail).toHaveLength(2);
  });
});

describe('a channel with rules of its own (e-mail)', () => {
  /** A stand-in for such a channel: it records what it was told, and is never given a message by the push rules. */
  function own(wants: (prefs: Prefs) => boolean = () => true) {
    const calls = { noticed: [] as Array<{ folder: string; id: string; at: number }>, delivered: [] as Array<[string, string, string]>, sweeps: [] as number[], deliver: 0 };
    const channel: NotifyChannel = {
      name: 'email',
      mode: 'own',
      wants,
      deliver: async () => ((calls.deliver += 1), { delivered: 0 }),
      noticed: (message) => void calls.noticed.push(message),
      delivered: (folder, id, by) => void calls.delivered.push([folder, id, by]),
      sweep: (now) => void calls.sweeps.push(now),
    };
    return { channel, calls };
  }

  it('hears of every message TAi writes on its own, whether or not the push rules send it (page in front, limit used, held for the night)', () => {
    const mail = own();
    const w = world({ channels: (world) => [world.channel, mail.channel] });
    w.page[ADA] = 'visible';
    text(w, ADA, 'Seen on the page: no push.');
    w.page[ADA] = 'closed';
    for (let i = 0; i < 4; i++) text(w, ADA, `Nudge number ${i} that goes over the push limit.`);
    w.now = at('2026-11-05T07:00:00Z');                                      // 23:00 in Los Angeles: held
    text(w, ADA, 'A note at night.');
    expect(w.jobs).toHaveLength(3);                                           // three pushes, as before
    expect(mail.calls.noticed).toHaveLength(6);                               // and the mail channel heard of all six
    expect(mail.calls.noticed[0]).toEqual({ folder: ADA, id: 'boot-1:1', at: at('2026-11-05T18:00:00Z') });
    expect(mail.calls.noticed.map((n) => n.id)).toEqual(['boot-1:1', 'boot-1:2', 'boot-1:3', 'boot-1:4', 'boot-1:5', 'boot-1:6']);
    expect(mail.calls.deliver).toBe(0);                                       // the push rules never handed it a message
  });

  it('never hears of a reply, nor of the same message twice', () => {
    const mail = own();
    const w = world({ channels: (world) => [world.channel, mail.channel] });
    w.notifier.studentMessage(ADA);
    w.now += 30_000;
    text(w, ADA, 'The answer.');
    expect(mail.calls.noticed).toEqual([]);
    const entry: OutboundLike = { kind: 'text', jid: `web:${ADA}`, text: 'On its own, twice.', seq: 99 };
    w.now += 20 * 60_000;
    w.notifier.outbound(entry);
    w.notifier.outbound(entry);
    expect(mail.calls.noticed).toHaveLength(1);
  });

  it('is told when a push for a message was delivered (and not when it was not), and is told by the notifier\'s sweep', async () => {
    const mail = own();
    const w = world({ channels: (world) => [world.channel, mail.channel] });
    text(w, ADA, 'Pushed.');
    await flush();
    expect(mail.calls.delivered).toEqual([[ADA, 'boot-1:1', 'push']]);
    const failing = own();
    const f = world({ channels: () => [{ name: 'push', wants: () => true, deliver: async () => ({ delivered: 0, failed: 1 }) }, failing.channel] });
    text(f, ADA, 'Not delivered.');
    await flush();
    expect(failing.calls.delivered).toEqual([]);
    f.now += 1000;
    f.notifier.sweep();
    f.notifier.sweep();
    expect(failing.calls.sweeps).toEqual([f.now, f.now]);
  });

  it('is the only channel a student has: it hears of the message, no push is decided, nothing is delivered', async () => {
    const mail = own();
    const w = world({ channels: () => [mail.channel] });
    text(w, ADA, 'Only mail here.');
    await flush();
    expect(mail.calls.noticed).toHaveLength(1);
    expect(mail.calls.deliver).toBe(0);
    expect(w.jobs).toHaveLength(0);
    expect(w.notifier.heldCount()).toBe(0);
  });

  it('is not asked about a student who has not switched it on', () => {
    const mail = own((prefs) => prefs.notify.email.enabled);
    const w = world({ channels: (world) => [world.channel, mail.channel] });
    text(w, ADA, 'Push only.');
    expect(mail.calls.noticed).toEqual([]);
    expect(w.jobs).toHaveLength(1);
  });

  it('hurts nothing when it throws: the push still goes, and the others are still swept', () => {
    const broken: NotifyChannel = {
      name: 'broken',
      mode: 'own',
      wants: () => true,
      deliver: async () => ({ delivered: 0 }),
      noticed: () => { throw new Error('boom'); },
      sweep: () => { throw new Error('boom'); },
    };
    const mail = own();
    const w = world({ channels: (world) => [broken, world.channel, mail.channel] });
    expect(() => text(w, ADA, 'Still pushed.')).not.toThrow();
    expect(w.jobs).toHaveLength(1);
    expect(mail.calls.noticed).toHaveLength(1);
    expect(() => w.notifier.sweep()).not.toThrow();
    expect(mail.calls.sweeps).toHaveLength(1);
    expect(w.logs.filter((l) => l.level === 'warn').length).toBeGreaterThanOrEqual(2);
  });

  it('gives a push the ids of the messages it stands for, the held ones together', () => {
    const w = world();
    w.now = at('2026-11-05T07:00:00Z');                                      // 23:00
    text(w, ADA, 'First at night.');
    text(w, ADA, 'Second at night.');
    w.now = at('2026-11-05T16:00:00Z');
    w.notifier.sweep();
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0].ids).toEqual(['boot-1:1', 'boot-1:2']);
    text(w, BOB, 'A single one.');
    expect(w.jobs[1].ids).toEqual(['boot-1:3']);
  });
});
