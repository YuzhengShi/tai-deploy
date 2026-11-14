import { afterEach, describe, expect, it } from 'vitest';

import { createStudentStateWriter, STATE_SYSTEM, type StudentStateWriter } from '../student-state-writer.js';
import type { WorkFact } from '../work-facts.js';
import { completion } from './testing/fake-gateway.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import { BrowserClient, GATEWAY_KEY, Harness, createHarness } from './testing/harness.js';
import type { Caller } from './types.js';

type CallWork = { folder: string; turns: Array<{ role: 'student' | 'tai'; text: string }>; facts: string[] };

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

const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** The call goes on a little: the student says something, TAi answers, the student says something more. */
async function talk(browser: BrowserClient, conn: FakeDeepgramConnection): Promise<void> {
  conn.userSays('my terraform plan says everything is fine');
  conn.userSays('but the load balancer still cannot reach my instances');
  conn.agentSays('which port is in your ingress rule?');
  conn.userSays('port 80 I think, my code is in cs6650-hw2');
  await browser.next('transcript', (e) => e.role === 'agent');
  await new Promise((r) => setTimeout(r, 60));
}

function hangUp(browser: BrowserClient, conn: FakeDeepgramConnection): void {
  browser.send({ type: 'end' });
  conn.close(1000);
}

describe('the state writer\'s pass over a finished call', () => {
  it('is handed the call\'s merged turns and the session\'s facts once, with the folder, before the summary\'s model call is back', async () => {
    const seen: CallWork[] = [];
    h = await createHarness({
      deps: {
        workFromCall: async (input) => {
          seen.push(input);
        },
      },
    });
    const u = h.user(1);
    const { browser, conn } = await startCall(h, u);
    await talk(browser, conn);
    h.gw.respond = () => ({ ...completion('We talked about the Terraform security group.'), delayMs: 300 });
    hangUp(browser, conn);
    await until(() => seen.length === 1);
    expect(h.summaries).toHaveLength(0);                                      // the pass began beside the summary, not after it
    expect(seen[0].folder).toBe(u.folder);
    expect(seen[0].turns).toEqual([
      { role: 'student', text: 'my terraform plan says everything is fine but the load balancer still cannot reach my instances' },
      { role: 'tai', text: 'which port is in your ingress rule?' },
      { role: 'student', text: 'port 80 I think, my code is in cs6650-hw2' },
    ]);
    expect(seen[0].facts[0]).toBe('nothing was put in the chat during the call, whatever TAi may have said');
    await until(() => h!.summaries.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(1);                                             // once
    expect(h.chat.filter((c) => c.kind === 'activity')).toHaveLength(1);
  });

  it('does not hold up the other post-call writes, and the end of the call waits for it only workWaitMs', async () => {
    h = await createHarness({
      timing: { workWaitMs: 150 },
      deps: { workFromCall: () => new Promise<void>(() => undefined) },       // a pass that never ends
    });
    const u = h.user(1);
    const { browser, conn } = await startCall(h, u);
    await talk(browser, conn);
    hangUp(browser, conn);
    await browser.next('closed');
    await until(() => h!.summaries.length === 1 && h!.chat.some((c) => c.kind === 'activity'));    // chat, voice-sessions.md and the text agent's row, all done
    const t = Date.now();
    await h.hub.close();                                                       // waits for the call's notes, the pass included
    expect(Date.now() - t).toBeLessThan(2000);
    expect(h.hub.isActive(u.folder)).toBe(false);
  });

  it('costs a pass that throws, or rejects, one warning and nothing else', async () => {
    for (const how of ['throws', 'rejects'] as const) {
      h = await createHarness({
        deps: {
          workFromCall: ((): Promise<void> => {
            if (how === 'throws') throw new Error('boom: throws');
            return Promise.reject(new Error('boom: rejects'));
          }) as never,
        },
      });
      const { browser, conn } = await startCall(h, h.user(1));
      await talk(browser, conn);
      hangUp(browser, conn);
      await until(() => h!.summaries.length === 1 && h!.chat.some((c) => c.kind === 'activity'));
      await until(() => h!.logs.some((l) => l.level === 'warn' && l.msg === 'voice: the state writer failed on the call'));
      expect(h.logs.find((l) => l.msg === 'voice: the state writer failed on the call')?.obj.err).toBe(`boom: ${how}`);
      await h.close();
      h = null;
    }
  });

  it('is not asked for a call in which nobody spoke, and a hub without a writer ends its calls as it always did', async () => {
    const seen: CallWork[] = [];
    h = await createHarness({ deps: { workFromCall: async (input) => void seen.push(input) } });
    const first = await startCall(h, h.user(1));
    hangUp(first.browser, first.conn);                                         // the student said nothing
    await first.browser.next('closed');
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([]);
    await h.close();
    h = await createHarness();
    const { browser, conn } = await startCall(h, h.user(1));
    await talk(browser, conn);
    hangUp(browser, conn);
    await until(() => h!.summaries.length === 1 && h!.chat.some((c) => c.kind === 'activity'));
  });

  it('with the real writer: the call goes to the gateway once, beside the summary, and what the model finds is kept for the student', async () => {
    const kept: Array<{ folder: string; fact: WorkFact }> = [];
    let writer: StudentStateWriter | null = null;
    h = await createHarness({ deps: { workFromCall: (input) => writer!.fromCall(input) } });
    writer = createStudentStateWriter({
      rememberWork: (folder, fact) => void kept.push({ folder, fact }),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      env: { TAI_STATE_MODEL: 'state-model', TAI_VOICE_LLM_URL: h.gw.url, TAI_VOICE_LLM_KEY: GATEWAY_KEY },
      readEnv: () => ({}),
    });
    h.gw.respond = (body) => {
      const system = String((body.messages as Array<{ content?: unknown }>)?.[0]?.content ?? '');
      if (system === STATE_SYSTEM) {
        return completion(
          JSON.stringify({
            issues: [{ problem: 'The security group allows port 80 while the app listens on 8080, so the load balancer is blocked.', confidence: 0.9 }],
            thread: { topic: 'Terraform ingress', left_open: 'Change the ingress port and run the plan again.', confidence: 0.9 },
            repo: { assignment: 'HW2', name: 'cs6650-hw2', confidence: 0.95 },
          }),
        );
      }
      return completion('We talked about the Terraform security group.');
    };
    const u = h.user(1);
    const { browser, conn } = await startCall(h, u);
    await talk(browser, conn);
    hangUp(browser, conn);
    await until(() => kept.length === 3);
    await until(() => h!.summaries.length === 1);
    const stateRequests = h.gw.requests.filter((r) => String((r.body.messages as Array<{ content?: unknown }>)?.[0]?.content ?? '') === STATE_SYSTEM);
    expect(stateRequests).toHaveLength(1);
    expect(stateRequests[0].body.model).toBe('state-model');
    expect(String((stateRequests[0].body.messages as Array<{ content: string }>)[1].content)).toContain('Student: port 80 I think, my code is in cs6650-hw2');
    expect(kept.map((k) => k.fact.key)).toEqual([expect.stringMatching(/^issue:/), 'thread:terraform-ingress', 'repo:hw2']);
    expect(kept.every((k) => k.folder === u.folder)).toBe(true);
  });
});
