import { describe, expect, it } from 'vitest';

import { isChatClaim } from './chat-claim.js';

describe('a claim that something is in the chat', () => {
  it.each([
    'I put it in the chat.',
    "I've put it in the chat now.",
    'I just sent the steps to the chat.',
    'I added a brief Raft summary to the chat.',
    'I have posted it on the page.',
    "It's in the chat now.",
    'That is in the chat.',
    "It's all in the chat.",
    'Check the chat for the link.',
    'Take a look at your chat.',
    "You'll find it in the chat.",
    'You can see it in the chat.',
    'Sent it to the chat.',
    'The deadline is Friday and I put it in the chat.',
    'The Raft slides are in the chat now.',
    'The summary is already in the chat.',
  ])('is found in "%s"', (text) => {
    expect(isChatClaim(text)).toBe(true);
  });

  it.each([
    "I'll put it in the chat.",
    'I can put it in the chat if you want.',
    'Want me to put it in the chat?',
    'Should I send the steps to the chat?',
    'Let me put it in the chat.',
    'You can type your question in the chat.',
    'Paste it in the chat when you have it.',
    "It's on the page for week three.",
    'I see your message in the chat.',
    'The chat is on the right of the page.',
    'The next homework is due today at nine.',
    'Your question is in the chat, but I cannot see a picture.',
    '',
  ])('is not found in "%s"', (text) => {
    expect(isChatClaim(text)).toBe(false);
  });
});
