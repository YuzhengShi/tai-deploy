/**
 * What the web channel does with the preview of a reply while it is written (src/stream-preview.ts, docs/STREAMING.md): nothing without the flag,
 * and with it a part of the status the page reads while the chat types: never a message, never in the outbox, gone with the answer, the end of
 * typing or the end of the turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TurnStatus, progressForwarder, type ProgressEvent } from '../turn-status.js';
import { WebChannel, type OutboxEntry } from './web.js';

const JID = 'web:s_0123456789abcdef0123';

function channel(queuePosition?: (jid: string) => { ahead: number } | null) {
  process.env.TAI_WEB_OUTBOX_LOG = '0';                 // no copy of the test's messages in the real store
  const web = new WebChannel({ onMessage: () => undefined, onChatMetadata: () => undefined, registeredGroups: () => ({}), registerGroup: () => undefined, solvers: [], queuePosition });
  const heard: OutboxEntry[] = [];
  web.onOutbound((entry) => heard.push(entry));
  const forward = (jid = JID, muted?: () => boolean) => progressForwarder({ jid, turn: new TurnStatus(), view: web.turn, muted });
  return { web, heard, forward };
}

const text = (n: number, words: string): ProgressEvent => ({ type: 'text', n, text: words });
const outbox = (web: WebChannel): OutboxEntry[] => (web as unknown as { outbox: OutboxEntry[] }).outbox;

afterEach(() => {
  delete process.env.TAI_PORTAL_STREAM;
  delete process.env.TAI_CHOICES;
});

describe('with the flag off (the default)', () => {
  beforeEach(() => {
    delete process.env.TAI_PORTAL_STREAM;
  });

  /** A whole turn as the container reports it, text lines and all (a runner that was not asked would not write them; this one does, to be sure they are nothing). */
  const turn: ProgressEvent[] = [
    { type: 'thinking' },
    text(1, 'Let me look. Checking Canvas now. And'),
    { type: 'tool', name: 'canvas_query', phase: 'start' },
    { type: 'tool', name: 'canvas_query', phase: 'end' },
    { type: 'thinking' },
    text(2, 'Homework 6 is due Friday. Start with the worker pool. Then'),
    { type: 'textError' },
  ];

  async function run(events: ProgressEvent[]) {
    const { web, heard, forward } = channel();
    await web.setTyping(JID, true);
    web.turn.beginTurn?.(JID);
    web.turn.setStatus(JID, { state: 'working' });
    const f = forward();
    const statuses: unknown[] = [];
    for (const event of events) {
      f(event);
      statuses.push(web.getStatus(JID) ?? null);
    }
    return { web, heard, statuses };
  }

  it('is a status with no preview in it, and the very same entries and statuses as a turn that has no text lines in it', async () => {
    const withText = await run(turn);
    const without = await run(turn.filter((e) => e.type !== 'text' && e.type !== 'textError'));
    const textless = turn.map((e, i) => ({ e, i })).filter(({ e }) => e.type !== 'text' && e.type !== 'textError').map(({ i }) => i);
    expect(withText.statuses.filter((_, i) => textless.includes(i))).toEqual(without.statuses);
    expect(withText.heard.map((e) => e.kind)).toEqual(without.heard.map((e) => e.kind));
    expect(JSON.stringify(withText.statuses)).not.toContain('partial');
    expect(withText.statuses[withText.statuses.length - 1]).toEqual({ state: 'working', label: 'Thinking' });
  });

  it('does nothing on a clear when nothing is shown: no entry for the listeners, no state', async () => {
    const { web, heard } = channel();
    await web.setTyping(JID, true);
    const before = heard.length;
    web.turn.previewClear?.(JID);
    web.turn.previewClear?.(JID);
    web.turn.beginTurn?.(JID);
    expect(heard.length).toBe(before);
    expect((web as unknown as { previews: Map<string, unknown> }).previews.size).toBe(0);
  });

  it('ignores a text event a container should not have written, even a good one', async () => {
    const { web, heard } = channel();
    await web.setTyping(JID, true);
    web.turn.setStatus(JID, { state: 'working', label: 'Thinking' });
    const before = heard.length;
    web.turn.previewEvent?.(JID, { type: 'text', n: 1, text: 'Hello there. And so on. More' });
    expect(web.getStatus(JID)).toEqual({ state: 'working', label: 'Thinking' });
    expect(heard.length).toBe(before);
  });
});

describe('with the flag on', () => {
  beforeEach(() => {
    process.env.TAI_PORTAL_STREAM = '1';
    process.env.TAI_CHOICES = '1';
  });

  async function typing(options: { queuePosition?: (jid: string) => { ahead: number } | null; jid?: string } = {}) {
    const made = channel(options.queuePosition);
    const jid = options.jid ?? JID;
    await made.web.setTyping(jid, true);
    made.web.turn.beginTurn?.(jid);
    made.web.turn.setStatus(jid, { state: 'working' });
    return { ...made, jid, f: made.forward(jid) };
  }

  it('puts whole sentences in the status while the chat types, and grows it as the reply grows', async () => {
    const { web, f } = await typing();
    f({ type: 'thinking' });
    f(text(1, 'Raft elects a leader'));
    expect(web.getStatus(JID)).toEqual({ state: 'working', label: 'Thinking' });
    f(text(1, 'Raft elects a leader. A candidate'));
    expect(web.getStatus(JID)).toEqual({ state: 'working', label: 'Thinking', partial: 'Raft elects a leader.' });
    f(text(1, 'Raft elects a leader. A candidate needs votes. Then'));
    expect(web.getStatus(JID)?.partial).toBe('Raft elects a leader. A candidate needs votes.');
  });

  it('is never a message: the listeners hear only status entries with no words in them, and the outbox has nothing', async () => {
    const { web, heard, f } = await typing();
    const outboxBefore = outbox(web).length;
    f({ type: 'thinking' });
    f(text(1, 'One is first. Two is second. And'));
    f(text(1, 'One is first. Two is second. And three. Then'));
    f({ type: 'tool', name: 'canvas_query', phase: 'start' });
    const after = heard.filter((e) => e.kind !== 'typing');
    expect(after.length).toBeGreaterThan(2);
    for (const entry of after) {
      expect(entry.kind).toBe('status');
      expect(Object.keys(entry).sort()).toEqual(['jid', 'kind', 'seq', 'ts']);       // no `text`, no `caption`: what a notification hook reads
    }
    expect(outbox(web).length).toBe(outboxBefore);                                      // (what /api/outbox serves: nothing was added)
    expect(outbox(web).some((e) => e.kind === 'text' || e.kind === 'image')).toBe(false);
  });

  it('is cleared, and the page woken, when a tool starts or a model request begins; the label is the tool\'s', async () => {
    const { web, heard, f } = await typing();
    f({ type: 'thinking' });
    f(text(1, 'Let me look. Checking Canvas now. And'));
    expect(web.getStatus(JID)?.partial).toBe('Let me look. Checking Canvas now.');
    const before = heard.length;
    f({ type: 'tool', name: 'canvas_query', phase: 'start' });
    expect(web.getStatus(JID)).toEqual({ state: 'working', label: 'Checking Canvas' });
    expect(heard.length).toBeGreaterThan(before);
    f({ type: 'tool', name: 'canvas_query', phase: 'end' });
    f({ type: 'thinking' });
    f(text(2, 'Homework 6 is due. And'));
    expect(web.getStatus(JID)?.partial).toBe('Homework 6 is due.');
    f({ type: 'thinking' });
    expect(web.getStatus(JID)).toEqual({ state: 'working', label: 'Thinking' });
  });

  it('is replaced by the answer in one step: the answer is pushed, and the status that goes with it has no preview left', async () => {
    const { web, heard, f } = await typing();
    f({ type: 'thinking' });
    f(text(1, 'Raft elects a leader. A candidate needs votes. And'));
    expect(web.getStatus(JID)?.partial).toBeDefined();
    let statusAtAnswer: unknown = 'not heard';
    web.onOutbound((entry) => {
      if (entry.kind === 'text') statusAtAnswer = web.getStatus(JID) ?? null;
    });
    await web.sendMessage(JID, 'Raft elects a leader. A candidate needs votes. And a majority wins.');
    expect(statusAtAnswer).toEqual({ state: 'working', label: 'Thinking' });          // when the page is woken by the answer, there is nothing to draw twice
    expect(heard.filter((e) => e.kind === 'text')).toHaveLength(1);
    expect(web.getStatus(JID)?.partial).toBeUndefined();
  });

  it('is gone when the turn ends with no answer from this path (the send tool\'s, an internal-only reply, an apology): typing stops', async () => {
    const { web, f } = await typing();
    f({ type: 'thinking' });
    f(text(1, 'Raft elects a leader. A candidate needs votes. And'));
    expect(web.getStatus(JID)?.partial).toBeDefined();
    web.turn.setStatus(JID, null);                  // index.ts stopTypingIndicator
    await web.setTyping(JID, false);
    expect(web.getStatus(JID)).toBeUndefined();
    await web.setTyping(JID, true);                 // the next turn does not start with the last one's words
    web.turn.setStatus(JID, { state: 'working' });
    expect(web.getStatus(JID)).toEqual({ state: 'working' });
  });

  it('is held back while the answer goes out another way (the marker of the send tool): nothing is shown, and what was is cleared', async () => {
    const { web, jid } = await typing();
    let marker = false;
    const f = progressForwarder({ jid, turn: new TurnStatus(), view: web.turn, muted: () => marker });
    f({ type: 'thinking' });
    f(text(1, 'Here you go. And so. Then'));
    expect(web.getStatus(jid)?.partial).toBe('Here you go. And so.');
    marker = true;
    f(text(1, 'Here you go. And so. Then more. And'));
    expect(web.getStatus(jid)?.partial).toBeUndefined();
  });

  it('is nothing for a chat that is not typing, for the instructor\'s admin chat, and while the message waits in line', async () => {
    const idle = channel();
    idle.web.turn.setStatus(JID, { state: 'working', label: 'Thinking' });
    idle.web.turn.previewEvent?.(JID, { type: 'text', n: 1, text: 'Hello there. And so on. More' });
    await idle.web.setTyping(JID, true);
    idle.web.turn.setStatus(JID, { state: 'working', label: 'Thinking' });
    expect(idle.web.getStatus(JID)).toEqual({ state: 'working', label: 'Thinking' });

    const admin = await typing({ jid: 'web:main' });
    admin.f({ type: 'thinking' });
    admin.f(text(1, 'Hello there. And so on. More'));
    expect(admin.web.getStatus('web:main')?.partial).toBeUndefined();

    let place: { ahead: number } | null = null;
    const queued = await typing({ queuePosition: () => place });
    queued.f({ type: 'thinking' });
    queued.f(text(1, 'Hello there. And so on. More'));
    place = { ahead: 2 };
    expect(queued.web.getStatus(JID)).toEqual({ state: 'queued', ahead: 2 });
  });

  it('is dropped for the rest of the turn on anything unusual, and a new turn starts clean', async () => {
    const { web, jid, f } = await typing();
    f({ type: 'thinking' });
    f(text(3, 'Hello there. And so on. More'));
    expect(web.getStatus(jid)?.partial).toBe('Hello there. And so on.');
    f(text(2, 'Hello there. And so on. More'));                         // a number that goes back
    expect(web.getStatus(jid)?.partial).toBeUndefined();
    f({ type: 'thinking' });
    f(text(4, 'A perfectly good reply. With a second sentence. And'));
    expect(web.getStatus(jid)?.partial).toBeUndefined();                // dropped: nothing more this turn
    web.turn.beginTurn?.(jid);
    f(text(5, 'A perfectly good reply. With a second sentence. And'));
    expect(web.getStatus(jid)?.partial).toBe('A perfectly good reply. With a second sentence.');
  });

  it('shows the words before an options block, and none of the block', async () => {
    const { web, f } = await typing();
    f({ type: 'thinking' });
    f(text(1, 'Which of these is true of a Raft term?\n<choices>\n<option>Every heart'));
    expect(web.getStatus(JID)?.partial).toBe('Which of these is true of a Raft term?');
    f(text(1, 'Which of these is true of a Raft term?\n<choices>\n<option>Every heartbeat starts a term</option><option correct>One leader per term</option>'));
    expect(JSON.stringify(web.getStatus(JID))).not.toMatch(/option|correct|heartbeat|leader/);
  });
});
