import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildContextMessages, courseStatusExcerpt, freshDeadline, loadInterviewContext, loadStudentContext, memoriesFromStore } from './context-builder.js';
import { capPrompt, conversationalPrompt, firstNameOf, interviewerPrompt } from './prompts.js';

let root: string;
let groupDir: string;
const COMP = '## Student Profile\n- Name: Ana Lopez\n\n## Mastery Scores\nRaft: 0.4 | 0.2 | [theoretical] | [] | 2026-10-01\nPaxos: 0.35 | 0.1 | [verbal] | [] | 2026-10-01\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-ctx-'));
  groupDir = path.join(root, 'groups', 's_a');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'groups', 'global'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('what a call takes of the course status', () => {
  const STATUS = [
    '# Course Status',
    'Last synced: 2026-11-02 14:00 UTC',
    '',
    '## Syllabus Summary',
    'CS 6650: Building Scalable Distributed Systems (Online Section!) Land Acknowledgement We acknowledge that the land on which we are offering this course ' + 'x'.repeat(1500),
    '',
    '## Course Structure (Modules)',
    '| Module | Materials |',
    '|---|---|',
    '| WELCOME! | Day 1 intro video! |',
    '| Week 2: Observability and AWS! | Observability.pdf |',
    '',
    '## Upcoming Deadlines (next 7 days)',
    '- 2026-11-02 17:00 UTC (Mon Nov 2, 9:00 AM PST): Midterm Mastery Part 2 (within 24 hours)',
    '',
    '## Alerts',
    '- due within 24 hours: Midterm Mastery Part 2',
    '',
    '## Sync Errors',
    'none',
  ].join('\n');

  it('keeps the deadlines, the alerts and the names of the modules, not the syllabus that opens the file', () => {
    const out = courseStatusExcerpt(STATUS, 1500, Date.UTC(2026, 10, 2, 14, 0));
    expect(out).toContain('Last synced: 2026-11-02 14:00 UTC');
    // the deadline as it stands at the moment of the call, not as it stood when the file was written ("within 24 hours")
    expect(out).toContain('Upcoming deadlines:\n- Midterm Mastery Part 2: due in 3 hours (Mon Nov 2, 9:00 AM PST)');
    expect(out).not.toContain('Alerts:');
    expect(out).toContain("The course's modules: WELCOME!; Week 2: Observability and AWS!");
    expect(out).not.toContain('Land Acknowledgement');
    expect(out.length).toBeLessThanOrEqual(1500);
  });

  it('says a deadline that has passed was due (the model said "is due" of one that had passed half an hour before)', () => {
    expect(freshDeadline('- 2026-11-02 17:00 UTC (Mon Nov 2, 9:00 AM PST): Midterm Mastery Part 2 (within 24 hours)', Date.UTC(2026, 10, 2, 17, 27))).toBe('- Midterm Mastery Part 2: was due 27 minutes ago (Mon Nov 2, 9:00 AM PST)');
    expect(freshDeadline('- 2026-11-03 17:00 UTC (Tue Nov 3, 9:00 AM PST): HW 3 (in 2 days)', Date.UTC(2026, 10, 2, 17, 0))).toBe('- HW 3: due in 1 day (Tue Nov 3, 9:00 AM PST)');
    expect(freshDeadline('a line that is not a deadline', 0)).toBe('a line that is not a deadline');
    expect(courseStatusExcerpt(STATUS, 1500, Date.UTC(2026, 10, 2, 17, 27))).toContain('was due 27 minutes ago');
  });

  it('falls back to the start of a file it cannot read the sections of', () => {
    expect(courseStatusExcerpt('HW9 due Monday')).toBe('HW9 due Monday');
  });
});

describe('the call\'s starting context', () => {
  it('condenses COMPETENCY.md, the newest memories and the last five chat lines', () => {
    fs.writeFileSync(path.join(groupDir, 'COMPETENCY.md'), COMP);
    fs.writeFileSync(
      path.join(groupDir, 'memory_store.json'),
      JSON.stringify({
        memories: Array.from({ length: 9 }, (_, i) => ({ text: `memory ${i}`, category: 'concept', created_at: i, key: i === 8 ? 'style' : null, value: i === 8 ? 'visual' : null })),
      }),
    );
    fs.writeFileSync(path.join(root, 'groups', 'global', 'COURSE_STATUS.md'), 'HW9 due Monday');
    const chat = Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `line ${i}\u0007` }));
    const ctx = loadStudentContext({ groupsDir: path.join(root, 'groups'), folder: 's_a', jid: 'web:s_a', recentChat: () => chat });
    expect(ctx.competencySummary).toContain('Student: Ana Lopez');
    expect(ctx.memories).toHaveLength(6);
    expect(ctx.memories[0]).toBe('[concept] [style=visual] memory 8');
    expect(ctx.recentChat.map((l) => l.text)).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
    expect(ctx.courseStatus).toBe('HW9 due Monday');

    const items = buildContextMessages(ctx, { withMemoryCall: true });
    expect(items[0]).toEqual({
      type: 'History',
      function_calls: [{ id: 'ctx_competency', name: 'read_competency', client_side: true, arguments: '{}', response: ctx.competencySummary }],
    });
    expect(items[1]).toMatchObject({ type: 'History', function_calls: [{ name: 'recall_memory', arguments: '{"query":"student context"}' }] });
    // the last lines of the chat are in the context (and the prompt's background), but not as turns of this call: as History they were taken for what TAi had just said
    expect(items.slice(2)).toHaveLength(0);
    expect(buildContextMessages(ctx, { withMemoryCall: false }).some((i) => JSON.stringify(i).includes('recall_memory'))).toBe(false);
  });

  it('has a usable context with nothing on disk', () => {
    const ctx = loadStudentContext({ groupsDir: path.join(root, 'groups'), folder: 's_a', jid: 'web:s_a' });
    expect(ctx.competencySummary).toMatch(/No competency record yet/);
    expect(ctx.memories).toEqual([]);
    expect(memoriesFromStore(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('the interview context', () => {
  const now = Date.parse('2026-11-01T15:00:00Z');
  const file = (extra: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(groupDir, 'interview_context.json'),
      JSON.stringify({ assignmentId: '77', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build a\nconcurrent server', codeExcerpts: 'func main() {}', weakConcepts: [], generatedAt: '2026-11-01T14:30:00Z', ...extra }),
    );

  it('uses the tool\'s file when it is recent and for the assignment asked, filling its weak spots from COMPETENCY.md', () => {
    file({});
    const { context, fresh } = loadInterviewContext({ groupDir, studentName: 'Ana', competencyText: COMP, assignmentId: '77', now });
    expect(fresh).toBe(true);
    expect(context).toMatchObject({ assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build a\nconcurrent server', source: 'file', weakConcepts: ['Raft (0.4)', 'Paxos (0.35)'] });
  });

  it('falls back to COMPETENCY.md and the topic for a stale file, another assignment, or garbage', () => {
    file({ generatedAt: '2026-10-30T10:00:00Z' });
    expect(loadInterviewContext({ groupDir, studentName: 'Ana', competencyText: COMP, topic: 'Raft', now }).fresh).toBe(false);
    file({});
    const other = loadInterviewContext({ groupDir, studentName: 'Ana', competencyText: COMP, assignmentId: '78', topic: 'HW4', now });
    expect(other.fresh).toBe(false);
    expect(other.context).toMatchObject({ assignmentName: 'HW4', source: 'competency', assignmentSpec: '' });
    fs.writeFileSync(path.join(groupDir, 'interview_context.json'), '{nope');
    expect(loadInterviewContext({ groupDir, studentName: 'Ana', competencyText: null, now }).context.assignmentName).toBe('');
  });
});

describe('the prompts', () => {
  const person = { studentName: 'Ana Lopez', firstName: 'Ana', today: 'Sunday, November 1, 2026' };
  it('keep the voice rules and the page\'s chat, and say nothing of WhatsApp', () => {
    const ctx = loadStudentContext({ groupsDir: path.join(root, 'groups'), folder: 's_a', jid: 'web:s_a' });
    const p = conversationalPrompt(person, ctx);
    expect(p).toContain('One to three short sentences per turn');
    expect(p).toContain('THEY LEAD');
    expect(p).toContain('Never say their name aloud');
    expect(p).toContain('file_content');
    expect(p).not.toContain('tomorrow at nine'); // an example in a prompt is repeated for a deadline in an hour
    expect(p).not.toContain('I put it in the chat'); // so is a fixed sign-off
    expect(p).toContain('render_diagram');
    expect(p).toContain('[Typed in the chat during the call]');
    expect(p).toContain('You cannot see pictures');
    expect(p).not.toMatch(/whatsapp|youtube|sharepoint|generate_image/i);
    const { context } = loadInterviewContext({ groupDir, studentName: 'Ana', competencyText: COMP, topic: 'HW3', now: Date.now() });
    const ip = interviewerPrompt(person, context, 15);
    expect(ip).toContain('evaluate_answer');
    expect(ip).toContain('about 15 minutes');
    expect(ip).toContain('Raft (0.4)');
    expect(ip).toContain('You do not have the assignment details yet');
  });

  it('cap the prompt for Deepgram\'s managed models, and speak a safe first name', () => {
    expect(capPrompt('x'.repeat(30_000)).length).toBeLessThanOrEqual(24_000);
    expect(firstNameOf('Yuzheng Shi')).toBe('Yuzheng');
    expect(firstNameOf('<script>')).toBe('there');
    expect(firstNameOf('')).toBe('there');
  });
});
