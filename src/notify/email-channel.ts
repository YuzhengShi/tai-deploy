/**
 * The e-mail channel of the notifier: a short plain-text note, to a student who turned it on, about messages TAi wrote on its own and that nobody
 * has looked at. It has rules and a clock of its own (NotifyChannel `mode: 'own'`), so it is not given what the push rules decide:
 *
 *   - it hears (`noticed`) of every message TAi writes to a student on its own, never of a reply, whether or not a push was sent for it;
 *   - it hears (`delivered`) when a push for a message was delivered, and then leaves that message alone;
 *   - at each sweep it decides (decideEmail, core.ts): the message must still be unseen an hour after TAi wrote it (a page of the student's in front
 *     at any moment since counts as seen), it must not have been pushed, and the student must not have had their one e-mail of the day;
 *   - a mail that could not be sent, for a reason that may pass (the connection failed, a timeout, a 4xx answer: the client has tried twice already), is
 *     held again and tried an hour later, at most three tries in all and none scheduled later than three hours after the first; a refusal that will not
 *     pass (a 5xx answer, a refused login, a certificate) is not repeated, as RFC 5321 asks and so that a wrong password is not tried for every student.
 *
 * WHO it goes to: only the address the student signed in with, which `recipientOf` reads from the allowlist by the student's folder. No request, no
 * preference, no word of a message is ever an address; `prefs` is read for one thing, whether the student switched e-mail on.
 *
 * WHAT it says is generic, on purpose: e-mail crosses mail providers in the clear and stays in mailboxes for years, so it carries no word of any message,
 * no name, no figure, nothing that tracks (no pixel, no personal link, no unsubscribe address): a subject, the page's own address, and one line about how
 * to stop, which is the switch in Settings.
 */
import type { Prefs } from '../portal/prefs.js';
import { DEFAULT_EMAIL_RULES, DailyCounts, decideEmail, localTime, type EmailRules, type HeldMessage } from './core.js';
import type { ChannelOutcome, NotifyChannel, NotifyLog, OwnMessage, PageProbe } from './notifier.js';
import type { MailSender, SmtpResult } from './smtp.js';

export const EMAIL_SUBJECT = 'TAi has a message for you';

/** The body: plain ASCII text, the page's address (where the message is) and how to stop. */
export function emailBody(pageUrl: string): string {
  return [
    'TAi has written to you in the CS6650 chat, and you have not opened it yet.',
    '',
    'Read it here:',
    pageUrl,
    '',
    'You get this because you turned on email in TAi\'s Settings (account menu, then Settings). To stop, turn "Email me when I miss a message" off there.',
    '',
  ].join('\n');
}

export interface EmailChannelDeps {
  mailer: MailSender;
  /** The student's own sign-in address from the allowlist, by their folder (undefined: not on it). The only source of an address. */
  recipientOf(folder: string): string | undefined;
  prefs: { read(folder: string): Prefs };
  page: Pick<PageProbe, 'lastVisibleAt'>;
  /** The page's address, as the link in the mail. */
  pageUrl: string;
  rules?: EmailRules;
  /** The zone of a student who has not told us theirs (the day of the daily limit is theirs). */
  defaultTz: string;
  log: NotifyLog;
  now?: () => number;
}

/** What is kept for a student: at most this many messages (older ones are of no use: the rules forget a day-old message anyway). */
const MAX_HELD = 50;
/** A mail that failed in a way that may pass: tried again this long after (ms), three tries in all, and no try is scheduled later than the span after the first. */
const RETRY_EVERY_MS = 60 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_SPAN_MS = 3 * 60 * 60_000;

/** Where a student's mail stands after a failure: the tries made, when the first was, and the earliest moment for the next. */
interface Retry {
  attempts: number;
  first: number;
  notBefore: number;
}

export class EmailChannel implements NotifyChannel {
  readonly name = 'email';
  readonly mode = 'own' as const;
  private readonly held = new Map<string, HeldMessage[]>();
  private readonly retries = new Map<string, Retry>();
  private readonly counts = new DailyCounts();
  private readonly rules: EmailRules;
  private readonly now: () => number;

  constructor(private readonly deps: EmailChannelDeps) {
    this.rules = deps.rules ?? DEFAULT_EMAIL_RULES;
    this.now = deps.now ?? Date.now;
  }

  wants(prefs: Prefs): boolean {
    return prefs.notify.email.enabled === true;
  }

  /** Never given a message by the push rules (mode `own`); present because a channel has one. */
  async deliver(): Promise<ChannelOutcome> {
    return { delivered: 0 };
  }

  noticed(message: OwnMessage): void {
    const list = this.held.get(message.folder) ?? [];
    list.push({ id: message.id, at: message.at, pushed: false });
    this.held.set(message.folder, list.slice(-MAX_HELD));
  }

  delivered(folder: string, id: string, by: string): void {
    if (by === this.name) return;
    const found = this.held.get(folder)?.find((m) => m.id === id);
    if (found) found.pushed = true;
  }

  /** Looks at what is held, for every student: decides, and sends (or lets go) when it is time. Never throws; the sending is not waited for. */
  sweep(now: number = this.now()): void {
    for (const [folder, messages] of [...this.held]) {
      try {
        const prefs = this.deps.prefs.read(folder);
        if (!this.wants(prefs)) {
          this.held.delete(folder);                           // they turned it off since
          this.retries.delete(folder);
          continue;
        }
        const retry = this.retries.get(folder);
        if (retry && now < retry.notBefore) continue;         // a mail that failed waits for its next try, not for the next sweep
        const day = localTime(now, prefs.tz || this.deps.defaultTz).day;
        const decision = decideEmail({ now, messages, lastVisibleAt: this.deps.page.lastVisibleAt(folder), sentToday: this.counts.count(folder, day) }, this.rules);
        if (decision.action === 'wait') continue;
        this.held.delete(folder);
        if (decision.action === 'skip') {
          this.retries.delete(folder);
          this.deps.log.debug({ folder, channel: this.name, reason: decision.reason }, 'notify: no e-mail');
          continue;
        }
        const to = this.deps.recipientOf(folder);
        if (!to) {
          this.retries.delete(folder);
          this.deps.log.debug({ folder, channel: this.name }, 'notify: no e-mail, the student is not on the list');
          continue;
        }
        this.send(folder, to, day, now, messages.filter((m) => decision.ids.includes(m.id))).catch((err) =>
          this.deps.log.warn({ folder, channel: this.name, err: String((err as Error)?.message ?? err).slice(0, 120) }, 'notify: the e-mail could not be sent'),
        );
      } catch (err) {
        this.deps.log.warn({ folder, channel: this.name, err: String((err as Error)?.message ?? err).slice(0, 120) }, 'notify: the e-mail channel could not look at a student');
      }
    }
  }

  /** Sends the mail for `batch` (what the sweep, at `at`, found unseen). A failure that may pass holds the batch again; nothing here throws. */
  private async send(folder: string, to: string, day: string, at: number, batch: HeldMessage[]): Promise<void> {
    let result: SmtpResult;
    try {
      result = await this.deps.mailer.send({ to, subject: EMAIL_SUBJECT, text: emailBody(this.deps.pageUrl) });
    } catch (err) {
      this.deps.log.warn({ folder, channel: this.name, err: String((err as Error)?.message ?? err).slice(0, 120) }, 'notify: the e-mail could not be sent');
      this.tryAgainLater(folder, batch, at);                  // a sender that throws says nothing of why: it may pass
      return;
    }
    if (result.ok) {
      this.retries.delete(folder);
      this.counts.bump(folder, day);                          // counted when it went: a mail server that is down does not use up the student's day
      this.deps.log.info({ folder, channel: this.name, kind: 'proactive', delivered: 1 }, 'notify: sent');
      return;
    }
    this.deps.log.warn({ folder, channel: this.name, stage: result.stage, transient: result.transient }, 'notify: the e-mail could not be sent');
    if (result.transient) this.tryAgainLater(folder, batch, at);
    else this.retries.delete(folder);                         // a refusal that will not pass is not repeated
  }

  /**
   * A mail that could not go, for a reason that may pass: what it was about is held again, to be tried an hour later: three tries at most, and none
   * scheduled more than three hours after the first. Then it is forgotten (what TAi writes later starts again). Messages that came in while it was
   * being sent are kept as they are, behind the ones that failed.
   */
  private tryAgainLater(folder: string, batch: HeldMessage[], at: number): void {
    const before = this.retries.get(folder);
    const attempts = (before?.attempts ?? 0) + 1;
    const first = before?.first ?? at;
    const notBefore = at + RETRY_EVERY_MS;
    if (attempts >= MAX_ATTEMPTS || notBefore - first > RETRY_SPAN_MS) {
      this.retries.delete(folder);
      this.deps.log.warn({ folder, channel: this.name, attempts }, 'notify: the e-mail was given up on');
      return;
    }
    this.retries.set(folder, { attempts, first, notBefore });
    const failed = new Set(batch.map((m) => m.id));
    const newer = (this.held.get(folder) ?? []).filter((m) => !failed.has(m.id));
    this.held.set(folder, [...batch, ...newer].slice(-MAX_HELD));
  }

  /** How many students have something held (for the tests). */
  heldCount(): number {
    return this.held.size;
  }
}
