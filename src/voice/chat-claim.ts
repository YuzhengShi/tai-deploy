/**
 * "It is in the chat" is true only once send_to_chat or render_diagram has returned. The model says it without having called (the owner's
 * first call), in whatever words it finds: the guard in session.ts asks TAi to send it, or to say that it has not, when this finds such a
 * sentence and nothing went to the chat in the turn.
 */

/**
 * A statement that something is there: first person ("I put it in the chat", "I've added a summary on the page"), or about the thing
 * ("it's in the chat now", "check the chat", "you'll find it in the chat", "sent it to the chat"). Only the first person form also takes
 * "page" (the chat is on the TAi page); "it's on the page" alone could be about anything.
 */
const CLAIM = new RegExp(
  [
    String.raw`\b(?:i|i've|i have|i just)\s+(?:also\s+)?(?:put|posted|sent|dropped|added|shared|saved)\b[^.?!]{0,60}\b(?:chat|page)\b`,
    String.raw`\b(?:it'?s|it is|that'?s|that is|this is|those are|they'?re|they are|there'?s)\s+(?:now\s+|all\s+|already\s+)?(?:in|on)\s+(?:the\s+|your\s+)?chat\b`,
    String.raw`\b(?:is|are)\s+(?:now|already|all|just)\s+in\s+(?:the\s+|your\s+)?chat\b`,
    String.raw`\b(?:is|are)\s+in\s+(?:the\s+|your\s+)?chat\s+now\b`,
    String.raw`\b(?:check|see|look (?:in|at)|take a look at|have a look at)\s+(?:the\s+|your\s+)?chat\b`,
    String.raw`\byou(?:'ll|\s+will|\s+can)\s+(?:find|see)\s+(?:it|that|this|them)\b[^.?!]{0,30}\bchat\b`,
    String.raw`\b(?:sent|posted|added|dropped)\s+(?:it|that|this|them|the summary|a summary)\b[^.?!]{0,30}\b(?:to|in|into|on)\s+(?:the\s+|your\s+)?chat\b`,
  ].join('|'),
  'i',
);

/** ...and not an offer or a promise ("I'll put it in the chat", "want me to send it to the chat?"). */
const NOT_A_CLAIM = /\b(?:i'll|i will|i can|i could|let me|want me to|should i|shall i|can i|could i|would you like me to|going to|gonna|i'd)\b/i;

export function isChatClaim(text: string): boolean {
  return CLAIM.test(text) && !NOT_A_CLAIM.test(text);
}

/** What send_to_chat and render_diagram answer once something has gone there (functions.ts). */
const SENT = /in the chat now/i;
/** The student asking whether something was sent ("did you put it in the chat?"): a claim about an earlier send is then fine. */
const ASKS_IF_SENT = /\b(?:did|have|has|was|were|is|are|didn't|haven't)\b[^.?!]{0,40}\b(?:chat|sent|send|put|post)/i;

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: unknown })?.text ?? '').join('') : '';

/**
 * Has something gone to the chat in this turn, going by the messages Deepgram sent the model? The turn began with the student's last
 * words (a user line that starts with the note this side sends is not theirs); something has gone when a function result after it says
 * so, or, when the student asks whether it did, any earlier one.
 */
export function chatSentThisTurn(messages: unknown, note = '[System note'): boolean {
  if (!Array.isArray(messages)) return false;
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m?.role === 'user' && !textOf(m.content).trimStart().startsWith(note)) {
      start = i;
      break;
    }
  }
  const sent = (from: number) => messages.slice(from).some((m) => (m as { role?: unknown })?.role === 'tool' && SENT.test(textOf((m as { content?: unknown }).content)));
  if (sent(start)) return true;
  const last = textOf((messages[start] as { content?: unknown } | undefined)?.content);
  return ASKS_IF_SENT.test(last) && sent(0);
}
