/**
 * A second opinion on a quick check before a student sees it. A model writing "which of these is true" marks the wrong option, or lets two
 * of them be true, in about one question of four (36 questions of gpt-oss on 2026-11-03: the key agreed with an independent answer in 27;
 * where two independent solvers agreed with each other against the key, it was the key that was wrong), and a student told "not quite" for
 * a right answer learns nothing true. So the question is put to other models that have not seen the key: it is trusted only when every
 * solver that answered chose the marked option. When they do not, the key is dropped (the page then gives no verdict of its own) and TAi
 * is told the key is doubtful with the student's pick. A solver that cannot be reached counts for nothing, and none at all means the key
 * stays as TAi wrote it.
 */
import type { Choice, ParsedChoices } from './choices.js';
import { chatCompletionsUrl } from './voice/config.js';

export type Verdict = 'agree' | 'doubt' | 'unknown';
/** One independent solver: the letter of the option it picked, 'NONE' for no or more than one correct option, or null when it could not say. */
export type Solver = (question: string, options: Choice[]) => Promise<string | null>;

const LETTERS = 'ABCDEF';

const SYSTEM =
  'You check multiple-choice questions for a university course on scalable distributed systems. Reply with ONLY the letter of the one option ' +
  'that is correct. If no option is correct, or more than one is correct, reply NONE.';

/** The solver's reply as a letter or NONE, or null when it is neither. */
export function readAnswer(content: unknown): string | null {
  const text = String(content ?? '').trim().toUpperCase();
  if (/^\W*NONE\W*$/.test(text)) return 'NONE';
  const letter = /^\W*([A-F])\W*$/.exec(text);
  return letter ? letter[1] : null;
}

/** The question and the options as the solver reads them. */
export function solverPrompt(question: string, options: Choice[]): string {
  return `${question}\n\n${options.map((o) => `${o.label}) ${o.text}`).join('\n')}`;
}

/** The solvers named by TAI_CHOICES_CHECK_MODELS (default gpt-oss and qwen) on the gateway the voice side uses; none when there is no key or TAI_CHOICES_CHECK=0. */
export function makeSolvers(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Solver[] {
  const key = (env.TAI_VOICE_LLM_KEY || '').trim();
  if (!key || env.TAI_CHOICES_CHECK === '0') return [];
  const url = chatCompletionsUrl(env.TAI_VOICE_LLM_URL || 'http://127.0.0.1:4010');
  const models = (env.TAI_CHOICES_CHECK_MODELS || 'gpt-oss,qwen').split(',').map((m) => m.trim()).filter((m) => /^[\w.:-]+$/.test(m));
  return models.map((model): Solver => async (question, options) => {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: solverPrompt(question, options) },
          ],
          max_tokens: 600,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      return readAnswer(body.choices?.[0]?.message?.content);
    } catch {
      return null;
    }
  });
}

/** Whether the solvers back the answer TAi marked. 'unknown' when there was no answer to check or no solver could say. */
export async function checkKey(parsed: ParsedChoices, solvers: Solver[]): Promise<Verdict> {
  if (!parsed.choices || parsed.key === undefined || solvers.length === 0) return 'unknown';
  const marked = LETTERS[parsed.key];
  const answers = await Promise.all(solvers.map((solve) => solve(parsed.text, parsed.choices as Choice[]).catch(() => null)));
  const said = answers.filter((a): a is string => !!a);
  if (said.length === 0) return 'unknown';
  return said.every((a) => a === marked) ? 'agree' : 'doubt';
}
