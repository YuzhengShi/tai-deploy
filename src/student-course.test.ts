import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchSubmissions, pacificTime, parseSubmissions, readStudentSnapshot, refreshStudentCourse, studentUpdates, type Snapshot, type Submission } from './student-course.js';

const NOW = new Date('2026-11-02T20:00:00Z');

/** A row as Canvas answers `students/submissions?include[]=assignment`. */
function row(o: Partial<{ user: number; assignment: number; name: string; due: string; cachedDue: string; points: number; state: string; submittedAt: string | null; gradedAt: string | null; postedAt: string | null; score: number | null; missing: boolean; excused: boolean; types: string[]; published: boolean }> = {}) {
  return {
    id: 1,
    user_id: o.user ?? 1001,
    assignment_id: o.assignment ?? 7,
    workflow_state: o.state ?? 'unsubmitted',
    submitted_at: o.submittedAt ?? null,
    graded_at: o.gradedAt ?? null,
    posted_at: o.postedAt !== undefined ? o.postedAt : (o.gradedAt ?? null),        // graded and posted at once, unless the test says the grade is held back
    score: o.score ?? null,
    missing: o.missing ?? false,
    excused: o.excused ?? false,
    ...(o.cachedDue ? { cached_due_date: o.cachedDue } : {}),
    assignment: { id: o.assignment ?? 7, name: o.name ?? 'Homework 7', due_at: o.due ?? '2026-11-09T17:00:00Z', points_possible: o.points ?? 15, published: o.published ?? true, submission_types: o.types ?? ['online_upload'] },
  };
}
const parse = (...rows: ReturnType<typeof row>[]) => parseSubmissions(rows);

describe('parseSubmissions', () => {
  it('reads a submission with its assignment, the student\'s own due date first', () => {
    const [s] = parse(row({ cachedDue: '2026-11-10T17:00:00Z', score: 12, gradedAt: '2026-11-02T10:00:00Z', state: 'graded', submittedAt: '2026-11-08T10:00:00Z' }));
    expect(s).toEqual({
      userId: '1001',
      assignmentId: '7',
      name: 'Homework 7',
      dueAt: '2026-11-10T17:00:00Z',
      points: 15,
      state: 'graded',
      submittedAt: '2026-11-08T10:00:00Z',
      gradedAt: '2026-11-02T10:00:00Z',
      postedAt: '2026-11-02T10:00:00Z',
      score: 12,
      missing: false,
      excused: false,
      submittable: true,
    });
  });

  it('leaves out what is not a student\'s submission of a published assignment, and survives what is not a list', () => {
    expect(parse(row({ published: false }), row({ state: 'deleted' }), { ...row(), assignment: undefined } as never)).toEqual([]);
    expect(parseSubmissions(null)).toEqual([]);
    expect(parseSubmissions({ error: 'no' })).toEqual([]);
    expect(parseSubmissions([null, 5, 'x', {}])).toEqual([]);
  });

  it('knows an assignment a student turns in on Canvas from one they do not (paper, Gradescope)', () => {
    expect(parse(row({ types: ['online_url'] }))[0].submittable).toBe(true);
    expect(parse(row({ types: ['online_quiz'] }))[0].submittable).toBe(true);
    expect(parse(row({ types: ['external_tool'] }))[0].submittable).toBe(false);
    expect(parse(row({ types: ['on_paper'] }))[0].submittable).toBe(false);
    expect(parse(row({ types: [] }))[0].submittable).toBe(false);
  });
});

describe('pacificTime', () => {
  it('says the course\'s time, in daylight time and out of it', () => {
    expect(pacificTime('2026-11-09T17:00:00Z')).toBe('Mon Nov 9, 9:00 AM PST');
    expect(pacificTime('2026-10-26T16:13:00Z')).toBe('Mon Oct 26, 9:13 AM PDT');
    expect(pacificTime(undefined)).toBe('');
    expect(pacificTime('not a date')).toBe('');
  });
});

const snapshotOf = (...subs: Submission[]): Snapshot => studentUpdates(null, subs, NOW).next;

describe('studentUpdates', () => {
  it('makes a baseline of the first look: no grade and no "missing" is news', () => {
    const subs = parse(row({ state: 'graded', gradedAt: '2026-10-01T10:00:00Z', score: 10, assignment: 1 }), row({ missing: true, assignment: 2, due: '2026-10-05T16:00:00Z' }));
    const { next, updates } = studentUpdates(null, subs, NOW);
    expect(updates.size).toBe(0);
    // what is kept also says when each is due and whether it is turned in on Canvas: the teaching patrol's gate reads that (src/patrol-gate.ts)
    expect(next['1001']['1']).toEqual({ state: 'graded', gradedAt: '2026-10-01T10:00:00Z', postedAt: '2026-10-01T10:00:00Z', missing: false, dueAt: '2026-11-09T17:00:00Z', submittable: true });
    expect(next['1001']['2']).toEqual({ state: 'unsubmitted', missing: true, dueAt: '2026-10-05T16:00:00Z', submittable: true });
  });

  it('tells a student of a grade posted, with the score, and of one changed', () => {
    const was = parse(row({ state: 'submitted', submittedAt: '2026-11-01T10:00:00Z' }));
    const graded = parse(row({ state: 'graded', submittedAt: '2026-11-01T10:00:00Z', gradedAt: '2026-11-02T18:00:00Z', score: 12.5, points: 15 }));
    const first = studentUpdates(snapshotOf(...was), graded, NOW);
    expect(first.updates.get('1001')).toEqual([{ title: 'Grade posted', text: 'Homework 7 · 12.5/15', detail: 'The score and the comments are in Canvas.' }]);
    const regraded = parse(row({ state: 'graded', submittedAt: '2026-11-01T10:00:00Z', gradedAt: '2026-11-02T19:00:00Z', score: 14, points: 15 }));
    expect(studentUpdates(first.next, regraded, NOW).updates.get('1001')).toEqual([{ title: 'Grade updated', text: 'Homework 7 · 14/15', detail: 'The score and the comments are in Canvas.' }]);
    expect(studentUpdates(first.next, graded, NOW).updates.size).toBe(0);                      // nothing changed: nothing said
  });

  it('does not tell a student of a grade Canvas holds back, and tells them when it is posted', () => {
    const was = parse(row({ state: 'submitted', submittedAt: '2026-11-01T10:00:00Z' }));
    const held = parse(row({ state: 'graded', submittedAt: '2026-11-01T10:00:00Z', gradedAt: '2026-11-02T18:00:00Z', postedAt: null, score: 12, points: 15 }));
    const first = studentUpdates(snapshotOf(...was), held, NOW);
    expect(first.updates.size).toBe(0);                                                         // graded, but not visible to the student yet
    const posted = parse(row({ state: 'graded', submittedAt: '2026-11-01T10:00:00Z', gradedAt: '2026-11-02T18:00:00Z', postedAt: '2026-11-02T19:30:00Z', score: 12, points: 15 }));
    expect(studentUpdates(first.next, posted, NOW).updates.get('1001')).toEqual([{ title: 'Grade posted', text: 'Homework 7 · 12/15', detail: 'The score and the comments are in Canvas.' }]);
  });

  it('says only "graded" of an assignment that has no points to score (a mastery)', () => {
    const was = parse(row({ state: 'submitted', points: 0, submittedAt: '2026-11-01T10:00:00Z' }));
    const graded = parse(row({ state: 'graded', points: 0, score: 0, submittedAt: '2026-11-01T10:00:00Z', gradedAt: '2026-11-02T18:00:00Z' }));
    expect(studentUpdates(snapshotOf(...was), graded, NOW).updates.get('1001')![0].text).toBe('Homework 7 · graded');
  });

  it('tells a student that Canvas has marked an assignment missing, once, with when it was due', () => {
    const was = parse(row({ due: '2026-11-02T16:00:00Z' }));
    const missing = parse(row({ due: '2026-11-02T16:00:00Z', missing: true }));
    const first = studentUpdates(snapshotOf(...was), missing, NOW);
    expect(first.updates.get('1001')![0]).toMatchObject({ title: 'Marked missing', text: 'Homework 7 · was due Mon Nov 2, 8:00 AM PST' });
    expect(studentUpdates(first.next, missing, NOW).updates.size).toBe(0);
  });

  it('does not say "no submission from you" of a row that has a submission or a grade, or of an assignment that is not turned in on Canvas', () => {
    const was = parse(
      row({ user: 1, due: '2026-11-02T16:00:00Z' }),
      row({ user: 2, due: '2026-11-02T16:00:00Z' }),
      row({ user: 3, due: '2026-11-02T16:00:00Z' }),
      row({ user: 4, due: '2026-11-02T16:00:00Z', types: ['external_tool'] }),
      row({ user: 5, due: '2026-11-02T16:00:00Z' }),
    );
    const now = parse(
      row({ user: 1, due: '2026-11-02T16:00:00Z', missing: true, state: 'graded', gradedAt: '2026-11-02T20:00:00Z', postedAt: null, score: 0 }),  // graded with a 0 by the teacher (held back: it is not the news here)
      row({ user: 2, due: '2026-11-02T16:00:00Z', missing: true, state: 'submitted', submittedAt: '2026-11-02T17:00:00Z' }),                   // turned in late, the flag kept
      row({ user: 3, due: '2026-11-02T16:00:00Z', missing: true, types: ['on_paper'] }),                                                       // paper
      row({ user: 4, due: '2026-11-02T16:00:00Z', missing: true, types: ['external_tool'] }),                                                  // Gradescope
      row({ user: 5, due: '2026-11-02T16:00:00Z', missing: true }),                                                                            // the one that is
    );
    const { updates } = studentUpdates(snapshotOf(...was), now, NOW);
    expect([...updates.keys()]).toEqual(['5']);
    expect(updates.get('5')![0].title).toBe('Marked missing');
  });

  it('reminds a student who has not turned in what is due within 24 hours, once, and nobody who has, or whom it does not concern', () => {
    const soon = '2026-11-03T08:00:00Z';
    const cases = parse(
      row({ user: 1, assignment: 1, due: soon }),                                              // not turned in: reminded
      row({ user: 2, assignment: 1, due: soon, state: 'submitted', submittedAt: '2026-11-02T10:00:00Z' }),
      row({ user: 3, assignment: 1, due: soon, excused: true }),
      row({ user: 4, assignment: 1, due: soon, types: ['external_tool'] }),
      row({ user: 5, assignment: 1, due: '2026-11-05T08:00:00Z' }),                            // not yet within 24 hours
      row({ user: 6, assignment: 1, due: '2026-11-02T10:00:00Z' }),                            // already past
      row({ user: 7, assignment: 1, due: soon, cachedDue: '2026-11-09T08:00:00Z' }),           // an extension
    );
    const first = studentUpdates(null, cases, NOW);                                            // even the baseline: a deadline is current, not history
    expect([...first.updates.keys()]).toEqual(['1']);
    expect(first.updates.get('1')).toEqual([{ title: 'Due soon · not submitted yet', text: 'Homework 7 · due Tue Nov 3, 12:00 AM PST', detail: 'Canvas has no submission from you yet.' }]);
    expect(studentUpdates(first.next, cases, NOW).updates.size).toBe(0);                       // once, not at every look after
  });

  it('does not take a student who has just joined, or an assignment a student has just got, for news: their old grades come all at once', () => {
    const known = snapshotOf(...parse(row({ user: 1, assignment: 1, state: 'submitted', submittedAt: '2026-10-01T10:00:00Z' })));
    const now = parse(
      row({ user: 1, assignment: 1, state: 'graded', gradedAt: '2026-11-02T18:00:00Z', score: 9, points: 10, submittedAt: '2026-10-01T10:00:00Z' }),
      row({ user: 1, assignment: 2, state: 'graded', gradedAt: '2026-11-02T18:00:00Z', score: 9, points: 10 }),                  // an assignment this student had not in the snapshot
      row({ user: 2, assignment: 1, state: 'graded', gradedAt: '2026-10-05T18:00:00Z', score: 7, points: 10 }),                  // a student the snapshot did not know
      row({ user: 2, assignment: 2, missing: true }),
    );
    const { updates } = studentUpdates(known, now, NOW);
    expect([...updates.keys()]).toEqual(['1']);
    expect(updates.get('1')).toHaveLength(1);
    expect(updates.get('1')![0].text).toBe('Homework 7 · 9/10');
  });

  it('puts four of a kind for one student in one line', () => {
    const was = parse(...[1, 2, 3, 4, 5].map((a) => row({ assignment: a, name: `Homework ${a}`, state: 'submitted', submittedAt: '2026-11-01T10:00:00Z' })));
    const graded = parse(...[1, 2, 3, 4, 5].map((a) => row({ assignment: a, name: `Homework ${a}`, state: 'graded', gradedAt: '2026-11-02T18:00:00Z', score: 5, points: 10, submittedAt: '2026-11-01T10:00:00Z' })));
    const list = studentUpdates(snapshotOf(...was), graded, NOW).updates.get('1001')!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: 'Grades posted', text: '5 assignments' });
    expect(list[0].detail).toContain('Homework 1 · 5/10\nHomework 2 · 5/10');
  });

  it('keeps the snapshot it had when Canvas answered with nothing', () => {
    const known = snapshotOf(...parse(row()));
    const result = studentUpdates(known, [], NOW);
    expect(result.next).toBe(known);
    expect(result.updates.size).toBe(0);
  });

  it('keeps what the patrol\'s gate needs of a deadline: when it is due (the student\'s own date first), and whether it is excused or not turned in on Canvas', () => {
    const { next } = studentUpdates(null, parse(row({ assignment: 3, types: ['on_paper'], excused: true }), row({ assignment: 4, cachedDue: '2026-11-10T17:00:00Z' })), NOW);
    expect(next['1001']['3']).toEqual({ state: 'unsubmitted', missing: false, dueAt: '2026-11-09T17:00:00Z', excused: true });       // paper: no "submittable"
    expect(next['1001']['4']).toEqual({ state: 'unsubmitted', missing: false, dueAt: '2026-11-10T17:00:00Z', submittable: true });
  });
});

describe('fetchSubmissions', () => {
  const page = (rows: unknown[], next?: string) => ({ ok: true, status: 200, json: async () => rows, headers: new Headers(next ? { link: `<${next}>; rel="next", <https://x/first>; rel="first"` } : {}) }) as unknown as Response;

  it('reads every page with the token, from the class\'s submissions with their assignments', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization') });
      return seen.length === 1 ? page([row({ user: 1 })], 'https://canvas.example/api/v1/courses/55/students/submissions?page=2') : page([row({ user: 2 })]);
    }) as unknown as typeof fetch;
    const subs = await fetchSubmissions({ baseUrl: 'https://canvas.example/api/v1/', token: 'tok', courseId: '55', fetchImpl });
    expect(subs.map((s) => s.userId)).toEqual(['1', '2']);
    expect(seen[0].url).toBe('https://canvas.example/api/v1/courses/55/students/submissions?student_ids[]=all&include[]=assignment&per_page=100');
    expect(seen.map((s) => s.auth)).toEqual(['Bearer tok', 'Bearer tok']);
  });

  it('does not send the token to another host, whatever a next page says', async () => {
    let calls = 0;
    const fetchImpl = (async () => (calls++, page([row()], 'https://evil.example/steal'))) as unknown as typeof fetch;
    const subs = await fetchSubmissions({ baseUrl: 'https://canvas.example/api/v1', token: 'tok', courseId: '55', fetchImpl });
    expect(subs).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('stops at the page limit, and says what went wrong without the token', async () => {
    let calls = 0;
    const endless = (async () => (calls++, page([row()], 'https://canvas.example/api/v1/next'))) as unknown as typeof fetch;
    await fetchSubmissions({ baseUrl: 'https://canvas.example/api/v1', token: 'tok', courseId: '55', fetchImpl: endless, maxPages: 3 });
    expect(calls).toBe(3);
    const refused = (async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchSubmissions({ baseUrl: 'https://canvas.example/api/v1', token: 'secret-token', courseId: '55', fetchImpl: refused })).rejects.toThrow('Canvas answered 401');
  });
});

describe('refreshStudentCourse', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-student-course-'));
    file = path.join(dir, 'store', 'student-course.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SECRETS = { CANVAS_API_TOKEN: 't', CANVAS_BASE_URL: 'https://canvas.example/api/v1', CANVAS_COURSE_ID: '55' };
  const canvasSays = (...rows: unknown[]) => (async () => ({ ok: true, status: 200, json: async () => rows, headers: new Headers() }) as unknown as Response) as unknown as typeof fetch;

  it('does nothing without Canvas configured', async () => {
    const told: string[] = [];
    expect(await refreshStudentCourse({ deliver: (u) => void told.push(u), file, readSecrets: () => ({}) })).toBe('skipped');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('makes the baseline, then tells a student of what changed, and keeps nothing a student could be named by but ids and flags', async () => {
    const told: Array<[string, string[]]> = [];
    const deps = (fetchImpl: typeof fetch) => ({ deliver: (u: string, l: { title: string }[]) => void told.push([u, l.map((x) => x.title)]), file, readSecrets: () => SECRETS, fetchImpl, now: () => NOW });
    expect(await refreshStudentCourse(deps(canvasSays(row({ state: 'submitted', submittedAt: '2026-11-01T10:00:00Z' }))))).toBe('baseline');
    expect(told).toEqual([]);
    expect(await refreshStudentCourse(deps(canvasSays(row({ state: 'graded', submittedAt: '2026-11-01T10:00:00Z', gradedAt: '2026-11-02T18:00:00Z', score: 12 }))))).toBe('delivered');
    expect(told).toEqual([['1001', ['Grade posted']]]);
    expect(await refreshStudentCourse(deps(canvasSays(row({ state: 'graded', submittedAt: '2026-11-01T10:00:00Z', gradedAt: '2026-11-02T18:00:00Z', score: 12 }))))).toBe('unchanged');
    const kept = fs.readFileSync(file, 'utf-8');
    expect(kept).not.toContain('Homework 7');
    expect(kept).not.toContain('12');
    expect((fs.statSync(file).mode & 0o077) === 0 || process.platform === 'win32').toBe(true);
  });

  it('lets the patrol\'s gate read the snapshot and when it was taken, and says nothing when there is none or it is not one', async () => {
    expect(readStudentSnapshot(file)).toBeNull();
    await refreshStudentCourse({ deliver: () => undefined, file, readSecrets: () => SECRETS, fetchImpl: canvasSays(row({ assignment: 5 })), now: () => NOW });
    const read = readStudentSnapshot(file);
    expect(read?.at).toBe(NOW.toISOString());
    expect(read?.snapshot['1001']['5']).toMatchObject({ state: 'unsubmitted', dueAt: '2026-11-09T17:00:00Z', submittable: true });
    fs.writeFileSync(file, '{not json');
    expect(readStudentSnapshot(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ at: 5, snapshot: {} }));
    expect(readStudentSnapshot(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ at: NOW.toISOString(), snapshot: null }));
    expect(readStudentSnapshot(file)).toBeNull();
  });

  it('keeps the snapshot when Canvas fails or answers with nothing, and a delivery that fails does not fail the look', async () => {
    const deliver = () => {
      throw new Error('no page');
    };
    await refreshStudentCourse({ deliver: () => undefined, file, readSecrets: () => SECRETS, fetchImpl: canvasSays(row()), now: () => NOW });
    const before = fs.readFileSync(file, 'utf-8');
    const boom = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await refreshStudentCourse({ deliver: () => undefined, file, readSecrets: () => SECRETS, fetchImpl: boom })).toBe('failed');
    expect(await refreshStudentCourse({ deliver: () => undefined, file, readSecrets: () => SECRETS, fetchImpl: canvasSays() })).toBe('failed');
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    const soon = row({ due: '2026-11-03T08:00:00Z' });
    expect(await refreshStudentCourse({ deliver, file, readSecrets: () => SECRETS, fetchImpl: canvasSays(soon), now: () => NOW })).toBe('unchanged');
  });
});
