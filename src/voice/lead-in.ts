/**
 * A turn that only announces the answer. In the owner's call of 2026-11-03 20:31 the student asked for a few project proposals and the model
 * (qwen) said "Here's a quick rundown of the interesting ones." and stopped: no list, no question, nothing, until the student said "okay,
 * tell me". The prompt asks for the answer itself (prompts.ts, rule 1), and a model that has not done it in the turn is told so by the
 * session (session.ts noticeLeadIn) once the student has been left waiting a moment. This is the test of what such a turn looks like: short,
 * not a question, and its last sentence is the announcement and not what it announces. Pure, so it can be tested on real sentences.
 */

/** A lead-in is an announcement in a few words; a turn longer than this has said something. */
export const LEAD_IN_MAX_WORDS = 14;

/** Words that may stand before the announcement ("Okay, so here's...", "Got it. Let's start with..."). */
const OPENER = /^(?:(?:okay|ok|sure|alright|all right|right|well|so|great|good|yeah|yes|no|nope|nah|actually|exactly|true|fair enough|cool|got it|of course|absolutely|no problem|happy to|now|then)\b[\s,.!;-]*)+/i;

/**
 * A turn that points at the chat or the page is TAi saying where something is, which is an answer ("There are a few more in the chat.", "Here's
 * the draft in the chat."): the closing line of a list or of something sent, and no promise of more to come.
 */
const POINTS_AT_CHAT = /\b(?:chat|page)\b/i;

/**
 * The announcement itself, at the start of the last sentence: "here's / here are ...", "let me give / walk you through ...", "let's start with
 * ...", "I'll give you ...", "there are a few ...", "the short version ...". Not "let me check / look / pull that up" (a look-up follows
 * those, and the session already says its own "one sec" for it), and not an offer.
 */
const ANNOUNCEMENT = new RegExp(
  [
    String.raw`^here(?:'s|\s+is|\s+are|\s+we\s+go)\b`,
    String.raw`^(?:let\s+me|let\s+us|let's|lemme)\s+(?:just\s+|quickly\s+|briefly\s+|first\s+)?(?:give|tell|walk|run|share|list|break|start|begin|dive|jump|explain|cover|summari[sz]e|show|talk|say|go\s+(?:over|through))\b`,
    String.raw`^(?:i'll|i\s+will|i'm\s+going\s+to|i\s+am\s+going\s+to|i\s+can)\s+(?:just\s+|quickly\s+|briefly\s+|first\s+)?(?:give|tell|walk|run|share|list|break|start|begin|explain|cover|summari[sz]e|show|go\s+(?:over|through))\b`,
    String.raw`^there\s+(?:are|were|'s|is)\s+(?:a\s+few|several|some|a\s+couple|two|three|four|five|six|many|quite\s+a\s+few)\b`,
    String.raw`^(?:the\s+)?(?:short|quick|basic|simple)\s+(?:version|answer|rundown|overview)\b`,
  ].join('|'),
  'i',
);

/** Whether this turn of TAi's is an announcement of an answer and not the answer. */
export function isLeadIn(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || /\?/.test(t) || POINTS_AT_CHAT.test(t)) return false; // a question is a turn that hands the floor to the student
  if (t.split(' ').length > LEAD_IN_MAX_WORDS) return false;
  const sentences = t.split(/(?<=[.!:…])\s+/).map((s) => s.trim()).filter(Boolean);
  const last = (sentences[sentences.length - 1] ?? '').replace(OPENER, '').trim();
  if (!last || !ANNOUNCEMENT.test(last)) return false;
  // "Here's one: the MUD project." has said the thing: words after a colon are the content
  return !/:\s*\S/.test(last);
}
