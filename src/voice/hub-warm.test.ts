/**
 * Two things that make a call feel less like a phone menu, through the whole hub with a fake Deepgram and fake tool hosts:
 *   - the tool host of a call that ended stays up for the same student's next call (no ten-second wait for a container);
 *   - a look-up that runs long is answered for now, and its result follows as a note while the conversation goes on (off unless
 *     TAI_VOICE_ASYNC_AFTER_MS is set).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { promotion } from './prompts.js';
import { BrowserClient, Harness, createHarness } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { Caller } from './types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function startCall(harness: Harness, user?: Caller): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection; user: Caller }> {
  const u = user ?? harness.user(1);
  const browser = await harness.browser(u);
  browser.send({ type: 'start', mode: 'chat' });
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  await browser.next('ready');
  return { browser, conn, user: u };
}

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A call, ended by the student, and waited for until its notes are written and its tool host has been given back. */
async function endCall(harness: Harness, browser: BrowserClient, endedBefore: number): Promise<void> {
  browser.send({ type: 'end' });
  await browser.next('closed');
  await until(() => harness.logs.filter((l) => l.msg === 'voice call ended').length > endedBefore);
}

const ended = (harness: Harness) => harness.logs.filter((l) => l.msg === 'voice call ended').length;

describe('the tool host kept for the next call', () => {
  const keep = { TAI_VOICE_TOOLHOST_KEEP_SEC: '60' };

  it('is the same container for the same student\'s next call: no second start, its caches refreshed, the first look-up does not wait or say "one sec"', async () => {
    h = await createHarness({ env: keep, toolStartDelayMs: 120, toolHandlers: { canvas_query: () => ({ ok: true, text: 'nothing due' }) } });
    const first = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    await endCall(h, first.browser, 0);
    expect(h.toolHosts).toHaveLength(1);
    expect(h.toolHosts[0].closed).toBe(false); // it waits for the next call

    const second = await startCall(h, first.user);
    expect(h.toolHosts).toHaveLength(1); // no second container
    expect(h.toolHosts[0].refreshed).toBe(1);
    second.conn.userSays('what is due this week?');
    second.conn.callFunction('fc-1', 'query_canvas', { action: 'upcoming' });
    const res = await second.conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-1');
    expect(res.content).toBe('nothing due');
    expect(second.conn.ofType('InjectAgentMessage')).toHaveLength(0); // up from the first moment: nothing to cover
    expect(h.toolHosts[0].calls).toHaveLength(1);
  });

  it('is never another student\'s, and a student whose GitHub was bound since gets a new one', async () => {
    h = await createHarness({ env: keep });
    const a = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    await endCall(h, a.browser, 0);

    const b = await startCall(h, h.user(2));
    await until(() => h!.toolHosts.length === 2);
    expect(h.toolHosts[0].closed).toBe(false); // the first student's host is still theirs
    await endCall(h, b.browser, 1);

    const rebound = { ...a.user, githubUsername: 'a-new-account' };
    const again = await startCall(h, rebound);
    await until(() => h!.toolHosts.length === 3);
    expect(h.toolHosts[0].closed).toBe(true); // started for another binding: closed, not handed on
    expect(h.toolHosts[1].closed).toBe(false);
    await endCall(h, again.browser, 2);
  });

  it('is closed with the service, and with every call when the keep time is 0', async () => {
    h = await createHarness({ env: keep });
    const first = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    await endCall(h, first.browser, 0);
    expect(h.toolHosts[0].closed).toBe(false);
    await h.hub.close();
    expect(h.toolHosts[0].closed).toBe(true);
  });

  it('is not kept while a look-up of the call was still running in it', async () => {
    h = await createHarness({ env: keep, toolHandlers: { canvas_query: () => new Promise(() => undefined) } });
    const first = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    first.conn.callFunction('fc-hang', 'query_canvas', { action: 'upcoming' });
    await until(() => h!.toolHosts[0].calls.length === 1);
    await endCall(h, first.browser, 0);
    expect(h.toolHosts[0].closed).toBe(true);
  });
});

describe('a look-up that runs long', () => {
  const slow = (ms: number, text = 'the slides say Raft elects a leader by majority vote') => async () => {
    await sleep(ms);
    return { ok: true, text };
  };

  /** The call, with its tool host up and the student having asked. */
  async function slowCall(opts: Parameters<typeof createHarness>[0] = {}) {
    h = await createHarness({ ...opts, env: { TAI_VOICE_ASYNC_AFTER_MS: '80', ...(opts.env ?? {}) } });
    const call = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    call.conn.userSays('what do the raft slides say?');
    return call;
  }

  it('is answered for now, and its result comes as a note once it is done: not as a second answer to the same call', async () => {
    const { conn, browser } = await slowCall({ toolHandlers: { canvas_query: slow(300) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    const provisional = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow');
    expect(provisional.content).toBe(promotion.provisionalResult());
    expect(h!.toolHosts[0].calls).toHaveLength(1); // the look-up goes on
    const note = await conn.waitFor('InjectUserMessage', (m) => String(m.content).startsWith('[System note'), 3000);
    expect(String(note.content)).toContain('query_canvas files');
    expect(String(note.content)).toContain('the slides say Raft elects a leader by majority vote');
    expect(String(note.content)).toContain('not from the student');
    expect(conn.ofType('FunctionCallResponse').filter((m) => m.id === 'fc-slow')).toHaveLength(1);
    // Deepgram sends the note back as the user's line: it is not what the student said, and the page never sees it
    conn.userSays(String(note.content));
    await sleep(60);
    expect(browser.ofType('transcript').some((t) => String(t.text).startsWith('[System note'))).toBe(false);
  });

  it('shows "working" until the look-up is done and then "listening": never "thinking" for good', async () => {
    const { conn, browser } = await slowCall({ toolHandlers: { canvas_query: slow(300) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow');
    conn.agentSays('still looking, give me a second.', 480, false); // what the model says to the provisional answer
    await conn.waitFor('InjectUserMessage', (m) => String(m.content).startsWith('[System note'), 3000);
    conn.agentSays('they say a leader needs a majority of the votes.', 480, false); // its answer to the note
    await until(() => browser.ofType('status').at(-1)?.state === 'listening' && browser.ofType('status').length >= 6);
    const seq = browser.ofType('status').map((e) => e.state);
    expect(seq.slice(seq.indexOf('working'))).toEqual(['working', 'speaking', 'working', 'listening', 'speaking', 'listening']);
  });

  it('does not add the pre-written "still on it" line on top of what the model says to the provisional answer', async () => {
    // the filler after 30 ms is armed first and its second line would be due 200 ms later; the look-up is promoted at 80 ms, so the model has the
    // provisional answer and says its own holding sentence: a third wait line within seconds is what the owner would hear if the timer survived
    h = await createHarness({
      timing: { fillerAfterMs: 30, stillLookingMs: 200 },
      env: { TAI_VOICE_ASYNC_AFTER_MS: '80' },
      toolHandlers: { canvas_query: slow(700) },
    });
    const { conn } = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    await sleep(100);
    const before = conn.ofType('InjectAgentMessage').length;
    conn.userSays('what do the raft slides say?');
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow')).content).toBe(promotion.provisionalResult());
    await sleep(450); // well past 30 + 200 ms, and the look-up (700 ms) is still running
    expect(h!.toolHosts[0].calls).toHaveLength(1);
    expect(conn.ofType('InjectAgentMessage').length - before).toBeLessThanOrEqual(1); // at most the first "one sec", never the second line
  });

  it('answers a look-up that is quicker than that as it always did, and a function that is no look-up however long it takes', async () => {
    h = await createHarness({
      env: { TAI_VOICE_ASYNC_AFTER_MS: '80' },
      toolHandlers: { canvas_query: slow(10, 'due friday'), render_diagram: slow(250, 'drawn') },
    });
    const { conn } = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    conn.callFunction('fc-fast', 'query_canvas', { action: 'upcoming' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-fast')).content).toBe('due friday');
    conn.callFunction('fc-draw', 'render_diagram', { mermaid_code: 'graph TD; A-->B' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-draw')).content).toBe('The diagram is in the chat now.'); // told only when it is true
    await sleep(200);
    expect(conn.ofType('InjectUserMessage')).toHaveLength(0);
  });

  it('does nothing of this while the flag is off, however long a look-up takes', async () => {
    h = await createHarness({ toolHandlers: { canvas_query: slow(300, 'the real answer') } });
    const { conn } = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow', 3000)).content).toContain('the real answer');
    await sleep(100);
    expect(conn.ofType('InjectUserMessage')).toHaveLength(0);
  });

  it('keeps the note until TAi has finished speaking, then says it', async () => {
    const { conn } = await slowCall({ toolHandlers: { canvas_query: slow(250) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow');
    conn.sendAudio(480); // TAi is in the middle of a sentence (no AgentAudioDone yet)
    await sleep(450); // the look-up has finished by now
    expect(conn.ofType('InjectUserMessage').filter((m) => String(m.content).startsWith('[System note'))).toHaveLength(0);
    conn.send({ type: 'AgentAudioDone' });
    await conn.waitFor('InjectUserMessage', (m) => String(m.content).startsWith('[System note'), 3000);
  });

  it('keeps the links it found: TAi may put them in the chat afterwards, and no other', async () => {
    const link = 'https://northeastern.instructure.com/files/77/download?verifier=abc';
    const { conn } = await slowCall({ toolHandlers: { canvas_query: slow(250, `Raft_Slides.pdf ${link}`) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow');
    await conn.waitFor('InjectUserMessage', (m) => String(m.content).startsWith('[System note'), 3000);
    conn.callFunction('fc-send', 'send_to_chat', { message: `the slides: ${link}` });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-send')).content).toBe('It is in the chat now.');
    conn.callFunction('fc-made-up', 'send_to_chat', { message: 'the slides: https://northeastern.instructure.com/files/xxxx/download' });
    expect(String((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-made-up')).content)).toContain('not sent');
  });

  it('puts into a note only as much of a long result as a person would say, and says it was cut', async () => {
    const { conn } = await slowCall({ toolHandlers: { canvas_query: slow(150, 'word '.repeat(4000)) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    const note = await conn.waitFor('InjectUserMessage', (m) => String(m.content).startsWith('[System note'), 3000);
    expect(String(note.content).length).toBeLessThan(2200);
    expect(String(note.content)).toContain('[... cut');
  });

  it('tells the model when the look-up failed, in the same note', async () => {
    const { conn } = await slowCall({ toolHandlers: { canvas_query: async () => (await sleep(150), { ok: false, text: 'Canvas is not reachable' }) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    const note = await conn.waitFor('InjectUserMessage', (m) => String(m.content).startsWith('[System note'), 3000);
    expect(String(note.content)).toMatch(/has failed/);
    expect(String(note.content)).toContain('Canvas is not reachable');
  });

  it('lets at most three run on at once: the fourth is waited for', async () => {
    h = await createHarness({ env: { TAI_VOICE_ASYNC_AFTER_MS: '60' }, toolHandlers: { canvas_query: slow(450, 'late answer') } });
    const { conn } = await startCall(h);
    await until(() => h!.toolHosts[0].alive);
    const asks: Record<string, string> = { a: 'files', b: 'modules', c: 'pages', d: 'assignments' }; // four different look-ups
    for (const id of Object.keys(asks)) conn.callFunction(`fc-${id}`, 'query_canvas', { action: asks[id] });
    await until(() => conn.ofType('FunctionCallResponse').length === 4, 4000);
    const answers = Object.fromEntries(conn.ofType('FunctionCallResponse').map((m) => [String(m.id), String(m.content)]));
    for (const id of ['a', 'b', 'c']) expect(answers[`fc-${id}`]).toBe(promotion.provisionalResult());
    expect(answers['fc-d']).toBe('late answer');
  });

  it('answers a second ask for what is still being looked up with the same "still running", and does not look it up twice', async () => {
    const { conn } = await slowCall({ toolHandlers: { canvas_query: slow(400) } });
    conn.callFunction('fc-1', 'query_canvas', { action: 'files' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-1');
    conn.callFunction('fc-2', 'query_canvas', { action: 'files' }); // the model asks again
    const again = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-2');
    expect(again.content).toBe(promotion.provisionalResult());
    expect(h!.toolHosts[0].calls).toHaveLength(1);
    await conn.waitFor('InjectUserMessage', (m) => String(m.content).startsWith('[System note'), 3000);
    await sleep(100);
    expect(conn.ofType('InjectUserMessage').filter((m) => String(m.content).startsWith('[System note'))).toHaveLength(1); // one note
    // once it is done, the same ask is a new look-up (the lists of the course are kept for a while, so this one is quick)
    conn.callFunction('fc-3', 'query_canvas', { action: 'files' });
    expect((await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-3')).content).not.toBe(promotion.provisionalResult());
  });

  it('drops the result when the call ends first, without a sound', async () => {
    const { conn, browser } = await slowCall({ toolHandlers: { canvas_query: slow(250) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow');
    const before = ended(h!);
    browser.send({ type: 'end' });
    await browser.next('closed');
    await until(() => ended(h!) > before);
    await sleep(350);
    expect(conn.ofType('InjectUserMessage')).toHaveLength(0);
    expect(h!.logs.some((l) => l.msg.includes('was dropped'))).toBe(true); // it came back, and was let go
    expect(h!.logs.filter((l) => l.level === 'error')).toHaveLength(0);
  });

  it('drops the result when the call changed its mode in the meantime: it belongs to the conversation it was asked in', async () => {
    const { conn, browser } = await slowCall({ toolHandlers: { canvas_query: slow(400) } });
    conn.callFunction('fc-slow', 'query_canvas', { action: 'files' });
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-slow');
    conn.userSays('actually, let me explain raft to you out loud');
    conn.callFunction('fc-go', 'start_talk_through', { topic: 'raft' });
    await browser.next('mode', (e) => e.mode === 'listener');
    await sleep(600); // the look-up has finished long ago
    expect(conn.ofType('InjectUserMessage').filter((m) => String(m.content).startsWith('[System note'))).toHaveLength(0);
    expect(h!.logs.some((l) => l.msg.includes('was dropped'))).toBe(true);
  });
});
