import { describe, expect, it } from 'vitest';

import { SpeechGovernor } from './speech-governor.js';
import { LIST_REQUEST, TEACH_LIMITS, TEACH_REQUEST, TEACH_TURNS, lastStudentLines, teachingNow } from './teach.js';

const user = (content: string) => ({ role: 'user', content });
const tai = (content: string) => ({ role: 'assistant', content });
const NOTE = (text: string) => text.startsWith('[SYSTEM');

describe('TEACH_REQUEST', () => {
  it('is a student asking to be taught or to have something explained, however they put it', () => {
    for (const said of [
      'Can you teach me?',
      'teach me about Raft',
      'Could you explain how leader election works',
      'explain that',
      'Okay. Explain that.',
      'walk me through it',
      'tell me about midterm mastery',
      'Tell me more about replication',
      'how does Raft handle a split vote',
      'why does the leader send heartbeats',
      'go on',
      'keep going',
      'continue please',
      'in more detail',
      'start from the basics',
      'Can you go over the Day 1 lecture?',
    ]) {
      expect(TEACH_REQUEST.test(said), said).toBe(true);
    }
  });

  it('is not a greeting, a backchannel, an answer or a plain question for a fact', () => {
    for (const said of ['hello', 'Okay.', 'mm-hm', 'because it is cheaper', 'I do not know', 'Anything.', 'What is assignment one?', "What's my score?", 'Do you see the Piazza?', 'thank you', 'send it in the chat']) {
      expect(TEACH_REQUEST.test(said), said).toBe(false);
    }
  });
});

describe('LIST_REQUEST', () => {
  it('is a student asking for several things, in the words of the call that got "Here\'s a quick rundown." and nothing after it', () => {
    for (const said of [
      'Can you help me identify some, uh, interesting final projects so I can, um, pick one to join?',
      'Okay. Tell me.',
      'Tell me.',
      'Okay. Then give me a few. I told you to give me a few project proposals.',
      'what other project ideas have been posted on Piazza',
      'which ones are looking for members?',
      'what are the options?',
      'give me some examples',
      'any other projects?',
      'can I get a quick rundown',
      'summarize the proposals',
      'What are some good topics for the final project?',
      'the interesting ones',
    ]) {
      expect(LIST_REQUEST.test(said), said).toBe(true);
    }
  });

  it('is not a greeting, a thank-you, an answer, or a question that asks for one thing', () => {
    for (const said of ['hello', 'Thank you so much.', 'That is the only one.', 'What is the final project?', 'When is my presentation date?', 'Do I need to prepare slides or videos?', 'Can you explain the second one for me?', "What's the email of the instructor?", 'yes', 'Okay.']) {
      expect(LIST_REQUEST.test(said), said).toBe(false);
    }
  });
});

describe('lastStudentLines', () => {
  it('is the student\'s own turns, newest first, with no word of TAi\'s and none of the host\'s notes', () => {
    const messages = [user('one'), tai('a'), user('[SYSTEM NOTE] look-up done'), user('two'), tai('b'), user('three')];
    expect(lastStudentLines(messages, 5, NOTE)).toEqual(['three', 'two', 'one']);
    expect(lastStudentLines(messages, 2, NOTE)).toEqual(['three', 'two']);
    expect(lastStudentLines('nothing', 3)).toEqual([]);
    expect(lastStudentLines([{ role: 'user', content: [{ text: 'in ' }, { text: 'parts' }] }], 1)).toEqual(['in parts']);
  });
});

describe('teachingNow', () => {
  it('is on from the request through the answers that follow it: "teach me", "anything", "okay", "okay"', () => {
    const call = [user('Can you teach me?'), tai('Sure. What part?'), user('Anything.'), tai("Got it."), user('Okay.'), tai('Right, so scaling up is a bigger machine.'), user('Okay.')];
    expect(teachingNow(call.slice(0, 1))).toBe(true);
    expect(teachingNow(call.slice(0, 3))).toBe(true);
    expect(teachingNow(call)).toBe(true);
  });

  it('is off in an ordinary conversation, and when the request is further back than the last few turns', () => {
    expect(teachingNow([user('Do you hear me?'), tai('Yes.'), user('Who are you?')])).toBe(false);
    const old = [user('teach me about Raft'), ...Array.from({ length: TEACH_TURNS }, (_, i) => [tai('x'), user(`what is thing ${i}?`)]).flat()];
    expect(teachingNow(old)).toBe(false);
    expect(teachingNow([user('teach me about Raft'), tai('Right.'), user('and?')])).toBe(true);
    expect(teachingNow(undefined)).toBe(false);
  });

  it('is on for a request for several things and for the turns after it, and not for a plain question', () => {
    const call = [user('Can you help me identify some interesting final projects?'), tai('Here is a quick rundown.'), user('Okay. Tell me.'), tai('The MUD project is fun.'), user("That's the only one.")];
    expect(teachingNow(call.slice(0, 1))).toBe(true);
    expect(teachingNow(call)).toBe(true);
    expect(teachingNow([user('When is my presentation date?')])).toBe(false);
  });

  it('does not take the host\'s own notes for the student asking', () => {
    expect(teachingNow([user('[SYSTEM NOTE] explain the result to the student')], NOTE)).toBe(false);
  });
});

describe('what the governor lets a lesson say', () => {
  const said = (text: string, options: Partial<ConstructorParameters<typeof SpeechGovernor>[0]> = {}) => {
    const governor = new SpeechGovernor({ chatClaimsAllowed: true, ...options });
    return governor.push(text) + governor.end();
  };
  const LESSON =
    'Scaling up means buying a bigger machine. Scaling out means running copies of your service on many smaller machines. ' +
    'The second one is cheaper at scale and survives a machine dying, which is why the cloud runs on it. ' +
    'The price is that the copies must agree about the data. What do you think goes wrong first?';

  it('cuts it to two sentences in an ordinary answer, and lets it through in full while teaching, up to the question', () => {
    const ordinary = said(LESSON).trim();
    expect(ordinary.split(/(?<=[.?])\s+/).length).toBeLessThanOrEqual(2);
    const lesson = said(LESSON, TEACH_LIMITS).trim();
    expect(lesson).toBe(LESSON);
    expect(lesson.split(/(?<=[.?])\s+/)).toHaveLength(5);
  });

  it('still stops after a question and keeps to its word limit', () => {
    expect(said('Why do you think so? And another thing.', TEACH_LIMITS).trim()).toBe('Why do you think so?');
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} has a handful of words in it.`).join(' ');
    const out = said(long, TEACH_LIMITS).trim();
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(TEACH_LIMITS.maxWords! + 12);
    expect(out.split(/(?<=[.?])\s+/).length).toBeLessThanOrEqual(TEACH_LIMITS.maxSentences!);
  });
});
