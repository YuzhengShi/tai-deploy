/** The push channel: what it sends, to whom, and what it does about a subscription that does not work. */
import { describe, expect, it, vi } from 'vitest';

import type { Prefs, StoredSubscription } from '../portal/prefs.js';
import { GENERIC_MESSAGE, type NotifyJob } from './notifier.js';
import { PushChannel, REJECTIONS_BEFORE_REMOVAL } from './push-channel.js';
import { endpointHash, type PushResult, type WebPushSubscription } from './webpush.js';

const ADA = 's_' + 'a1'.repeat(10);
const sub = (n: number): StoredSubscription => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` }, added: '' });
const prefsOf = (...subs: StoredSubscription[]): Prefs => ({ voiceSpeed: 1, notify: { push: subs, email: { enabled: false } } });
const jobOf = (prefs: Prefs, extra: Partial<NotifyJob> = {}): NotifyJob => ({ folder: ADA, ids: ['boot:1'], kind: 'proactive', urgency: 'normal', ttl: 86_400, message: GENERIC_MESSAGE, prefs, ...extra });

function setup(results: Record<string, PushResult | (() => PushResult)> = {}) {
  const sent: Array<{ sub: WebPushSubscription; payload: Buffer; options: { ttl: number; urgency: string } }> = [];
  const logs: Array<{ level: string; obj: object; msg?: string }> = [];
  const removed: Array<[string, string]> = [];
  const log = (level: string) => (obj: object, msg?: string) => void logs.push({ level, obj, msg });
  const channel = new PushChannel({
    sender: {
      send: vi.fn(async (s, payload, options) => {
        sent.push({ sub: s, payload, options });
        const result = results[s.endpoint];
        return typeof result === 'function' ? result() : (result ?? { outcome: 'sent', status: 201 });
      }),
    },
    prefs: {
      removePush: (folder, id) => {
        removed.push([folder, id]);
        return { removed: true };
      },
    },
    log: { debug: log('debug'), info: log('info'), warn: log('warn') },
    now: () => 1_700_000_000_000,
  });
  return { channel, sent, logs, removed };
}

describe('the push channel', () => {
  it('is wanted by a student with a browser subscribed, and by nobody else', () => {
    const { channel } = setup();
    expect(channel.name).toBe('push');
    expect(channel.wants(prefsOf())).toBe(false);
    expect(channel.wants(prefsOf(sub(1)))).toBe(true);
  });

  it('sends the generic message, as a small JSON, to every browser the student has, with the time to live and the urgency it was given', async () => {
    const { channel, sent } = setup();
    const outcome = await channel.deliver(jobOf(prefsOf(sub(1), sub(2)), { urgency: 'high', ttl: 1800 }));
    expect(outcome).toEqual({ delivered: 2, removed: 0, failed: 0 });
    expect(sent.map((s) => s.sub.endpoint)).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(sent.every((s) => s.options.ttl === 1800 && s.options.urgency === 'high')).toBe(true);
    expect(JSON.parse(sent[0].payload.toString())).toEqual({ v: 1, t: 'TAi', b: 'TAi has a new message', tag: 'tai-message', ts: 1_700_000_000_000 });
    expect(sent[0].payload.length).toBeLessThan(200);
    expect(sent[0].sub.keys).toEqual(sub(1).keys);
  });

  it('puts what a preview says in the notification, and nothing else of the message', async () => {
    const { channel, sent } = setup();
    await channel.deliver(jobOf(prefsOf(sub(1)), { message: { title: 'TAi', body: 'Heads up: HW6 is due tomorrow' } }));
    expect(JSON.parse(sent[0].payload.toString()).b).toBe('Heads up: HW6 is due tomorrow');
  });

  it('removes a subscription that is gone or is not allowed, at once, and keeps one that only failed', async () => {
    const { channel, removed } = setup({
      [sub(1).endpoint]: { outcome: 'gone', status: 410 },
      [sub(2).endpoint]: { outcome: 'refused', detail: 'endpoint not allowed' },
      [sub(3).endpoint]: { outcome: 'failed', status: 503 },
      [sub(4).endpoint]: { outcome: 'failed', detail: 'timeout' },
    });
    const outcome = await channel.deliver(jobOf(prefsOf(sub(1), sub(2), sub(3), sub(4), sub(5))));
    expect(outcome).toEqual({ delivered: 1, removed: 2, failed: 2 });
    expect(removed).toEqual([[ADA, endpointHash(sub(1).endpoint)], [ADA, endpointHash(sub(2).endpoint)]]);
  });

  it('removes a subscription the push service keeps rejecting after three in a row, and not for one or two', async () => {
    const answers: PushResult[] = [{ outcome: 'rejected', status: 403, detail: 'VapidPkHashMismatch' }];
    const { channel, removed } = setup({ [sub(1).endpoint]: () => answers[0] });
    for (let i = 1; i < REJECTIONS_BEFORE_REMOVAL; i++) {
      await channel.deliver(jobOf(prefsOf(sub(1))));
      expect(removed).toEqual([]);
    }
    await channel.deliver(jobOf(prefsOf(sub(1))));
    expect(removed).toEqual([[ADA, endpointHash(sub(1).endpoint)]]);
    expect(REJECTIONS_BEFORE_REMOVAL).toBe(3);
  });

  it('forgets the rejections when a push goes through in between: three in a row is three in a row', async () => {
    const queue: PushResult[] = [
      { outcome: 'rejected', status: 403 }, { outcome: 'rejected', status: 403 }, { outcome: 'sent', status: 201 },
      { outcome: 'rejected', status: 403 }, { outcome: 'rejected', status: 403 },
    ];
    const { channel, removed } = setup({ [sub(1).endpoint]: () => queue.shift()! });
    for (let i = 0; i < 5; i++) await channel.deliver(jobOf(prefsOf(sub(1))));
    expect(removed).toEqual([]);
  });

  it('counts the rejections of each browser apart', async () => {
    const { channel, removed } = setup({ [sub(1).endpoint]: { outcome: 'rejected', status: 403 }, [sub(2).endpoint]: { outcome: 'rejected', status: 401 } });
    for (let i = 0; i < 2; i++) await channel.deliver(jobOf(prefsOf(sub(1), sub(2))));
    expect(removed).toEqual([]);
    await channel.deliver(jobOf(prefsOf(sub(1))));
    expect(removed).toEqual([[ADA, endpointHash(sub(1).endpoint)]]);
  });

  it('does not stop for a subscription that cannot be removed', async () => {
    const channel = new PushChannel({
      sender: { send: async () => ({ outcome: 'gone', status: 404 }) },
      prefs: { removePush: () => { throw new Error('the disk is full'); } },
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    });
    await expect(channel.deliver(jobOf(prefsOf(sub(1), sub(2))))).resolves.toEqual({ delivered: 0, removed: 2, failed: 0 });
  });

  it('names an endpoint in the log by its hash only, and never logs a key or the payload', async () => {
    const { channel, logs } = setup({ [sub(1).endpoint]: { outcome: 'gone', status: 410, detail: 'UnregisteredPushSubscription' } });
    await channel.deliver(jobOf(prefsOf(sub(1), sub(2))));
    const text = JSON.stringify(logs);
    expect(text).toContain(endpointHash(sub(1).endpoint));
    expect(text).not.toContain('fcm.googleapis.com');
    expect(text).not.toContain('device-1');
    expect(text).not.toContain('p256dh-1');
    expect(text).not.toContain('auth-1');
    expect(text).not.toContain('new message');
  });
});
