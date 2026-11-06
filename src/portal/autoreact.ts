/**
 * A reaction the page adds when the model did not. TAi is asked to react to a student's message with an emoji when it fits (the persona
 * says when, and `react_to_message` does it), but a model that is told "when it feels natural" mostly does not: the owner measured no
 * reaction in a message that said "I finally got my leader election passing all the tests". For the plain cases (the student says it
 * works, says thanks, says they are stuck) the page therefore puts one on the message itself when the reply arrives and the model has put
 * none. What the model chooses always wins: this only fills a silence, only for messages that say so in so many words, and never twice
 * in a row.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // it worked, it is done
  [/\b(?:finally|it works|works now|working now|passing|passes|passed|got it working|figured (?:it )?out|solved|fixed it|nailed it|i did it|all (?:the )?tests|aced)\b/i, '🎉'],
  // thanks
  [/\b(?:thanks|thank you|thx|much appreciated|appreciate (?:it|that|the help))\b/i, '👍'],
  // a rough moment
  [/\b(?:stuck|frustrated|frustrating|stressed|overwhelmed|give up|giving up|so confused|totally lost|exhausted)\b/i, '❤️'],
];

const LONGEST = 400;

/** The emoji a message calls for, or null: the first rule that matches wins, and a long message is a question or a paste, not a feeling. */
export function suggestReaction(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > LONGEST) return null;
  for (const [pattern, emoji] of RULES) if (pattern.test(t)) return emoji;
  return null;
}
