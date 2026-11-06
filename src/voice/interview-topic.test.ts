import { describe, expect, it } from 'vitest';

import { pickAssignment, sharesWord, significantWords, topicEvidenced, type TranscriptLine } from './interview-topic.js';

const student = (text: string): TranscriptLine => ({ role: 'student', text });
const tai = (text: string): TranscriptLine => ({ role: 'tai', text });

describe('the words that name a topic', () => {
  it('keeps names and numbers, drops filler, reads number words as digits', () => {
    expect(significantWords('Let us do a mock interview on homework six, please')).toEqual(['6']);
    expect(significantWords('Homework 1a: Let’s Get Going')).toEqual(['1a', '1', 'get', 'going']);
    expect(significantWords('the second assignment, Raft leader election')).toEqual(['2', 'raft', 'leader', 'election']);
    expect(significantWords('HW3 concurrency')).toEqual(['3', 'concurrency']);
    expect(significantWords('homework3')).toEqual(['3']);
  });
});

describe('start_interview must be backed by the student', () => {
  it('refuses a topic the student never said, however sure the model is of it (the owner’s call)', () => {
    const talk = [
      tai("hey Yuzheng, what's up?"),
      student("I don't know anything about c s six six five zero."),
      tai('Got it, let’s start with the fundamentals: how distributed services discover each other, keep data consistent, or stay resilient?'),
      student('Nothing. Nothing.'),
      tai('Think of a common address book they could all check to find each other: service discovery.'),
      student("Let's do a mock interview."),
    ];
    expect(topicEvidenced('service discovery', talk)).toBe(false);
    expect(topicEvidenced('mock interview', talk)).toBe(false);
    expect(topicEvidenced('', talk)).toBe(false);
  });

  it('takes a topic the student named, in any of the ways they say it', () => {
    expect(topicEvidenced('Homework 6: Scalability', [tai('which assignment?'), student('homework six')])).toBe(true);
    expect(topicEvidenced('Raft consensus', [student('can we practice raft')])).toBe(true);
    expect(topicEvidenced('HW 1a', [student('the first homework please')])).toBe(true); // "1a" is also "1"
    expect(topicEvidenced('Homework 6: Scalability', [student('homework two')])).toBe(false);
  });

  it('takes a topic TAi offered and the student said yes to', () => {
    expect(topicEvidenced('Midterm Mastery Part 1', [tai('want to practice the midterm mastery?'), student('yeah')])).toBe(true);
    expect(topicEvidenced('Midterm Mastery Part 1', [tai('want to practice the midterm mastery?'), student('no thanks')])).toBe(false);
    expect(topicEvidenced('Midterm Mastery Part 1', [tai('shall we do something else?'), student('yeah')])).toBe(false);
  });
});

describe('the assignment a topic means', () => {
  const list = [
    { id: 11, name: 'Homework 1a: Let’s Get Going', due_at: '2026-09-14T16:00:00Z' },
    { id: 13, name: 'Homework 3: Concurrency', due_at: '2026-09-28T16:00:00Z' },
    { id: 16, name: 'Homework 6: Scalability', due_at: '2026-10-19T16:00:00Z' },
    { id: 21, name: 'Midterm Mastery Part 1', due_at: '2026-10-12T16:00:00Z' },
    { id: 22, name: 'Midterm Mastery Part 2', due_at: '2026-11-02T17:00:00Z' },
  ];
  const now = Date.parse('2026-11-02T14:00:00Z');

  it('finds it by its number, however the student says it', () => {
    expect(pickAssignment('homework three', list, now)).toEqual({ id: '13', name: 'Homework 3: Concurrency' });
    expect(pickAssignment('HW 6', list, now)?.id).toBe('16');
    expect(pickAssignment('the first homework', list, now)?.id).toBe('11'); // "first" is 1, "1a" is also 1, and "Midterm Mastery Part 1" is not a homework
  });

  it('finds it by a word of its name', () => {
    expect(pickAssignment('scalability', list, now)?.id).toBe('16');
  });

  it('takes the one due nearest to now when several share the words', () => {
    expect(pickAssignment('the midterm mastery', list, now)?.id).toBe('22');
  });

  it('is null when nothing shares a word with it, or there is nothing to share', () => {
    expect(pickAssignment('service discovery', list, now)).toBeNull();
    expect(pickAssignment('mock interview', list, now)).toBeNull();
    expect(pickAssignment('homework three', [{ id: 'x', name: 'Homework 3' }, { name: 'Homework 3' }, null as never], now)).toBeNull();
  });

  it('knows a file for another assignment when it sees one', () => {
    expect(sharesWord('homework three', 'Homework 3: Concurrency')).toBe(true);
    expect(sharesWord('homework three', 'Midterm Mastery Part 1')).toBe(false);
  });
});
