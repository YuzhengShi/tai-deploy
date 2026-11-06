/**
 * The mock interview reads the student's code and leaves them something to practise from, through the whole hub with a fake Deepgram, a fake
 * gateway and a fake tool host:
 *   - the background step of the interview's start names the student's repository files in the prompt, before the long tool call;
 *   - the interviewer reads their own repository only, and puts in the chat only lines of a file it has read;
 *   - every scored answer becomes a review item, and the interview's activity line carries at most eight of them while its detail is what it was.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { signInterviewToken } from './interview-token.js';
import { completion, streamed } from './testing/fake-gateway.js';
import { BrowserClient, Harness, INTERVIEW_SECRET, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { ToolResult } from './tool-host.js';
import type { Caller } from './types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const ASSIGNMENTS = JSON.stringify([
  { id: 3527597, name: 'HW3 Concurrency', due_at: '2026-11-04T17:00:00Z' },
  { id: 3527598, name: 'HW6 Scalability', due_at: '2026-11-18T17:00:00Z' },
]);
const REPOS = JSON.stringify([
  { name: 'cs6650-notes', updated_at: '2026-11-04T00:00:00Z' },
  { name: 'hw3-concurrency', updated_at: '2026-10-20T00:00:00Z' },
]);
const TREE = JSON.stringify([
  { name: 'main.go', path: 'main.go', type: 'file', size: 400 },
  { name: 'orders.go', path: 'handlers/orders.go', type: 'file', size: 900 },
  { name: 'store.go', path: 'store/store.go', type: 'file', size: 800 },
  { name: 'x.go', path: 'vendor/x.go', type: 'file', size: 10 },
  { name: 'logo.png', path: 'logo.png', type: 'file', size: 5000 },
]);
const STORE_GO = ['package store', '', 'func (s *Store) Create(o Order) error {', '\ts.mu.Lock()', '\tdefer s.mu.Unlock()', '\tif _, ok := s.orders[o.ID]; ok {', '\t\treturn ErrDuplicate', '\t}', '\ts.orders[o.ID] = o', '\treturn nil', '}'].join('\n');

type Handler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

/** The tool host of a student whose repository is hw3-concurrency (and the Canvas that knows HW3 and HW6). */
function course(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    canvas_query: () => ({ ok: true, text: ASSIGNMENTS }),
    github_query: (args) => {
      const { action, params } = args as { action: string; params: Record<string, string> };
      if (action === 'list_repos') return { ok: true, text: REPOS };
      if (action === 'repo_tree') return { ok: true, text: TREE };
      if (action === 'file_content') return { ok: true, text: JSON.stringify({ path: params.path, size: STORE_GO.length, content: STORE_GO }, null, 2) };
      return { ok: true, text: '[]' };
    },
    start_mock_interview: () => ({ ok: true, text: 'Mock interview ready for Yuzheng — HW3 Concurrency\nContext: spec ✓' }),
    ...over,
  };
}

const STRONG = '{"accuracy": 5, "depth": 4, "verbal_clarity": 5, "problem_solving": 4, "missed_concepts": [], "suggested_follow_up": "Ask about RWMutex", "difficulty_adjustment": "harder", "said": "They said the lock stops two creates racing.", "better": "You could add that the check and the insert must be one critical section."}';
const VAGUE = '{"accuracy": 2, "depth": 1, "verbal_clarity": 2, "problem_solving": 1, "missed_concepts": ["critical section"], "suggested_follow_up": "Ask what the lock protects", "difficulty_adjustment": "easier", "said": "They said it is for safety.", "better": "Say what the lock protects: the map, and the check-then-insert that has to be atomic."}';

/** The gateway as the evaluator and the summary see it: an answer by the word "strong", "vague" or "broken" in the interviewer's summary of it. */
function evaluating(harness: Harness): void {
  harness.gw.respond = (body) => {
    const messages = body.messages as Array<{ content: string }>;
    const system = String(messages[0]?.content ?? '');
    const user = String(messages[1]?.content ?? '');
    if (system.includes('teaching evaluator')) {
      if (user.includes('answer: strong')) return completion(STRONG);
      if (user.includes('answer: vague')) return completion(VAGUE);
      return completion('I could not say.');
    }
    if (system.includes('You write the note')) return completion('We practised HW3 and the order store.');
    return streamed('hello');
  };
}

async function startCall(harness: Harness, user: Caller, start: Record<string, unknown> = { type: 'start', mode: 'chat' }): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection }> {
  const browser = await harness.browser(user);
  browser.send(start);
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  await browser.next('ready');
  return { browser, conn };
}

/** A call in which the student has named HW3, and the model has started the interview. */
async function interviewOf(harness: Harness, user: Caller): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection }> {
  const call = await startCall(harness, user);
  call.conn.userSays('homework three, the concurrency one');
  call.conn.callFunction('fc-iv', 'start_interview', { topic: 'HW3 concurrency' });
  await call.conn.waitFor('UpdateThink');
  await call.browser.next('mode', (e) => e.mode === 'interviewer');
  return call;
}

const calls = (harness: Harness) => harness.toolHosts[0].calls.map((c) => (c.tool === 'github_query' || c.tool === 'canvas_query' ? `${c.tool}:${(c.args as { action: string }).action}` : c.tool));

describe('the interview\'s start names the student\'s code', () => {
  it('asks GitHub for the repository and its files before the long tool call, and appends the names to the prompt: the first question does not wait', async () => {
    h = await createHarness({ toolHandlers: course({ start_mock_interview: async () => { await new Promise((r) => setTimeout(r, 150)); return { ok: true, text: 'Mock interview ready for Yuzheng — HW3 Concurrency' }; } }) });
    const u = h.user(1);
    const { conn } = await interviewOf(h, u);

    const repo = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
    const text = String(repo.prompt);
    expect(text).toContain('(just arrived: use it from your next question on)');
    expect(text).toContain('Repository: hw3-concurrency');
    expect(text).toMatch(/- main\.go\n- handlers\/orders\.go\n- store\/store\.go/);
    expect(text).not.toContain('vendor/x.go');
    expect(text).not.toContain('logo.png');
    expect(text).toMatch(/you have not read any of them/);
    expect(text).not.toContain('package'); // names only: nothing of the code is in it

    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h)).toEqual(['canvas_query:assignments', 'github_query:list_repos', 'github_query:repo_tree', 'start_mock_interview']);
    // as the student's own account, from the allowlist: the model named nobody
    const github = h.toolHosts[0].calls.filter((c) => c.tool === 'github_query').map((c) => c.args);
    expect(github).toEqual([
      { action: 'list_repos', params: { user: u.githubUsername } },
      { action: 'repo_tree', params: { owner: u.githubUsername, repo: 'hw3-concurrency', recursive: 'true' } },
    ]);
  });

  it('puts the interviewer\'s whole kit in the switch: the walkthrough protocol and six functions, none of them able to name another account', async () => {
    h = await createHarness({ toolHandlers: course() });
    const { conn } = await interviewOf(h, h.user(1));
    const think: any = conn.ofType('UpdateThink')[0];
    expect(think.think.prompt).toContain('## CODE WALKTHROUGH');
    expect(think.think.functions.map((f: any) => f.name)).toEqual(['evaluate_answer', 'query_knowledge', 'read_competency', 'query_github', 'send_to_chat', 'end_interview']);
    const github = think.think.functions.find((f: any) => f.name === 'query_github');
    expect(github.parameters.properties).not.toHaveProperty('owner');
  });

  it('keeps the repository in the prompt when Deepgram drops the call and its Settings are sent again: what was only appended is not lost', async () => {
    h = await createHarness({ toolHandlers: course() });
    const { browser, conn } = await interviewOf(h, h.user(1));
    await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
    conn.close(1011);
    const settings: any = await (await h.dg.connection(2)).waitFor('Settings');
    expect(settings.agent.think.prompt).toContain('## THEIR REPOSITORY\n\nRepository: hw3-concurrency');
    expect(settings.agent.think.prompt).toContain('- handlers/orders.go');
    expect(settings.agent.think.functions.map((f: any) => f.name)).toContain('query_github');
    await browser.next('notice', (e) => e.text === 'Reconnected.');
  });

  it('says so, once and plainly, when none of their repositories is the assignment\'s: the interview goes on with the concepts', async () => {
    h = await createHarness({ toolHandlers: course({ github_query: () => ({ ok: true, text: JSON.stringify([{ name: 'cs6650-notes' }, { name: 'dotfiles' }]) }) }) });
    const { conn } = await interviewOf(h, h.user(1));
    const repo = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
    expect(repo.prompt).toMatch(/None of their repositories is this assignment's/);
    expect(repo.prompt).toMatch(/Say so once, in one short sentence/);
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview')); // the material still comes
    expect(calls(h)).toEqual(['canvas_query:assignments', 'github_query:list_repos', 'start_mock_interview']); // and no tree was asked for
  });

  it('says the account is not linked, and asks GitHub nothing, for a student the allowlist gave no GitHub account', async () => {
    h = await createHarness({ toolHandlers: course() });
    const u = { ...h.user(1), githubUsername: undefined };
    const { conn } = await interviewOf(h, u);
    const repo = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
    expect(repo.prompt).toMatch(/GitHub account is not linked to TAi/);
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h).filter((c) => c.startsWith('github_query'))).toEqual([]);
  });

  it('says GitHub could not be reached when it could not, and never leaves the start waiting on it', async () => {
    h = await createHarness({ toolHandlers: course({ github_query: () => ({ ok: false, text: 'GitHub query failed: 502' }) }) });
    const { conn } = await interviewOf(h, h.user(1));
    const repo = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
    expect(repo.prompt).toMatch(/GitHub could not be reached just now/);
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
  });

  it('looks for the repository of an interview that started from a link too, whose fresh context file means the material is not fetched again', async () => {
    h = await createHarness({ toolHandlers: course() });
    const u = h.user(1);
    fs.writeFileSync(
      path.join(h.groupsDir, u.folder, 'interview_context.json'),
      JSON.stringify({ studentName: 'Yuzheng', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service.', generatedAt: new Date().toISOString() }),
    );
    const token = signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now());
    const { conn } = await startCall(h, u, { type: 'start', mode: 'chat', token });
    const repo = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
    expect(repo.prompt).toContain('Repository: hw3-concurrency');
    // the file was fresh: the long tool is not called, and no Canvas list was needed to name the assignment
    expect(calls(h)).toEqual(['github_query:list_repos', 'github_query:repo_tree']);
  });

  it('names the assignment from Canvas when a link has only its id, then looks for the repository by that name', async () => {
    h = await createHarness({ toolHandlers: course() });
    const u = h.user(1);
    const token = signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now()); // no context file on disk
    const { conn } = await startCall(h, u, { type: 'start', mode: 'chat', token });
    await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h)).toEqual(['canvas_query:assignments', 'github_query:list_repos', 'github_query:repo_tree', 'start_mock_interview']);
    expect(h.toolHosts[0].calls.find((c) => c.tool === 'start_mock_interview')!.args).toEqual({ assignment_id: '3527597' });
  });
});

describe('the interviewer reads the student\'s code and shows an excerpt', () => {
  it('reads a file as plain lines, puts an excerpt of it in the chat, and is refused code that is not the file\'s', async () => {
    h = await createHarness({ toolHandlers: course() });
    const u = h.user(1);
    const { conn } = await interviewOf(h, u);
    await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));

    conn.callFunction('fc-read', 'query_github', { action: 'file_content', repo: 'hw3-concurrency', path: 'store/store.go', owner: 'classmate' });
    const read = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-read');
    expect(String(read.content)).toMatch(/^File store\/store\.go \(\d+ bytes\):\npackage store/);
    expect(String(read.content)).toContain('\ts.mu.Lock()');
    expect(h.toolHosts[0].calls.filter((c) => c.tool === 'github_query').pop()!.args).toEqual({ action: 'file_content', params: { owner: u.githubUsername, repo: 'hw3-concurrency', path: 'store/store.go' } });

    const excerpt = `store/store.go\n\`\`\`go\n${STORE_GO.split('\n').slice(2, 8).join('\n')}\n\`\`\``;
    conn.callFunction('fc-send', 'send_to_chat', { message: excerpt });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-send')).content).toBe('It is in the chat now.');
    const dir = path.join(h.dataDir, 'ipc', u.folder, 'messages');
    const written = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
    expect(written).toHaveLength(1);
    expect(written[0].text).toContain('defer s.mu.Unlock()');

    conn.callFunction('fc-fix', 'send_to_chat', { message: 'store/store.go\n```go\nfunc (s *Store) Create(o Order) error {\n\ts.mu.RLock()\n\treturn nil\n}\n```' });
    expect(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-fix')).content)).toMatch(/not in a file you read in this call/);
    conn.callFunction('fc-again', 'send_to_chat', { message: excerpt });
    expect(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-again')).content)).toMatch(/is in the chat already/);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('cannot ask GitHub for anything but a repository list, a folder and a file, nor for anyone else\'s', async () => {
    h = await createHarness({ toolHandlers: course() });
    const { conn } = await interviewOf(h, h.user(1));
    conn.callFunction('fc-pr', 'query_github', { action: 'pull_requests', repo: 'hw3-concurrency' });
    expect(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-pr')).content)).toMatch(/action must be one of list_repos, repo_tree, file_content/);
    const before = h.toolHosts[0].calls.filter((c) => c.tool === 'github_query').length;
    conn.callFunction('fc-tree', 'query_github', { action: 'repo_tree', repo: 'hw3-concurrency', owner: 'someone-else' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-tree');
    const last = h.toolHosts[0].calls.filter((c) => c.tool === 'github_query').pop()!;
    expect(h.toolHosts[0].calls.filter((c) => c.tool === 'github_query').length).toBe(before + 1);
    expect((last.args as { params: Record<string, string> }).params.owner).not.toBe('someone-else');
  });
});

describe('what the student takes away from a mock interview', () => {
  const answer = (conn: FakeDeepgramConnection, id: string, which: string, question: string, topic = 'Concurrency') =>
    conn.callFunction(id, 'evaluate_answer', { question_asked: question, student_answer_summary: `an answer: ${which}`, topic });

  it('leaves the questions on the interview\'s activity line, with how each went in a word and a stronger answer, while the detail is what it always was', async () => {
    h = await createHarness({ toolHandlers: course() });
    evaluating(h);
    const u = h.user(1);
    const { browser, conn } = await interviewOf(h, u);

    answer(conn, 'e1', 'strong', 'Why is the lock held inside Create?');
    const first = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'e1');
    // the interviewer gets the evaluation it always got: the sentences for the student's review are not its to say
    const given = JSON.parse(String(first.content));
    expect(given).toMatchObject({ accuracy: 5, difficulty_adjustment: 'harder', missed_concepts: [] });
    expect(given).not.toHaveProperty('better');
    expect(given).not.toHaveProperty('said');
    answer(conn, 'e2', 'vague', 'What does the mutex protect?');
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'e2');
    answer(conn, 'e3', 'broken', 'What if two requests carry the same id?'); // the evaluator could not say: nothing was scored
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'e3');

    conn.callFunction('fc-end', 'end_interview', { topics_covered: 'Concurrency', overall_impression: 'solid' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-end');
    browser.send({ type: 'end' });
    await browser.next('closed');
    await until(() => h!.chat.some((c) => c.kind === 'activity')); // written once the call is saved

    const activity = h.chat.filter((c) => c.kind === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0].type).toBe('interview');
    expect(activity[0].items).toEqual([
      { question: 'Why is the lock held inside Create?', said: 'They said the lock stops two creates racing.', band: 'solid', better: 'You could add that the check and the insert must be one critical section.', topic: 'Concurrency' },
      { question: 'What does the mutex protect?', said: 'They said it is for safety.', band: 'just started', better: 'Say what the lock protects: the map, and the check-then-insert that has to be atomic.', topic: 'Concurrency' },
    ]);
    // the third answer had no evaluation to speak of: no item, and no "getting there" about an answer nobody weighed
    expect(JSON.stringify(activity[0].items)).not.toContain('same id');
    // words, never numbers, anywhere the student can read
    for (const item of activity[0].items as Array<Record<string, string>>) expect(item.band).toMatch(/^[a-z ]+$/);
    // and the detail is what it was: the summary and the interview's line, nothing of the items
    expect(activity[0].detail).toContain('We practised HW3 and the order store.');
    expect(activity[0].detail).toMatch(/Mock interview, HW3 Concurrency: /);
    expect(activity[0].detail).not.toContain('critical section');
    expect(activity[0].detail).not.toContain('Why is the lock held');
  });

  it('keeps eight at most, the weakest of them, in the order they were asked', async () => {
    h = await createHarness({ toolHandlers: course() });
    evaluating(h);
    const { browser, conn } = await interviewOf(h, h.user(1));
    // ten answers: the 2nd, 5th, 7th and 9th are vague, the rest strong
    for (let i = 1; i <= 10; i++) {
      answer(conn, `e${i}`, [2, 5, 7, 9].includes(i) ? 'vague' : 'strong', `Question ${i}?`);
      await conn.waitFor('FunctionCallResponse', (m) => m.id === `e${i}`);
    }
    conn.callFunction('fc-end', 'end_interview', { topics_covered: 'Concurrency', overall_impression: 'ok' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-end');
    browser.send({ type: 'end' });
    await browser.next('closed');
    await until(() => h!.chat.some((c) => c.kind === 'activity'));
    const items = h.chat.find((c) => c.kind === 'activity')!.items as Array<{ question: string; band: string }>;
    expect(items).toHaveLength(8);
    // the four vague ones (2, 5, 7, 9) are all there, with the four earliest of the strong ones (1, 3, 4, 6), in the order asked
    expect(items.map((i) => i.question)).toEqual(['Question 1?', 'Question 2?', 'Question 3?', 'Question 4?', 'Question 5?', 'Question 6?', 'Question 7?', 'Question 9?']);
    expect(items.filter((i) => i.band === 'just started')).toHaveLength(4);
  });

  it('is on an interview\'s line only: a call that was not one leaves none, and an interview in which nothing was scored leaves none', async () => {
    h = await createHarness({ toolHandlers: course() });
    evaluating(h);
    const plain = await startCall(h, h.user(1));
    plain.conn.userSays('what is Raft?');
    plain.browser.send({ type: 'end' });
    await plain.browser.next('closed');
    await until(() => h!.chat.some((c) => c.kind === 'activity'));
    expect(h.chat.find((c) => c.kind === 'activity')!.items).toBeUndefined();

    const second = await interviewOf(h, h.user(2));
    second.conn.callFunction('fc-end', 'end_interview', { topics_covered: 'x', overall_impression: 'nothing was asked' });
    await second.conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-end');
    second.browser.send({ type: 'end' });
    await second.browser.next('closed');
    await until(() => h!.chat.filter((c) => c.kind === 'activity').length === 2);
    const interview = h.chat.filter((c) => c.kind === 'activity')[1];
    expect(interview.type).toBe('interview');
    expect(interview.items).toBeUndefined();
  });
});
