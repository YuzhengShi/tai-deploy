/**
 * How long a reply to a student's chat message should be, and the line the host puts after the message to say so.
 *
 * The persona already says "short", but one rule among 28 KB of prompt loses to whatever sits next to the question. In the owner's own
 * chat of 2026-11-02 (28 replies, gpt-oss under pi) the median reply was 59 words and the longest 229, for questions of 5-7 words,
 * with bullet lists, bold labels and a closing offer on most of them. A number worked out from the student's own message and put at the
 * very end of the prompt is the last thing the model reads. Pure functions (no I/O), so the arithmetic can be tested.
 */

export interface ReplyBudget {
  /** What the reply should stay under, in `unit`. */
  limit: number;
  unit: 'words' | 'characters';
  /** The student asked for depth: short paragraphs are allowed, lists still are not. */
  deep: boolean;
  /** How much the student wrote (in `unit`), for the line the model reads. */
  studentWords: number;
  /** The language of a student who wrote in Chinese, Japanese or Korean: the model answers in it (gpt-oss mixes otherwise). */
  language?: 'Chinese' | 'Japanese' | 'Korean';
  /**
   * The student asks whether TAi can open, read or find something. gpt-oss answers that from memory ("I can't open PDFs here", without a
   * tool call, in six of six tries on 2026-11-02) when the same agent reads the PDF as soon as it is asked to: the line tells it to look.
   */
  ability?: boolean;
  /**
   * The message is only the page's note that the student put an emoji on one of TAi's messages (src/portal/server.ts answers an emoji):
   * they said it with the emoji and a lecture back is the wrong answer.
   */
  reactionOnly?: boolean;
  /**
   * The message carries the page's note that the student tapped one of TAi's options (src/portal/choose.ts). `answer`: it was a quick check,
   * and the reply says at once whether it was right, a sentence of why, and one follow-up. `pick`: it was a few ways to answer a question
   * (no right one), and the reply carries on from what they chose. Either needs more room than the option's few words would give it.
   */
  choice?: 'answer' | 'pick';
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;

const GREETING = /^(?:hi|hey|hello|yo|sup|thanks?|thank you|thx|ok|okay|cool|nice|great|bye|good (?:morning|night|evening)|你好|谢谢|好的|嗯)(?![a-z])/i;
const DEEP =
  /\b(?:in detail|in depth|step[- ]by[- ]step|elaborate|go deeper|deep dive|thoroughly|everything (?:about|you know)|full (?:explanation|walk-?through|list))\b|详细|详解|一步一步|深入/i;
const EXPLAIN =
  /\b(?:explain|walk me through|tell me (?:more )?about|describe|compare|differences? between|how (?:does|do|would|can|should)|why (?:does|do|did|would)|what(?:'s| is| are) (?:an? |the )?(?:difference|point|idea|purpose)|what(?:'s| is) an?\b)|解释|讲讲|说说|为什么|怎么|是什么/i;
const ABILITY = /\bcan you (?:open|read|view|look at|access|check|pull up|find|get|send)\b|\bare you able to (?:open|read|view|access)\b|你(?:能|可以|会)(?:打开|读|看|查|找|发)/i;
const BRIEF = /\b(?:too long|too much|wordy|shorter|short(?:er)? please|be brief|more concise|keep it short|tl;?dr|stop talking)\b|太长|啰嗦|简短|短一点|简洁/i;

/** What the student wrote, without the host's own notes (a reaction, a rating, a retry) and the label of a voice note. */
export function studentText(content: string): string {
  return content
    .split('\n')
    .filter((line) => !/^\[(?:The student |SYSTEM\])/.test(line.trim()))
    .join('\n')
    .replace(/^\s*\[Voice note[^\]]*\]\s*/i, '')
    .trim();
}

/**
 * The student's TYPED words as TAi and the host's parsers may read them: any line that opens like one of the host's own notes ("[The student answered
 * your multiple-choice question ...", "[The student reacted ...", "[SYSTEM] ...", "[Voice note, 0:12] ...") gets a backslash in front, so no parser that
 * looks for those openings (the student model's graded tap, the reply budget, `studentText`, the "spoken" test that allows the verbal scope) takes it
 * for the host's. The words stay. The notes the SERVER writes itself (a tap, an emoji, a voice note, an attachment) never pass through here: it is only
 * for what a student typed into the message box.
 */
export function neutralHostLines(typed: string): string {
  return typed.replace(/^(\s*)\[(?=(?:The student |SYSTEM\]|Voice note\b))/gim, '$1\\[');
}

/** How much a text holds: its words, or its characters when it is mostly Chinese, Japanese or Korean. */
export function measure(text: string): { count: number; cjk: boolean } {
  const han = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, ' ').split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  return { count: han + rest, cjk: han > rest };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The budget for the reply to these pending messages (all the student wrote since the last answer). A short question gets a short
 * answer; an explanation about 60 words; a request for depth 110, in paragraphs; a pasted error or a piece of code room in proportion
 * to its size; and a student who has just said "too long" half of what they would have got.
 */
export function replyBudget(contents: string[]): ReplyBudget {
  const text = contents.map(studentText).filter(Boolean).join('\n');
  const { count, cjk } = measure(text);
  const w = Math.max(1, cjk ? Math.round(count / 2) : count);
  let limit = clamp(3 * w + 12, 18, 40);
  let deep = false;
  if (w >= 25) limit = Math.max(limit, Math.min(120, Math.round(w * 0.8)));
  if (EXPLAIN.test(text)) limit = Math.max(limit, 60);
  if (DEEP.test(text)) {
    limit = 110;
    deep = true;
  }
  if (w <= 3 && GREETING.test(text)) limit = 14;
  if (BRIEF.test(contents.join('\n'))) limit = Math.max(10, Math.round(limit / 2));
  const budget: ReplyBudget = { limit: cjk ? limit * 2 : limit, unit: cjk ? 'characters' : 'words', deep, studentWords: count };
  if (cjk) budget.language = /[぀-ヿ]/.test(text) ? 'Japanese' : /[가-힯]/.test(text) ? 'Korean' : 'Chinese';
  if (ABILITY.test(text)) budget.ability = true;
  if (!text && contents.some((c) => /^\[The student (?:reacted|liked)\b/m.test(c))) {
    budget.reactionOnly = true;
    budget.limit = 8;
  }
  const tapped = contents.map((c) => /^\[The student (answered your multiple-choice question|picked an option on your question)\b/m.exec(c)?.[1]).find(Boolean);
  if (tapped) {
    budget.choice = tapped.startsWith('answered') ? 'answer' : 'pick';
    budget.limit = Math.max(budget.limit, cjk ? 90 : 45);
  }
  return budget;
}

/** The line that goes after the student's messages. English: the persona tells the model to answer in the student's language. */
export function replyRule(b: ReplyBudget): string {
  if (b.reactionOnly) {
    return (
      '<reply_rule>They sent no words, only an emoji on one of your messages (the note above): answer in 8 words at most, the way a friend would. ' +
      '👍 ❤️ 🙏: a tiny "glad it helped" at most. 😂: a laugh back. 😮: ask what surprised them. 😢: ask gently what is wrong. ' +
      'No question after 👍 ❤️ 🙏 😂, no bullet points, no bold, and do not put an emoji on a message of theirs: they sent none.</reply_rule>'
    );
  }
  const lang =
    (b.language ? ` Answer in ${b.language}; technical terms stay in English.` : '') +
    (b.ability ? ' They are asking whether you can: try it now with your tools and answer from what you saw, not from memory (a Canvas PDF: canvas_query "files", then "file_content").' : '');
  if (b.choice === 'answer') {
    return (
      `<reply_rule>They tapped an answer to your quick check (the note above). First whether it was right: a few words. Then one sentence of why, ` +
      `and ONE short follow-up (a harder question, a "why", or the next quick check as a <choices> block). About ${b.limit} ${b.unit} outside any <choices> block. ` +
      `Plain sentences, no bullet points, no bold, do not list the options again, no "let me know" ending.${lang}</reply_rule>`
    );
  }
  if (b.choice === 'pick') {
    return (
      `<reply_rule>They tapped one of the options you offered (the note above): there is no right answer to grade. Carry on from what they chose: one or two ` +
      `sentences of help, then at most one open question. Not a quick check unless they ask for one. About ${b.limit} ${b.unit}. ` +
      `Plain sentences, no bullet points, no bold, do not list the options again, no "let me know" ending.${lang}</reply_rule>`
    );
  }
  const room = b.deep
    ? `They asked for depth: up to ${b.limit} ${b.unit}, in short paragraphs.`
    : `Go past ${b.limit} ${b.unit} only if they ask for depth.`;
  return (
    `<reply_rule>This reply: about ${b.limit} ${b.unit} at most (they wrote ${b.studentWords}). Plain sentences, the way a person texts: ` +
    'no bullet points, no bold, no headings, no lettered or numbered list in your words (a <choices> block is how you offer options, and it does not count), and no "let me know" / "feel free" / "would you like me to" ending. ' +
    'A fact or a logistics question: the answer is your first sentence, then stop. Teaching: follow your strategy, in one to three short ' +
    `sentences, with a question only if it moves them forward. ${room}${lang}</reply_rule>`
  );
}

/**
 * The last sentence of a reply when it is only a formula of closing ("Let me know if you need anything else.", "Hope this helps!"),
 * taken off. Nothing else is touched: an offer or a question that says something stays, and so does a reply that is nothing but the
 * formula. Up to two such sentences, because a model writes them in pairs.
 */
const CLOSING_FORMULA =
  /^(?:let me know\b|feel free\b|hope (?:this|that) helps|happy to help|i['’]?m here (?:if|to|for)\b|don['’]?t hesitate|just (?:let me know|say the word|ask)\b|need (?:anything|any help)\b|anything else\b|is there anything else)/i;

export function trimClosingFormula(text: string): string {
  let out = text.trimEnd();
  for (let i = 0; i < 2; i++) {
    if (out.endsWith('```')) break;
    const parts = out.split(/(?<=[.!?…])\s+/);
    const last = parts.at(-1) ?? '';
    const rest = parts.slice(0, -1).join(' ');
    if (parts.length < 2 || !CLOSING_FORMULA.test(last.trim()) || (rest.match(/\S+/g) ?? []).length < 4) break;
    out = out.slice(0, out.length - last.length).trimEnd();
  }
  return out;
}

/** The prompt of a run (or of messages piped into a running container) with the reply rule after the student's messages. */
export function withReplyRule(prompt: string, contents: string[]): string {
  return `${prompt}\n\n${replyRule(replyBudget(contents))}`;
}
