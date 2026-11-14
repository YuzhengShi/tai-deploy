/**
 * The viewer through the whole hub with a fake Deepgram and a fake gateway (docs/VIEWER_VOICE.md): the page's `view` message (kept for the student of the socket, with or without a call, empty
 * views too, at a pace of its own), the note on each turn of a call (conversation and interview, not the talk-through), and show_document, point_at and look_at_screen as the model calls them:
 * what the page is sent, the card in the chat, what the model is answered, and what the interview and the claim guard make of them. The logic of the functions is screen.test.ts; the relay's is relay-screen.test.ts.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createViewStore } from '../chat-objects/view.js';
import type { ChatObject } from '../chat-objects/types.js';
import type { DocMeta, DocOpenResult, DocSource, DocsApi, PageWords } from '../docs/types.js';
import { VIEW_PER_MINUTE } from './hub.js';
import { signInterviewToken } from './interview-token.js';
import { SYSTEM_NOTE, lines } from './prompts.js';
import { BrowserClient, Harness, INTERVIEW_SECRET, createHarness, makeUser } from './testing/harness.js';
import { streamed } from './testing/fake-gateway.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { Caller, ChatExtra } from './types.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const RAFT = 'a'.repeat(32);
const PAGE: PageWords = {
  words: [
    [0.1, 0.1, 0.2, 0.13, 'Leader'],
    [0.21, 0.1, 0.3, 0.13, 'election'],
    [0.31, 0.1, 0.36, 0.13, 'in'],
    [0.37, 0.1, 0.45, 0.13, 'Raft'],
    [0.1, 0.8, 0.18, 0.83, 'uses'],
    [0.19, 0.8, 0.22, 0.83, 'a'],
    [0.23, 0.8, 0.4, 0.83, 'randomized'],
    [0.41, 0.8, 0.55, 0.83, 'election-timeout.'],
  ],
  lines: [
    [0, 3],
    [4, 7],
  ],
};

/** A documents service with one document for one student. */
function fakeDocs(folder: string): DocsApi & { opens: DocSource[] } {
  const doc: DocMeta = { id: RAFT, title: 'Raft slides', pages: 32, origin: 'canvas', createdAt: 1, bytes: 10 };
  const opens: DocSource[] = [];
  return {
    opens,
    meta: (f, id) => (f === folder && id === RAFT ? doc : null),
    words: (f, id, page) => (f === folder && id === RAFT && page === 7 ? PAGE : null),
    text: (f, id, page) => (f === folder && id === RAFT && page === 7 ? 'Leader election in Raft\nuses a randomized election-timeout.' : null),
    pageFile: () => null,
    list: (f) => (f === folder ? [doc] : []),
    library: () => [],
    searchLibrary: () => [],
    ready: async () => true,
    reap: async () => 0,
    open: async (_who, source): Promise<DocOpenResult> => {
      opens.push(source);
      return { ok: true, doc, page: 1 };
    },
  };
}

interface Chat {
  folder: string;
  role: string;
  text: string;
  extra?: ChatExtra;
}

/** The deps a test hands the hub: the page's views, one student's documents, and an appendChat that keeps the card as well as the words. */
function viewer(user: Caller, over: { objectOf?: (folder: string, n: number) => ChatObject | null } = {}) {
  const views = createViewStore();
  const docs = fakeDocs(user.folder);
  const chat: Chat[] = [];
  return { views, docs, chat, deps: { views, docs, objectOf: over.objectOf, appendChat: (folder: string, role: 'user' | 'assistant', text: string, extra?: ChatExtra) => void chat.push({ folder, role, text, extra }) } };
}

const tools = { canvas_query: () => ({ ok: true as const, text: '[]' }), github_query: () => ({ ok: true as const, text: '[]' }), start_mock_interview: () => ({ ok: true as const, text: 'ready' }) };

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function startCall(harness: Harness, user: Caller, start: Record<string, unknown> = { type: 'start', mode: 'chat' }): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection; sid: string; url: string; auth: string }> {
  const browser = await harness.browser(user);
  browser.send(start);
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  const ready = await browser.next('ready');
  const settings = (await conn.waitFor('Settings')) as any;
  return { browser, conn, sid: String(ready.sessionId), url: settings.agent.think.endpoint.url, auth: settings.agent.think.endpoint.headers.authorization };
}

type Msg = { role: string; content?: unknown };
/** One Think request as Deepgram would send it for this call; the messages the gateway got come back. */
async function think(harness: Harness, call: { url: string; auth: string }, messages: Msg[]): Promise<{ text: string; sent: Msg[] }> {
  harness.gw.respond = () => streamed('Right, that is the leader election slide.');
  const before = harness.gw.requests.length;
  const res = await fetch(call.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: call.auth }, body: JSON.stringify({ model: 'x', messages, stream: true }) });
  const text = await res.text();
  const sent = (harness.gw.requests[before]?.body as { messages?: Msg[] } | undefined)?.messages ?? [];
  return { text, sent };
}
const noteIn = (messages: Msg[]) => messages.filter((m) => m.role === 'system' && String(m.content).startsWith('THEIR SCREEN'));

describe("the page's view message", () => {
  it('is kept for the student of the socket, with no call started yet, and the folder is the one the portal gave, never one in the message', async () => {
    const v = viewer(makeUser(1));
    h = await createHarness({ deps: v.deps });
    const u = h.user(1);
    const browser = await h.browser(u);
    // no start message: the socket is only the page's way of telling where the student is looking
    browser.send({ type: 'view', folder: 'someone-else', view: { v: 1, doc: { id: RAFT, page: 7 }, sel: { doc: RAFT, page: 7, from: 6, to: 7 } } });
    await until(() => v.views.get(u.folder) !== null);
    expect(v.views.get(u.folder)!.view).toEqual({ v: 1, doc: { id: RAFT, page: 7 }, sel: { doc: RAFT, page: 7, from: 6, to: 7 } });
    expect(v.views.size()).toBe(1);
    expect(v.views.get('someone-else')).toBeNull();
    browser.close();
  });

  it('keeps an empty view (the viewer was closed) and drops one that does not parse, and a message that is no view', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    h = await createHarness({ deps: v.deps });
    const u = h.user(1);
    const browser = await h.browser(u);
    browser.send({ type: 'view', view: { v: 1, doc: { id: RAFT, page: 7 } } });
    await until(() => v.views.get(u.folder) !== null);
    browser.send({ type: 'view', view: { v: 2, doc: { id: RAFT, page: 9 } } });                  // not version 1
    browser.send({ type: 'view', view: 'doc' });
    browser.send({ type: 'view' });
    browser.send({ type: 'ping' });
    await browser.next('pong');                                                                      // everything before it has been handled
    expect(v.views.get(u.folder)!.view).toEqual({ v: 1, doc: { id: RAFT, page: 7 } });
    browser.send({ type: 'view', view: { v: 1 } });                                                  // the page says the viewer is closed: the server forgets what was open
    await until(() => JSON.stringify(v.views.get(u.folder)?.view) === '{"v":1}');
    browser.close();
  });

  it('takes the views of a page that reports often, and not more than a minute\'s worth: the rest are dropped', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    let sets = 0;
    const counting = { ...v.views, set: (folder: string, view: Parameters<typeof v.views.set>[1]) => (sets++, v.views.set(folder, view)) };
    h = await createHarness({ deps: { ...v.deps, views: counting } });
    const u = h.user(1);
    const browser = await h.browser(u);
    for (let i = 0; i < VIEW_PER_MINUTE + 30; i++) browser.send({ type: 'view', view: { v: 1, doc: { id: RAFT, page: 1 + (i % 100) } } });
    browser.send({ type: 'ping' });
    await browser.next('pong');
    expect(sets).toBe(VIEW_PER_MINUTE);
    expect(VIEW_PER_MINUTE).toBeGreaterThan(80);                                                      // more than the page's own pace (one report in 0.8 s)
    browser.close();
  });

  it('is ignored when the host has no store for it', async () => {
    h = await createHarness();
    const browser = await h.browser(h.user(1));
    browser.send({ type: 'view', view: { v: 1, doc: { id: RAFT, page: 7 } } });
    browser.send({ type: 'ping' });
    await browser.next('pong');
    browser.close();
  });
});

describe('the note on each turn of a call', () => {
  it('goes into the request of a conversation while something is open, right before the last user message, and not into the next one when the viewer is closed', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    h = await createHarness({ deps: v.deps, toolHandlers: tools });
    const u = h.user(1);
    const call = await startCall(h, u);
    const history: Msg[] = [{ role: 'system', content: 'You are TAi.' }, { role: 'assistant', content: 'hey' }, { role: 'user', content: 'what does this slide say?' }];
    // nothing open: the request is what Deepgram sent
    expect((await think(h, call, history)).sent).toEqual(history);
    // the page says the student is looking at page 7 with two words selected
    call.browser.send({ type: 'view', view: { v: 1, doc: { id: RAFT, page: 7 }, sel: { doc: RAFT, page: 7, from: 6, to: 7 } } });
    await until(() => v.views.get(u.folder) !== null);
    const turn = await think(h, call, history);
    expect(turn.sent.map((m) => m.role)).toEqual(['system', 'assistant', 'system', 'user']);
    const note = String(turn.sent[2].content);
    expect(note).toMatch(/^THEIR SCREEN, as of /);
    expect(note).toContain('The document "Raft slides" is open in their viewer at page 7 of 32.');
    expect(note).toContain('SELECTED WORDS: randomized election-timeout.');
    expect(turn.text).toContain('leader election slide');
    // Deepgram's own conversation never holds it: the next request is built from the history without it, and gets a note of its own
    const again = await think(h, call, [...history, { role: 'assistant', content: 'It is about leader election.' }, { role: 'user', content: 'and this?' }]);
    expect(noteIn(again.sent)).toHaveLength(1);
    // the viewer is closed: no note
    call.browser.send({ type: 'view', view: { v: 1 } });
    await until(() => JSON.stringify(v.views.get(u.folder)?.view) === '{"v":1}');
    expect((await think(h, call, history)).sent).toEqual(history);
    // the student's chat selection makes a note without any document at all
    call.browser.send({ type: 'view', view: { v: 1, msg: { n: 4, text: 'the leader sends heartbeats' } } });
    await until(() => v.views.get(u.folder)?.view.msg !== undefined);
    expect(String(noteIn((await think(h, call, history)).sent)[0].content)).toContain('SELECTED IN CHAT LINE 4: the leader sends heartbeats');
  });

  it('is told of a card the student is looking at, through the history\'s own object for that line', async () => {
    const probe = makeUser(1);
    const run: ChatObject = { t: 'run', command: 'go test ./...', ok: true, exitCode: 1, timedOut: false, durationMs: 1, output: 'one\ntwo\nFAIL', truncated: false };
    const v = viewer(probe, { objectOf: (folder, n) => (folder === probe.folder && n === 41 ? run : null) });
    h = await createHarness({ deps: v.deps });
    const u = h.user(1);
    const call = await startCall(h, u);
    call.browser.send({ type: 'view', view: { v: 1, obj: { n: 41, lines: [2, 3] } } });
    await until(() => v.views.get(u.folder) !== null);
    const note = String(noteIn((await think(h, call, [{ role: 'system', content: 'p' }, { role: 'user', content: 'why does this fail?' }])).sent)[0].content);
    expect(note).toContain('They are looking at the run card of `go test ./...`');
    expect(note).toContain('RUN OUTPUT LINES 2-3');
  });

  it('is there in an interview and not in a talk-it-through, whose prompt knows nothing of it', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    h = await createHarness({ deps: v.deps, toolHandlers: tools });
    const u = h.user(1);
    v.views.set(u.folder, { v: 1, doc: { id: RAFT, page: 7 } });
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'interview_context.json'), JSON.stringify({ studentName: 'Ada', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.', generatedAt: new Date().toISOString() }));
    const token = signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now());
    const interview = await startCall(h, u, { type: 'start', mode: 'chat', token });
    const msgs: Msg[] = [{ role: 'system', content: 'You are TAi.' }, { role: 'user', content: 'what does this mean?' }];
    expect(noteIn((await think(h, interview, msgs)).sent)).toHaveLength(1);
    interview.browser.send({ type: 'end' });
    await interview.browser.next('closed');
    await until(() => !h!.hub.isActive(u.folder));
    const talk = await startCall(h, u, { type: 'start', mode: 'talk' });
    expect(noteIn((await think(h, talk, msgs)).sent)).toHaveLength(0);
  });

  it('is gone with the call: a token of a call that is over does not open the relay, and nothing is asked of the store for it', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    let asked = 0;
    const watching = { ...v.views, get: (folder: string) => (asked++, v.views.get(folder)) };
    h = await createHarness({ deps: { ...v.deps, views: watching } });
    const u = h.user(1);
    const call = await startCall(h, u);
    call.browser.send({ type: 'end' });
    await call.browser.next('closed');
    await until(() => !h!.hub.isActive(u.folder));
    const res = await fetch(call.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: call.auth }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
    expect(res.status).toBe(401);
    expect(asked).toBe(0);
  });
});

describe('the functions in a call', () => {
  const ask = async (conn: FakeDeepgramConnection, id: string, name: string, args: Record<string, unknown> = {}): Promise<string> => {
    conn.callFunction(id, name, args);
    return String((await conn.waitFor('FunctionCallResponse', (m) => m.id === id)).content);
  };

  it('show_document opens the student\'s own document, tells their page, leaves one card in their chat, and answers with the page as data; a second ask is not a second card', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    h = await createHarness({ deps: v.deps, toolHandlers: tools });
    const u = h.user(1);
    const { conn, browser } = await startCall(h, u);
    conn.userSays('show me the raft slides');
    const answer = JSON.parse(await ask(conn, 'f1', 'show_document', { document: 'raft slides', page: 7 }));
    expect(answer.status).toBe('on their screen');
    expect(answer.screen).toContain('TEXT OF PAGE 7: Leader election in Raft');
    expect(await browser.next('show')).toMatchObject({ type: 'show', doc: RAFT, page: 7, title: 'Raft slides', pages: 32 });
    const cards = v.chat.filter((c) => c.extra?.kind === 'object');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ folder: u.folder, role: 'assistant', text: '' });
    expect(cards[0].extra!.obj).toEqual({ t: 'doc', doc: RAFT, title: 'Raft slides', pages: 32, page: 7, origin: 'canvas' });
    await ask(conn, 'f2', 'show_document', { document: 'raft', page: 8 });
    expect(v.chat.filter((c) => c.extra?.kind === 'object')).toHaveLength(1);
    expect(v.docs.opens).toEqual([{ kind: 'existing', id: RAFT }]);
    expect(browser.ofType('show')).toHaveLength(2);
    // a document that is not theirs is not found, and nothing is sent to the page
    const none = JSON.parse(await ask(conn, 'f3', 'show_document', { document: 'kubernetes' }));
    expect(none.error).toMatch(/could not tell which document of theirs they mean/);
    expect(none.their_documents).toContain('Prepared documents: "Raft slides".');
    expect(browser.ofType('show')).toHaveLength(2);
  });

  it('is met with a pre-written line when it takes a moment, like the look-ups: a document that has to be prepared is not met with silence', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    const slow = {
      ...v.docs,
      list: () => [] as DocMeta[],
      open: async (): Promise<DocOpenResult> => {
        await new Promise((r) => setTimeout(r, 350));
        return { ok: true, doc: { id: RAFT, title: 'hw3.pdf', pages: 3, origin: 'upload', createdAt: 1, bytes: 1 }, page: 1 };
      },
    } as DocsApi;
    h = await createHarness({ timing: { fillerAfterMs: 60, stillLookingMs: 5_000 }, deps: { ...v.deps, docs: slow }, toolHandlers: tools });
    const u = h.user(1);
    fs.mkdirSync(path.join(h.groupsDir, u.folder, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'uploads', 'hw3.pdf'), '%PDF-1.4');
    const { conn, sid } = await startCall(h, u);
    await new Promise((r) => setTimeout(r, 300));
    const before = conn.ofType('InjectAgentMessage').length;
    conn.userSays('open my hw3 pdf');
    conn.callFunction('f1', 'show_document', { document: 'hw3' });
    await until(() => conn.ofType('InjectAgentMessage').length > before);
    expect(conn.ofType('InjectAgentMessage')[before]).toMatchObject({ message: expect.stringMatching(/./), behavior: 'queue' });
    expect(lines.fillers.slow).toContain(String(conn.ofType('InjectAgentMessage')[before].message));
    expect(sid.length).toBeGreaterThan(10);
    await conn.waitFor('FunctionCallResponse', (m) => m.id === 'f1');
  });

  it('point_at sends the boxes for the page the student has open, and look_at_screen answers with what they have open', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    h = await createHarness({ deps: v.deps, toolHandlers: tools });
    const u = h.user(1);
    const { conn, browser } = await startCall(h, u);
    expect(await ask(conn, 'f0', 'look_at_screen')).toMatch(/^Their viewer is closed and nothing is selected/);
    browser.send({ type: 'view', view: { v: 1, doc: { id: RAFT, page: 7 }, point: { doc: RAFT, page: 7, x: 0.41, y: 0.81 } } });
    await until(() => v.views.get(u.folder) !== null);
    const look = await ask(conn, 'f1', 'look_at_screen');
    expect(look).toMatch(/^THEIR SCREEN, as of /);
    expect(look).toContain('NEAR THE CLICK:');
    const pointed = JSON.parse(await ask(conn, 'f2', 'point_at', { phrase: 'randomized election-timeout' }));
    expect(pointed).toMatchObject({ status: 'pointing', page: 7 });
    const point = await browser.next('point');
    expect(point).toMatchObject({ doc: RAFT, page: 7 });
    expect((point.boxes as unknown[]).length).toBe(1);
    expect(browser.ofType('show')).toHaveLength(0);                                                  // the viewer was on that page already
    const miss = JSON.parse(await ask(conn, 'f3', 'point_at', { phrase: 'consistent hashing' }));
    expect(miss.status).toBe('not found');
    expect(miss.start_of_page).toContain('Leader election in Raft');
  });

  it('says it is not set up when the host has no documents service, and an interview may look at the screen but never open or point at a document', async () => {
    h = await createHarness({ toolHandlers: tools });
    const u = h.user(1);
    const conversation = await startCall(h, u);
    expect(JSON.parse(await ask(conversation.conn, 'f1', 'show_document', { document: 'raft' })).error).toMatch(/not set up on this server yet/);
    expect(JSON.parse(await ask(conversation.conn, 'f2', 'point_at', { phrase: 'raft' })).error).toMatch(/not set up on this server yet/);
    expect(await ask(conversation.conn, 'f3', 'look_at_screen')).toMatch(/closed and nothing is selected/);
    conversation.browser.send({ type: 'end' });
    await conversation.browser.next('closed');
    await until(() => !h!.hub.isActive(u.folder));
    fs.writeFileSync(path.join(h.groupsDir, u.folder, 'interview_context.json'), JSON.stringify({ studentName: 'Ada', assignmentId: '3527597', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.', generatedAt: new Date().toISOString() }));
    const interview = await startCall(h, u, { type: 'start', mode: 'chat', token: signInterviewToken(INTERVIEW_SECRET, u.folder, '3527597', Date.now()) });
    expect(await ask(interview.conn, 'g1', 'look_at_screen')).toMatch(/closed and nothing is selected/);
    expect(await ask(interview.conn, 'g1b', 'look_at_screen')).not.toMatch(/show_document/);
    expect(JSON.parse(await ask(interview.conn, 'g2', 'show_document', { document: 'raft' })).error).toMatch(/not available in the interview/);
    expect(JSON.parse(await ask(interview.conn, 'g3', 'point_at', { phrase: 'raft' })).error).toMatch(/not available in the interview/);
  });

  it('lets TAi say a card is in the chat after show_document, as it may after send_to_chat: the sentence is not dropped and nobody is asked to send it again', async () => {
    const probe = makeUser(1);
    const v = viewer(probe);
    h = await createHarness({ timing: { claimCheckMs: 60 }, deps: v.deps, toolHandlers: tools });
    const u = h.user(1);
    const call = await startCall(h, u);
    // the student asks for the slides ("show me", "slides": a request for something in the chat), the model opens the document and then says where it is
    call.conn.userSays('show me the raft slides');
    const answer = await ask(call.conn, 'f1', 'show_document', { document: 'raft slides', page: 7 });
    expect(answer).toMatch(/in the chat now/i);
    const res = await (async () => {
      h!.gw.respond = () => streamed('Done, the card is in the chat now.');
      const r = await fetch(call.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: call.auth },
        body: JSON.stringify({
          model: 'x',
          stream: true,
          messages: [
            { role: 'system', content: 'You are TAi.' },
            { role: 'user', content: 'show me the raft slides' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'f1', type: 'function', function: { name: 'show_document', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'f1', content: answer },
          ],
        }),
      });
      return r.text();
    })();
    expect(res).toContain('the card is in the chat now');
    await new Promise((r) => setTimeout(r, 400));
    expect(call.conn.ofType('InjectUserMessage').filter((m) => String(m.content ?? '').startsWith(SYSTEM_NOTE))).toEqual([]);
    expect(h.logs.filter((l) => /claimed|said it had put|asking it to send it/i.test(l.msg))).toEqual([]);
  });
});
