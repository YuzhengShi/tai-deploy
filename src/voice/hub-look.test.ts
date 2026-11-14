/**
 * look_at_week through the whole hub with a fake Deepgram and a fake tool host (the owner's call of 2026-11-06: in the interview TAi "can only see GitHub, not Canvas and
 * Piazza": asked to look again it said it could not open Canvas). The interviewer's new function asks the student's own tool host for the week's brief again, tells the
 * model which sources arrived, and the interview keeps what they said. The logic of the answer is week-look.test.ts; the container's `format` is
 * container/agent-runner/test/weekly-brief.test.ts.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { signInterviewToken } from './interview-token.js';
import { fillerLine } from './prompts.js';
import { completion, streamed } from './testing/fake-gateway.js';
import { BrowserClient, Harness, INTERVIEW_SECRET, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import { SHA, raw } from './testing/week-fixture.js';
import type { ToolResult } from './tool-host.js';
import type { Caller } from './types.js';
import { LOOK_FAILED, LOOK_MAX, LOOK_NOT_LINKED, LOOK_TIMEOUT_MS } from './week-look.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

type Handler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

const ASSIGNMENTS = JSON.stringify([{ id: 3527597, name: 'HW3 Concurrency', due_at: '2026-11-09T17:00:00Z' }]);
const REPOS = JSON.stringify([{ name: 'hw3-concurrency', updated_at: '2026-10-20T00:00:00Z' }]);
const TREE = JSON.stringify([{ name: 'main.go', path: 'main.go', type: 'file', size: 400 }]);

/** The brief the interview began with: HW3 not submitted, three commits, one post. */
const START = () => raw({ assignments: [{ id: '3527597', name: 'HW3 Concurrency', primary: true, dueAt: '2026-11-09T17:00:00Z', status: 'not_submitted', requirements: 'Build an order service in Go.\nPost your tradeoffs on Piazza.' }] });
/** The brief a second look finds: HW3 submitted (with a grade, which must never reach the model), and a fourth commit. */
const LATER = (over: Record<string, unknown> = {}) =>
  raw({
    assignments: [
      {
        id: '3527597', name: 'HW3 Concurrency', primary: true, dueAt: '2026-11-09T17:00:00Z', status: 'graded', requirements: 'Build an order service in Go.\nPost your tradeoffs on Piazza.',
        submission: { submittedAt: '2026-11-04T22:00:00Z', late: false, missing: false, score: 95, grade: 'A', attempt: 1, text: 'Uploaded files: hw3.zip', comments: [], rubric: [] },
      },
    ],
    commits: {
      owner: 'ada', total: 4,
      repos: [{
        name: 'cs6650-hw7-locks', own: true, count: 4,
        commits: [
          { sha: SHA, date: '2026-11-04T21:00:00Z', message: 'fix the race in the lock table', files: [] },
          { sha: SHA, date: '2026-11-03T20:00:00Z', message: 'add mutex around the lock table', files: [] },
          { sha: SHA, date: '2026-11-02T17:00:00Z', message: 'wip', files: [] },
          { sha: SHA, date: '2026-11-01T18:00:00Z', message: 'acquire and release handlers', files: [] },
        ],
      }],
    },
    ...over,
  });
const FILE = (weekBrief: Record<string, unknown> | undefined) => ({ studentName: 'Ada', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.', weekBrief });

/** The tool host of a student whose repository is hw3-concurrency; `weekly_brief` answers what the test gives it. */
function course(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    canvas_query: () => ({ ok: true, text: ASSIGNMENTS }),
    github_query: (args) => ({ ok: true, text: (args as { action: string }).action === 'repo_tree' ? TREE : REPOS }),
    start_mock_interview: () => ({ ok: true, text: 'Mock interview ready for Ada — HW3 Concurrency' }),
    weekly_brief: () => ({ ok: true, text: JSON.stringify(LATER()) }),
    ...over,
  };
}

const STRONG = '{"accuracy": 5, "depth": 4, "verbal_clarity": 5, "problem_solving": 4, "missed_concepts": [], "suggested_follow_up": "Ask about RWMutex", "difficulty_adjustment": "harder", "said": "They said the lock stops two creates racing.", "better": "You could add that the check and the insert must be one critical section."}';
function evaluating(harness: Harness): void {
  harness.gw.respond = (body) => {
    const system = String((body.messages as Array<{ content: string }>)[0]?.content ?? '');
    if (system.includes('teaching evaluator')) return completion(STRONG);
    if (system.includes('You write the note')) return completion('We practised HW3.');
    return streamed('hello');
  };
}

async function startCall(harness: Harness, user: Caller, start: Record<string, unknown> = { type: 'start', mode: 'chat' }): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection; sid: string }> {
  const browser = await harness.browser(user);
  browser.send(start);
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  const ready = await browser.next('ready');
  return { browser, conn, sid: String(ready.sessionId) };
}

/** A call that starts as an interview from a link whose context file is fresh, with the brief the interview began with (or none). */
async function linkInterview(harness: Harness, user: Caller, weekBrief: Record<string, unknown> | null = START()): Promise<{ conn: FakeDeepgramConnection; sid: string; browser: BrowserClient }> {
  // (null: an interview whose file has no brief; an omitted argument is the brief the interview began with)
  fs.writeFileSync(path.join(harness.groupsDir, user.folder, 'interview_context.json'), JSON.stringify({ ...FILE(weekBrief ?? undefined), generatedAt: new Date().toISOString() }));
  const token = signInterviewToken(INTERVIEW_SECRET, user.folder, '3527597', Date.now());
  const { conn, sid, browser } = await startCall(harness, user, { type: 'start', mode: 'chat', token });
  await conn.waitFor('Settings');
  return { conn, sid, browser };
}

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function ask(conn: FakeDeepgramConnection, id: string): Promise<Record<string, any>> {
  conn.callFunction(id, 'evaluate_answer', { question_asked: 'Why is the lock taken there?', student_answer_summary: 'an answer: strong', topic: 'Concurrency' });
  return JSON.parse(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === id)).content));
}

async function lookAt(conn: FakeDeepgramConnection, id: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  conn.callFunction(id, 'look_at_week', args);
  return JSON.parse(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === id)).content));
}

const briefCalls = (harness: Harness) => harness.toolHosts.flatMap((t) => t.calls).filter((c) => c.tool === 'weekly_brief');

describe('the interviewer looks at the week again', () => {
  it('has the function in the interview\'s Settings and not in a conversation\'s', async () => {
    h = await createHarness({ toolHandlers: course() });
    const { conn } = await linkInterview(h, h.user(1));
    const names = (conn.ofType('Settings')[0] as any).agent.think.functions.map((f: any) => f.name);
    expect(names).toContain('look_at_week');
    expect(names).toHaveLength(9);
    const chat = await startCall(h, h.user(2));
    const chatNames = ((await chat.conn.waitFor('Settings')) as any).agent.think.functions.map((f: any) => f.name);
    expect(chatNames).not.toContain('look_at_week');
    expect(chatNames).toHaveLength(24);
    // and a function of the other mode is refused in this one, without a word to the container
    chat.conn.callFunction('fc-x', 'look_at_week', {});
    expect(String((await chat.conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-x')).content)).toContain('not available in this mode');
    expect(briefCalls(h)).toHaveLength(0);
  });

  it('asks the tool host for the brief of the interview\'s own assignment as json, nothing else, with the time the brief needs; and answers compactly in the host\'s words', async () => {
    h = await createHarness({ toolHandlers: course() });
    const { conn } = await linkInterview(h, h.user(1));
    const a = await lookAt(conn, 'l1');
    const calls = briefCalls(h);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ server: 'nanoclaw', tool: 'weekly_brief', args: { assignment_id: '3527597', format: 'json' }, timeoutMs: LOOK_TIMEOUT_MS });
    expect(Object.keys(calls[0].args).sort()).toEqual(['assignment_id', 'format']);
    expect(LOOK_TIMEOUT_MS).toBeGreaterThan(40_000); // the brief stops itself at 40 s
    expect(LOOK_TIMEOUT_MS).toBeLessThanOrEqual(120_000); // the tool host caps a call at 120 s

    expect(a.status).toBe('looked just now');
    expect(a.sources).toBe('Canvas: read just now. GitHub: read just now. Piazza: read just now.');
    expect(a.shows).toContain('HW3 Concurrency: submitted on Wed, Nov 4, on time, and graded');
    expect(a.shows).toContain('commits: 4 listed, the newest from Wed, Nov 4');
    expect(a.details).toContain('fix the race in the lock table');
    expect(JSON.stringify(a).length).toBeLessThan(3000);
    // text a student wrote is between the markers, and no grade, score or hash is anywhere in the answer
    const outside = String(a.details).replace(/<<<STUDENT TEXT [0-9a-f]{12}\n[\s\S]*?\nSTUDENT TEXT [0-9a-f]{12}>>>/g, '');
    expect(outside).not.toContain('fix the race');
    for (const gone of ['95', '"grade"', SHA, 'a1b2c3d4', '88']) expect(JSON.stringify(a).replace(/STUDENT TEXT [0-9a-f]{12}/g, 'STUDENT TEXT n')).not.toContain(gone);
  });

  it('is about this student and this assignment whatever the model passes: no folder, no account, no other assignment is ever sent', async () => {
    h = await createHarness({ toolHandlers: course() });
    const { conn } = await linkInterview(h, h.user(1));
    await lookAt(conn, 'l1', { student_folder: 's_someone_else', canvas_user_id: '999', github_username: 'classmate', assignment_id: '1234', format: 'text', user_id: '5' });
    expect(briefCalls(h)).toHaveLength(1);
    expect(briefCalls(h)[0].args).toEqual({ assignment_id: '3527597', format: 'json' });
    expect(JSON.stringify(briefCalls(h)[0].args)).not.toMatch(/someone_else|999|classmate|1234/);
  });

  it('leaves the assignment out when the interview has no assignment id (a topic Canvas did not know)', async () => {
    h = await createHarness({ toolHandlers: course({ canvas_query: () => ({ ok: true, text: '[]' }) }) });
    const u = h.user(1);
    const browser = await h.browser(u);
    browser.send({ type: 'start', mode: 'chat' });
    const conn = await h.dg.connection(1);
    await browser.next('ready');
    conn.userSays('the one about service discovery');
    conn.callFunction('fc-iv', 'start_interview', { topic: 'service discovery' });
    await conn.waitFor('UpdateThink');
    await browser.next('mode', (e) => e.mode === 'interviewer');
    await lookAt(conn, 'l1');
    expect(briefCalls(h)).toHaveLength(1);
    expect(briefCalls(h)[0].args).toEqual({ format: 'json' });
  });

  it('replaces what the interview holds of the week with the new view, and keeps the beats it has named: the next result of evaluate_answer is about the new week', async () => {
    h = await createHarness({ toolHandlers: course() });
    evaluating(h);
    const { conn } = await linkInterview(h, h.user(1));
    expect((await ask(conn, 'e1')).week).toContain('HW3 Concurrency: not submitted yet; commits: 3 listed, the newest from Tue, Nov 3.');
    expect((await ask(conn, 'e2')).week).toContain('Due now, if you have not asked it yet: a commit.');
    await lookAt(conn, 'l1');
    const third = await ask(conn, 'e3');
    // the facts are the new week's (graded, four commits), and the commit beat is not named again: the record of beats survived the look
    expect(third.week).toContain('HW3 Concurrency: submitted on Wed, Nov 4, on time, and graded');
    expect(third.week).toContain('commits: 4 listed, the newest from Wed, Nov 4');
    expect(third.week).not.toContain('Due now');
    expect((await ask(conn, 'e4')).week).toContain('Due now, if you have not asked it yet: their Piazza post.');
  });

  it('turns an interview that had no week at all into one that has it: later results carry the facts, and a reconnect brings the rules and the sections', async () => {
    h = await createHarness({ toolHandlers: course() });
    evaluating(h);
    const { conn } = await linkInterview(h, h.user(1), null);
    expect(await ask(conn, 'e1')).not.toHaveProperty('week');
    const a = await lookAt(conn, 'l1');
    expect(a.status).toBe('looked just now');
    expect((await ask(conn, 'e2')).week).toContain('What the sections show:');
    conn.close(1011);
    const settings: any = await (await h.dg.connection(2)).waitFor('Settings');
    expect(settings.agent.think.prompt).toContain("THE WEEK'S EVIDENCE");
    expect(settings.agent.think.prompt).toContain('## THEIR COMMITS THIS WEEK');
    expect(settings.agent.think.prompt).toContain('fix the race in the lock table');
    expect(settings.agent.think.functions.map((f: any) => f.name)).toContain('look_at_week');
  });
});

describe('when a source does not arrive, or nothing does', () => {
  it('says which source did not, keeps what the interview had of it, and still says what the others show', async () => {
    h = await createHarness({
      toolHandlers: course({ weekly_brief: () => ({ ok: true, text: JSON.stringify(LATER({ commits: null, piazza: { matched: false, matchedBy: null, reason: 'several Piazza accounts have this name', counts: {}, posts: [] }, sources: { canvas: 'ok', github: 'failed', piazza: 'ok', errors: ['github: timed out'] } })) }) }),
    });
    evaluating(h);
    const { conn } = await linkInterview(h, h.user(1));
    const a = await lookAt(conn, 'l1');
    expect(a.sources).toContain('GitHub: could not be read just now. What you already had of it is from before.');
    expect(a.sources).toContain('Piazza: their account could not be identified (several Piazza accounts have this name), which is not the same as not posting.');
    expect(a.shows).toContain('HW3 Concurrency: submitted on Wed, Nov 4, on time, and graded');
    expect(a.details).not.toContain('## THEIR COMMITS THIS WEEK');
    expect(a.instruction).toContain("A source that could not be read is not 'nothing there'.");
    // the commits the interview began with are still its commits (three of them), and Piazza is now an account it cannot see
    const next = await ask(conn, 'e1');
    expect(next.week).toContain('commits: 3 listed, the newest from Tue, Nov 3');
    expect(next.week).toContain('Piazza: you cannot see their account');
  });

  it('says it could not read, in a sentence, when the tool host is down, the tool fails, the answer is not a brief, or every source failed', async () => {
    // the tool host never started
    h = await createHarness({ toolStartError: new Error('docker is down'), toolHandlers: course() });
    const down = await linkInterview(h, h.user(1));
    expect(await lookAt(down.conn, 'l1')).toEqual({ error: LOOK_FAILED });
    expect(briefCalls(h)).toHaveLength(0);
    await h.close();

    for (const [why, answer] of [
      ['the tool failed', { ok: false, text: 'weekly_brief failed' }],
      ['it timed out', { ok: false, text: 'timeout' }],
      ['the answer is the text a text agent would get (an image that does not know "json")', { ok: true, text: 'WEEK BRIEF, built 2026-11-06T18:00:00Z; window 2026-10-30 to 2026-11-06.\nSources: canvas ok, github ok, piazza ok.' }],
      ['the answer is not JSON at all', { ok: true, text: '' }],
      ['every source failed', { ok: true, text: JSON.stringify(raw({ assignments: [], week: null, commits: null, piazza: null, sources: { canvas: 'failed', github: 'failed', piazza: 'failed', errors: ['canvas: timed out'] } })) }],
    ] as Array<[string, ToolResult]>) {
      h = await createHarness({ toolHandlers: course({ weekly_brief: () => answer }) });
      const { conn } = await linkInterview(h, h.user(1));
      expect(await lookAt(conn, 'l1'), why).toEqual({ error: LOOK_FAILED });
      expect(briefCalls(h), why).toHaveLength(1);
      await h.close();
      h = null;
    }
  });

  it('asks nobody for a student whose Canvas and GitHub are both unlinked, and says so', async () => {
    h = await createHarness({ toolHandlers: course() });
    const u = { ...h.user(1), githubUsername: undefined, canvasUserId: undefined };
    const { conn } = await linkInterview(h, u);
    expect(await lookAt(conn, 'l1')).toEqual({ error: LOOK_NOT_LINKED });
    expect(LOOK_NOT_LINKED).toMatch(/not linked to TAi/);
    expect(briefCalls(h)).toHaveLength(0);
    // with one of them linked it asks, and the container says what it skipped
    const one = h.user(2);
    const linked = await linkInterview(h, { ...one, canvasUserId: undefined });
    expect((await lookAt(linked.conn, 'l2')).status).toBe('looked just now');
    expect(briefCalls(h)).toHaveLength(1);
  });
});

describe('how often a call may look', () => {
  it('looks three times, counts a look that failed too, and then answers from the view it has, with no more calls to the container', async () => {
    let n = 0;
    h = await createHarness({ toolHandlers: course({ weekly_brief: () => (++n === 2 ? { ok: false, text: 'weekly_brief failed' } : { ok: true, text: JSON.stringify(LATER()) }) }) });
    const { conn } = await linkInterview(h, h.user(1));
    expect((await lookAt(conn, 'l1')).status).toBe('looked just now');
    expect(await lookAt(conn, 'l2')).toEqual({ error: LOOK_FAILED });
    expect((await lookAt(conn, 'l3')).status).toBe('looked just now');
    expect(briefCalls(h)).toHaveLength(LOOK_MAX);
    const fourth = await lookAt(conn, 'l4');
    expect(briefCalls(h)).toHaveLength(LOOK_MAX); // none was sent
    expect(fourth.status).toBe('not looked again');
    expect(fourth.note).toContain(`already looked ${LOOK_MAX} times in this call`);
    expect(fourth).not.toHaveProperty('sources');
    expect(fourth.shows).toContain('commits: 4 listed'); // the view of the last look that worked
    expect(fourth.details).toContain('## THEIR COMMITS THIS WEEK');
    expect(Object.keys(await lookAt(conn, 'l5'))).toEqual(Object.keys(fourth));
    expect(briefCalls(h)).toHaveLength(LOOK_MAX);
  });

  it('answers the same when the container says the call has had its looks (a count that ran ahead of this one), and counts no more after it', async () => {
    h = await createHarness({ toolHandlers: course({ weekly_brief: () => ({ ok: false, text: 'Rate limit exceeded for weekly_brief: max 3 calls per voice call.' }) }) });
    const { conn } = await linkInterview(h, h.user(1));
    const a = await lookAt(conn, 'l1');
    expect(a.status).toBe('not looked again');
    expect(a.details).toContain('## THEIR COMMITS THIS WEEK'); // the view the interview began with
    expect(briefCalls(h)).toHaveLength(1);
    // the call has had its looks, whatever this side had counted: the next one is not sent at all
    const again = await lookAt(conn, 'l2');
    expect(again.status).toBe('not looked again');
    expect(briefCalls(h)).toHaveLength(1);
  });

  it('says there is nothing to show when the last look is used up and there never was a view', async () => {
    h = await createHarness({ toolHandlers: course({ weekly_brief: () => ({ ok: false, text: 'boom' }) }) });
    const { conn } = await linkInterview(h, h.user(1), null);
    for (let i = 0; i < LOOK_MAX; i++) expect(await lookAt(conn, `l${i}`)).toEqual({ error: LOOK_FAILED });
    const last = await lookAt(conn, 'l9');
    expect(last.error).toMatch(/looked as often as you may in this call and have nothing from before to show/);
    expect(briefCalls(h)).toHaveLength(LOOK_MAX);
  });
});

describe('a look that takes a moment', () => {
  it('is met with the pre-written line of a look-up that runs a while, once, and the answer follows', async () => {
    h = await createHarness({ timing: { fillerAfterMs: 60, stillLookingMs: 5_000 }, toolHandlers: course({ weekly_brief: async () => { await new Promise((r) => setTimeout(r, 350)); return { ok: true, text: JSON.stringify(LATER()) }; } }) });
    const { conn, sid } = await linkInterview(h, h.user(1));
    await until(() => h!.toolHosts[0].alive);
    await new Promise((r) => setTimeout(r, 100));
    const before = conn.ofType('InjectAgentMessage').length;
    conn.userSays('can you go take a look at Canvas?');
    conn.callFunction('l1', 'look_at_week', {});
    await until(() => conn.ofType('InjectAgentMessage').length > before);
    expect(conn.ofType('InjectAgentMessage')[before]).toMatchObject({ message: fillerLine('slow', sid, 0), behavior: 'queue' });
    const answer = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'l1');
    expect(JSON.parse(String(answer.content)).status).toBe('looked just now');
    expect(conn.ofType('InjectAgentMessage').length).toBe(before + 1);
  });

  it('says "one sec" once while the tool host is still starting, as the other look-ups do, and then looks', async () => {
    h = await createHarness({ toolStartDelayMs: 300, toolHandlers: course() });
    const { conn, sid } = await linkInterview(h, h.user(1));
    conn.userSays('can you check GitHub?');
    conn.callFunction('l1', 'look_at_week', {});
    const filler = await conn.waitFor('InjectAgentMessage');
    expect(filler).toMatchObject({ message: fillerLine('tool_wait', sid, 0), behavior: 'queue' });
    const answer = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'l1');
    expect(JSON.parse(String(answer.content)).status).toBe('looked just now');
  });

  it('is let go of when the call ends while it runs: the late answer is for nobody, and nothing throws or is logged as a failure', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h = await createHarness({ toolHandlers: course({ weekly_brief: async () => { await gate; return { ok: true, text: JSON.stringify(LATER()) }; } }) });
    const { conn, browser } = await linkInterview(h, h.user(1));
    conn.callFunction('l1', 'look_at_week', {});
    await until(() => briefCalls(h!).length === 1);
    browser.send({ type: 'end' }); // the student hangs up while the container is reading three sources
    await browser.next('closed');
    release();
    await new Promise((r) => setTimeout(r, 200));
    expect(conn.ofType('FunctionCallResponse').some((m) => m.id === 'l1')).toBe(false);
    expect(h.logs.filter((l) => l.level === 'error' || (l.level === 'warn' && /function failed/.test(l.msg)))).toEqual([]);
  });
});

/** The brief start_mock_interview leaves in the file when it finishes: older than any look made while it ran, with a commit, a status and a post of its own to tell it by. */
const FILE_BRIEF = () =>
  raw({
    assignments: [{ id: '3527597', name: 'HW3 Concurrency', primary: true, dueAt: '2026-11-09T17:00:00Z', status: 'not_submitted', requirements: 'Build an order service in Go.\nPost your tradeoffs on Piazza.' }],
    commits: { owner: 'ada', total: 1, repos: [{ name: 'cs6650-hw7-locks', own: true, count: 1, commits: [{ sha: SHA, date: '2026-11-01T18:00:00Z', message: 'old file commit', files: [] }] }] },
    piazza: { matched: true, matchedBy: 'email', counts: { posted: 1, followups: 0, answers: 0 }, posts: [{ id: 9, role: 'posted', type: 'note', subject: 'file post about leases', tags: ['hw3'], date: '2026-11-02T19:00:00Z', text: 'The file had this post.' }] },
  });

/**
 * An interview that starts from the chat call, so that it has no context file and start_mock_interview is what brings the week and the material, with that
 * tool held until the test lets it answer (`state.release()`): then it writes the file (with `state.brief`, or none) and finishes, as the real one does
 * after twenty seconds or more.
 */
function lateCourse(over: Record<string, Handler> = {}) {
  const state = { release: (): void => undefined, brief: null as Record<string, unknown> | null, folder: '' };
  const gate = new Promise<void>((resolve) => (state.release = resolve));
  const handlers = course({
    start_mock_interview: async () => {
      await gate;
      fs.writeFileSync(path.join(h!.groupsDir, state.folder, 'interview_context.json'), JSON.stringify({ ...FILE(state.brief ?? undefined), generatedAt: new Date().toISOString() }));
      return { ok: true, text: 'Mock interview ready for Ada — HW3 Concurrency' };
    },
    ...over,
  });
  return { handlers, state };
}

async function lateInterview(harness: Harness, user: Caller): Promise<FakeDeepgramConnection> {
  const { browser, conn } = await startCall(harness, user);
  conn.userSays('homework three, the concurrency one');
  conn.callFunction('fc-iv', 'start_interview', { topic: 'HW3 concurrency' });
  await conn.waitFor('UpdateThink');
  await browser.next('mode', (e) => e.mode === 'interviewer');
  await until(() => harness.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview')); // the long tool is running now
  return conn;
}

const lateUpdate = async (conn: FakeDeepgramConnection): Promise<string> => String((await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes("THE WEEK'S EVIDENCE"))).prompt);

describe('a look made while start_mock_interview is still running, and the file that arrives after it', () => {
  it('keeps what the look found for every source it had, fills in the sources it lacked from the file, and builds the update from that week', async () => {
    // the look reads Canvas and GitHub, and Piazza does not answer
    const { handlers, state } = lateCourse({ weekly_brief: () => ({ ok: true, text: JSON.stringify(LATER({ piazza: null, sources: { canvas: 'ok', github: 'ok', piazza: 'failed', errors: ['piazza: timed out'] } })) }) });
    h = await createHarness({ toolHandlers: handlers });
    evaluating(h);
    const u = h.user(1);
    state.folder = u.folder;
    state.brief = FILE_BRIEF();
    const conn = await lateInterview(h, u);
    expect((await lookAt(conn, 'l1')).status).toBe('looked just now');
    state.release();
    const text = await lateUpdate(conn);
    // (a) Canvas and GitHub: what the look found, not what the older file says
    expect(text).toContain('fix the race in the lock table');
    expect(text).toContain('Submitted on Wed, Nov 4, on time, and graded');
    expect(text).not.toContain('old file commit');
    expect(text).not.toContain('Not submitted yet.'); // (the week's rules say "Not submitted yet: ask what is left": it is the section's own sentence, with its full stop, that tells the status)
    // (b) Piazza, which the look did not have: the file's post
    expect(text).toContain('file post about leases');
    // the interview holds that week from then on: what a later result says is the same
    const note = String((await ask(conn, 'e1')).week);
    expect(note).toContain('HW3 Concurrency: submitted on Wed, Nov 4, on time, and graded');
    expect(note).toContain('commits: 4 listed, the newest from Wed, Nov 4');
    expect(note).toContain('Piazza: 1 post of theirs is listed');
    expect(note).not.toContain('commits: 1 listed');
    // and a reconnect is given the same week, in one prompt
    conn.close(1011);
    const settings: any = await (await h.dg.connection(2)).waitFor('Settings');
    for (const part of ['fix the race in the lock table', 'file post about leases']) expect(settings.agent.think.prompt).toContain(part);
    expect(settings.agent.think.prompt).not.toContain('old file commit');
  });

  it('does not let a file with no brief wipe what the look found: the update still carries the rules and the sections of the look', async () => {
    const { handlers, state } = lateCourse();
    h = await createHarness({ toolHandlers: handlers });
    evaluating(h);
    const u = h.user(1);
    state.folder = u.folder; // (state.brief stays null: the file has no weekBrief)
    const conn = await lateInterview(h, u);
    await lookAt(conn, 'l1');
    state.release();
    const text = await lateUpdate(conn);
    expect(text).toContain('fix the race in the lock table');
    expect(text).toContain('## THEIR COMMITS THIS WEEK');
    expect(String((await ask(conn, 'e1')).week)).toContain('commits: 4 listed, the newest from Wed, Nov 4');
  });

  it('is exactly what it was with no look: the file\'s brief is the week, its sections are in the update, and the container was not asked for a second one', async () => {
    const { handlers, state } = lateCourse();
    h = await createHarness({ toolHandlers: handlers });
    evaluating(h);
    const u = h.user(1);
    state.folder = u.folder;
    state.brief = FILE_BRIEF();
    const conn = await lateInterview(h, u);
    state.release();
    const text = await lateUpdate(conn);
    for (const part of ['old file commit', 'Not submitted yet.', 'file post about leases']) expect(text).toContain(part);
    expect(text).not.toContain('fix the race in the lock table');
    const note = String((await ask(conn, 'e1')).week);
    expect(note).toContain('HW3 Concurrency: not submitted yet');
    expect(note).toContain('commits: 1 listed');
    expect(briefCalls(h)).toHaveLength(0);
  });

  it('is what it was too after a look that found nothing: the file\'s brief is the week', async () => {
    const { handlers, state } = lateCourse({ weekly_brief: () => ({ ok: false, text: 'weekly_brief failed' }) });
    h = await createHarness({ toolHandlers: handlers });
    evaluating(h);
    const u = h.user(1);
    state.folder = u.folder;
    state.brief = FILE_BRIEF();
    const conn = await lateInterview(h, u);
    expect(await lookAt(conn, 'l1')).toEqual({ error: LOOK_FAILED });
    state.release();
    const text = await lateUpdate(conn);
    for (const part of ['old file commit', 'Not submitted yet.', 'file post about leases']) expect(text).toContain(part);
    expect(String((await ask(conn, 'e1')).week)).toContain('commits: 1 listed');
    expect(briefCalls(h)).toHaveLength(1);
  });
});
