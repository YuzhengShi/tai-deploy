import { describe, expect, it, vi } from 'vitest';

import type { Choice, ParsedChoices } from './choices.js';
import { checkKey, makeSolvers, readAnswer, solverPrompt, Solver } from './choices-check.js';

const OPTIONS: Choice[] = [
  { label: 'A', text: 'alpha' },
  { label: 'B', text: 'beta' },
  { label: 'C', text: 'gamma' },
];
const quiz = (key: number | null = 1): ParsedChoices => ({ text: 'Which one?', choices: OPTIONS, quiz: true, ...(key !== null ? { key } : {}) });
const says = (answer: string | null): Solver => async () => answer;

describe('readAnswer', () => {
  it('reads a letter, with or without the punctuation a model puts round it, and NONE', () => {
    expect(readAnswer('B')).toBe('B');
    expect(readAnswer(' b. ')).toBe('B');
    expect(readAnswer('(C)')).toBe('C');
    expect(readAnswer('**A**')).toBe('A');
    expect(readAnswer('none')).toBe('NONE');
    expect(readAnswer('NONE.')).toBe('NONE');
  });

  it('reads nothing from a sentence, an empty answer, or a letter that is not an option', () => {
    expect(readAnswer('The answer is B')).toBeNull();
    expect(readAnswer('')).toBeNull();
    expect(readAnswer(undefined)).toBeNull();
    expect(readAnswer('G')).toBeNull();
    expect(readAnswer('AB')).toBeNull();
  });
});

describe('solverPrompt', () => {
  it('is the question and the options with their letters, and no answer', () => {
    expect(solverPrompt('Which one?', OPTIONS)).toBe('Which one?\n\nA) alpha\nB) beta\nC) gamma');
  });
});

describe('checkKey', () => {
  it('trusts the answer when every solver that answered picked it', async () => {
    expect(await checkKey(quiz(), [says('B'), says('B')])).toBe('agree');
    expect(await checkKey(quiz(), [says('B'), says(null)])).toBe('agree');          // one that could not say counts for nothing
  });

  it('doubts it when one solver picked another option, or found none or several right', async () => {
    expect(await checkKey(quiz(), [says('B'), says('A')])).toBe('doubt');
    expect(await checkKey(quiz(), [says('B'), says('NONE')])).toBe('doubt');
    expect(await checkKey(quiz(), [says('C')])).toBe('doubt');
  });

  it('does not know when nobody could say, when there is no solver, or when there is no answer to check', async () => {
    expect(await checkKey(quiz(), [says(null), says(null)])).toBe('unknown');
    expect(await checkKey(quiz(), [])).toBe('unknown');
    expect(await checkKey(quiz(null), [says('B')])).toBe('unknown');
    expect(await checkKey({ text: 'plain' }, [says('B')])).toBe('unknown');
  });

  it('is not undone by a solver that throws', async () => {
    const broken: Solver = async () => {
      throw new Error('gateway down');
    };
    expect(await checkKey(quiz(), [broken, says('B')])).toBe('agree');
    expect(await checkKey(quiz(), [broken])).toBe('unknown');
  });

  it('asks every solver the question as the student reads it, in the order the student sees', async () => {
    const asked: Array<[string, Choice[]]> = [];
    const spy: Solver = async (q, o) => {
      asked.push([q, o]);
      return 'B';
    };
    await checkKey(quiz(), [spy, spy]);
    expect(asked).toEqual([['Which one?', OPTIONS], ['Which one?', OPTIONS]]);
  });
});

describe('makeSolvers', () => {
  const env = (extra: Record<string, string> = {}) => ({ TAI_VOICE_LLM_KEY: 'k-123', TAI_VOICE_LLM_URL: 'http://gateway.test:4010', ...extra }) as NodeJS.ProcessEnv;
  const reply = (content: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response);

  it('has none without the gateway key, or when it is switched off', () => {
    expect(makeSolvers({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(makeSolvers(env({ TAI_CHOICES_CHECK: '0' }))).toEqual([]);
  });

  it('has gpt-oss and qwen by default, and the models TAI_CHOICES_CHECK_MODELS names (names that are not model names are dropped)', () => {
    expect(makeSolvers(env())).toHaveLength(2);
    expect(makeSolvers(env({ TAI_CHOICES_CHECK_MODELS: 'qwen' }))).toHaveLength(1);
    expect(makeSolvers(env({ TAI_CHOICES_CHECK_MODELS: 'a, b ,c d, $(x)' }))).toHaveLength(2);
  });

  it('asks the gateway with the key, a temperature of 0 and no answer in the prompt, and reads the letter back', async () => {
    const fetchImpl = reply('B');
    const [solve] = makeSolvers(env({ TAI_CHOICES_CHECK_MODELS: 'qwen' }), fetchImpl as unknown as typeof fetch);
    expect(await solve('Which one?', OPTIONS)).toBe('B');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://gateway.test:4010/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k-123');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'qwen', temperature: 0, stream: false });
    expect(body.messages[1].content).toBe('Which one?\n\nA) alpha\nB) beta\nC) gamma');
    expect(JSON.stringify(body)).not.toMatch(/correct"|key/);
  });

  it('says nothing when the gateway fails, answers in words, or is unreachable', async () => {
    for (const fetchImpl of [reply('B', false), reply('I think B'), vi.fn(async () => { throw new Error('down'); })]) {
      const [solve] = makeSolvers(env({ TAI_CHOICES_CHECK_MODELS: 'qwen' }), fetchImpl as unknown as typeof fetch);
      expect(await solve('Which one?', OPTIONS)).toBeNull();
    }
  });
});
