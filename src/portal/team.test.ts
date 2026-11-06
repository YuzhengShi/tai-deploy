/**
 * The teaching-team view's numbers (src/portal/team.ts), on a synthetic class written as real files (src/portal/testing/team-fixture.ts):
 * the heat map in each spelling of COMPETENCY.md, the misconceptions (classified as the patrol's gate does), the patrol, the quick checks, who
 * needs attention, the voice; an empty class, one student, a file nobody can read; and that nothing a student wrote or said reaches an answer.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } }));

import { evaluateGate, gatherFacts } from '../patrol-gate.js';
import { GETTING_THERE_AT, SOLID_AT } from '../voice/competency.js';
import { studentFolder } from './auth.js';
import { CANARIES, writeTeamFixture } from './testing/team-fixture.js';
import type { TeamFixture } from './testing/team-fixture.js';
import { TeamView, callHeadings, classifyRun, misconceptionStatus, normalizeReason, parseInterventions, parseUsage, quickCheckPanel, quizEvents, sqliteTeamDb } from './team.js';
import type { RosterEntry, TeamDeps, TeamOverview } from './team.js';

const NOW = Date.parse('2026-11-04T20:00:00Z');
const DAY = 86_400_000;
const TEMPLATE = fs.readFileSync(path.resolve(process.cwd(), 'groups', 'global', 'COMPETENCY_TEMPLATE.md'), 'utf-8');
const folderOf = (key: string): string => studentFolder(`${key}@example.com`);
const day = (ago: number): string => new Date(NOW - ago * DAY).toISOString().slice(0, 10);

describe('the teaching-team view', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-team-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  let fixture: TeamFixture;
  let view: TeamView;
  let overview: TeamOverview;
  const id = (key: string): string => folderOf(key);
  const nameOf = (o: TeamOverview, key: string): TeamOverview['students'][number] => o.students.find((s) => s.id === id(key)) as TeamOverview['students'][number];
  const cell = (o: TeamOverview, concept: string, key: string) => {
    const row = o.concepts.find((c) => c.name === concept);
    const at = o.students.findIndex((s) => s.id === id(key));
    return row && at >= 0 ? row.cells[at] : undefined;
  };

  beforeEach(async () => {
    fixture = writeTeamFixture(tmp(), { now: NOW, template: TEMPLATE, folderOf });
    view = new TeamView(fixture.deps);
    overview = await view.overview();
  });

  // ------------------------------------------------------------ the class and the heat map

  it('counts the class: twelve students, the teaching-team account left out, the files it could not read said so', () => {
    expect(overview.class).toMatchObject({ students: 12, withRecord: 10, noRecord: 1, unreadable: 1, staffHidden: 1, includeStaff: false, inactiveDays: 5 });
    expect(overview.class.skipped).toEqual({ records: 1, histories: 0, voiceUsage: false });
    expect(overview.students.map((s) => s.name)).toEqual([...overview.students.map((s) => s.name)].sort((a, b) => a.localeCompare(b)));
    expect(nameOf(overview, 'lena').record).toBe('unreadable');
    expect(nameOf(overview, 'ivan').record).toBe('none');
    expect(overview.students.some((s) => s.staff)).toBe(false);
    expect(overview.cacheSeconds).toBe(60);
    expect(overview.bands).toEqual({ solid: SOLID_AT, gettingThere: GETTING_THERE_AT });
  });

  it('puts the weakest concepts of the class first, and the concepts nobody has touched last', () => {
    const met = overview.concepts.filter((c) => c.touched > 0);
    const untouched = overview.concepts.filter((c) => c.touched === 0);
    expect(met.length).toBeGreaterThan(10);
    expect(untouched.length).toBeGreaterThan(30);                                  // the later weeks of the template
    expect(overview.concepts.slice(0, met.length)).toEqual(met);                   // none of them comes before one that has evidence
    const means = met.map((c) => c.mean as number);
    expect(means).toEqual([...means].sort((a, b) => a - b));
    expect(untouched.every((c) => c.mean === null && c.last === null && c.cells.every((x) => x === null))).toBe(true);
    // a row has one cell for each student, in the order of `students`
    expect(overview.concepts.every((c) => c.cells.length === overview.students.length)).toBe(true);
  });

  it('gives each cell its confidence, stability, scopes, last evidence and whether it is a verbal gap', () => {
    const raft = 'Raft (leader election, log replication)';
    expect(cell(overview, raft, 'carol')).toEqual([0.8, 0.5, ['theoretical', 'implementation'], day(3), 1]);       // knows it, has not said it aloud
    expect(cell(overview, raft, 'bob')).toEqual([0.75, 0.5, ['theoretical', 'verbal'], day(2), 0]);
    expect(cell(overview, raft, 'dave')).toBeNull();                                                              // no evidence yet
    const row = overview.concepts.find((c) => c.name === raft)!;
    expect(row.touched).toBe(4);                                                                                  // bob, carol, june, kai
    expect(row.noVerbal).toBe(2);                                                                                 // carol and kai
    expect(row.levels).toEqual({ solid: 2, gettingThere: 2, justStarted: 0 });
    expect(row.mean).toBe(0.66);
    expect(row.last).toBe(day(1));
    expect(row.group).toMatch(/^Week 11/);
    expect(nameOf(overview, 'carol').verbalGaps).toBe(5);
    expect(nameOf(overview, 'bob').verbalGaps).toBe(0);
  });

  it('reads every spelling of the mastery lines: the template\'s, the labelled one and the older two-line one', () => {
    // bob is written labelled and hana in two lines (the fixture rewrites the template's lines in those spellings)
    const bob = fs.readFileSync(path.join(fixture.deps.groupsDir, folderOf('bob'), 'COMPETENCY.md'), 'utf-8');
    const hana = fs.readFileSync(path.join(fixture.deps.groupsDir, folderOf('hana'), 'COMPETENCY.md'), 'utf-8');
    expect(bob).toContain('confidence: 0.85 | stability: 0.7');
    expect(hana).toMatch(/Load balancers:\r?\n\s+confidence: 0\.75/);
    expect(cell(overview, 'Docker concepts (images, containers, Dockerfile)', 'bob')?.[0]).toBe(0.85);
    expect(cell(overview, 'Load balancers', 'hana')).toEqual([0.75, 0.5, ['theoretical', 'verbal'], day(4), 0]);
    expect(cell(overview, 'Go programming basics', 'carol')?.[0]).toBe(0.9);                                      // the template's own spelling
  });

  it('reads the concepts the host writes under "Chat sessions" (src/competency-writer.ts) like any others, and lists them under that heading', async () => {
    const file = path.join(fixture.deps.groupsDir, folderOf('carol'), 'COMPETENCY.md');
    fs.appendFileSync(file, `\n### Chat sessions (concepts first met in a chat)\nBackpressure in queues: 0.2 | 0.1 | [theoretical] | [socratic_dialogue] | ${day(1)}\n`);
    const o = await new TeamView(fixture.deps).overview();
    const row = o.concepts.find((c) => c.name === 'Backpressure in queues');
    expect(row?.group).toBe('Chat sessions (concepts first met in a chat)');
    expect(cell(o, 'Backpressure in queues', 'carol')).toEqual([0.2, 0.1, ['theoretical'], day(1), 0]);
    expect(row?.touched).toBe(1);
    expect(o.concepts.indexOf(row!)).toBeLessThan(o.concepts.findIndex((c) => c.touched === 0));     // a concept with evidence is not among the ones nobody has touched
  });

  it('counts one student, an empty class and a class of nobody who has a record, and none of them is a failure', async () => {
    const empty = await new TeamView({ ...fixture.deps, roster: () => [] }).overview();
    expect(empty.students).toEqual([]);
    expect(empty.concepts).toEqual([]);
    expect(empty.misconceptions).toEqual([]);
    expect(empty.attention).toEqual([]);
    expect(empty.quickChecks).toMatchObject({ asked: 0, answered: 0, questions: [] });
    expect(empty.voice).toMatchObject({ days: [], students: [] });
    expect(empty.class).toMatchObject({ students: 0, withRecord: 0, staffHidden: 0 });
    const one = await new TeamView({ ...fixture.deps, roster: () => fixture.roster.filter((r) => r.folder === id('bob')) }).overview();
    expect(one.students.map((s) => s.name)).toEqual(['Bob Barker']);
    expect(one.concepts.find((c) => c.name === 'Paxos')?.cells).toEqual([[0.6, 0.4, ['theoretical', 'verbal'], day(2), 0]]);
    const nobody = await new TeamView({ ...fixture.deps, roster: () => fixture.roster.filter((r) => r.folder === id('ivan')) }).overview();
    expect(nobody.students).toHaveLength(1);
    expect(nobody.concepts).toEqual([]);
    expect(nobody.attention.map((a) => a.name)).toEqual(['Ivan Petrov']);                                         // never wrote
  });

  it('skips a file it cannot read and says how many, and never fails: a directory, binary bytes, a shape nobody knows, a folder that is not one', async () => {
    const groups = fixture.deps.groupsDir;
    fs.rmSync(path.join(groups, folderOf('dave'), 'COMPETENCY.md'));
    fs.mkdirSync(path.join(groups, folderOf('dave'), 'COMPETENCY.md'));                     // a directory where the file should be
    fs.writeFileSync(path.join(groups, folderOf('frank'), 'COMPETENCY.md'), Buffer.from([0x23, 0x20, 0, 0, 0xff, 0xfe, 0, 1, 2, 3]));
    fs.mkdirSync(path.join(fixture.deps.historyDir, `${folderOf('kai')}.jsonl.d`), { recursive: true });
    fs.rmSync(path.join(fixture.deps.historyDir, `${folderOf('june')}.jsonl`));
    fs.mkdirSync(path.join(fixture.deps.historyDir, `${folderOf('june')}.jsonl`));         // a history that is a directory
    const roster: RosterEntry[] = [...fixture.roster, { folder: '../../etc', jid: 'web:x', name: 'Eve', staff: false }, { folder: 'main', jid: 'web:main', name: 'Admin', staff: false }];
    const o = await new TeamView({ ...fixture.deps, roster: () => roster }).overview();
    expect(o.students.map((s) => s.name)).not.toContain('Eve');
    expect(o.students.map((s) => s.name)).not.toContain('Admin');
    expect(nameOf(o, 'dave').record).toBe('unreadable');
    expect(nameOf(o, 'frank').record).toBe('unreadable');
    expect(nameOf(o, 'lena').record).toBe('unreadable');
    expect(o.class.unreadable).toBe(3);
    expect(o.class.skipped).toEqual({ records: 3, histories: 1, voiceUsage: false });
    expect(nameOf(o, 'bob').record).toBe('ok');                                             // the others are as they were
  });

  it('keeps a class going when the database, the snapshot or the voice file is broken', async () => {
    fs.writeFileSync(fixture.deps.voiceUsageFile, '{"days": {');
    const broken = await new TeamView({
      ...fixture.deps,
      db: {
        patrolRuns: () => {
          throw new Error('database is locked');
        },
        patrolCron: () => {
          throw new Error('database is locked');
        },
        lastStudentMessages: () => {
          throw new Error('database is locked');
        },
      },
      canvas: () => {
        throw new Error('snapshot is not JSON');
      },
    }).overview();
    expect(broken.class.skipped.voiceUsage).toBe(true);
    expect(broken.voice.days).toEqual([]);
    expect(broken.voice.students.map((s) => [s.name, s.total, s.calls])).toEqual([['June Park', 0, 4], ['Bob Barker', 0, 2]]);        // the calls are read from another file
    expect(broken.patrol.available).toBe(false);
    expect(broken.class.canvas).toEqual({ state: 'missing', at: null });
    expect(broken.students).toHaveLength(12);
    expect(parseUsage('[1, 2]').days).toEqual({});
    expect(parseUsage('{"days": {"2026-11-03": {"a": 60, "b": "x", "c": -1}, "nope": {"a": 1}}}').days).toEqual({ '2026-11-03': { a: 60 } });
  });

  // ------------------------------------------------------------ misconceptions

  it('groups the misconceptions by the concept they contradict: how many students, in which state, and the names only in the row', () => {
    const [first, ...rest] = overview.misconceptions;
    expect(first).toMatchObject({ concept: 'Concurrency vs parallelism distinction', students: 3, confirmed: 2, candidate: 1, remediated: 0 });
    expect(first.who.map((w) => [w.name, w.status])).toEqual([['Erin Brockovich', 'confirmed'], ['Gina Torres', 'confirmed'], ['Frank Lloyd', 'candidate']]);
    expect(rest).toEqual([expect.objectContaining({ concept: "Little's Law and queue theory", students: 1, remediated: 1, confirmed: 0, candidate: 0 })]);
    // gina's `identifying` line (discussing the mix-up correctly, not holding it) is not a misconception
    expect(overview.misconceptions.some((m) => m.concept.startsWith('ACID'))).toBe(false);
  });

  it('classifies a line the way the patrol gate does: its confirmed-and-open count is the gate\'s `misconception` signal, student by student', () => {
    for (const person of fixture.roster) {
      const facts = gatherFacts({ chat_jid: person.jid, group_folder: person.folder, schedule_value: '' }, { added_at: person.addedAt, canvasUserId: person.canvasUserId }, {
        now: () => new Date(NOW),
        groupsDir: fixture.deps.groupsDir,
        stateFile: fixture.deps.gateStateFile,
        snapshot: () => fixture.snapshot,
        lastStudentMessage: () => undefined,
        nextPatrol: () => null,
      });
      const gate = evaluateGate(facts, { mode: 'on', inactiveDays: 5, floorDays: 7 }).signals.find((s) => s.kind === 'misconception')?.n ?? 0;
      const mine = overview.misconceptions.flatMap((m) => m.who).filter((w) => w.id === person.folder && w.status === 'confirmed').length;
      if (!person.staff) expect(mine, person.name).toBe(gate);
    }
  });

  it('classifies a line of Active Misconceptions', () => {
    const line = (fields: string): string => `- "a belief" | contradicts: Raft | ${fields}`;
    expect(misconceptionStatus(line('status: confirmed | freq: 1'))).toBe('confirmed');
    expect(misconceptionStatus(line('status: candidate | freq: 3'))).toBe('confirmed');
    expect(misconceptionStatus(line('status: candidate | freq: 1 | holding'))).toBe('candidate');
    expect(misconceptionStatus(line('status: confirmed | freq: 3 | remediated'))).toBe('remediated');
    expect(misconceptionStatus(line('status: confirmed | effective: true'))).toBe('remediated');
    expect(misconceptionStatus(line('status: resolved'))).toBe('remediated');
    expect(misconceptionStatus(line('status: candidate | freq: 1 | identifying | remediation: none'))).toBe('identifying');
    // the words "not yet resolved" in the notes do not close it
    expect(misconceptionStatus(line('status: confirmed | freq: 3 | remediation: not yet resolved | effective: unknown'))).toBe('confirmed');
  });

  // ------------------------------------------------------------ the patrol

  it('tells the last seven days of the patrol: the gate\'s skips in its words, the runs of the model, the failures, and no student\'s text', () => {
    const { patrol } = overview;
    expect(patrol.available).toBe(true);
    expect(patrol).toMatchObject({ days: 7, runs: 33, skipped: 30, ranModel: 3, failed: 1, shadow: 1 });         // not bob's run of 12 days ago, not another chat's
    expect(patrol.byDay).toHaveLength(7);
    expect(patrol.byDay[6].day).toBe(day(0));
    expect(patrol.byDay.find((d) => d.day === day(1))).toEqual({ day: day(1), ranModel: 1, skipped: 10, failed: 0 });
    expect(patrol.byDay.find((d) => d.day === day(2))).toEqual({ day: day(2), ranModel: 1, skipped: 10, failed: 1 });
    expect(patrol.skipReasons).toEqual([{ reason: 'nothing new since the model last looked (<date>); still open: inactive; the weekly full check is due <date>', count: 30 }]);
    expect(patrol.recent).toHaveLength(33);
    expect(patrol.recent.filter((r) => r.kind === 'skipped')).toHaveLength(30);
    expect(patrol.recent.find((r) => r.kind === 'failed')).toEqual({ day: day(2), student: 'Erin Brockovich', kind: 'failed' });         // no error text
    expect(patrol.recent.find((r) => r.kind === 'ran')).toEqual({ day: day(1), student: 'Mike Okafor', kind: 'ran' });                    // no answer of the model's
    expect(patrol.recent.find((r) => r.kind === 'shadow')?.reason).toBe(`nothing new since the model last looked (${day(5)})`);          // the gate's words, not the model's
  });

  it('reads what each student\'s intervention log says, and shows nothing when no log has an entry', async () => {
    const { interventions } = overview.patrol;
    expect(interventions.available).toBe(true);
    expect(interventions).toMatchObject({ intervene: 2, noAction: 4, other: 1 });
    expect(interventions.students.map((s) => [s.name, s.intervene, s.noAction, s.other, s.last])).toEqual([
      ['Dave Cutler', 1, 2, 1, { date: day(1), decision: 'no-action' }],          // the scheduler's own lines (src/intervention-log.ts): a skip, two runs, a failed run
      ['Mike Okafor', 1, 1, 0, { date: day(1), decision: 'intervene' }],
      ['Carol Shaw', 0, 1, 0, { date: day(2), decision: 'no-action' }],
    ]);                                                                                                             // bob's file has no entry: not listed
    for (const key of ['mike', 'carol', 'bob', 'dave']) fs.rmSync(path.join(fixture.deps.groupsDir, folderOf(key), 'competency', 'intervention-log.md'));
    const none = await new TeamView(fixture.deps).overview();
    expect(none.patrol.interventions).toEqual({ available: false, intervene: 0, noAction: 0, other: 0, students: [] });
  });

  it('has no patrol panel without a database, and keeps the log\'s lines', async () => {
    const o = await new TeamView({ ...fixture.deps, db: null }).overview();
    expect(o.patrol).toMatchObject({ available: false, runs: 0, skipped: 0 });
    expect(o.patrol.interventions.available).toBe(true);
  });

  it('reads a patrol run only as far as the gate wrote it', () => {
    const row = (result: string | null, status = 'success') => ({ folder: 'f', runAt: '2026-11-04T16:00:00.000Z', status, result });
    expect(classifyRun(row('skipped by the gate: nothing new'))).toEqual({ kind: 'skipped', reason: 'nothing new' });
    expect(classifyRun(row('skipped by the gate'))).toEqual({ kind: 'skipped', reason: '' });
    expect(classifyRun(row('[the gate would have skipped this run: nothing new] the model said hello'))).toEqual({ kind: 'shadow', reason: 'nothing new' });
    expect(classifyRun(row('the model said hello'))).toEqual({ kind: 'ran' });
    expect(classifyRun(row(null))).toEqual({ kind: 'ran' });
    expect(classifyRun(row('the model said hello', 'error'))).toEqual({ kind: 'failed' });
    expect(classifyRun(row('[the gate would have skipped this run: x] y', 'error'))).toEqual({ kind: 'failed' });
    expect(normalizeReason('due-last:123; due-late:9; misconception:ab12cd34; spaced:00ff00ff; since 2026-11-03 and 2026-11-10')).toBe('due-last:<id>; due-late:<id>; misconception:<hash>; spaced:<hash>; since <date> and <date>');
  });

  it('reads an intervention log whatever its bullets: the protocol\'s own lines, a line with no bullet, bold, a time, a line that says nothing of a decision', () => {
    const log = [
      '# Intervention Log',
      '',
      '2026-03-19: no-action — Docker confidence 0.8, stability 0.7, no upcoming deadline.',
      '- 2026-03-20: intervene — Raft confidence 0.3, mock interview in 2 days. Sent practice question.',
      '* **2026-03-21** No action - nothing new',
      '- 2026-03-22 09:00 | Sent a quick check on Paxos',
      '- 2026-03-23: Student asked about consensus',
      'not a decision, no date',
      '- 2026-03-18: skipped (the gate said nothing new)',
    ].join('\n');
    // (lines the model wrote have a decision and no reason: its words may carry the student's, and are never shown. Only the scheduler's own lines, below, have one)
    expect(parseInterventions(log)).toEqual([
      { date: '2026-03-23', decision: 'other', reason: '' },
      { date: '2026-03-22', decision: 'intervene', reason: '' },
      { date: '2026-03-21', decision: 'no-action', reason: '' },
      { date: '2026-03-20', decision: 'intervene', reason: '' },
      { date: '2026-03-19', decision: 'no-action', reason: '' },
      { date: '2026-03-18', decision: 'no-action', reason: '' },
    ]);
    expect(parseInterventions('# Intervention Log\n\n')).toEqual([]);
    // the lines the scheduler writes for each patrol run (src/intervention-log.ts): a failure, a run that sent a message, one that did not, a skip
    const written = [
      '# Intervention Log',
      '',
      '- 2026-11-05: failed — the model could not be reached (other) | signals: inactive | no message sent | nothing kept, the next patrol looks again | gate on | 12 s',
      '- 2026-11-04: intervene — the model ran and sent the student a message | signals: due-last:901 | new signal | gate on | 44 s',
      '- 2026-11-03: no-action — the model ran and sent no message | signals: spaced:ab12cd34 | weekly check | gate on | 31 s',
      '- 2026-11-02: no-action — the gate skipped the run (no container, no model) | open signals: inactive | weekly check not due',
    ].join('\n');
    const lines = parseInterventions(written);
    expect(lines.map((i) => [i.date, i.decision])).toEqual([['2026-11-05', 'failed'], ['2026-11-04', 'intervene'], ['2026-11-03', 'no-action'], ['2026-11-02', 'no-action']]);
    expect(lines.map((i) => i.reason.split(' | ')[0])).toEqual([
      'the model could not be reached (other)',
      'the model ran and sent the student a message',
      'the model ran and sent no message',
      'the gate skipped the run (no container, no model)',
    ]);
    expect(parseInterventions(`- 2026-03-19: no-action — the gate skipped the run (no container, no model) | open signals: ${'k'.repeat(500)}`)[0].reason).toHaveLength(200);
    expect(parseInterventions(`- 2026-03-19: no-action — ${'x'.repeat(500)}`)[0].reason).toBe('');                    // a model's line: its decision, never its words
  });

  // ------------------------------------------------------------ the quick checks

  it('tells each quick check: how many answered, how many were right, and nobody\'s name', () => {
    const q = overview.quickChecks;
    expect(q).toMatchObject({ asked: 9, answered: 8, graded: 7, right: 4 });
    expect(q.questions[0]).toEqual({ question: 'Which of these is true of a Raft term?', answers: 4, graded: 4, right: 2, percentRight: 50 });   // kai twice, frank, june
    expect(q.questions.find((x) => x.question.startsWith('What does a goroutine leak'))).toMatchObject({ answers: 1, right: 0, percentRight: 0 });
    expect(q.questions.find((x) => x.question.startsWith('When a node joins'))).toMatchObject({ answers: 1, right: 1, percentRight: 100 });
    // a quick check whose key the host dropped: answered, not graded
    expect(q.questions.find((x) => x.question.startsWith('And this one'))).toEqual({ question: 'And this one, which the host doubted?', answers: 1, graded: 0, right: 0, percentRight: null });
    // quick replies ("Which part of Raft is confusing?") are not quick checks
    expect(q.questions.some((x) => x.question.startsWith('Which part of Raft'))).toBe(false);
    const text = JSON.stringify(q);
    for (const person of fixture.roster) expect(text).not.toContain(person.name);
    expect(text).not.toContain('s_');
    expect(text).not.toContain('secret');
  });

  it('pairs a tap with the line it answers, by its number and never by the position of an option, once, and only a quick check', () => {
    const lines = [
      JSON.stringify({ n: 1, role: 'assistant', text: 'Q one?', quiz: true, choices: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }], secret: { key: 1, why: 'because' } }),
      JSON.stringify({ n: 2, role: 'user', text: 'B. y', choice: { to: 1, index: 1, correct: true } }),
      JSON.stringify({ n: 3, role: 'user', text: 'A. x', choice: { to: 1, index: 0, correct: false } }),         // a second tap on the same line
      JSON.stringify({ n: 4, role: 'user', text: 'A. x', choice: { to: 99, index: 0, correct: true } }),         // a tap on a line that is not here
      JSON.stringify({ n: 5, role: 'assistant', text: 'Quick replies?', choices: [{ label: 'A', text: 'x' }] }),
      JSON.stringify({ n: 6, role: 'user', text: 'A. x', choice: { to: 5, index: 0 } }),                         // not a quick check
      JSON.stringify({ n: 7, role: 'assistant', text: 'Q two?', quiz: true }),
      JSON.stringify({ n: 8, role: 'user', text: 'A. x', choice: { to: 7, index: 0, correct: 'yes' } }),         // not a grade
      '{"n": 9, "role": "assistant", "quiz": tr',                                                                // half a line
      'not json',
      JSON.stringify({ n: 10, role: 'user', text: 'quiz: true and "choice": in the words of a student' }),
    ].join('\n');
    const events = quizEvents(lines);
    expect([...events.asked]).toEqual([[1, 'Q one?'], [7, 'Q two?']]);
    expect(events.taps).toEqual([{ to: 1, correct: true }, { to: 1, correct: false }, { to: 99, correct: true }, { to: 5 }, { to: 7 }]);
    const panel = quickCheckPanel([events]);
    expect(panel).toMatchObject({ asked: 2, answered: 2, graded: 1, right: 1 });
    expect(panel.questions.map((q) => [q.question, q.answers, q.percentRight])).toEqual([['Q one?', 1, 100], ['Q two?', 1, null]]);
    // the same words from two students are one question, whatever the case and the closing mark
    const other = quizEvents([JSON.stringify({ n: 1, role: 'assistant', text: 'q ONE', quiz: true }), JSON.stringify({ n: 2, role: 'user', text: 'x', choice: { to: 1, index: 0, correct: false } })].join('\n'));
    expect(quickCheckPanel([events, other]).questions[0]).toMatchObject({ answers: 2, graded: 2, right: 1, percentRight: 50 });
  });

  // ------------------------------------------------------------ who needs attention

  it('lists who needs attention, with their names: quiet, deadlines the gate sees, confirmed misconceptions still open', () => {
    expect(overview.attention.map((a) => [a.name, a.reasons.map((r) => r.kind)])).toEqual([
      ['Gina Torres', ['deadline', 'misconception']],
      ['Erin Brockovich', ['quiet', 'misconception']],
      ['Mike Okafor', ['quiet', 'overdue']],
      ['Ivan Petrov', ['quiet']],
    ]);
    const gina = overview.attention[0];
    expect(gina.reasons[0]).toEqual({ kind: 'deadline', assignment: '901', hours: 20 });
    expect(gina.reasons[1]).toEqual({ kind: 'misconception', concepts: ['Concurrency vs parallelism distinction'] });
    expect(overview.attention[1].reasons[0]).toEqual({ kind: 'quiet', days: 12 });
    expect(overview.attention[2].reasons).toEqual([{ kind: 'quiet', days: 8 }, { kind: 'overdue', assignment: '902', hours: 30 }]);
    expect(overview.attention[3].reasons).toEqual([{ kind: 'quiet', days: null }]);                                   // never wrote
    expect(overview.class.canvas).toEqual({ state: 'ok', at: new Date(NOW - 3 * 3_600_000).toISOString() });
  });

  it('counts a student who has been quiet for longer than the gate looks, and does not count a new one who has not written yet', async () => {
    const messages = new Map(fixture.db.messages);
    messages.set(`web:${id('dave')}`, new Date(NOW - 40 * DAY).toISOString());            // the gate stops at 21 days: the team must not
    const roster = fixture.roster.map((r) => (r.folder === id('ivan') ? { ...r, addedAt: new Date(NOW - 1 * DAY).toISOString() } : r));     // ivan joined yesterday
    const o = await new TeamView({ ...fixture.deps, roster: () => roster, db: { patrolRuns: () => [], patrolCron: () => null, lastStudentMessages: () => messages } }).overview();
    expect(o.attention.find((a) => a.name === 'Dave Cutler')?.reasons).toEqual([{ kind: 'quiet', days: 40 }]);
    expect(o.attention.find((a) => a.name === 'Ivan Petrov')).toBeUndefined();
  });

  it('sees deadlines whether or not the gate is switched off, and says when Canvas cannot be seen', async () => {
    const off = await new TeamView({ ...fixture.deps, env: { TAI_PATROL_GATE: 'off', TAI_PATROL_INACTIVE_DAYS: '9' } }).overview();
    expect(off.attention.find((a) => a.name === 'Gina Torres')?.reasons.some((r) => r.kind === 'deadline')).toBe(true);
    expect(off.class.inactiveDays).toBe(9);
    expect(off.attention.find((a) => a.name === 'Mike Okafor')?.reasons.some((r) => r.kind === 'quiet')).toBe(false);       // 8 days is under 9
    const stale = await new TeamView({ ...fixture.deps, canvas: () => ({ ...fixture.snapshot, at: new Date(NOW - 3 * DAY).toISOString() }) }).overview();
    expect(stale.class.canvas.state).toBe('stale');
    expect(stale.attention.some((a) => a.reasons.some((r) => r.kind === 'deadline' || r.kind === 'overdue'))).toBe(false);
    const missing = await new TeamView({ ...fixture.deps, canvas: () => null }).overview();
    expect(missing.class.canvas).toEqual({ state: 'missing', at: null });
  });

  it('counts the teaching-team accounts only when asked', async () => {
    const withStaff = await view.overview(true);
    expect(withStaff.class).toMatchObject({ students: 13, staffHidden: 0, includeStaff: true });
    expect(withStaff.students.find((s) => s.name === 'Ada Lovelace')?.staff).toBe(true);
    expect(overview.class.staffHidden).toBe(1);
  });

  // ------------------------------------------------------------ voice

  it('tells the voice: minutes per student per day, calls from the headings of voice-sessions.md, and the daily cap', () => {
    const { voice } = overview;
    expect(voice.capMinutes).toBe(45);
    expect(voice.days).toEqual([day(6), day(4), day(3), day(2), day(1), day(0)]);
    expect(voice.students.map((s) => [s.name, s.total, s.calls, s.lastCall])).toEqual([
      ['June Park', 91, 4, day(0)],
      ['Bob Barker', 21, 2, day(0)],
      ['Carol Shaw', 5, 0, null],
    ]);
    expect(voice.students[0].minutes).toEqual([10, 22, 0, 45, 0, 14]);
    expect(voice.totals).toEqual([10, 22, 5, 45, 12, 23]);
  });

  it('reads nothing but the headings of voice-sessions.md', () => {
    const text = [
      '# Voice Sessions',
      '',
      `## 2026-11-03 14:05 · 12 min · conversational`,
      '',
      `Summary: ${CANARIES.summary}`,
      '',
      'Transcript:',
      `- Student: ${CANARIES.voice}`,
      '- Student: ## 2026-11-02 10:00 · 99 min · fake',
      '',
      '## 2026-11-01 09:30 · 7.5 min · interviewer, conversational',
      '## not a call',
      '',
    ].join('\n');
    expect(callHeadings(text)).toEqual([{ day: '2026-11-03', minutes: 12 }, { day: '2026-11-01', minutes: 7.5 }]);
  });

  // ------------------------------------------------------------ one student

  it('gives one student\'s detail: every concept weakest first, the mix-ups by state, what the patrol decided, their voice', async () => {
    const mike = (await view.student(id('mike')))!;
    expect(mike).toMatchObject({ name: 'Mike Okafor', record: 'ok', staff: false, quietDays: 8 });
    expect(mike.concepts.map((c) => [c.name, c.confidence, c.level, c.verbalGap])).toEqual([
      ['Terraform / Infrastructure as Code', 0.6, 'getting there', true],
      ['MapReduce paper concepts', 0.8, 'solid', false],
      ['Docker concepts (images, containers, Dockerfile)', 0.85, 'solid', true],
    ]);
    expect(mike.attention.map((r) => r.kind)).toEqual(['quiet', 'overdue']);
    expect(mike.patrol).toMatchObject({ available: true, ranModel: 1, skipped: 3, failed: 0 });
    expect(mike.patrol.decisions).toEqual([
      { date: day(1), decision: 'intervene', reason: '' },                       // (the model's own words in the log are not shown: only the decision)
      { date: day(3), decision: 'no-action', reason: '' },
    ]);
    const dave = (await view.student(id('dave')))!;
    expect(dave.patrol.decisions.map((d) => [d.date, d.decision])).toEqual([[day(1), 'no-action'], [day(2), 'no-action'], [day(3), 'intervene'], [day(5), 'failed']]);
    const june = (await view.student(id('june')))!;
    expect(june.voice).toMatchObject({ calls: 4, lastCall: day(0) });
    expect(june.voice.minutes.map((m) => m.minutes)).toEqual([10, 22, 45, 14]);
    const gina = (await view.student(id('gina')))!;
    expect(gina.misconceptions).toEqual([{ concept: 'Concurrency vs parallelism distinction', status: 'confirmed' }]);
    expect((await view.student(id('lena')))?.record).toBe('unreadable');
    expect((await view.student(id('ivan')))?.concepts).toEqual([]);
    expect(await view.student(folderOf('nobody-at-all'))).toBeNull();                        // a folder of the right shape that is not on the list
    expect(await view.student('main')).toBeNull();
    expect(await view.student('../../etc')).toBeNull();
  });

  // ------------------------------------------------------------ privacy

  it('lets nothing a student wrote or said, no belief, no note, no upload, no model answer and no error reach any answer', async () => {
    expect(fixture.canaries.length).toBeGreaterThanOrEqual(10);
    const answers = [JSON.stringify(overview), JSON.stringify(await view.overview(true))];
    for (const person of fixture.roster) answers.push(JSON.stringify(await view.student(person.folder)));
    for (const [at, answer] of answers.entries()) {
      for (const canary of fixture.canaries) expect(answer.includes(canary), `answer ${at} holds ${canary}`).toBe(false);
      expect(answer).not.toContain('@example.com');
      expect(answer).not.toContain('"secret"');
      expect(answer).not.toContain('"belief"');
    }
    // a line the model wrote in a student's intervention log is read for its decision only: its words are in no answer, the student's own detail included
    // (they can carry the student's: "Ada told me she is overwhelmed"); the lines the scheduler writes there keep their reason, which is ids, counts and fixed words
    expect(answers.join('')).not.toContain('stability 0.2 and no evidence');
  });

  it('does not touch a file it is not asked about (the summaries, the notes, the uploads of the agent are never opened)', async () => {
    const seen: string[] = [];
    // (the files of a student's folder are opened without following a link or waiting for a writer, src/safe-fs.ts: by handle)
    const real = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      seen.push(String(file));
      return (real as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fs.promises.open);
    try {
      await new TeamView(fixture.deps).overview(true);
    } finally {
      spy.mockRestore();
    }
    const names = new Set(seen.map((f) => path.basename(f)).filter((name) => !name.endsWith('.jsonl')));
    expect([...names].sort()).toEqual(['intervention-log.md', 'voice-sessions.md']);       // the histories are read by their own tail reader, COMPETENCY.md by the gate's
  });

  // ------------------------------------------------------------ the cache

  it('caches the aggregate for a minute, once for callers that come together, and not at all when it failed', async () => {
    let clock = NOW;
    let calls = 0;
    const counted: TeamDeps = { ...fixture.deps, now: () => clock, roster: () => (calls++, fixture.roster) };
    const cached = new TeamView(counted);
    const [a, b] = await Promise.all([cached.overview(), cached.overview()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    clock += 59_000;
    expect(await cached.overview()).toBe(a);
    expect(calls).toBe(1);
    expect(await cached.overview(true)).not.toBe(a);                                      // the class with the staff is its own aggregate
    expect(calls).toBe(2);
    clock += 2_000;
    const later = await cached.overview();
    expect(later).not.toBe(a);
    expect(calls).toBe(3);
    cached.clear();
    await cached.overview();
    expect(calls).toBe(4);

    let broken = true;
    const flaky = new TeamView({
      ...fixture.deps,
      roster: () => {
        if (broken) throw new Error('allowlist is unreadable');
        return fixture.roster;
      },
    });
    await expect(flaky.overview()).rejects.toThrow('allowlist is unreadable');
    broken = false;
    expect((await flaky.overview()).students).toHaveLength(12);                           // the failure was not kept
  });
});

describe('the database questions', () => {
  it('asks for the patrol\'s runs by the origin and the id of the host\'s own patrol (never by the tag of a prompt), newest first, and for the schedule and the last messages', () => {
    const asked: Array<{ sql: string; params: unknown[] }> = [];
    const answers: Record<string, unknown[]> = {
      task_run_logs: [{ folder: 's_a', runAt: '2026-11-04T16:00:00.000Z', status: 'success', result: 'skipped by the gate: x' }],
      schedule_value: [{ cron: '0 9 * * 1-5' }],
      MAX: [{ jid: 'web:s_a', t: '2026-11-04T10:00:00.000Z' }, { jid: 'web:s_b', t: null }, { jid: 5, t: 'x' }],
    };
    const db = sqliteTeamDb(
      () => ({
        prepare: (sql: string) => ({
          all: (...params: unknown[]) => {
            asked.push({ sql, params });
            return Object.entries(answers).find(([key]) => sql.includes(key))?.[1] ?? [];
          },
        }),
      }),
      'TAi',
    );
    expect(db.patrolRuns('2026-10-28T00:00:00.000Z')).toEqual(answers.task_run_logs);
    expect(asked[0].params).toEqual(['2026-10-28T00:00:00.000Z']);                                          // no marker: a student's task can carry it
    expect(asked[0].sql).toMatch(/ORDER BY l\.run_at DESC/);
    expect(asked[0].sql).toContain(`t.origin = 'system' AND substr(t.id, 1, 7) = 'patrol-'`);
    expect(asked[0].sql).not.toMatch(/prompt|LIKE/i);
    expect(db.patrolCron()).toBe('0 9 * * 1-5');
    expect(asked[1].params).toEqual([]);
    expect(asked[1].sql).toContain(`origin = 'system' AND substr(id, 1, 7) = 'patrol-'`);
    expect(asked[1].sql).not.toMatch(/prompt|LIKE/i);
    expect([...db.lastStudentMessages()]).toEqual([['web:s_a', '2026-11-04T10:00:00.000Z']]);                // a chat with no message and a row that is not one are left out
    expect(asked[2].params).toEqual(['TAi:%']);
    expect(asked[2].sql).toMatch(/is_bot_message = 0/);
    answers.schedule_value = [];
    expect(db.patrolCron()).toBeNull();
    answers.schedule_value = [{ cron: 5 }];
    expect(db.patrolCron()).toBeNull();
  });
});
