import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultEvaluation, evaluateAnswer, evaluateDetailed, evaluatorPrompt, parseEvaluation, summarizeCall } from './evaluator.js';
import { pickItems, reviewItem } from './review.js';
import type { Weighed } from './review.js';
import { FakeGateway, completion } from './testing/fake-gateway.js';

describe('parsing an evaluation', () => {
  it('takes JSON in prose, in code fences, with trailing commas or single quotes, and clamps the scores', () => {
    expect(parseEvaluation('Here you go: {"accuracy": 7, "depth": 0, "verbal_clarity": "4", "problem_solving": 3.6, "missed_concepts": ["quorum", 5], "suggested_follow_up": "Ask about quorums", "difficulty_adjustment": "HARDER"} hope it helps')).toEqual({
      accuracy: 5,
      depth: 1,
      verbal_clarity: 4,
      problem_solving: 4,
      missed_concepts: ['quorum'],
      suggested_follow_up: 'Ask about quorums',
      difficulty_adjustment: 'harder',
    });
    expect(parseEvaluation('```json\n{"accuracy": 2, "depth": 2, "verbal_clarity": 2, "problem_solving": 2,}\n```')).toMatchObject({ accuracy: 2, difficulty_adjustment: 'maintain' });
    expect(parseEvaluation("{'accuracy': 4, 'depth': 4, 'verbal_clarity': 4, 'problem_solving': 4}")).toMatchObject({ accuracy: 4 });
    expect(parseEvaluation('accuracy: 3, depth: 2, verbal_clarity: 5, problem_solving: 1')).toMatchObject({ accuracy: 3, depth: 2, verbal_clarity: 5, problem_solving: 1 });
  });

  it('gives nothing for nothing', () => {
    expect(parseEvaluation('')).toBeNull();
    expect(parseEvaluation('I cannot evaluate this.')).toBeNull();
    expect(parseEvaluation('[1, 2, 3]')).toBeNull();
    // an object with none of the four scores is not an evaluation: it would stand for an answer that somebody weighed at 3, 3, 3, 3
    expect(parseEvaluation('{}')).toBeNull();
    expect(parseEvaluation('{"better": "name the term", "said": "something"}')).toBeNull();
  });

  it('takes the sentences meant for the student when the model wrote them, and leaves the keys out when it did not', () => {
    const full = parseEvaluation('{"accuracy": 4, "depth": 3, "verbal_clarity": 4, "problem_solving": 3, "said": "  They said a majority stops two leaders.\\n", "better": "Add that any two majorities share a node."}')!;
    expect(full).toMatchObject({ said: 'They said a majority stops two leaders.', better: 'Add that any two majorities share a node.' });
    const bare = parseEvaluation('{"accuracy": 4, "depth": 3, "verbal_clarity": 4, "problem_solving": 3, "said": "", "better": 7}')!;
    expect(bare).not.toHaveProperty('said');
    expect(bare).not.toHaveProperty('better');
    expect(parseEvaluation(`{"accuracy": 4, "better": "${'b'.repeat(900)}"}`)!.better).toHaveLength(300);
  });
});

describe('what the evaluator is asked for', () => {
  const prompt = evaluatorPrompt({ studentName: 'Ana', weakConcepts: ['Raft (0.4)'], misconceptions: [] });

  it('asks for a sentence the student can read and a stronger answer, with no scores in either, next to the scores the interviewer uses', () => {
    expect(prompt).toContain('"said":');
    expect(prompt).toContain('"better":');
    expect(prompt).toMatch(/shown to the student afterwards/);
    expect(prompt).toMatch(/Never put a score, a number out of five or a percentage in "said" or "better"/);
    expect(prompt).toMatch(/at most 35 words/);
    expect(prompt).toContain('"difficulty_adjustment": "easier" | "maintain" | "harder"');
    expect(prompt).toContain('Known weak spots: Raft (0.4)');
  });
});

describe('the shadow evaluator on the gateway', () => {
  let gw: FakeGateway;
  beforeEach(async () => {
    gw = await FakeGateway.start();
  });
  afterEach(async () => {
    await gw.close();
  });
  const ctx = { studentName: 'Ana', weakConcepts: ['Raft (0.4)'], misconceptions: ['leaders commit alone'] };
  const input = { question_asked: 'Why a majority?', student_answer_summary: 'so two leaders cannot both commit', topic: 'Raft' };

  it('asks the eval model with the rubric and the student context, and returns the parsed scores', async () => {
    gw.respond = () => completion('{"accuracy": 4, "depth": 3, "verbal_clarity": 4, "problem_solving": 3, "missed_concepts": [], "suggested_follow_up": "terms", "difficulty_adjustment": "harder"}');
    const r = await evaluateAnswer(input, ctx, { url: gw.url, key: 'k1', model: 'gpt-oss-eval' });
    expect(r).toMatchObject({ accuracy: 4, difficulty_adjustment: 'harder' });
    const req = gw.requests[0];
    expect(req.headers.authorization).toBe('Bearer k1');
    expect(req.body.model).toBe('gpt-oss-eval');
    expect(req.body.stream).toBe(false);
    const [system, user] = req.body.messages as Array<{ content: string }>;
    expect(system.content).toContain('Known weak spots: Raft (0.4)');
    expect(system.content).toContain('"difficulty_adjustment": "easier" | "maintain" | "harder"');
    expect(user.content).toContain('Why a majority?');
  });

  it('never throws: bad JSON, an error status, a hang or no gateway give the neutral evaluation', async () => {
    gw.respond = () => completion('as an AI I think the answer was ok');
    expect(await evaluateAnswer(input, ctx, { url: gw.url, key: '', model: 'm' })).toEqual(defaultEvaluation());
    gw.respond = () => ({ status: 500, text: 'boom' });
    expect(await evaluateAnswer(input, ctx, { url: gw.url, key: '', model: 'm' })).toEqual(defaultEvaluation());
    gw.respond = () => ({ json: { choices: [] } });
    expect(await evaluateAnswer(input, ctx, { url: gw.url, key: '', model: 'm' })).toEqual(defaultEvaluation());
    gw.respond = () => ({ ...completion('{}'), delayMs: 500 });
    expect(await evaluateAnswer(input, ctx, { url: gw.url, key: '', model: 'm', timeoutMs: 100 })).toEqual(defaultEvaluation());
    expect(await evaluateAnswer(input, ctx, { url: 'http://127.0.0.1:9', key: '', model: 'm', timeoutMs: 500 })).toEqual(defaultEvaluation());
  });

  it('says whether it really scored: the neutral evaluation of a gateway that failed is not a score', async () => {
    gw.respond = () => completion('{"accuracy": 4, "depth": 3, "verbal_clarity": 4, "problem_solving": 3, "said": "They said a majority.", "better": "Name the term."}');
    expect(await evaluateDetailed(input, ctx, { url: gw.url, key: '', model: 'm' })).toMatchObject({ scored: true, result: { accuracy: 4, said: 'They said a majority.', better: 'Name the term.' } });
    for (const failing of [() => completion('as an AI I think the answer was ok'), () => ({ status: 500, text: 'boom' }), () => completion('{}')]) {
      gw.respond = failing;
      const r = await evaluateDetailed(input, ctx, { url: gw.url, key: '', model: 'm' });
      expect(r).toEqual({ result: defaultEvaluation(), scored: false });
    }
    expect(await evaluateDetailed(input, ctx, { url: 'http://127.0.0.1:9', key: '', model: 'm', timeoutMs: 300 })).toEqual({ result: defaultEvaluation(), scored: false });
  });

  it('sends the interviewer the same evaluation it always got, and the sentences for the student to the review alone (evaluateAnswer is the old function)', async () => {
    gw.respond = () => completion('{"accuracy": 4, "depth": 3, "verbal_clarity": 4, "problem_solving": 3, "missed_concepts": [], "suggested_follow_up": "x", "difficulty_adjustment": "harder", "better": "Name the term."}');
    expect(await evaluateAnswer(input, ctx, { url: gw.url, key: '', model: 'm' })).toMatchObject({ accuracy: 4, better: 'Name the term.' });
  });

  it('turns a strong answer and a vague one into review items with a fake model: words for bands, the stronger sentence, nothing for a failed evaluation', async () => {
    const answers: Record<string, string> = {
      strong: '{"accuracy": 5, "depth": 4, "verbal_clarity": 5, "problem_solving": 4, "missed_concepts": [], "said": "They said a majority means any two quorums share a node.", "better": "You could add what a candidate does when its term is stale."}',
      vague: '{"accuracy": 2, "depth": 1, "verbal_clarity": 2, "problem_solving": 1, "missed_concepts": ["quorum intersection"], "said": "They said it is for fault tolerance.", "better": "Say why: any two majorities overlap, so a second leader cannot be elected unseen."}',
      broken: 'no json here',
    };
    const pool: Weighed[] = [];
    for (const [which, question] of [['strong', 'Why a majority?'], ['vague', 'Why not just two nodes?'], ['broken', 'What is a term?']] as const) {
      gw.respond = () => completion(answers[which]);
      const args = { question_asked: question, student_answer_summary: `an answer: ${which}`, topic: 'Raft' };
      const { result, scored } = await evaluateDetailed(args, ctx, { url: gw.url, key: '', model: 'm' });
      const w = scored ? reviewItem(args, result) : null;
      if (w) pool.push(w);
    }
    const items = pickItems(pool);
    expect(items).toEqual([
      { question: 'Why a majority?', said: 'They said a majority means any two quorums share a node.', band: 'solid', better: 'You could add what a candidate does when its term is stale.', topic: 'Raft' },
      { question: 'Why not just two nodes?', said: 'They said it is for fault tolerance.', band: 'just started', better: 'Say why: any two majorities overlap, so a second leader cannot be elected unseen.', topic: 'Raft' },
    ]);
    // the band is a word, and the evaluation of the third answer, which the gateway could not give, is not in the review at all
    for (const item of items) expect(item.band).toMatch(/^[a-z ]+$/);
    expect(items.some((i) => i.question === 'What is a term?')).toBe(false);
  });

  it('summarizes a call in plain text, or gives null', async () => {
    gw.respond = () => completion('**We** talked about Raft.\n\n- You explained elections.');
    expect(await summarizeCall([{ role: 'student', text: 'raft?' }], ['competency changes: Raft 0.4 → 0.55'], { url: gw.url, key: '', model: 'm' })).toBe(
      'We talked about Raft. - You explained elections.',
    );
    expect(gw.requests[0].body.messages).toBeTruthy();
    expect(await summarizeCall([], [], { url: gw.url, key: '', model: 'm' })).toBeNull();
    gw.respond = () => ({ status: 503, text: 'no' });
    expect(await summarizeCall([{ role: 'tai', text: 'hi' }], [], { url: gw.url, key: '', model: 'm' })).toBeNull();
  });
});
