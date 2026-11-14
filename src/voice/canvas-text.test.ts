import { describe, expect, it } from 'vitest';

import { compactAssignmentDetail, findInCourse } from './canvas-text.js';
import type { StudentContext } from './context-builder.js';
import { conversationalPrompt } from './prompts.js';

// The student's own clock next to the Pacific one (docs/COURSE_TIME.md). canvas_api.py adds `due_local` only when the student's zone reads a
// different time than Pacific; what is said aloud carries it when it is there and is exactly what it was when it is not.
const NOW = Date.parse('2026-11-02T14:00:00Z');
const LOCAL = 'Mon Nov 2, 10:00 AM (America/Vancouver, UTC-7)';

const detail = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 101, name: 'Homework 6: Scalability?', due_at: '2026-11-02T17:00:00Z', points_possible: 30, submission_types: ['online_text_entry'], description: '<p>Add a cache.</p>', ...extra });

describe('compactAssignmentDetail and the student\'s own clock', () => {
  it('says the Pacific time as before and, on the next line, the student\'s clock when canvas_api.py gave one', () => {
    const lines = compactAssignmentDetail(detail({ due_pacific: 'Mon Nov 2, 9:00 AM PST', due_local: LOCAL, due_relative: 'due in 3 hours' }), NOW)!.split('\n');
    expect(lines[1]).toBe('Due: Mon, Nov 2, 9:00 AM PST (in 3 hours).');
    expect(lines[2]).toBe(`On the student's own clock that is ${LOCAL}.`);
    expect(lines[3]).toMatch(/^Points: 30/);
  });

  it('is exactly what it was without due_local: nothing about a clock, no extra line', () => {
    const lines = compactAssignmentDetail(detail({ due_pacific: 'Mon Nov 2, 9:00 AM PST', due_relative: 'due in 3 hours' }), NOW)!.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Assignment 101: Homework 6: Scalability?', 'Due: Mon, Nov 2, 9:00 AM PST (in 3 hours).', 'Points: 30. Submit as: online_text_entry.']);
    expect(lines.join('\n')).not.toMatch(/own clock/i);
    for (const empty of ['', '   ', null, 7, {}]) {
      expect(compactAssignmentDetail(detail({ due_local: empty }), NOW), JSON.stringify(empty)).not.toMatch(/own clock/i);
    }
  });

  it('never says a clock for an assignment with no due date, and clips what is not a short phrase', () => {
    expect(compactAssignmentDetail(detail({ due_at: null, due_local: LOCAL }), NOW)).not.toMatch(/own clock/i);
    const long = compactAssignmentDetail(detail({ due_local: `Mon Nov 2, 10:00 AM (${'x'.repeat(300)})` }), NOW)!;
    const line = long.split('\n').find((l) => l.startsWith("On the student's own clock"))!;
    expect(line.length).toBeLessThan(140); // the 80 characters of the phrase and the words around it
  });
});

describe('findInCourse and the student\'s own clock', () => {
  const list = (items: Array<Record<string, unknown>>) => JSON.stringify(items);
  const hw = { id: 101, name: 'Homework 6: Scalability?', due_at: '2026-11-02T17:00:00Z', due_pacific: 'Mon Nov 2, 9:00 AM PST' };

  it('puts the student\'s clock after the Pacific time of each assignment it finds', () => {
    const out = findInCourse('homework', '[]', '[]', '[]', list([{ ...hw, due_local: LOCAL }]));
    expect(out).toContain(`- assignment_id=101 "Homework 6: Scalability?" (due Mon Nov 2, 9:00 AM PST; on the student's own clock ${LOCAL})`);
  });

  it('is exactly what it was without it', () => {
    const out = findInCourse('homework', '[]', '[]', '[]', list([hw]));
    expect(out).toContain('- assignment_id=101 "Homework 6: Scalability?" (due Mon Nov 2, 9:00 AM PST)');
    expect(out).not.toMatch(/own clock/i);
    const bare = findInCourse('homework', '[]', '[]', '[]', list([{ id: 101, name: 'Homework 6: Scalability?', due_local: LOCAL }]));
    expect(bare.split('\n').find((l) => l.startsWith('- assignment_id=101'))).toBe('- assignment_id=101 "Homework 6: Scalability?"'); // a clock with no Pacific time beside it is not told
  });
});

describe('the conversational prompt and the student\'s own clock', () => {
  const ctx: StudentContext = { competencyText: null, competencySummary: '', memories: [], work: [], recentChat: [], courseStatus: '' };
  const prompt = conversationalPrompt({ studentName: 'Ana Lopez', firstName: 'Ana', today: 'Monday, November 2, 2026' }, ctx);

  it('keeps the Pacific rule and adds what to do with due_local', () => {
    expect(prompt).toContain("say the Pacific time in plain words, never the UTC one");
    expect(prompt).toContain('due_local');
    expect(prompt).toMatch(/Pacific first/);
    expect(prompt).toMatch(/never work out the difference yourself or leave the Pacific time out/);
    expect(prompt).toContain('The course status below has Pacific only');
  });

  it('has no worked example with a day and an hour in it (a model repeats one for a deadline in an hour: see context-builder.test.ts)', () => {
    const rule = prompt.split('\n').find((l) => l.startsWith('6. Dates'))!;
    expect(rule).not.toMatch(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|nine|ten)\b/i);
    expect(rule).not.toMatch(/\d{1,2}:\d{2}/);
  });
});
