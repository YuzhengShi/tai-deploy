import { describe, expect, it } from 'vitest';

import { replyBudget, replyRule, studentText, trimClosingFormula, withReplyRule } from './reply-shape.js';
import { formatOutbound } from './router.js';

describe('studentText', () => {
  it("drops the host's own notes and the label of a voice note", () => {
    expect(studentText('[The student reacted 👍 to your earlier message: "Good."]\nwhat is due?')).toBe('what is due?');
    expect(studentText('[Voice note, 0:12] what is due this week')).toBe('what is due this week');
    expect(studentText('[SYSTEM] try again\nhello there')).toBe('hello there');
  });
});

describe('replyBudget', () => {
  it('gives a short question a short answer', () => {
    expect(replyBudget(["what week i'm in ?"])).toEqual({ limit: 24, unit: 'words', deep: false, studentWords: 4 });
    expect(replyBudget(['can you send me the slides?']).limit).toBe(30);
  });

  it('gives an explanation about 60 words, and a request for depth 110 in paragraphs', () => {
    expect(replyBudget(['tell me about week 1 content']).limit).toBe(60);
    expect(replyBudget(['how does Raft handle split votes?']).limit).toBe(60);
    expect(replyBudget(["what's a mock interview in this course"]).limit).toBe(60);
    expect(replyBudget(['explain CAP in detail'])).toMatchObject({ limit: 110, deep: true });
    expect(replyBudget(['walk me through it step by step'])).toMatchObject({ limit: 110, deep: true });
  });

  it('keeps a greeting to a line', () => {
    expect(replyBudget(['hi']).limit).toBe(14);
    expect(replyBudget(['Hello there']).limit).toBe(14);
    expect(replyBudget(['hey can you explain raft']).limit).toBe(60);
  });

  it('gives a pasted error or a piece of code room in proportion, up to 120', () => {
    expect(replyBudget(['word '.repeat(60)]).limit).toBe(48);
    expect(replyBudget(['word '.repeat(200)]).limit).toBe(120);
  });

  it('halves the budget of a student who has just said too long, in their own words or through the page', () => {
    expect(replyBudget(["what's next?", '[The student said your earlier message was too long: "Sure! Here is a ..."]']).limit).toBe(10);
    expect(replyBudget(['too long. can you explain leader election']).limit).toBe(30);
    expect(replyBudget(['太长了']).limit).toBeLessThanOrEqual(20);
  });

  it('counts a message of several pending fragments as one request', () => {
    expect(replyBudget(['hey', 'about raft', 'how does leader election work?']).studentWords).toBe(8);
  });

  it('measures Chinese in characters', () => {
    expect(replyBudget(['这是什么课程？'])).toEqual({ limit: 120, unit: 'characters', deep: false, studentWords: 6, language: 'Chinese' });
    expect(replyBudget(['これは何のコースですか'])).toMatchObject({ unit: 'characters', language: 'Japanese' });
    expect(replyBudget(['이 수업은 무엇인가요'])).toMatchObject({ unit: 'characters', language: 'Korean' });
    expect(replyBudget(['what is this course'])).not.toHaveProperty('language');
    expect(replyBudget(['你知道我妈'])).toMatchObject({ unit: 'characters', limit: 42 });
  });

  it('never asks for fewer than ten words nor, short of a request for depth, for more than the explanation allowance of a short question', () => {
    for (const text of ['ok', 'what?', 'why', 'thanks', 'what is due']) {
      const b = replyBudget([text]);
      expect(b.limit).toBeGreaterThanOrEqual(10);
      expect(b.limit).toBeLessThanOrEqual(60);
    }
  });
});

describe('replyRule', () => {
  it('names the number, the unit and what a reply is not', () => {
    const rule = replyRule(replyBudget(["what week i'm in ?"]));
    expect(rule).toMatch(/^<reply_rule>This reply: about 24 words at most \(they wrote 4\)/);
    expect(rule).toContain('no bullet points, no bold');
    expect(rule).toContain('Go past 24 words only if they ask for depth.');
    expect(rule.endsWith('</reply_rule>')).toBe(true);
  });

  it('allows paragraphs, not lists, when the student asked for depth', () => {
    const rule = replyRule(replyBudget(['explain Raft in detail']));
    expect(rule).toContain('They asked for depth: up to 110 words, in short paragraphs.');
    expect(rule).toContain('no bullet points');
  });

  it('says characters for Chinese, and which language to answer in', () => {
    const rule = replyRule(replyBudget(['这是什么课程？']));
    expect(rule).toContain('about 120 characters at most (they wrote 6)');
    expect(rule).toContain('Answer in Chinese; technical terms stay in English.');
  });

  it('tells the model to look when the student asks whether it can open or read something', () => {
    for (const text of ['can you view the first pdf?', 'Can you read the slides pdf from canvas?', 'are you able to open the syllabus', 'can you send me the slides?', '你能打开第一个PDF吗']) {
      expect(replyBudget([text]).ability).toBe(true);
      expect(replyRule(replyBudget([text]))).toContain('try it now with your tools and answer from what you saw, not from memory');
    }
    for (const text of ['what week am I in?', 'can you run code?', 'can you explain raft', 'I can read it myself']) {
      expect(replyBudget([text]).ability).toBeUndefined();
      expect(replyRule(replyBudget([text]))).not.toContain('try it now');
    }
  });

  it('keeps an answer to a bare emoji to a few words, and tells the model what each emoji asks of it', () => {
    const note = '[The student reacted 😂 to your earlier message: "A mutex is a lock."]\n';
    expect(replyBudget([note])).toMatchObject({ reactionOnly: true, limit: 8 });
    expect(replyBudget(['[The student liked your voice call]\n'])).toMatchObject({ reactionOnly: true });
    expect(replyBudget([note + '[The student reacted 👍 to your earlier message: "Yes."]\n'])).toMatchObject({ reactionOnly: true });
    const rule = replyRule(replyBudget([note]));
    expect(rule).toContain('only an emoji');
    expect(rule).toContain('8 words at most');
    expect(rule).toContain('😢: ask gently what is wrong');
    expect(rule.startsWith('<reply_rule>') && rule.endsWith('</reply_rule>')).toBe(true);
  });

  it('is not a bare emoji when the student also said something, or when it is only a note about the call', () => {
    expect(replyBudget(['[The student reacted 😂 to your earlier message: "x"]\nwhy is that funny']).reactionOnly).toBeUndefined();
    expect(replyBudget(['[The student said your earlier message was too long: "x"]\n']).reactionOnly).toBeUndefined();
    expect(replyBudget(['hello']).reactionOnly).toBeUndefined();
  });

  it('gives the answer to a tap on an option room for a verdict, a reason and one follow-up, and says options are a block', () => {
    const quiz = '[The student answered your multiple-choice question "Which?". They chose B, "x". That is the answer you marked.]\nB. x';
    const b = replyBudget([quiz]);
    expect(b.choice).toBe('answer');
    expect(b.limit).toBeGreaterThanOrEqual(45);                    // the option's few words would have given it 18
    const rule = replyRule(b);
    expect(rule).toContain('They tapped an answer to your quick check');
    expect(rule).toContain('First whether it was right');
    expect(rule).toContain('<choices> block');
    expect(rule).toContain('do not list the options again');
    expect(rule.startsWith('<reply_rule>') && rule.endsWith('</reply_rule>')).toBe(true);
    const pick = replyBudget(['[The student picked an option on your question "Which part?". They chose A, "y".]\nA. y']);
    expect(pick.choice).toBe('pick');
    const pickRule = replyRule(pick);
    expect(pickRule).toContain('there is no right answer to grade');
    expect(pickRule).toContain('Not a quick check unless they ask for one');
    expect(pickRule).not.toContain('First whether it was right');
    expect(replyBudget(['B. x']).choice).toBeUndefined();          // an ordinary message that happens to look like an option
    expect(replyBudget(['[The student reacted 👍 to your earlier message: "x"]\nB. x']).choice).toBeUndefined();
    expect(replyBudget(['[The student answered your multiple-choice question "Q". They chose B, "x".]\n好的']).limit).toBeGreaterThanOrEqual(90);   // characters, for a student who writes Chinese
  });

  it('no longer forbids a list of options in the ordinary rule: they go in a block, which is not counted', () => {
    const rule = replyRule(replyBudget(['quiz me on raft']));
    expect(rule).not.toContain('no list of options');
    expect(rule).toContain('<choices> block is how you offer options, and it does not count');
    expect(rule).toContain('no lettered or numbered list in your words');
  });

  it('leaves teaching to the persona: no rule that every reply ends in a question', () => {
    const rule = replyRule(replyBudget(['how does Raft handle split votes?']));
    expect(rule).toContain('Teaching: follow your strategy');
    expect(rule).not.toMatch(/ending with the single question/);
  });
});

describe('trimClosingFormula', () => {
  it('takes a closing formula off the end', () => {
    expect(trimClosingFormula('Week 9. HW7 is due Nov 9. Let me know if you need anything else.')).toBe('Week 9. HW7 is due Nov 9.');
    expect(trimClosingFormula("I'd start with the Day 1 slides. Is there anything else?")).toBe("I'd start with the Day 1 slides.");
  });

  it('takes two of them, because a model writes them in pairs', () => {
    expect(trimClosingFormula('Here is the link. Hope this helps! Feel free to ask more.')).toBe('Here is the link.');
  });

  it('keeps an offer or a question that says something', () => {
    expect(trimClosingFormula('It is due Monday. Want me to set a reminder?')).toBe('It is due Monday. Want me to set a reminder?');
    expect(trimClosingFormula('Raft elects a leader by votes. Which part is unclear?')).toBe('Raft elects a leader by votes. Which part is unclear?');
  });

  it('keeps a reply that is nothing but the formula, or whose rest is too short to stand', () => {
    expect(trimClosingFormula('Let me know if you need anything.')).toBe('Let me know if you need anything.');
    expect(trimClosingFormula('Sure. Let me know if you need anything else.')).toBe('Sure. Let me know if you need anything else.');
  });

  it('does not reach into the middle of a reply or into code', () => {
    expect(trimClosingFormula('Feel free to skip it. The deadline is Monday at nine.')).toBe('Feel free to skip it. The deadline is Monday at nine.');
    const code = 'Try this one, it is short:\n```go\nfmt.Println("hi")\n```';
    expect(trimClosingFormula(code)).toBe(code);
  });
});

describe('withReplyRule', () => {
  it('puts the rule after the messages, so it is the last thing the model reads', () => {
    const prompt = '<messages>\n<message id="1" sender="A" time="t">hi</message>\n</messages>';
    const out = withReplyRule(prompt, ['hi']);
    expect(out.startsWith(`${prompt}\n\n<reply_rule>`)).toBe(true);
    expect(out.endsWith('</reply_rule>')).toBe(true);
  });
});

describe('what the student sees', () => {
  it('never carries the rule, in case a model repeats it', () => {
    expect(formatOutbound('week nine. <reply_rule>about 24 words</reply_rule>')).toBe('week nine.');
    expect(formatOutbound('week nine. <reply_rule>about 24 words at most')).toBe('week nine.');
  });
});
