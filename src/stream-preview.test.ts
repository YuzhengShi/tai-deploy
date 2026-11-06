/**
 * The preview of a reply while it is written (src/stream-preview.ts, docs/STREAMING.md): what may be shown of the accumulated text, at EVERY split
 * position of the text (a chunk can end anywhere, so the accumulated text can be any prefix of the reply), and the state of one chat's turn.
 *
 * The property most of this file checks: after every prefix of a reply, what the page would be showing is a prefix of what the final filters (the ones
 * src/index.ts and the web channel apply) make of the WHOLE reply, and contains no byte of a fingerprint, a tag or an option.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { parseChoices } from './choices.js';
import { trimClosingFormula } from './reply-shape.js';
import { formatOutbound } from './router.js';
import { PREVIEW_MAX_EVENTS, PREVIEW_MAX_INPUT, PreviewTurn, previewParts, stablePrefix } from './stream-preview.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** What the student gets of a reply: the web channel's whole pipeline for a student's chat (index.ts, then parseChoices in WebChannel.sendMessage). */
const finalOf = (raw: string): string => parseChoices(trimClosingFormula(formatOutbound(raw))).text;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The fingerprints the final filter redacts, read from router.ts itself (the list is private there), so a new one is covered the day it is added. */
const FINGERPRINTS = ((): string[] => {
  const source = fs.readFileSync(path.join(here, 'router.ts'), 'utf-8');
  const block = /SYSTEM_PROMPT_FINGERPRINTS = \[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

/** What the page shows after each prefix of `raw` (index k: the first k characters have arrived), through a PreviewTurn as the web channel runs it. */
function shownAfterEachPrefix(raw: string): { shown: string[]; turn: PreviewTurn } {
  const turn = new PreviewTurn({ trimClosing: true });
  const shown: string[] = [''];
  for (let k = 1; k <= raw.length; k++) {
    turn.apply({ type: 'text', n: 1, text: raw.slice(0, k) });
    shown.push(turn.shown);
  }
  return { shown, turn };
}

/** The property, at every split position: nothing forbidden is shown, no half character, and (for rules that only look back) a prefix of the final. */
function expectSafeAtEverySplit(raw: string, forbidden: string[], { prefixOfFinal = true } = {}): string[] {
  const final = finalOf(raw);
  const { shown, turn } = shownAfterEachPrefix(raw);
  shown.forEach((text, k) => {
    for (const bad of forbidden) expect(text.includes(bad), `after ${k} characters: ${JSON.stringify(text)} contains ${bad}`).toBe(false);
    expect(LONE_SURROGATE.test(text), `after ${k} characters: a half of a character`).toBe(false);
    if (prefixOfFinal) expect(final.startsWith(text), `after ${k} characters: ${JSON.stringify(text)} is not the start of ${JSON.stringify(final)}`).toBe(true);
  });
  expect(turn.dropped, `dropped (${turn.reason})`).toBe(false);
  return shown;
}

describe('the stable part of a reply', () => {
  const table: Array<[string, string, string]> = [
    ['a sentence that is followed by the start of the next', 'Hello there. How are you', 'Hello there.'],
    ['nothing while the first sentence is still the last', 'Hello there.', ''],
    ['nothing for white space after it', 'Hello there. ', ''],
    ['every whole sentence but the last', 'One. Two! Three? Four', 'One. Two! Three?'],
    ['a paragraph that is followed by another', 'First paragraph\n\nSecond para', 'First paragraph'],
    ['nothing for a blank line with nothing after it', 'First paragraph without a stop\n\n', ''],
    ['a list number is not the end of a sentence', '1. First item\n2. Second', ''],
    ['nor are the usual abbreviations', 'Use e.g. a queue. Then', 'Use e.g. a queue.'],
    ['nor the point of a decimal', 'It takes 3.5 seconds. Then', 'It takes 3.5 seconds.'],
    ['nor "Fig."', 'See Fig. 2 for it. Then', 'See Fig. 2 for it.'],
    ['a closing quote or bracket belongs to its sentence', 'He said "stop." Then', 'He said "stop."'],
    ['a bracketed sentence', '(see below.) Then', '(see below.)'],
    ['an ellipsis', 'Hmm... then', 'Hmm...'],
    ['code that is closed', 'Use `a. b` now. Then', 'Use `a. b` now.'],
    ['nothing inside code that is still open', 'Run `foo. Then bar', ''],
    ['a fence that is closed', 'Here:\n```go\nfmt.Println(1)\n```\nDone. Next', 'Here:\n```go\nfmt.Println(1)\n```\nDone.'],
    ['nothing inside a fence that is still open', 'Here:\n```go\nx := 1. y\nmore', ''],
    ['the words before the first tag, once the tag has begun', 'Which one? <choices><option>A</option>', 'Which one?'],
    ['the words before half a tag', 'Fine. <internal', 'Fine.'],
    ['nothing for a tag glued to the sentence', 'Fine.<internal', ''],
    ['Chinese sentences, which have no space after them', '你好。我是助教。下', '你好。我是助教。'],
    ['an emoji is the start of the next sentence', 'Great job! 🎉 Next up', 'Great job!'],
  ];
  for (const [what, accumulated, expected] of table) {
    it(`is ${what}`, () => {
      expect(stablePrefix(accumulated, false)).toBe(expected);
    });
  }

  it('is without the closing formula for a student, as the final is', () => {
    const text = 'Week 9. HW7 is due Nov 9. Let me know if you need anything else. Also';
    expect(stablePrefix(text, true)).toBe('Week 9. HW7 is due Nov 9.');
    expect(stablePrefix(text, false)).toBe('Week 9. HW7 is due Nov 9. Let me know if you need anything else.');
  });

  it('never shows the last sentence of a reply, whatever the reply: the final is what says it', () => {
    const raw = 'One is first. Two is second. Three is third.';
    const { shown } = shownAfterEachPrefix(raw);
    expect(shown[shown.length - 1]).toBe('One is first. Two is second.');
    expect(shown.some((text) => text.includes('Three'))).toBe(false);
  });

  it('only grows, step by step, while a reply is written one character at a time', () => {
    const raw = 'Raft elects one leader per term. A candidate needs a majority of the votes.\n\nIf two candidates split the vote, a new term starts. Why is that safe?';
    const { shown } = shownAfterEachPrefix(raw);
    shown.forEach((text, k) => {
      if (k > 0) expect(text.startsWith(shown[k - 1]), `step ${k}`).toBe(true);
    });
    expect(shown[shown.length - 1]).toBe('Raft elects one leader per term. A candidate needs a majority of the votes.\n\nIf two candidates split the vote, a new term starts.');
  });
});

describe('what is held back, at every split position', () => {
  it('is every fingerprint of the system prompt, cut anywhere: no byte of one is shown, and nothing of the sentence that holds it', () => {
    expect(FINGERPRINTS.length).toBeGreaterThan(20);
    for (const fp of FINGERPRINTS) {
      const raw = `Sure thing. Open ${fp} and read it. Then try again. More text follows here.`;
      const shown = expectSafeAtEverySplit(raw, [fp]);
      shown.forEach((text, k) => {
        for (let len = 2; len < fp.length; len++) expect(text.endsWith(fp.slice(0, len)), `${fp} after ${k} characters`).toBe(false);
      });
    }
  });

  it('is a fingerprint written glued to the end of a sentence, or in the middle of a word', () => {
    for (const fp of FINGERPRINTS.slice(0, 6)) {
      expectSafeAtEverySplit(`Look.${fp} matters. Then go on to the next part.`, [fp]);
      expectSafeAtEverySplit(`Sure. See my${fp}notes here. And more after that.`, [fp]);
    }
  });

  it('is the whole reply when three fingerprints are in it: the final is another text, so the preview ends and nothing of the three was shown', () => {
    const [a, b, c] = FINGERPRINTS;
    const raw = `Sure thing. First ${a} is one. Then ${b} is two. Last ${c} is three. And a closing sentence.`;
    expect(finalOf(raw)).toBe('hmm, I got a bit confused there — what were we talking about?');
    const { shown, turn } = shownAfterEachPrefix(raw);
    for (const text of shown) for (const fp of [a, b, c]) expect(text.includes(fp)).toBe(false);
    expect(turn.shown).toBe('');
    expect(turn.dropped).toBe(true);
  });

  for (const [what, raw] of [
    ['a closed internal block', 'Sure thing. <internal>secret plan: grade it. Then hint.</internal> Next, try the retry. Okay then.'],
    ['an internal block that never closes', 'Sure thing. <internal>secret plan: grade it. Then hint. Still going on and on'],
    ['an internal block with attributes', 'Sure thing. <internal note="secret. plan">secret more</internal> Next, try it. Okay then.'],
    ['an italic block that says internal', 'Sure thing. <i>internal secret plan. Then hint.</i> Next, try the retry. Okay then.'],
    ['an internal block glued to the words', 'Sure thing.<internal>secret plan.</internal>Next sentence goes here. And the last one.'],
    ['an internal block first, then the reply', '<internal>secret plan. Then hint.</internal> Here is the reply. And a second sentence. Third one.'],
    ['stray reasoning-channel tags', 'Sure thing. </commentary>Next, try it. <analysis secret> Okay then. And more.'],
  ] as Array<[string, string]>) {
    it(`is ${what}: nothing of it is shown, cut anywhere`, () => {
      expectSafeAtEverySplit(raw, ['secret', 'internal', '<', 'commentary', 'analysis']);
    });
  }

  it('is an options block, cut anywhere: the question shows once the block has begun, and nothing of the block ever does', () => {
    const question = 'Which of these is true of a Raft term?';
    const raw = `${question}\n<choices>\n<option>Every heartbeat starts a new term</option>\n<option correct>A term has at most one leader</option>\n<why>Each term has one winner.</why>\n</choices>`;
    expect(finalOf(raw)).toBe(question);
    const shown = expectSafeAtEverySplit(raw, ['<', 'option', 'correct', 'Every heartbeat', 'one leader', 'winner', 'choices', 'why']);
    const opened = raw.indexOf('<');
    expect(shown[opened]).toBe('');
    expect(shown[opened + 1]).toBe(question);
    expect(shown[raw.length]).toBe(question);
  });

  it('is an options block with words after it: only the words before it are shown', () => {
    const raw = 'Quick check. Which one is right?\n<choices><option>A cat</option><option>A dog</option></choices>\nThink it over. Then tap one.';
    const shown = expectSafeAtEverySplit(raw, ['<', 'A cat', 'A dog']);
    expect(shown[raw.length]).toBe('Quick check. Which one is right?');
  });

  it('is a closing formula at the end: it is not shown, and the preview stays the start of the final', () => {
    const raw = 'Here is the link. Hope this helps! Feel free to ask more.';
    expect(finalOf(raw)).toBe('Here is the link.');
    const shown = expectSafeAtEverySplit(raw, ['Hope', 'Feel']);
    expect(shown[raw.length]).toBe('Here is the link.');                // all the final will say, and the final then changes nothing
  });

  it('is a planning sentence the final filter takes off, glued to the reply: shown only once it is gone', () => {
    const raw = 'We need to introduce ourselves as TAi.hey! i am TAi, the course assistant. Ask me about Homework 6. Go on.';
    expect(finalOf(raw).startsWith('hey!')).toBe(true);
    expectSafeAtEverySplit(raw, ['We need']);
  });

  it('is text in other scripts, emoji and combining marks: nobody is shown half a character', () => {
    expectSafeAtEverySplit('Great job! 🎉 Next, try the 👩🏽‍💻 retry. Then 日本語です。次は何ですか？ Okay then. And 👍🏻 more.', []);
    expectSafeAtEverySplit('Café is open. Then we go. And ñ is a letter. The last bit.', []);
    expectSafeAtEverySplit('مرحبا بك في الدرس. هذا اختبار صغير. نعم، هذا كل شيء. وأخيرا نهاية.', []);
    expectSafeAtEverySplit('你好。我是助教。今天我们讲 Raft。你准备好了吗？好的。', []);
  });

  it('is the one thing it cannot know in advance, a filter rule that takes back EARLIER words when a marker comes later: the preview ends there', () => {
    const raw = 'We should greet them politely. Then answer briefly.assistantfinalHello there. How can I help? Ask away.';
    expect(finalOf(raw).startsWith('Hello there.')).toBe(true);
    const { turn } = shownAfterEachPrefix(raw);
    expect(turn.shown).toBe('');
    expect(turn.dropped).toBe(true);
    expect(turn.reason).toBe('rewrite');
  });

  it('is any reply made of the pieces models write (a fixed seed): safe at every split position', () => {
    let seed = 20261105;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const pieces = [
      'Raft elects a leader.', 'Why does that matter?', 'Try it on a small case!', 'See Fig. 2 and e.g. the log.', 'A `quorum` is a majority.', 'It takes 3.5 ms.',
      'Great job! 🎉', '你好。', 'Done...', '<internal>secret plan. more secret.</internal>', '<internal>secret unfinished', '<i>internal secret</i>',
      `Open ${FINGERPRINTS[0]} now.`, `Read ${FINGERPRINTS[3]}.`, 'Hope this helps!', 'Let me know if you need anything else.', '\n\n', '\n', '1. First step', 'Step 2. Run it.',
      '<choices><option>a</option><option correct>secret b</option></choices>',
    ];
    for (let r = 0; r < 120; r++) {
      const count = 3 + Math.floor(random() * 7);
      const raw = Array.from({ length: count }, () => pick(pieces)).join(random() < 0.8 ? ' ' : '');
      const forbidden = ['secret', '<', ...FINGERPRINTS.slice(0, 4)];
      const final = finalOf(raw);
      const { shown, turn } = shownAfterEachPrefix(raw);
      shown.forEach((text, k) => {
        for (const bad of forbidden) expect(text.includes(bad), `${JSON.stringify(raw)} after ${k}`).toBe(false);
        expect(LONE_SURROGATE.test(text)).toBe(false);
        // a turn that was not dropped shows only what the final also has at its start
        if (!turn.dropped) expect(final.startsWith(text), `${JSON.stringify(raw)} after ${k}: ${JSON.stringify(text)}`).toBe(true);
      });
    }
  });
});

describe('the time it takes', () => {
  const big = { trimClosing: true, maxInput: 100_000 };

  it('is bounded for 20,000 characters of anything: dots, blank lines, backticks, tags, prose', () => {
    const inputs = [
      'Words go here. '.repeat(1334),
      '.'.repeat(20_000),
      '\n \n'.repeat(6_700),
      '`'.repeat(20_000),
      '<internal>a'.repeat(1_800),
      '<'.repeat(20_000),
      'a'.repeat(20_000),
      '! '.repeat(10_000),
      '.)"\' '.repeat(4_000),
    ];
    const started = Date.now();
    for (const text of inputs) {
      const turn = new PreviewTurn(big);
      turn.apply({ type: 'text', n: 1, text });
      expect(turn.dropped, text.slice(0, 20)).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('is nothing at all above the host limit: such a message has no preview', () => {
    const turn = new PreviewTurn({ trimClosing: true });
    const started = Date.now();
    expect(turn.apply({ type: 'text', n: 1, text: 'Words go here. '.repeat(1334) })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(50);
    expect(turn.dropped).toBe(true);
    expect(turn.reason).toBe('oversize');
    expect('x'.repeat(PREVIEW_MAX_INPUT + 1).length).toBeGreaterThan(PREVIEW_MAX_INPUT);
  });

  it('is linear in the length of what it is given (twice the text is not four times the time, with a margin)', () => {
    const time = (repeat: number): number => {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 5; i++) previewParts('Words go here. And more of them follow. '.repeat(repeat), true);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    time(50);
    const small = time(50);
    const large = time(400);
    expect(large).toBeLessThan(Math.max(small * 8 * 4, 200));
  });
});

describe('one chat\'s turn', () => {
  const text = (n: number, words: string) => ({ type: 'text' as const, n, text: words });

  it('shows what is stable and tells nothing when nothing changed', () => {
    const turn = new PreviewTurn({ trimClosing: true });
    expect(turn.apply(text(1, 'Raft elects'))).toBeUndefined();
    expect(turn.apply(text(1, 'Raft elects a leader. A candidate'))).toBe('Raft elects a leader.');
    expect(turn.apply(text(1, 'Raft elects a leader. A candidate needs'))).toBeUndefined();
    expect(turn.apply(text(1, 'Raft elects a leader. A candidate needs votes. Then'))).toBe('Raft elects a leader. A candidate needs votes.');
    expect(turn.shown).toBe('Raft elects a leader. A candidate needs votes.');
  });

  it('is cleared when a model request begins or a tool starts: the words before it were not the reply; then a new message is fine', () => {
    const turn = new PreviewTurn({ trimClosing: true });
    turn.apply(text(1, 'Let me look. Checking Canvas now. And'));
    expect(turn.shown).toBe('Let me look. Checking Canvas now.');
    expect(turn.clear()).toBe('');
    expect(turn.shown).toBe('');
    expect(turn.clear()).toBeUndefined();                              // nothing shown: nothing to tell (and, with the flag off, never anything)
    expect(turn.apply(text(2, 'Homework 6 is due Friday. Start with'))).toBe('Homework 6 is due Friday.');
    expect(turn.dropped).toBe(false);
  });

  it('is cleared by the runner taking its words back, and a message that is cleared says no more', () => {
    const turn = new PreviewTurn({ trimClosing: true });
    turn.apply(text(1, 'One is first. Two is second. And'));
    expect(turn.apply(text(1, ''))).toBe('');
    expect(turn.shown).toBe('');
    expect(turn.apply(text(1, 'One is first. Two is second. And more. Then'))).toBeUndefined();
    expect(turn.dropped).toBe(true);
    expect(turn.reason).toBe('text-after-clear');
  });

  const drops: Array<[string, (turn: PreviewTurn) => void, string]> = [
    ['a message number that goes back', (turn) => { turn.apply(text(3, 'Hello there. And')); turn.apply(text(2, 'Hello there. And')); }, 'out-of-order'],
    ['a message number that is not a number', (turn) => { turn.apply(text(0, 'Hello there. And')); }, 'out-of-order'],
    ['text that is not what was said before', (turn) => { turn.apply(text(1, 'Hello there. And so')); turn.apply(text(1, 'Goodbye now. And so')); }, 'rewrite'],
    ['text that is shorter than before', (turn) => { turn.apply(text(1, 'Hello there. And so')); turn.apply(text(1, 'Hello')); }, 'rewrite'],
    ['a new message while words are still shown', (turn) => { turn.apply(text(1, 'Hello there. And so')); turn.apply(text(2, 'Again now. And so')); }, 'new-message-while-shown'],
    ['more text than the host looks at', (turn) => { turn.apply(text(1, 'x'.repeat(PREVIEW_MAX_INPUT + 1))); }, 'oversize'],
    ['a half character in the text', (turn) => { turn.apply(text(1, 'Hello there. � And')); }, 'bad-characters'],
    ['a line that did not parse', (turn) => { turn.apply({ type: 'textError' }); }, 'bad-line'],
    ['a filter rule that takes back what was shown', (turn) => {
      turn.apply(text(1, 'Sure thing. We need to go. Next'));
      turn.apply(text(1, 'Sure thing. We need to go. Next one.assistantfinalOnly this. Then'));
    }, 'rewrite'],
  ];
  for (const [what, act, reason] of drops) {
    it(`ends the preview for good on ${what}: nothing is shown for the rest of the turn`, () => {
      const turn = new PreviewTurn({ trimClosing: true });
      act(turn);
      expect(turn.dropped).toBe(true);
      expect(turn.reason).toBe(reason);
      expect(turn.shown).toBe('');
      expect(turn.apply(text(9, 'Fresh start here. And more'))).toBeUndefined();
      expect(turn.clear()).toBeUndefined();
      expect(turn.shown).toBe('');
    });
  }

  it('tells the page the preview is gone when it drops one that was shown', () => {
    const turn = new PreviewTurn({ trimClosing: true });
    turn.apply(text(1, 'Hello there. And so'));
    expect(turn.shown).toBe('Hello there.');
    expect(turn.apply({ type: 'textError' })).toBe('');
  });

  it('ends the preview at the event after the limit: a runner that says that much is not behaving', () => {
    const turn = new PreviewTurn({ trimClosing: true });
    for (let i = 0; i < PREVIEW_MAX_EVENTS; i++) turn.apply(text(1, 'Hello'));
    expect(turn.dropped).toBe(false);
    turn.apply(text(1, 'Hello'));
    expect(turn.dropped).toBe(true);
    expect(turn.reason).toBe('too-many-events');
  });

  it('is fed the way the runner feeds it, in chunks of any size: the same preview, never a drop', () => {
    const raw = 'Raft elects one leader per term. A candidate needs a majority.\n\nIf two split the vote, a new term starts. 🎉 Why is that safe? 日本語です。次は何ですか？ Done.';
    const whole = shownAfterEachPrefix(raw).shown[raw.length];
    for (const size of [1, 2, 3, 5, 7, 11, 40]) {
      const turn = new PreviewTurn({ trimClosing: true });
      for (let k = size; k < raw.length + size; k += size) turn.apply(text(1, raw.slice(0, Math.min(k, raw.length))));
      expect(turn.dropped, `chunks of ${size}`).toBe(false);
      expect(turn.shown, `chunks of ${size}`).toBe(whole);
    }
  });
});
