import { describe, expect, it } from 'vitest';

import { GUARDED_TOOLS, RetryGuard, stableStringify } from '../src/retry-guard.js';

const ok = { content: [{ type: 'text' as const, text: 'fine' }] };
const bad = { content: [{ type: 'text' as const, text: 'Piazza query failed: too fast' }], isError: true };

/** A guard with a clock the test moves, and a tool that answers what it is told to and counts how often it was reached. */
function setup(maxFailures = 2, windowMs = 90_000) {
  let clock = 1_000_000;
  const guard = new RetryGuard(maxFailures, windowMs, () => clock);
  const state = { reached: 0, answer: bad as { content: Array<{ type: 'text'; text: string }>; isError?: boolean } };
  const run = (tool: string, args: unknown) =>
    guard.run(tool, args, async () => {
      state.reached++;
      return state.answer;
    });
  return { guard, state, run, advance: (ms: number) => void (clock += ms) };
}

describe('the same failing lookup, asked again and again (12 times for one Piazza post in one call)', () => {
  it('sends a failing call twice and refuses the third, without sending it, in words that say what to do instead', async () => {
    const t = setup();
    const args = { action: 'get_post', params: { post_id: '882' } };
    expect(await t.run('piazza_query', args)).toBe(bad);
    expect(await t.run('piazza_query', args)).toBe(bad);
    const third = await t.run('piazza_query', args);
    expect(t.state.reached).toBe(2);                                                       // the third never reached the service
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toMatch(/^This exact piazza_query request has already failed 2 times in the last 90 seconds, so it was not sent again\./);
    expect(third.content[0].text).toMatch(/Do not repeat it: tell the student/);
    for (let i = 0; i < 10; i++) await t.run('piazza_query', args);                         // however often the model asks
    expect(t.state.reached).toBe(2);
  });

  it('does not touch a different call: another post, another action, another tool', async () => {
    const t = setup();
    const a = { action: 'get_post', params: { post_id: '882' } };
    await t.run('piazza_query', a);
    await t.run('piazza_query', a);
    expect((await t.run('piazza_query', a)).content[0].text).toMatch(/not sent again/);
    await t.run('piazza_query', { action: 'get_post', params: { post_id: '883' } });
    await t.run('piazza_query', { action: 'search', params: { query: 'raft' } });
    await t.run('canvas_query', a);
    expect(t.state.reached).toBe(5);
  });

  it('takes the same arguments in another order for the same call', async () => {
    const t = setup();
    await t.run('piazza_query', { action: 'get_post', params: { post_id: '1', x: '2' } });
    await t.run('piazza_query', { params: { x: '2', post_id: '1' }, action: 'get_post' });
    const third = await t.run('piazza_query', { params: { post_id: '1', x: '2' }, action: 'get_post' });
    expect(third.content[0].text).toMatch(/not sent again/);
    expect(t.state.reached).toBe(2);
  });

  it('forgets the failures of a call once it works, so a lookup that was only throttled is not held against the student', async () => {
    const t = setup();
    const args = { action: 'get_post', params: { post_id: '882' } };
    await t.run('piazza_query', args);                                                     // fails once
    t.state.answer = ok;
    expect(await t.run('piazza_query', args)).toBe(ok);                                    // works
    t.state.answer = bad;
    await t.run('piazza_query', args);
    await t.run('piazza_query', args);
    expect(t.state.reached).toBe(4);                                                       // two more failures were sent: the count had started again
    expect((await t.run('piazza_query', args)).content[0].text).toMatch(/not sent again/);
  });

  it('sends the call again once the window has gone by, and a refusal does not extend it', async () => {
    const t = setup(2, 60_000);
    const args = { action: 'recent_posts' };
    await t.run('piazza_query', args);
    await t.run('piazza_query', args);
    t.advance(59_000);
    expect((await t.run('piazza_query', args)).content[0].text).toMatch(/last 60 seconds/); // refused, and that does not count
    expect(t.state.reached).toBe(2);
    t.advance(2_000);                                                                      // 61 s after the failures
    await t.run('piazza_query', args);
    expect(t.state.reached).toBe(3);
  });

  it('counts a handler that throws as a failure and lets the error go on', async () => {
    const guard = new RetryGuard(2, 90_000, () => 5);
    const boom = async () => {
      throw new Error('disk full');
    };
    await expect(guard.run('canvas_query', { a: 1 }, boom)).rejects.toThrow('disk full');
    await expect(guard.run('canvas_query', { a: 1 }, boom)).rejects.toThrow('disk full');
    const third = await guard.run('canvas_query', { a: 1 }, async () => ok);
    expect(third.isError).toBe(true);
    expect(third.content[0].text).toMatch(/not sent again/);
  });

  it('keeps no more than a couple of hundred calls in mind', async () => {
    const t = setup(1);
    for (let i = 0; i < 300; i++) await t.run('canvas_query', { n: i });
    expect(t.state.reached).toBe(300);
    await t.run('canvas_query', { n: 299 });                                               // recent: still held
    expect(t.state.reached).toBe(300);
    await t.run('canvas_query', { n: 0 });                                                 // long forgotten: sent again
    expect(t.state.reached).toBe(301);
  });
});

describe('the guard used as two calls, by the voice tool host', () => {
  it('check says go ahead until the call has failed twice, record counts, and a success clears', () => {
    let clock = 5_000;
    const guard = new RetryGuard(2, 60_000, () => clock);
    const args = { action: 'search', params: { query: 'raft' } };
    expect(guard.check('piazza_query', args)).toBeNull();
    guard.record('piazza_query', args, true);
    expect(guard.check('piazza_query', args)).toBeNull();
    guard.record('piazza_query', args, true);
    expect(guard.check('piazza_query', args)).toMatch(/^This exact piazza_query request has already failed 2 times in the last 60 seconds/);
    expect(guard.check('piazza_query', { action: 'search', params: { query: 'paxos' } })).toBeNull();
    clock += 61_000;
    expect(guard.check('piazza_query', args)).toBeNull();                                   // the window has gone by
    guard.record('piazza_query', args, true);
    guard.record('piazza_query', args, false);                                              // a success after a failure forgets it
    guard.record('piazza_query', args, true);
    expect(guard.check('piazza_query', args)).toBeNull();
  });

  it('reset forgets everything: a new call is not held to what failed in the last one', () => {
    const guard = new RetryGuard(1, 60_000, () => 1);
    guard.record('canvas_query', { a: 1 }, true);
    expect(guard.check('canvas_query', { a: 1 })).not.toBeNull();
    guard.reset();
    expect(guard.check('canvas_query', { a: 1 })).toBeNull();
  });

  it('uses the arguments as they arrive: a handler that fills a parameter in afterwards does not make the call a different one', async () => {
    const guard = new RetryGuard(2, 60_000, () => 1);
    const fill = async (args: { params?: Record<string, string> }) => {
      args.params = { ...(args.params ?? {}), user_id: '42' };                              // what canvas_query does for my_grades
      return bad;
    };
    for (let i = 0; i < 2; i++) {
      const args: { action: string; params?: Record<string, string> } = { action: 'my_grades' };
      await guard.run('canvas_query', args, () => fill(args));
    }
    const third = await guard.run('canvas_query', { action: 'my_grades' }, async () => ok);
    expect(third.content[0].text).toMatch(/not sent again/);
  });

  it('names the three tools that call an outside service, and no others', () => {
    expect([...GUARDED_TOOLS].sort()).toEqual(['canvas_query', 'github_query', 'piazza_query']);
  });
});

describe('stableStringify', () => {
  it('writes the same text for the same value whatever the order of the keys, at any depth', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } })).toBe(stableStringify({ a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }));
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify([3, 1])).not.toBe(stableStringify([1, 3]));
  });
});
