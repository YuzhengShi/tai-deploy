/**
 * Puts the rules of core.ts to work for the web channel: it is told of every message the student sends (the clock of a reply starts) and of
 * everything TAi sends out (src/channels/web.ts calls its listeners from `push`, the one place all web output passes), and decides, for each
 * message of TAi's to a student, whether to tell that student by other means than the page. It never delays or fails a message: it runs on the
 * listener's own call stack for as long as it takes to read a small file and a few maps, hands the sending to the next turn of the event
 * loop, and catches everything.
 *
 * A NotifyChannel is one way of telling a student (a browser push now, e-mail next): it says whether this student has it switched on and how to
 * deliver one notification. The rules decide once per message, whatever channels the student has; a channel that is switched off for a student
 * is skipped, and one that fails does not stop the others. The daily limit counts messages, not channels.
 */
import crypto from 'node:crypto';

import { STUDENT_FOLDER } from '../portal/history.js';
import type { Prefs } from '../portal/prefs.js';
import { DailyCounts, Episodes, Recent, decide, localTime, type Kind, type PageState, type Rules } from './core.js';

/** What a student is told. The default says only that there is something: nothing a student wrote or TAi wrote leaves this server unless the operator allows a preview. */
export interface NotifyMessage {
  title: string;
  body: string;
}

export const GENERIC_MESSAGE: NotifyMessage = { title: 'TAi', body: 'TAi has a new message' };

export interface NotifyJob {
  folder: string;
  /** The messages this notification stands for (one, or several that were held for the end of quiet hours): `${bootId}:${seq}` of each. */
  ids: string[];
  kind: Kind;
  urgency: 'normal' | 'high';
  /** Seconds that a message may wait for a device that is off. */
  ttl: number;
  message: NotifyMessage;
  /** The student's preferences as they are now (read just before delivery). */
  prefs: Prefs;
}

export interface ChannelOutcome {
  delivered: number;
  removed?: number;
  failed?: number;
}

/** A message TAi wrote to a student on its own (never a reply), as a channel with its own rules is told of it. It carries no words: only when. */
export interface OwnMessage {
  folder: string;
  id: string;
  at: number;
}

export interface NotifyChannel {
  readonly name: string;
  /**
   * `rules` (the default): the channel is told by `deliver` when the rules of core.ts decide to push a message (the browser push is one).
   * `own`: the channel has rules and a clock of its own (e-mail waits an hour and sends one a day): it is never given `deliver` by the rules; it hears of
   * every message TAi writes on its own through `noticed`, of what the other channels delivered through `delivered`, and is called by `sweep`.
   */
  readonly mode?: 'rules' | 'own';
  /** Whether this student has the channel on (and something to deliver to). */
  wants(prefs: Prefs): boolean;
  /** Tells the student. May reject: the notifier logs it and goes on to the next channel. */
  deliver(job: NotifyJob): Promise<ChannelOutcome>;
  /** `own` channels: a message TAi wrote on its own to a student who has this channel on (whether or not it was pushed). */
  noticed?(message: OwnMessage): void;
  /** `own` channels: another channel delivered this message (`id`) to the student. */
  delivered?(folder: string, id: string, by: string): void;
  /** `own` channels: called with the notifier's sweep, every half minute or so. */
  sweep?(now: number): void;
}

export interface PageProbe {
  state(folder: string): PageState;
  /** When a page of this student was last in front (ms since the epoch; now if one is; 0: never). */
  lastVisibleAt(folder: string): number;
}

export interface NotifyLog {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/** What the web channel hands its listeners (src/channels/web.ts, OutboxEntry): only what is read here. */
export interface OutboundLike {
  kind: string;
  jid: string;
  text?: string;
  caption?: string;
  typing?: boolean;
  seq?: number;
}

export interface NotifierDeps {
  rules: Rules;
  prefs: { read(folder: string): Prefs };
  channels: NotifyChannel[];
  page: PageProbe;
  log: NotifyLog;
  /** Put the first characters of a message in the notification (TAI_PUSH_PREVIEW=1). Off: the generic message. */
  preview?: boolean;
  /** Names the process that numbered the messages, so a `seq` that starts again after a restart is not mistaken for the same message. */
  bootId?: string;
  now?: () => number;
  /** Runs the sending off the caller's stack. Default: the next turn of the event loop. */
  schedule?: (run: () => void) => void;
}

/** The start of a message as a line of plain words for a lock screen: markup taken off, cut at a word, about 80 characters. */
export function previewOf(text: string, max = 80): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-]+$/, '')}…`;
}

const errorText = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 160);

interface Held {
  /** When the newest message that is held arrived: a student who has looked since has seen them all. */
  since: number;
  until: number;
  held: number;
  ids: string[];
}

export class Notifier {
  private readonly episodes: Episodes;
  private readonly recent = new Recent();
  private readonly counts = new DailyCounts();
  private readonly held = new Map<string, Held>();
  private readonly now: () => number;
  private readonly schedule: (run: () => void) => void;
  private fallbackSeq = 0;

  constructor(private readonly deps: NotifierDeps) {
    this.episodes = new Episodes(deps.rules);
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((run) => void setImmediate(run));
  }

  /** The student handed TAi a message (typed, tapped, spoken as a note, or the emoji that TAi answers): the clock of the reply starts. */
  studentMessage(folder: string): void {
    try {
      this.episodes.studentMessage(folder, this.now());
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'notify: could not note a message of a student');
    }
  }

  /** Everything the web channel sends out; the one call that decides. Never throws. */
  outbound(entry: OutboundLike): void {
    try {
      this.handle(entry);
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'notify: could not look at a message');
    }
  }

  private handle(entry: OutboundLike): void {
    if (!entry.jid.startsWith('web:')) return;
    const folder = entry.jid.slice(4);
    if (!STUDENT_FOLDER.test(folder)) return;                 // the owner's admin chat, the evaluation's and the smoke tests' chats are nobody's to push to
    const now = this.now();
    if (entry.kind === 'typing') return this.episodes.typing(folder, entry.typing === true, now);
    if (entry.kind !== 'text' && entry.kind !== 'image') return;
    const text = (entry.kind === 'text' ? entry.text : entry.caption) ?? '';
    if (entry.kind === 'text' && !text.trim()) return;

    const classified = this.episodes.classify(folder, now);
    const kind: Kind = classified.kind;
    const prefs = this.deps.prefs.read(folder);
    const wanting = this.deps.channels.filter((channel) => channel.wants(prefs));
    if (wanting.length === 0) return;                                              // this student has nothing to be told by

    const tz = prefs.tz;
    const day = localTime(now, tz || this.deps.rules.defaultTz).day;
    const seq = entry.seq ?? ++this.fallbackSeq;
    const id = `${this.deps.bootId ?? ''}:${seq}`;
    const duplicate =
      this.recent.check(`${folder}:${id}`, now) ||
      (kind === 'proactive' && this.recent.check(`${folder}:text:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}`, now));
    // a channel with rules of its own (e-mail) hears of every message TAi writes on its own, whether or not the push rules send it
    if (kind === 'proactive' && !duplicate) {
      for (const channel of wanting) {
        try {
          channel.noticed?.({ folder, id, at: now });
        } catch (err) {
          this.deps.log.warn({ folder, channel: channel.name, err: errorText(err) }, 'notify: a channel could not note a message');
        }
      }
    }
    if (!wanting.some((channel) => (channel.mode ?? 'rules') === 'rules')) return;
    const decision = decide(
      {
        kind,
        page: this.deps.page.state(folder),
        now,
        tz,
        waitedMs: classified.kind === 'reply' ? classified.waitedMs : undefined,
        episodePushed: classified.kind === 'reply' ? classified.episode.pushed : undefined,
        sentToday: this.counts.count(folder, day),
        duplicate,
      },
      this.deps.rules,
    );

    if (decision.action === 'skip') {
      this.deps.log.debug({ folder, kind, reason: decision.reason }, 'notify: not pushed');
      return;
    }
    if (decision.action === 'defer') {
      const existing = this.held.get(folder);
      this.held.set(folder, { since: now, until: existing?.until ?? decision.until, held: (existing?.held ?? 0) + 1, ids: [...(existing?.ids ?? []), id].slice(-50) });
      this.deps.log.debug({ folder, until: new Date(decision.until).toISOString() }, 'notify: held for quiet hours');
      return;
    }
    if (classified.kind === 'reply') classified.episode.pushed = true;
    else this.counts.bump(folder, day);
    const message = this.deps.preview && text.trim() && previewOf(text) ? { title: GENERIC_MESSAGE.title, body: previewOf(text) } : GENERIC_MESSAGE;
    this.dispatch(folder, kind, decision.urgency, decision.ttl, message, [id]);
  }

  /** The end of quiet hours: one push for what was held, to a student who has not looked since and whose limit for the day allows it. Called every half minute or so. */
  sweep(): void {
    try {
      const now = this.now();
      this.episodes.prune(now);
      for (const [folder, held] of [...this.held]) {
        if (held.until > now) continue;
        this.held.delete(folder);
        this.release(folder, held, now);
      }
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'notify: sweep failed');
    }
    for (const channel of this.deps.channels) {
      try {
        channel.sweep?.(this.now());
      } catch (err) {
        this.deps.log.warn({ channel: channel.name, err: errorText(err) }, 'notify: a channel could not sweep');
      }
    }
  }

  private release(folder: string, held: Held, now: number): void {
    if (this.deps.page.lastVisibleAt(folder) >= held.since) {
      this.deps.log.debug({ folder }, 'notify: the student has looked since, nothing to push');
      return;
    }
    const prefs = this.deps.prefs.read(folder);
    if (!this.deps.channels.some((channel) => channel.wants(prefs))) return;
    const tz = prefs.tz;
    const day = localTime(now, tz || this.deps.rules.defaultTz).day;
    const decision = decide({ kind: 'proactive', page: this.deps.page.state(folder), now, tz, sentToday: this.counts.count(folder, day), due: true }, this.deps.rules);
    if (decision.action !== 'send') {
      this.deps.log.debug({ folder, reason: decision.action === 'skip' ? decision.reason : decision.action }, 'notify: held message not pushed');
      return;
    }
    this.counts.bump(folder, day);
    this.dispatch(folder, 'proactive', decision.urgency, decision.ttl, GENERIC_MESSAGE, held.ids);      // never a preview: it stands for several, and for hours ago
  }

  /** How many students have a message held for the end of quiet hours (for the tests). */
  heldCount(): number {
    return this.held.size;
  }

  private dispatch(folder: string, kind: Kind, urgency: 'normal' | 'high', ttl: number, message: NotifyMessage, ids: string[]): void {
    this.schedule(() => {
      void this.deliver(folder, kind, urgency, ttl, message, ids).catch((err) => this.deps.log.warn({ folder, err: errorText(err) }, 'notify: delivery failed'));
    });
  }

  private async deliver(folder: string, kind: Kind, urgency: 'normal' | 'high', ttl: number, message: NotifyMessage, ids: string[]): Promise<void> {
    const prefs = this.deps.prefs.read(folder);              // as it is now: a browser taken off a moment ago is not written to
    for (const channel of this.deps.channels) {
      if ((channel.mode ?? 'rules') !== 'rules' || !channel.wants(prefs)) continue;      // a channel with its own rules (e-mail) is not given what the push rules decided
      try {
        const outcome = await channel.deliver({ folder, ids, kind, urgency, ttl, message, prefs });
        this.deps.log.info({ folder, channel: channel.name, kind, ...outcome }, 'notify: sent');
        if (outcome.delivered > 0) {
          for (const other of this.deps.channels) {
            for (const id of ids) {
              try {
                other.delivered?.(folder, id, channel.name);
              } catch {
                /* what another channel does with the news is its own affair */
              }
            }
          }
        }
      } catch (err) {
        this.deps.log.warn({ folder, channel: channel.name, kind, err: errorText(err) }, 'notify: a channel failed');
      }
    }
  }
}
