// The viewer's pure parts: the words and boxes of a page (against the server's own src/docs/words.ts), what a drag selects, the boxes at any zoom, what each action reports to the view,
// what a reload keeps, the three messages of a call, and how a document the student attached is opened. The DOM over them is checked in the browser (portal/qa).
import { describe, expect, it } from 'vitest';

import { boxesFor as serverBoxesFor, deriveLines as serverDeriveLines, nearestWord as serverNearestWord, pageText as serverPageText, textOf as serverTextOf, validateWords } from '../../src/docs/words.ts';
import { createViewState } from './view-state.js';
import { SCREEN_TYPES, sendViewOver } from './voice.js';
import {
  HIGHLIGHT_MS, JOB_LIMIT_MS, MAX_SELECTION_WORDS, MIN_POINT_MS, SETTLE_MS, boxStyle, boxesFor, cleanBoxes, clampPage, deriveLines, isOfficeFile, isOpenable, isPdfFile, jobAnswer, metaProblem, naturalWidthOf, nearestWord, nextZoom, offerOpen, openAnswer, openRequest,
  orderRange, pageText, pageWidth, parseScreenMessage, parseStored, parseZoom, pointPlan, pointStyle, pointTimeLeft, pollJob, problemWords, quoteOf, readMeta, readWords, selectionFromDrag, serializeStored, textOf,
  textUnderBoxes, toFraction, turnedQuickly, viewForClose, viewForPage, viewForPoint, viewForSelection, wordAtPoint,
} from './viewer.js';

const DOC = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

/** A page of text as the renderer writes it: three lines of words, each word as wide as its letters, in reading order. */
function makePage(rows = [
  { y: 0.1, text: 'Raft elects a leader' },
  { y: 0.16, text: 'by majority vote in each term' },
  { y: 0.22, text: 'and a follower becomes a candidate' },
]) {
  const words = [];
  const lines = [];
  for (const row of rows) {
    const first = words.length;
    let x = 0.1;
    for (const text of row.text.split(' ')) {
      const width = 0.012 * text.length;
      words.push([x, row.y, x + width, row.y + 0.03, text]);
      x += width + 0.015;
    }
    lines.push([first, words.length - 1]);
  }
  return { words, lines };
}

/** `count` words on lines of ten, small enough to fit on one page: for the 600-word limit. */
function longPage(count) {
  const words = [];
  const lines = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 10);
    const col = i % 10;
    const y = 0.01 + row * 0.0105;
    words.push([0.05 + col * 0.09, y, 0.05 + col * 0.09 + 0.07, y + 0.008, `w${i}`]);
    if (col === 0) lines.push([i, i]);
    else lines[lines.length - 1][1] = i;
  }
  return { words, lines };
}

/** The middle of word `i` of a longPage. */
const longCentre = (i) => ({ x: 0.05 + (i % 10) * 0.09 + 0.035, y: 0.01 + Math.floor(i / 10) * 0.0105 + 0.004 });

describe('clampPage', () => {
  it('keeps a page inside the document and takes anything else to page 1', () => {
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(99, 5)).toBe(5);
    expect(clampPage(-4, 5)).toBe(1);
    expect(clampPage('2', 5)).toBe(2);
    expect(clampPage(2.6, 5)).toBe(3);
    expect(clampPage(undefined, 5)).toBe(1);
    expect(clampPage(NaN, 5)).toBe(1);
    expect(clampPage('x', 5)).toBe(1);
  });

  it('does not go past the pages the server keeps while the page count is not known', () => {
    expect(clampPage(500)).toBe(120);
    expect(clampPage(7, null)).toBe(7);
    expect(clampPage(7, 0)).toBe(7);
  });
});

describe('readMeta', () => {
  const meta = { id: DOC, title: '  Homework 5\n spec.pdf ', pages: 4, origin: 'upload', createdAt: 1, bytes: 1000, aspect: 0.77 };

  it('reads a document meta bare or inside `meta`, with the title on one line', () => {
    const expected = { id: DOC, title: 'Homework 5 spec.pdf', pages: 4, aspect: 0.77, origin: 'upload' };
    expect(readMeta(meta, DOC)).toEqual(expected);
    expect(readMeta({ ok: true, meta }, DOC)).toEqual(expected);
  });

  it('refuses a meta for another document, without pages, or that is not an object', () => {
    expect(readMeta(meta, OTHER)).toBeNull();
    expect(readMeta({ ...meta, pages: 0 }, DOC)).toBeNull();
    expect(readMeta({ ...meta, pages: 'four' }, DOC)).toBeNull();
    expect(readMeta({ ...meta, id: 'not-an-id' }, DOC)).toBeNull();
    for (const bad of [null, undefined, 'meta', 7, [meta]]) expect(readMeta(bad, DOC)).toBeNull();
  });

  it('keeps an unlikely shape or title out and cuts the page count at what the server keeps', () => {
    expect(readMeta({ ...meta, aspect: 0 }, DOC).aspect).toBeNull();
    expect(readMeta({ ...meta, aspect: 0.04 }, DOC).aspect).toBeNull();
    expect(readMeta({ ...meta, aspect: 40 }, DOC).aspect).toBeNull();
    expect(readMeta({ ...meta, aspect: 2.4 }, DOC).aspect).toBe(2.4);
    expect(readMeta({ ...meta, aspect: 'wide' }, DOC).aspect).toBeNull();
    expect(readMeta({ ...meta, title: '' }, DOC).title).toBe('Document');
    expect(readMeta({ ...meta, title: 'x'.repeat(500) }, DOC).title.length).toBe(120);
    expect(readMeta({ ...meta, pages: 900 }, DOC).pages).toBe(120);
    expect(readMeta({ ...meta, origin: 'elsewhere' }, DOC).origin).toBeNull();
  });

  it('takes the id it asked for when the server leaves it out', () => {
    const { id: _gone, ...bare } = meta;
    expect(readMeta(bare, DOC).id).toBe(DOC);
  });
});

describe('readWords', () => {
  it('agrees with the server\'s validateWords on a words file', () => {
    const raw = {
      words: [[0.1, 0.1, 0.2, 0.13, 'Raft'], [0.21, 0.1, 0.3, 0.13, 'elects'], [0.1, 0.2, 0.15, 0.23, 'a'], [0.16, 0.2, 0.3, 0.23, 'leader']],
      lines: [[0, 1], [2, 3]],
    };
    expect(readWords(raw)).toEqual(validateWords(raw));
    // corners the wrong way round, numbers outside the page, a word with spaces and control characters inside
    const messy = { words: [[0.3, 0.13, 0.1, 0.1, 'Ra ft'], [-1, 2, 0.5, 0.5, 'edge'], [0.1, 0.1, 0.2, 'x', 'bad'], [0.1, 0.1, 0.2, 0.2, ''], [0.1, 0.1, 0.2, 0.2, 7]] };
    expect(readWords(messy).words).toEqual(validateWords(messy).words);
    expect(readWords(messy).words[0]).toEqual([0.1, 0.1, 0.3, 0.13, 'Raft']);
    expect(readWords(messy).words.length).toBe(2);
  });

  it('reads words inside `words` too, and gives null for what is not a words file or has too many words', () => {
    const raw = { words: [[0.1, 0.1, 0.2, 0.13, 'Raft']], lines: [[0, 0]] };
    expect(readWords({ ok: true, words: raw })).toEqual(readWords(raw));
    for (const bad of [null, undefined, 'words', {}, { words: 'x' }, { words: { words: 3 } }]) expect(readWords(bad)).toBeNull();
    expect(readWords({ words: Array.from({ length: 4001 }, () => [0.1, 0.1, 0.2, 0.2, 'w']) })).toBeNull();
    expect(readWords({ words: Array.from({ length: 4000 }, () => [0.1, 0.1, 0.2, 0.2, 'w']) }).words.length).toBe(4000);
  });

  it('keeps lines that tile the words and makes them from the boxes when they do not', () => {
    const page = makePage();
    expect(readWords(page).lines).toEqual(page.lines);
    const noLines = readWords({ words: page.words });
    expect(noLines.lines).toEqual(page.lines);
    const skipped = readWords({ words: page.words, lines: [[0, 2], [4, 8]] });      // words 3 and past 8 are in no line: the page's own lines are made instead
    expect(skipped.lines).toEqual(page.lines);
    expect(readWords({ words: page.words, lines: [[0, 3], [3, 8], [9, 14]] }).lines).toEqual(page.lines);   // overlapping lines
    expect(readWords({ words: page.words, lines: 'x' }).lines).toEqual(page.lines);
  });

  it('makes no lines for a page with no words (a scan)', () => {
    expect(readWords({ words: [], lines: [] })).toEqual({ words: [], lines: [] });
  });
});

describe('the words and boxes agree with the server\'s own', () => {
  const page = makePage();

  it('derives the same lines, boxes, text and nearest word', () => {
    expect(deriveLines(page.words)).toEqual(serverDeriveLines(page.words));
    for (const [from, to] of [[0, 0], [1, 3], [2, 9], [0, 14], [5, 6], [9, 14]]) {
      expect(boxesFor(page, from, to)).toEqual(serverBoxesFor(page, from, to));
      expect(textOf(page, from, to)).toBe(serverTextOf(page, from, to));
      expect(textOf(page, to, from)).toBe(serverTextOf(page, to, from));
    }
    expect(pageText(page)).toBe(serverPageText(page));
    for (const [x, y] of [[0.12, 0.11], [0.5, 0.5], [0.9, 0.9], [0.0, 0.0], [0.3, 0.17], [0.2, 0.135]]) expect(nearestWord(page, x, y)).toBe(serverNearestWord(page, x, y));
  });

  it('draws one box for each line a selection touches', () => {
    expect(boxesFor(page, 2, 3)).toHaveLength(1);      // "a leader": the end of line one
    expect(boxesFor(page, 3, 5)).toHaveLength(2);      // "leader" and "by majority"
    expect(boxesFor(page, 0, 14)).toHaveLength(3);
    expect(boxesFor(page, 50, 60)).toEqual([]);
  });
});

describe('wordAtPoint', () => {
  const page = makePage();
  const at = (word) => {
    const [x0, y0, x1, y1] = page.words[word];
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };

  it('finds the word a point is over', () => {
    for (const word of [0, 3, 4, 7, 11]) expect(wordAtPoint(page, ...at(word))).toBe(word);
  });

  it('takes the nearer neighbour for a point in the gap between two words', () => {
    const [, y] = at(0);
    const gap = (page.words[0][2] + page.words[1][0]) / 2;
    expect(wordAtPoint(page, gap - 0.004, y)).toBe(0);
    expect(wordAtPoint(page, gap + 0.004, y)).toBe(1);
  });

  it('finds the first word of a line from its left margin and the last word from beyond its end', () => {
    expect(wordAtPoint(page, 0.02, 0.175)).toBe(4);
    expect(wordAtPoint(page, 0.98, 0.175)).toBe(9);
    expect(wordAtPoint(page, 0.98, 0.115)).toBe(3);
  });

  it('finds the line beside a point a little above or below it and nothing far from any text', () => {
    expect(wordAtPoint(page, 0.15, 0.085)).toBeGreaterThanOrEqual(0);
    expect(wordAtPoint(page, 0.5, 0.9)).toBeNull();
    expect(wordAtPoint(page, 0.5, 0.01)).toBeNull();
  });

  it('is null on a page with no words', () => {
    expect(wordAtPoint({ words: [], lines: [] }, 0.5, 0.5)).toBeNull();
  });
});

describe('selectionFromDrag', () => {
  const page = makePage();
  const centre = (word) => {
    const [x0, y0, x1, y1] = page.words[word];
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  };

  it('selects from the word under the start to the word under the end, in reading order', () => {
    expect(selectionFromDrag(page, centre(1), centre(3))).toEqual({ from: 1, to: 3 });
    expect(selectionFromDrag(page, centre(2), centre(6))).toEqual({ from: 2, to: 6 });
  });

  it('is the same for a drag made backwards, and for a drag across the whole page', () => {
    expect(selectionFromDrag(page, centre(6), centre(2))).toEqual({ from: 2, to: 6 });
    expect(selectionFromDrag(page, centre(0), centre(14))).toEqual({ from: 0, to: 14 });
  });

  it('is one word for a drag that ends where it began, and counts a drag that ends in the white space for its other end', () => {
    expect(selectionFromDrag(page, centre(5), centre(5))).toEqual({ from: 5, to: 5 });
    expect(selectionFromDrag(page, centre(4), { x: 0.99, y: 0.175 })).toEqual({ from: 4, to: 9 });
    expect(selectionFromDrag(page, centre(4), { x: 0.5, y: 0.95 })).toEqual({ from: 4, to: 4 });
  });

  it('selects nothing when neither end is near any text, or the page has no words', () => {
    expect(selectionFromDrag(page, { x: 0.5, y: 0.8 }, { x: 0.6, y: 0.95 })).toBeNull();
    expect(selectionFromDrag({ words: [], lines: [] }, { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 })).toBeNull();
    expect(selectionFromDrag(null, { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 })).toBeNull();
  });

  it('never names more than 600 words, keeping the word where the drag began', () => {
    const big = longPage(900);
    const forward = selectionFromDrag(big, longCentre(0), longCentre(899));
    expect(forward).toEqual({ from: 0, to: 599 });
    const backward = selectionFromDrag(big, longCentre(899), longCentre(0));
    expect(backward).toEqual({ from: 300, to: 899 });
    expect(selectionFromDrag(big, longCentre(10), longCentre(609))).toEqual({ from: 10, to: 609 });
    expect(orderRange(10, 610)).toEqual({ from: 10, to: 609 });
    expect(orderRange(7, 7)).toEqual({ from: 7, to: 7 });
  });
});

describe('geometry at any zoom', () => {
  it('gives the same fractions for the same spot of the page at every size of the box', () => {
    const fit = { left: 20, top: 100, width: 500, height: 650 };
    const full = { left: -300, top: -40, width: 850, height: 1100 };      // scrolled, at 100%
    const big = { left: 5, top: 5, width: 1275, height: 1650 };            // 150%
    for (const rect of [fit, full, big]) {
      expect(toFraction(rect.left + rect.width * 0.25, rect.top + rect.height * 0.5, rect)).toEqual({ x: 0.25, y: 0.5 });
      expect(toFraction(rect.left + rect.width * 0.8, rect.top + rect.height * 0.1, rect)).toEqual({ x: 0.8, y: 0.1 });
    }
  });

  it('clamps a pointer that has left the page and copes with a box with no size', () => {
    const rect = { left: 10, top: 10, width: 200, height: 300 };
    expect(toFraction(-50, 900, rect)).toEqual({ x: 0, y: 1 });
    expect(toFraction(1000, -5, rect)).toEqual({ x: 1, y: 0 });
    expect(toFraction(5, 5, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 1, y: 1 });
  });

  it('positions boxes in percentages of the page, so a zoom never changes them', () => {
    expect(boxStyle([0.1, 0.25, 0.6, 0.3])).toEqual({ left: '10%', top: '25%', width: '50%', height: '5%' });
    expect(boxStyle([0.12345, 0.5, 0.2, 0.55])).toEqual({ left: '12.35%', top: '50%', width: '7.66%', height: '5%' });
    expect(boxStyle([-1, 0, 2, 9])).toEqual({ left: '0%', top: '0%', width: '100%', height: '100%' });
    expect(boxStyle([0.5, 0.5, 0.4, 0.4])).toEqual({ left: '50%', top: '50%', width: '0%', height: '0%' });
    expect(pointStyle(0.333, 0.7)).toEqual({ left: '33.3%', top: '70%' });
  });

  it('works out the width of the page box for each zoom', () => {
    const natural = naturalWidthOf(0.773);
    expect(natural).toBe(850);
    expect(pageWidth('fit', natural)).toBe('100%');
    expect(pageWidth('100', natural)).toBe('850px');
    expect(pageWidth('150', natural)).toBe('1275px');
    expect(pageWidth('whatever', natural)).toBe('100%');
    expect(naturalWidthOf(1.778)).toBe(1100);
    expect(naturalWidthOf(null)).toBe(850);
    expect(naturalWidthOf(0)).toBe(850);
  });

  it('steps through fit, 100% and 150% and stops at the ends', () => {
    expect(nextZoom('fit', 1)).toBe('100');
    expect(nextZoom('100', 1)).toBe('150');
    expect(nextZoom('150', 1)).toBe('150');
    expect(nextZoom('150', -1)).toBe('100');
    expect(nextZoom('fit', -1)).toBe('fit');
    expect(nextZoom('odd', 1)).toBe('100');
  });
});

describe('textUnderBoxes', () => {
  const page = makePage();

  it('reads out the words that stand under the boxes TAi drew, in reading order', () => {
    const box = serverBoxesFor(page, 0, 3)[0];
    expect(textUnderBoxes(page, [box])).toBe('Raft elects a leader');
    expect(textUnderBoxes(page, [serverBoxesFor(page, 4, 6)[0], serverBoxesFor(page, 0, 0)[0]])).toBe('by majority vote … Raft');
  });

  it('says nothing for boxes over no words and cuts a long text', () => {
    expect(textUnderBoxes(page, [[0.7, 0.7, 0.9, 0.9]])).toBe('');
    const big = longPage(100);
    const text = textUnderBoxes(big, [[0, 0, 1, 1]], 50);
    expect(text.length).toBeLessThanOrEqual(51);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('quoteOf', () => {
  it('quotes the selected words on one line and cuts a very long selection', () => {
    const page = makePage();
    expect(quoteOf(page, 4, 6)).toBe('by majority vote');
    const big = longPage(600);
    const quote = quoteOf(big, 0, 599);
    expect(quote.length).toBeLessThanOrEqual(1201);
    expect(quote.endsWith('…')).toBe(true);
  });
});

describe('cleanBoxes', () => {
  it('keeps boxes with four numbers inside the page, corners the right way round, and some size', () => {
    expect(cleanBoxes([[0.1, 0.1, 0.5, 0.2], [0.9, 0.9, 0.7, 0.8], [0.2, 0.2, 0.2, 0.4], [0.1, 0.1, 'x', 0.2], [1, 2, 3], 'box', null, [-1, -1, 2, 2]])).toEqual([
      [0.1, 0.1, 0.5, 0.2],
      [0.7, 0.8, 0.9, 0.9],
      [0, 0, 1, 1],
    ]);
    expect(cleanBoxes('no')).toEqual([]);
    expect(cleanBoxes(Array.from({ length: 100 }, () => [0.1, 0.1, 0.2, 0.2]))).toHaveLength(40);
  });
});

describe('what each action reports to the view', () => {
  /** The view state as app.js makes it, with a clock the test turns by hand. */
  function harness() {
    let t = 1000;
    const pending = [];
    const sent = [];
    const state = createViewState({
      send: (view) => sent.push(view),
      now: () => t,
      setTimer: (fn, wait) => {
        const handle = { fn, at: t + wait, live: true };
        pending.push(handle);
        return handle;
      },
      clearTimer: (handle) => {
        if (handle) handle.live = false;
      },
    });
    const settle = () => {
      t += 5000;
      for (const handle of pending.splice(0)) if (handle.live) handle.fn();
    };
    return { state, sent, settle };
  }

  it('says which page is shown, and drops what was picked on another page', () => {
    expect(viewForPage(DOC, 3)).toEqual({ doc: { id: DOC, page: 3 }, sel: null, point: null });
    const { state, sent, settle } = harness();
    state.set(viewForPage(DOC, 1));
    state.set(viewForSelection(DOC, 1, { from: 4, to: 9 }));
    settle();
    expect(sent.at(-1)).toEqual({ v: 1, doc: { id: DOC, page: 1 }, sel: { doc: DOC, page: 1, from: 4, to: 9 } });
    state.set(viewForPage(DOC, 2));
    settle();
    expect(sent.at(-1)).toEqual({ v: 1, doc: { id: DOC, page: 2 } });
  });

  it('reports a selection as the range of words and a click as the spot, and each replaces the other', () => {
    expect(viewForSelection(DOC, 2, { from: 1, to: 6 })).toEqual({ sel: { doc: DOC, page: 2, from: 1, to: 6 }, point: null });
    expect(viewForPoint(DOC, 2, 0.25, 0.5)).toEqual({ point: { doc: DOC, page: 2, x: 0.25, y: 0.5 }, sel: null });
    const { state, sent, settle } = harness();
    state.set(viewForPage(DOC, 2));
    state.set(viewForPoint(DOC, 2, 0.25, 0.5));
    settle();
    expect(sent.at(-1)).toEqual({ v: 1, doc: { id: DOC, page: 2 }, point: { doc: DOC, page: 2, x: 0.25, y: 0.5 } });
    state.set(viewForSelection(DOC, 2, { from: 1, to: 6 }));
    settle();
    expect(sent.at(-1)).toEqual({ v: 1, doc: { id: DOC, page: 2 }, sel: { doc: DOC, page: 2, from: 1, to: 6 } });
  });

  it('empties the document, selection and point when the viewer closes, and leaves the parts it does not own', () => {
    expect(viewForClose()).toEqual({ doc: null, sel: null, point: null });
    const { state, sent, settle } = harness();
    state.set({ msg: { n: 7, text: 'a few words of an earlier message' } });
    state.set(viewForPage(DOC, 1));
    state.set(viewForSelection(DOC, 1, { from: 0, to: 2 }));
    settle();
    state.set(viewForClose());
    settle();
    expect(sent.at(-1)).toEqual({ v: 1, msg: { n: 7, text: 'a few words of an earlier message' } });
  });

  it('sends a view with the selection no longer than the server takes', () => {
    const range = orderRange(0, 5000);
    expect(range.to - range.from).toBeLessThan(MAX_SELECTION_WORDS);
  });
});

describe('what a reload keeps', () => {
  it('writes and reads the document, page and tab', () => {
    const raw = serializeStored({ doc: DOC, page: 4, tab: 'text' });
    expect(parseStored(raw)).toEqual({ doc: DOC, page: 4, tab: 'text' });
    expect(parseStored(serializeStored({ doc: DOC, page: 1, tab: 'page' }))).toEqual({ doc: DOC, page: 1, tab: 'page' });
  });

  it('checks what it reads: a bad id is nothing, a bad page is page 1, a bad tab is the page', () => {
    for (const bad of [null, undefined, '', 'not json', '[]', '"x"', '{}', JSON.stringify({ doc: 'short', page: 1 }), JSON.stringify({ doc: 7, page: 1 }), JSON.stringify({ page: 2 })]) expect(parseStored(bad)).toBeNull();
    expect(parseStored(JSON.stringify({ doc: DOC, page: 0 }))).toEqual({ doc: DOC, page: 1, tab: 'page' });
    expect(parseStored(JSON.stringify({ doc: DOC, page: 'two', tab: 'other' }))).toEqual({ doc: DOC, page: 1, tab: 'page' });
    expect(parseStored(JSON.stringify({ doc: DOC, page: 121 }))).toEqual({ doc: DOC, page: 1, tab: 'page' });
    expect(parseStored(JSON.stringify({ doc: DOC, page: 2.5 }))).toEqual({ doc: DOC, page: 1, tab: 'page' });
  });

  it('reads the zoom, and fit for anything else', () => {
    expect(parseZoom('150')).toBe('150');
    expect(parseZoom('100')).toBe('100');
    expect(parseZoom('fit')).toBe('fit');
    for (const bad of [null, undefined, '200', 150, 'huge']) expect(parseZoom(bad)).toBe('fit');
  });
});

describe('the three messages of a call', () => {
  it('reads show: the document, the page clamped to the pages it has, the title on one line', () => {
    expect(parseScreenMessage({ type: 'show', doc: DOC, page: 3, title: 'Raft\nslides', pages: 12 })).toEqual({ type: 'show', doc: DOC, page: 3, title: 'Raft slides', pages: 12 });
    expect(parseScreenMessage({ type: 'show', doc: DOC, page: 99, title: 'Deck', pages: 12 }).page).toBe(12);
    expect(parseScreenMessage({ type: 'show', doc: DOC, page: 0, pages: 12 }).page).toBe(1);
    expect(parseScreenMessage({ type: 'show', doc: DOC })).toEqual({ type: 'show', doc: DOC, page: 1, title: '', pages: null });
    expect(parseScreenMessage({ type: 'show', doc: DOC, page: 5, pages: 'many' }).pages).toBeNull();
  });

  it('reads point: boxes cleaned, and nothing at all when none is left', () => {
    expect(parseScreenMessage({ type: 'point', doc: DOC, page: 2, boxes: [[0.1, 0.1, 0.4, 0.15], [0.5, 0.3, 0.2, 0.2], 'x'] })).toEqual({ type: 'point', doc: DOC, page: 2, boxes: [[0.1, 0.1, 0.4, 0.15], [0.2, 0.2, 0.5, 0.3]] });
    expect(parseScreenMessage({ type: 'point', doc: DOC, page: 2, boxes: [] })).toBeNull();
    expect(parseScreenMessage({ type: 'point', doc: DOC, page: 2 })).toBeNull();
    expect(parseScreenMessage({ type: 'point', doc: DOC, page: 2, boxes: [[0.3, 0.3, 0.3, 0.3]] })).toBeNull();
  });

  it('reads doc_state: preparing or failed, with the title and message as one line', () => {
    expect(parseScreenMessage({ type: 'doc_state', state: 'preparing', title: 'Homework 5' })).toEqual({ type: 'doc_state', state: 'preparing', title: 'Homework 5', message: '' });
    expect(parseScreenMessage({ type: 'doc_state', state: 'failed', message: 'It is too big.\nSorry.' })).toEqual({ type: 'doc_state', state: 'failed', title: '', message: 'It is too big. Sorry.' });
    expect(parseScreenMessage({ type: 'doc_state', state: 'done' })).toBeNull();
    expect(parseScreenMessage({ type: 'doc_state' })).toBeNull();
  });

  it('gives nothing for a message that is not one of the three, for an id that is not an id, or for a value that is not an object', () => {
    expect(parseScreenMessage({ type: 'status', state: 'listening' })).toBeNull();
    expect(parseScreenMessage({ type: 'show', doc: 'x', page: 1 })).toBeNull();
    expect(parseScreenMessage({ type: 'point', doc: 7, page: 1, boxes: [[0, 0, 1, 1]] })).toBeNull();
    for (const bad of [null, undefined, 'show', 3, []]) expect(parseScreenMessage(bad)).toBeNull();
  });

  it('puts no words of the message on the page as markup: titles and messages are kept as text and cut', () => {
    const hostile = '<img src=x onerror=alert(1)>'.repeat(20);
    const show = parseScreenMessage({ type: 'show', doc: DOC, page: 1, title: hostile, pages: 2 });
    expect(show.title.length).toBeLessThanOrEqual(120);
    expect(parseScreenMessage({ type: 'doc_state', state: 'failed', message: hostile }).message.length).toBeLessThanOrEqual(300);
  });
});

describe('the call\'s socket', () => {
  it('names the three messages the viewer takes', () => {
    expect([...SCREEN_TYPES].sort()).toEqual(['doc_state', 'point', 'show']);
    expect(SCREEN_TYPES.has('status')).toBe(false);
    expect(SCREEN_TYPES.has('transcript')).toBe(false);
  });

  it('sends the view as {type: "view", view} when the socket is open, and says so', () => {
    const sent = [];
    const ws = { readyState: 1, send: (text) => sent.push(text) };
    const view = { v: 1, doc: { id: DOC, page: 2 } };
    expect(sendViewOver(ws, view)).toBe(true);
    expect(JSON.parse(sent[0])).toEqual({ type: 'view', view });
  });

  it('says false when there is no socket, it is not open, or it cannot send, and never throws', () => {
    const view = { v: 1 };
    expect(sendViewOver(null, view)).toBe(false);
    expect(sendViewOver(undefined, view)).toBe(false);
    expect(sendViewOver({ readyState: 0, send: () => assertNever() }, view)).toBe(false);
    expect(sendViewOver({ readyState: 2, send: () => assertNever() }, view)).toBe(false);
    expect(sendViewOver({ readyState: 3, send: () => assertNever() }, view)).toBe(false);
    expect(sendViewOver({ readyState: 1, send: () => { throw new Error('the socket broke'); } }, view)).toBe(false);
    const circular = {};
    circular.self = circular;
    expect(sendViewOver({ readyState: 1, send: () => assertNever() }, circular)).toBe(false);
  });
});

function assertNever() {
  throw new Error('nothing should have been sent');
}

describe('opening a document the student attached', () => {
  it('is for a PDF the student attached and nothing else', () => {
    expect(isPdfFile({ name: 'spec.pdf', kind: 'document' })).toBe(true);
    expect(isPdfFile({ name: 'SPEC.PDF', kind: 'document' })).toBe(true);
    expect(isPdfFile({ name: 'slides.pptx', kind: 'document' })).toBe(false);
    expect(isPdfFile({ name: 'spec.pdf', kind: 'text' })).toBe(false);
    expect(isPdfFile({ name: 'spec.pdf.txt', kind: 'document' })).toBe(false);
    expect(isPdfFile({ kind: 'document' })).toBe(false);
    expect(isPdfFile(null)).toBe(false);
  });

  it('is for a PDF, a presentation or a document the student attached (a file of kind document that ends .pdf, .pptx, .docx or .xlsx, in any case) and nothing else', () => {
    for (const name of ['spec.pdf', 'SPEC.PDF', 'slides.pptx', 'Slides.PPTX', 'report.docx', 'data.XLSX', 'Week 5 - Raft.pptx']) expect(isOpenable({ name, kind: 'document' }), name).toBe(true);
    for (const name of ['notes.txt', 'old.ppt', 'old.doc', 'sheet.xls', 'slides.pptx.txt', 'pptx', 'a.docx.zip', 'code.go', 'archive.zip', 'report.pdfx']) expect(isOpenable({ name, kind: 'document' }), name).toBe(false);
    for (const kind of ['text', 'image', 'archive', undefined]) expect(isOpenable({ name: 'slides.pptx', kind }), String(kind)).toBe(false);
    expect(isOpenable({ kind: 'document' })).toBe(false);
    expect(isOpenable({ name: 5, kind: 'document' })).toBe(false);
    expect(isOpenable(null)).toBe(false);
    expect(isOpenable(undefined)).toBe(false);
    // the two predicates keep their own meaning: a deck is not a PDF, and a PDF is not an Office file
    expect(isOfficeFile({ name: 'slides.pptx', kind: 'document' })).toBe(true);
    expect(isOfficeFile({ name: 'spec.pdf', kind: 'document' })).toBe(false);
    expect(isPdfFile({ name: 'slides.pptx', kind: 'document' })).toBe(false);
  });

  it('does not offer a button before the viewer is set up', () => {
    expect(offerOpen({}, { name: 'spec.pdf', kind: 'document', index: 0 })).toBeNull();
    expect(offerOpen({}, { name: 'slides.pptx', kind: 'document', index: 0 })).toBeNull();
  });

  it('asks for file `index` of message `n` and nothing before the message has a number', () => {
    expect(openRequest(12, 0)).toEqual({ n: 12, index: 0 });
    expect(openRequest(12, 3)).toEqual({ n: 12, index: 3 });
    for (const [n, index] of [[NaN, 0], [0, 0], [-1, 0], [1.5, 0], [12, -1], [12, 0.5], [undefined, 0], [12, undefined], ['12', 0]]) expect(openRequest(n, index)).toBeNull();
  });

  it('reads 200 as ready at the page, 202 as preparing with its job, and an error as words', () => {
    expect(openAnswer(200, { ok: true, state: 'ready', doc: DOC, page: 3 })).toEqual({ kind: 'ready', doc: DOC, page: 3 });
    expect(openAnswer(200, { ok: true, doc: DOC })).toEqual({ kind: 'ready', doc: DOC, page: 1 });
    expect(openAnswer(202, { ok: true, state: 'preparing', job: 'j-1234_ab' })).toEqual({ kind: 'preparing', job: 'j-1234_ab' });
    expect(openAnswer(400, { error: 'bad-file', message: 'That is not a PDF TAi can read.' })).toEqual({ kind: 'error', message: 'That is not a PDF TAi can read.' });
    expect(openAnswer(413, { error: 'too-big' }).message).toBe('That file is too big to open here.');
    expect(openAnswer(429, { error: 'limit' }).message).toBe('You have opened a lot of documents lately. Try again in a few minutes.');
    expect(openAnswer(503, { error: 'busy' }).message).toBe('TAi is busy preparing other documents. Try again in a minute.');
    expect(openAnswer(503, { error: 'off' }).message).toBe('Opening documents is switched off right now.');
  });

  it('never answers ready or preparing for an answer that is not well formed, and never shows a status code', () => {
    for (const [status, data] of [[200, null], [200, {}], [200, { doc: 'x' }], [200, { state: 'preparing', doc: DOC }], [202, {}], [202, { job: '../etc' }], [202, { job: '' }], [200, 'ok']]) {
      expect(openAnswer(status, data).kind).toBe('error');
    }
    for (const status of [0, 401, 404, 429, 500, 502]) expect(problemWords(status, null)).not.toMatch(/\d{3}/);
    expect(problemWords(0, null)).toBe('I cannot be reached right now. Check your connection.');
    expect(problemWords(401, null)).toBe('Your session ended. Sign in again.');
    expect(problemWords(500, null)).toBe('That document could not be opened. Try again in a moment.');
  });

  it('says that a document that has expired is no longer available, and other problems in the words above', () => {
    expect(metaProblem(404, { error: 'not-found' })).toBe('This document is no longer available.');
    expect(metaProblem(404, null)).toBe('This document is no longer available.');
    expect(metaProblem(0, null)).toBe('I cannot be reached right now. Check your connection.');
    expect(metaProblem(500, null)).toBe('That document could not be opened. Try again in a moment.');
  });

  it('reads a job: ready, still waiting (also through a dropped connection or a busy server), or lost', () => {
    expect(jobAnswer(200, { ok: true, state: 'ready', doc: DOC, page: 2 })).toEqual({ kind: 'ready', doc: DOC, page: 2 });
    expect(jobAnswer(200, { ok: true, state: 'preparing' })).toEqual({ kind: 'waiting' });
    expect(jobAnswer(200, { ok: true, state: 'queued' })).toEqual({ kind: 'waiting' });
    for (const status of [0, 429, 500, 503]) expect(jobAnswer(status, null)).toEqual({ kind: 'waiting' });
    expect(jobAnswer(404, null).message).toBe('TAi lost track of that file. Try Open again.');
    expect(jobAnswer(401, null).message).toBe('Your session ended. Sign in again.');
    expect(jobAnswer(200, { state: 'ready', doc: 'bad' }).kind).toBe('error');
    expect(jobAnswer(200, { ok: false, state: 'failed', message: 'TAi could not read that PDF.' })).toEqual({ kind: 'error', message: 'TAi could not read that PDF.' });
  });

  it('reads a job that ended badly the way open answers one: the reason, the sentence and a status of its own are its last word', () => {
    expect(jobAnswer(502, { error: 'failed', message: 'The document could not be prepared.' })).toEqual({ kind: 'error', message: 'The document could not be prepared.' });
    expect(jobAnswer(502, { error: 'failed' }).message).toBe('TAi could not prepare that document.');
    expect(jobAnswer(503, { error: 'busy' }).message).toBe('TAi is busy preparing other documents. Try again in a minute.');
    expect(jobAnswer(503, { error: 'off', message: 'Documents are off.' }).message).toBe('Documents are off.');
    expect(jobAnswer(413, { error: 'too-big' }).message).toBe('That file is too big to open here.');
    expect(jobAnswer(415, { error: 'bad-file', message: 'That is not a PDF.' }).message).toBe('That is not a PDF.');
    expect(jobAnswer(429, { error: 'limit' }).kind).toBe('error');
    expect(jobAnswer(404, { error: 'not-found' }).message).toBe('TAi lost track of that file. Try Open again.');
  });

  it('waits out what is not the word of the job itself: no body, or the server rate limit', () => {
    for (const [status, data] of [[502, null], [503, {}], [504, 'Bad Gateway'], [429, { error: 'rate-limited' }], [500, { error: 'something-else' }], [0, null]]) expect(jobAnswer(status, data)).toEqual({ kind: 'waiting' });
  });

  /** A clock and a way of waiting that the test turns by hand: waiting moves the clock. */
  function clock() {
    const state = { t: 0, waits: [] };
    return { state, now: () => state.t, wait: async (ms) => { state.waits.push(ms); state.t += ms; } };
  }

  it('asks after the job every 1.5 seconds and opens it when it is ready', async () => {
    const { state, now, wait } = clock();
    const answers = [{ status: 200, data: { state: 'preparing' } }, { status: 200, data: { state: 'preparing' } }, { status: 200, data: { state: 'ready', doc: DOC, page: 1 } }];
    const asked = [];
    const result = await pollJob({ job: 'j1', now, wait, get: async (job) => (asked.push(job), answers.shift()) });
    expect(result).toEqual({ kind: 'ready', doc: DOC, page: 1 });
    expect(asked).toEqual(['j1', 'j1', 'j1']);
    expect(state.waits).toEqual([1500, 1500, 1500]);
  });

  it('stops with a word about it after 190 seconds (an Office render: 30 s of queue, 150 s of clock, a guard)', async () => {
    const { state, now, wait } = clock();
    let calls = 0;
    const result = await pollJob({ job: 'j1', now, wait, get: async () => (calls++, { status: 200, data: { state: 'preparing' } }) });
    expect(result.kind).toBe('timeout');
    expect(result.message).toBe('This is taking longer than expected. Try Open again in a minute.');
    expect(state.t).toBeGreaterThanOrEqual(JOB_LIMIT_MS);
    expect(state.t).toBeLessThan(JOB_LIMIT_MS + 1500 + 1);
    expect(JOB_LIMIT_MS).toBe(190_000);
    expect(calls).toBe(Math.ceil(JOB_LIMIT_MS / 1500));
  });

  it('stops at the first failure, keeps waiting through a dropped connection, and stops when it is cancelled', async () => {
    let c = clock();
    const replies = [{ status: 0, data: null }, { status: 503, data: null }, { status: 200, data: { ok: false, state: 'failed', message: 'It did not work.' } }];
    expect(await pollJob({ job: 'j1', now: c.now, wait: c.wait, get: async () => replies.shift() })).toEqual({ kind: 'error', message: 'It did not work.' });
    c = clock();
    let stop = false;
    let asked = 0;
    const result = await pollJob({ job: 'j1', now: c.now, wait: async (ms) => { await c.wait(ms); stop = asked >= 2; }, cancelled: () => stop, get: async () => (asked++, { status: 200, data: { state: 'preparing' } }) });
    expect(result).toEqual({ kind: 'cancelled' });
    expect(asked).toBe(2);
  });

  it('keeps the boxes TAi draws for a few seconds', () => {
    expect(HIGHLIGHT_MS).toBe(8000);
  });
});

describe('a point that comes with a show', () => {
  const m = { doc: DOC, page: 3 };

  it('is drawn when its page is on screen, kept when a show for it is on its way, and ignored otherwise', () => {
    expect(pointPlan({ id: DOC, page: 3 }, null, m)).toBe('draw');
    expect(pointPlan({ id: DOC, page: 3 }, { id: OTHER, page: 1 }, m)).toBe('draw');
    expect(pointPlan(null, { id: DOC, page: 3 }, m)).toBe('wait');
    expect(pointPlan({ id: OTHER, page: 1 }, { id: DOC, page: 3 }, m)).toBe('wait');
    expect(pointPlan({ id: DOC, page: 1 }, { id: DOC, page: 3 }, m)).toBe('wait');
  });

  it('never opens a document or turns a page by itself: another page, another document, or a closed viewer is ignored', () => {
    expect(pointPlan({ id: DOC, page: 2 }, null, m)).toBe('ignore');
    expect(pointPlan({ id: OTHER, page: 3 }, null, m)).toBe('ignore');
    expect(pointPlan(null, null, m)).toBe('ignore');
    expect(pointPlan({ id: DOC, page: 1 }, { id: DOC, page: 4 }, m)).toBe('ignore');
    expect(pointPlan({ id: DOC, page: 1 }, { id: OTHER, page: 3 }, m)).toBe('ignore');
  });

  it('shows kept boxes for what is left of their eight seconds, and not at all when it is nearly gone', () => {
    expect(pointTimeLeft(1000, 1000)).toBe(HIGHLIGHT_MS);
    expect(pointTimeLeft(1000, 1040)).toBe(HIGHLIGHT_MS - 40);
    expect(pointTimeLeft(1000, 1000 + HIGHLIGHT_MS - MIN_POINT_MS)).toBe(MIN_POINT_MS);
    expect(pointTimeLeft(1000, 1000 + HIGHLIGHT_MS - MIN_POINT_MS + 1)).toBe(0);
    expect(pointTimeLeft(1000, 1000 + HIGHLIGHT_MS)).toBe(0);
    expect(pointTimeLeft(1000, 1000 + 60_000)).toBe(0);
  });
});

describe('turning quickly through a document', () => {
  it('counts a page as turned to quickly when it comes within a quarter of a second of the last one', () => {
    expect(SETTLE_MS).toBe(250);
    expect(turnedQuickly(1000, 1000)).toBe(true);
    expect(turnedQuickly(1000, 1000 + SETTLE_MS - 1)).toBe(true);
    expect(turnedQuickly(1000, 1000 + SETTLE_MS)).toBe(false);
    expect(turnedQuickly(1000, 1000 + 5000)).toBe(false);
  });

  it('never counts the first page of a document (nothing was turned to before it), so it is asked for at once', () => {
    expect(turnedQuickly(0, 5)).toBe(false);
    expect(turnedQuickly(0, 100)).toBe(false);
  });
});
