import { describe, expect, it } from 'vitest';

import { MAX_OPTIONS, OPTION_CHARS, WHY_CHARS, parseChoices, shuffleQuiz } from './choices.js';

const QUIZ = `Which of these is true of a Raft term?

<choices>
<option>Every heartbeat starts a new term</option>
<option correct>A term has at most one leader</option>
<option>The term number can go down after a failure</option>
<why>Each term starts with an election and has at most one winner; terms only go up.</why>
</choices>`;

describe('parseChoices', () => {
  it('hands a text with no block back exactly as it was', () => {
    const text = '  Two things:\n\n- one\n- two  \n';
    expect(parseChoices(text)).toEqual({ text });
    expect(parseChoices('a < b and c > d')).toEqual({ text: 'a < b and c > d' });
  });

  it('takes a quick check apart: the words, the options with letters, the marked answer and the note for TAi', () => {
    const parsed = parseChoices(QUIZ);
    expect(parsed.text).toBe('Which of these is true of a Raft term?');
    expect(parsed.choices).toEqual([
      { label: 'A', text: 'Every heartbeat starts a new term' },
      { label: 'B', text: 'A term has at most one leader' },
      { label: 'C', text: 'The term number can go down after a failure' },
    ]);
    expect(parsed.quiz).toBe(true);
    expect(parsed.key).toBe(1);
    expect(parsed.why).toBe('Each term starts with an election and has at most one winner; terms only go up.');
  });

  it('takes options with no answer as quick replies: not a quiz, no key', () => {
    const parsed = parseChoices('Which part is confusing?\n<choices>\n<option>The election</option>\n<option>The log</option>\n</choices>');
    expect(parsed.text).toBe('Which part is confusing?');
    expect(parsed.choices).toHaveLength(2);
    expect(parsed.quiz).toBeUndefined();
    expect(parsed.key).toBeUndefined();
    expect(parsed.why).toBeUndefined();
  });

  it('reads the answer however it is marked, and not when it says it is not', () => {
    const mark = (attrs: string) => parseChoices(`Q?\n<choices><option>x</option><option ${attrs}>y</option><option>z</option></choices>`).key;
    expect(mark('correct')).toBe(1);
    expect(mark('correct="true"')).toBe(1);
    expect(mark("correct='yes'")).toBe(1);
    expect(mark('correct=1')).toBe(1);
    expect(mark('data-correct')).toBe(1);
    expect(mark('correct="false"')).toBeUndefined();
    expect(mark('correct="0"')).toBeUndefined();
    expect(mark('wrong')).toBeUndefined();
  });

  it('takes two marked answers for no answer', () => {
    const parsed = parseChoices('Q?\n<choices><option correct>x</option><option correct>y</option><option>z</option></choices>');
    expect(parsed.choices).toHaveLength(3);
    expect(parsed.key).toBeUndefined();
    expect(parsed.quiz).toBeUndefined();
  });

  it('reads an answer given on the block as a letter or a number, and ignores one that is not an option', () => {
    const block = (attrs: string) => parseChoices(`Q?\n<choices ${attrs}><option>x</option><option>y</option><option>z</option></choices>`);
    expect(block('answer="C"').key).toBe(2);
    expect(block('answer="b"').key).toBe(1);
    expect(block('correct="2"').key).toBe(1);
    expect(block('answer="F"').key).toBeUndefined();
    expect(block('answer="the second"').key).toBeUndefined();
    expect(block('quiz').quiz).toBe(true);
    expect(block('quiz').key).toBeUndefined();
    expect(block('quiz="false"').quiz).toBeUndefined();
  });

  it('is generous about tags nobody closed', () => {
    const open = parseChoices('Which?\n<choices>\n<option>one\n<option correct>two\n<option>three\n<why>because');
    expect(open.choices?.map((c) => c.text)).toEqual(['one', 'two', 'three']);
    expect(open.key).toBe(1);
    expect(open.why).toBe('because');
    expect(open.text).toBe('Which?');
  });

  it('takes one option to a line when there are no option tags, and the usual ways of marking the answer', () => {
    const parsed = parseChoices('Pick one\n<choices>\nA. the leader *\nB) a follower\n(c) a candidate\n</choices>');
    expect(parsed.choices?.map((c) => c.text)).toEqual(['the leader', 'a follower', 'a candidate']);
    expect(parsed.key).toBe(0);
    const ticked = parseChoices('Pick one\n<choices>\n- yes ✓\n- no\n</choices>');
    expect(ticked.choices?.map((c) => c.text)).toEqual(['yes', 'no']);
    expect(ticked.key).toBe(0);
    expect(parseChoices('Pick one\n<choices>\n1. first (correct)\n2. second\n</choices>').key).toBe(0);
  });

  it('takes a list marker the model put in front of an option off, because the page numbers them', () => {
    const parsed = parseChoices('Q?\n<choices><option>A. alpha</option><option>(b) beta</option><option>C) gamma</option><option>D: delta</option><option>1. one</option><option>e.g. eagle</option></choices>');
    expect(parsed.choices?.map((c) => c.text)).toEqual(['alpha', 'beta', 'gamma', 'delta', 'one', 'e.g. eagle']);
    expect(parsed.choices?.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('keeps an option to plain text: tags go, entities are read, a comparison stays', () => {
    const parsed = parseChoices('Q?\n<choices><option>use <b>bold</b> and <script>x</script></option><option>n &lt; m &amp;&amp; m &gt; 0</option><option>when a < b</option></choices>');
    expect(parsed.choices?.map((c) => c.text)).toEqual(['use bold and x', 'n < m && m > 0', 'when a < b']);
  });

  it('keeps the options in the text as a plain list when there are not two of them, and loses nothing', () => {
    const one = parseChoices('Which?\n<choices><option>only this</option></choices>');
    expect(one.choices).toBeUndefined();
    expect(one.text).toBe('Which?\n\nA. only this');
    const none = parseChoices('Which?\n<choices></choices>');
    expect(none).toEqual({ text: 'Which?' });
  });

  it('can be switched off: the options are a lettered list in the text, with no answer to give away', () => {
    const off = parseChoices(QUIZ, false);
    expect(off.choices).toBeUndefined();
    expect(off.key).toBeUndefined();
    expect(off.why).toBeUndefined();
    expect(off.text).toBe('Which of these is true of a Raft term?\n\nA. Every heartbeat starts a new term\nB. A term has at most one leader\nC. The term number can go down after a failure');
    expect(off.text).not.toMatch(/election and has at most one winner/);
  });

  it('allows six options and no more', () => {
    const options = (n: number) => Array.from({ length: n }, (_, i) => `<option>option ${i + 1}</option>`).join('');
    const many = parseChoices(`Q?\n<choices>${options(9)}</choices>`);
    expect(many.choices).toHaveLength(MAX_OPTIONS);
    const late = parseChoices(`Q?\n<choices>${options(6)}<option correct>seventh</option></choices>`);
    expect(late.choices).toHaveLength(MAX_OPTIONS);
    expect(late.key).toBeUndefined();
  });

  it('keeps an option and a note within their limits, on one line', () => {
    const long = parseChoices(`Q?\n<choices><option>${'word '.repeat(60)}</option><option>b</option><why>${'because '.repeat(200)}\nand again</why></choices>`);
    expect(long.choices![0].text.length).toBeLessThanOrEqual(OPTION_CHARS);
    expect(long.choices![0].text.endsWith('…')).toBe(true);
    expect(long.why!.length).toBeLessThanOrEqual(WHY_CHARS);
    expect(long.why).not.toMatch(/\n/);
    const multi = parseChoices('Q?\n<choices><option>first\n   line\tbroken</option><option>b</option></choices>');
    expect(multi.choices![0].text).toBe('first line broken');
  });

  it('joins the words before and after the block, and drops a second block', () => {
    const parsed = parseChoices('Quick check:\n<choices><option>x</option><option>y</option></choices>\nTake your time.\n<choices><option>p</option><option>q</option></choices>');
    expect(parsed.text).toBe('Quick check:\n\nTake your time.');
    expect(parsed.choices?.map((c) => c.text)).toEqual(['x', 'y']);
  });

  it('asks with the question inside the block when there are no words before it, and falls back to a list when there is no question at all', () => {
    const inside = parseChoices('<choices><question>What happens next?</question><option>x</option><option>y</option></choices>');
    expect(inside.text).toBe('What happens next?');
    expect(inside.choices).toHaveLength(2);
    const bare = parseChoices('<choices><option>x</option><option>y</option></choices>');
    expect(bare.choices).toBeUndefined();
    expect(bare.text).toBe('A. x\nB. y');
  });

  it('does not mind the case of the tags, or words in another language', () => {
    const parsed = parseChoices('哪一个是对的？\n<CHOICES>\n<Option>领导者每个任期最多一个</Option>\n<OPTION CORRECT>跟随者可以同时当领导者</OPTION>\n</CHOICES>');
    expect(parsed.text).toBe('哪一个是对的？');
    expect(parsed.choices?.map((c) => c.text)).toEqual(['领导者每个任期最多一个', '跟随者可以同时当领导者']);
    expect(parsed.key).toBe(1);
  });

  it('takes the same option twice for one, and for the answer when either was marked', () => {
    const twice = parseChoices('Q?\n<choices><option>same thing</option><option correct>Same Thing</option><option>other</option></choices>');
    expect(twice.choices?.map((c) => c.text)).toEqual(['same thing', 'other']);
    expect(twice.key).toBe(0);
    const first = parseChoices('Q?\n<choices><option correct>one</option><option>one</option><option>two</option></choices>');
    expect(first.choices?.map((c) => c.text)).toEqual(['one', 'two']);
    expect(first.key).toBe(0);
    const left = parseChoices('Q?\n<choices><option>x</option><option>X</option></choices>');
    expect(left.choices).toBeUndefined();                           // one option is no question
    expect(left.text).toBe('Q?\n\nA. x');
  });

  it('leaves no tag of its own in the words', () => {
    const parsed = parseChoices('Hi </option> there\n<choices><option>x</option><option>y</option></choices> <why>stray</why> bye');
    expect(parsed.text).not.toMatch(/<|>/);
    expect(parsed.text).toContain('Hi');
    expect(parsed.text).toContain('bye');
  });
});

describe('shuffleQuiz', () => {
  const quiz = () => parseChoices('Which?\n<choices><option>alpha</option><option correct>beta</option><option>gamma</option><option>delta</option></choices>');
  /** A fixed sequence for the shuffle, so the order is the same on every run. */
  const sequence = (...values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it('puts the options in another order, relabels them A to D in it, and the answer still points at the same words', () => {
    const shuffled = shuffleQuiz(quiz(), sequence(0, 0, 0));
    expect(shuffled.choices?.map((c) => c.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(shuffled.choices?.map((c) => c.text)).not.toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect([...(shuffled.choices ?? [])].map((c) => c.text).sort()).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(shuffled.choices![shuffled.key!].text).toBe('beta');
    expect(shuffled.text).toBe('Which?');
    expect(shuffled.quiz).toBe(true);
  });

  it('does not always leave the answer second: over many shuffles it lands in every place', () => {
    const places = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const s = shuffleQuiz(quiz());
      expect(s.choices![s.key!].text).toBe('beta');
      places.add(s.key!);
    }
    expect([...places].sort()).toEqual([0, 1, 2, 3]);
  });

  it('leaves a question with no answer marked, and one that has an option that depends on its place', () => {
    const open = parseChoices('Which?\n<choices><option>a</option><option>b</option><option>c</option></choices>');
    expect(shuffleQuiz(open, sequence(0))).toBe(open);
    for (const bound of ['All of the above', 'None of the above', 'Both A and B', 'A and C', 'Neither of these', 'The previous option', 'Option B only']) {
      const q = parseChoices(`Which?\n<choices><option>one</option><option correct>two</option><option>${bound}</option></choices>`);
      expect(shuffleQuiz(q, sequence(0))).toBe(q);
    }
    const fine = parseChoices('Which?\n<choices><option>an all-in-one design</option><option correct>b-trees</option></choices>');
    expect(shuffleQuiz(fine, sequence(0.99))).not.toBe(fine);
  });
});
