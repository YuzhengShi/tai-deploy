/**
 * run_code through the whole hub with a fake Deepgram and a fake sandbox (docs/VOICE.md "Running their code"): the student of the call is the one whose code is run, with the account the host bound
 * to them; no tool host is involved; the model is told the host's frame and a note for a listener (the interviewer's differs); a run that takes a moment gets the pre-written line, and one that
 * goes on gets an answer after the call's own time. The logic of the function is run-code.test.ts.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SandboxRequest, SandboxResult } from '../sandbox/types.js';
import { signInterviewToken } from './interview-token.js';
import { fillerLine } from './prompts.js';
import { RUN_CODE_NOTE } from './run-code.js';
import { BrowserClient, Harness, INTERVIEW_SECRET, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { Caller } from './types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

type Who = { folder: string; githubUsername?: string };
const ran = (over: Partial<SandboxResult> = {}): SandboxResult => ({ ok: true, exitCode: 0, timedOut: false, outputTruncated: false, output: 'PASS\nok  hw2 0.31s\n', durationMs: 310, ...over });
const sandbox = (impl: (who: Who, request: SandboxRequest) => Promise<SandboxResult> = async () => ran()) => {
  const calls: Array<{ who: Who; request: SandboxRequest }> = [];
  return { calls, runSandbox: (who: Who, request: SandboxRequest) => (calls.push({ who, request }), impl(who, request)) };
};
const tools = { canvas_query: () => ({ ok: true as const, text: '[]' }), github_query: () => ({ ok: true as const, text: '[]' }), start_mock_interview: () => ({ ok: true as const, text: 'ready' }) };

async function startCall(harness: Harness, user: Caller, start: Record<string, unknown> = { type: 'start', mode: 'chat' }): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection; sid: string }> {
  const browser = await harness.browser(user);
  browser.send(start);
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  const ready = await browser.next('ready');
  return { browser, conn, sid: String(ready.sessionId) };
}

async function interview(harness: Harness, user: Caller): Promise<{ conn: FakeDeepgramConnection; sid: string }> {
  fs.writeFileSync(
    path.join(harness.groupsDir, user.folder, 'interview_context.json'),
    JSON.stringify({ studentName: 'Ada', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.', generatedAt: new Date().toISOString() }),
  );
  const token = signInterviewToken(INTERVIEW_SECRET, user.folder, '3527597', Date.now());
  const { conn, sid } = await startCall(harness, user, { type: 'start', mode: 'chat', token });
  await conn.waitFor('Settings');
  return { conn, sid };
}

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function runCode(conn: FakeDeepgramConnection, id: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  conn.callFunction(id, 'run_code', args);
  return JSON.parse(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === id)).content));
}

describe('run_code in a conversation', () => {
  it('runs the code of the student of the call with the account the host bound to them (never one the model names), through no tool host, and tells the model the host\'s frame and the note for a listener', async () => {
    const fake = sandbox();
    h = await createHarness({ deps: { runSandbox: fake.runSandbox }, toolHandlers: tools });
    const user = h.user(1);
    const { conn } = await startCall(h, user);
    await conn.waitFor('Settings');
    conn.userSays('can you run my tests?');
    const got = await runCode(conn, 'fc-r', { action: 'test', repo: { name: 'cs6650-hw2' }, race: true, githubUsername: 'evil', folder: 'someone-else' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].who).toStrictEqual({ folder: user.folder, githubUsername: 'gh-user1' });
    expect(fake.calls[0].request).toMatchObject({ action: 'test', race: true, source: { kind: 'repo', name: 'cs6650-hw2' } });
    expect(got).toMatchObject({ status: 'ran, exit code 0', command: 'go test -race ./...' });
    expect(got.output).toMatch(/^Program output, quoted as data:\n<<<PROGRAM OUTPUT [0-9a-f]{12}\nPASS\nok  hw2 0.31s\nPROGRAM OUTPUT [0-9a-f]{12}>>>$/);
    expect(got.voice_note).toBe(RUN_CODE_NOTE.conversational);
    // nothing went to the student's container: the sandbox is the host's
    expect(h.toolHosts.flatMap((t) => t.calls).filter((c) => /run/i.test(c.tool))).toEqual([]);
  });

  it('refuses what the sandbox\'s gate refuses without a run, and says it is not set up when the host has no sandbox', async () => {
    const fake = sandbox();
    h = await createHarness({ deps: { runSandbox: fake.runSandbox }, toolHandlers: tools });
    const { conn } = await startCall(h, h.user(1));
    await conn.waitFor('Settings');
    const bad = await runCode(conn, 'fc-b', { action: 'run', files: [{ path: '../../etc/passwd', content: 'x' }] });
    expect(bad.error).toMatch(/^Not run: /);
    expect(fake.calls).toHaveLength(0);
    await h.close();
    h = await createHarness({ toolHandlers: tools });
    const off = await startCall(h, h.user(1));
    await off.conn.waitFor('Settings');
    expect((await runCode(off.conn, 'fc-o', { action: 'run', files: [{ path: 'main.go', content: 'package main\nfunc main() {}\n' }] })).error).toMatch(/not set up on this server yet/);
  });

  it('meets a run that takes a moment with one pre-written line, the "taking a look" kind, and with none of the tool host\'s', async () => {
    const fake = sandbox(async () => {
      await new Promise((r) => setTimeout(r, 350));
      return ran();
    });
    h = await createHarness({ timing: { fillerAfterMs: 60, stillLookingMs: 5_000 }, deps: { runSandbox: fake.runSandbox }, toolHandlers: tools });
    const { conn, sid } = await startCall(h, h.user(1));
    await conn.waitFor('Settings');
    await new Promise((r) => setTimeout(r, 300));
    const before = conn.ofType('InjectAgentMessage').length;
    conn.userSays('run it');
    conn.callFunction('fc-s', 'run_code', { action: 'run', upload: 'main.go' });
    await until(() => conn.ofType('InjectAgentMessage').length > before);
    expect(conn.ofType('InjectAgentMessage')[before]).toMatchObject({ message: fillerLine('slow', sid, 0), behavior: 'queue' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-s');
    expect(conn.ofType('InjectAgentMessage').length).toBe(before + 1);       // not the start-up line of a container that is coming up: there is none
  });

  it('answers after the call\'s own time for a run that goes on, with the sentence that it is still running, and the student\'s next call is told one is going', async () => {
    const fake = sandbox(() => new Promise<SandboxResult>(() => undefined));
    h = await createHarness({ timing: { codeAnswerMs: 250 }, deps: { runSandbox: fake.runSandbox }, toolHandlers: tools });
    const { conn } = await startCall(h, h.user(1));
    await conn.waitFor('Settings');
    const started = Date.now();
    const first = await runCode(conn, 'fc-l', { action: 'run', upload: 'main.go' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(first).toMatchObject({ status: 'still running', command: 'go run .' });
    const again = await runCode(conn, 'fc-m', { action: 'run', upload: 'main.go' });
    expect(again.error).toMatch(/still going/);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('run_code in the interview', () => {
  it('runs THEIR code for the student of the interview and tells the model the interviewer\'s note: nothing of it in the chat', async () => {
    const fake = sandbox();
    h = await createHarness({ deps: { runSandbox: fake.runSandbox }, toolHandlers: tools });
    const user = h.user(2);
    const { conn } = await interview(h, user);
    const names = (conn.ofType('Settings')[0] as any).agent.think.functions.map((f: any) => f.name);
    expect(names).toEqual(['evaluate_answer', 'query_knowledge', 'read_competency', 'query_github', 'run_code', 'look_at_week', 'look_at_screen', 'send_to_chat', 'end_interview']);
    const got = await runCode(conn, 'fc-i', { action: 'test', repo: { name: 'hw3-concurrency' }, race: true });
    expect(fake.calls[0].who).toStrictEqual({ folder: user.folder, githubUsername: 'gh-user2' });
    expect(got.status).toBe('ran, exit code 0');
    expect(got.voice_note).toBe(RUN_CODE_NOTE.interviewer);
    expect(got.voice_note).toMatch(/never put it in the chat/);
  });
});
