/**
 * What TAi remembers of a student's work, through the whole hub with a fake Deepgram, a fake gateway and a fake tool host (docs/STUDENT_STATE.md): the conversation's and the interviewer's prompts
 * carry it, an interview starts from the repository an earlier one remembered (and forgets one that no longer exists), and what the interviewer finds or reads is remembered for the next.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { signInterviewToken } from './interview-token.js';
import { PROMPT_MAX } from './prompts.js';
import { BrowserClient, Harness, INTERVIEW_SECRET, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import { raw } from './testing/week-fixture.js';
import type { ToolResult } from './tool-host.js';
import type { Caller } from './types.js';
import type { StoredWorkFact, WorkFact } from '../work-facts.js';

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
const NOTES_ONLY = JSON.stringify([{ name: 'cs6650-notes', updated_at: '2026-11-04T00:00:00Z' }]);
const TREE = JSON.stringify([
  { name: 'main.go', path: 'main.go', type: 'file', size: 400 },
  { name: 'orders.go', path: 'handlers/orders.go', type: 'file', size: 900 },
  { name: 'store.go', path: 'store/store.go', type: 'file', size: 800 },
]);
const STORE_GO = ['package store', '', 'func (s *Store) Create(o Order) error {', '\ts.mu.Lock()', '\tdefer s.mu.Unlock()', '\treturn nil', '}'].join('\n');
/** What the container answers for a repository that does not exist (the tool's error wrapped around github_api.py's own). */
const NOT_FOUND = `GitHub query failed: ${JSON.stringify({ error: `GitHub API error: 404 ${JSON.stringify({ message: 'Not Found' })}` })}`;

type Handler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

/** The student's GitHub: `repos` is what list_repos says, `gone` are repositories that answer "does not exist", `flaky` ones that time out. */
function github(opts: { repos?: string; gone?: string[]; flaky?: string[] } = {}): Handler {
  return (args) => {
    const { action, params } = args as { action: string; params: Record<string, string> };
    if (action === 'list_repos') return { ok: true, text: opts.repos ?? REPOS };
    if (action === 'repo_tree') {
      if (opts.gone?.includes(params.repo)) return { ok: false, text: NOT_FOUND };
      if (opts.flaky?.includes(params.repo)) return { ok: false, text: 'timeout' };
      return { ok: true, text: TREE };
    }
    if (action === 'file_content') return { ok: true, text: JSON.stringify({ path: params.path, size: STORE_GO.length, content: STORE_GO }) };
    return { ok: true, text: '[]' };
  };
}

/** `onMaterial` is what the long tool leaves behind as it finishes (the real one writes the interview's context file into the student's folder). */
const course = (gh: Handler = github(), onMaterial?: () => void): Record<string, Handler> => ({
  canvas_query: () => ({ ok: true, text: ASSIGNMENTS }),
  github_query: gh,
  start_mock_interview: () => {
    onMaterial?.();
    return { ok: true, text: 'Mock interview ready for Yuzheng — HW3 Concurrency\nContext: spec ✓' };
  },
});

const BRIEF = () => raw({ assignments: [{ id: '3527597', name: 'HW3 Concurrency', primary: true, dueAt: '2026-11-09T17:00:00Z', status: 'not_submitted', requirements: 'Build an order service in Go.\nPost your tradeoffs on Piazza.' }] });
/** The interview's context file as the long tool writes it: the assignment, and (with a brief) the week's evidence. */
const contextFile = (withBrief = true) => ({ studentName: 'Ada', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.', ...(withBrief ? { weekBrief: BRIEF() } : {}), generatedAt: new Date().toISOString() });

/** The host's side of what is remembered: the rows a student has, and a record of what was kept and taken back. A kept fact replaces the row of its key, as the database does. */
function memory(initial: Array<Omit<StoredWorkFact, 'at'>> = []) {
  let clock = 1_000;
  let facts: StoredWorkFact[] = initial.map((f) => ({ ...f, at: clock-- })); // newest first
  const kept: Array<[string, WorkFact]> = [];
  const forgotten: Array<[string, string]> = [];
  return {
    kept,
    forgotten,
    keys: () => facts.map((f) => f.key),
    deps: {
      workFacts: (_folder: string) => facts,
      rememberWork: (folder: string, fact: WorkFact) => {
        kept.push([folder, fact]);
        facts = [{ ...fact, at: 5_000 + kept.length }, ...facts.filter((f) => f.key !== fact.key)];
      },
      forgetWork: (folder: string, key: string) => {
        forgotten.push([folder, key]);
        facts = facts.filter((f) => f.key !== key);
      },
    },
  };
}

const HW3_REPO = (repo: string): Omit<StoredWorkFact, 'at'> => ({ category: 'repo', key: 'repo:hw3', value: repo, text: `Their code for HW3 Concurrency is in their repository ${repo}.` });
const THREAD = { category: 'thread', key: 'thread:lock-table', text: 'Left open on Nov 5: check why release does not wake the waiters.' } as const;
const ISSUE = { category: 'issue', key: 'issue:cache-deadlock', text: 'Two goroutines lock the cache map in opposite orders and deadlock. (Nov 4)' } as const;

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
const githubCalls = (harness: Harness) => harness.toolHosts[0].calls.filter((c) => c.tool === 'github_query').map((c) => c.args as { action: string; params: Record<string, string> });
const repoBlock = (conn: FakeDeepgramConnection) => conn.waitFor('UpdatePrompt', (m) => String(m.prompt).startsWith('## THEIR REPOSITORY'));
const WORK_HEADING = '## THEIR WORK, FROM EARLIER SESSIONS';

describe('the prompts of a call carry what TAi remembers of their work', () => {
  it('has it in the conversation\'s background, and nothing of it for a student with none', async () => {
    const m = memory([HW3_REPO('hw3-concurrency'), THREAD, ISSUE]);
    h = await createHarness({ deps: m.deps });
    const { conn } = await startCall(h, h.user(1));
    const settings: any = await conn.waitFor('Settings');
    const prompt = String(settings.agent.think.prompt);
    expect(prompt).toContain('What you remember of their work, from earlier sessions (for when they bring it up, or it is plainly what they need):');
    for (const line of [HW3_REPO('hw3-concurrency').text, THREAD.text, ISSUE.text]) expect(prompt).toContain(`- ${line}`);
    expect(prompt).toContain('may be out of date: use them to ask');
    await h.close();

    const none = memory();
    h = await createHarness({ deps: none.deps });
    const second: any = await (await startCall(h, h.user(1))).conn.waitFor('Settings');
    expect(String(second.agent.think.prompt)).not.toContain('of their work');
  });

  it('has it in the interviewer\'s first prompt as a block of its own when the interview starts with its material (a link, and a context file that is fresh): quoted, the repository of ITS assignment first and no other assignment\'s', async () => {
    const m = memory([{ category: 'repo', key: 'repo:hw6', value: 'cs6650-hw6', text: 'Their code for HW6 Scalability is in their repository cs6650-hw6.' }, HW3_REPO('hw3-concurrency'), THREAD, ISSUE]);
    h = await createHarness({ toolHandlers: course(), deps: m.deps });
    const u = h.user(1);
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'interview_context.json'), JSON.stringify(contextFile()));
    const { conn } = await startCall(h, u, { type: 'start', mode: 'chat', token: signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now()) });
    const prompt = String(((await conn.waitFor('Settings')) as any).agent.think.prompt);
    const at = prompt.indexOf(WORK_HEADING);
    expect(at).toBeGreaterThan(0);
    const block = prompt.slice(at, prompt.indexOf('may be out of date', at));
    expect(block).toMatch(/Quoted data, notes TAi kept of their work:\n<<<STUDENT TEXT [0-9a-f]{12}\n> Their code for HW3 Concurrency is in their repository hw3-concurrency\.\n> Left open on Nov 5: check why release does not wake the waiters\.\n> Two goroutines lock the cache map/);
    expect(block).not.toContain('cs6650-hw6');
    expect(prompt.indexOf(WORK_HEADING)).toBeLessThan(prompt.indexOf('## BEFORE EACH QUESTION')); // the week's check is still the last thing before the evaluation
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
  });

  it('rides on the late update of an interview that began without its material, after the material and before the week\'s check, and that update is the one there would be without it; a reconnect then has it once', async () => {
    const run = async (facts: ReturnType<typeof memory>) => {
      let folder = '';
      h = await createHarness({ toolHandlers: course(github(), () => fs.writeFileSync(path.join(h!.groupsDir, folder, 'interview_context.json'), JSON.stringify(contextFile()))), deps: facts.deps });
      const u = h.user(1);
      folder = u.folder;
      const { conn } = await interviewOf(h, u);
      const update = await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes("THE WEEK'S EVIDENCE"));
      const first = String((conn.ofType('UpdateThink')[0] as any).think.prompt);
      const held = first.length + conn.ofType('UpdatePrompt').reduce((n, e) => n + String((e as any).prompt).length, 0);
      conn.close(1011);
      const again = String(((await (await h.dg.connection(2)).waitFor('Settings')) as any).agent.think.prompt);
      await h.close();
      h = null;
      return { first, update: String(update.prompt), held, again };
    };
    const withFacts = await run(memory([HW3_REPO('hw3-concurrency'), THREAD, ISSUE]));
    const without = await run(memory());
    // the first prompt of this interview had none of its material, and none of this
    expect(withFacts.first).not.toContain(WORK_HEADING);
    // the update has it: the repository of the assignment the file names, after the material, before the check
    const at = withFacts.update.indexOf(WORK_HEADING);
    expect(at).toBeGreaterThan(withFacts.update.indexOf('## THEIR PIAZZA THIS WEEK'));
    expect(at).toBeLessThan(withFacts.update.indexOf('## BEFORE EACH QUESTION'));
    expect(withFacts.update).toContain('> Their code for HW3 Concurrency is in their repository hw3-concurrency.');
    // and without it the update is the same text (the markers' values differ from call to call)
    const strip = (t: string) => t.replace(/STUDENT TEXT [0-9a-f]{12}/g, 'STUDENT TEXT n').replace(/\n\n## THEIR WORK, FROM EARLIER SESSIONS[\s\S]*?never in place of a question this interview needs\./, '');
    expect(strip(withFacts.update)).toBe(strip(without.update));
    expect(without.update).not.toContain(WORK_HEADING);
    expect(withFacts.held).toBeLessThanOrEqual(PROMPT_MAX);
    // the interview has its material now: the Settings a reconnect sends have the block, once, inside the cap
    expect(withFacts.again.split(WORK_HEADING).length - 1).toBe(1);
    expect(withFacts.again.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(without.again).not.toContain(WORK_HEADING);
  });

  it('is left out of both when what is remembered cannot be read, and the call goes on', async () => {
    h = await createHarness({
      toolHandlers: course(),
      deps: {
        workFacts: () => {
          throw new Error('database is locked');
        },
      },
    });
    const u = h.user(1);
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'interview_context.json'), JSON.stringify(contextFile()));
    const { conn } = await startCall(h, u, { type: 'start', mode: 'chat', token: signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now()) });
    expect(String(((await conn.waitFor('Settings')) as any).agent.think.prompt)).not.toContain(WORK_HEADING);
    const repo = await repoBlock(conn);
    expect(String(repo.prompt)).toContain('Repository: hw3-concurrency'); // the matcher, as ever
    expect(h.logs.some((l) => l.level === 'warn' && /what is remembered of their work is unavailable \(database is locked\)/.test(l.msg))).toBe(true);
  });
});

describe('an interview starts from the repository that was remembered for its assignment', () => {
  it('lists it directly, with no search of their repositories, and renews it', async () => {
    const m = memory([HW3_REPO('hw3-concurrency')]);
    h = await createHarness({ toolHandlers: course(github({ repos: NOTES_ONLY })), deps: m.deps }); // (the matcher could not have found it: it is not in the list)
    const u = h.user(1);
    const { conn } = await interviewOf(h, u);
    const repo = await repoBlock(conn);
    expect(String(repo.prompt)).toContain('Repository: hw3-concurrency');
    expect(String(repo.prompt)).toMatch(/- main\.go\n- handlers\/orders\.go\n- store\/store\.go/);
    expect(String(repo.prompt)).not.toContain('out of date');
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h)).toEqual(['canvas_query:assignments', 'github_query:repo_tree', 'start_mock_interview']);
    // as the student's own account, from the allowlist, whatever a row says
    expect(githubCalls(h)).toEqual([{ action: 'repo_tree', params: { owner: u.githubUsername, repo: 'hw3-concurrency', recursive: 'true' } }]);
    // its row is renewed (kept again, with its words), and nothing is forgotten
    expect(m.kept).toEqual([[u.folder, { category: 'repo', key: 'repo:hw3', value: 'hw3-concurrency', text: HW3_REPO('hw3-concurrency').text }]]);
    expect(m.forgotten).toEqual([]);
  });

  it('forgets one that no longer exists, runs the matcher as before, says the earlier note is out of date, and remembers what the matcher found', async () => {
    const m = memory([HW3_REPO('old-name'), THREAD]);
    h = await createHarness({ toolHandlers: course(github({ gone: ['old-name'] })), deps: m.deps });
    const u = h.user(1);
    // an interview that starts with its material (a link, and a fresh file), so that its first prompt has their work
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'interview_context.json'), JSON.stringify(contextFile(false)));
    const { browser, conn } = await startCall(h, u, { type: 'start', mode: 'chat', token: signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now()) });
    // the prompt the interview began with was written before GitHub was asked: it names the old repository
    expect(String(((await conn.waitFor('Settings')) as any).agent.think.prompt)).toContain('in their repository old-name');
    const repo = await repoBlock(conn);
    expect(String(repo.prompt)).toContain('Repository: hw3-concurrency');
    expect(String(repo.prompt)).toContain('The earlier note that named the repository old-name is out of date: it no longer exists on their GitHub. Do not use it.');
    expect(calls(h)).toEqual(['github_query:repo_tree', 'github_query:list_repos', 'github_query:repo_tree']); // (the file is fresh: no Canvas, and the long tool is not called)
    expect(m.forgotten).toEqual([[u.folder, 'repo:hw3']]);
    expect(m.kept).toEqual([[u.folder, { category: 'repo', key: 'repo:hw3', value: 'hw3-concurrency', text: HW3_REPO('hw3-concurrency').text }]]);
    // the call's own copy forgot it too: the prompt a reconnect sends names the repository found, and never the one that is gone (the thread is still there)
    conn.close(1011);
    const again: any = await (await h.dg.connection(2)).waitFor('Settings');
    const prompt = String(again.agent.think.prompt);
    expect(prompt).not.toContain('old-name');
    expect(prompt).toContain('Repository: hw3-concurrency');
    expect(prompt).toContain(THREAD.text);
    await browser.next('notice', (e) => e.text === 'Reconnected.');
  });

  it('forgets one that no longer exists in an interview started from the chat too, and says nothing of an earlier note: the prompt it began with never had it', async () => {
    const m = memory([HW3_REPO('old-name'), THREAD]);
    h = await createHarness({ toolHandlers: course(github({ gone: ['old-name'] })), deps: m.deps });
    const u = h.user(1);
    const { conn } = await interviewOf(h, u);
    expect(String((conn.ofType('UpdateThink')[0] as any).think.prompt)).not.toContain('old-name');
    const repo = await repoBlock(conn);
    expect(String(repo.prompt)).toContain('Repository: hw3-concurrency');
    expect(String(repo.prompt)).not.toContain('out of date');
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h)).toEqual(['canvas_query:assignments', 'github_query:repo_tree', 'github_query:list_repos', 'github_query:repo_tree', 'start_mock_interview']);
    expect(m.forgotten).toEqual([[u.folder, 'repo:hw3']]);
    expect(m.kept.map(([, f]) => (f as { value?: string }).value)).toEqual(['hw3-concurrency']); // what the matcher found
  });

  it('keeps one that could not be asked about (a timeout): it names it with no files, forgets nothing and does not search again', async () => {
    const m = memory([HW3_REPO('hw3-concurrency')]);
    h = await createHarness({ toolHandlers: course(github({ flaky: ['hw3-concurrency'] })), deps: m.deps });
    const { conn } = await interviewOf(h, h.user(1));
    const repo = await repoBlock(conn);
    expect(String(repo.prompt)).toContain('Repository: hw3-concurrency');
    expect(String(repo.prompt)).toMatch(/Its files could not be listed just now/);
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h)).toEqual(['canvas_query:assignments', 'github_query:repo_tree', 'start_mock_interview']);
    expect(m.forgotten).toEqual([]);
  });

  it('never asks GitHub about a stored value that is no repository name (a row somebody forged), and searches as before', async () => {
    for (const forged of ['..', 'a/b', '-x', 'cs6650-hw2']) {
      const m = memory([HW3_REPO(forged)]);
      h = await createHarness({ toolHandlers: course(), deps: m.deps });
      const u = h.user(1);
      const { conn } = await interviewOf(h, u);
      await repoBlock(conn);
      await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
      expect(calls(h), forged).toEqual(['canvas_query:assignments', 'github_query:list_repos', 'github_query:repo_tree', 'start_mock_interview']);
      expect(githubCalls(h).map((c) => c.params.repo ?? c.params.user), forged).toEqual([u.githubUsername, 'hw3-concurrency']);
      expect(m.forgotten, forged).toEqual([]); // not gone: never asked about
      expect(m.keys(), forged).toEqual(['repo:hw3']); // and the find replaced the row
      await h.close();
      h = null;
    }
  });

  it('remembers the repository the matcher finds, and nothing when it finds none', async () => {
    const found = memory();
    h = await createHarness({ toolHandlers: course(), deps: found.deps });
    const u = h.user(1);
    await repoBlock((await interviewOf(h, u)).conn);
    expect(found.kept).toEqual([[u.folder, { category: 'repo', key: 'repo:hw3', value: 'hw3-concurrency', text: HW3_REPO('hw3-concurrency').text }]]);
    await h.close();

    const none = memory();
    h = await createHarness({ toolHandlers: course(github({ repos: NOTES_ONLY })), deps: none.deps });
    const repo = await repoBlock((await interviewOf(h, h.user(1))).conn);
    expect(String(repo.prompt)).toMatch(/None of their repositories is this assignment's/);
    expect(none.kept).toEqual([]);
  });

  it('starts from it for an interview that a link named by its id alone, whose name Canvas could not tell: the Canvas id is the other key it is remembered under, and with nothing remembered there is still nothing to look for', async () => {
    const down: Record<string, Handler> = { ...course(github({ repos: NOTES_ONLY })), canvas_query: () => ({ ok: false, text: 'Canvas query failed: down' }) };
    const m = memory([{ category: 'repo', key: 'repo:3527597', value: 'hw3-concurrency', text: 'Their code for this assignment is in their repository hw3-concurrency.' }]);
    h = await createHarness({ toolHandlers: down, deps: m.deps });
    const u = h.user(1);
    const token = signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now()); // no context file on disk
    const { conn } = await startCall(h, u, { type: 'start', mode: 'chat', token });
    expect(String((await repoBlock(conn)).prompt)).toContain('Repository: hw3-concurrency');
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h)).toEqual(['canvas_query:assignments', 'github_query:repo_tree', 'start_mock_interview']);
    expect(m.kept.map(([, f]) => f.key)).toEqual(['repo:3527597']); // renewed under the key it had
    await h.close();

    const none = memory();
    h = await createHarness({ toolHandlers: down, deps: none.deps });
    const second = h.user(1);
    await startCall(h, second, { type: 'start', mode: 'chat', token: signInterviewToken(INTERVIEW_SECRET, second.folder, '3527597', Date.now()) });
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(calls(h)).toEqual(['canvas_query:assignments', 'start_mock_interview']); // as it was: no name, no search of their repositories
    expect(none.kept).toEqual([]);
  });

  it('asks the matcher only, as it always did, when nothing is remembered and no account is bound', async () => {
    const m = memory();
    h = await createHarness({ toolHandlers: course(), deps: m.deps });
    const { conn } = await interviewOf(h, { ...h.user(1), githubUsername: undefined });
    expect(String((await repoBlock(conn)).prompt)).toMatch(/GitHub account is not linked to TAi/);
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(githubCalls(h)).toEqual([]);
    expect(m.kept).toEqual([]);
  });

  it('goes on when the store that remembers throws: the interview still gets its repository', async () => {
    h = await createHarness({
      toolHandlers: course(),
      deps: {
        workFacts: () => [],
        rememberWork: () => {
          throw new Error('database is locked');
        },
        forgetWork: () => {
          throw new Error('database is locked');
        },
      },
    });
    const repo = await repoBlock((await interviewOf(h, h.user(1))).conn);
    expect(String(repo.prompt)).toContain('Repository: hw3-concurrency');
    expect(h.logs.some((l) => l.level === 'warn' && l.msg === 'voice: a fact of their work could not be kept')).toBe(true);
  });
});

describe('what the interviewer reads is remembered for the next interview of the assignment', () => {
  it('keeps the repository the student named and the interviewer read, and the next interview starts from it', async () => {
    const m = memory();
    // none of their repositories matches the assignment by its name: the student says it is in "my-locks"
    h = await createHarness({ toolHandlers: course(github({ repos: NOTES_ONLY })), deps: m.deps });
    const u = h.user(1);
    const first = await interviewOf(h, u);
    await repoBlock(first.conn);
    expect(m.kept).toEqual([]);
    first.conn.callFunction('fc-read', 'query_github', { action: 'file_content', repo: 'my-locks', path: 'store/store.go' });
    expect(String((await first.conn.waitFor('FunctionCallResponse', (e) => e.id === 'fc-read')).content)).toMatch(/^File store\/store\.go/);
    expect(m.kept).toEqual([[u.folder, { category: 'repo', key: 'repo:hw3', value: 'my-locks', text: 'Their code for HW3 Concurrency is in their repository my-locks.' }]]);
    await h.close();

    // the next interview, of the same assignment: its repository is the one that was read, asked for by name
    h = await createHarness({ toolHandlers: course(github({ repos: NOTES_ONLY })), deps: m.deps });
    const second = await interviewOf(h, h.user(1));
    const repo = await repoBlock(second.conn);
    expect(String(repo.prompt)).toContain('Repository: my-locks');
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(githubCalls(h)).toEqual([{ action: 'repo_tree', params: { owner: u.githubUsername, repo: 'my-locks', recursive: 'true' } }]);
  });

  it('keeps nothing of a read in the ordinary conversation, nor of an earlier homework looked at for comparison', async () => {
    const m = memory();
    h = await createHarness({ toolHandlers: course(), deps: m.deps });
    const talk = await startCall(h, h.user(1));
    talk.conn.callFunction('fc-chat', 'query_github', { action: 'file_content', repo: 'hw3-concurrency', path: 'main.go' });
    await talk.conn.waitFor('FunctionCallResponse', (e) => e.id === 'fc-chat');
    expect(m.kept).toEqual([]);
    await h.close();

    const compare = memory();
    h = await createHarness({ toolHandlers: course(), deps: compare.deps });
    const { conn } = await interviewOf(h, h.user(1));
    await repoBlock(conn);
    compare.kept.length = 0;
    conn.callFunction('fc-old', 'query_github', { action: 'file_content', repo: 'cs6650-hw2', path: 'main.go' });
    await conn.waitFor('FunctionCallResponse', (e) => e.id === 'fc-old');
    expect(compare.kept).toEqual([]);
  });
});
