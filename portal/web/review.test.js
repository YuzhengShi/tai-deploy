// The review of a mock interview in the card's detail: the pure model (what an item says, how it is read from a line, which of two things "Practise
// this" does) and, with a small stand-in for the document, the structure of what is drawn and what the button runs. (How it LOOKS is seen in the
// browser, desktop and a phone, light and dark; portal/qa/portal_e2e.py has the flow.)
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cardOf, createCard } from './activity.js';
import { BETTER_LABEL, PRACTISE_LABEL, SAID_LABEL, TITLE, itemsOf, practiceOf, practiceText, reviewList, setPractise, toneOf, topicOf, viewOf } from './review.js';

const item = (over = {}) => ({
  question: 'Why does the leader need a majority?',
  said: 'so that two leaders cannot both commit',
  band: 'getting there',
  better: 'Say that any two majorities share a node.',
  topic: 'Raft leader election',
  ...over,
});

// ---------------------------------------------------------------- a stand-in for the document (no DOM library here): enough to build and read a tree

class Node {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.id = '';
    this.type = '';
    this.title = '';
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      toggle: (name, on) => (on === undefined ? (classes.has(name) ? classes.delete(name) : classes.add(name)) : on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    };
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(typeof n === 'string' ? Object.assign(new Node('#text'), { value: n }) : n);
  }
  get textContent() {
    return this.tag === '#text' ? this.value : this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this.children = [Object.assign(new Node('#text'), { value: String(text) })];
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return this.attrs[name];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) fn({ target: this });
  }
  all(test, out = []) {
    for (const c of this.children) {
      if (test(c)) out.push(c);
      c.all(test, out);
    }
    return out;
  }
  withClass(name) {
    return this.all((n) => n.className.split(/\s+/).includes(name) || n.classList.contains(name));
  }
}
const fakeDoc = {
  createElement: (tag) => new Node(tag),
  createElementNS: (_ns, tag) => new Node(tag),
  createTextNode: (text) => Object.assign(new Node('#text'), { value: String(text) }),
};

afterEach(() => {
  vi.useRealTimers();
  setPractise(null);
  delete globalThis.document;
});

// ---------------------------------------------------------------- reading the items of a line

describe('the items of an activity line', () => {
  it('are kept as they are when they are well formed', () => {
    expect(itemsOf([item()])).toEqual([item()]);
  });

  it('are nothing for anything that is not a list, and an item without a question is dropped', () => {
    for (const bad of [undefined, null, 'items', 4, {}, { question: 'x' }]) expect(itemsOf(bad)).toEqual([]);
    expect(itemsOf([null, 'x', 3, [], item({ question: '' }), item({ question: '   ' }), item({ question: 7 }), item()])).toEqual([item()]);
  });

  it('are eight at most, every field is a short line, and a field that is not text is empty', () => {
    expect(itemsOf(Array.from({ length: 12 }, (_, i) => item({ question: `Q${i + 1}?` })))).toHaveLength(8);
    const [long] = itemsOf([item({ question: 'w '.repeat(300), said: 'x'.repeat(500), better: 'b\nc\td', topic: 't'.repeat(400) })]);
    expect(long.question).toHaveLength(240);
    expect(long.question.endsWith('…')).toBe(true);
    expect(long.said).toHaveLength(240);
    expect(long.better).toBe('b c d');
    expect(long.topic.length).toBeLessThanOrEqual(120);
    expect(itemsOf([item({ said: { a: 1 }, better: 3, topic: null })])[0]).toEqual({ question: item().question, said: '', band: 'getting there', better: '', topic: '' });
  });

  it('say how it went in a word, and a number or markup is no word at all', () => {
    for (const word of ['solid', 'getting there', 'just started', 'not started']) expect(itemsOf([item({ band: word })])[0].band).toBe(word);
    expect(itemsOf([item({ band: 'SOLID' })])[0].band).toBe('solid');
    for (const score of ['4/5', '3', '0.7', '85%', '<b>solid</b>', '', 'solid 4']) expect(itemsOf([item({ band: score })])[0].band, score).toBe('');
  });

  it('give the tone each word is drawn in, and none to a word this page does not know', () => {
    expect([toneOf('solid'), toneOf('getting there'), toneOf('just started'), toneOf('not started')]).toEqual(['good', 'mid', 'low', 'low']);
    expect(toneOf('excellent')).toBe('none');
    expect(toneOf('')).toBe('none');
  });
});

describe('a card\'s line of an item', () => {
  it('is the question, "You said: ..." and "A stronger way to say it: ...", the band and the topic', () => {
    expect(viewOf(item())).toEqual({
      question: 'Why does the leader need a majority?',
      said: { label: 'You said: ', text: 'so that two leaders cannot both commit' },
      better: { label: 'A stronger way to say it: ', text: 'Say that any two majorities share a node.' },
      band: 'getting there',
      tone: 'mid',
      topic: 'Raft leader election',
    });
    expect([SAID_LABEL, BETTER_LABEL, PRACTISE_LABEL]).toEqual(['You said: ', 'A stronger way to say it: ', 'Practise this']);
  });

  it('leaves out a line when there is nothing to say in it', () => {
    const v = viewOf(item({ said: '', better: '', band: '', topic: '' }));
    expect(v.said).toBeNull();
    expect(v.better).toBeNull();
    expect(v.tone).toBe('none');
  });
});

// ---------------------------------------------------------------- what "Practise this" does

describe('what Practise this does', () => {
  it('is a "Talk it through" call on the question when voice calls are on and none is going', () => {
    expect(practiceOf({ voiceCalls: true, callActive: false }, item())).toEqual({ kind: 'call', mode: 'talk', topic: 'Why does the leader need a majority?' });
  });

  it('is the student\'s own message in the chat when voice calls are off', () => {
    expect(practiceOf({ voiceCalls: false, callActive: false }, item())).toEqual({ kind: 'chat', text: "Let's practise: Why does the leader need a majority?" });
    expect(practiceOf({}, item())).toEqual({ kind: 'chat', text: practiceText(item()) });
    expect(practiceOf(undefined, item()).kind).toBe('chat');
  });

  it('is that message too while a call is on (what is typed during a call joins it), never a second call', () => {
    expect(practiceOf({ voiceCalls: true, callActive: true }, item()).kind).toBe('chat');
  });

  it('keeps a call\'s topic to what voice.js sends (200 characters), cut at a word', () => {
    const long = item({ question: `${'Explain how a candidate wins a Raft election '.repeat(6)}when the logs differ?` });
    const topic = topicOf(long);
    expect(topic.length).toBeLessThanOrEqual(200);
    expect(topic).not.toMatch(/\s$/);
    expect(long.question.startsWith(topic)).toBe(true);
    expect(topic.endsWith(' ')).toBe(false);
    expect(topicOf(item())).toBe(item().question);
    expect(topicOf(item({ question: 'x'.repeat(240) }))).toHaveLength(200);
  });
});

// ---------------------------------------------------------------- what is drawn

describe('the list of a card\'s items', () => {
  it('is a title and one entry for each question: its band and topic, the question, what was said, the stronger way, and a button', () => {
    const root = reviewList([item(), item({ question: 'What is a term?', said: '', better: '', band: 'solid', topic: '' })], { practise: () => undefined, doc: fakeDoc });
    expect(root.withClass('review-title')[0].textContent).toBe(TITLE);
    const rows = root.withClass('review-item');
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(first.dataset.tone).toBe('mid');
    expect(first.withClass('review-band')[0].textContent).toBe('getting there');
    expect(first.withClass('review-band')[0].dataset.tone).toBe('mid');
    expect(first.withClass('review-topic')[0].textContent).toBe('Raft leader election');
    expect(first.withClass('review-q')[0].textContent).toBe('Why does the leader need a majority?');
    expect(first.withClass('review-said')[0].textContent).toBe('You said: so that two leaders cannot both commit');
    expect(first.withClass('review-better')[0].textContent).toBe('A stronger way to say it: Say that any two majorities share a node.');
    expect(first.withClass('review-practise')[0].textContent).toBe('Practise this');
    expect(first.withClass('review-practise')[0].getAttribute('aria-label')).toBe('Practise this: Why does the leader need a majority?');
    // the second has no said, no stronger way and no topic: those lines are not drawn, and the band is
    expect(rows[1].withClass('review-said')).toHaveLength(0);
    expect(rows[1].withClass('review-better')).toHaveLength(0);
    expect(rows[1].withClass('review-topic')).toHaveLength(0);
    expect(rows[1].withClass('review-band')[0].textContent).toBe('solid');
  });

  it('draws what it is given as text: markup in a question or a sentence is words (nothing here sets HTML, and the stand-in has no way to)', () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    const root = reviewList([item({ question: hostile, said: hostile, better: hostile, topic: hostile })], { practise: () => undefined, doc: fakeDoc });
    expect(root.withClass('review-q')[0].textContent).toBe(hostile);
    expect(root.withClass('review-said')[0].textContent).toBe(`You said: ${hostile}`);
    expect(root.all((n) => n.tag === 'img' || n.tag === 'script')).toHaveLength(0);
    expect('innerHTML' in root).toBe(false);
  });

  it('runs what the page registered, with the item, when the button is pressed, and not before', () => {
    const ran = [];
    setPractise((it) => ran.push(it.question));
    const items = [item(), item({ question: 'Second?' })];
    const root = reviewList(items, { doc: fakeDoc });
    expect(ran).toEqual([]);
    const buttons = root.withClass('review-practise');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(ran).toEqual(['Second?']);
    buttons[0].click();
    expect(ran).toEqual(['Second?', 'Why does the leader need a majority?']);
  });

  it('takes the button out of use for a moment once it is pressed: a double click does not start two things', () => {
    vi.useFakeTimers();
    const ran = [];
    const root = reviewList([item()], { practise: (it) => ran.push(it), doc: fakeDoc });
    const button = root.withClass('review-practise')[0];
    button.click();
    expect(button.disabled).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(button.disabled).toBe(false);
    expect(ran).toHaveLength(1);
  });

  it('draws no button when there is nothing for it to do: nothing is drawn that does not work', () => {
    setPractise(null);
    const root = reviewList([item()], { doc: fakeDoc });
    expect(root.withClass('review-practise')).toHaveLength(0);
    expect(root.withClass('review-q')).toHaveLength(1);
  });
});

describe('the card of an interview', () => {
  const line = (over = {}) => ({ n: 4, ts: '2026-11-04T20:00:00Z', role: 'assistant', kind: 'activity', type: 'interview', title: 'Mock interview · 12 min', text: 'Went through HW3', ...over });

  it('carries its items only when the line has some: an older line gives the card it always gave', () => {
    expect(cardOf(line())).toEqual({ n: 4, ts: '2026-11-04T20:00:00Z', type: 'interview', title: 'Mock interview · 12 min', text: 'Went through HW3', detail: '', legacy: false });
    expect(cardOf(line({ items: [] }))).not.toHaveProperty('items');
    expect(cardOf(line({ items: 'nonsense' }))).not.toHaveProperty('items');
    expect(cardOf(line({ detail: 'We went through it.', items: [item(), { nothing: 1 }] }))).toMatchObject({ detail: 'We went through it.', items: [item()] });
  });

  it('opens, with its questions in the detail after its words, even when it has no words of its own', () => {
    globalThis.document = fakeDoc;
    setPractise(() => undefined);
    const withWords = createCard(cardOf(line({ detail: 'We went through it.', items: [item()] })), { variant: 'in-chat', id: 'acard-4' });
    expect(withWords.openable).toBe(true);
    expect(withWords.detail.children.map((c) => c.className)).toEqual(['acard-detail-text', 'review']);
    const onlyItems = createCard(cardOf(line({ items: [item(), item({ question: 'Second?' })] })), { variant: 'in-chat', id: 'acard-5' });
    expect(onlyItems.openable).toBe(true);
    expect(onlyItems.detail.withClass('review-item')).toHaveLength(2);
    expect(onlyItems.toggle()).toBe(true);
    expect(onlyItems.isOpen()).toBe(true);
  });

  it('is a plain card, as before, with no detail and no items', () => {
    globalThis.document = fakeDoc;
    const plain = createCard(cardOf(line()), { variant: 'in-chat', id: 'acard-6' });
    expect(plain.openable).toBe(false);
    expect(plain.detail.withClass('review')).toHaveLength(0);
  });
});
