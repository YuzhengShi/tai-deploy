import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { signInterviewToken } from './interview-token.js';
import { fillerLine } from './prompts.js';
import { completion, streamed } from './testing/fake-gateway.js';
import { BrowserClient, GATEWAY_KEY, Harness, INTERVIEW_SECRET, TEST_KEY, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { Caller } from './types.js';

const COMPETENCY = `# Student Competency Model

Last updated: 2026-10-01

## Student Profile

- Name: Yuzheng Shi
- Current week: 11

## Mastery Scores

### Week 3: Concurrency (HW3)
Concurrency vs parallelism distinction: 0.6 | 0.3 | [theoretical] | [socratic_dialogue] | 2026-09-20
Lamport clocks and event ordering: 0.2 | 0.1 | [] | [] | 2026-09-21

### Week 11: Consensus & Replication (HW10)
Raft (leader election, log replication): 0.4 | 0.2 | [theoretical] | [homework] | 2026-10-01
Paxos: 0.0 | 0.0 | [] | [] | never

## Active Misconceptions

- "a Raft leader can commit without a majority" | contradicts: Raft | status: candidate | freq: 1 | first: 2026-10-01 | last: 2026-10-01 | holding | remediation: none | effective: unknown

## Mock Interview Summary

- Most recent interview: [date, assignment, scores]

## Detail Files

| File | Read When |
`;

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function startCall(
  harness: Harness,
  start: Record<string, unknown> = { type: 'start', mode: 'chat' },
  user?: Caller,
): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection; ready: Record<string, unknown>; user: Caller }> {
  const u = user ?? harness.user(1);
  const browser = await harness.browser(u);
  browser.send(start);
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  const ready = await browser.next('ready');
  return { browser, conn, ready, user: u };
}

function settingsOf(conn: FakeDeepgramConnection): any {
  return conn.ofType('Settings')[0];
}

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe('a voice call', () => {
  it('sends Settings with the student context, the relay endpoint, mip_opt_out and the 16 functions, then says ready', async () => {
    h = await createHarness();
    const u = h.user(1);
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'COMPETENCY.md'), COMPETENCY);
    fs.writeFileSync(
      path.join(h.groupsDir, u.folder, 'memory_store.json'),
      JSON.stringify({ memories: [{ text: 'prefers analogies to real systems', category: 'student_preference', created_at: 5 }], messages: [] }),
    );
    const { conn, ready } = await startCall(h, undefined, u);

    expect(conn.headers.authorization).toBe(`Token ${TEST_KEY}`);
    const s = settingsOf(conn);
    expect(s.type).toBe('Settings');
    expect(s.mip_opt_out).toBe(true);
    expect(s.flags).toEqual({ history: true });
    expect(s.audio).toEqual({ input: { encoding: 'linear16', sample_rate: 16000 }, output: { encoding: 'linear16', sample_rate: 24000, container: 'none' } });
    expect(s.agent.language).toBeUndefined();
    expect(s.agent.listen.provider).toMatchObject({ type: 'deepgram', model: 'flux-general-en', version: 'v2', eot_threshold: 0.75, eot_timeout_ms: 5000 });
    expect(s.agent.listen.provider).not.toHaveProperty('eager_eot_threshold');
    expect(s.agent.listen.provider.keyterms).toContain('Raft');
    expect(s.agent.listen.provider.smart_format).toBeUndefined();
    expect(s.agent.think.provider).toEqual({ type: 'open_ai', model: 'gpt-oss', temperature: 0.7 });
    expect(s.agent.think.endpoint.url).toBe(`${h.publicBase}/voice-llm/v1/chat/completions`);
    expect(s.agent.think.endpoint.headers.authorization).toMatch(/^Bearer v1\.[A-Za-z0-9_-]{16,}\.\d+\.[0-9a-f]{64}$/);
    expect(s.agent.think.prompt).toContain('Yuzheng Shi');
    expect(s.agent.think.prompt).toContain('One to three short sentences per turn');
    expect(s.agent.think.prompt).toContain('chat on their screen');
    expect(s.agent.think.prompt).not.toMatch(/whatsapp|youtube|sharepoint/i);
    const names = s.agent.think.functions.map((f: any) => f.name);
    expect(names).toEqual([
      'query_knowledge', 'recall_memory', 'save_memory', 'read_competency', 'update_competency', 'query_canvas', 'query_github',
      'query_piazza', 'browse_url', 'read_file', 'render_diagram', 'send_to_chat', 'schedule_task', 'start_interview', 'start_talk_through', 'end_session',
    ]);
    for (const f of s.agent.think.functions) {
      expect(f.client_side).toBeUndefined();
      expect(f.description).toMatch(/WHEN TO CALL/);
    }
    expect(s.agent.think.functions.find((f: any) => f.name === 'send_to_chat').defer_until_eot).toBe(true);
    expect(s.agent.speak).toEqual({ provider: { type: 'deepgram', version: 'v2', model: 'flux-hannah-en', speed: 1.2 } });
    expect(s.agent.greeting).toBe("hey, what's up?"); // no name: the speech engine says names its own way
    const ctx = s.agent.context.messages;
    expect(ctx[0].function_calls[0]).toMatchObject({ id: 'ctx_competency', name: 'read_competency', client_side: true, arguments: '{}' });
    expect(ctx[0].function_calls[0].response).toContain('Raft (leader election, log replication): confidence 0.4');
    expect(ctx[1].function_calls[0]).toMatchObject({ name: 'recall_memory', client_side: true });
    expect(ctx[1].function_calls[0].response).toContain('prefers analogies');
    // the page's last lines are background in the prompt, not turns of the call (as History they made TAi open with "how can I help you with Raft today?")
    expect(ctx.slice(2)).toEqual([]);
    expect(s.agent.think.prompt).toContain('I am stuck on the Raft election timeout');

    expect(ready).toMatchObject({ type: 'ready', mode: 'conversational', voice: 'flux-hannah-en', maxSeconds: 1800, resumed: false });
    expect(typeof ready.sessionId).toBe('string');
    expect(h.preempted).toEqual([u.jid]);
    expect(h.hub.isActive(u.folder)).toBe(true);
    // the key and the relay token are never logged
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(TEST_KEY);
    expect(logged).not.toContain(s.agent.think.endpoint.headers.authorization.slice(7));
  });

  it('the token in the Settings opens the relay for this call: the gateway gets the rewritten request', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    const s = settingsOf(conn);
    h.gw.respond = () => streamed('Raft elects a leader with a majority of votes.');
    const res = await fetch(s.agent.think.endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: s.agent.think.endpoint.headers.authorization },
      body: JSON.stringify({ model: 'whatever', messages: [{ role: 'user', content: 'what is raft' }], max_tokens: 5000, stream: false, user: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toContain('Raft elects');
    expect(text).toContain('[DONE]');
    const sent = h.gw.requests[0];
    expect(sent.path).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(sent.body).toEqual({ model: 'gpt-oss', messages: [{ role: 'user', content: 'what is raft' }], stream: true, max_tokens: 1200 });
  });

  it('relays transcripts, statuses, barge-in and audio both ways; mute sends silence', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h);
    conn.agentSays("hey, what's up?", 9600);
    await browser.next('transcript', (e) => e.role === 'agent');
    await until(() => browser.audioBytes === 9600);
    expect(browser.ofType('status').map((e) => e.state)).toContain('speaking');

    conn.userSays('what is raft');
    expect(await browser.next('agent_interrupted')).toEqual({ type: 'agent_interrupted' });
    expect(await browser.next('transcript', (e) => e.role === 'user')).toEqual({ type: 'transcript', role: 'user', text: 'what is raft', mode: 'conversational' });
    conn.send({ type: 'AgentThinking', content: '' });
    await browser.next('status', (e) => e.state === 'thinking');

    for (let i = 0; i < 5; i++) browser.sendAudio(1280);
    await until(() => conn.audioBytes === 6400);
    browser.send({ type: 'mute', muted: true });
    await new Promise((r) => setTimeout(r, 50));
    const muted: Buffer[] = [];
    conn.ws.on('message', (data, isBinary) => {
      if (isBinary) muted.push(data as Buffer);
    });
    browser.sendAudio(Buffer.alloc(1280, 9));
    await until(() => muted.length === 1);
    expect(muted[0].every((b) => b === 0)).toBe(true);
    // odd-sized frames are not PCM16 and are dropped
    browser.sendAudio(1281);
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.audioBytes).toBe(6400 + 1280);
  });

  it('drops the agent audio still arriving after the student cut in, until the next turn', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h);
    conn.agentSays('a long sentence about consensus', 960);
    await until(() => browser.audioBytes === 960);
    conn.send({ type: 'UserStartedSpeaking' });
    await browser.next('agent_interrupted');
    conn.sendAudio(4800); // the rest of the interrupted sentence, still in flight
    await new Promise((r) => setTimeout(r, 80));
    expect(browser.audioBytes).toBe(960);
    expect(browser.ofType('status').at(-1)?.state).toBe('listening');
    conn.send({ type: 'ConversationText', role: 'user', content: 'wait, what about leaders?' });
    conn.agentSays('sure, leaders first', 480);
    await until(() => browser.audioBytes === 960 + 480);
  });

  it('runs a function on the tool host and answers with FunctionCallResponse', async () => {
    h = await createHarness({ toolHandlers: { canvas_query: (args) => ({ ok: true, text: `due dates for ${JSON.stringify(args)}` }) } });
    const { browser, conn } = await startCall(h);
    conn.callFunction('fc-1', 'query_canvas', { action: 'deadlines' });
    const res = await conn.waitFor('FunctionCallResponse');
    expect(res).toMatchObject({ type: 'FunctionCallResponse', id: 'fc-1', name: 'query_canvas' });
    expect(res.content).toBe('due dates for {"action":"upcoming","params":{}}');
    expect(h.toolHosts[0].calls[0]).toMatchObject({ server: 'nanoclaw', tool: 'canvas_query' });
    await browser.next('status', (e) => e.state === 'working');
  });

  it('caps a long function result at 6000 characters and never answers a cancelled call', async () => {
    h = await createHarness({
      toolHandlers: {
        piazza_query: () => ({ ok: true, text: 'x'.repeat(20_000) }),
        canvas_query: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { ok: true, text: 'late' };
        },
      },
    });
    const { conn } = await startCall(h);
    conn.callFunction('fc-big', 'query_piazza', { action: 'recent_posts' });
    const big = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-big');
    expect((big.content as string).length).toBe(6000);
    conn.callFunction('fc-cancel', 'query_canvas', { action: 'assignments' });
    conn.send({ type: 'FunctionCallCancelled', functions: [{ id: 'fc-cancel', name: 'query_canvas' }] });
    await new Promise((r) => setTimeout(r, 400));
    expect(conn.ofType('FunctionCallResponse').some((m) => m.id === 'fc-cancel')).toBe(false);
  });

  it('switches to the interviewer and back: UpdateThink with endpoint, prompt and 6 functions, mars, queued opener, results written', async () => {
    h = await createHarness({
      toolHandlers: {
        // the topic the student named is looked up in Canvas's own list, and the tool is asked for that assignment
        canvas_query: () => ({ ok: true, text: JSON.stringify([{ id: 3527597, name: 'HW3 Concurrency', due_at: '2026-11-04T17:00:00Z' }, { id: 3527598, name: 'HW6 Scalability', due_at: '2026-11-18T17:00:00Z' }]) }),
        start_mock_interview: () => ({ ok: true, text: 'Mock interview ready for Yuzheng — HW3 Concurrency\nContext: spec ✓' }),
      },
    });
    const u = h.user(1);
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'COMPETENCY.md'), COMPETENCY);
    const { browser, conn, ready } = await startCall(h, undefined, u);
    const token = settingsOf(conn).agent.think.endpoint.headers.authorization;

    // the student has not said what to practice: the model is sent to ask, and nothing is switched or said
    conn.userSays("let's do a mock interview");
    conn.callFunction('fc-ask', 'start_interview', { topic: 'service discovery' });
    const asked = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-ask');
    expect(JSON.parse(asked.content as string)).toMatchObject({ status: 'not started' });
    expect(conn.ofType('UpdateThink')).toHaveLength(0);
    expect(conn.ofType('InjectAgentMessage').some((m) => String(m.message).includes('set that up'))).toBe(false);

    // they name it: now it starts
    conn.userSays('homework three, the concurrency one');
    conn.callFunction('fc-iv', 'start_interview', { topic: 'HW3 concurrency' });
    const filler = await conn.waitFor('InjectAgentMessage');
    expect(filler).toMatchObject({ message: fillerLine('start_interview', String(ready.sessionId), 0), behavior: 'queue' });
    const ack = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-iv');
    expect(JSON.parse(ack.content as string).status).toBe('switching to interview mode');
    expect(ack.content as string).toContain('[[handoff]]');
    const think: any = await conn.waitFor('UpdateThink');
    expect(think.think.provider).toEqual({ type: 'open_ai', model: 'gpt-oss', temperature: 0.7 });
    expect(think.think.endpoint.url).toBe(`${h.publicBase}/voice-llm/v1/chat/completions`);
    expect(think.think.endpoint.headers.authorization).toMatch(/^Bearer v1\./);
    expect(think.think.endpoint.headers.authorization.split('.')[1]).toBe(token.split('.')[1]); // the same call's token
    expect(think.think.prompt).toContain('mock interview');
    expect(think.think.prompt).toContain('HW3 concurrency');
    expect(think.think.prompt).toContain('Lamport clocks and event ordering (0.2)');
    expect(think.think.functions.map((f: any) => f.name)).toEqual(['evaluate_answer', 'query_knowledge', 'read_competency', 'query_github', 'send_to_chat', 'end_interview']);
    expect(await conn.waitFor('UpdateSpeak')).toEqual({ type: 'UpdateSpeak', speak: { provider: { type: 'deepgram', version: 'v2', model: 'flux-miles-en', speed: 1.2 } } });
    // an interview is judged patiently: the student thinks aloud
    const patient: any = await conn.waitFor('UpdateListen');
    expect(patient.listen.provider).toEqual({ type: 'deepgram', version: 'v2', model: 'flux-general-en', eot_threshold: 0.88, eot_timeout_ms: 8000 });
    const opener = await conn.waitFor('InjectAgentMessage', (m) => String(m.message).startsWith('alright, interview time'));
    expect(opener).toMatchObject({ behavior: 'queue' });
    expect(String(opener.message)).toMatch(/ready\?$/); // it asks nothing about the topic, which no one has confirmed against Canvas yet
    expect(await browser.next('mode')).toEqual({ type: 'mode', mode: 'interviewer', voice: 'flux-miles-en' });
    // the assignment the tool host found is appended to the prompt when it arrives
    const material = await conn.waitFor('UpdatePrompt');
    expect(material.prompt).toContain('HW3 Concurrency');

    // a function of the other mode is refused in this one
    conn.callFunction('fc-wrong', 'query_canvas', { action: 'upcoming' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-wrong')).content).toContain('not available');

    h.gw.respond = () => completion('```json\n{"accuracy": 4, "depth": 3, "verbal_clarity": 5, "problem_solving": 4, "missed_concepts": ["happens-before"], "suggested_follow_up": "Ask about vector clocks", "difficulty_adjustment": "harder",}\n```');
    conn.callFunction('fc-eval', 'evaluate_answer', { question_asked: 'Why a mutex?', student_answer_summary: 'to protect the map', topic: 'Concurrency vs parallelism distinction' });
    const evaluation = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-eval');
    expect(JSON.parse(evaluation.content as string)).toMatchObject({ accuracy: 4, verbal_clarity: 5, difficulty_adjustment: 'harder', missed_concepts: ['happens-before'] });
    const evalReq = h.gw.requests.find((r) => r.body.stream === false)!;
    expect(evalReq.body.model).toBe('gpt-oss');
    expect(evalReq.headers.authorization).toBe(`Bearer ${GATEWAY_KEY}`);

    conn.callFunction('fc-end', 'end_interview', { topics_covered: 'Concurrency vs parallelism distinction', overall_impression: 'solid' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-end');
    const back: any = await conn.waitFor('UpdateThink', (m: any) => m.think.functions.length === 16);
    expect(back.think.endpoint.url).toBe(`${h.publicBase}/voice-llm/v1/chat/completions`);
    await conn.waitFor('UpdateSpeak', (m: any) => m.speak.provider.model === 'flux-hannah-en');
    const quick: any = await conn.waitFor('UpdateListen', (m: any) => m.listen.provider.eot_threshold === 0.75);
    expect(quick.listen.provider.eot_timeout_ms).toBe(5000);
    const returnLine = await conn.waitFor('InjectAgentMessage', (m) => String(m.message).startsWith('nice work'));
    expect(returnLine.message).toContain('clear verbal explanations');
    await browser.next('mode', (e) => e.mode === 'conversational');

    const comp = fs.readFileSync(path.join(h.groupsDir, u.folder, 'COMPETENCY.md'), 'utf-8');
    expect(comp).toMatch(/Concurrency vs parallelism distinction: 0\.6 \| 0\.3 \| \[theoretical, verbal\] \| \[socratic_dialogue, mock_interview\] \| \d{4}-\d{2}-\d{2}/);
    expect(comp).toContain('## Mock Interview Summary');
    expect(comp).toMatch(/Most recent interview: .*HW3 concurrency.*adequate|strong/);
    expect(comp).toContain('## Detail Files'); // the next section is intact
    const interviews = fs.readFileSync(path.join(h.groupsDir, u.folder, 'competency', 'interviews.md'), 'utf-8');
    expect(interviews).toContain('## Interview History (most recent first)');
    expect(interviews).toContain('verbal_clarity: 5/5');
  });

  it('says a filler once while the tool host is still starting, instead of leaving the student in silence', async () => {
    h = await createHarness({ toolStartDelayMs: 300 });
    const { conn, ready } = await startCall(h);
    conn.callFunction('fc-1', 'query_canvas', { action: 'upcoming' });
    const filler = await conn.waitFor('InjectAgentMessage');
    expect(filler).toMatchObject({ message: fillerLine('tool_wait', String(ready.sessionId), 0), behavior: 'queue' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-1');
    conn.callFunction('fc-2', 'query_canvas', { action: 'upcoming' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-2');
    expect(conn.ofType('InjectAgentMessage')).toHaveLength(1);
  });

  it('asks for the lists of the course by itself once the tool host is up, so that the first search of the slides does not wait for Canvas', async () => {
    const asked: string[] = [];
    h = await createHarness({ env: { TAI_VOICE_WARM_COURSE: '1' }, toolHandlers: { canvas_query: (args) => { asked.push(String((args as { action: string }).action)); return { ok: true, text: '[]' }; } } });
    const { conn } = await startCall(h);
    await until(() => asked.length >= 4);
    expect([...asked].sort()).toEqual(['assignments', 'files', 'modules', 'pages']);
    expect(conn.ofType('InjectAgentMessage')).toHaveLength(0);                       // and says nothing about it
    const before = asked.length;
    conn.userSays('can you see the slides?');
    conn.callFunction('fc-s', 'query_canvas', { action: 'find', query: 'slides' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-s');
    expect(asked).toHaveLength(before);                                              // the lists were in the cache: nothing asked again
  });

  describe('a look-up that takes more than a moment', () => {
    const slowTools = (ms: number) => ({ canvas_query: async () => { await new Promise((r) => setTimeout(r, ms)); return { ok: true as const, text: '[]' }; }, piazza_query: async () => { await new Promise((r) => setTimeout(r, ms)); return { ok: true as const, text: '{"posts":[]}' }; } });

    it('is met with one pre-written line once it has run a moment (the owner sat through Piazza searches of 3 to 8 seconds in silence), whichever function it is', async () => {
      h = await createHarness({ timing: { fillerAfterMs: 60, stillLookingMs: 5_000 }, toolHandlers: slowTools(350) });
      const { conn, ready } = await startCall(h);
      await new Promise((r) => setTimeout(r, 300));                                           // the tool host is up: no start-up filler in the way
      const before = conn.ofType('InjectAgentMessage').length;
      conn.userSays('do any students respond to the post?');
      conn.callFunction('fc-p', 'query_piazza', { action: 'recent_posts' });
      await until(() => conn.ofType('InjectAgentMessage').length > before);
      expect(conn.ofType('InjectAgentMessage')[before]).toMatchObject({ message: fillerLine('slow', String(ready.sessionId), 0), behavior: 'queue' });
      await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-p');
      conn.callFunction('fc-p2', 'query_piazza', { action: 'get_post', post_id: '5' });      // a second look-up in the same turn: still the one line
      await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-p2');
      expect(conn.ofType('InjectAgentMessage').length).toBe(before + 1);
    });

    it('is met with nothing when it is quicker than that', async () => {
      h = await createHarness({ timing: { fillerAfterMs: 400 }, toolHandlers: slowTools(20) });
      const { conn } = await startCall(h);
      await new Promise((r) => setTimeout(r, 300));
      const before = conn.ofType('InjectAgentMessage').length;
      conn.userSays('what is due?');
      conn.callFunction('fc-q', 'query_canvas', { action: 'upcoming' });
      await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-q');
      await new Promise((r) => setTimeout(r, 500));                                           // longer than the filler's delay: the timer was cancelled
      expect(conn.ofType('InjectAgentMessage').length).toBe(before);
    });

    it('gets a second line, not the same, when the wait goes on, and not when TAi has begun to answer', async () => {
      h = await createHarness({ timing: { fillerAfterMs: 50, stillLookingMs: 150 }, toolHandlers: slowTools(700) });
      const { conn, ready } = await startCall(h);
      const sid = String(ready.sessionId);
      await new Promise((r) => setTimeout(r, 300));
      const before = conn.ofType('InjectAgentMessage').length;
      conn.userSays('how many groups have been formed?');
      conn.callFunction('fc-g', 'query_piazza', { action: 'search', query: 'groups' });
      await until(() => conn.ofType('InjectAgentMessage').length >= before + 2);
      expect(conn.ofType('InjectAgentMessage').slice(before, before + 2).map((m) => m.message)).toEqual([fillerLine('slow', sid, 0), fillerLine('still', sid, 0)]);
      await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-g');
      // a turn in which TAi starts answering before the second line is due says no second line
      conn.userSays('and the next ones?');
      const mark = conn.ofType('InjectAgentMessage').length;
      conn.callFunction('fc-h', 'query_piazza', { action: 'search', query: 'more' });
      await until(() => conn.ofType('InjectAgentMessage').length >= mark + 1);
      conn.send({ type: 'AgentStartedSpeaking', total_latency: 0.5, tts_latency: 0.1, ttt_latency: 0.4 });      // TAi starts to answer before the second line is due
      await new Promise((r) => setTimeout(r, 400));
      expect(conn.ofType('InjectAgentMessage').length).toBe(mark + 1);
    });
  });

  it('says one filler to a student turn however many functions the model calls in it, and another one, not the same, in the next turn', async () => {
    h = await createHarness({ toolStartDelayMs: 250, toolHandlers: { canvas_query: () => ({ ok: true, text: JSON.stringify({ display_name: 'a.pdf', content: 'Raft' }) }) } });
    const { conn, ready } = await startCall(h);
    const sid = String(ready.sessionId);
    conn.userSays('what is due, and what do the slides say?');
    conn.callFunction('fc-1', 'query_canvas', { action: 'upcoming' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-1');
    conn.callFunction('fc-2', 'query_canvas', { action: 'file_content', file_id: '4455' }); // the container is up now, and reading would get its own filler
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-2');
    expect(conn.ofType('InjectAgentMessage').map((m) => m.message)).toEqual([fillerLine('tool_wait', sid, 0)]);
    conn.userSays('and the next ones?');
    conn.callFunction('fc-3', 'query_canvas', { action: 'file_content', file_id: '4455' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-3');
    expect(conn.ofType('InjectAgentMessage').map((m) => m.message)).toEqual([fillerLine('tool_wait', sid, 0), fillerLine('reading', sid, 0)]);
    // the same kind of wait, again: the next line of its list, never the one before
    await new Promise((r) => setTimeout(r, 200)); // the last filler is no longer unconfirmed (a second one would not be said over it)
    conn.userSays('and the one after that?');
    conn.callFunction('fc-4', 'query_canvas', { action: 'file_content', file_id: '4456' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-4');
    const said = conn.ofType('InjectAgentMessage').map((m) => m.message);
    expect(said).toHaveLength(3);
    expect(said[2]).toBe(fillerLine('reading', sid, 1));
    expect(said[2]).not.toBe(said[1]);
  });

  it('says a filler while a file or a page of the course is read, once the container is up', async () => {
    h = await createHarness({ toolHandlers: { canvas_query: () => ({ ok: true, text: JSON.stringify({ display_name: 'Week7_Raft_Slides.pdf', content: 'Raft elects a leader.' }) }) } });
    const { conn, ready } = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    conn.callFunction('fc-read', 'query_canvas', { action: 'file_content', file_id: '4455' });
    const filler = await conn.waitFor('InjectAgentMessage');
    expect(filler).toMatchObject({ message: fillerLine('reading', String(ready.sessionId), 0), behavior: 'queue' });
    const res = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-read');
    expect(String(res.content)).toContain('Raft elects a leader.');
  });

  it('does not tell the page "listening" while a look-up still runs or its answer has yet to begin', async () => {
    h = await createHarness({ toolStartDelayMs: 400 });
    const { conn, browser } = await startCall(h);
    conn.userSays('when is the next homework due?');
    conn.callFunction('fc-1', 'query_canvas', { action: 'upcoming' });
    await conn.waitFor('InjectAgentMessage');
    conn.agentSays('one sec.', 4800, false); // the filler is heard in full while the tool host is still starting (the live protocol sends no AgentStartedSpeaking)
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-1');
    await until(() => browser.ofType('status').at(-1)?.state === 'thinking');
    const before = browser.ofType('status').length;
    conn.agentSays('it is due on Friday.', 4800, false); // the answer
    await until(() => browser.ofType('status').length >= before + 2);
    const seq = browser.ofType('status').map((e) => e.state);
    // from the look-up to its answer: working, the filler, working again (not listening), thinking, the answer, listening
    expect(seq.slice(seq.indexOf('working'))).toEqual(['working', 'speaking', 'working', 'thinking', 'speaking', 'listening']);
  });

  it('logs Deepgram\'s report of each turn and sums the turns up when the call ends', async () => {
    h = await createHarness();
    const { conn, browser } = await startCall(h);
    // Deepgram sends a report for each interim transcript with one number in it: those are parts, and only the one with the total closes a turn
    conn.send({ type: 'LatencyReport', stt_latency: 0.5 });
    conn.send({ type: 'LatencyReport', stt_latency: 0.12, ttt_text_latency: 0.31 });
    conn.send({ type: 'LatencyReport', tts_latency: 0.2, total_latency: 0.64 });
    conn.send({ type: 'LatencyReport', stt_latency: 0.4 });
    conn.send({ type: 'LatencyReport', total_latency: 0.9 });
    conn.send({ type: 'LatencyReport', total_latency: 2.5, ttt_tool_latency: 1.1 });
    await until(() => h!.logs.filter((l) => l.msg.startsWith('voice turn latency')).length === 3);
    const rows = h.logs.filter((l) => l.msg.startsWith('voice turn latency')).map((l) => l.obj as Record<string, unknown>);
    expect(rows[0]).toMatchObject({ stt: 120, ttt: 310, tts: 200, total: 640 });
    expect(rows[1]).toMatchObject({ stt: 400, total: 900 });
    expect(rows[1].ttt).toBeUndefined(); // nothing is carried from one turn into the next
    expect(rows[2]).toMatchObject({ tool: 1100, total: 2500 });
    browser.send({ type: 'end' });
    await browser.next('closed');
    await until(() => h!.logs.some((l) => l.msg === 'voice call ended'));
    expect((h.logs.find((l) => l.msg === 'voice call ended')!.obj as Record<string, unknown>).latencyMs).toEqual({ turns: 3, p50: 900, p90: 900 });
  });

  it('asks TAi to send it when TAi says it put something in the chat and did not, and takes no notice when it did', async () => {
    h = await createHarness();
    const { conn, browser } = await startCall(h);
    conn.userSays('can you put the steps in the chat?');
    conn.agentSays('I put it in the chat.');
    const note = await conn.waitFor('InjectUserMessage');
    expect(String(note.content)).toMatch(/^\[System note/);
    expect(String(note.content)).toContain('send_to_chat was never called');
    // the note comes back as the user's line: it is not the student's and is not shown or kept
    conn.userSays(String(note.content));
    await new Promise((r) => setTimeout(r, 60));
    expect(browser.ofType('transcript').some((t) => String(t.text).startsWith('[System note'))).toBe(false);

    // when it did send it, nobody is told anything
    const before = conn.ofType('InjectUserMessage').length;
    conn.userSays('and the diagram too');
    conn.callFunction('fc-chat', 'send_to_chat', { message: 'diagram steps' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-chat');
    conn.agentSays("I've put it in the chat now.");
    await new Promise((r) => setTimeout(r, 250));
    expect(conn.ofType('InjectUserMessage')).toHaveLength(before);
    // an offer or a promise is not a claim
    conn.userSays('what else?');
    conn.agentSays("I'll put it in the chat if you want.");
    conn.agentSays('Want me to put it in the chat?');
    await new Promise((r) => setTimeout(r, 250));
    expect(conn.ofType('InjectUserMessage')).toHaveLength(before);
  });

  describe('a turn that only announces the answer', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('is followed, once the student has waited a moment, by a note asking TAi to give the answer (the owner\'s call: "Here\'s a quick rundown of the interesting ones." and then nothing)', async () => {
      h = await createHarness({ timing: { leadInWaitMs: 80 } });
      const { conn } = await startCall(h);
      conn.userSays('Can you help me find some interesting final projects?');
      conn.agentSays("Here's a quick rundown of the interesting ones.");
      const note = await conn.waitFor('InjectUserMessage');
      expect(String(note.content)).toMatch(/^\[System note/);
      expect(String(note.content)).toContain('only announced an answer');
      expect(String(note.content)).toContain('first three');
      // once to a student turn: a second announcement in the same turn is not nudged again
      conn.agentSays('Let me give you the short version.');
      await sleep(250);
      expect(conn.ofType('InjectUserMessage')).toHaveLength(1);
    });

    it('is left alone when the student speaks first, when TAi goes on to say something, and when it is a question', async () => {
      h = await createHarness({ timing: { leadInWaitMs: 80 } });
      const { conn } = await startCall(h);
      conn.userSays('what are the project ideas?');
      conn.agentSays("Here's a quick rundown.");
      conn.userSays('okay, go on');                                                      // the student speaks before the wait is over
      await sleep(250);
      conn.userSays('and the second one?');
      conn.agentSays("Here's a quick rundown.");
      conn.agentSays('The first is a chat server in Go. It needs two more members, and the poster is due in week fourteen.');
      await sleep(250);                                                                  // TAi said the answer after it: the last thing said is not a lead-in
      conn.userSays('and the third?');
      conn.agentSays('Sure. Which part do you want first?');
      await sleep(250);
      expect(conn.ofType('InjectUserMessage')).toHaveLength(0);
    });

    it('is left alone while a look-up is running', async () => {
      h = await createHarness({ timing: { leadInWaitMs: 80 }, toolHandlers: { canvas_query: async () => { await sleep(400); return { ok: true as const, text: '[]' }; } } });
      const { conn } = await startCall(h);
      await sleep(300);                                                                  // the tool host is up
      conn.userSays('what is due this week?');
      conn.agentSays("Here's what is due.");
      conn.callFunction('fc-due', 'query_canvas', { action: 'upcoming' });
      await sleep(250);                                                                  // longer than the wait, shorter than the look-up
      expect(conn.ofType('InjectUserMessage')).toHaveLength(0);
      await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-due');
    });

    it('is left alone when something went to the chat in the turn: a short line after a send closes the answer (and a second send would be worse than a wait)', async () => {
      h = await createHarness({ timing: { leadInWaitMs: 80 } });
      const { conn } = await startCall(h);
      conn.userSays('give me a few project ideas');
      conn.callFunction('fc-list', 'send_to_chat', { message: 'the MUD project; a chat server; a cache' });
      await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-list');
      conn.agentSays("Here's the summary of the three projects.");
      await sleep(250);
      expect(conn.ofType('InjectUserMessage')).toHaveLength(0);
    });

    it('is asked for at most three times in a call', async () => {
      h = await createHarness({ timing: { leadInWaitMs: 40 } });
      const { conn } = await startCall(h);
      for (let i = 0; i < 4; i++) {
        conn.userSays(`tell me about number ${i}`);
        conn.agentSays("Here's a quick rundown.");
        await sleep(200);
      }
      expect(conn.ofType('InjectUserMessage')).toHaveLength(3);
    });
  });

  it('appends a BREVITY paragraph once when the student says the answers are too long (the owner\'s long call: "No. No. Too long. Too long.")', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    conn.userSays('No. No. No. Too long. Too long.');
    const shift = await conn.waitFor('UpdatePrompt');
    expect(String(shift.prompt)).toContain('BREVITY');
    conn.userSays('still too long!');
    await new Promise((r) => setTimeout(r, 80));
    expect(conn.ofType('UpdatePrompt')).toHaveLength(1);
  });

  it('keeps a false "it is in the chat" out of the speech, and asks TAi to send it when the student had asked for it, and only then', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    const s = settingsOf(conn);
    const ask = async (said: string) => {
      const res = await fetch(s.agent.think.endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: s.agent.think.endpoint.headers.authorization },
        body: JSON.stringify({ messages: [{ role: 'user', content: said }], stream: true }),
      });
      return res.text();
    };
    h.gw.respond = () => streamed('The dates are Friday and Monday.I put them in the chat.');
    conn.userSays('what is due this week');
    const spoken = await ask('what is due this week');
    expect(spoken).toContain('The dates are Friday and Monday.');
    expect(spoken).not.toContain('I put them');
    await new Promise((r) => setTimeout(r, 120));
    expect(conn.ofType('InjectUserMessage')).toHaveLength(0); // nobody asked for the chat: the sentence being gone is all there is to do
    conn.userSays('please put the dates in the chat');
    expect(await ask('please put the dates in the chat')).not.toContain('I put them');
    const note = await conn.waitFor('InjectUserMessage');
    expect(String(note.content)).toMatch(/^\[System note/);
    expect(String(note.content)).toContain('asked for something to be put in the chat');
  });

  it('changes TAi\'s approach once when the student says twice in a row that they are lost', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    conn.userSays("I don't know anything about this course.");
    await new Promise((r) => setTimeout(r, 60));
    expect(conn.ofType('UpdatePrompt')).toHaveLength(0);
    conn.userSays('Nothing. Nothing.');
    const shift = await conn.waitFor('UpdatePrompt');
    expect(String(shift.prompt)).toContain('STRATEGY SHIFT');
    conn.userSays('I have no idea.');
    conn.userSays('Give me a hint.');
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.ofType('UpdatePrompt')).toHaveLength(1); // once per call
  });

  it('does not take one "I do not know" between real answers for being lost', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    conn.userSays("I don't know.");
    conn.userSays('Oh wait, a leader needs a majority of votes to win.');
    conn.userSays("I'm not sure.");
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.ofType('UpdatePrompt')).toHaveLength(0);
  });

  it('starts again with the Aura voice of the mode when Deepgram refuses the Flux voice', async () => {
    h = await createHarness();
    h.dg.onSettings = (s: any) =>
      s.agent.speak.provider.version === 'v2' ? { code: 'INVALID_SETTINGS', description: 'agent.speak.provider.model flux-hannah-en is not available' } : 'apply';
    const { ready } = await startCall(h);
    expect(h.dg.connections).toHaveLength(2);
    expect(settingsOf(h.dg.connections[0]).agent.speak.provider).toEqual({ type: 'deepgram', version: 'v2', model: 'flux-hannah-en', speed: 1.2 });
    expect(settingsOf(h.dg.connections[1]).agent.speak.provider).toEqual({ type: 'deepgram', model: 'aura-2-thalia-en', speed: 1.2 });
    expect(settingsOf(h.dg.connections[1]).agent.listen.provider.model).toBe('flux-general-en'); // the listen model was not at fault
    expect(ready).toMatchObject({ type: 'ready', voice: 'aura-2-thalia-en' });
  });

  it('keeps the mode switch going when Deepgram does not confirm the new turn-taking', async () => {
    h = await createHarness();
    h.dg.withheldAcks.add('ListenUpdated');
    const { browser, conn } = await startCall(h);
    conn.userSays('can we practice raft');
    conn.callFunction('fc-iv', 'start_interview', { topic: 'Raft' });
    await conn.waitFor('UpdateListen');
    expect(await browser.next('mode')).toMatchObject({ mode: 'interviewer' });
    expect(h.logs.some((l) => l.msg.includes('UpdateListen was not confirmed'))).toBe(true);
  });

  it('a switch Deepgram never confirms leaves the call in its mode and says so', async () => {
    h = await createHarness();
    h.dg.withheldAcks.add('ThinkUpdated');
    const { browser, conn } = await startCall(h);
    conn.userSays('can we practice raft');
    conn.callFunction('fc-iv', 'start_interview', { topic: 'Raft' });
    await conn.waitFor('UpdateThink');
    const said = await conn.waitFor('InjectAgentMessage', (m) => String(m.message).includes("couldn't switch"), 3000);
    expect(said.behavior).toBe('queue');
    expect(conn.ofType('UpdateSpeak')).toHaveLength(0);
    expect(browser.ofType('mode')).toHaveLength(0);
  });

  it('retries a refused injection after AgentAudioDone', async () => {
    h = await createHarness();
    const { conn, user } = await startCall(h);
    h.dg.refuseInjections = 1;
    expect(h.hub.inject(user.folder, 'can you look at my server.go?')).toBe(true);
    const first = await conn.waitFor('InjectUserMessage');
    expect(first.content).toBe('[Typed in the chat during the call]\ncan you look at my server.go?');
    await new Promise((r) => setTimeout(r, 60)); // refused by now
    conn.agentSays('one sec');
    await until(() => conn.ofType('InjectUserMessage').length === 2);
    expect(conn.ofType('InjectUserMessage')[1].content).toBe(first.content);
    // the portal put the line in the chat itself: the hub does not add it again
    expect(h.chat.filter((c) => c.role === 'user')).toHaveLength(0);
  });

  it('a line typed over the socket goes into the chat once and into the call', async () => {
    h = await createHarness();
    const { browser, conn, user } = await startCall(h);
    browser.send({ type: 'text', text: 'here is my question' });
    await conn.waitFor('InjectUserMessage');
    expect(h.chat.filter((c) => c.kind !== 'speech')).toEqual([{ folder: user.folder, role: 'user', text: 'here is my question', kind: undefined }]);
    browser.send({ type: 'ping' });
    await browser.next('pong');
  });

  it('falls back from Flux to nova-3 once when the Settings are refused for the listen model', async () => {
    h = await createHarness();
    h.dg.onSettings = (s: any) =>
      String(s.agent.listen.provider.model).startsWith('flux') ? { code: 'INVALID_SETTINGS', description: 'eot_threshold is not supported for this listen model' } : 'apply';
    const { ready } = await startCall(h);
    expect(h.dg.connections).toHaveLength(2);
    expect(settingsOf(h.dg.connections[0]).agent.listen.provider.model).toBe('flux-general-en');
    expect(settingsOf(h.dg.connections[1]).agent.listen.provider).toEqual({ type: 'deepgram', model: 'nova-3', keyterms: expect.any(Array), version: 'v1' });
    expect(ready.type).toBe('ready');
  });

  it('a Deepgram that refuses everything ends the call with an error, once, and frees the slot', async () => {
    h = await createHarness();
    h.dg.onSettings = () => ({ code: 'INVALID_SETTINGS', description: 'listen provider rejected' });
    const u = h.user(1);
    const browser = await h.browser(u);
    browser.send({ type: 'start', mode: 'chat' });
    expect(await browser.next('error')).toMatchObject({ code: 'deepgram' });
    expect(await browser.next('closed')).toMatchObject({ reason: 'error' });
    expect(h.dg.connections).toHaveLength(3); // flux, then nova-3, then the Aura voice, then no more
    await browser.waitClosed();
    await until(() => !h!.hub.isActive(u.folder));
    h.dg.onSettings = () => 'apply';
    const again = await startCall(h, undefined, u);
    expect(again.ready.type).toBe('ready');
  });

  it('keeps the call for a browser that comes back within the grace period, and ends it after', async () => {
    h = await createHarness({ timing: { graceMs: 400 } });
    const { browser, conn, user } = await startCall(h);
    conn.userSays('hello');
    browser.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.hub.isActive(user.folder)).toBe(true);
    const back = await h.browser(user);
    back.send({ type: 'start', resume: true });
    expect(await back.next('ready')).toMatchObject({ resumed: true, mode: 'conversational' });
    conn.agentSays('welcome back');
    await back.next('transcript', (e) => e.text === 'welcome back');
    expect(h.dg.connections).toHaveLength(1);

    back.close();
    await until(() => !h!.hub.isActive(user.folder), 3000);
    await until(() => h!.summaries.length === 1);
    expect(conn.closed || conn.ws.readyState !== 1).toBe(true);
  });

  it('refuses a second call of the same student (busy), a resume with no call (no-session), and a full host (busy)', async () => {
    h = await createHarness({ env: { TAI_VOICE_MAX_CONCURRENT: '1' } });
    const { user } = await startCall(h);
    const second = await h.browser(user);
    second.send({ type: 'start', mode: 'chat' });
    expect(await second.next('error')).toMatchObject({ code: 'busy' });

    const other = h.user(2);
    const third = await h.browser(other);
    third.send({ type: 'start', mode: 'chat' });
    expect((await third.next('error')).message).toMatch(/busy/i);

    const fourth = await h.browser(h.user(3));
    fourth.send({ type: 'start', resume: true });
    expect(await fourth.next('error')).toMatchObject({ code: 'no-session' });
    expect(h.dg.connections).toHaveLength(1);
  });

  it('budget: a student with 30 s left is refused; one with 5 min left gets a 5 minute call', async () => {
    h = await createHarness();
    const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const a = h.user(1);
    const b = h.user(2);
    // usage is read when the hub starts: write it, then start another hub on the same store
    const storeDir = h.storeDir;
    fs.writeFileSync(path.join(storeDir, 'voice-usage.json'), JSON.stringify({ version: 1, days: { [day]: { [a.folder]: 45 * 60 - 30, [b.folder]: 40 * 60 } } }));
    const { createVoiceHub } = await import('./hub.js');
    const { FakeToolHost } = await import('./tool-host.js');
    const hub = createVoiceHub({
      groupsDir: h.groupsDir,
      dataDir: h.dataDir,
      storeDir,
      publicBase: h.publicBase,
      publicOrigin: h.origin,
      secretFile: path.join(h.root, 'portal-secret'),
      appendChat: () => undefined,
      recordVoiceSummary: () => undefined,
      preemptTextAgent: () => undefined,
      spawnToolHost: () => new FakeToolHost(),
      readEnv: () => ({ DEEPGRAM_API_KEY: TEST_KEY }),
      env: { TAI_VOICE: '1', TAI_VOICE_LLM_URL: h.gw.url },
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      deepgramUrl: h.dg.url,
    })!;
    const http = await import('http');
    const server = http.createServer();
    const users: Record<string, Caller> = { [a.folder]: a, [b.folder]: b };
    server.on('upgrade', (req, socket, head) => hub.upgrade(req, socket, head, users[String(req.headers['x-test-user'])], new URLSearchParams()));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const open = (u: Caller) => BrowserClient.connect(`ws://127.0.0.1:${port}/api/voice`, { Origin: h!.origin, 'x-test-user': u.folder });
    try {
      const ca = await open(a);
      ca.send({ type: 'start', mode: 'chat' });
      expect(await ca.next('error')).toMatchObject({ code: 'budget' });
      const cb = await open(b);
      cb.send({ type: 'start', mode: 'chat' });
      expect(await cb.next('ready')).toMatchObject({ maxSeconds: 300 });
      cb.send({ type: 'end' });
      await cb.next('closed');
    } finally {
      await hub.close();
      server.close();
    }
  });

  it('refuses an upgrade from another origin', async () => {
    h = await createHarness();
    const u = h.user(1);
    await expect(h.browser(u, { Origin: 'https://evil.example' })).rejects.toMatchObject({ status: 403 });
    expect(h.dg.connections).toHaveLength(0);
  });

  it('starts an interview from a valid link of this student, and refuses another student\'s or an expired one', async () => {
    h = await createHarness();
    const u = h.user(1);
    const now = Date.now();
    const good = signInterviewToken(INTERVIEW_SECRET, u.folder, '4242', now);
    expect(h.hub.checkInterviewToken(good)).toEqual({ folder: u.folder, assignmentId: '4242' });
    const { conn, ready } = await startCall(h, { type: 'start', mode: 'chat', token: good }, u);
    expect(ready).toMatchObject({ mode: 'interviewer', voice: 'flux-miles-en' });
    const s = settingsOf(conn);
    expect(s.agent.think.functions.map((f: any) => f.name)).toEqual(['evaluate_answer', 'query_knowledge', 'read_competency', 'query_github', 'send_to_chat', 'end_interview']);
    expect(s.agent.speak.provider.model).toBe('flux-miles-en');
    expect(s.agent.listen.provider).toMatchObject({ eot_threshold: 0.88, eot_timeout_ms: 8000 });         // an interview that starts the call is judged patiently from the first word
    expect(s.agent.greeting).toBe('hey! ready for some mock interview practice?');
    // no recall_memory History item in a call that starts as an interview (the interviewer has no such function)
    expect(JSON.stringify(s.agent.context.messages)).not.toContain('recall_memory');
    await h.toolHosts[0].start();
    await until(() => h!.toolHosts[0].calls.some((c) => c.tool === 'start_mock_interview'));
    expect(h.toolHosts[0].calls.find((c) => c.tool === 'start_mock_interview')!.args).toEqual({ assignment_id: '4242' });

    const other = h.user(2);
    const theirs = signInterviewToken(INTERVIEW_SECRET, other.folder, undefined, now);
    const b1 = await h.browser(other);
    b1.send({ type: 'start', mode: 'interview', token: good }); // u's link, other's session
    expect(await b1.next('error')).toMatchObject({ code: 'bad-token' });
    const third = h.user(3);
    const b2 = await h.browser(third);
    b2.send({ type: 'start', mode: 'interview', token: signInterviewToken(INTERVIEW_SECRET, third.folder, undefined, now - 2 * 3600_000) });
    expect(await b2.next('error')).toMatchObject({ code: 'bad-token' });
    expect(h.hub.checkInterviewToken(theirs)).toEqual({ folder: other.folder });
  });

  it('puts what is said in the call into the chat as its words, a line a turn, with a marker where the call began, changed kind and ended', async () => {
    h = await createHarness();
    const { browser, conn, user } = await startCall(h);
    conn.userSays('Do you hear me?');
    conn.agentSays('Yeah, loud and clear.');
    conn.userSays('[System note, not from the student: a look-up finished]');             // the host's own note is not what the student said
    conn.userSays('   ');                                                                 // nor is nothing
    conn.userSays('[Typed in the chat during the call]\nthe line they typed');            // a typed line is in the chat already, as the line they typed
    conn.agentSays('Okay, so scaling out means copies. Does that make sense?');
    await until(() => h!.chat.filter((c) => c.kind === 'speech' && c.text).length >= 3);
    h.gw.respond = () => completion('We talked about scaling out.');
    browser.send({ type: 'end' });
    conn.close(1000);
    await browser.next('closed');
    const speech = h.chat.filter((c) => c.kind === 'speech');
    const calls = new Set(speech.map((c) => c.call));
    expect(calls.size).toBe(1);
    expect([...calls][0]).toMatch(/^[A-Za-z0-9_-]{4,40}$/);
    expect(speech.map((c) => `${c.role}:${c.event ?? 'line'}:${c.text}`)).toEqual([
      'assistant:start:',
      'user:line:Do you hear me?',
      'assistant:line:Yeah, loud and clear.',
      'assistant:line:Okay, so scaling out means copies. Does that make sense?',
      expect.stringMatching(/^assistant:end:$/),
    ]);
    expect(speech[0]).toMatchObject({ folder: user.folder, mode: 'conversational' });
    expect(speech[4].seconds).toBeGreaterThanOrEqual(0);
    expect(h.chat.filter((c) => c.kind !== 'speech' && c.kind !== 'activity')).toHaveLength(0);   // nothing else went to the chat
  });

  it('does not let a chat that cannot take a line end the call', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h);
    const chat = h.chat.push.bind(h.chat);
    h.chat.push = () => {
      throw new Error('disk full');
    };
    conn.userSays('still there?');
    conn.agentSays('Yes.');
    await new Promise((r) => setTimeout(r, 100));
    expect(browser.ofType('transcript').length).toBeGreaterThanOrEqual(2);                  // the call goes on and the page still hears
    h.chat.push = chat;
    browser.send({ type: 'end' });
    conn.close(1000);
    expect((await browser.next('closed')).reason).toBe('user');
  });

  it('ends once however many ways it is ended, and leaves its summary in the chat, the files and the text agent\'s messages', async () => {
    h = await createHarness();
    const u = h.user(1);
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'COMPETENCY.md'), COMPETENCY);
    const { browser, conn } = await startCall(h, undefined, u);
    conn.userSays('raft elects a leader when the election timer fires');
    conn.agentSays('right, and what does a candidate need to win?');
    conn.callFunction('fc-c', 'update_competency', { concept: 'Raft leader election', confidence_delta: 0.15, notes: 'explained timeouts' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-c');
    h.gw.respond = () => completion('We talked through Raft leader election and you explained election timeouts well. Next, practise log replication.');
    browser.send({ type: 'end' });
    conn.close(1000);
    browser.send({ type: 'end' });
    const closed = await browser.next('closed');
    expect(closed.reason).toBe('user');
    expect(closed.summary).toContain('Voice session, 1 min.');
    expect(closed.summary).toContain('Raft (leader election, log replication) 0.4 → 0.55');
    await until(() => h!.summaries.length >= 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(browser.ofType('closed')).toHaveLength(1);
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].jid).toBe(u.jid);
    expect(h.summaries[0].text).toMatch(/^\[Voice session, 1 min\] We talked through Raft/);
    // the chat gets a compact activity, not the long summary: a title, the first sentence, and the rest for the card to open, in words
    expect(h.chat.filter((c) => c.kind === 'voice')).toHaveLength(0);
    const calls = h.chat.filter((c) => c.kind === 'activity');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ role: 'assistant', type: 'voice', title: 'Voice call · 1 min' });
    expect(calls[0].text).toMatch(/^We talked through Raft/);
    expect(calls[0].text.split('\n')).toHaveLength(1);
    expect(calls[0].detail).toContain('We talked through Raft');
    expect(calls[0].detail).toContain('Where you stand now: Raft (leader election, log replication): a little stronger.');
    expect(calls[0].detail).not.toContain('0.55');                       // the page shows no scores
    const sessions = fs.readFileSync(path.join(h.groupsDir, u.folder, 'competency', 'voice-sessions.md'), 'utf-8');
    expect(sessions).toContain('- Student: raft elects a leader when the election timer fires');
    expect(sessions).toContain('- TAi: right, and what does a candidate need to win?');
    expect(h.toolHosts[0].closed).toBe(true);
    expect(h.hub.isActive(u.folder)).toBe(false);
    const usage = JSON.parse(fs.readFileSync(path.join(h.storeDir, 'voice-usage.json'), 'utf-8'));
    expect(Object.values(usage.days)[0]).toHaveProperty(u.folder);
  });

  it('end_session waits for the goodbye, then closes with reason agent', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h);
    conn.userSays('thanks, bye');
    conn.callFunction('fc-bye', 'end_session', { summary_note: 'talked about Raft' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-bye');
    conn.agentSays('bye, talk soon!');
    expect(await browser.next('closed')).toMatchObject({ reason: 'agent' });
    await until(() => h!.chat.some((c) => c.kind === 'activity'));
  });

  it('sends KeepAlive and the timer, and ends a call with no speech from the student (timeout)', async () => {
    const clock = { now: Date.now() };
    h = await createHarness({ env: { TAI_VOICE_SILENCE_SEC: '30' }, timing: { silenceNudgeBeforeMs: 10_000 }, now: () => clock.now });
    const { browser, conn } = await startCall(h);
    await conn.waitFor('KeepAlive', undefined, 2000);
    clock.now += 6_000;
    expect(await browser.next('timer')).toMatchObject({ remainingSec: expect.any(Number), elapsedSec: expect.any(Number) });
    clock.now += 15_000; // 21 s of silence: the nudge
    await browser.next('notice', (e) => String(e.text).includes('silence'));
    await conn.waitFor('InjectAgentMessage', (m) => m.message === 'hey, are you still there?');
    clock.now += 10_000; // 31 s
    expect(await browser.next('closed')).toMatchObject({ reason: 'timeout' });
  });

  it('wraps up a minute before the session cap and closes at it', async () => {
    const clock = { now: Date.now() };
    h = await createHarness({ env: { TAI_VOICE_SESSION_MIN: '2', TAI_VOICE_SILENCE_SEC: '600' }, now: () => clock.now });
    const { browser, conn } = await startCall(h);
    clock.now += 61_000;
    const wrap = await conn.waitFor('UpdatePrompt');
    expect(wrap.prompt).toMatch(/^## WRAP UP NOW/);
    clock.now += 60_000;
    await conn.waitFor('InjectAgentMessage', (m) => String(m.message).startsWith("alright, that's our time"));
    clock.now += 1_000;
    expect(await browser.next('closed')).toMatchObject({ reason: 'timeout' });
  });

  it('ends the interview at its cap: wrap-up prompt, closing line, results, back to the conversational TA', async () => {
    const clock = { now: Date.now() };
    h = await createHarness({ env: { TAI_VOICE_INTERVIEW_MIN: '2', TAI_VOICE_SILENCE_SEC: '600' }, now: () => clock.now });
    const u = h.user(1);
    const { browser, conn } = await startCall(h, { type: 'start', mode: 'interview' }, u);
    clock.now += 61_000;
    expect((await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes('WRAP UP THE INTERVIEW'))).prompt).toBeTruthy();
    clock.now += 60_000;
    await conn.waitFor('InjectAgentMessage', (m) => String(m.message).includes("that's time for the interview"));
    await conn.waitFor('UpdateThink', (m: any) => m.think.functions.length === 16);
    await browser.next('mode', (e) => e.mode === 'conversational');
    await until(() => fs.existsSync(path.join(h!.groupsDir, u.folder, 'competency', 'interviews.md')));
  });

  it('works without a tool host: functions say so, and messages to the chat go through the IPC directory', async () => {
    h = await createHarness({ toolStartError: new Error('no docker') });
    const { conn, user } = await startCall(h);
    conn.callFunction('fc-k', 'query_knowledge', { question: 'what is raft' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-k')).content).toContain('not available right now');
    conn.callFunction('fc-s', 'send_to_chat', { message: '```go\nmu.Lock()\n```' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-s')).content).toBe('It is in the chat now.');
    const dir = path.join(h.dataDir, 'ipc', user.folder, 'messages');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf-8'))).toMatchObject({ type: 'message', chatJid: user.jid, text: '```go\nmu.Lock()\n```', groupFolder: user.folder });
  });

  it('reconnects once to Deepgram with the conversation so far when Deepgram drops a live call', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h);
    conn.userSays('tell me about paxos');
    conn.agentSays('sure, what do you know about proposers?');
    await browser.next('transcript', (e) => e.role === 'agent');
    conn.close(1011);
    const second = await h.dg.connection(2);
    const s = await second.waitFor('Settings');
    expect((s as any).agent.greeting).toMatch(/lost you/);
    const history = (s as any).agent.context.messages;
    expect(history).toContainEqual({ type: 'History', role: 'user', content: 'tell me about paxos' });
    expect(history).toContainEqual({ type: 'History', role: 'assistant', content: 'sure, what do you know about proposers?' });
    await browser.next('notice', (e) => e.text === 'Reconnected.');
    expect(browser.ofType('closed')).toHaveLength(0);
  });

  it('lets a second window take the call over (the first is told), and has nothing to inject into when no call is on', async () => {
    h = await createHarness();
    expect(h.hub.isActive(h.user(1).folder)).toBe(false);
    expect(h.hub.inject(h.user(1).folder, 'hello')).toBe(false);
    const { browser, conn, user } = await startCall(h);
    const second = await h.browser(user);
    second.send({ type: 'start', resume: true });
    expect(await second.next('ready')).toMatchObject({ resumed: true });
    expect(await browser.next('error')).toMatchObject({ code: 'replaced' });
    await browser.waitClosed();
    conn.agentSays('still here', 960);
    await until(() => second.audioBytes === 960);
    expect(browser.audioBytes).toBe(0);
    expect(h.hub.isActive(user.folder)).toBe(true);
  });

  it('close() ends the calls, tells the browser, and waits for their notes', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h);
    conn.userSays('one question');
    await browser.next('transcript', (e) => e.role === 'user');
    await h.hub.close();
    expect(await browser.next('error')).toMatchObject({ code: 'shutdown' });
    expect(await browser.next('closed')).toMatchObject({ reason: 'error' });
    expect(h.summaries).toHaveLength(1);
    expect(h.chat.filter((c) => c.kind === 'activity')).toHaveLength(1);
  });

  it('uses Deepgram\'s managed model without an endpoint when TAI_VOICE_THINK=deepgram', async () => {
    h = await createHarness({ env: { TAI_VOICE_THINK: 'deepgram' } });
    const { conn } = await startCall(h);
    const s = settingsOf(conn);
    expect(s.agent.think.provider).toEqual({ type: 'open_ai', model: 'gpt-4o-mini', temperature: 0.7 });
    expect(s.agent.think.endpoint).toBeUndefined();
    expect(s.mip_opt_out).toBe(true);
    expect(s.agent.think.prompt.length).toBeLessThanOrEqual(24_000);
  });
});

describe('createVoiceHub', () => {
  it('is null when voice is off, when there is no Deepgram key, or when the public address does not fit', async () => {
    const { createVoiceHub } = await import('./hub.js');
    const base = {
      groupsDir: '.',
      dataDir: '.',
      storeDir: '.',
      publicBase: 'https://tai.example/tai',
      secretFile: 'nope',
      appendChat: () => undefined,
      recordVoiceSummary: () => undefined,
      preemptTextAgent: () => undefined,
      spawnToolHost: () => {
        throw new Error('not here');
      },
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    expect(createVoiceHub({ ...base, readEnv: () => ({ DEEPGRAM_API_KEY: 'k' }), env: {} })).toBeNull();
    expect(createVoiceHub({ ...base, readEnv: () => ({}), env: { TAI_VOICE: '1' } })).toBeNull();
    expect(createVoiceHub({ ...base, publicOrigin: 'https://other.example', readEnv: () => ({ DEEPGRAM_API_KEY: 'k' }), env: { TAI_VOICE: '1' } })).toBeNull();
    // no readable secret file: off as well
    expect(createVoiceHub({ ...base, readEnv: () => ({ DEEPGRAM_API_KEY: 'k' }), env: { TAI_VOICE: '1' } })).toBeNull();
  });
});
