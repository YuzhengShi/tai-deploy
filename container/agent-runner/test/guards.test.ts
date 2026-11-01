import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import {
  composeHooks,
  createCompetencyGuardHook,
  createFileSizeGuardHook,
  createSanitizeBashHook,
  createSensitiveFileReadHook,
  createWebFetchGuardHook,
  createWorkspaceSizeGuardHook,
  deny,
  denial,
  isCleanupCommand,
  isPrivateAddress,
  masteryScores,
  newTurnCounters,
  preToolUseHooks,
  privateUrlReason,
  raisedToHigh,
  secretEnvNames,
  touchesProc,
  unquote,
  writesCompetency,
} from '../src/guards.js';

function run(hook: HookCallback, toolInput: Record<string, unknown>) {
  return hook(
    { hook_event_name: 'PreToolUse', tool_name: 'Tool', tool_input: toolInput } as never,
    undefined,
    { signal: new AbortController().signal },
  );
}

const denied = async (hook: HookCallback, toolInput: Record<string, unknown>) => denial(await run(hook, toolInput));

describe('deny', () => {
  it('uses the fields the Agent SDK reads', () => {
    const out = (deny('no') as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
    expect(out).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' });
    expect(out).not.toHaveProperty('decision'); // upstream's `decision: 'block'` was ignored by the SDK
    expect(denial(deny('no'))).toBe('no');
    expect(denial({})).toBeNull();
  });
});

describe('secretEnvNames', () => {
  it('takes every name the host handed over, plus credential-looking names in the environment', () => {
    const names = secretEnvNames(
      { MS_EMAIL: 'x', MS_PASSWORD: 'x', PIAZZA_PASSWORD: 'x', GITHUB_TOKEN_PUBLIC: 'x', CANVAS_BASE_URL: 'x' },
      { PATH: '/bin', HOME: '/home/node', TZ: 'UTC', MY_SERVICE_TOKEN: 'x', db_password: 'x' },
    );
    for (const n of ['MS_EMAIL', 'MS_PASSWORD', 'PIAZZA_PASSWORD', 'GITHUB_TOKEN_PUBLIC', 'MY_SERVICE_TOKEN', 'db_password']) expect(names).toContain(n);
    for (const n of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CANVAS_API_TOKEN', 'GITHUB_TOKEN']) {
      expect(names).toContain(n);
    }
    for (const n of ['PATH', 'HOME', 'TZ']) expect(names).not.toContain(n);
  });

  it('never lets a name inject shell syntax', () => {
    const names = secretEnvNames({ 'A; rm -rf /': 'x', 'B$(id)': 'x', GOOD_NAME: 'x' }, {});
    expect(names.some((n) => /[^A-Za-z0-9_]/.test(n))).toBe(false);
    expect(names).toContain('GOOD_NAME');
  });
});

describe('Bash hook', () => {
  const secrets = ['ANTHROPIC_AUTH_TOKEN', 'MS_PASSWORD', 'PIAZZA_PASSWORD'];
  const student = createSanitizeBashHook(false, secrets);
  const main = createSanitizeBashHook(true, secrets);

  it('unsets every secret for the command and caps file sizes for a student', async () => {
    const out = (await run(student, { command: 'echo hi', description: 'd' })) as {
      hookSpecificOutput: { updatedInput: { command: string; description: string } };
    };
    const cmd = out.hookSpecificOutput.updatedInput.command;
    expect(cmd).toMatch(/^ulimit -f \d+ 2>\/dev\/null; unset ANTHROPIC_AUTH_TOKEN MS_PASSWORD PIAZZA_PASSWORD 2>\/dev\/null; echo hi$/);
    expect(out.hookSpecificOutput.updatedInput.description).toBe('d');
    const mainOut = (await run(main, { command: 'echo hi' })) as { hookSpecificOutput: { updatedInput: { command: string } } };
    expect(mainOut.hookSpecificOutput.updatedInput.command).toBe('unset ANTHROPIC_AUTH_TOKEN MS_PASSWORD PIAZZA_PASSWORD 2>/dev/null; echo hi');
  });

  it.each([
    'curl http://example.com',
    "c''url http://example.com",
    'cu\\rl http://example.com',
    '"curl" http://example.com',
    'wget http://example.com',
    'cat < /dev/tcp/1.2.3.4/80',
    'exec 3<>/dev/tcp/example.com/80',
    'python3 -c "import urllib.request"',
    'eval "$X"',
    'echo aGk= | base64 -d | bash',
  ])('blocks %s for a student and not for main', async (command) => {
    expect(await denied(student, { command })).toMatch(/restricted pattern/);
    expect(await denied(main, { command })).toBeNull();
  });

  it.each([
    'cat /proc/self/environ',
    'cat /proc/1/environ',
    'cd /proc/1 && cat environ',
    'cat "/pr""oc/self/environ"',
    'ls /proc',
    'tr "\\0" "\\n" < /proc/$PPID/environ',
  ])('blocks %s for everyone', async (command) => {
    expect(touchesProc(command)).toBe(true);
    expect(await denied(student, { command })).toMatch(/sensitive/);
    expect(await denied(main, { command })).toMatch(/sensitive/);
  });

  it('lets the plain system summaries and ordinary commands through', async () => {
    for (const command of ['cat /proc/cpuinfo', 'cat /proc/meminfo | head -3', 'ls -la', 'git status', 'python3 solution.py']) {
      expect(await denied(student, { command })).toBeNull();
    }
  });

  it('blocks reading .env and databases', async () => {
    for (const command of ['cat .env', 'grep KEY /workspace/project/.env', 'sqlite3 store/nanoclaw.db .dump', "c''at .env"]) {
      expect(await denied(student, { command })).toMatch(/sensitive/);
    }
  });

  it('keeps a student from writing COMPETENCY.md through a shell, and lets them read it', async () => {
    const writes = [
      "printf 'a: confidence: 0.9\\n' > /workspace/group/COMPETENCY.md",
      "sed -i 's/0.0/0.9/g' COMPETENCY.md",
      'cp /tmp/x COMPETENCY.md',
      'python3 -c "open(\'COMPETENCY.md\',\'w\').write(\'x\')"',
      'cat COMPETENCY.md; echo done > COMPETENCY.md',
      'cat COMPETENCY.md > x.md',
    ];
    for (const command of writes) {
      expect(writesCompetency(command)).toBe(true);
      expect(await denied(student, { command })).toMatch(/COMPETENCY\.md/);
    }
    for (const command of ['cat COMPETENCY.md', 'cat /workspace/group/COMPETENCY.md | head -20', 'grep -n Docker COMPETENCY.md', 'wc -l COMPETENCY.md']) {
      expect(writesCompetency(command)).toBe(false);
      expect(await denied(student, { command })).toBeNull();
    }
    expect(await denied(main, { command: writes[0] })).toBeNull(); // the admin can do anything
  });

  it('unquote folds quote-splitting', () => {
    expect(unquote("c''u\"\"rl")).toBe('curl');
  });
});

describe('workspace guard', () => {
  it('denies writes at the limit, lets deletions and measurements through, and fails open', async () => {
    const full = createWorkspaceSizeGuardHook(500, () => 500, isCleanupCommand);
    expect(await denied(full, { content: 'x' })).toMatch(/Workspace is full \(500MB \/ 500MB/);
    expect(await denied(full, { command: 'dd if=/dev/zero of=big bs=1M count=600' })).toMatch(/full/);
    expect(await denied(full, { command: 'rm -rf big' })).toBeNull();
    expect(await denied(full, { command: 'du -sm .' })).toBeNull();
    expect(await denied(full, { command: 'rm -rf big; dd if=/dev/zero of=x' })).toMatch(/full/);
    expect(await denied(createWorkspaceSizeGuardHook(500, () => 499, isCleanupCommand), { content: 'x' })).toBeNull();
    expect(await denied(createWorkspaceSizeGuardHook(500, () => null, isCleanupCommand), { content: 'x' })).toBeNull();
  });
});

describe('file size guard', () => {
  it('counts bytes, not characters', async () => {
    const guard = createFileSizeGuardHook(10);
    expect(await denied(guard, { content: '0123456789' })).toBeNull();
    expect(await denied(guard, { content: '01234567890' })).toMatch(/too large/);
    expect(await denied(guard, { new_string: 'ééééé6' })).toMatch(/too large/); // 11 bytes
  });
});

describe('Read and Grep guard', () => {
  const guard = createSensitiveFileReadHook();

  it.each([
    '/proc/self/environ',
    '/proc/1/environ',
    '/proc/self/cmdline',
    '/proc/self/mem',
    '/proc/self/root/workspace/project/.env',
    '/workspace/group/../../proc/self/environ',
    '/workspace/project/.env',
    '/workspace/project/.env.production',
    '/workspace/project/store/nanoclaw.db',
    '/workspace/project/store/nanoclaw.db-wal',
  ])('denies %s', async (file) => {
    expect(await denied(guard, { file_path: file })).toMatch(/sensitive/);
    expect(await denied(guard, { path: file })).toMatch(/sensitive/); // Grep names it path
  });

  it('allows ordinary files and the plain system summaries', async () => {
    for (const file of ['/workspace/group/COMPETENCY.md', '/proc/cpuinfo', '/workspace/group/env.md', '/workspace/group/notes.env.md']) {
      expect(await denied(guard, { file_path: file })).toBeNull();
    }
    expect(await denied(guard, {})).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('follows a symlink to a sensitive file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
      fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'notes.txt'));
      fs.writeFileSync(path.join(dir, 'plain.txt'), 'hello\n');
      expect(await denied(guard, { file_path: path.join(dir, 'notes.txt') })).toMatch(/sensitive/);
      expect(await denied(guard, { file_path: path.join(dir, 'plain.txt') })).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('addresses', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '127.255.255.254', '100.64.0.1', '100.127.255.255', '169.254.169.254', '172.16.0.1', '172.18.0.3',
    '172.31.255.255', '192.168.0.1', '192.0.0.8', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3',
    '::10.1.2.3', '64:ff9b::a00:1', '2002:7f00:1::', '2002:a9fe:a9fe::',
  ])('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.43.7', '198.17.255.255', '198.20.0.1',
    '2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:808:808::',
  ])('%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('treats what is not an address as private', () => {
    expect(isPrivateAddress('example.com')).toBe(true);
    expect(isPrivateAddress('1.2.3')).toBe(true);
  });
});

describe('privateUrlReason', () => {
  const resolver = (table: Record<string, string[]>) => async (host: string) => {
    if (!(host in table)) throw new Error('ENOTFOUND');
    return table[host];
  };
  const dns = resolver({
    'example.com': ['93.184.216.34'],
    'github.eval': ['172.18.0.3'],
    'rebind.example.net': ['93.184.216.34', '10.0.0.5'],
    'empty.example.net': [],
  });

  it.each([
    'http://localhost:8099/api/health',
    'http://127.0.0.1:8099/',
    'http://[::1]:8099/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://017700000001/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://10.1.2.3/',
    'http://172.18.0.5:4000/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://user@127.0.0.1/',
    'http://localhost./',
    'http://tai-litellm:4000/',
    'http://tai-mocks:8081/health',
    'http://metadata.internal/',
    'http://printer.local/',
    'http://github.eval:8081/health',
    'http://rebind.example.net/',
    'http://empty.example.net/',
    'http://does-not-exist.example.org/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'javascript:alert(1)',
    'localhost:8099/x',
    'not a url',
  ])('refuses %s', async (url) => expect(await privateUrlReason(url, dns)).not.toBeNull());

  it.each(['https://example.com/page?q=1', 'http://example.com:8080/', 'http://8.8.8.8/', 'https://[2606:4700::1111]/'])('allows %s', async (url) => {
    expect(await privateUrlReason(url, dns)).toBeNull();
  });
});

describe('WebFetch hook', () => {
  const dns = async () => ['93.184.216.34'];

  it('allows at most maxCalls per answer, then again after the counter is reset', async () => {
    const counters = newTurnCounters();
    const guard = createWebFetchGuardHook(counters, 3, dns);
    for (let i = 0; i < 3; i++) expect(await denied(guard, { url: `https://example.com/${i}` })).toBeNull();
    expect(await denied(guard, { url: 'https://example.com/4' })).toMatch(/rate limit/);
    expect(await denied(guard, { url: 'https://example.com/5' })).toMatch(/rate limit/);
    counters.webFetch = 0; // the model has answered
    expect(await denied(guard, { url: 'https://example.com/6' })).toBeNull();
  });

  it('refuses a private target with the reason', async () => {
    const guard = createWebFetchGuardHook(newTurnCounters(), 15, dns);
    expect(await denied(guard, { url: 'http://169.254.169.254/latest/meta-data/' })).toMatch(/private or internal address/);
    expect(await denied(guard, { url: 'http://tai-mocks:8081/' })).toMatch(/internal host name/);
  });
});

describe('competency mastery lines', () => {
  const labelled = 'Docker: confidence: 0.3 | stability: 0.1 | scope: [] | via: [] | last: never';
  const template = 'Docker concepts (images, containers, Dockerfile): 0.3 | 0.1 | [] | [] | never';

  it('reads both formats', () => {
    expect([...masteryScores(labelled)]).toEqual([['docker', 0.3]]);
    expect([...masteryScores(template)]).toEqual([['docker concepts (images, containers, dockerfile)', 0.3]]);
    expect([...masteryScores('- Raft: confidence = .9')]).toEqual([['raft', 0.9]]);
    expect(masteryScores('Last updated: 2026-11-01\nWeek 1: Go, GCP & AWS (HW1a + HW1b)\nName: Ann').size).toBe(0);
  });

  it('reads a bare confidence value and counts it', () => {
    expect(raisedToHigh('', 'confidence: 0.9\nconfidence: 0.95\nconfidence: 0.2')).toHaveLength(2);
  });

  it('counts concepts raised to 0.8 or more, not those already there', () => {
    const before = 'A: 0.9 | 0.9 | [] | [] | d\nB: 0.5 | 0.1 | [] | [] | d\nC: 0.0 | 0.0 | [] | [] | never';
    const after = 'A: 0.9 | 0.9 | [] | [] | d\nB: 0.8 | 0.1 | [] | [] | d\nC: 0.79 | 0.0 | [] | [] | d\nD: 0.85 | 0.0 | [] | [] | d';
    expect(raisedToHigh(before, after).sort()).toEqual(['b', 'd']);
  });
});

describe('competency guard', () => {
  const lines = (n: number, v: string, style: 'labelled' | 'template') =>
    Array.from({ length: n }, (_, i) =>
      style === 'labelled' ? `Concept ${i}: confidence: ${v} | stability: 0.5 | scope: [] | via: [] | last: today` : `Concept ${i}: ${v} | 0.5 | [] | [] | today`,
    ).join('\n');
  const file = '/workspace/group/COMPETENCY.md';
  const student = createCompetencyGuardHook(false, () => '');

  it.each(['labelled', 'template'] as const)('blocks three concepts raised to 0.9 in one Write (%s format)', async (style) => {
    expect(await denied(student, { file_path: file, content: lines(3, '0.9', style) })).toMatch(/3 concepts to confidence >= 0.8/);
    expect(await denied(student, { file_path: file, content: lines(2, '0.9', style) })).toBeNull();
    expect(await denied(student, { file_path: file, content: lines(5, '0.79', style) })).toBeNull();
  });

  it('blocks it through Edit and MultiEdit', async () => {
    const edit = { file_path: file, old_string: lines(3, '0.1', 'template'), new_string: lines(3, '0.9', 'template') };
    expect(await denied(student, edit)).toMatch(/3 concepts/);
    expect(await denied(student, { file_path: file, edits: [{ old_string: 'x', new_string: lines(3, '0.9', 'labelled') }] })).toMatch(/3 concepts/);
    expect(await denied(student, { ...edit, old_string: lines(3, '0.9', 'template') })).toBeNull(); // already there
  });

  it('compares a Write with the file as it is: what was high already does not count', async () => {
    const current = lines(3, '0.9', 'template');
    const guard = createCompetencyGuardHook(false, () => current);
    const rewrite = current + '\nExtra: 0.9 | 0.5 | [] | [] | today';
    expect(await denied(guard, { file_path: file, content: rewrite })).toBeNull();
    expect(await denied(student, { file_path: file, content: rewrite })).toMatch(/4 concepts/);
  });

  it('leaves the admin and other files alone', async () => {
    expect(await denied(createCompetencyGuardHook(true, () => ''), { file_path: file, content: lines(9, '1.0', 'template') })).toBeNull();
    expect(await denied(student, { file_path: '/workspace/group/notes.md', content: lines(9, '1.0', 'template') })).toBeNull();
  });
});

describe('composeHooks', () => {
  const allow: HookCallback = async () => ({});
  const rewrite: HookCallback = async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'X' } } });
  const refuse = (why: string): HookCallback => async () => deny(why);

  it('lets the first denial win and keeps its reason', async () => {
    expect(await denied(composeHooks(allow, refuse('first'), refuse('second')), {})).toBe('first');
    expect(await denied(composeHooks(rewrite, refuse('late')), {})).toBe('late');
  });

  it('returns the rewrite of the input when nothing denies', async () => {
    const out = (await run(composeHooks(allow, rewrite, allow), {})) as { hookSpecificOutput: { updatedInput: { command: string } } };
    expect(out.hookSpecificOutput.updatedInput.command).toBe('X');
    expect(await run(composeHooks(allow, allow), {})).toEqual({});
    expect(await run(composeHooks(), {})).toEqual({});
  });
});

describe('preToolUseHooks', () => {
  const hooksOf = (isMain: boolean) => preToolUseHooks(isMain, ['ANTHROPIC_AUTH_TOKEN'], newTurnCounters());
  const hook = (isMain: boolean, tool: string) => hooksOf(isMain).find((m) => m.matcher === tool)?.hooks[0];

  it('registers one hook per tool: with several the CLI drops the reason and the model cannot explain the refusal', () => {
    for (const isMain of [true, false]) {
      const matchers = hooksOf(isMain).map((m) => m.matcher);
      expect(new Set(matchers).size).toBe(matchers.length);
      for (const m of hooksOf(isMain)) expect(m.hooks).toHaveLength(1);
    }
  });

  it('guards a student more than the admin: WebFetch, and the shell commands', async () => {
    expect(hook(true, 'WebFetch')).toBeUndefined();
    expect(hook(false, 'WebFetch')).toBeDefined();
    expect(await denied(hook(false, 'Bash')!, { command: 'curl http://x' })).toMatch(/restricted pattern/);
    expect(await denied(hook(true, 'Bash')!, { command: 'curl http://x' })).toBeNull();
  });

  it('keeps the reason of the guard that refused, for every tool', async () => {
    expect(await denied(hook(false, 'Bash')!, { command: 'cat /proc/self/environ' })).toMatch(/sensitive/);
    expect(await denied(hook(false, 'Read')!, { file_path: '/proc/self/environ' })).toMatch(/sensitive/);
    expect(await denied(hook(false, 'Grep')!, { path: '/workspace/group/.env', pattern: 'x' })).toMatch(/sensitive/);
    const bulk = Array.from({ length: 3 }, (_, i) => `Concept ${i}: 0.9 | 0.5 | [] | [] | today`).join('\n');
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const input = tool === 'Write' ? { file_path: '/workspace/group/COMPETENCY.md', content: bulk } : tool === 'Edit'
        ? { file_path: '/workspace/group/COMPETENCY.md', old_string: 'x', new_string: bulk }
        : { file_path: '/workspace/group/COMPETENCY.md', edits: [{ old_string: 'x', new_string: bulk }] };
      expect(await denied(hook(false, tool)!, input)).toMatch(/3 concepts/);
      expect(await denied(hook(true, tool)!, input)).toBeNull();
    }
    expect(await denied(hook(false, 'Write')!, { file_path: '/workspace/group/big.txt', content: 'x'.repeat(5 * 1024 * 1024 + 1) })).toMatch(/too large/);
  });
});
