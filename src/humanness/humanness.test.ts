import { describe, expect, it } from 'vitest';

import { judge, judgePrompt, parseJudge } from './judge.js';
import { lastSentences, openerRepeats, rate, repeatedLines, replyShape, stats, summarizeShapes } from './metrics.js';
import { buildReport, samplePairs } from './report.js';
import { parseDump, parseHistory, parseTranscript, type Sources } from './sources.js';

describe('replyShape', () => {
  it('sees the shapes of a bot in a reply', () => {
    const s = replyShape('Week 1 covers:\n\n* **Go** basics\n* Cloud VMs\n\nWhich part first? Or would you like the slides?');
    expect(s).toMatchObject({ bullets: true, bold: true, closer: true, questions: 2, endsWithQuestion: true, links: 0, code: false });
  });

  it('does not see them in a short, plain reply', () => {
    const s = replyShape('Week 9. HW7 is due Nov 9.');
    expect(s).toMatchObject({ words: 7, bullets: false, bold: false, headings: false, closer: false, questions: 0, endsWithQuestion: false });
  });

  it('reads a closing formula only at the end, and leaves code alone', () => {
    expect(replyShape('Feel free to skip it. The deadline is Monday at nine, and the second part is optional.').closer).toBe(false);
    expect(replyShape('It is in the Files tab. Let me know if you need anything else.').closer).toBe(true);
    expect(replyShape('Try this:\n```go\n// let me know if\n* x\n```').bullets).toBe(false);
  });

  it('counts Chinese in half-characters like a word', () => {
    expect(replyShape('这是一个很长的中文回答，用来测试字数。').words).toBe(9);
  });

  it('counts links and headings', () => {
    expect(replyShape('# Title\nhttps://a.example/x and https://b.example/y').links).toBe(2);
    expect(replyShape('# Title\ntext').headings).toBe(true);
  });
});

describe('stats, rate, openers', () => {
  it('summarizes numbers', () => {
    expect(stats([])).toEqual({ n: 0, mean: 0, median: 0, p90: 0, max: 0 });
    expect(stats([10, 20, 30, 40, 100])).toEqual({ n: 5, mean: 40, median: 30, p90: 100, max: 100 });
    expect(rate([true, false, true, true])).toBe(0.75);
    expect(rate([])).toBe(0);
  });

  it('finds replies that start alike', () => {
    expect(openerRepeats(['Sure! here you go', 'Sure, here is more', 'Week 9.', 'It is due Monday', 'Sure thing']).toFixed(2)).toBe('0.40');
    expect(openerRepeats(['a b', 'a b'])).toBe(0);
  });

  it('lists short lines said more than once', () => {
    expect(repeatedLines(['One sec.', 'one  sec.', 'The grades are not posted yet, sorry about that.', 'Hello'])).toEqual([{ text: 'one sec.', count: 2 }]);
  });

  it('takes the last sentences of a text without its code', () => {
    expect(lastSentences('One. Two. Three.', 2)).toBe('Two. Three.');
    expect(lastSentences('Look.\n```x. y.```', 1)).toBe('Look.');
  });

  it('summarizes a list of replies', () => {
    const s = summarizeShapes(['Week 9.', 'x '.repeat(80).trim()]);
    expect(s.n).toBe(2);
    expect(s.overBudget).toBe(0.5);
    expect(s.words.max).toBe(80);
  });
});

const HISTORY = [
  '{"n":1,"ts":"2026-11-02T20:00:00.000Z","role":"user","text":"what week am I in?"}',
  '{"n":2,"ts":"2026-11-02T20:00:05.000Z","role":"assistant","text":"Week 9. HW7 is due Nov 9. Let me know if you need anything else."}',
  '{"n":3,"ts":"2026-11-02T20:01:00.000Z","role":"user","text":"tell me about week 1"}',
  '{"n":4,"ts":"2026-11-02T20:01:09.000Z","role":"assistant","text":"Week 1 covers:\\n\\n* **Go** basics\\n* Cloud VMs\\n\\nWhich part first? Or would you like the slides?"}',
  '{"n":5,"ts":"2026-11-02T20:02:00.000Z","role":"user","kind":"react","to":4,"emoji":"😂","text":""}',
  '{"n":6,"ts":"2026-11-02T20:02:10.000Z","role":"user","kind":"feedback","to":4,"rating":"down","tag":"long","text":""}',
  '{"n":7,"ts":"2026-11-02T20:03:00.000Z","role":"assistant","kind":"image","text":"a diagram"}',
  '{"n":8',
].join('\n');

const TRANSCRIPT = [
  '# 2026-11-02 08:37 · 7 min · conversation',
  '',
  'Summary: We talked.',
  '',
  'Transcript:',
  "- TAi: hey, what's up?",
  "- Student: what's my score?",
  '- TAi: one sec.',
  "- TAi: Your grades aren't posted yet.",
  '- Student: ok',
  '- TAi: one sec.',
  '',
].join('\n');

const DUMP = [
  '{"at":"2026-11-02T18:12:55.314Z","sid":"a","ms":295,"answer":{"finish":"stop","text":"hi","calls":[],"writtenAsText":[],"spoken":"hi","notSpoken":[]}}',
  '{"at":"2026-11-02T18:12:57.284Z","sid":"a","ms":900,"answer":{"finish":"stop","text":"x","calls":[{"name":"send_to_chat"}],"writtenAsText":[{"name":"x"}],"spoken":"","notSpoken":["thinking aloud"]}}',
  'not json',
].join('\n');

function sources(): Sources {
  return { histories: new Map([['s_1', parseHistory(HISTORY)]]), calls: [parseTranscript(TRANSCRIPT)!], dump: parseDump(DUMP) };
}

describe('parsers', () => {
  it('reads a history and skips a half-written last line', () => {
    const rows = parseHistory(HISTORY);
    expect(rows).toHaveLength(7);
    expect(rows[3]).toMatchObject({ n: 4, role: 'assistant', kind: 'text' });
    expect(rows[4]).toMatchObject({ kind: 'react', to: 4, emoji: '😂' });
    expect(rows[5]).toMatchObject({ kind: 'feedback', rating: 'down', tag: 'long' });
  });

  it('reads a transcript', () => {
    const call = parseTranscript(TRANSCRIPT)!;
    expect(call).toMatchObject({ when: '2026-11-02 08:37', minutes: 7, mode: 'conversation' });
    expect(call.turns).toHaveLength(6);
    expect(call.turns[1]).toEqual({ who: 'student', text: "what's my score?" });
    expect(parseTranscript('no title here')).toBeNull();
  });

  it('reads a relay dump', () => {
    const rows = parseDump(DUMP);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ms: 900, notSpoken: ['thinking aloud'], writtenAsText: 1, calls: 1 });
  });
});

describe('buildReport', () => {
  const now = new Date('2026-11-03T00:00:00Z');

  it('puts the shapes, the students\' signals and the calls in one page', () => {
    const report = buildReport(sources(), { now, days: 7 });
    expect(report).toContain('# TAi human-likeness report');
    expect(report).toContain('| all | 2 |');
    expect(report).toMatch(/\| all \| 2 \| [\d.]+ \/ \d+ \/ \d+ \/ \d+ \| 0% \| 50% \| 50% \| 100% \| 50% \| 50%/);
    expect(report).toContain("- Emoji on TAi's messages: 😂 1");
    expect(report).toContain('- Ratings: 0 up, 1 down (long 1); the ones marked too long averaged');
    expect(report).toContain('- 1 call(s), 7 min (conversation 1)');
    expect(report).toContain('"one sec." x2');
    expect(report).toContain('2 requests to the model; sentences cut by the speech governor in 50%');
    expect(report).toContain('## Longest text replies');
  });

  it('puts what came before and after a change side by side', () => {
    const report = buildReport(sources(), { now, days: 7, split: '2026-11-02T20:01:00.000Z' });
    expect(report).toContain('| before 2026-11-02T20:01:00.000Z | 1 |');
    expect(report).toContain('| after 2026-11-02T20:01:00.000Z | 1 |');
  });

  it('says so when there is nothing in the period, and does not fall over on empty sources', () => {
    expect(buildReport({ histories: new Map(), calls: [], dump: [] }, { now, days: 7 })).toContain('None in the period.');
    expect(buildReport(sources(), { now: new Date('2027-01-01T00:00:00Z'), days: 1 })).toContain('None in the period.');
  });

  it('leaves out a section the judge was not asked for, and prints one it was', () => {
    expect(buildReport(sources(), { now, days: 7 })).not.toContain('## Judge');
    const judged = [{ kind: 'text' as const, human: 2, brief: 1, honest: 5, tells: ['closing offer'] }, { kind: 'text' as const, human: 4, brief: 3, honest: 5, tells: ['Closing offer', 'bullet list'] }];
    const report = buildReport(sources(), { now, days: 7, judged });
    expect(report).toContain('- text: 2 exchanges; human 3, brief 2, honest 5 (of 5)');
    expect(report).toContain('closing offer (2)');
  });
});

describe('samplePairs', () => {
  it('pairs each reply with what it answered, typed and spoken', () => {
    const pairs = samplePairs(sources(), '2026-11-01T00:00:00Z', 10);
    expect(pairs).toContainEqual({ kind: 'text', student: 'what week am I in?', reply: 'Week 9. HW7 is due Nov 9. Let me know if you need anything else.' });
    expect(pairs).toContainEqual({ kind: 'voice', student: "what's my score?", reply: 'one sec.' });
    expect(samplePairs(sources(), '2026-11-01T00:00:00Z', 2)).toHaveLength(2);
  });
});

describe('judge', () => {
  it('reads an answer in the asked shape and clamps what it cannot trust', () => {
    expect(parseJudge('```json\n[{"human":4,"brief":9,"honest":"x","tells":["a","b","c","d"]}]\n```', 1)).toEqual([{ human: 4, brief: 5, honest: 3, tells: ['a', 'b', 'c'] }]);
    expect(parseJudge('[{"human":4}]', 2)).toBeNull();
    expect(parseJudge('no json', 1)).toBeNull();
  });

  it('puts each exchange in the prompt', () => {
    const p = judgePrompt([{ kind: 'voice', student: 'hi', reply: 'hey' }]);
    expect(p).toContain('#1 (spoken aloud)');
    expect(p).toContain('Student: hi\nTA: hey');
  });

  it('scores in batches and leaves out a batch the model did not answer properly', async () => {
    const answers = ['[{"human":5,"brief":5,"honest":5,"tells":[]},{"human":1,"brief":2,"honest":3,"tells":["lecture"]}]', 'sorry, no'];
    let call = 0;
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: answers[call++] } }] }) })) as unknown as typeof fetch;
    const pairs = Array.from({ length: 4 }, () => ({ kind: 'text' as const, student: 'q', reply: 'a' }));
    const scores = await judge(pairs, { url: 'http://x/', key: 'k', model: 'm', fetchImpl }, 2);
    expect(scores).toHaveLength(2);
    expect(scores[1]).toMatchObject({ kind: 'text', human: 1, tells: ['lecture'] });
  });

  it('survives a gateway that is away', async () => {
    const fetchImpl = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await judge([{ kind: 'text', student: 'q', reply: 'a' }], { url: 'http://x', key: 'k', model: 'm', fetchImpl })).toEqual([]);
  });
});
