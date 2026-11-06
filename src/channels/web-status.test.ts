/**
 * What the web channel holds for the student's page besides the outbox: the status of a chat's turn and the "looked at" chips of its answer
 * (src/turn-status.ts, src/sources.ts; docs/PROGRESS.md).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebChannel, type OutboxEntry } from './web.js';

const JID = 'web:s_0123456789abcdef0123';

function channel(queuePosition?: (jid: string) => { ahead: number } | null) {
  process.env.TAI_WEB_OUTBOX_LOG = '0';                 // no copy of the test's messages in the real store
  const web = new WebChannel({ onMessage: () => undefined, onChatMetadata: () => undefined, registeredGroups: () => ({}), registerGroup: () => undefined, solvers: [], queuePosition });
  const heard: OutboxEntry[] = [];
  web.onOutbound((entry) => heard.push(entry));
  return { web, heard };
}

describe('the status of a chat\'s turn', () => {
  beforeEach(() => {
    process.env.TAI_CHOICES = '0';
  });
  afterEach(() => {
    delete process.env.TAI_CHOICES;
  });

  it('is there only while the chat is typing: a label that outlives the work would be a lie', async () => {
    const { web } = channel();
    web.turn.setStatus(JID, { state: 'working', label: 'Checking Canvas' });
    expect(web.getStatus(JID)).toBeUndefined();                       // not typing yet
    await web.setTyping(JID, true);
    web.turn.setStatus(JID, { state: 'working', label: 'Checking Canvas' });
    expect(web.getStatus(JID)).toEqual({ state: 'working', label: 'Checking Canvas' });
    await web.setTyping(JID, false);
    expect(web.getStatus(JID)).toBeUndefined();
    await web.setTyping(JID, true);                                   // the next turn does not start with the last one's label
    expect(web.getStatus(JID)).toBeUndefined();
  });

  it('is "queued" with the place the queue gives, read when asked: never a number the queue did not give', async () => {
    let place: { ahead: number } | null = { ahead: 2 };
    const { web } = channel(() => place);
    await web.setTyping(JID, true);
    web.turn.setStatus(JID, { state: 'working', label: 'Thinking' });
    expect(web.getStatus(JID)).toEqual({ state: 'queued', ahead: 2 });
    place = { ahead: 0 };
    expect(web.getStatus(JID)).toEqual({ state: 'queued', ahead: 0 });
    place = null;                                                     // the container started: what the runner says is what the page shows
    expect(web.getStatus(JID)).toEqual({ state: 'working', label: 'Thinking' });
  });

  it('is nothing for a chat the runner has said nothing about', async () => {
    const { web } = channel(() => null);
    await web.setTyping(JID, true);
    expect(web.getStatus(JID)).toBeUndefined();
  });

  it('tells the listeners when it changes, not when it does not, and puts nothing in the outbox', async () => {
    const { web, heard } = channel();
    await web.setTyping(JID, true);
    const before = heard.filter((e) => e.kind !== 'status').length;
    web.turn.setStatus(JID, { state: 'working', label: 'Thinking' });
    web.turn.setStatus(JID, { state: 'working', label: 'Thinking' });          // the same again: nothing to tell
    web.turn.setStatus(JID, { state: 'working', label: 'Searching Piazza' });
    web.turn.refreshStatus(JID);                                               // the queue moved
    expect(heard.filter((e) => e.kind === 'status')).toHaveLength(3);
    expect(heard.filter((e) => e.kind !== 'status')).toHaveLength(before);
    expect((web as unknown as { outbox: OutboxEntry[] }).outbox.filter((e) => e.kind === 'status')).toEqual([]);     // what /api/outbox serves
  });
});

describe('the chips of an answer', () => {
  beforeEach(() => {
    process.env.TAI_CHOICES = '0';
  });
  afterEach(() => {
    delete process.env.TAI_CHOICES;
  });

  it('go with the answer that takes them, once, in order of use, and with no other message', async () => {
    const { web, heard } = channel();
    web.turn.addSources(JID, 2, [{ kind: 'piazza', label: '@45 Raft timeouts' }]);
    web.turn.addSources(JID, 1, [{ kind: 'canvas', label: 'Homework 6', url: 'https://canvas.example.edu/courses/1/assignments/107' }]);
    const sources = web.turn.takeSources(JID);
    await web.sendMessage(JID, 'Here is what I found.', { sources });
    await web.sendMessage(JID, 'And a notice with none.', undefined);
    const texts = heard.filter((e) => e.kind === 'text');
    expect(texts[0].sources?.map((c) => c.label)).toEqual(['Homework 6', '@45 Raft timeouts']);
    expect(texts[1].sources).toBeUndefined();
    expect(web.turn.takeSources(JID)).toBeUndefined();                  // taken once
  });

  it('are left out of the entry when there are none', async () => {
    const { web, heard } = channel();
    await web.sendMessage(JID, 'Plain.', { sources: [] });
    expect('sources' in heard[0]).toBe(false);
  });

  it('are forgotten when a turn begins, and are one chat\'s own', async () => {
    const { web } = channel();
    web.turn.addSources(JID, 1, [{ kind: 'canvas', label: 'x' }]);
    web.turn.resetSources(JID);
    expect(web.turn.takeSources(JID)).toBeUndefined();
    web.turn.addSources(JID, 1, [{ kind: 'canvas', label: 'y' }]);
    expect(web.turn.takeSources('web:s_other')).toBeUndefined();
    expect(web.turn.takeSources(JID)?.[0].label).toBe('y');
  });
});
