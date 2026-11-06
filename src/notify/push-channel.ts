/**
 * The browser-push channel of the notifier: one message to every browser the student turned notifications on in. The payload is small and
 * generic ({"v":1,"t":"TAi","b":"TAi has a new message","tag":"tai-message"}, portal/web/sw.js shows it); it is padded and encrypted for each
 * browser separately (webpush.ts). What happens to a subscription that does not work:
 *
 *   gone (404, 410)             the browser has unsubscribed or been reset: removed at once
 *   refused (our own check)     an endpoint or keys that no longer pass today's rules: removed, they could never be sent to
 *   rejected (400, 401, 403)    the push service does not accept what we send (a key that was changed since the subscription was made makes
 *                               every message a 403): removed after three in a row, because a clock that is wrong for a minute must not cost
 *                               every student their notifications
 *   failed (a timeout, 429, 5xx, a redirect)   kept: it may be the service's trouble, and the next message tries again
 */
import type { Prefs } from '../portal/prefs.js';
import type { ChannelOutcome, NotifyChannel, NotifyJob, NotifyLog } from './notifier.js';
import { endpointHash, type PushOptions, type PushResult, type WebPushSubscription } from './webpush.js';

export interface PushLike {
  send(sub: WebPushSubscription, payload: Buffer, options: PushOptions): Promise<PushResult>;
}

export interface PushChannelDeps {
  sender: PushLike;
  prefs: { removePush(folder: string, id: string): { removed: boolean } };
  log: NotifyLog;
  now?: () => number;
}

/** How many rejections in a row remove a subscription. */
export const REJECTIONS_BEFORE_REMOVAL = 3;

export class PushChannel implements NotifyChannel {
  readonly name = 'push';
  private readonly rejections = new Map<string, number>();

  constructor(private readonly deps: PushChannelDeps) {}

  wants(prefs: Prefs): boolean {
    return prefs.notify.push.length > 0;
  }

  async deliver(job: NotifyJob): Promise<ChannelOutcome> {
    const payload = Buffer.from(JSON.stringify({ v: 1, t: job.message.title, b: job.message.body, tag: 'tai-message', ts: (this.deps.now ?? Date.now)() }));
    const results = await Promise.all(
      job.prefs.notify.push.map(async (stored) => {
        const id = endpointHash(stored.endpoint);
        const result = await this.deps.sender.send({ endpoint: stored.endpoint, keys: stored.keys }, payload, { ttl: job.ttl, urgency: job.urgency });
        this.account(job.folder, id, result);
        return result;
      }),
    );
    return {
      delivered: results.filter((r) => r.outcome === 'sent').length,
      removed: results.filter((r) => r.outcome === 'gone' || r.outcome === 'refused').length,
      failed: results.filter((r) => r.outcome === 'failed' || r.outcome === 'rejected').length,
    };
  }

  private account(folder: string, id: string, result: PushResult): void {
    if (result.outcome === 'sent') {
      this.rejections.delete(id);
      return;
    }
    // the endpoint is only ever named by its hash, and what the push service said is a few words of its own (never what we sent)
    this.deps.log.warn({ folder, endpoint: id, outcome: result.outcome, status: result.status, detail: result.detail }, 'notify: a push did not go through');
    if (result.outcome === 'gone' || result.outcome === 'refused') return this.remove(folder, id, result.outcome);
    if (result.outcome === 'rejected') {
      const count = (this.rejections.get(id) ?? 0) + 1;
      this.rejections.set(id, count);
      if (count >= REJECTIONS_BEFORE_REMOVAL) this.remove(folder, id, `rejected ${count} times`);
    }
  }

  private remove(folder: string, id: string, why: string): void {
    this.rejections.delete(id);
    try {
      if (this.deps.prefs.removePush(folder, id).removed) this.deps.log.info({ folder, endpoint: id, why }, 'notify: a subscription was removed');
    } catch (err) {
      this.deps.log.warn({ folder, endpoint: id, err: String((err as Error)?.message).slice(0, 120) }, 'notify: a subscription could not be removed');
    }
  }
}
