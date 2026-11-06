/** The rules of when a push is sent, on a fake clock: quiet hours across a zone and across daylight saving, the daily limit, duplicates, a page in front, a reply or TAi's own message. */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EMAIL_RULES,
  DEFAULT_RULES,
  DailyCounts,
  Episodes,
  PROACTIVE_TTL_SECONDS,
  REPLY_TTL_SECONDS,
  Recent,
  decide,
  decideEmail,
  inQuietHours,
  localTime,
  nextQuietEnd,
  type Candidate,
  type Rules,
} from './core.js';

const at = (iso: string) => Date.parse(iso);
const rules: Rules = { ...DEFAULT_RULES };

describe('local time', () => {
  it('is the day and the minute of the day that an instant is in a zone, midnight as 00:00', () => {
    expect(localTime(at('2026-11-05T07:59:00Z'), 'America/Los_Angeles')).toEqual({ day: '2026-11-04', minutes: 23 * 60 + 59 });
    expect(localTime(at('2026-11-05T08:00:00Z'), 'America/Los_Angeles')).toEqual({ day: '2026-11-05', minutes: 0 });
    expect(localTime(at('2026-11-05T12:00:00Z'), 'Asia/Tokyo')).toEqual({ day: '2026-11-05', minutes: 21 * 60 });
    expect(localTime(at('2026-11-05T12:30:00Z'), 'UTC')).toEqual({ day: '2026-11-05', minutes: 12 * 60 + 30 });
    expect(localTime(at('2026-11-05T23:59:00Z'), 'Pacific/Kiritimati')).toEqual({ day: '2026-11-06', minutes: 13 * 60 + 59 });
  });

  it('follows the clocks changing: the same wall time is a different instant before and after', () => {
    // (Los Angeles, whose rules have been the same since 2007. Vancouver is not used here: British Columbia has stopped changing its clocks, and
    // what a given Node's time zone data says about it depends on how new that Node is)
    expect(localTime(at('2026-10-31T15:00:00Z'), 'America/Los_Angeles').minutes).toBe(8 * 60);       // PDT, UTC-7
    expect(localTime(at('2026-11-01T16:00:00Z'), 'America/Los_Angeles').minutes).toBe(8 * 60);       // PST, UTC-8
    expect(localTime(at('2026-11-01T09:00:00Z'), 'America/Los_Angeles').minutes).toBe(60);           // 2:00 PDT is 1:00 PST: the hour repeats
  });
});

describe('quiet hours', () => {
  it('run across midnight from 22:00 to 08:00 and include the start but not the end', () => {
    const q = (minutes: number) => inQuietHours(minutes, 22 * 60, 8 * 60);
    expect([q(22 * 60 - 1), q(22 * 60), q(23 * 60 + 59), q(0), q(3 * 60), q(8 * 60 - 1), q(8 * 60), q(12 * 60)]).toEqual([false, true, true, true, true, true, false, false]);
  });

  it('can be inside one day, and equal bounds mean there are none', () => {
    expect([inQuietHours(12 * 60 + 59, 13 * 60, 14 * 60), inQuietHours(13 * 60, 13 * 60, 14 * 60), inQuietHours(14 * 60, 13 * 60, 14 * 60)]).toEqual([false, true, false]);
    for (const minutes of [0, 480, 1320, 1439]) expect(inQuietHours(minutes, 480, 480)).toBe(false);
  });

  it('end, the next time, at 08:00 by the student\'s clock: tomorrow\'s from the evening, today\'s from the small hours', () => {
    expect(new Date(nextQuietEnd(at('2026-11-05T07:30:00Z'), 'America/Los_Angeles', rules)).toISOString()).toBe('2026-11-05T16:00:00.000Z');      // 23:30 PST
    expect(new Date(nextQuietEnd(at('2026-11-05T09:45:00Z'), 'America/Los_Angeles', rules)).toISOString()).toBe('2026-11-05T16:00:00.000Z');      // 01:45 PST
    expect(new Date(nextQuietEnd(at('2026-11-05T12:00:00Z'), 'Asia/Tokyo', rules)).toISOString()).toBe('2026-11-05T23:00:00.000Z');              // 21:00 JST: 08:00 JST is 23:00 UTC
  });

  it('end at 08:00 on the clock when the clocks change in between (autumn: an hour later in UTC; spring: an hour earlier)', () => {
    // 22:00 PDT on 31 October; the clocks go back at 02:00 on 1 November, so 08:00 is 16:00 UTC (a day of 25 hours)
    expect(new Date(nextQuietEnd(at('2026-11-01T05:00:00Z'), 'America/Los_Angeles', rules)).toISOString()).toBe('2026-11-01T16:00:00.000Z');
    // 22:00 PST on 7 March; the clocks go forward at 02:00 on 8 March, so 08:00 is 15:00 UTC (a day of 23 hours)
    expect(new Date(nextQuietEnd(at('2026-03-08T06:00:00Z'), 'America/Los_Angeles', rules)).toISOString()).toBe('2026-03-08T15:00:00.000Z');
    for (const [from, tz] of [['2026-11-01T05:00:00Z', 'America/Los_Angeles'], ['2026-03-08T06:00:00Z', 'America/Denver'], ['2026-10-25T21:30:00Z', 'Europe/London'], ['2026-04-04T14:00:00Z', 'Australia/Sydney']] as const) {
      const end = nextQuietEnd(at(from), tz, rules);
      expect(localTime(end, tz).minutes, `${from} ${tz}`).toBe(8 * 60);
      expect(end).toBeGreaterThan(at(from));
      expect(end - at(from)).toBeLessThanOrEqual(26 * 3600_000);
    }
  });
});

const base: Candidate = { kind: 'proactive', page: 'closed', now: at('2026-11-05T18:00:00Z'), tz: 'America/Los_Angeles', sentToday: 0 };       // 10:00 in Los Angeles

describe('the page in front, and a message twice', () => {
  it('is never pushed to while the student is looking at the page, whatever it is', () => {
    expect(decide({ ...base, page: 'visible' }, rules)).toEqual({ action: 'skip', reason: 'page-visible' });
    expect(decide({ ...base, kind: 'reply', waitedMs: 120_000, page: 'visible' }, rules)).toEqual({ action: 'skip', reason: 'page-visible' });
    expect(decide({ ...base, now: at('2026-11-05T07:00:00Z'), page: 'visible' }, rules)).toEqual({ action: 'skip', reason: 'page-visible' });      // not held either: it is on the screen
  });

  it('is pushed to a page that is open but behind another tab, and to one that is closed', () => {
    expect(decide({ ...base, page: 'hidden' }, rules).action).toBe('send');
    expect(decide({ ...base, page: 'closed' }, rules).action).toBe('send');
    expect(decide({ ...base, kind: 'reply', waitedMs: 30_000, page: 'hidden' }, rules).action).toBe('send');
  });

  it('is pushed once: the same message a second time is skipped, replies and TAi\'s own alike', () => {
    expect(decide({ ...base, duplicate: true }, rules)).toEqual({ action: 'skip', reason: 'duplicate' });
    expect(decide({ ...base, kind: 'reply', waitedMs: 60_000, duplicate: true }, rules)).toEqual({ action: 'skip', reason: 'duplicate' });
  });
});

describe('TAi writing on its own', () => {
  it('is pushed normally, with a day to live', () => {
    expect(decide(base, rules)).toEqual({ action: 'send', urgency: 'normal', ttl: PROACTIVE_TTL_SECONDS });
    expect(PROACTIVE_TTL_SECONDS).toBe(86_400);
  });

  it('is held in quiet hours until they end, by the student\'s own clock', () => {
    const night = { ...base, now: at('2026-11-05T07:00:00Z') };                       // 23:00 in Los Angeles, 00:00 in Denver, 16:00 in Tokyo, 07:00 in London
    expect(decide(night, rules)).toEqual({ action: 'defer', until: at('2026-11-05T16:00:00Z') });
    expect(decide({ ...night, tz: 'America/Denver' }, rules)).toEqual({ action: 'defer', until: at('2026-11-05T15:00:00Z') });
    expect(decide({ ...night, tz: 'America/New_York' }, rules)).toEqual({ action: 'defer', until: at('2026-11-05T13:00:00Z') });        // 02:00 EST
    expect(decide({ ...night, tz: 'Asia/Tokyo' }, rules).action).toBe('send');
    expect(decide({ ...night, tz: 'Asia/Kolkata' }, rules).action).toBe('send');                                                          // 12:30 IST
    expect(decide({ ...night, tz: 'Europe/London' }, rules)).toEqual({ action: 'defer', until: at('2026-11-05T08:00:00Z') });
    expect(decide({ ...night, tz: undefined }, rules)).toEqual({ action: 'defer', until: at('2026-11-05T16:00:00Z') });        // unknown zone: Los Angeles, the course's Pacific
  });

  it('starts being held at 22:00 sharp and is pushed again at 08:00 sharp', () => {
    expect(decide({ ...base, now: at('2026-11-05T05:59:00Z') }, rules).action).toBe('send');         // 21:59 PST
    expect(decide({ ...base, now: at('2026-11-05T06:00:00Z') }, rules).action).toBe('defer');        // 22:00 PST
    expect(decide({ ...base, now: at('2026-11-05T15:59:00Z') }, rules).action).toBe('defer');        // 07:59 PST
    expect(decide({ ...base, now: at('2026-11-05T16:00:00Z') }, rules).action).toBe('send');         // 08:00 PST
  });

  it('is held by the clock that is in force: the same UTC time is quiet on one side of the change of the clocks and not on the other', () => {
    // 05:30 UTC: 22:30 PDT on 31 October (quiet), and 21:30 PST (not quiet) a week later after the clocks went back
    expect(decide({ ...base, now: at('2026-10-31T05:30:00Z') }, rules).action).toBe('defer');
    expect(decide({ ...base, now: at('2026-11-02T05:30:00Z') }, rules).action).toBe('send');
    expect(decide({ ...base, now: at('2026-11-01T15:30:00Z') }, rules).action).toBe('defer');        // 07:30 PST on the day the clocks went back
    expect(decide({ ...base, now: at('2026-11-01T16:00:00Z') }, rules).action).toBe('send');
    // spring: 06:30 UTC is 22:30 PST on 7 March (quiet) and 23:30 PDT... on 8 March it is 23:30 PDT at 06:30 UTC the next day
    expect(decide({ ...base, now: at('2026-03-08T14:59:00Z') }, rules).action).toBe('defer');        // 07:59 PDT
    expect(decide({ ...base, now: at('2026-03-08T15:00:00Z') }, rules).action).toBe('send');         // 08:00 PDT
  });

  it('is pushed when a held message falls due, whatever the quiet hours say by then, and is still bound by the day\'s limit', () => {
    const night = { ...base, now: at('2026-11-05T07:00:00Z') };
    expect(decide({ ...night, due: true }, rules).action).toBe('send');
    expect(decide({ ...night, due: true, sentToday: 3 }, rules)).toEqual({ action: 'skip', reason: 'daily-max' });
  });

  it('is limited per day: the fourth is not pushed, and none at all when the limit is 0', () => {
    expect(decide({ ...base, sentToday: 2 }, rules).action).toBe('send');
    expect(decide({ ...base, sentToday: 3 }, rules)).toEqual({ action: 'skip', reason: 'daily-max' });
    expect(decide({ ...base, sentToday: 9 }, rules)).toEqual({ action: 'skip', reason: 'daily-max' });
    expect(decide({ ...base, sentToday: 0 }, { ...rules, dailyMax: 0 })).toEqual({ action: 'skip', reason: 'off' });
    expect(decide({ ...base, sentToday: 4 }, { ...rules, dailyMax: 5 }).action).toBe('send');
  });

  it('has no quiet hours when they are set equal', () => {
    expect(decide({ ...base, now: at('2026-11-05T09:00:00Z') }, { ...rules, quietStart: 0, quietEnd: 0 }).action).toBe('send');
  });
});

describe('a reply to the student', () => {
  const reply = { ...base, kind: 'reply' as const, now: at('2026-11-05T07:00:00Z') };       // 23:00: quiet hours

  it('is pushed when the student waited 20 seconds or more, urgently, and never held for quiet hours', () => {
    expect(decide({ ...reply, waitedMs: 20_000 }, rules)).toEqual({ action: 'send', urgency: 'high', ttl: REPLY_TTL_SECONDS });
    expect(decide({ ...reply, waitedMs: 600_000 }, rules).action).toBe('send');
    expect(REPLY_TTL_SECONDS).toBe(1800);
  });

  it('is not pushed when it came quickly: the student is most likely still there', () => {
    expect(decide({ ...reply, waitedMs: 19_999 }, rules)).toEqual({ action: 'skip', reason: 'quick-reply' });
    expect(decide({ ...reply, waitedMs: 0 }, rules)).toEqual({ action: 'skip', reason: 'quick-reply' });
    expect(decide({ ...reply, waitedMs: 5_000 }, { ...rules, replyAfterMs: 0 }).action).toBe('send');
  });

  it('is not bound by the daily limit of TAi\'s own messages, and is pushed once for one answer', () => {
    expect(decide({ ...reply, waitedMs: 30_000, sentToday: 50 }, rules).action).toBe('send');
    expect(decide({ ...reply, waitedMs: 30_000, episodePushed: true }, rules)).toEqual({ action: 'skip', reason: 'already-notified' });
    expect(decide({ ...reply, waitedMs: 30_000 }, { ...rules, dailyMax: 0 }).action).toBe('send');
  });
});

describe('which of TAi\'s messages are answers', () => {
  const folder = 's_' + 'a1'.repeat(10);
  const other = 's_' + 'b2'.repeat(10);
  const t0 = at('2026-11-05T18:00:00Z');
  const episodes = () => new Episodes({ replyWindowMs: 20 * 60_000, replyGraceMs: 5000 });

  it('is TAi\'s own when no message of the student is waiting', () => {
    expect(episodes().classify(folder, t0)).toEqual({ kind: 'proactive' });
  });

  it('is an answer, with the seconds the student waited, from their message to the end of TAi\'s typing and a few seconds more', () => {
    const e = episodes();
    e.studentMessage(folder, t0);
    e.typing(folder, true, t0 + 400);
    const first = e.classify(folder, t0 + 25_000);
    expect(first).toMatchObject({ kind: 'reply', waitedMs: 25_000 });
    e.typing(folder, false, t0 + 26_000);
    expect(e.classify(folder, t0 + 30_999)).toMatchObject({ kind: 'reply', waitedMs: 30_999 });        // a late message of the same answer
    expect(e.classify(folder, t0 + 31_001)).toEqual({ kind: 'proactive' });                          // five seconds after the typing stopped: TAi's own
    expect(e.classify(folder, t0 + 31_002)).toEqual({ kind: 'proactive' });
  });

  it('is an answer for as long as TAi is still typing, however long the run takes, and for no more than 20 minutes', () => {
    const e = episodes();
    e.studentMessage(folder, t0);
    e.typing(folder, true, t0 + 400);
    expect(e.classify(folder, t0 + 10 * 60_000)).toMatchObject({ kind: 'reply' });
    expect(e.classify(folder, t0 + 20 * 60_000)).toMatchObject({ kind: 'reply' });
    expect(e.classify(folder, t0 + 20 * 60_000 + 1)).toEqual({ kind: 'proactive' });
  });

  it('keeps one answer one answer when TAi stops typing and starts again (a second message of the student\'s piped in)', () => {
    const e = episodes();
    e.studentMessage(folder, t0);
    e.typing(folder, false, t0 + 20_000);
    e.typing(folder, true, t0 + 21_000);
    expect(e.classify(folder, t0 + 60_000)).toMatchObject({ kind: 'reply' });
  });

  it('counts the wait from the oldest message that has not been answered, and from the newest once an answer has come', () => {
    const e = episodes();
    e.studentMessage(folder, t0);
    e.studentMessage(folder, t0 + 10_000);
    expect(e.classify(folder, t0 + 30_000)).toMatchObject({ kind: 'reply', waitedMs: 30_000 });
    e.studentMessage(folder, t0 + 40_000);                                         // after the answer: a new wait
    expect(e.classify(folder, t0 + 70_000)).toMatchObject({ kind: 'reply', waitedMs: 30_000 });
  });

  it('does not take typing that starts after the answer is over for a new answer', () => {
    const e = episodes();
    e.studentMessage(folder, t0);
    e.classify(folder, t0 + 10_000);
    e.typing(folder, false, t0 + 10_000);
    e.typing(folder, true, t0 + 100_000);                                          // nothing of the student's came first
    expect(e.classify(folder, t0 + 101_000)).toEqual({ kind: 'proactive' });
  });

  it('is told apart for each student, and forgets the answers that are over', () => {
    const e = episodes();
    e.studentMessage(folder, t0);
    expect(e.classify(other, t0 + 1000)).toEqual({ kind: 'proactive' });
    expect(e.classify(folder, t0 + 1000)).toMatchObject({ kind: 'reply' });
    e.typing(other, false, t0);                                                    // nobody's episode: nothing happens
    e.studentMessage(other, t0);
    e.typing(folder, false, t0 + 2000);
    expect(e.size()).toBe(2);
    e.prune(t0 + 60_000);
    expect(e.size()).toBe(1);
    e.prune(t0 + 30 * 60_000);
    expect(e.size()).toBe(0);
  });

  it('lets a caller mark an answer as pushed, and the mark stays for the rest of that answer', () => {
    const e = episodes();
    e.studentMessage(folder, t0);
    const one = e.classify(folder, t0 + 25_000);
    if (one.kind !== 'reply') throw new Error('expected a reply');
    expect(one.episode.pushed).toBe(false);
    one.episode.pushed = true;
    const two = e.classify(folder, t0 + 26_000);
    expect(two.kind === 'reply' && two.episode.pushed).toBe(true);
    e.studentMessage(folder, t0 + 600_000);                                        // the next answer is a new one
    const three = e.classify(folder, t0 + 630_000);
    expect(three.kind === 'reply' && three.episode.pushed).toBe(false);
  });
});

describe('the same message twice, and the count of a day', () => {
  it('knows a key it saw in the last ten minutes, and forgets it after that', () => {
    const recent = new Recent(10 * 60_000);
    expect(recent.check('a', 0)).toBe(false);
    expect(recent.check('a', 9 * 60_000)).toBe(true);
    expect(recent.check('a', 19 * 60_000 - 1)).toBe(true);                         // each sighting renews it
    expect(recent.check('a', 40 * 60_000)).toBe(false);
    expect(recent.check('b', 40 * 60_000)).toBe(false);
  });

  it('stays small', () => {
    const recent = new Recent(1000, 50);
    for (let i = 0; i < 500; i++) recent.check(`key-${i}`, i);
    expect(recent.check('key-499', 500)).toBe(true);
    expect(recent.check('key-0', 500)).toBe(false);
  });

  it('counts per student and per calendar day of the student\'s own zone, and starts again on the next day', () => {
    const counts = new DailyCounts();
    expect(counts.count('ada', '2026-11-05')).toBe(0);
    expect(counts.bump('ada', '2026-11-05')).toBe(1);
    expect(counts.bump('ada', '2026-11-05')).toBe(2);
    expect(counts.count('ada', '2026-11-05')).toBe(2);
    expect(counts.count('bob', '2026-11-05')).toBe(0);
    expect(counts.count('ada', '2026-11-06')).toBe(0);
    expect(counts.bump('ada', '2026-11-06')).toBe(1);
    expect(counts.count('ada', '2026-11-05')).toBe(0);
    // the same instant is two days in two zones: 2026-11-06 04:00 UTC is still the 5th in Los Angeles and already the 6th in Tokyo
    const now = at('2026-11-06T04:00:00Z');
    expect(localTime(now, 'America/Los_Angeles').day).toBe('2026-11-05');
    expect(localTime(now, 'Asia/Tokyo').day).toBe('2026-11-06');
  });
});

describe('e-mail about what nobody has seen', () => {
  const HOUR = 3_600_000;
  const t0 = at('2026-11-05T18:00:00Z');
  const base = { now: t0 + HOUR, lastVisibleAt: 0, sentToday: 0 };
  const own = (id: string, ageMs: number, pushed = false) => ({ id, at: t0 + HOUR - ageMs, pushed });
  const rules = DEFAULT_EMAIL_RULES;

  it('is one an hour, for a student who has not looked since', () => {
    expect(rules).toEqual({ afterMs: HOUR, dailyMax: 1, staleMs: 24 * HOUR });
    expect(decideEmail({ ...base, messages: [own('a', HOUR)] }, rules)).toEqual({ action: 'send', ids: ['a'] });
    expect(decideEmail({ ...base, messages: [own('a', HOUR + 5)] }, rules)).toEqual({ action: 'send', ids: ['a'] });
  });

  it('waits until the message is an hour old, counted from the oldest unseen one', () => {
    expect(decideEmail({ ...base, messages: [own('a', HOUR - 1)] }, rules)).toEqual({ action: 'wait', until: base.now + 1 });
    expect(decideEmail({ ...base, messages: [own('new', 10 * 60_000), own('old', 50 * 60_000)] }, rules)).toEqual({ action: 'wait', until: t0 + HOUR + 10 * 60_000 });
    expect(decideEmail({ ...base, messages: [own('old', 61 * 60_000), own('new', 5 * 60_000)] }, rules)).toEqual({ action: 'send', ids: ['old', 'new'] });      // one e-mail stands for both
  });

  it('is never sent for what the student has seen: a page of theirs in front after the message, not one that is merely open', () => {
    const message = own('a', 2 * HOUR);
    expect(decideEmail({ ...base, messages: [message], lastVisibleAt: message.at + 1 }, rules)).toEqual({ action: 'skip', reason: 'seen' });
    expect(decideEmail({ ...base, messages: [message], lastVisibleAt: message.at }, rules)).toEqual({ action: 'skip', reason: 'seen' });
    expect(decideEmail({ ...base, messages: [message], lastVisibleAt: message.at - 1 }, rules).action).toBe('send');                 // looked before it came
    expect(decideEmail({ ...base, messages: [message], lastVisibleAt: 0 }, rules).action).toBe('send');
    // seen one of two: the other is still unseen, and only it is asked about
    const first = own('first', 3 * HOUR);
    const second = own('second', 90 * 60_000);
    expect(decideEmail({ ...base, messages: [first, second], lastVisibleAt: first.at + 1 }, rules)).toEqual({ action: 'send', ids: ['second'] });
  });

  it('is not sent for a message that a push delivered, and is for one whose push did not go (or was never sent)', () => {
    expect(decideEmail({ ...base, messages: [own('a', 2 * HOUR, true)] }, rules)).toEqual({ action: 'skip', reason: 'pushed' });
    expect(decideEmail({ ...base, messages: [own('a', 2 * HOUR, true), own('b', 2 * HOUR, false)] }, rules)).toEqual({ action: 'send', ids: ['a', 'b'] });
    expect(decideEmail({ ...base, messages: [own('a', 5 * 60_000, true), own('b', 2 * HOUR)] }, rules).action).toBe('send');
  });

  it('is one a student a day, and none when the limit is 0', () => {
    expect(decideEmail({ ...base, messages: [own('a', 2 * HOUR)], sentToday: 1 }, rules)).toEqual({ action: 'skip', reason: 'daily-max' });
    expect(decideEmail({ ...base, messages: [own('a', 2 * HOUR)], sentToday: 1 }, { ...rules, dailyMax: 2 }).action).toBe('send');
    expect(decideEmail({ ...base, messages: [own('a', 2 * HOUR)] }, { ...rules, dailyMax: 0 })).toEqual({ action: 'skip', reason: 'off' });
    // the limit is only asked once the wait is over: a message that has not waited long enough waits, whatever the day's count
    expect(decideEmail({ ...base, messages: [own('a', 10 * 60_000)], sentToday: 5 }, rules).action).toBe('wait');
  });

  it('forgets a message that is more than a day old, and has nothing to say about none', () => {
    expect(decideEmail({ ...base, messages: [own('a', 24 * HOUR + 1)] }, rules)).toEqual({ action: 'skip', reason: 'stale' });
    expect(decideEmail({ ...base, messages: [own('a', 24 * HOUR)] }, rules).action).toBe('send');
    expect(decideEmail({ ...base, messages: [] }, rules)).toEqual({ action: 'skip', reason: 'seen' });
  });

  it('takes the wait from the rules it is given', () => {
    expect(decideEmail({ ...base, messages: [own('a', 20 * 60_000)] }, { ...rules, afterMs: 15 * 60_000 }).action).toBe('send');
    expect(decideEmail({ ...base, messages: [own('a', 20 * 60_000)] }, { ...rules, afterMs: 30 * 60_000 }).action).toBe('wait');
  });
});
