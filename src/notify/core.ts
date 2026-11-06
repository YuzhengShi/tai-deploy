/**
 * When a push is sent, as pure functions and small state machines (no clock of their own, no files, no network): `decide` for one message,
 * `Episodes` for telling a reply to a student from TAi writing on its own, `Recent` for the same message twice, `DailyCounts` for the
 * limit per day. src/notify/notifier.ts puts them to work; the tests here run every rule on a fake clock.
 *
 * The rules (docs/NOTIFICATIONS.md says them again in words for the owner):
 *  1. Never while the student's page is open and in front: the message is on the screen they are looking at (the page tells the server
 *     whether it is in front with every poll, src/notify/presence.ts).
 *  2. A message TAi sends on its own (the patrol, a reminder the student asked for) is pushed when the page is not in front, unless it is
 *     quiet hours in the student's time zone (22:00 to 08:00; then one push follows when they end, if the student has not looked since), and
 *     at most three a day by the student's own calendar.
 *  3. The reply to something the student wrote is pushed when the page is not in front and the student waited at least 20 seconds for it,
 *     once per message of theirs. Quiet hours and the daily limit are for TAi's own messages: a reply is never held.
 *  4. The same message is never pushed twice.
 */

export type PageState = 'visible' | 'hidden' | 'closed';
/** `reply`: an answer to a message of the student's. `proactive`: TAi writing on its own. */
export type Kind = 'reply' | 'proactive';

export interface Rules {
  /** Quiet hours as minutes after local midnight; equal values mean there are none. */
  quietStart: number;
  quietEnd: number;
  /** Pushes of TAi's own messages per student per local day; 0: none at all. */
  dailyMax: number;
  /** A reply is pushed only when the student waited at least this long (ms). */
  replyAfterMs: number;
  /** A student's message is answered within this long (ms); what TAi says later than that is its own doing, not an answer. */
  replyWindowMs: number;
  /** After TAi stops typing, a message that belongs to the same answer may still arrive (the IPC watcher polls once a second): this long (ms). */
  replyGraceMs: number;
  /** The time zone of a student who has not told us theirs. The course keeps Pacific time: Los Angeles, not Vancouver (the app's "Pacific"). */
  defaultTz: string;
}

export const DEFAULT_RULES: Rules = {
  quietStart: 22 * 60,
  quietEnd: 8 * 60,
  dailyMax: 3,
  replyAfterMs: 20_000,
  replyWindowMs: 20 * 60_000,
  replyGraceMs: 5_000,
  defaultTz: 'America/Los_Angeles',
};

/** How long a push service keeps a message for a device that is off: a reply is stale quickly, a reminder is read whenever the phone is on. */
export const REPLY_TTL_SECONDS = 30 * 60;
export const PROACTIVE_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------- local time

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, format);
  }
  return format;
}

/** The calendar day ("2026-11-05") and the minute of the day (0 to 1439) that an instant is in a time zone. */
export function localTime(ms: number, tz: string): { day: string; minutes: number } {
  const part: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(ms)) part[p.type] = p.value;
  return { day: `${part.year}-${part.month}-${part.day}`, minutes: Number(part.hour) * 60 + Number(part.minute) };
}

/** Whether a minute of the day is in quiet hours, which may run across midnight (22:00 to 08:00). Equal bounds: never. */
export function inQuietHours(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * The next instant at which the local clock reads the end of quiet hours. The first guess assumes a day of the same length; a change of the
 * clocks in between (daylight saving) moves it by the hour it changed, so it is corrected until the local time is right.
 */
export function nextQuietEnd(nowMs: number, tz: string, rules: Pick<Rules, 'quietEnd'>): number {
  let at = nowMs + (((rules.quietEnd - localTime(nowMs, tz).minutes + 1440) % 1440) || 1440) * 60_000;
  for (let i = 0; i < 4; i++) {
    const off = rules.quietEnd - localTime(at, tz).minutes;
    const signed = ((off + 1440 + 720) % 1440) - 720;
    if (signed === 0) break;
    at += signed * 60_000;
  }
  return at;
}

// ---------------------------------------------------------------- one decision

export type SkipReason = 'duplicate' | 'page-visible' | 'quick-reply' | 'already-notified' | 'daily-max' | 'off';

export type Decision = { action: 'send'; urgency: 'normal' | 'high'; ttl: number } | { action: 'defer'; until: number } | { action: 'skip'; reason: SkipReason };

export interface Candidate {
  kind: Kind;
  /** Where the student's page is right now. */
  page: PageState;
  now: number;
  /** The student's time zone as they told it; absent: the rules' default. */
  tz?: string;
  /** reply: how long the student has waited (ms). */
  waitedMs?: number;
  /** reply: this answer has been pushed already (a long answer comes in several messages). */
  episodePushed?: boolean;
  /** proactive: pushes already sent on the student's local day. */
  sentToday?: number;
  /** The same message was seen a moment ago. */
  duplicate?: boolean;
  /** A message that was held for quiet hours and is now due: the quiet hours are not asked about again. */
  due?: boolean;
}

export function decide(c: Candidate, rules: Rules): Decision {
  if (c.duplicate) return { action: 'skip', reason: 'duplicate' };
  if (c.page === 'visible') return { action: 'skip', reason: 'page-visible' };
  if (c.kind === 'reply') {
    if (c.episodePushed) return { action: 'skip', reason: 'already-notified' };
    if ((c.waitedMs ?? 0) < rules.replyAfterMs) return { action: 'skip', reason: 'quick-reply' };
    return { action: 'send', urgency: 'high', ttl: REPLY_TTL_SECONDS };
  }
  if (rules.dailyMax <= 0) return { action: 'skip', reason: 'off' };
  const tz = c.tz || rules.defaultTz;
  if (!c.due && inQuietHours(localTime(c.now, tz).minutes, rules.quietStart, rules.quietEnd)) return { action: 'defer', until: nextQuietEnd(c.now, tz, rules) };
  if ((c.sentToday ?? 0) >= rules.dailyMax) return { action: 'skip', reason: 'daily-max' };
  return { action: 'send', urgency: 'normal', ttl: PROACTIVE_TTL_SECONDS };
}

// ---------------------------------------------------------------- replies and TAi's own messages

export interface Episode {
  /** When the student's oldest message that has not been answered was handed to TAi. */
  since: number;
  /** When TAi first answered it. */
  repliedAt?: number;
  /** When TAi stopped typing, plus the grace: after this, nothing more belongs to the answer. */
  endedAt?: number;
  /** A push was sent (or decided against for good) for this answer. */
  pushed: boolean;
}

export type Classified = { kind: 'proactive' } | { kind: 'reply'; waitedMs: number; episode: Episode };

/**
 * Which messages of TAi's are answers. A student's message opens an episode; TAi's typing indicator going off closes it a few seconds
 * later (a message of the same answer may still be on its way through the IPC watcher), and so does 20 minutes of silence; a message
 * that comes outside an episode is TAi's own. The student's message is handed to TAi by src/portal (the clock starts there: typed words, a
 * tap on an option, a voice note, the emoji that TAi answers), and the typing indicator is the one the page shows.
 */
export class Episodes {
  private readonly byFolder = new Map<string, Episode>();

  constructor(private readonly rules: Pick<Rules, 'replyWindowMs' | 'replyGraceMs'>) {}

  private open(e: Episode, now: number): boolean {
    return now - e.since <= this.rules.replyWindowMs && (e.endedAt === undefined || now <= e.endedAt);
  }

  studentMessage(folder: string, now: number): void {
    const e = this.byFolder.get(folder);
    // an earlier message of theirs is still waiting for its answer: the wait counts from that one
    if (e && e.repliedAt === undefined && this.open(e, now)) {
      e.endedAt = undefined;
      return;
    }
    this.byFolder.set(folder, { since: now, pushed: false });
  }

  typing(folder: string, on: boolean, now: number): void {
    const e = this.byFolder.get(folder);
    if (!e) return;
    if (!on) e.endedAt = now + this.rules.replyGraceMs;
    else if (this.open(e, now)) e.endedAt = undefined;          // (typing that starts after the episode is over answers nothing: a student's message always comes first)
  }

  classify(folder: string, now: number): Classified {
    const e = this.byFolder.get(folder);
    if (!e) return { kind: 'proactive' };
    if (!this.open(e, now)) {
      this.byFolder.delete(folder);
      return { kind: 'proactive' };
    }
    e.repliedAt ??= now;
    return { kind: 'reply', waitedMs: now - e.since, episode: e };
  }

  /** Forgets the episodes that are over (called now and then; an episode that is not asked about costs a few bytes until then). */
  prune(now: number): void {
    for (const [folder, e] of this.byFolder) if (!this.open(e, now)) this.byFolder.delete(folder);
  }

  size(): number {
    return this.byFolder.size;
  }
}

// ---------------------------------------------------------------- the same message twice

/** Keys seen in the last ten minutes: `check` says whether one was already there, and remembers it either way. */
export class Recent {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 2000,
  ) {}

  check(key: string, now: number): boolean {
    const at = this.seen.get(key);
    const again = at !== undefined && now - at <= this.ttlMs;
    this.seen.delete(key);                            // re-inserted last, so the map stays in order of time
    this.seen.set(key, now);
    if (this.seen.size > this.max) {
      for (const [k, t] of this.seen) {
        if (now - t > this.ttlMs || this.seen.size > this.max) this.seen.delete(k);
        else break;
      }
    }
    return again;
  }
}

// ---------------------------------------------------------------- the limit per day

/** Pushes counted per student and per local calendar day (the count of a day that is over is forgotten the next time that student is asked). */
export class DailyCounts {
  private readonly counts = new Map<string, { day: string; count: number }>();

  count(folder: string, day: string): number {
    const c = this.counts.get(folder);
    return c && c.day === day ? c.count : 0;
  }

  bump(folder: string, day: string): number {
    const c = this.counts.get(folder);
    const next = c && c.day === day ? c.count + 1 : 1;
    this.counts.set(folder, { day, count: next });
    return next;
  }
}

// ---------------------------------------------------------------- e-mail: slower, rarer, and only for what nobody has seen

export interface EmailRules {
  /** A message that nobody has looked at this long (ms) after TAi wrote it is worth an e-mail. */
  afterMs: number;
  /** E-mails per student per local day; 0: none at all. */
  dailyMax: number;
  /** A message older than this (ms) is not written about any more (an e-mail the next day about last night's message is no help). */
  staleMs: number;
}

export const DEFAULT_EMAIL_RULES: EmailRules = { afterMs: 60 * 60_000, dailyMax: 1, staleMs: 24 * 60 * 60_000 };

/** A message TAi wrote to a student on its own, as the e-mail channel holds it until it is time to decide. */
export interface HeldMessage {
  id: string;
  at: number;
  /** A push for this message was delivered. */
  pushed: boolean;
}

export type EmailSkip = 'off' | 'seen' | 'pushed' | 'stale' | 'daily-max';

export type EmailDecision = { action: 'send'; ids: string[] } | { action: 'wait'; until: number } | { action: 'skip'; reason: EmailSkip };

/**
 * Whether to e-mail a student about the messages TAi wrote to them on its own (never replies: the channel is only ever told of those). A message
 * counts as seen once a page of theirs was in front at any moment after it was written (`lastVisibleAt`: a page that is open behind other tabs has
 * not been looked at); one that was pushed (delivered) has been told already. What is left must be `afterMs` old, counted from the oldest of
 * it, and the student must not have had their e-mail for the day. One e-mail then stands for everything that was unseen.
 */
export function decideEmail(c: { now: number; messages: HeldMessage[]; lastVisibleAt: number; sentToday: number }, rules: EmailRules): EmailDecision {
  if (rules.dailyMax <= 0) return { action: 'skip', reason: 'off' };
  const unseen = c.messages.filter((m) => m.at > c.lastVisibleAt);
  if (unseen.length === 0) return { action: 'skip', reason: 'seen' };
  const unpushed = unseen.filter((m) => !m.pushed);
  if (unpushed.length === 0) return { action: 'skip', reason: 'pushed' };
  const fresh = unpushed.filter((m) => c.now - m.at <= rules.staleMs);
  if (fresh.length === 0) return { action: 'skip', reason: 'stale' };
  const due = Math.min(...fresh.map((m) => m.at)) + rules.afterMs;
  if (c.now < due) return { action: 'wait', until: due };
  if (c.sentToday >= rules.dailyMax) return { action: 'skip', reason: 'daily-max' };
  return { action: 'send', ids: unseen.map((m) => m.id) };
}
