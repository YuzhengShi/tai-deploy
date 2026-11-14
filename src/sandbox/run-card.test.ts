import { describe, expect, it, vi } from 'vitest';

import { cleanObject } from '../chat-objects/clean.js';
import { OBJECT_JSON_MAX, RUN_OUTPUT_CHARS } from '../chat-objects/types.js';
import { leaveRunCard, runCard } from './run-card.js';
import { parseSandboxRequest } from './types.js';
import type { SandboxRequest, SandboxResult } from './types.js';

// The card a run leaves in the student's chat: built by the host from the sandbox's result, only for a run that happened, always through the chat's own gate (cleanObject), and never able to
// make the answer to a container or a call fail. (docs/RUN_CARDS.md)

const request = (raw: Record<string, unknown> = { action: 'test', repo: { name: 'hw2' }, race: true }): SandboxRequest => {
  const parsed = parseSandboxRequest(raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};
const ran = (over: Partial<SandboxResult> = {}): SandboxResult => ({ ok: true, exitCode: 0, timedOut: false, outputTruncated: false, output: 'PASS\nok  \thw2\t0.012s\n', durationMs: 1234.4, ...over });
const must = (result: SandboxResult, req: SandboxRequest = request()) => {
  const card = runCard(result, req);
  if (!card) throw new Error('no card');
  return card;
};

describe('the card of a run that happened', () => {
  it('has the host\'s words for the command, the result\'s numbers and the program\'s output', () => {
    expect(must(ran())).toEqual({
      t: 'run',
      command: 'go test -race ./...',
      ok: true,
      exitCode: 0,
      timedOut: false,
      durationMs: 1234,
      output: 'PASS\nok  \thw2\t0.012s',
      truncated: false,
    });
  });

  it('says how a failure, a stop and a timeout ended, and carries the host\'s sentence as its note', () => {
    expect(must(ran({ exitCode: 2, output: '--- FAIL: TestX (0.00s)\n' }))).toMatchObject({ exitCode: 2, timedOut: false });
    expect(must(ran({ exitCode: null, timedOut: true, outputTruncated: true, message: 'It was stopped at the time limit.' }))).toMatchObject({ exitCode: null, timedOut: true, truncated: true, note: 'It was stopped at the time limit.' });
    expect('note' in must(ran())).toBe(false);
    expect('note' in must(ran({ message: '' }))).toBe(false);
  });

  it('uses the validated request\'s command line, whatever the kind of run', () => {
    expect(must(ran(), request({ action: 'run', files: [{ path: 'main.go', content: 'package main\n' }], args: ['a', 'b'] })).command).toBe('go run . a b');
    expect(must(ran(), request({ action: 'test', upload: 'proj.tgz', pkg: './pkg/...', testRun: 'TestA|TestB' })).command).toBe('go test -run TestA|TestB ./pkg/...');
    expect(must(ran(), request({ action: 'vet', repo: 'hw2' })).command).toBe('go vet ./...');
  });

  it('shows the program\'s text without terminal escapes or control characters, and says so when it printed nothing', () => {
    const card = must(ran({ output: '\u001b[31mred\u001b[0m\r\nbell\u0007 and\u0000nul\n\u202eflipped\u200b\n\n\n\n\n\nend\n' }));
    expect(card.output).toBe('red\nbell  and nul\n flipped \n\n\nend');
    expect(card.output.replace(/[\n\t]/g, '')).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(must(ran({ output: '' })).output).toBe('');
    expect(must(ran({ output: '   \n\n' })).output).toBe('');
  });

  it('passes the chat\'s own gate as it is: cleanObject changes nothing of it', () => {
    const card = must(ran({ exitCode: 3, message: 'A sentence.' }));
    expect(cleanObject(card)).toEqual(card);
  });
});

describe('a run that did not happen leaves no card', () => {
  it('is nothing for a refusal, a busy sandbox, a limit, or anything that is not a result', () => {
    for (const result of [
      { ...ran(), ok: false, phase: 'busy', message: 'The sandbox is busy.' },
      { ...ran(), ok: false, phase: 'refused', message: 'Not run: x.' },
      { ...ran(), ok: false },
      { ...ran(), ok: 'true' },
      undefined,
      null,
      'ran',
      42,
    ]) {
      expect(runCard(result as unknown as SandboxResult, request())).toBeNull();
    }
  });

  it('is nothing, and no throw, for a result or a request that is nonsense', () => {
    expect(runCard(ran({ output: 42 as unknown as string }), request())?.output).toBe('');
    expect(runCard(ran({ exitCode: 'x' as unknown as number, durationMs: Number.NaN }), request())).toMatchObject({ exitCode: null, durationMs: 0 });
    expect(runCard(ran(), null as unknown as SandboxRequest)).toBeNull();
  });
});

describe('a long output', () => {
  it('is cut in the middle at the card\'s cap, says so, and counts what it left out', () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `line ${i} of the output`).join('\n');
    expect(raw.length).toBeGreaterThan(RUN_OUTPUT_CHARS);
    const card = must(ran({ output: raw }));
    expect(card.truncated).toBe(true);
    expect(card.output.startsWith('line 0 of the output\nline 1 of the output')).toBe(true);
    expect(card.output.endsWith('line 4999 of the output')).toBe(true);
    const marker = /\n\[\.\.\. (\d+) characters in the middle are not shown \.\.\.\]\n/.exec(card.output);
    expect(marker).not.toBeNull();
    const [before, after] = card.output.split(marker![0]);
    // the number is the number of characters that are really missing: the output was cut once, not twice
    expect(before.length + Number(marker![1]) + after.length).toBe(raw.length);
    expect(card.output.length).toBeLessThanOrEqual(RUN_OUTPUT_CHARS);
    expect(card.output.match(/characters in the middle are not shown/g)).toHaveLength(1);
  });

  it('is cut once, with a true count, for every length around the card\'s cap', () => {
    for (const extra of [-300, -150, -1, 0, 1, 55, 60, 150, 199, 200, 201, 300, 1000]) {
      const raw = 'x'.repeat(RUN_OUTPUT_CHARS + extra);
      const card = must(ran({ output: raw }));
      const marker = /\n\[\.\.\. (\d+) characters in the middle are not shown \.\.\.\]\n/.exec(card.output);
      if (!marker) {
        expect(card.output).toBe(raw);
        continue;
      }
      const [before, after] = card.output.split(marker[0]);
      expect(before.length + Number(marker[1]) + after.length, `extra ${extra}`).toBe(raw.length);
      expect(card.output.match(/characters in the middle are not shown/g), `extra ${extra}`).toHaveLength(1);
    }
  });

  it('is still a card when the output is all the characters that JSON writes at double length or more: it is cut further until the chat\'s gate takes it', () => {
    const hostile: Record<string, string> = {
      quotes: '"'.repeat(60_000),
      backslashes: '\\'.repeat(60_000),
      'tabs and quotes': '\t"'.repeat(30_000),
      'quotes and breaks': '"\n'.repeat(30_000),
      'one short line each': 'a\n'.repeat(30_000),
      'lone surrogates': '\ud800'.repeat(40_000),
      'quote, backslash and tab': '"\\\t'.repeat(20_000),
    };
    for (const [name, output] of Object.entries(hostile)) {
      const card = must(ran({ output, outputTruncated: true }));
      expect(JSON.stringify(card).length, name).toBeLessThanOrEqual(OBJECT_JSON_MAX);
      expect(card.truncated, name).toBe(true);
      expect(card.ok, name).toBe(true);
      expect(cleanObject(card), name).toEqual(card);
      expect(card.output.length, name).toBeGreaterThan(300);
    }
  });

  it('keeps the command, the numbers and the note when it has to cut hard', () => {
    const card = must(ran({ output: '"'.repeat(60_000), exitCode: 1, message: 'It printed too much.', durationMs: 5000 }));
    expect(card).toMatchObject({ command: 'go test -race ./...', exitCode: 1, durationMs: 5000, note: 'It printed too much.' });
  });
});

describe('leaving the card', () => {
  it('posts the card and says it did', () => {
    const post = vi.fn();
    expect(leaveRunCard(ran(), request(), post)).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual(must(ran()));
  });

  it('posts nothing, and says so, for a run that did not happen or when there is no way to post', () => {
    const post = vi.fn();
    expect(leaveRunCard({ ...ran(), ok: false }, request(), post)).toBe(false);
    expect(leaveRunCard(undefined, request(), post)).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(leaveRunCard(ran(), request(), undefined)).toBe(false);
  });

  it('never throws: a posting that throws is false and is told to the log, which may itself throw', () => {
    const onError = vi.fn();
    expect(
      leaveRunCard(ran(), request(), () => {
        throw new Error('the history is closed');
      }, onError),
    ).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('the history is closed');
    expect(
      leaveRunCard(ran(), request(), () => {
        throw new Error('x');
      }, () => {
        throw new Error('the log failed too');
      }),
    ).toBe(false);
  });
});
