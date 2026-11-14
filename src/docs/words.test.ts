import { describe, expect, it } from 'vitest';

import { DOC_LIMITS } from './types.js';
import type { PageWords } from './types.js';
import { boxesFor, cleanWord, deriveLines, findPhrase, nearestWord, pageText, textOf, tokens, validateWords } from './words.js';

/** Two lines of a slide: "Leader election in Raft" (y 0.1) and "uses a randomized election timeout" (y 0.2). */
const PAGE: PageWords = {
  words: [
    [0.1, 0.1, 0.2, 0.13, 'Leader'],
    [0.21, 0.1, 0.3, 0.13, 'election'],
    [0.31, 0.1, 0.36, 0.13, 'in'],
    [0.37, 0.1, 0.45, 0.13, 'Raft'],
    [0.1, 0.2, 0.18, 0.23, 'uses'],
    [0.19, 0.2, 0.22, 0.23, 'a'],
    [0.23, 0.2, 0.4, 0.23, 'randomized'],
    [0.41, 0.2, 0.55, 0.23, 'election-timeout.'],
  ],
  lines: [
    [0, 3],
    [4, 7],
  ],
};

describe('validateWords', () => {
  it('keeps what is well formed and rounds the boxes to four decimals', () => {
    const page = validateWords({ words: [[0.123456, 0.2, 0.3, 0.25, 'hello']], lines: [[0, 0]] });
    expect(page).toEqual({ words: [[0.1235, 0.2, 0.3, 0.25, 'hello']], lines: [[0, 0]] });
  });

  it('clamps a box to the page and puts its corners the right way round', () => {
    const page = validateWords({ words: [[1.4, 0.5, -0.2, 0.4, 'x']] });
    expect(page?.words[0]).toEqual([0, 0.4, 1, 0.5, 'x']);
  });

  it('drops a word that is not a box and a word that says nothing, and cleans the rest', () => {
    const page = validateWords({ words: [[0, 0, 1, 1, ''], ['a', 0, 1, 1, 'x'], [0, 0, 1, 1, 'ok'], [0, 0, NaN, 1, 'nan'], [0, 0, 1, 1, ' a b\u0007c '], [0, 0, 1]] });
    expect(page?.words.map((w) => w[4])).toEqual(['ok', 'abc']);
  });

  it('refuses what is not a words file, and a page with too many words', () => {
    expect(validateWords(null)).toBeNull();
    expect(validateWords([])).toBeNull();
    expect(validateWords({ words: 'no' })).toBeNull();
    expect(validateWords({ words: Array.from({ length: DOC_LIMITS.wordsPerPage + 1 }, () => [0, 0, 1, 1, 'w']) })).toBeNull();
    expect(validateWords({ words: Array.from({ length: DOC_LIMITS.wordsPerPage }, () => [0, 0, 1, 1, 'w']) })?.words).toHaveLength(DOC_LIMITS.wordsPerPage);
  });

  it('cuts a very long word', () => {
    const page = validateWords({ words: [[0, 0, 1, 1, 'x'.repeat(500)]] });
    expect(page?.words[0][4]).toHaveLength(DOC_LIMITS.wordChars);
  });

  it('keeps lines that are index ranges in order and makes its own from the boxes otherwise', () => {
    const words = PAGE.words.map((w) => [...w]);
    expect(validateWords({ words, lines: [[0, 3], [4, 7]] })?.lines).toEqual([[0, 3], [4, 7]]);
    for (const lines of [[[4, 7], [0, 3]], [[0, 9]], [[0, 3], [3, 7]], [[2, 1]], 'x', [[0.5, 1]], []]) {
      expect(validateWords({ words, lines })?.lines).toEqual([[0, 3], [4, 7]]);
    }
  });

  it('does not keep the given lines when a word was dropped (the indexes would be wrong)', () => {
    const words = [[0, 0.1, 0.1, 0.13, 'a'], 'junk', [0, 0.5, 0.1, 0.53, 'b']];
    expect(validateWords({ words, lines: [[0, 1]] })?.lines).toEqual([[0, 0], [1, 1]]);
  });
});

describe('cleanWord', () => {
  it('removes white space, control and direction characters', () => {
    expect(cleanWord('a b')).toBe('ab');
    expect(cleanWord(String.fromCharCode(0x202e) + 'hello' + String.fromCharCode(0x202c))).toBe('hello');
    expect(cleanWord(String.fromCharCode(0x200b) + 'x' + String.fromCharCode(0))).toBe('x');
    expect(cleanWord(42)).toBe('');
  });
});

describe('deriveLines', () => {
  it('starts a line when a word is a line below the one before', () => {
    expect(deriveLines(PAGE.words)).toEqual([[0, 3], [4, 7]]);
    expect(deriveLines([])).toEqual([]);
    expect(deriveLines([[0, 0, 0.1, 0.1, 'a']])).toEqual([[0, 0]]);
  });
});

describe('textOf and pageText', () => {
  it('join a range, and the page by lines', () => {
    expect(textOf(PAGE, 1, 3)).toBe('election in Raft');
    expect(textOf(PAGE, 3, 1)).toBe('election in Raft');
    expect(textOf(PAGE, -5, 99)).toBe('Leader election in Raft uses a randomized election-timeout.');
    expect(pageText(PAGE)).toBe('Leader election in Raft\nuses a randomized election-timeout.');
  });
});

describe('nearestWord', () => {
  it('is the word under the point, or the closest one near it', () => {
    expect(nearestWord(PAGE, 0.25, 0.115)).toBe(1);
    expect(nearestWord(PAGE, 0.5, 0.215)).toBe(7);
    expect(nearestWord(PAGE, 0.205, 0.115)).toBe(0);
  });

  it('is null when nothing is near', () => {
    expect(nearestWord(PAGE, 0.9, 0.9)).toBeNull();
    expect(nearestWord({ words: [], lines: [] }, 0.5, 0.5)).toBeNull();
    expect(nearestWord(PAGE, 0.9, 0.9, 1)).not.toBeNull();
  });
});

describe('boxesFor', () => {
  it('is one box for each line the words touch, a hair larger than the words', () => {
    const boxes = boxesFor(PAGE, 2, 5);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual([0.307, 0.097, 0.453, 0.133]);
    expect(boxes[1]).toEqual([0.097, 0.197, 0.223, 0.233]);
    expect(boxesFor(PAGE, 0, 0)).toHaveLength(1);
    expect(boxesFor(PAGE, 20, 30)).toEqual([]);
  });
});

describe('tokens', () => {
  it('are the letters and digits in lower case', () => {
    expect(tokens('Election-Timeout, 150ms!')).toEqual(['election', 'timeout', '150ms']);
    expect(tokens('...')).toEqual([]);
  });
});

describe('findPhrase', () => {
  it('finds the same words in a row, whatever the case and the punctuation', () => {
    const hit = findPhrase(PAGE, 'Election Timeout');
    expect(hit).toMatchObject({ from: 7, to: 7, exact: true, text: 'election-timeout.' });
    const across = findPhrase(PAGE, 'raft uses a');
    expect(across).toMatchObject({ from: 3, to: 5, exact: true });
    expect(across?.boxes).toHaveLength(2);
  });

  it('finds the first place when the phrase is there more than once', () => {
    expect(findPhrase(PAGE, 'election')).toMatchObject({ from: 1, to: 1, exact: true });
  });

  it('falls back to the window with most of the words when at least three quarters are there', () => {
    const near = findPhrase(PAGE, 'a randomized election timeout limit');
    expect(near?.exact).toBe(false);
    expect(near?.text).toContain('randomized');
    expect(findPhrase(PAGE, 'completely different words about gossip')).toBeNull();
  });

  it('does not guess for one word, and says null for an empty phrase or a page without words', () => {
    expect(findPhrase(PAGE, 'gossip')).toBeNull();
    expect(findPhrase(PAGE, '   ')).toBeNull();
    expect(findPhrase({ words: [], lines: [] }, 'raft')).toBeNull();
  });

  it('keeps to a phrase of at most 24 words', () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    expect(findPhrase(PAGE, long)).toBeNull();
  });
});
