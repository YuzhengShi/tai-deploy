import { describe, expect, it } from 'vitest';

import { LEAD_IN_MAX_WORDS, isLeadIn } from './lead-in.js';
import { lines } from './prompts.js';

describe('isLeadIn', () => {
  it('is a turn that only announces its answer, in the words of the calls where TAi then stopped', () => {
    for (const said of [
      "Here's a quick rundown of the interesting ones.",
      "Got it. Let's start with the basics.",
      'Okay, here are the top three.',
      'Alright, let me give you the short version.',
      'Sure. Let me walk you through it.',
      "I'll give you a quick overview.",
      'There are a few interesting ones.',
      'Okay, so there are a few options.',
      "Here's the plan:",
      "Let's dive in.",
      'The short version.',
      'Well, let me explain.',
      'Nope, there are a few more.',
      'let me take a look. Here\'s a quick rundown of the interesting ones.',
    ]) {
      expect(isLeadIn(said), said).toBe(true);
    }
  });

  it('is not an answer, a question, a look-up filler or anything that says something', () => {
    for (const said of [
      'Sure. What part do you want to start with?',
      "Here's one: the MUD project.",
      "Here's the first one: a chat server in Go. It needs two more members.",
      'First, the MUD project is a game server in Go.',
      'To start, the MUD project is a game server in Go.',
      'There are a few more in the chat.',
      "Here's the draft in the chat.",
      'Done, the email is in the chat.',
      "Here's the list on the page.",
      'one sec.',
      'okay, taking a look.',
      'let me pull that up.',
      'Let me check.',
      'Let me take a look.',
      'hey, what\'s up?',
      "Scaling out means running copies of your service on many smaller machines.",
      'The MUD project is fun, and there are two more people needed for it right now, so it might be worth a look.',
      'Yes.',
      'Okay.',
      'Sorry, I lost you for a second there.',
      '',
    ]) {
      expect(isLeadIn(said), said).toBe(false);
    }
  });

  it('is only a turn of a few words', () => {
    const long = `Here's a rundown of ${Array.from({ length: LEAD_IN_MAX_WORDS }, () => 'the').join(' ')} ones.`;
    expect(isLeadIn(long)).toBe(false);
  });

  it('is none of the lines the host itself has TAi say (a filler or a greeting would otherwise open a lead-in)', () => {
    const said: string[] = [
      lines.chatGreeting(),
      lines.interviewGreeting('Assignment 2'),
      lines.interviewGreeting(''),
      lines.reconnectGreeting('conversational'),
      lines.reconnectGreeting('listener'),
      lines.interviewOpener('Assignment 2'),
      lines.interviewOpener(''),
      lines.interviewReturn('Raft'),
      lines.interviewReturn(null),
      lines.switchFailed(),
      lines.talkSwitchFailed(),
      lines.sessionClosing(),
      lines.interviewClosing(),
      lines.talkClosing(),
      lines.stillThere(),
      ...Object.values(lines.fillers).flat(),
      ...lines.talkOpeners,
      ...lines.talkReturns,
    ];
    expect(said.length).toBeGreaterThan(20);
    for (const line of said) expect(isLeadIn(line), line).toBe(false);
  });
});
