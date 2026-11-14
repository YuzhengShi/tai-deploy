/**
 * The talk-it-through ("listener") mode of a call: the student explains something out loud and TAi only listens, then gives its feedback.
 * Through the whole hub with a fake Deepgram, as hub.test.ts does the mock interview.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { signInterviewToken } from './interview-token.js';
import { lines } from './prompts.js';
import { completion, streamed } from './testing/fake-gateway.js';
import { BrowserClient, Harness, INTERVIEW_SECRET, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { Caller } from './types.js';

const COMPETENCY = `# Student Competency Model

Last updated: 2026-10-01

## Student Profile

- Name: Yuzheng Shi
- Current week: 11

## Mastery Scores

### Week 11: Consensus & Replication (HW10)
Raft (leader election, log replication): 0.4 | 0.2 | [theoretical] | [homework] | 2026-10-01
Paxos: 0.0 | 0.0 | [] | [] | never

## Active Misconceptions

## Mock Interview Summary

- Most recent interview: [date, assignment, scores]

## Detail Files

| File | Read When |
`;

/** What a student says who has explained the whole idea: more than the 45 words after which TAi's turns may be its feedback. */
const EXPLANATION =
  'so a follower waits for a heartbeat from the leader and if it hears nothing for a random time it becomes a candidate and bumps its term and asks everybody else for their vote and whoever gets a majority of the votes becomes the new leader and starts sending heartbeats again';

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

const settingsOf = (conn: FakeDeepgramConnection): any => conn.ofType('Settings')[0];

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** One request to the relay with the call's own token: what it lets the listener say. */
async function relayAsk(settings: any, messages: unknown[]): Promise<string> {
  const res = await fetch(settings.agent.think.endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: settings.agent.think.endpoint.headers.authorization },
    body: JSON.stringify({ messages, stream: true }),
  });
  const events = (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)));
  return events.map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
}

describe('a call that starts as a talk-it-through', () => {
  it('has the listener\'s prompt and six functions, the most patient turn-taking, TAi\'s own voice and an opener that names nothing', async () => {
    h = await createHarness();
    const u = h.user(1);
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'COMPETENCY.md'), COMPETENCY);
    const { conn, ready } = await startCall(h, { type: 'start', mode: 'talk', topic: ' how Raft\nelects a leader ' }, u);
    const s = settingsOf(conn);
    expect(ready).toMatchObject({ type: 'ready', mode: 'listener', voice: 'flux-hannah-en', resumed: false });
    expect(s.agent.think.prompt).toContain('LISTENER');
    expect(s.agent.think.prompt).toContain('how Raft elects a leader'); // the line break of what the student typed is gone
    expect(s.agent.think.prompt).toContain('Raft (leader election, log replication)'); // what it knows of them is what its question is made of
    expect(s.agent.think.functions.map((f: any) => f.name)).toEqual(['query_knowledge', 'read_competency', 'update_competency', 'save_memory', 'end_talk_through', 'end_session']);
    expect(s.agent.listen.provider).toMatchObject({ model: 'flux-general-en', version: 'v2', eot_threshold: 0.9, eot_timeout_ms: 10000 });
    expect(s.agent.speak.provider).toMatchObject({ model: 'flux-hannah-en' }); // not the interviewer's voice: the listener is TAi
    expect(lines.talkOpeners).toContain(s.agent.greeting);
    expect(JSON.stringify(s.agent.context.messages)).not.toContain('recall_memory'); // no such function in this mode
    expect(s.agent.think.endpoint.url).toBe(`${h.publicBase}/voice-llm/v1/chat/completions`);
  });

  it('needs no topic, ignores one that is not words, and is an interview when the call comes with an interview link', async () => {
    h = await createHarness();
    const { conn } = await startCall(h, { type: 'start', mode: 'talk', topic: 42 });
    expect(settingsOf(conn).agent.think.prompt).toContain('talk through something out loud');
    expect(settingsOf(conn).agent.think.prompt).not.toContain('The topic they named');
    await h.hub.close();
    await h.close();
    h = await createHarness();
    const u = h.user(1);
    const link = signInterviewToken(INTERVIEW_SECRET, u.folder, '4242', Date.now());
    const { ready } = await startCall(h, { type: 'start', mode: 'talk', token: link }, u);
    expect(ready.mode).toBe('interviewer');
  });

  it('reconnects with the listener\'s prompt and patience, and tells the student to carry on', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h, { type: 'start', mode: 'talk', topic: 'consistent hashing' });
    conn.userSays('so you put the servers on a ring');
    await browser.next('transcript', (e) => e.role === 'user');
    conn.close(1011);
    const second = await h.dg.connection(2);
    const s: any = await second.waitFor('Settings');
    expect(s.agent.greeting).toMatch(/carry on from where you were/);
    expect(s.agent.think.prompt).toContain('LISTENER');
    expect(s.agent.listen.provider).toMatchObject({ eot_threshold: 0.9, eot_timeout_ms: 10000 });
    expect(s.agent.context.messages).toContainEqual({ type: 'History', role: 'user', content: 'so you put the servers on a ring' });
    await browser.next('notice', (e) => e.text === 'Reconnected.');
  });

  it('does not take "too long" for a request to make its answers shorter: it says next to nothing, and its feedback is meant to be a few sentences', async () => {
    h = await createHarness();
    const { conn } = await startCall(h, { type: 'start', mode: 'talk' });
    conn.userSays('No. Too long. Too long.');
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.ofType('UpdatePrompt')).toHaveLength(0);
  });
});

describe('switching into a talk-it-through and back', () => {
  it('lets the model start it only when the student asked for it (their words, or their yes to its offer), and sends it to ask when not', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    conn.userSays('what is raft?');
    conn.callFunction('fc-ask', 'start_talk_through', { topic: 'raft' });
    const asked = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-ask');
    expect(JSON.parse(asked.content as string)).toMatchObject({ status: 'not started' });
    expect(String(asked.content)).toMatch(/Offer it in one short sentence/);
    expect(conn.ofType('UpdateThink')).toHaveLength(0);

    // once it has been told to ask, what it brings back is let through
    conn.userSays('sure, why not');
    conn.callFunction('fc-again', 'start_talk_through', { topic: 'raft' });
    const again = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-again');
    expect(JSON.parse(again.content as string).status).toBe('switching to listening mode');
    await conn.waitFor('UpdateThink');
  });

  it('starts it from the student\'s own words', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    conn.userSays("let me try to explain how raft elects a leader, I'll just talk");
    conn.callFunction('fc-1', 'start_talk_through', { topic: 'how raft elects a leader' });
    const ack = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-1');
    expect(JSON.parse(ack.content as string).status).toBe('switching to listening mode');
    await conn.waitFor('UpdateThink');
  });

  it('starts it from the student\'s yes to TAi\'s offer', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    conn.userSays('i think i get consistent hashing');
    conn.agentSays('nice! want to just talk it through out loud?');
    conn.userSays('yeah sure, go ahead');
    conn.callFunction('fc-2', 'start_talk_through', { topic: 'consistent hashing' });
    const ack = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-2');
    expect(JSON.parse(ack.content as string).status).toBe('switching to listening mode');
    await conn.waitFor('UpdateThink');
  });

  it('does not start it from a yes to an offer of something else', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    conn.userSays('what is due?');
    conn.agentSays('friday. want me to put the steps in the chat?');
    conn.userSays('yeah sure');
    conn.callFunction('fc-3', 'start_talk_through', { topic: 'steps' });
    const ack = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-3');
    expect(JSON.parse(ack.content as string).status).toBe('not started');
    expect(conn.ofType('UpdateThink')).toHaveLength(0);
  });

  it('goes into the listener and back with the same voice: UpdateThink with the six, the patient turn-taking, an opener, no UpdateSpeak; the other mode\'s functions are refused', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h);
    const token = settingsOf(conn).agent.think.endpoint.headers.authorization;
    conn.userSays("can I just talk it through out loud? I'll explain how raft elects a leader");
    conn.callFunction('fc-go', 'start_talk_through', { topic: 'how Raft elects a leader' });
    const ack = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-go');
    expect(JSON.parse(ack.content as string).status).toBe('switching to listening mode');
    expect(ack.content as string).toContain('[[handoff]]'); // the relay answers the turn after it with silence
    const think: any = await conn.waitFor('UpdateThink');
    expect(think.think.endpoint.headers.authorization.split('.')[1]).toBe(token.split('.')[1]); // the same call's token
    expect(think.think.prompt).toContain('LISTENER');
    expect(think.think.prompt).toContain('how Raft elects a leader');
    expect(think.think.functions.map((f: any) => f.name)).toEqual(['query_knowledge', 'read_competency', 'update_competency', 'save_memory', 'end_talk_through', 'end_session']);
    const patient: any = await conn.waitFor('UpdateListen');
    expect(patient.listen.provider).toEqual({ type: 'deepgram', version: 'v2', model: 'flux-general-en', eot_threshold: 0.9, eot_timeout_ms: 10000 });
    const opener = await conn.waitFor('InjectAgentMessage', (m) => lines.talkOpeners.includes(String(m.message)));
    expect(opener.behavior).toBe('queue');
    expect(await browser.next('mode')).toEqual({ type: 'mode', mode: 'listener', voice: 'flux-hannah-en' });
    expect(conn.ofType('UpdateSpeak')).toHaveLength(0); // TAi sounds as it always does

    conn.callFunction('fc-wrong', 'query_canvas', { action: 'upcoming' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-wrong')).content).toContain('not available in the talk-through');
    conn.callFunction('fc-iv', 'start_interview', { topic: 'raft' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-iv')).content).toContain('not available');
    conn.callFunction('fc-again', 'start_talk_through', { topic: 'raft' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-again')).content).toContain('not available');

    conn.callFunction('fc-end', 'end_talk_through', { summary: 'explained timeouts well, majority rule shaky' });
    const bye = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-end');
    expect(JSON.parse(bye.content as string).status).toBe('ending the talk-through');
    expect(bye.content as string).toContain('[[handoff]]');
    const back: any = await conn.waitFor('UpdateThink', (m: any) => m.think.functions.some((f: any) => f.name === 'start_interview'));
    expect(back.think.prompt).not.toContain('LISTENER');
    const quick: any = await conn.waitFor('UpdateListen', (m: any) => m.listen.provider.eot_threshold === 0.75);
    expect(quick.listen.provider.eot_timeout_ms).toBe(5000);
    await conn.waitFor('InjectAgentMessage', (m) => lines.talkReturns.includes(String(m.message)));
    await browser.next('mode', (e) => e.mode === 'conversational');
    expect(conn.ofType('UpdateSpeak')).toHaveLength(0);
  });

  it('stays in the conversation, and says so, when Deepgram does not confirm the switch', async () => {
    h = await createHarness();
    h.dg.withheldAcks.add('ThinkUpdated');
    const { browser, conn } = await startCall(h);
    conn.userSays('let me explain how raft elects a leader out loud');
    conn.callFunction('fc-go', 'start_talk_through', { topic: 'raft' });
    await conn.waitFor('UpdateThink');
    const said = await conn.waitFor('InjectAgentMessage', (m) => String(m.message).includes("couldn't switch into listening mode"), 3000);
    expect(said.behavior).toBe('queue');
    expect(browser.ofType('mode')).toHaveLength(0);
    expect(conn.ofType('UpdateListen')).toHaveLength(0);
  });

  it('does not ask for a Flux voice when the call had to give them up: the listener keeps the Aura voice', async () => {
    h = await createHarness();
    h.dg.onSettings = (s: any) => (s.agent.speak.provider.version === 'v2' ? { code: 'INVALID_SETTINGS', description: 'agent.speak.provider.model flux-hannah-en is not available' } : 'apply');
    const { browser } = await startCall(h);
    const conn = h.dg.connections[1];
    conn.userSays('let me explain how raft elects a leader out loud');
    conn.callFunction('fc-go', 'start_talk_through', { topic: 'raft' });
    await conn.waitFor('UpdateThink');
    expect(await browser.next('mode')).toEqual({ type: 'mode', mode: 'listener', voice: 'aura-2-thalia-en' });
    expect(conn.ofType('UpdateSpeak')).toHaveLength(0);
  });
});

describe('what the listener says', () => {
  it('may only nudge until the student has explained enough, then give its feedback: the relay\'s limits follow the call', async () => {
    h = await createHarness();
    const { conn } = await startCall(h, { type: 'start', mode: 'talk', topic: 'raft' });
    const s = settingsOf(conn);
    const answer = 'Right, so a follower that hears nothing starts an election and asks for votes. And the votes are counted by majority rule in the cluster. What about ties?';
    h.gw.respond = () => streamed(answer);

    // in a conversation these would be two sentences; a listener that has heard three words says one
    expect((await relayAsk(s, [{ role: 'user', content: 'so a follower waits' }])).trim()).toBe('Right, so a follower that hears nothing starts an election and asks for votes.');
    // the explanation is in the request that asks for the answer, before its transcript reaches the session: that is enough
    expect((await relayAsk(s, [{ role: 'user', content: EXPLANATION }])).trim()).toBe(answer);
    // and once the transcript is there as well, it is not counted twice (nor lost)
    conn.userSays(EXPLANATION);
    await new Promise((r) => setTimeout(r, 60));
    expect((await relayAsk(s, [{ role: 'user', content: EXPLANATION }])).trim()).toBe(answer);
    // a note of the system in the place of the last words is not what the student said
    expect((await relayAsk(s, [{ role: 'user', content: '[System note, not from the student: x]' }])).trim()).toBe(answer); // the explanation was counted from the transcript
  });

  it('asks the talk model for the listener, and the voice model for a conversation', async () => {
    h = await createHarness();
    const talk = await startCall(h, { type: 'start', mode: 'talk', topic: 'raft' });
    h.gw.respond = () => streamed('mm-hm.');
    await relayAsk(settingsOf(talk.conn), [{ role: 'user', content: 'so a follower waits' }]);
    expect((h.gw.requests.at(-1)!.body as { model: string }).model).toBe('qwen');
    await h.close();
    h = await createHarness();
    const chat = await startCall(h);
    h.gw.respond = () => streamed('Sure.');
    await relayAsk(settingsOf(chat.conn), [{ role: 'user', content: 'what is raft' }]);
    expect((h.gw.requests.at(-1)!.body as { model: string }).model).toBe('gpt-oss');
  });

  it('leaves the usual limits to a conversation, and gives a student who has said little only nudges', async () => {
    h = await createHarness();
    const { conn } = await startCall(h);
    const s = settingsOf(conn);
    const answer = 'Right, so a follower that hears nothing starts an election and asks for votes. And the votes are counted by majority rule in the cluster. A leader needs more than half of them. What about ties?';
    h.gw.respond = () => streamed(answer);
    expect((await relayAsk(s, [{ role: 'user', content: 'so a follower waits' }])).trim()).toBe('Right, so a follower that hears nothing starts an election and asks for votes. And the votes are counted by majority rule in the cluster. A leader needs more than half of them.');
  });

  it('sends the listener no note about the chat: it has no send_to_chat to call', async () => {
    h = await createHarness();
    const { conn } = await startCall(h, { type: 'start', mode: 'talk' });
    const s = settingsOf(conn);
    conn.userSays('can you put the steps in the chat?');
    conn.agentSays('I put it in the chat.'); // a claim in a mode that cannot send anything
    h.gw.respond = () => streamed('It is due on Friday.I put it in the chat.');
    expect((await relayAsk(s, [{ role: 'user', content: 'can you put the steps in the chat?' }])).trim()).toBe('It is due on Friday.'); // and the sentence is still not spoken
    await new Promise((r) => setTimeout(r, 300));
    expect(conn.ofType('InjectUserMessage')).toHaveLength(0);
  });

  it('credits what was explained through the guard (with the verbal scope), and the summary names the mode and the topic', async () => {
    h = await createHarness();
    const u = h.user(1);
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'COMPETENCY.md'), COMPETENCY);
    const { browser, conn } = await startCall(h, { type: 'start', mode: 'talk', topic: 'Raft leader election' }, u);
    conn.userSays(EXPLANATION);
    conn.agentSays('You had the random timeouts exactly right. What happens if two candidates tie?');
    conn.userSays('then neither has a majority so the term ends and they try again with new random timeouts');
    conn.callFunction('fc-c', 'update_competency', { concept: 'Raft leader election', confidence_delta: 0.15, notes: 'explained timeouts and the tie case in own words' });
    expect(await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-c')).toMatchObject({ name: 'update_competency' });
    conn.callFunction('fc-m', 'save_memory', { content: 'explains best when she starts from the failure case', category: 'student_preference' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-m')).content).toBe('Remembered.');
    conn.callFunction('fc-end', 'end_talk_through', { summary: 'explained timeouts and ties well; the majority rule needs another pass' });
    await conn.waitFor('UpdateThink', (m: any) => m.think.functions.some((f: any) => f.name === 'start_interview'));
    await browser.next('mode', (e) => e.mode === 'conversational');
    h.gw.respond = () => completion('You talked Raft leader election through and the timeouts were strong. The majority rule needs another pass.');
    browser.send({ type: 'end' });
    const closed = await browser.next('closed');
    expect(closed.summary).toContain('Voice session, 1 min (talk-it-through: Raft leader election).');
    expect(closed.summary).toContain('COMPETENCY.md: Raft (leader election, log replication) 0.4 → 0.55');
    await until(() => h!.summaries.length === 1);
    expect(h.summaries[0].text).toMatch(/^\[Voice session, 1 min, talk-it-through: Raft leader election\] You talked Raft leader election through/);
    const calls = h.chat.filter((c) => c.kind === 'activity');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: 'talk', title: 'Talk it through · 1 min' });
    expect(calls[0].text).toMatch(/^You talked Raft leader election through and the timeouts were strong\.$/);
    expect(calls[0].detail).toContain('The majority rule needs another pass.');
    expect(calls[0].detail).toContain('Where you stand now: Raft (leader election, log replication): a little stronger.');
    // what the call kept
    const comp = fs.readFileSync(path.join(h.groupsDir, u.folder, 'COMPETENCY.md'), 'utf-8');
    expect(comp).toMatch(/Raft \(leader election, log replication\): 0\.55 \| 0\.3 \| \[theoretical, verbal\] \| \[homework, socratic_dialogue\]/);
    const sessions = fs.readFileSync(path.join(h.groupsDir, u.folder, 'competency', 'voice-sessions.md'), 'utf-8');
    expect(sessions).toMatch(/## .* · 1 min · talk-it-through, Raft leader election/);
    expect(sessions).toContain('- Student (talk-through): so a follower waits for a heartbeat');
    expect(sessions).toContain('- TAi (talk-through): You had the random timeouts exactly right.');
    // the model was given the facts, among them that this was a talk-through and TAi's own note on it
    const summaryRequest = h.gw.requests.find((r) => r.body.stream === false)!;
    const asked = (summaryRequest.body.messages as Array<{ content: unknown }>).map((m) => String(m.content)).join('\n');
    expect(asked).toContain('talked "Raft leader election" through out loud');
    expect(asked).toContain('the majority rule needs another pass');
    const messagesDir = path.join(h.dataDir, 'ipc', u.folder, 'messages');
    const memory = fs.readdirSync(messagesDir).map((f) => JSON.parse(fs.readFileSync(path.join(messagesDir, f), 'utf-8')));
    expect(memory.find((m) => m.type === 'memory_store')).toMatchObject({ fact: { category: 'student_preference' } });
  });

  it('keeps the talk-through\'s notes when the call ends in the middle of it', async () => {
    h = await createHarness();
    const { browser, conn } = await startCall(h, { type: 'start', mode: 'talk', topic: 'consistent hashing' });
    conn.userSays('so you hash the servers onto a ring and then the keys too and each key goes to the next server clockwise');
    await browser.next('transcript', (e) => e.role === 'user');
    browser.send({ type: 'end' });
    const closed = await browser.next('closed');
    expect(closed.summary).toContain('(talk-it-through: consistent hashing)');
    await until(() => h!.chat.some((c) => c.kind === 'activity'));
    expect(h.chat.find((c) => c.kind === 'activity')).toMatchObject({ type: 'talk', title: 'Talk it through · 1 min' });
  });

  it('wraps up a minute before its cap and ends at it: the wrap-up prompt, the closing line, back to the conversational TA', async () => {
    const clock = { now: Date.now() };
    h = await createHarness({ env: { TAI_VOICE_TALK_MAX_MIN: '2', TAI_VOICE_SILENCE_SEC: '600' }, now: () => clock.now });
    const { browser, conn } = await startCall(h, { type: 'start', mode: 'talk', topic: 'raft' });
    clock.now += 61_000;
    expect((await conn.waitFor('UpdatePrompt', (m) => String(m.prompt).includes('WRAP UP THE TALK-THROUGH'))).prompt).toBeTruthy();
    const timer = await browser.next('timer', (e) => e.talkRemainingSec !== undefined && Number(e.talkRemainingSec) <= 60);
    expect(timer.talkRemainingSec).toBeLessThanOrEqual(59);
    clock.now += 60_000;
    await conn.waitFor('InjectAgentMessage', (m) => m.message === lines.talkClosing());
    await conn.waitFor('UpdateThink', (m: any) => m.think.functions.some((f: any) => f.name === 'start_interview'));
    await browser.next('mode', (e) => e.mode === 'conversational');
    expect(conn.ofType('InjectAgentMessage').filter((m) => m.message === lines.talkClosing())).toHaveLength(1);
  });
});
