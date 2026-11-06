// The pure parts of the progress the page shows (status.js): what the bubble says for a status, the note beside it, and the announcer that tells a
// screen reader what TAi is doing without chattering. (The bubble is DOM: it is looked at in the dev server, portal/qa/dev_server.mjs.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LABELS, LONGEST_TEXT, QUEUED_TEXT, createAnnouncer, noteText, statusView } from './status.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('the words of a status', () => {
  it('are the same nine the server sends (src/turn-status.ts STATUS_LABELS)', () => {
    const source = fs.readFileSync(path.join(here, '..', '..', 'src', 'turn-status.ts'), 'utf-8');
    const table = /export const STATUS_LABELS = \{([^}]*)\} as const;/.exec(source);
    expect(table).not.toBeNull();
    const server = [...table[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(server).toHaveLength(9);
    expect([...LABELS].sort()).toEqual([...server].sort());
  });

  it('are the only words a payload can put in the bubble: another label is "Working", and a status without one is the dots alone', () => {
    expect(statusView({ state: 'working', label: 'Checking Canvas' })).toEqual({ state: 'working', text: 'Checking Canvas…', spoken: 'Checking Canvas' });
    expect(statusView({ state: 'working', label: '<img src=x onerror=alert(1)>' })).toEqual({ state: 'working', text: 'Working…', spoken: 'Working' });
    expect(statusView({ state: 'working', label: 'Pay me a visit' })?.text).toBe('Working…');
    expect(statusView({ state: 'working' })).toBeNull();
    expect(statusView({ state: 'working', label: 42 })?.text).toBe('Working…');
  });

  it('is nothing for what is not a status of this page: no status, another state, not an object', () => {
    expect(statusView(undefined)).toBeNull();
    expect(statusView(null)).toBeNull();
    expect(statusView('working')).toBeNull();
    expect(statusView({ state: 'sleeping', label: 'Thinking' })).toBeNull();
    expect(statusView({})).toBeNull();
  });

  it('say "Waiting for a free slot" for a message in line, with its place only when the server gave one', () => {
    expect(statusView({ state: 'queued' })).toEqual({ state: 'queued', text: QUEUED_TEXT, spoken: QUEUED_TEXT });
    expect(statusView({ state: 'queued', ahead: 3 })).toEqual({ state: 'queued', text: 'Waiting for a free slot · 3 ahead', spoken: 'Waiting for a free slot, 3 ahead' });
    expect(statusView({ state: 'queued', ahead: 0 })?.text).toBe("Waiting for a free slot · you're next");
    for (const odd of [-1, 2.5, 'three', null, Number.NaN, 1000, Infinity]) expect(statusView({ state: 'queued', ahead: odd })?.text, String(odd)).toBe(QUEUED_TEXT);
    expect(statusView({ state: 'queued', label: 'Checking Canvas' })?.text).toBe(QUEUED_TEXT);        // a queued message is not "checking" anything
  });

  it('give the label\'s box the width of the longest thing the bubble can say', () => {
    for (const label of LABELS) expect(LONGEST_TEXT.length).toBeGreaterThanOrEqual(`${label}…`.length);
    expect(LONGEST_TEXT.length).toBeGreaterThanOrEqual(`${QUEUED_TEXT} · 99 ahead`.length);
    expect(statusView({ state: 'queued', ahead: 99 }).text.length).toBeLessThanOrEqual(LONGEST_TEXT.length);
  });
});

describe('the note beside the bubble', () => {
  const working = statusView({ state: 'working', label: 'Thinking' });
  const waiting = statusView({ state: 'queued', ahead: 1 });

  it('says nothing for the first seconds, then how long it has been, as it always did while TAi works', () => {
    expect(noteText(working, 0)).toBe('');
    expect(noteText(working, 7)).toBe('');
    expect(noteText(working, 8)).toBe('Still working… 8 s');
    expect(noteText(null, 45)).toBe('Still working… 45 s');
    expect(noteText(working, 119)).toBe('Still working… 119 s');
    expect(noteText(working, 120)).toBe('This is taking longer than usual. Your message arrived; the reply will appear here.');
  });

  it('does not say "still working" of a message that waits in line', () => {
    expect(noteText(waiting, 7)).toBe('');
    expect(noteText(waiting, 30)).toBe('Waiting… 30 s');
    expect(noteText(waiting, 300)).toBe('Your message is in line. The reply will appear here.');
    expect(noteText(waiting, 30)).not.toMatch(/working/i);
  });
});

describe('the announcer', () => {
  /** A clock and timers the test moves by hand. */
  function rig(gapMs = 4000) {
    let t = 1_000_000;
    const timers = [];
    const said = [];
    const announcer = createAnnouncer({
      write: (text) => said.push(text),
      gapMs,
      now: () => t,
      setTimer: (fn, ms) => {
        const timer = { at: t + ms, fn, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        timer.live = false;
      },
    });
    const advance = (ms) => {
      t += ms;
      for (const timer of timers.filter((x) => x.live && x.at <= t)) {
        timer.live = false;
        timer.fn();
      }
    };
    return { announcer, said, advance };
  }

  it('says the first thing at once, and the same thing never twice', () => {
    const { announcer, said } = rig();
    announcer.say('Checking Canvas');
    announcer.say('Checking Canvas');
    expect(said).toEqual(['Checking Canvas']);
  });

  it('says a change at most every four seconds, and then the newest of what came in between (not each of them)', () => {
    const { announcer, said, advance } = rig();
    announcer.say('Checking Canvas');
    advance(1000);
    announcer.say('Searching Piazza');
    advance(500);
    announcer.say('Thinking');
    advance(500);
    expect(said).toEqual(['Checking Canvas']);
    advance(2000);                                                      // four seconds since the first
    expect(said).toEqual(['Checking Canvas', 'Thinking']);
    advance(10_000);
    expect(said).toEqual(['Checking Canvas', 'Thinking']);
  });

  it('says a change that comes after a quiet spell at once', () => {
    const { announcer, said, advance } = rig();
    announcer.say('Thinking');
    advance(6000);
    announcer.say('Searching Piazza');
    expect(said).toEqual(['Thinking', 'Searching Piazza']);
  });

  it('says nothing for what went away and came back inside the gap: what was said is still true', () => {
    const { announcer, said, advance } = rig();
    announcer.say('Thinking');
    advance(1000);
    announcer.say('Checking Canvas');
    advance(1000);
    announcer.say('Thinking');
    advance(10_000);
    expect(said).toEqual(['Thinking']);
  });

  it('empties the region when the work is over, drops what was waiting, and reads the same words again next time', () => {
    const { announcer, said, advance } = rig();
    announcer.say('Thinking');
    advance(1000);
    announcer.say('Searching Piazza');
    announcer.clear();
    advance(10_000);
    expect(said).toEqual(['Thinking', '']);                             // the waiting text was dropped with the work
    announcer.say('Thinking');
    expect(said).toEqual(['Thinking', '', 'Thinking']);
  });

  it('treats an empty or odd text as "nothing to say", and clearing twice writes once', () => {
    const { announcer, said } = rig();
    announcer.say('Thinking');
    announcer.say('');
    announcer.say(undefined);
    announcer.clear();
    expect(said).toEqual(['Thinking', '']);
  });
});
