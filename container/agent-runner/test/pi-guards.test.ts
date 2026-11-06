import { describe, expect, it } from 'vitest';

import { newTurnCounters } from '../src/guards.js';
import { DEFAULT_BASH_SECONDS, MAX_BASH_SECONDS, boundedBashTimeout, createPiGuard, piResolvedPath, toGuardCalls } from '../src/pi-guards.js';

const CWD = '/workspace/group';
const HOME = '/home/node';

function guard(isMain = false, secretNames: string[] = ['CANVAS_API_TOKEN', 'GITHUB_TOKEN']) {
  const counters = newTurnCounters();
  return { counters, check: createPiGuard({ isMain, secretNames, counters, cwd: CWD, home: HOME }) };
}

const blocked = async (g: ReturnType<typeof guard>, tool: string, input: Record<string, unknown>) => (await g.check(tool, input))?.reason ?? null;

describe('piResolvedPath: the path pi opens', () => {
  it('resolves what pi resolves', () => {
    expect(piResolvedPath('notes.md', CWD, HOME)).toBe('/workspace/group/notes.md');
    expect(piResolvedPath('../global/x', CWD, HOME)).toBe('/workspace/global/x');
    expect(piResolvedPath('/etc/hosts', CWD, HOME)).toBe('/etc/hosts');
    expect(piResolvedPath('@.env', CWD, HOME)).toBe('/workspace/group/.env'); // pi strips a leading @
    expect(piResolvedPath('~/.env', CWD, HOME)).toBe('/home/node/.env');
    expect(piResolvedPath('~', CWD, HOME)).toBe('/home/node');
    expect(piResolvedPath('file:///workspace/group/.env', CWD, HOME)).toBe('/workspace/group/.env');
    expect(piResolvedPath('a b', CWD, HOME)).toBe('/workspace/group/a b'); // unicode spaces become spaces
  });
});

describe('toGuardCalls: pi calls as the guards know them', () => {
  it('bash, web_fetch and the file tools', () => {
    expect(toGuardCalls('bash', { command: 'ls' }, CWD, HOME)).toEqual([{ tool_name: 'Bash', tool_input: { command: 'ls' } }]);
    expect(toGuardCalls('web_fetch', { url: 'https://example.com' }, CWD, HOME)).toEqual([{ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }]);
    const write = toGuardCalls('write', { path: 'a.txt', content: 'hi' }, CWD, HOME);
    expect(write).toEqual([{ tool_name: 'Write', tool_input: { file_path: '/workspace/group/a.txt', content: 'hi' } }]);
    const edit = toGuardCalls('edit', { path: 'a.txt', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] }, CWD, HOME);
    expect(edit).toEqual([
      { tool_name: 'Edit', tool_input: { file_path: '/workspace/group/a.txt', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } },
    ]);
  });

  it('read and grep are checked under both spellings of the path', () => {
    const calls = toGuardCalls('read', { path: '@.env' }, CWD, HOME);
    expect(calls.map((c) => c.tool_input.file_path)).toEqual(['@.env', '/workspace/group/.env']);
    expect(toGuardCalls('read', { path: '/workspace/group/a.md' }, CWD, HOME)).toHaveLength(1);
    expect(toGuardCalls('grep', { pattern: 'x' }, CWD, HOME)).toEqual([]); // no path: it searches the working directory
  });

  it('the older single-replacement shape of edit still maps', () => {
    const [call] = toGuardCalls('edit', { path: 'COMPETENCY.md', oldText: 'a', newText: 'b' }, CWD, HOME);
    expect(call.tool_input.edits).toEqual([{ old_string: 'a', new_string: 'b' }]);
  });

  it('has no rule for MCP tools, find or ls', () => {
    expect(toGuardCalls('mcp__nanoclaw__send_message', { text: 'hi' }, CWD, HOME)).toEqual([]);
    expect(toGuardCalls('find', { pattern: '*.md' }, CWD, HOME)).toEqual([]);
    expect(toGuardCalls('ls', {}, CWD, HOME)).toEqual([]);
  });

  it('survives inputs of the wrong shape', () => {
    expect(() => toGuardCalls('read', { path: 42 }, CWD, HOME)).not.toThrow();
    expect(() => toGuardCalls('edit', { path: 'x', edits: 'nope' }, CWD, HOME)).not.toThrow();
    expect(() => toGuardCalls('bash', {}, CWD, HOME)).not.toThrow();
  });
});

describe('the guard on pi calls', () => {
  it('stops the files that hold secrets, whichever way they are named', async () => {
    const g = guard();
    for (const p of ['.env', '/workspace/group/.env', '@.env', '~/.env', 'file:///workspace/group/.env', '/proc/self/environ', 'store/nanoclaw.db']) {
      expect(await blocked(g, 'read', { path: p }), p).toMatch(/sensitive/);
    }
    expect(await blocked(g, 'grep', { pattern: 'KEY', path: '/workspace/group/.env.local' })).toMatch(/sensitive/);
    expect(await blocked(g, 'read', { path: 'COMPETENCY.md' })).toBeNull();
    expect(await blocked(guard(true), 'read', { path: '.env' })).toMatch(/sensitive/); // main too
  });

  it('keeps shell commands off the network and out of the credentials', async () => {
    const g = guard();
    expect(await blocked(g, 'bash', { command: 'curl https://example.com' })).toMatch(/restricted pattern/);
    expect(await blocked(g, 'bash', { command: 'cat /proc/1/environ' })).toMatch(/sensitive/);
    expect(await blocked(g, 'bash', { command: 'cat .env' })).toMatch(/sensitive/);
    expect(await blocked(guard(true), 'bash', { command: 'curl https://example.com' })).toBeNull(); // the admin chat may
  });

  it('rewrites an allowed command: file size cap, then every credential unset', async () => {
    const g = guard(false, ['GITHUB_TOKEN', 'CANVAS_API_TOKEN']);
    const input: Record<string, unknown> = { command: 'ls -la' };
    expect(await g.check('bash', input)).toBeUndefined();
    expect(input.command).toBe('ulimit -f 51200 2>/dev/null; unset GITHUB_TOKEN CANVAS_API_TOKEN 2>/dev/null; ls -la');
    const main: Record<string, unknown> = { command: 'ls' };
    await guard(true, ['GITHUB_TOKEN']).check('bash', main);
    expect(main.command).toBe('unset GITHUB_TOKEN 2>/dev/null; ls');
  });

  it('gives a command a time limit: 120 s unless the model asks for more, 600 s at most', async () => {
    const g = guard();
    const cases: Array<[unknown, number]> = [[undefined, 120], [30, 30], [300, 300], [99999, 600], [0, 120], [-5, 120], ['soon', 120], [Number.NaN, 120]];
    for (const [asked, expected] of cases) {
      const input: Record<string, unknown> = { command: 'ls', timeout: asked };
      expect(await g.check('bash', input)).toBeUndefined();
      expect(input.timeout, String(asked)).toBe(expected);
    }
    expect(boundedBashTimeout(undefined)).toBe(DEFAULT_BASH_SECONDS);
    expect(MAX_BASH_SECONDS).toBeGreaterThan(DEFAULT_BASH_SECONDS);
    const denied: Record<string, unknown> = { command: 'curl http://example.com' };
    expect((await g.check('bash', denied))?.block).toBe(true);
    expect(denied.timeout).toBeUndefined(); // a blocked call is left as it was
  });

  it('refuses to bulk-raise mastery in one edit, however many edits it holds', async () => {
    const g = guard();
    const raise = (n: number) => Array.from({ length: n }, (_v, i) => ({ oldText: `C${i}: 0.2 | 0.1 | [] | [] | never`, newText: `C${i}: 0.9 | 0.9 | [] | [] | today` }));
    expect(await blocked(g, 'edit', { path: 'COMPETENCY.md', edits: raise(2) })).toBeNull();
    expect(await blocked(g, 'edit', { path: 'COMPETENCY.md', edits: raise(3) })).toMatch(/single edit/);
    expect(await blocked(g, 'edit', { path: '@COMPETENCY.md', edits: raise(3) })).toMatch(/single edit/);
    expect(await blocked(guard(true), 'edit', { path: 'COMPETENCY.md', edits: raise(3) })).toBeNull(); // admin
  });

  it('caps what one write or edit may put in a file', async () => {
    const g = guard();
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    expect(await blocked(g, 'write', { path: 'big.txt', content: big })).toMatch(/too large/);
    expect(await blocked(g, 'edit', { path: 'big.txt', edits: [{ oldText: 'a', newText: big }] })).toMatch(/too large/);
    expect(await blocked(g, 'write', { path: 'ok.txt', content: 'hello' })).toBeNull();
  });

  it('fetches only public pages, fifteen a answer', async () => {
    const g = guard();
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:8099/', 'http://[::1]/', 'file:///etc/passwd']) {
      expect(await blocked(g, 'web_fetch', { url }), url).toMatch(/internal\/private|only http/);
    }
    const counted = guard();
    for (let i = 0; i < 15; i++) expect(await blocked(counted, 'web_fetch', { url: 'http://93.184.216.34/' })).toBeNull();
    expect(await blocked(counted, 'web_fetch', { url: 'http://93.184.216.34/' })).toMatch(/rate limit/);
    counted.counters.webFetch = 0; // the runner resets it when the model has answered
    expect(await blocked(counted, 'web_fetch', { url: 'http://93.184.216.34/' })).toBeNull();
    expect(await blocked(guard(true), 'web_fetch', { url: 'http://127.0.0.1/' })).toBeNull(); // the admin chat is not limited
  });

  it('lets MCP tools through and fails closed when a guard breaks', async () => {
    expect(await blocked(guard(), 'mcp__nanoclaw__send_message', { text: 'hi' })).toBeNull();
    const counters = newTurnCounters();
    const broken = createPiGuard({ isMain: false, secretNames: [], counters, cwd: CWD, home: HOME });
    const hostile = { get command(): string { throw new Error('boom'); } } as unknown as Record<string, unknown>;
    expect((await broken('bash', hostile))?.reason).toMatch(/could not be completed/);
  });
});
