import { describe, expect, it } from 'vitest';

import { LibrarySearcher, SEARCH_LIMITS, buildIndex, normalize, queryStems, searchLibrary, snippetAround, stem } from './library-search.js';
import type { SearchableDeck } from './library-search.js';
import { LIBRARY_LIMITS } from './types.js';
import type { LibraryEntry } from './types.js';

const deck = (id: string, title: string, week: number | null, pages: string[]): SearchableDeck => ({ id: id.repeat(32).slice(0, 32), title, week, pages });
const ID = (c: string): string => c.repeat(32).slice(0, 32);

const RAFT = deck('a', 'Week 5 - Raft Consensus', 5, [
  'Raft Consensus\nA replicated log keeps the servers in step',
  'Leader election\nA follower that hears nothing becomes a candidate and asks for votes. Randomized election timeouts keep two candidates from splitting the vote.',
  'Log replication\nThe leader sends AppendEntries to every follower and an entry counts once a majority has stored it.',
  'Safety\nA candidate with a log that is behind cannot win an election.',
]);
const PAXOS = deck('b', 'Week 6 - Paxos', 6, [
  'Paxos\nProposers, acceptors and learners',
  'Leader election in Multi-Paxos\nA distinguished proposer is chosen so that most rounds skip the prepare phase.',
  'Quorums\nAny two majorities overlap in at least one acceptor.',
]);
const DOCKER = deck('c', 'Week 2 - Containers and Docker', 2, ['Containers\nAn image is a stack of layers', 'Dockerfile\nFROM, COPY, RUN: each line is a layer', 'Networking\nPorts and bridges']);

describe('how a query and a page are read', () => {
  it('does not care about case, accents or punctuation, and reads letters and digits only', () => {
    expect(normalize("Raft's  Leader-Election!!")).toBe('raft s leader election');
    expect(normalize(`  CAFÉ r${String.fromCharCode(0xad)}esume ${String.fromCharCode(0xe9)} `)).toBe('cafe resume e'); // (a soft hyphen is no break between words)
    expect(normalize('"quoted" (parens) [brackets] a/b')).toBe('quoted parens brackets a b');
    expect(normalize('')).toBe('');
  });

  it('meets a word and its plural, its -ing, -ed and -ion forms, and a final e', () => {
    const same = [['replicate', 'replicated', 'replicating', 'replication', 'replicates'], ['election', 'elections', 'elected'], ['node', 'nodes'], ['partition', 'partitions', 'partitioned', 'partitioning'], ['timeout', 'timeouts'], ['class', 'classes']];
    for (const group of same) expect(new Set(group.map(stem)).size, group.join(',')).toBe(1);
    expect(stem('raft')).toBe('raft');
    expect(stem('paxos')).toBe('paxos');
    expect(stem('42')).toBe('42');
    expect(stem('go')).toBe('go');
    expect(stem('process')).not.toBe(stem('procedure'));
  });

  it('drops the words that say nothing about a topic, keeps each stem once, and takes at most eight', () => {
    expect(queryStems('How does the Raft leader election work in the slides?').stems).toEqual(['raft', 'leader', 'elect', 'work']);
    expect(queryStems('raft Raft RAFT rafts').stems).toEqual(['raft']);
    expect(queryStems('the slides about it').stems).toEqual([]);
    expect(queryStems('').stems).toEqual([]);
    expect(queryStems(undefined).stems).toEqual([]);
    expect(queryStems(42).stems).toEqual([]);
    expect(queryStems('alpha beta gamma delta epsilon zeta eta theta iota kappa').stems).toHaveLength(SEARCH_LIMITS.queryWords);
    expect(queryStems('week 5').stems).toEqual(['week', '5']);
    expect(queryStems('x'.repeat(5000)).stems).toHaveLength(1); // (cut before it is read)
  });
});

describe('what a search finds and in what order', () => {
  const index = buildIndex([RAFT, PAXOS, DOCKER]);

  it('puts a deck whose TITLE has the words above every deck that only has them in its pages', () => {
    // "paxos" is in the title of one deck and on a page of the other ("Multi-Paxos" does not count as the word, but the page text of RAFT mentions none): use a word both have
    const both = buildIndex([deck('a', 'Notes on elections', null, ['election of leaders election election election']), deck('b', 'Week 6 - Paxos', 6, ['paxos paxos paxos paxos paxos', 'A page about an election'])]);
    const hits = searchLibrary(both, 'election');
    expect(hits[0]).toMatchObject({ title: 'Notes on elections' });
    expect(hits.map((h) => h.title)).toEqual(['Notes on elections', 'Week 6 - Paxos']);
    const titleHit = searchLibrary(buildIndex([deck('a', 'Paxos', null, ['nothing here']), deck('b', 'Other', null, ['paxos paxos paxos paxos paxos'])]), 'paxos');
    expect(titleHit.map((h) => h.title)).toEqual(['Paxos', 'Other']);
  });

  it('finds the page by what it says: the best page of the deck that has the words, with its number, the deck\'s title, week and page count', () => {
    const hits = searchLibrary(index, 'leader election randomized timeouts');
    expect(hits[0]).toMatchObject({ id: ID('a'), title: 'Week 5 - Raft Consensus', week: 5, page: 2, pages: 4 });
    expect(hits[0].snippet).toContain('election');
    expect(searchLibrary(index, 'randomized election timeout').map((h) => `${h.title}:${h.page}`)[0]).toBe('Week 5 - Raft Consensus:2');
  });

  it('ranks a page that has more of the words, and the words in a row, above one that has fewer', () => {
    const hits = searchLibrary(index, 'leader election');
    expect(hits.map((h) => `${h.id.slice(0, 1)}:${h.page}`).slice(0, 2)).toEqual(['a:2', 'b:2']);
    const ordered = buildIndex([deck('a', 'x', null, ['election and leader are separate here', 'the leader election is one phrase here'])]);
    expect(searchLibrary(ordered, 'leader election').map((h) => h.page)).toEqual([2, 1]);
  });

  it('is case and punctuation insensitive, in the query and in the page', () => {
    const a = searchLibrary(index, 'LEADER-ELECTION!!');
    const b = searchLibrary(index, 'leader election');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(searchLibrary(index, 'appendentries')[0]).toMatchObject({ page: 3 });
    expect(searchLibrary(index, 'APPENDENTRIES.')[0]).toMatchObject({ page: 3 });
  });

  it('does not make a hit of a page that has one word of a long query', () => {
    expect(searchLibrary(index, 'consistent hashing virtual nodes ring')).toEqual([]);
    expect(searchLibrary(index, 'quantum hashing')).toEqual([]);
    expect(searchLibrary(index, 'dockerfile layers')[0]).toMatchObject({ id: ID('c'), page: 2 });
  });

  it('is empty for a query with nothing to look for, for an empty library and for words that are nowhere', () => {
    expect(searchLibrary(index, '')).toEqual([]);
    expect(searchLibrary(index, 'the slides about how')).toEqual([]);
    expect(searchLibrary(index, 'zzzzqqqq')).toEqual([]);
    expect(searchLibrary(buildIndex([]), 'raft')).toEqual([]);
    expect(searchLibrary(index, null)).toEqual([]);
  });

  it('returns at most five hits and at most three from one deck, best first', () => {
    const many = buildIndex([
      deck('a', 'Deck A', 1, Array.from({ length: 10 }, (_, i) => `consensus page ${i} about consensus`)),
      deck('b', 'Deck B', 2, Array.from({ length: 10 }, (_, i) => `consensus again ${i}`)),
    ]);
    const hits = searchLibrary(many, 'consensus');
    expect(hits).toHaveLength(LIBRARY_LIMITS.hits);
    const perDeck = new Map<string, number>();
    for (const h of hits) perDeck.set(h.id, (perDeck.get(h.id) ?? 0) + 1);
    expect(Math.max(...perDeck.values())).toBeLessThanOrEqual(LIBRARY_LIMITS.perDeck);
    expect(new Set(hits.map((h) => `${h.id}:${h.page}`)).size).toBe(hits.length);
    expect(searchLibrary(many, 'consensus', 2)).toHaveLength(2);
  });

  it('breaks a tie by week (none last), then title, then page', () => {
    const tied = buildIndex([deck('a', 'Zebra', 3, ['gossip protocols']), deck('b', 'Apple', null, ['gossip protocols']), deck('c', 'Mango', 1, ['gossip protocols'])]);
    expect(searchLibrary(tied, 'gossip').map((h) => h.title)).toEqual(['Mango', 'Zebra', 'Apple']);
  });

  it('gives the first page of a deck whose title has the words when no page does, with the start of that page as the snippet (or none for a page with no text)', () => {
    const titled = buildIndex([deck('a', 'Syllabus', null, ['Course policies and grading\nHomework is half of the grade', 'Schedule']), deck('b', 'Syllabus pictures', null, ['', 'x'])]);
    const hits = searchLibrary(titled, 'syllabus');
    expect(hits.map((h) => `${h.title}:${h.page}`)).toEqual(['Syllabus:1', 'Syllabus pictures:1']);
    expect(hits[0].snippet).toBe('Course policies and grading Homework is half of the grade');
    expect(hits[1].snippet).toBe('');
  });
});

describe('the snippet', () => {
  const words = (n: number, w = 'word'): string => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

  it('is the page\'s own words from a little before the first word that matched, at most 160 characters, with "..." where it was cut', () => {
    const page = `${words(60)} treasure ${words(60, 'tail')}`;
    const s = searchLibrary(buildIndex([deck('a', 'A deck', null, [page])]), 'treasure')[0].snippet;
    expect(s.length).toBeLessThanOrEqual(LIBRARY_LIMITS.snippetChars);
    expect(s).toContain('treasure');
    expect(s.startsWith('...')).toBe(true);
    expect(s.endsWith('...')).toBe(true);
    const inner = s.replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
    expect(page.replace(/\s+/g, ' ')).toContain(inner);
    // not cut in the middle of a word
    for (const piece of inner.split(' ')) expect(page.split(/\s+/)).toContain(piece);
  });

  it('is the whole text when the page is short, and starts at the beginning when the match is near it', () => {
    expect(snippetAround('short text here', 6)).toBe('short text here');
    const long = `treasure ${words(80)}`;
    const s = snippetAround(long, 0);
    expect(s.startsWith('treasure')).toBe(true);
    expect(s.endsWith('...')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(160);
  });

  it('is never made up: for any page and any word of it, every word of the snippet is a word of the page, in the page\'s order', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const vocab = Array.from({ length: 80 }, (_, i) => `w${i}x`);
    for (let round = 0; round < 40; round++) {
      const tokens = Array.from({ length: 30 + Math.floor(next() * 200) }, () => vocab[Math.floor(next() * vocab.length)]);
      const page = tokens.join(round % 2 ? '\n' : ' ');
      const target = tokens[Math.floor(next() * tokens.length)];
      const hit = searchLibrary(buildIndex([deck('a', 'Deck', null, [page])]), target)[0];
      expect(hit, target).toBeDefined();
      const inner = hit.snippet.replace(/^\.\.\./, '').replace(/\.\.\.$/, '').trim();
      expect(hit.snippet.length).toBeLessThanOrEqual(160);
      expect(tokens.join(' ')).toContain(inner);
      expect(inner).toContain(target.replace(/x$/, ''));
    }
  });
});

describe('the index that remembers', () => {
  const entry = (id: string, title: string, week: number | null): LibraryEntry => ({ id: ID(id), title, week, sourceName: `${title}.pptx`, sha256: id.repeat(64).slice(0, 64), pages: 2, origin: 'course', createdAt: 1, bytes: 10 });

  it('builds the index once for a library that has not changed and again when the entries are not the same array', () => {
    const reads: string[] = [];
    let entries = [entry('a', 'Raft', 5)];
    const texts: Record<string, string[]> = { [ID('a')]: ['Raft slide', 'Election of a leader'], [ID('b')]: ['Paxos slide'] };
    const searcher = new LibrarySearcher({
      library: () => entries,
      pageTexts: (id) => {
        reads.push(id);
        return texts[id] ?? null;
      },
    });
    expect(searcher.search('election')[0]).toMatchObject({ page: 2 });
    expect(searcher.search('leader')).toHaveLength(1);
    expect(searcher.size()).toBe(2);
    expect(reads).toEqual([ID('a')]); // one build for three calls
    entries = [...entries, entry('b', 'Paxos', 6)];
    expect(searcher.search('paxos')[0]).toMatchObject({ title: 'Paxos' });
    expect(reads).toEqual([ID('a'), ID('a'), ID('b')]);
  });

  it('leaves out an entry whose text cannot be read, searches the rest, and never throws', () => {
    const searcher = new LibrarySearcher({
      library: () => [entry('a', 'Raft', 5), entry('b', 'Broken', 6), entry('c', 'Throws', 7)],
      pageTexts: (id) => {
        if (id === ID('c')) throw new Error('disk');
        return id === ID('a') ? ['Raft election'] : null;
      },
    });
    expect(searcher.search('election').map((h) => h.title)).toEqual(['Raft']);
    const broken = new LibrarySearcher({
      library: () => {
        throw new Error('no library');
      },
      pageTexts: () => null,
    });
    expect(broken.search('anything')).toEqual([]);
    expect(broken.size()).toBe(0);
  });

  it('is fast enough for the biggest library there can be: a hundred decks of a hundred and twenty pages', () => {
    const decks = Array.from({ length: LIBRARY_LIMITS.entries }, (_, d) => deck(String.fromCharCode(97 + (d % 26)) + String(d).padStart(31, '0'), `Deck ${d}`, d % 15, Array.from({ length: 120 }, (_, p) => `slide ${p} of deck ${d} discusses topic${(d * 7 + p) % 97} and consensus${p % 5} in detail with some more words to make it a page`)));
    const began = Date.now();
    const index = buildIndex(decks.map((d, i) => ({ ...d, id: i.toString(16).padStart(32, '0') })));
    const built = Date.now() - began;
    const searched = Date.now();
    expect(searchLibrary(index, 'topic42 consensus3').length).toBeGreaterThan(0);
    expect(index.pageCount).toBe(12_000);
    expect(built).toBeLessThan(5_000);
    expect(Date.now() - searched).toBeLessThan(500);
  });
});
