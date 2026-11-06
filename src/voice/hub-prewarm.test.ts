/**
 * A tool host started before the call asks for it. The page tells the server that the call button was pressed (POST /api/voice/warm, before the
 * browser asks for the microphone), the hub starts the student's tool host through the pool, and the call that follows takes it over. The rules
 * are the hub's: voice on, no call open, room in the pool and on the lines, a minute between two starts, the student's own host only.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createVoiceHub, VoiceDeps, VoiceHub } from './hub.js';
import { BrowserClient, Harness, createHarness, makeUser } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import { FakeToolHost } from './tool-host.js';
import type { Caller } from './types.js';

const KEEP = { TAI_VOICE_TOOLHOST_KEEP_SEC: '60' };

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ---------------------------------------------------------------- the hub alone: the rules

interface Alone {
  hub: VoiceHub;
  hosts: FakeToolHost[];
  root: string;
  clock: { now: number };
  close(): Promise<void>;
}

const alone: Alone[] = [];
afterEach(async () => {
  for (const a of alone.splice(0)) await a.close();
});

/** A hub with no sockets and no Deepgram (warm needs neither): every tool host it makes is recorded. */
function aloneHub(opts: { env?: Record<string, string>; hostDelayMs?: number; spareContainer?: () => boolean; usage?: Record<string, number>; spawnThrows?: boolean; maxConcurrent?: string } = {}): Alone {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-prewarm-'));
  const secretFile = path.join(root, 'portal-secret');
  fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
  const storeDir = path.join(root, 'store');
  fs.mkdirSync(storeDir, { recursive: true });
  const clock = { now: Date.UTC(2026, 10, 5, 18, 0, 0) };
  if (opts.usage) {
    const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clock.now));
    fs.writeFileSync(path.join(storeDir, 'voice-usage.json'), JSON.stringify({ version: 1, days: { [day]: opts.usage } }));
  }
  const hosts: FakeToolHost[] = [];
  const deps: VoiceDeps = {
    groupsDir: path.join(root, 'groups'),
    dataDir: path.join(root, 'data'),
    storeDir,
    publicBase: 'https://tai.example/tai',
    publicOrigin: 'https://tai.example',
    secretFile,
    appendChat: () => undefined,
    recordVoiceSummary: () => undefined,
    preemptTextAgent: () => undefined,
    spawnToolHost: () => {
      if (opts.spawnThrows) throw new Error('no such group');
      const host = new FakeToolHost();
      host.startDelayMs = opts.hostDelayMs ?? 0;
      hosts.push(host);
      return host;
    },
    spareContainer: opts.spareContainer,
    readEnv: () => ({ DEEPGRAM_API_KEY: 'dg-test-key' }),
    env: { TAI_VOICE: '1', ...KEEP, ...(opts.env ?? {}) },
    now: () => clock.now,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const hub = createVoiceHub(deps);
  if (!hub) throw new Error('the hub did not start');
  const made: Alone = {
    hub,
    hosts,
    root,
    clock,
    close: async () => {
      await hub.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  alone.push(made);
  return made;
}

describe('warm: starting a student\'s tool host ahead of their call', () => {
  const ana = makeUser(1);
  const bob = makeUser(2);

  it('starts the host at once and answers before the container is up (it takes seconds)', async () => {
    const a = aloneHub({ hostDelayMs: 600 });
    const began = Date.now();
    expect(a.hub.warm(ana)).toEqual({ ok: true, state: 'warming' });
    expect(Date.now() - began).toBeLessThan(250);
    expect(a.hosts).toHaveLength(1);
    expect(a.hosts[0].starts).toBe(1); // the container is on its way now
    expect(a.hosts[0].alive).toBe(false); // and not up: nobody waited for it
    await until(() => a.hosts[0].alive);
  });

  it('says "warm" and starts nothing when the student has a host waiting already', () => {
    const a = aloneHub();
    expect(a.hub.warm(ana).state).toBe('warming');
    a.clock.now += 61_000; // a minute later: the rule of the minute is not what answers
    expect(a.hub.warm(ana)).toEqual({ ok: true, state: 'warm' });
    expect(a.hosts).toHaveLength(1);
  });

  it('starts at most one a minute for a student, and another student has their own minute', () => {
    const a = aloneHub({ env: { TAI_VOICE_TOOLHOST_KEEP_SEC: '1' } });
    expect(a.hub.warm(ana).state).toBe('warming');
    expect(a.hub.warm(ana)).toEqual({ ok: false, state: 'recent' });
    a.clock.now += 59_000;
    expect(a.hub.warm(ana)).toEqual({ ok: false, state: 'recent' });
    expect(a.hub.warm(bob).state).toBe('warming');
    expect(a.hosts).toHaveLength(2);
  });

  it('starts another once the minute is over and the first one has been closed after its keep time', async () => {
    const a = aloneHub({ env: { TAI_VOICE_TOOLHOST_KEEP_SEC: '1' } });
    expect(a.hub.warm(ana).state).toBe('warming');
    await until(() => a.hosts[0].closed, 2500); // nobody called: it goes after TAI_VOICE_TOOLHOST_KEEP_SEC
    a.clock.now += 61_000;
    expect(a.hub.warm(ana).state).toBe('warming');
    expect(a.hosts).toHaveLength(2);
  });

  it('never takes the place of another student\'s host: a full pool refuses, and nobody\'s host is closed', () => {
    const a = aloneHub({ env: { TAI_VOICE_TOOLHOST_KEEP_MAX: '1' } });
    expect(a.hub.warm(ana).state).toBe('warming');
    expect(a.hub.warm(bob)).toEqual({ ok: false, state: 'full' });
    expect(a.hosts).toHaveLength(1);
    expect(a.hosts[0].closed).toBe(false);
  });

  it('is off without a pool (TAI_VOICE_TOOLHOST_KEEP_SEC=0: nobody would close a host nobody called for), and for anything that is not a student of this host', () => {
    const none = aloneHub({ env: { TAI_VOICE_TOOLHOST_KEEP_SEC: '0' } });
    expect(none.hub.warm(ana)).toEqual({ ok: false, state: 'off' });
    expect(none.hosts).toHaveLength(0);
    const a = aloneHub();
    for (const bad of [{ ...ana, folder: '../../x' }, { ...ana, folder: '' }, undefined as unknown as Caller]) expect(a.hub.warm(bad)).toEqual({ ok: false, state: 'off' });
    expect(a.hosts).toHaveLength(0);
  });

  it('is off once the service is going down, and a host started before is closed with it', async () => {
    const a = aloneHub();
    expect(a.hub.warm(ana).state).toBe('warming');
    await a.hub.close();
    expect(a.hosts[0].closed).toBe(true);
    expect(a.hub.warm(bob)).toEqual({ ok: false, state: 'off' });
  });

  it('refuses a student who has used the day\'s voice minutes: their call would be refused, and a container would be for nothing', () => {
    const a = aloneHub({ usage: { [ana.folder]: 45 * 60 - 30, [bob.folder]: 10 * 60 } });
    expect(a.hub.warm(ana)).toEqual({ ok: false, state: 'budget' });
    expect(a.hub.warm(bob).state).toBe('warming');
    expect(a.hosts).toHaveLength(1);
  });

  it('asks the orchestrator whether the machine has a container to spare, when it is given a way to ask: the last slot is for a chat', () => {
    let spare = false;
    const a = aloneHub({ spareContainer: () => spare });
    expect(a.hub.warm(ana)).toEqual({ ok: false, state: 'busy' });
    expect(a.hosts).toHaveLength(0);
    spare = true;
    // the refusal used up the student's minute (a refused attempt counts as one: it used to be free, and a held button went through the pool every time)
    expect(a.hub.warm(ana)).toEqual({ ok: false, state: 'recent' });
    expect(a.hosts).toHaveLength(0);
    a.clock.now += 61_000;
    expect(a.hub.warm(ana).state).toBe('warming');
    expect(a.hosts).toHaveLength(1);
  });

  it('counts a refused attempt against the minute whatever the reason: the budget, a full pool, a spent line', () => {
    const budget = aloneHub({ usage: { [ana.folder]: 45 * 60 - 30 } });
    expect(budget.hub.warm(ana)).toEqual({ ok: false, state: 'budget' });
    expect(budget.hub.warm(ana)).toEqual({ ok: false, state: 'recent' });
    const full = aloneHub({ env: { TAI_VOICE_TOOLHOST_KEEP_MAX: '1' } });
    expect(full.hub.warm(ana).state).toBe('warming');
    expect(full.hub.warm(bob)).toEqual({ ok: false, state: 'full' });
    expect(full.hub.warm(bob)).toEqual({ ok: false, state: 'recent' });
    full.clock.now += 61_000;
    expect(full.hub.warm(bob)).toEqual({ ok: false, state: 'full' });          // the minute is over: asked again, answered again
  });

  it('never throws: a host that cannot even be made is "off", and nothing is kept', () => {
    const a = aloneHub({ spawnThrows: true });
    expect(a.hub.warm(ana)).toEqual({ ok: false, state: 'off' });
    expect(() => a.hub.warm(ana)).not.toThrow();
  });
});

// ---------------------------------------------------------------- through the hub with a call

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function startCall(harness: Harness, user: Caller): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection }> {
  const browser = await harness.browser(user);
  browser.send({ type: 'start', mode: 'chat' });
  const conn = await harness.dg.connection(harness.dg.connections.length + 1);
  await browser.next('ready');
  return { browser, conn };
}

describe('warm and the call that follows it', () => {
  it('is taken over by the student\'s call: one container, started once, up before the first look-up asks for it', async () => {
    h = await createHarness({ env: KEEP, toolStartDelayMs: 150, toolHandlers: { canvas_query: () => ({ ok: true, text: 'nothing due' }) } });
    const u = h.user(1);
    expect(h.hub.warm(u)).toEqual({ ok: true, state: 'warming' });
    expect(h.toolHosts).toHaveLength(1);
    expect(h.toolHosts[0].starts).toBe(1);

    const { conn } = await startCall(h, u);
    expect(h.toolHosts).toHaveLength(1); // the call did not start a second one
    expect(h.toolHosts[0].starts).toBe(1);
    expect(h.toolHosts[0].refreshed).toBe(1); // it was handed on as a kept host is, with its caches refreshed
    conn.userSays('what is due this week?');
    conn.callFunction('fc-1', 'query_canvas', { action: 'upcoming' });
    const answer = await conn.waitFor('FunctionCallResponse', (m) => m.id === 'fc-1');
    expect(answer.content).toBe('nothing due');
    expect(h.toolHosts).toHaveLength(1);
  });

  it('starts nothing for a student whose call is on: the call has its own host', async () => {
    h = await createHarness({ env: KEEP });
    const u = h.user(1);
    await startCall(h, u);
    expect(h.toolHosts).toHaveLength(1);
    expect(h.hub.warm(u)).toEqual({ ok: false, state: 'active' });
    expect(h.toolHosts).toHaveLength(1);
  });

  it('starts nothing when every voice line is taken: the call that follows would be refused', async () => {
    h = await createHarness({ env: { ...KEEP, TAI_VOICE_MAX_CONCURRENT: '1' } });
    const first = h.user(1);
    const second = h.user(2);
    await startCall(h, first);
    expect(h.hub.warm(second)).toEqual({ ok: false, state: 'busy' });
    expect(h.toolHosts).toHaveLength(1);
  });

  it('makes no second host for a student whose call has just ended: until its slot is released the call is theirs, and then the host it gave back is waiting for them', async () => {
    h = await createHarness({ env: KEEP });
    const u = h.user(1);
    const { browser } = await startCall(h, u);
    browser.send({ type: 'end' });
    await browser.next('closed');
    // between "closed" and the end of the call's own clean-up: still the call's, or already the kept host, and never a new one
    expect(['active', 'warm']).toContain(h.hub.warm(u).state);
    await until(() => h!.logs.some((l) => l.msg === 'voice call ended'));
    expect(h.hub.warm(u)).toEqual({ ok: true, state: 'warm' });
    expect(h.toolHosts).toHaveLength(1);
    expect(h.toolHosts[0].closed).toBe(false);
  });

  it('is keyed as the call is: a student bound differently by the time of the call gets a new host, and the one warmed for the old binding is closed', async () => {
    h = await createHarness({ env: KEEP });
    const u = h.user(1);
    expect(h.hub.warm(u).state).toBe('warming');
    const rebound = { ...u, githubUsername: 'a-new-account' };
    h.hub.warm(rebound); // the same minute: refused, so nothing changes here
    const { browser } = await startCall(h, rebound);
    await until(() => h!.toolHosts.length === 2);
    expect(h.toolHosts[0].closed).toBe(true); // started for another binding: closed, never handed on
    expect(h.toolHosts[1].closed).toBe(false);
    browser.send({ type: 'end' });
    await browser.next('closed');
  });
});
