import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatFromPortal } from '../voice/hub.js';
import { History, HistoryStore } from './history.js';

const FOLDER = 's_0123456789abcdef0123';
const DOC = 'c'.repeat(32);
const RUN = { t: 'run', command: 'go test ./...', ok: true, exitCode: 0, timedOut: false, durationMs: 9100, output: 'ok  \tx\t0.01s', truncated: false };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-obj-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('History.appendObject', () => {
  it('writes a card as a line of TAi with its summary as the text, and gives it back with its object', () => {
    const history = new History(path.join(dir, 'h.jsonl'));
    const entry = history.appendObject(RUN, new Date('2026-11-07T10:00:00Z'));
    expect(entry).toMatchObject({ n: 1, role: 'assistant', kind: 'object', text: 'Ran go test ./... (exit 0, 9.1 s)', obj: RUN });
    expect(history.since(0)[0]).toMatchObject({ kind: 'object', obj: RUN });
    expect(history.tail(10)[0].obj).toEqual(RUN);
  });

  it('writes nothing for what is not a card, and cleans what it writes', () => {
    const history = new History(path.join(dir, 'h.jsonl'));
    expect(history.appendObject({ t: 'video' })).toBeNull();
    expect(history.appendObject({ t: 'doc', doc: 'nope', title: 'x', pages: 1 })).toBeNull();
    expect(history.last).toBe(0);
    const got = history.appendObject({ ...RUN, injected: '<script>', command: '  go   run .  ' });
    expect(got?.obj).toEqual({ ...RUN, command: 'go run .' });
    expect(got?.obj && 'injected' in got.obj).toBe(false);
  });

  it('survives a restart: the card is read back, and a line whose object is no longer valid is skipped', () => {
    const file = path.join(dir, 'h.jsonl');
    const history = new History(file);
    history.append('user', 'hello');
    history.appendObject({ t: 'doc', doc: DOC, title: 'Raft slides', pages: 32 });
    fs.appendFileSync(file, JSON.stringify({ n: 3, ts: '2026-11-07T10:00:00Z', role: 'assistant', text: 'broken', kind: 'object', obj: { t: 'doc', doc: 'not-an-id' } }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ n: 4, ts: '2026-11-07T10:00:00Z', role: 'assistant', text: 'no object', kind: 'object' }) + '\n');
    const again = new History(file);
    expect(again.since(0).map((e) => e.n)).toEqual([1, 2]);
    expect(again.since(0)[1].obj).toMatchObject({ t: 'doc', doc: DOC });
  });

  it('is not something the student said, and is a card when a reaction names it', () => {
    const history = new History(path.join(dir, 'h.jsonl'));
    const card = history.appendObject(RUN);
    expect(history.latestUser(60_000, Date.now())).toBeUndefined();
    history.append('user', '', new Date(), { kind: 'react', to: card?.n, emoji: '👍' });
    expect(history.reactionsSinceLastMessage()).toEqual([{ to: 1, emoji: '👍', excerpt: 'Ran go test ./... (exit 0, 9.1 s)' }]);
  });
});

describe('chatFromPortal: a card from the voice side', () => {
  it('appends it through the same gate and wakes the page, and throws for what the gate refuses', () => {
    const store = new HistoryStore(dir);
    const woken: string[] = [];
    const { appendChat } = chatFromPortal(store, (folder) => woken.push(folder));
    appendChat(FOLDER, 'assistant', '', { kind: 'object', obj: RUN });
    // a card the gate refuses is a throw: whoever tells a model "the student sees it" must not say so about it
    expect(() => appendChat(FOLDER, 'assistant', '', { kind: 'object', obj: { t: 'run' } })).toThrow('did not take the card');
    expect(() => appendChat(FOLDER, 'assistant', '', { kind: 'object' })).toThrow('did not take the card');
    const lines = store.forFolder(FOLDER).since(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'object', obj: RUN });
    expect(woken).toEqual([FOLDER]);
  });

  it('keeps cards out of what a call starts knowing of the chat', () => {
    const store = new HistoryStore(dir);
    const { appendChat, recentChat } = chatFromPortal(store, () => undefined);
    appendChat(FOLDER, 'user', 'hello');
    appendChat(FOLDER, 'assistant', '', { kind: 'object', obj: RUN });
    appendChat(FOLDER, 'assistant', 'hi there');
    expect(recentChat?.(FOLDER, 10)).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
    ]);
  });
});
