/**
 * A week brief as the producer writes it (contract section 5, container/agent-runner), for the synthetic student Ada, and its parsed view.
 * Shared by the tests of the parser and of the prompts: nothing in it is a real student's.
 */
import { parseWeekBrief } from '../week-brief.js';
import type { WeekBriefView } from '../week-brief.js';

// 2026-11-04 3:15 PM Pacific (PST: daylight saving ended on Nov 1)
export const NOW = Date.parse('2026-11-04T23:15:00Z');
export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** A brief as the producer writes it (contract section 5), for the synthetic student Ada. */
export function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    generatedAt: '2026-11-04T23:10:00Z',
    window: { since: '2026-10-28T23:10:00Z', until: '2026-11-04T23:10:00Z' },
    week: { number: 8, title: 'Week 8! We are over half way!' },
    assignments: [
      {
        id: '3527597', name: 'Homework 7: Distributed Locking', primary: true, unlockAt: '2026-11-02T08:00:00Z', dueAt: '2026-11-09T17:00:00Z', due: 'Mon Nov 9, 9:00 AM PST (in 5 days)', points: 100,
        requirements: 'Build a lock service in Go.\nPost your tradeoffs on Piazza.', status: 'not_submitted', statusLine: 'Not submitted yet (due in 5 days)', submission: null,
      },
      {
        id: '3527411', name: 'Homework 6: Load Balancing', primary: false, unlockAt: '2026-10-26T08:00:00Z', dueAt: '2026-11-02T17:00:00Z', due: 'Mon Nov 2, 9:00 AM PST (2 days ago)', points: 100,
        requirements: 'Compare round robin and least connections under bursty traffic.', status: 'graded', statusLine: 'Submitted Nov 1, on time; graded 88 of 100',
        submission: {
          submittedAt: '2026-11-01T18:00:00Z', late: false, missing: false, score: 88, grade: 'B+', attempt: 1, type: 'online_text_entry', links: ['https://github.com/ada/hw6'],
          text: 'Round robin spreads evenly but ignores load.',
          comments: [{ at: '2026-11-03T18:00:00Z', from: 'teacher', text: 'Good comparison, but what about p99 with one slow backend?' }],
          rubric: ['Analysis: 8/10 - missing the slow backend case', 'Code: 10/10'],
        },
      },
    ],
    commits: {
      owner: 'ada', total: 3,
      repos: [{
        name: 'cs6650-hw7-locks', own: true, count: 3,
        commits: [
          { sha: SHA, date: '2026-11-03T20:00:00Z', message: 'add mutex around the lock table', files: [{ name: 'locks/table.go', status: 'modified', additions: 31, deletions: 4 }] },
          { sha: SHA, date: '2026-11-02T17:00:00Z', message: 'wip', files: [] },
          { sha: SHA, date: '2026-11-01T18:00:00Z', message: 'acquire and release handlers', files: [] },
        ],
      }],
    },
    piazza: {
      matched: true, matchedBy: 'email', counts: { posted: 1, followups: 0, answers: 0 },
      posts: [{ id: 412, role: 'posted', type: 'note', subject: 'HW7: why leases', tags: ['hw7'], date: '2026-11-02T19:00:00Z', text: 'I chose leases because a crashed client cannot renew one.' }],
    },
    sources: { canvas: 'ok', github: 'ok', piazza: 'ok', errors: [] },
    ...over,
  };
}

export function view(over: Record<string, unknown> = {}): WeekBriefView {
  const v = parseWeekBrief(raw(over), NOW);
  if (!v) throw new Error('the fixture did not parse');
  return v;
}

const words = (n: number): string => 'word '.repeat(Math.ceil(n / 5)).slice(0, n);
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000).toISOString();

/**
 * A brief with every field as large as section 5 of the contract allows (four assignments with a full submission each, four repositories of fifteen
 * commits, eight posts of 600 characters, five comments of 300, eight rubric lines): the worst case the prompt's budget has to take.
 */
export function maxRaw(): Record<string, unknown> {
  return {
    version: 1,
    generatedAt: new Date(NOW).toISOString(),
    window: { since: daysAgo(7), until: daysAgo(0) },
    week: { number: 8, title: 'Week 8! We are over half way and the title is as long as a title may be '.padEnd(120, 'w') },
    assignments: Array.from({ length: 4 }, (_, i) => ({
      id: String(3527597 + i), name: `Homework ${7 - i}: `.padEnd(160, 'N'), primary: i === 0, unlockAt: daysAgo(6), dueAt: new Date(NOW + (i + 1) * 86_400_000).toISOString(), due: 'Mon Nov 9, 9:00 AM PST (in 5 days)', points: 100,
      requirements: words(i === 0 ? 2500 : 600), status: i === 0 ? 'graded' : 'late', statusLine: 'Submitted Nov 1, on time; graded 88 of 100',
      submission: {
        submittedAt: daysAgo(2), late: i !== 0, missing: false, score: 88, grade: 'B+', attempt: 2, type: 'online_text_entry', links: ['https://github.com/ada/hw'], text: words(1500),
        comments: Array.from({ length: 5 }, (_, k) => ({ at: daysAgo(1), from: k % 2 ? 'student' : 'teacher', text: words(300) })),
        rubric: Array.from({ length: 8 }, (_, k) => `Criterion ${k}: 8/10 - ${words(150)}`),
      },
    })),
    commits: {
      owner: 'ada', total: 60, note: words(200),
      repos: Array.from({ length: 4 }, (_, r) => ({
        name: `cs6650-repository-${r}-`.padEnd(100, 'R'), own: r !== 3, count: 15,
        commits: Array.from({ length: 15 }, (_, c) => ({
          sha: SHA, date: daysAgo(c * 0.4 + r * 0.1), message: words(200),
          files: r === 0 && c < 4 ? Array.from({ length: 8 }, (_, f) => ({ name: `services/orders/internal/handlers/file_${f}_`.padEnd(120, 'f'), status: 'modified', additions: 12, deletions: 3 })) : [],
        })),
      })),
    },
    piazza: {
      matched: true, matchedBy: 'email', counts: { posted: 3, followups: 3, answers: 2 }, note: words(200),
      posts: Array.from({ length: 8 }, (_, k) => ({ id: k, role: 'posted', type: 'note', subject: words(160), tags: ['hw7', 'locks', 'raft', 'go', 'docker'], date: daysAgo(k * 0.5), text: words(600) })),
    },
    sources: { canvas: 'ok', github: 'ok', piazza: 'ok', errors: [] },
  };
}
