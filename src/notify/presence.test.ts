/** Whether a student's page is open and in front: the poll as the sign of life, a page told apart from another, and a closed tab taken at its word. */
import { describe, expect, it } from 'vitest';

import { DEFAULT_EMAIL_RULES, decideEmail } from './core.js';
import { Presence } from './presence.js';

const ADA = 's_' + 'a1'.repeat(10);
const BOB = 's_' + 'b2'.repeat(10);
const PAGE_1 = '11111111-1111-4111-8111-111111111111';
const PAGE_2 = '22222222-2222-4222-8222-222222222222';

function setup(extra: { maxClients?: number } = {}) {
  let now = 1_000_000;
  const presence = new Presence({ now: () => now, ...extra });
  return { presence, advance: (ms: number) => (now += ms), clock: () => now };
}

describe('the page of a student', () => {
  it('is closed until it polls', () => {
    const { presence } = setup();
    expect(presence.state(ADA)).toBe('closed');
    expect(presence.lastVisibleAt(ADA)).toBe(0);
  });

  it('is in front while a poll that said so is held, however long (the longest is 25 s, and nothing here counts it)', () => {
    const { presence, advance } = setup();
    const end = presence.begin(ADA, PAGE_1, true);
    expect(presence.state(ADA)).toBe('visible');
    advance(25_000);
    expect(presence.state(ADA)).toBe('visible');
    advance(5 * 60_000);
    expect(presence.state(ADA)).toBe('visible');                     // a poll that is still in flight is a page that is still there
    end();
  });

  it('stays in front for 5 seconds after its last poll was answered (a live page asks again at once), and is then closed', () => {
    const { presence, advance } = setup();
    presence.begin(ADA, PAGE_1, true)();
    advance(4_999);
    expect(presence.state(ADA)).toBe('visible');
    advance(2);
    expect(presence.state(ADA)).toBe('closed');
  });

  it('looks closed about 30 seconds after a page that died without a word: its held poll is answered by the server\'s own timer into a dead socket, which is no disconnect', () => {
    const { presence, advance, clock } = setup();
    const began = clock();
    const end = presence.begin(ADA, PAGE_1, true);                       // the last request the page made: the lid closed right after it
    advance(25_000);
    expect(presence.state(ADA)).toBe('visible');                         // held until the server's 25 s timer: nothing says otherwise
    end(false);                                                          // answered into the dead connection: res.writableEnded, so not "gone"
    advance(4_999);
    expect(presence.state(ADA)).toBe('visible');                         // 29,999 ms: the grace for the gap between two polls of a live page
    advance(2);
    expect(presence.state(ADA)).toBe('closed');                          // 30,001 ms (it was 55 s when the grace after an answer was 30 s)
    advance(1_000);
    expect(presence.state(ADA)).toBe('closed');
    expect(presence.lastVisibleAt(ADA)).toBe(began);
  });

  it('is open but behind another tab when its polls say it is not in front', () => {
    const { presence, advance } = setup();
    presence.begin(ADA, PAGE_1, false)();
    expect(presence.state(ADA)).toBe('hidden');
    advance(5_001);
    expect(presence.state(ADA)).toBe('closed');
  });

  it('follows the page into the foreground and out of it at once, through the short request it makes when the tab changes', () => {
    const { presence } = setup();
    const poll = presence.begin(ADA, PAGE_1, true);                     // a long poll is held, begun while the tab was in front
    expect(presence.state(ADA)).toBe('visible');
    presence.begin(ADA, PAGE_1, false)();                               // the student switched away: a zero-wait poll says so
    expect(presence.state(ADA)).toBe('hidden');
    presence.begin(ADA, PAGE_1, true)();                                // and back
    expect(presence.state(ADA)).toBe('visible');
    poll();
  });

  it('is gone at once when the poll that was held was dropped (the tab was closed): a reply a few seconds later is not taken for a page that is there', () => {
    const { presence, advance } = setup();
    const end = presence.begin(ADA, PAGE_1, true);
    advance(8_000);
    end(true);
    expect(presence.state(ADA)).toBe('closed');
    // a poll that was answered is not that
    const answered = presence.begin(ADA, PAGE_1, true);
    answered(false);
    expect(presence.state(ADA)).toBe('visible');
  });

  it('is not gone when one poll of a page is dropped while another of the same page is held', () => {
    const { presence } = setup();
    const first = presence.begin(ADA, PAGE_1, true);
    const second = presence.begin(ADA, PAGE_1, true);
    first(true);
    expect(presence.state(ADA)).toBe('visible');
    second(true);
    expect(presence.state(ADA)).toBe('closed');
  });

  it('tells two pages of one student apart: in front when either is, open as long as either is', () => {
    const { presence, advance } = setup();
    presence.begin(ADA, PAGE_1, false)();
    const held = presence.begin(ADA, PAGE_2, true);
    expect(presence.state(ADA)).toBe('visible');
    held(true);                                                         // the tab that was in front is closed
    expect(presence.state(ADA)).toBe('hidden');                         // the other is still there, behind
    advance(31_000);
    expect(presence.state(ADA)).toBe('closed');
  });

  it('is told apart for each student', () => {
    const { presence } = setup();
    presence.begin(ADA, PAGE_1, true)();
    expect(presence.state(BOB)).toBe('closed');
    presence.begin(BOB, PAGE_1, false)();
    expect(presence.state(ADA)).toBe('visible');
    expect(presence.state(BOB)).toBe('hidden');
  });

  it('takes a page without an id, or with one that is not an id, as one anonymous page', () => {
    const { presence } = setup();
    for (const id of [null, undefined, '', 'not-an-id', 'x'.repeat(500), '../../etc']) {
      const end = presence.begin(ADA, id, true);
      expect(presence.state(ADA)).toBe('visible');
      end(true);
      expect(presence.state(ADA)).toBe('closed');
    }
  });

  it('remembers eight pages of a student, no more', () => {
    const { presence, advance } = setup({ maxClients: 3 });
    const ids = [1, 2, 3, 4].map((n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`);
    const ends = ids.map((id) => {
      advance(10);
      return presence.begin(ADA, id, true);
    });
    ends[0](true);                                                       // the first was forgotten already: its end does nothing to the others
    expect(presence.state(ADA)).toBe('visible');
    for (const end of ends.slice(1)) end(true);
    expect(presence.state(ADA)).toBe('closed');
  });

  it('knows when a page was last in front, and that it is in front now', () => {
    const { presence, advance, clock } = setup();
    const start = clock();
    const end = presence.begin(ADA, PAGE_1, true);
    advance(10_000);
    expect(presence.lastVisibleAt(ADA)).toBe(clock());                  // a request that said "in front" is held: now
    end();
    expect(presence.state(ADA)).toBe('visible');                        // (the grace after an answer is "visible" for the push rules ...)
    expect(presence.lastVisibleAt(ADA)).toBe(start);                    // ... but not "in front now" for what a student has seen: that is the last request that said so
    advance(60_000);
    expect(presence.state(ADA)).toBe('closed');
    expect(presence.lastVisibleAt(ADA)).toBe(start);
    presence.begin(ADA, PAGE_1, false)();
    expect(presence.lastVisibleAt(ADA)).toBe(start);                    // behind another tab is not in front
    expect(presence.lastVisibleAt(BOB)).toBe(0);
  });

  describe('what the e-mail channel calls seen (decideEmail, core.ts: a message is seen when a page was in front after it was written)', () => {
    const decide = (presence: Presence, written: number, now: number) =>
      decideEmail({ now, messages: [{ id: 'b:1', at: written, pushed: false }], lastVisibleAt: presence.lastVisibleAt(ADA), sentToday: 0 }, DEFAULT_EMAIL_RULES);

    it('is not a message that woke the held poll of a page that had died: the answer went into a dead socket, so it is still unseen an hour later', () => {
      const { presence, advance, clock } = setup();
      const end = presence.begin(ADA, PAGE_1, true);                    // the last poll; the laptop's lid closes
      advance(10_000);
      const written = clock();                                          // TAi writes on its own: the held poll is woken ...
      advance(5);
      end(false);                                                       // ... and answered, into the dead connection (not "gone")
      advance(60 * 60_000);
      expect(presence.state(ADA)).toBe('closed');
      expect(presence.lastVisibleAt(ADA)).toBeLessThan(written);
      expect(decide(presence, written, clock())).toEqual({ action: 'send', ids: ['b:1'] });
    });

    it('is a message that a page in front was sent: it asks again at once, and that request, made after the message, is the proof', () => {
      const { presence, advance, clock } = setup();
      const end = presence.begin(ADA, PAGE_1, true);
      advance(10_000);
      const written = clock();
      advance(5);
      end(false);                                                       // answered with the message
      advance(20);
      const next = presence.begin(ADA, PAGE_1, true);                   // the page is alive: its next poll
      next(true);                                                       // and the student closes the tab
      advance(60 * 60_000);
      expect(presence.state(ADA)).toBe('closed');
      expect(presence.lastVisibleAt(ADA)).toBeGreaterThan(written);
      expect(decide(presence, written, clock())).toEqual({ action: 'skip', reason: 'seen' });
    });

    it('is not a message written while the page was behind another tab, whatever its polls did after', () => {
      const { presence, advance, clock } = setup();
      presence.begin(ADA, PAGE_1, true)();
      advance(1_000);
      presence.begin(ADA, PAGE_1, false)();                             // the student looked away
      advance(10_000);
      const written = clock();
      const held = presence.begin(ADA, PAGE_1, false);
      advance(5);
      held(false);
      advance(60 * 60_000);
      expect(decide(presence, written, clock())).toEqual({ action: 'send', ids: ['b:1'] });
    });
  });

  it('ends a request once: calling its end again does not take a second request off the count', () => {
    const { presence } = setup();
    const first = presence.begin(ADA, PAGE_1, true);
    const second = presence.begin(ADA, PAGE_1, true);
    first();
    first();
    first(true);
    expect(presence.state(ADA)).toBe('visible');                          // the second is still held
    second();
  });
});
