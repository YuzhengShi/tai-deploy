/**
 * The week's evidence through the whole hub with a fake Deepgram and a fake tool host: the brief that start_mock_interview writes into
 * interview_context.json reaches the interviewer (in the first prompt when the file is already there, as an UpdatePrompt when it arrives after
 * the interview has begun, and in the Settings of a reconnect), and everything the call holds together (the Settings' prompt and what is appended
 * to it) stays inside the 24,000 characters Deepgram takes.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { signInterviewToken } from './interview-token.js';
import { PROMPT_MAX } from './prompts.js';
import { completion, streamed } from './testing/fake-gateway.js';
import { BrowserClient, Harness, INTERVIEW_SECRET, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import { maxRaw, raw } from './testing/week-fixture.js';
import type { ToolResult } from './tool-host.js';
import type { Caller } from './types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

type Handler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

const ASSIGNMENTS = JSON.stringify([{ id: 3527597, name: 'HW3 Concurrency', due_at: '2026-11-09T17:00:00Z' }]);
const REPOS = JSON.stringify([{ name: 'hw3-concurrency', updated_at: '2026-10-20T00:00:00Z' }]);
const SMALL_TREE = JSON.stringify([
  { name: 'main.go', path: 'main.go', type: 'file', size: 400 },
  { name: 'orders.go', path: 'handlers/orders.go', type: 'file', size: 900 },
]);
/** Forty-five code files whose paths are the longest the prompt lists (a hundred characters): the repository block at its largest. */
const LONG_TREE = JSON.stringify(Array.from({ length: 45 }, (_, i) => ({ name: 'h.go', path: `${'d'.repeat(80)}/handler_${String(i).padStart(2, '0')}.go`, type: 'file', size: 500 })));

const words = (n: number, w: string): string => `${w} `.repeat(Math.ceil(n / (w.length + 1))).slice(0, n);

/** The tool host of a student whose repository is hw3-concurrency; start_mock_interview leaves `context` in the student's folder, as the real tool does. */
function course(tree: string, context: () => Record<string, unknown> | null, folder: () => string): Record<string, Handler> {
  return {
    canvas_query: () => ({ ok: true, text: ASSIGNMENTS }),
    github_query: (args) => {
      const { action } = args as { action: string };
      if (action === 'list_repos') return { ok: true, text: REPOS };
      if (action === 'repo_tree') return { ok: true, text: tree };
      return { ok: true, text: '[]' };
    },
    start_mock_interview: () => {
      const file = context();
      if (file) fs.writeFileSync(path.join(h!.groupsDir, folder(), 'interview_context.json'), JSON.stringify({ ...file, generatedAt: new Date().toISOString() }));
      return { ok: true, text: 'Mock interview ready for Ada — HW3 Concurrency' };
    },
  };
}

async function startCall(harness: Harness, user: Caller, start: Record<string, unknown> = { type: 'start', mode: 'chat' }): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection }> {
  const browser = await harness.browser(user);
  browser.send(start);
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  await browser.next('ready');
  return { browser, conn };
}

async function interviewOf(harness: Harness, user: Caller): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection }> {
  const call = await startCall(harness, user);
  call.conn.userSays('homework three, the concurrency one');
  call.conn.callFunction('fc-iv', 'start_interview', { topic: 'HW3 concurrency' });
  await call.conn.waitFor('UpdateThink');
  await call.browser.next('mode', (e) => e.mode === 'interviewer');
  return call;
}

const brief = () => raw({ assignments: [{ id: '3527597', name: 'HW3 Concurrency', primary: true, dueAt: '2026-11-09T17:00:00Z', status: 'not_submitted', requirements: 'Build an order service in Go.\nPost your tradeoffs on Piazza.' }] });
const FILE = (weekBrief: Record<string, unknown>) => ({ studentName: 'Ada', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.', weekBrief });

/** What the call holds: the prompt of its Settings or of the switch, and everything appended to it. */
const held = (conn: FakeDeepgramConnection): number => {
  const think: any = conn.ofType('UpdateThink')[0] ?? conn.ofType('Settings')[0];
  const prompt = String(think.think?.prompt ?? think.agent?.think?.prompt ?? '');
  return prompt.length + conn.ofType('UpdatePrompt').reduce((n, m) => n + String((m as any).prompt).length, 0);
};

describe('the week\'s evidence reaches the interviewer', () => {
  it('arrives as an update when the interview began without it, with the rules, and the call stays inside what Deepgram takes; a reconnect keeps it', async () => {
    let folder = '';
    h = await createHarness({ toolHandlers: course(SMALL_TREE, () => FILE(brief()), () => folder) });
    const u = h.user(1);
    folder = u.folder;
    const { conn } = await interviewOf(h, u);

    const update = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes("THE WEEK'S EVIDENCE"));
    const text = String(update.prompt);
    expect(text.startsWith('## ASSIGNMENT CONTEXT (just arrived; use it from your next question on)')).toBe(true);
    for (const part of ['## THIS WEEK', '## THEIR COMMITS THIS WEEK', '## THEIR PIAZZA THIS WEEK', 'add mutex around the lock table', '<<<STUDENT TEXT ', 'NEVER say a score, a grade or points']) expect(text).toContain(part);
    expect(text).toContain('- HW3 Concurrency (you are practicing this one). Due: Mon, Nov 9, 9:00 AM PST'); // the assignment the call is about, by the id the file carries
    // (the markers end in 12 random hex characters, which may hold "88" by chance: the check is of the text without them)
    const plain = text.replace(/STUDENT TEXT [0-9a-f]{12}/g, 'STUDENT TEXT n');
    for (const gone of ['88', 'B+', 'a1b2c3d4']) expect(plain).not.toContain(gone);
    // the interview's first prompt had none of this (the file was not there yet): the rules came with the update, and the repository before it
    const think: any = conn.ofType('UpdateThink')[0];
    expect(think.think.prompt).not.toContain("THE WEEK'S EVIDENCE");
    expect(conn.ofType('UpdatePrompt').some((m: any) => String(m.prompt).startsWith('## THEIR REPOSITORY'))).toBe(true);
    expect(held(conn)).toBeLessThanOrEqual(PROMPT_MAX);

    // Deepgram drops the call: the Settings are sent again, with the brief in them, inside the cap
    conn.close(1011);
    const settings: any = await (await h.dg.connection(2)).waitFor('Settings');
    expect(settings.agent.think.prompt).toContain("THE WEEK'S EVIDENCE");
    expect(settings.agent.think.prompt).toContain('## THEIR COMMITS THIS WEEK');
    expect(settings.agent.think.prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
  });

  it('is in the first prompt when the interview starts from a link whose file is already there, and the long tool is not called again', async () => {
    let folder = '';
    h = await createHarness({ toolHandlers: course(SMALL_TREE, () => null, () => folder) });
    const u = h.user(1);
    folder = u.folder;
    fs.writeFileSync(path.join(h.groupsDir, folder, 'interview_context.json'), JSON.stringify({ ...FILE(brief()), generatedAt: new Date().toISOString() }));
    const token = signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now());
    const { conn } = await startCall(h, u, { type: 'start', mode: 'chat', token });
    const settings: any = await conn.waitFor('Settings');
    const prompt = String(settings.agent.think.prompt);
    expect(prompt).toContain("THE WEEK'S EVIDENCE");
    expect(prompt).toContain('## THEIR PIAZZA THIS WEEK');
    expect(prompt).toContain('that are not in the ASSIGNMENT or THIS WEEK sections below.');
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(h.toolHosts[0]?.calls.some((c) => c.tool === 'start_mock_interview') ?? false).toBe(false);
  });

  it('keeps the whole call inside 24,000 characters when everything is at its maximum: forty files of a hundred characters, the brief, the course material, the code', async () => {
    let folder = '';
    const big = { ...FILE(maxRaw()), assignmentSpec: words(2500, 'zspc'), lectureContent: words(5000, 'zlec'), submissionText: words(3000, 'zsub'), codeExcerpts: words(4000, 'zcod') };
    // (maxRaw's first assignment is not this one: the file's own id is what the interview is about, so the brief's rules and sections come with their own primary)
    big.weekBrief = { ...maxRaw(), assignments: (maxRaw().assignments as Array<Record<string, unknown>>).map((a, i) => (i === 0 ? { ...a, id: '3527597' } : a)) };
    h = await createHarness({ toolHandlers: course(LONG_TREE, () => big, () => folder) });
    const u = h.user(1);
    folder = u.folder;
    fs.writeFileSync(
      path.join(h.groupsDir, u.folder, 'COMPETENCY.md'),
      `## Student Profile\n- Name: Ada\n\n## Mastery Scores\n${Array.from({ length: 30 }, (_, i) => `${`Concept ${i} `.padEnd(100, 'c')}: 0.3 | 0.1 | [theoretical] | [] | 2026-10-01`).join('\n')}\n`,
    );
    const { conn } = await interviewOf(h, u);
    const update = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes("THE WEEK'S EVIDENCE"));
    const repo = conn.ofType('UpdatePrompt').map((m: any) => String(m.prompt)).find((p) => p.startsWith('## THEIR REPOSITORY'));
    expect(repo).toContain('(5 more files are not listed');
    expect((repo ?? '').split('\n').filter((l) => l.startsWith('- ')).length).toBe(40);
    expect(String(update.prompt)).toContain('## THEIR PIAZZA THIS WEEK');
    expect(held(conn)).toBeLessThanOrEqual(PROMPT_MAX);
    // and again after a reconnect, when it is one prompt
    conn.close(1011);
    const settings: any = await (await h.dg.connection(2)).waitFor('Settings');
    expect(settings.agent.think.prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(settings.agent.think.prompt.trimEnd().endsWith('never read the result aloud.')).toBe(true);
  });

  it('changes nothing for an interview whose file has no brief: the update is the one it always was', async () => {
    let folder = '';
    h = await createHarness({ toolHandlers: course(SMALL_TREE, () => ({ studentName: 'Ada', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.' }), () => folder) });
    const u = h.user(1);
    folder = u.folder;
    const { conn } = await interviewOf(h, u);
    const update = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes('Build an order service in Go.'));
    expect(String(update.prompt)).toBe('## ASSIGNMENT CONTEXT (just arrived; use it from your next question on)\n\nHW3 Concurrency:\nBuild an order service in Go.');
    expect(conn.ofType('UpdatePrompt').some((m: any) => String(m.prompt).includes('STUDENT TEXT'))).toBe(false);
  });
});

const STRONG = '{"accuracy": 5, "depth": 4, "verbal_clarity": 5, "problem_solving": 4, "missed_concepts": [], "suggested_follow_up": "Ask about RWMutex", "difficulty_adjustment": "harder", "said": "They said the lock stops two creates racing.", "better": "You could add that the check and the insert must be one critical section."}';

/** The gateway as the evaluator and the summary see it (as in hub-interview.test.ts): every answer is a strong one. */
function evaluating(harness: Harness): void {
  harness.gw.respond = (body) => {
    const messages = body.messages as Array<{ content: string }>;
    const system = String(messages[0]?.content ?? '');
    if (system.includes('teaching evaluator')) return completion(STRONG);
    if (system.includes('You write the note')) return completion('We practised HW3.');
    return streamed('hello');
  };
}

/** A call that starts as an interview from a link whose context file is fresh, with or without a brief in it. */
async function linkInterview(harness: Harness, user: Caller, weekBrief: Record<string, unknown> | null): Promise<FakeDeepgramConnection> {
  fs.writeFileSync(path.join(harness.groupsDir, user.folder, 'interview_context.json'), JSON.stringify({ ...FILE(weekBrief ?? {}), ...(weekBrief ? {} : { weekBrief: undefined }), generatedAt: new Date().toISOString() }));
  const token = signInterviewToken(INTERVIEW_SECRET, user.folder, '3527597', Date.now());
  const { conn } = await startCall(harness, user, { type: 'start', mode: 'chat', token });
  await conn.waitFor('Settings');
  return conn;
}

describe('the beats while the interview goes on', () => {
  const ask = async (conn: FakeDeepgramConnection, id: string): Promise<Record<string, any>> => {
    conn.callFunction(id, 'evaluate_answer', { question_asked: 'Why is the lock taken there?', student_answer_summary: 'an answer: strong', topic: 'Concurrency' });
    return JSON.parse(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === id)).content));
  };

  it('puts what the sections show, the contradiction check and the beat that is due into the result of evaluate_answer, in the host\'s words', async () => {
    h = await createHarness({ toolHandlers: course(SMALL_TREE, () => null, () => '') });
    evaluating(h);
    const conn = await linkInterview(h, h.user(1), brief());
    const first = await ask(conn, 'e1');
    // the evaluation it always got, and one more thing
    expect(first).toMatchObject({ accuracy: 5, difficulty_adjustment: 'harder', missed_concepts: [] });
    expect(first).not.toHaveProperty('better');
    expect(first.week).toContain('What the sections show: Piazza: 1 post of theirs is listed, the first from Mon, Nov 2; HW3 Concurrency: not submitted yet; commits: 3 listed, the newest from Tue, Nov 3.');
    expect(first.week).toContain('your next question is about that: say what the section shows in one short neutral sentence and ask them to talk about it');
    expect(first.week).not.toContain('Due now');
    const second = await ask(conn, 'e2');
    expect(second.week).toContain('Due now, if you have not asked it yet: a commit.');
    await ask(conn, 'e3');
    const fourth = await ask(conn, 'e4');
    expect(fourth.week).toContain('Due now, if you have not asked it yet: their Piazza post.');
    await ask(conn, 'e5');
    const sixth = await ask(conn, 'e6');
    expect(sixth.week).toContain('Due now, if you have not asked it yet: where the assignment stands');
    expect(sixth.week).toContain('it is not submitted yet: ask what is left');
    // nothing a student wrote, nothing of a grade
    for (const text of [first.week, second.week, fourth.week, sixth.week]) for (const gone of ['why leases', 'add mutex', '88', 'B+', 'a1b2c3d4']) expect(text).not.toContain(gone);
  });

  it('names the commit beat at the first answer after a brief that arrives after two answers, the others at their own slots: the usual start, where the brief is fetched in the background', async () => {
    let folder = '';
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const handlers = course(SMALL_TREE, () => null, () => folder);
    handlers.start_mock_interview = async () => {
      await gate;
      fs.writeFileSync(path.join(h!.groupsDir, folder, 'interview_context.json'), JSON.stringify({ ...FILE(brief()), generatedAt: new Date().toISOString() }));
      return { ok: true, text: 'Mock interview ready for Ada — HW3 Concurrency' };
    };
    h = await createHarness({ toolHandlers: handlers });
    evaluating(h);
    const u = h.user(1);
    folder = u.folder;
    const { conn } = await interviewOf(h, u);
    // two answers are evaluated before the brief is there: no note, and nothing named
    for (const id of ['e1', 'e2']) expect(await ask(conn, id)).not.toHaveProperty('week');
    open();
    await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes("THE WEEK'S EVIDENCE"));
    // a count from the start alone would have let the commit's slot (the 2nd answer) go by: it is named with the first answer the brief is there for
    expect((await ask(conn, 'e3')).week).toContain('Due now, if you have not asked it yet: a commit.');
    expect((await ask(conn, 'e4')).week).toContain('Due now, if you have not asked it yet: their Piazza post.');
    expect((await ask(conn, 'e5')).week).not.toContain('Due now');
    expect((await ask(conn, 'e6')).week).toContain('Due now, if you have not asked it yet: where the assignment stands');
  });

  it('adds nothing to the result for an interview with no brief', async () => {
    h = await createHarness({ toolHandlers: course(SMALL_TREE, () => null, () => '') });
    evaluating(h);
    const conn = await linkInterview(h, h.user(1), null);
    const first = await ask(conn, 'e1');
    expect(first).toMatchObject({ accuracy: 5 });
    expect(first).not.toHaveProperty('week');
    expect(Object.keys(first).sort()).toEqual(['accuracy', 'depth', 'difficulty_adjustment', 'missed_concepts', 'problem_solving', 'suggested_follow_up', 'verbal_clarity']);
  });

  it('wraps up with the closing that waits for the beats that are left when there is a brief, and with the plain one when there is not', async () => {
    for (const withBrief of [true, false]) {
      const clock = { now: Date.now() };
      h = await createHarness({ env: { TAI_VOICE_INTERVIEW_MIN: '2', TAI_VOICE_SILENCE_SEC: '600' }, now: () => clock.now, toolHandlers: course(SMALL_TREE, () => null, () => '') });
      const u = h.user(1);
      fs.writeFileSync(path.join(h.groupsDir, u.folder, 'interview_context.json'), JSON.stringify({ ...FILE(brief()), ...(withBrief ? {} : { weekBrief: undefined }), generatedAt: new Date(clock.now).toISOString() }));
      const { conn } = await startCall(h, u, { type: 'start', mode: 'interview' });
      clock.now += 61_000;
      const wrap = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes('WRAP UP THE INTERVIEW'));
      if (withBrief) {
        expect(String(wrap.prompt)).toContain("a beat of THE WEEK'S EVIDENCE");
        expect(String(wrap.prompt)).not.toContain('one final question at most');
      } else {
        expect(String(wrap.prompt)).toContain('Ask one final question at most');
        expect(String(wrap.prompt)).not.toContain('THE WEEK');
      }
      await h.close();
      h = null;
    }
  });
});
