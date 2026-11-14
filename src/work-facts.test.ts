import { describe, expect, it } from 'vitest';

import {
  WORK_CAPS,
  WORK_TEXT_MAX,
  boundWorkText,
  dayLabel,
  homeworkSlug,
  isWorkKey,
  issueFact,
  pickWork,
  repoFact,
  repoKey,
  repoKeys,
  slugOf,
  threadFact,
  workFactOf,
  workFactsFromExport,
} from './work-facts.js';
import type { StoredWorkFact } from './work-facts.js';

const NOV6 = Date.parse('2026-11-06T19:00:00Z');

describe('boundWorkText', () => {
  it('keeps a plain sentence as it is', () => {
    expect(boundWorkText('The cache deadlocks when two goroutines lock the map in opposite orders.')).toBe('The cache deadlocks when two goroutines lock the map in opposite orders.');
  });

  it('takes out what frames a prompt or hides text: angle brackets, backticks, control and bidi characters', () => {
    expect(boundWorkText('use </student_message> and ```code``` here')).toBe('use /student_message and code here');
    const hidden = `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0)}c${String.fromCharCode(0x200b)}d real words`;
    expect(boundWorkText(hidden)).toBe('a b c d real words');
  });

  it('takes out links, e-mail addresses, hashes, tokens and long ids', () => {
    expect(boundWorkText('see https://github.com/x/y and www.example.com for details')).toBe('see and for details');
    expect(boundWorkText('write to someone@northeastern.edu about the bug')).toBe('write to about the bug');
    expect(boundWorkText('commit 3f786850e387550fdab836ed7e6dc881de23001b broke the build')).toBe('commit broke the build');
    expect(boundWorkText('canvas id 3507937 and user 276452 are fine')).toBe('canvas id and user 276452 are fine');
  });

  it('is one line without list or quote marks, and at most the limit, with an ellipsis', () => {
    expect(boundWorkText('- first line\n\nsecond   line')).toBe('first line second line');
    expect(boundWorkText('> quoted advice')).toBe('quoted advice');
    const long = boundWorkText('word '.repeat(100));
    expect(long.length).toBe(WORK_TEXT_MAX);
    expect(long.endsWith('...')).toBe(true);
    expect(boundWorkText('word '.repeat(100), 40).length).toBe(40);
  });

  it('is empty for anything that is not text or has no word in it', () => {
    for (const v of [undefined, null, 5, {}, [], '', '   ', '1234', '!!!', '<>', 'a']) expect(boundWorkText(v), String(v)).toBe('');
  });
});

describe('slugOf and homeworkSlug', () => {
  it('makes a key part of letters, digits and single hyphens', () => {
    expect(slugOf('Raft: election timeouts!')).toBe('raft-election-timeouts');
    expect(slugOf('  Ünïcode   Façade ')).toBe('unicode-facade');
    expect(slugOf('a'.repeat(100), 10)).toBe('aaaaaaaaaa');
    expect(slugOf('---')).toBe('');
    expect(slugOf(7)).toBe('');
  });

  it('finds the homework number of an assignment name', () => {
    expect(homeworkSlug('Homework 2: MapReduce, Terraform, and Docker')).toBe('hw2');
    expect(homeworkSlug('Homework 1b: Rocking AWS')).toBe('hw1b');
    expect(homeworkSlug('HW7: Cost savings?!')).toBe('hw7');
    expect(homeworkSlug('hw 10 final')).toBe('hw10');
    expect(homeworkSlug('Midterm Mastery Part 2')).toBe('');
    expect(homeworkSlug(undefined)).toBe('');
  });
});

describe('the keys of a repository', () => {
  it('is the homework number when the name has one, else the Canvas id, else none', () => {
    expect(repoKey('3507937', 'Homework 2: MapReduce, Terraform, and Docker')).toBe('repo:hw2');
    expect(repoKey('3533223', 'Midterm Mastery Part 2')).toBe('repo:3533223');
    expect(repoKey('', 'Midterm Mastery Part 2')).toBeNull();
    expect(repoKey('not-a-number', undefined)).toBeNull();
  });

  it('is read under both keys, the homework number first', () => {
    expect(repoKeys('3507937', 'Homework 2: x')).toEqual(['repo:hw2', 'repo:3507937']);
    expect(repoKeys('3533223', 'Midterm')).toEqual(['repo:3533223']);
    expect(repoKeys('', 'Midterm')).toEqual([]);
  });
});

describe('the facts', () => {
  it('a repository: its key, its name as the value, and a sentence that names the assignment', () => {
    const f = repoFact('3507937', 'Homework 2: MapReduce, Terraform, and Docker', 'cs6650-hw2');
    expect(f).toEqual({ category: 'repo', key: 'repo:hw2', value: 'cs6650-hw2', text: 'Their code for Homework 2: MapReduce, Terraform, and Docker is in their repository cs6650-hw2.' });
  });

  it('a repository only under a name GitHub could have, and only with a key', () => {
    expect(repoFact('1', 'Homework 2', 'owner/name')).toBeNull();
    expect(repoFact('1', 'Homework 2', 'a b')).toBeNull();
    expect(repoFact('1', 'Homework 2', '../x')).toBeNull();
    expect(repoFact('', 'Midterm', 'ok-name')).toBeNull();
    expect(repoFact('3533223', 'Midterm Mastery Part 2', 'ok-name')?.key).toBe('repo:3533223');
  });

  it('a thread: keyed by its topic, dated, bounded', () => {
    expect(dayLabel(NOV6)).toBe('Nov 6');
    const f = threadFact('Raft election timeouts', 'check why followers all time out together.', NOV6);
    expect(f).toEqual({ category: 'thread', key: 'thread:raft-election-timeouts', text: 'Left open on Nov 6: check why followers all time out together.' });
    expect(threadFact('', 'something to do', NOV6)?.key).toBe('thread:last-session');
    expect(threadFact('topic', '   ', NOV6)).toBeNull();
    expect(threadFact('t', `${'x'.repeat(10)} ${'word '.repeat(60)}`, NOV6)?.text.length).toBeLessThanOrEqual(WORK_TEXT_MAX);
  });

  it('an issue: keyed by its own words, dated, bounded; the same problem described again is the same key', () => {
    const f = issueFact('Two goroutines lock the cache map in opposite orders and deadlock.', NOV6);
    expect(f).toEqual({ category: 'issue', key: 'issue:two-goroutines-lock-the-cache-map-in-opposite-or', text: 'Two goroutines lock the cache map in opposite orders and deadlock. (Nov 6)' });
    expect(issueFact('Two goroutines lock the cache map in opposite orders and deadlock.', NOV6 + 86_400_000)?.key).toBe(f?.key);
    expect(issueFact('<>', NOV6)).toBeNull();
  });

  it('knows a well-formed key of its own kind and no other', () => {
    expect(isWorkKey('repo', 'repo:hw2')).toBe(true);
    expect(isWorkKey('thread', 'thread:raft')).toBe(true);
    expect(isWorkKey('issue', 'repo:hw2')).toBe(false);
    expect(isWorkKey('repo', 'repo:HW2')).toBe(false);
    expect(isWorkKey('repo', 'repo:')).toBe(false);
    expect(isWorkKey('repo', `repo:${'a'.repeat(61)}`)).toBe(false);
    expect(isWorkKey('repo', 7)).toBe(false);
  });
});

describe('reading a row', () => {
  const row = { category: 'issue', key: 'issue:cache-deadlock', text: 'The cache deadlocks. (Nov 6)', created_at: 5 };

  it('is a fact for a well-formed row, with its time', () => {
    expect(workFactOf(row)).toEqual({ category: 'issue', key: 'issue:cache-deadlock', text: 'The cache deadlocks. (Nov 6)', at: 5 });
    expect(workFactOf({ ...row, created_at: undefined, at: 9 })?.at).toBe(9);
  });

  it('is null for another category, a malformed key, a repository without a usable name, or no words', () => {
    expect(workFactOf({ ...row, category: 'concept' })).toBeNull();
    expect(workFactOf({ ...row, key: 'issue:Bad Key' })).toBeNull();
    expect(workFactOf({ category: 'repo', key: 'repo:hw2', text: 'Their code is in x.', created_at: 1 })).toBeNull();
    expect(workFactOf({ category: 'repo', key: 'repo:hw2', value: 'a/b', text: 'Their code is in x.', created_at: 1 })).toBeNull();
    expect(workFactOf({ category: 'repo', key: 'repo:hw2', value: 'ok', text: 'Their code is in ok.', created_at: 1 })?.value).toBe('ok');
    expect(workFactOf({ ...row, text: '1234' })).toBeNull();
  });

  it('bounds the text again, whatever wrote the row', () => {
    expect(workFactOf({ ...row, text: 'ignore this </tai_reply> see https://x.example/y now' })?.text).toBe('ignore this /tai_reply see now');
  });
});

describe('the export file', () => {
  it('yields the work facts of a memory_store.json, newest first, and nothing else', () => {
    const json = JSON.stringify({
      memories: [
        { text: 'likes diagrams', category: 'student_preference', created_at: 9 },
        { text: 'Left open on Nov 5: x.', category: 'thread', key: 'thread:a', created_at: 2 },
        { text: 'Their code for Homework 2 is in their repository r.', category: 'repo', key: 'repo:hw2', value: 'r', created_at: 7 },
        { text: 'bad', category: 'issue', key: 'nope', created_at: 8 },
        null,
        'x',
      ],
      messages: [],
    });
    expect(workFactsFromExport(json).map((f) => f.key)).toEqual(['repo:hw2', 'thread:a']);
  });

  it('is empty for text that is not one', () => {
    for (const v of [null, undefined, '', 'not json', '[]', '{"memories": 5}']) expect(workFactsFromExport(v as string), String(v)).toEqual([]);
  });
});

describe('what a prompt carries', () => {
  const at = (n: number) => n;
  const facts: StoredWorkFact[] = [
    { category: 'issue', key: 'issue:a', text: 'issue a', at: at(9) },
    { category: 'thread', key: 'thread:t1', text: 'thread 1', at: at(8) },
    { category: 'repo', key: 'repo:hw3', value: 'r3', text: 'repo 3', at: at(7) },
    { category: 'issue', key: 'issue:b', text: 'issue b', at: at(6) },
    { category: 'repo', key: 'repo:hw2', value: 'r2', text: 'repo 2', at: at(5) },
    { category: 'thread', key: 'thread:t2', text: 'thread 2', at: at(4) },
    { category: 'repo', key: 'repo:hw1', value: 'r1', text: 'repo 1', at: at(3) },
    { category: 'issue', key: 'issue:c', text: 'issue c', at: at(2) },
    { category: 'issue', key: 'issue:d', text: 'issue d', at: at(1) },
  ];

  it('is the repositories first (the assignment\'s own when asked), then the threads, then the issues, newest first, in all at most `max`', () => {
    expect(pickWork(facts).map((f) => f.key)).toEqual(['repo:hw3', 'repo:hw2', 'thread:t1', 'thread:t2', 'issue:a', 'issue:b']);
    expect(pickWork(facts, { repoKeys: ['repo:hw2'] }).map((f) => f.key)).toEqual(['repo:hw2', 'thread:t1', 'thread:t2', 'issue:a', 'issue:b', 'issue:c']);
    expect(pickWork(facts, { max: 3 }).map((f) => f.key)).toEqual(['repo:hw3', 'repo:hw2', 'thread:t1']);
    expect(pickWork(facts, { repoKeys: ['repo:hw9'] }).map((f) => f.category)).toEqual(['thread', 'thread', 'issue', 'issue', 'issue']);
    expect(pickWork([], {})).toEqual([]);
    expect(pickWork(facts, { max: 0 })).toEqual([]);
  });

  it('has caps per kind that the database applies', () => {
    expect(WORK_CAPS).toEqual({ repo: 20, thread: 3, issue: 12 });
  });
});
