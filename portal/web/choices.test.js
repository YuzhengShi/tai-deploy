// The pure parts of the options a student can tap: which lines have options, how they stand (open, answered, closed), what the buttons look
// like, what copying and tapping give. (The buttons are DOM: the browser suite, portal/qa/portal_e2e.py, taps them, reloads, types instead, and
// takes them with the keyboard and a finger.)
import { describe, expect, it } from 'vitest';

import { MAX_OPTIONS, copyTextOf, optionsOf, standOf, tapText, verdictOf, viewOf } from './choices.js';

const OPTIONS = [
  { label: 'A', text: 'Every heartbeat starts a new term' },
  { label: 'B', text: 'A term has at most one leader' },
  { label: 'C', text: 'The term number can go down after a failure' },
];
/** TAi's line with options, as the page holds it. */
const asks = (n, extra = {}) => ({ n, ts: '2026-11-03T10:00:00Z', role: 'assistant', text: 'Which of these is true of a Raft term?', choices: OPTIONS, quiz: true, ...extra });
const said = (n, extra = {}) => ({ n, ts: '2026-11-03T10:01:00Z', role: 'user', text: 'a message', ...extra });
const tap = (n, to, index, correct) => ({ n, ts: '2026-11-03T10:01:00Z', role: 'user', text: `${OPTIONS[index].label}. ${OPTIONS[index].text}`, choice: { to, index, ...(correct === undefined ? {} : { correct }) } });

describe('the options of a line', () => {
  it('are two to six, each a letter and its words', () => {
    expect(optionsOf(asks(4))).toEqual(OPTIONS);
    expect(optionsOf(asks(4, { choices: OPTIONS.slice(0, 2) }))).toHaveLength(2);
    const six = Array.from({ length: MAX_OPTIONS }, (_, i) => ({ label: 'ABCDEF'[i], text: `option ${i}` }));
    expect(optionsOf(asks(4, { choices: six }))).toHaveLength(6);
  });

  it('are none when there are fewer than two, more than six, or one has no words', () => {
    expect(optionsOf(asks(4, { choices: OPTIONS.slice(0, 1) }))).toBeNull();
    expect(optionsOf(asks(4, { choices: Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => ({ label: 'A', text: `option ${i}` })) }))).toBeNull();
    expect(optionsOf(asks(4, { choices: [OPTIONS[0], { label: 'B', text: '   ' }] }))).toBeNull();
    expect(optionsOf(asks(4, { choices: 'A, B' }))).toBeNull();
    expect(optionsOf(asks(4, { choices: undefined }))).toBeNull();
  });

  it('are only on TAi\'s words: not on the student\'s lines, a picture or a card', () => {
    expect(optionsOf(asks(4, { role: 'user' }))).toBeNull();
    expect(optionsOf(asks(4, { kind: 'image' }))).toBeNull();
    expect(optionsOf(asks(4, { kind: 'activity' }))).toBeNull();
    expect(optionsOf(asks(4, { kind: 'text' }))).toEqual(OPTIONS);
    expect(optionsOf(null)).toBeNull();
    expect(optionsOf('text')).toBeNull();
  });

  it('get their letters back when a line leaves them out or garbles them, and their words flattened to one line', () => {
    const odd = optionsOf(asks(4, { choices: [{ text: 'first' }, { label: 'zz', text: 'second\n line' }, { label: 'c', text: 'third' }] }));
    expect(odd.map((o) => o.label)).toEqual(['A', 'B', 'C']);
    expect(odd[1].text).toBe('second line');
  });

  it('keep markup as the words it is (the page puts it on as text)', () => {
    expect(optionsOf(asks(4, { choices: [{ label: 'A', text: '<b>bold</b> & <script>x</script>' }, OPTIONS[1]] }))[0].text).toBe('<b>bold</b> & <script>x</script>');
  });
});

describe('how the options of a line stand', () => {
  it('are open while nothing has been said since', () => {
    expect(standOf([asks(4)], 4)).toEqual({ state: 'open' });
    expect(standOf([], 4)).toEqual({ state: 'open' });
    expect(standOf(undefined, 4)).toEqual({ state: 'open' });
  });

  it('are still open after an emoji, a thumb, a card of the activity list and TAi\'s own emoji: none of them is something said', () => {
    const lines = [asks(4), { n: 5, role: 'user', kind: 'react', text: '', to: 4, emoji: '👍' }, { n: 6, role: 'user', kind: 'feedback', text: '', to: 4, rating: 'up' }, { n: 7, role: 'assistant', kind: 'activity', type: 'voice', title: 'Voice call', text: 'a call' }, { n: 8, role: 'assistant', kind: 'react', to: 3, emoji: '👍' }, { n: 9, role: 'assistant', kind: 'voice', text: 'Voice session, 3 min: …' }];
    expect(standOf(lines, 4)).toEqual({ state: 'open' });
  });

  it('are still open after the words of a voice call and its markers: what is said aloud is not a message, as the server counts it', () => {
    const lines = [asks(4), { n: 5, role: 'assistant', kind: 'speech', call: 'abc', text: '', event: 'start', mode: 'conversational' }, { n: 6, role: 'user', kind: 'speech', call: 'abc', text: 'hello there' }, { n: 7, role: 'assistant', kind: 'speech', call: 'abc', text: 'What would you like to talk through?' }, { n: 8, role: 'assistant', kind: 'speech', call: 'abc', text: '', event: 'end', seconds: 60 }];
    expect(standOf(lines, 4)).toEqual({ state: 'open' });
    expect(standOf([...lines, tap(9, 4, 1, true)], 4)).toEqual({ state: 'answered', chosen: 1, correct: true });
  });

  it('are closed by the student\'s words or voice note, and by TAi\'s words or picture', () => {
    expect(standOf([asks(4), said(5)], 4)).toEqual({ state: 'closed' });
    expect(standOf([asks(4), said(5, { kind: 'audio', text: 'hello' })], 4)).toEqual({ state: 'closed' });
    expect(standOf([asks(4), { n: 5, role: 'assistant', text: 'And one more thing.' }], 4)).toEqual({ state: 'closed' });
    expect(standOf([asks(4), { n: 5, role: 'assistant', kind: 'image', text: 'A diagram', media: 'x' }], 4)).toEqual({ state: 'closed' });
  });

  it('are closed while a message of the student\'s is on its way and has no number yet', () => {
    expect(standOf([asks(4)], 4, { said: true })).toEqual({ state: 'closed' });
    expect(standOf([asks(4), tap(5, 4, 1, true)], 4, { said: true }).state).toBe('answered');
  });

  it('are answered once a later line of the student\'s is a tap on them: which option, and whether it was right when TAi marked one', () => {
    expect(standOf([asks(4), tap(5, 4, 1, true)], 4)).toEqual({ state: 'answered', chosen: 1, correct: true });
    expect(standOf([asks(4), tap(5, 4, 0, false)], 4)).toEqual({ state: 'answered', chosen: 0, correct: false });
    expect(standOf([asks(4, { quiz: undefined }), tap(5, 4, 2)], 4)).toEqual({ state: 'answered', chosen: 2 });
  });

  it('are answered however the lines are ordered (a reply can be held before the line of the tap that it answers)', () => {
    const reply = { n: 6, role: 'assistant', text: 'Good.' };
    expect(standOf([asks(4), reply, tap(5, 4, 1, true)], 4)).toEqual({ state: 'answered', chosen: 1, correct: true });
  });

  it('are closed, not answered, by a tap on another line, and by a tap that came after something else was said', () => {
    expect(standOf([asks(4), asks(5), tap(6, 5, 1, true)], 4)).toEqual({ state: 'closed' });
    expect(standOf([asks(4), said(5), tap(6, 4, 1, true)], 4)).toEqual({ state: 'closed' });
  });

  it('answer for each line by its own number', () => {
    const lines = [asks(4), tap(5, 4, 0, false), { n: 6, role: 'assistant', text: 'Not quite.' }, asks(7, { quiz: undefined })];
    expect(standOf(lines, 4)).toMatchObject({ state: 'answered', chosen: 0 });
    expect(standOf(lines, 7)).toEqual({ state: 'open' });
  });
});

describe('what the buttons look like', () => {
  it('are all on while open', () => {
    expect(viewOf(OPTIONS, { state: 'open' })).toEqual({ phase: 'open', disabled: false, states: ['open', 'open', 'open'], verdict: '' });
  });

  it('are all off at once on a tap, the one tapped pending', () => {
    expect(viewOf(OPTIONS, { state: 'open' }, { picked: 1 })).toMatchObject({ phase: 'pending', disabled: true, states: ['dim', 'pending', 'dim'], verdict: '' });
  });

  it('show a tick on the right pick and a cross on the wrong one, and say Correct or Not quite', () => {
    expect(viewOf(OPTIONS, { state: 'answered', chosen: 1, correct: true })).toMatchObject({ phase: 'answered', disabled: true, states: ['dim', 'right', 'dim'], verdict: 'Correct' });
    expect(viewOf(OPTIONS, { state: 'answered', chosen: 0, correct: false })).toMatchObject({ phase: 'answered', disabled: true, states: ['wrong', 'dim', 'dim'], verdict: 'Not quite' });
  });

  it('never show which option was right after a wrong pick: only the pick is marked and the rest are dimmed', () => {
    const view = viewOf(OPTIONS, { state: 'answered', chosen: 0, correct: false });
    expect(view.states.filter((state) => state === 'right')).toHaveLength(0);
    expect(view.states.filter((state) => state === 'dim')).toHaveLength(2);
  });

  it('only say chosen, with no verdict, when TAi marked no answer', () => {
    expect(viewOf(OPTIONS, { state: 'answered', chosen: 2 })).toMatchObject({ phase: 'answered', states: ['dim', 'dim', 'chosen'], verdict: '' });
  });

  it('are all off and dimmed, with nothing highlighted, once closed (or when the server said it could not take the tap)', () => {
    expect(viewOf(OPTIONS, { state: 'closed' })).toEqual({ phase: 'closed', disabled: true, states: ['closed', 'closed', 'closed'], verdict: '' });
    expect(viewOf(OPTIONS, { state: 'open' }, { closed: true })).toMatchObject({ phase: 'closed', disabled: true });
  });

  it('are closed, not highlighted, for an answer that names no option of the line', () => {
    expect(viewOf(OPTIONS, { state: 'answered', chosen: 9, correct: true }).phase).toBe('closed');
    expect(viewOf(OPTIONS, { state: 'answered', chosen: -1 }).phase).toBe('closed');
  });

  it('call the verdict by what the server said', () => {
    expect(verdictOf(true)).toBe('Correct');
    expect(verdictOf(false)).toBe('Not quite');
    expect(verdictOf(undefined)).toBe('');
  });
});

describe('what copying and tapping give', () => {
  it('copy the question and then the options as lines', () => {
    expect(copyTextOf(asks(4), OPTIONS)).toBe('Which of these is true of a Raft term?\n\nA. Every heartbeat starts a new term\nB. A term has at most one leader\nC. The term number can go down after a failure');
  });

  it('copy only the options when the line has no question', () => {
    expect(copyTextOf({ text: '' }, OPTIONS)).toBe('A. Every heartbeat starts a new term\nB. A term has at most one leader\nC. The term number can go down after a failure');
  });

  it('say, as the student\'s message, the letter and the option (as the server records it)', () => {
    expect(tapText(OPTIONS[1])).toBe('B. A term has at most one leader');
  });
});
