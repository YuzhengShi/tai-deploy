/**
 * Options a student can tap: a multiple-choice question TAi asks (a quick check of something they have learned), or a few ways to answer a
 * question it asks them. TAi writes them as a block in its message:
 *
 *   Which of these is true of a Raft term?
 *   <choices>
 *   <option>Every heartbeat starts a new term</option>
 *   <option correct>A term has at most one leader</option>
 *   <option>The term number can go down after a failure</option>
 *   <why>Each term starts with an election and has at most one winner; terms only go up.</why>
 *   </choices>
 *
 * The student's page gets the words around the block as the message and the options as buttons. The option TAi marked as the answer and its
 * note on it (`<why>`) are TAi's and the host's, never the page's: the host grades a tap and tells TAi what the student chose and whether it
 * was the marked one, so a model that has forgotten its own question, or a session that was retired in between, still grades right.
 *
 * Models write this loosely, so the parser is generous about what it takes (an unclosed tag, options as plain lines, the answer given as a
 * letter on the block) and strict about what it hands on (two to six options, one line each, plain text, at most one marked answer). A block
 * that does not make a question becomes a plain list in the text, so nothing TAi wrote is lost. Pure functions: no I/O.
 */

export interface Choice {
  /** "A" to "F", in order: the page shows it on the button and the student's answer starts with it. */
  label: string;
  text: string;
}

export interface ParsedChoices {
  /** The message as the student reads it: the words around the block, with no markup. */
  text: string;
  choices?: Choice[];
  /** A question with an answer (one option marked, or the block says `quiz`): the page calls it a quick check. */
  quiz?: boolean;
  /** The index of the option TAi marked as the answer, when it marked exactly one. Never leaves the host. */
  key?: number;
  /** TAi's note on the answer, for itself. Never leaves the host. */
  why?: string;
}

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const OPTION_CHARS = 140;
export const WHY_CHARS = 600;
const LABELS = 'ABCDEF';

const BLOCK = /<choices\b([^>]*)>([\s\S]*?)(?:<\/choices\s*>|$)/gi;
const WHY = /<(why|explain|note)\b[^>]*>([\s\S]*?)(?:<\/\1\s*>|$)/i;
const QUESTION = /<question\b[^>]*>([\s\S]*?)<\/question\s*>/i;
const OPTION = /<option\b([^>]*)>([\s\S]*?)(?=<\/option\s*>|<option\b|$)(?:<\/option\s*>)?/gi;
const STRAY_TAGS = /<\/?(?:choices|option|why|explain|note|question)\b[^>]*>/gi;
/** A list marker TAi may have put in front of an option although the page numbers them: "A.", "(b)", "C)", "D:", "1.", "- ". */
const MARKER = /^(?:\(?[A-Fa-f]\)|[A-Fa-f][.):]|\d{1,2}[.):]|[-*•])\s+/;
/** How a plain line says it is the answer: a trailing star, "(correct)" or a tick. */
const LINE_KEY = /\s*(?:\*|\(correct\)|✓|✔)\s*$/i;

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);
/** Plain text: anything that looks like a tag is dropped ("a < b" is not one), entities for < > & are read. */
const unTag = (text: string): string =>
  flat(text.replace(/<\/?[A-Za-z][^>]*>/g, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&'));

/** The value of an attribute in the text of a tag: undefined when it is absent, '' when it has no value. */
function attr(attrs: string, name: string): string | undefined {
  const found = new RegExp(`(?:^|[\\s/])${name}\\b(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?`, 'i').exec(attrs);
  if (!found) return undefined;
  return found[1] ?? found[2] ?? found[3] ?? '';
}

const truthy = (value: string | undefined): boolean => value !== undefined && !/^(?:false|no|0)$/i.test(value.trim());

/** "B", "b" or "2" as the index of an option; undefined for anything else. */
function indexOfAnswer(value: string | undefined): number | undefined {
  const v = (value ?? '').trim();
  if (/^[A-Fa-f]$/.test(v)) return LABELS.indexOf(v.toUpperCase());
  if (/^[1-6]$/.test(v)) return Number(v) - 1;
  return undefined;
}

interface Option {
  text: string;
  marked: boolean;
}

function optionsOf(inner: string): Option[] {
  const out: Option[] = [];
  for (const m of inner.matchAll(OPTION)) {
    const text = cut(unTag(m[2]).replace(MARKER, ''), OPTION_CHARS);
    if (text) out.push({ text, marked: truthy(attr(m[1], 'correct')) || truthy(attr(m[1], 'data-correct')) });
  }
  if (out.length > 0) return out;
  // no <option> tags: one option to a line
  for (const line of inner.split('\n')) {
    const plain = unTag(line);
    if (!plain) continue;
    const marked = LINE_KEY.test(plain);
    const text = cut(plain.replace(LINE_KEY, '').replace(MARKER, '').trim(), OPTION_CHARS);
    if (text) out.push({ text, marked });
  }
  return out;
}

/** The block's options as the plain lines TAi's message falls back to when they cannot be buttons. */
const asList = (options: Option[]): string => options.map((o, i) => `${LABELS[i] ?? '-'}. ${o.text}`).join('\n');

/**
 * TAi's message with its options taken out. A text with no <choices> block comes back exactly as it was. `enabled` false (TAI_CHOICES=0) or
 * a block that does not make a question (fewer than two options, nothing to ask them with): the options stay in the text as a plain list.
 */
export function parseChoices(raw: string, enabled = true): ParsedChoices {
  if (!/<choices\b/i.test(raw)) return { text: raw };
  const blocks = [...raw.matchAll(BLOCK)];
  const first = blocks[0];
  if (!first) return { text: raw };
  const before = raw.slice(0, first.index);
  const after = raw.slice((first.index ?? 0) + first[0].length).replace(BLOCK, '');
  const inner = first[2];
  const whyMatch = WHY.exec(inner);
  const questionMatch = QUESTION.exec(inner);
  const rest = inner.replace(WHY, '').replace(QUESTION, '');
  // the same option twice (a model does that) is one option, and it is the answer if either was marked
  const options: Option[] = [];
  const seen = new Map<string, number>();
  for (const o of optionsOf(rest)) {
    const at = seen.get(o.text.toLowerCase());
    if (at === undefined) {
      seen.set(o.text.toLowerCase(), options.length);
      options.push({ ...o });
    } else if (o.marked) options[at].marked = true;
  }
  options.splice(MAX_OPTIONS);

  const words = (lead: string): string => [lead.trim(), after.trim()].filter(Boolean).join('\n\n').replace(STRAY_TAGS, '').replace(/\n{3,}/g, '\n\n').trim();
  const lead = before.trim() || (questionMatch ? unTag(questionMatch[1]) : '');

  if (!enabled || options.length < MIN_OPTIONS || !lead) {
    const plain = options.length > 0 ? asList(options) : '';
    return { text: [words(lead), plain].filter(Boolean).join('\n\n') };
  }

  const marked = options.flatMap((o, i) => (o.marked ? [i] : []));
  let key: number | undefined = marked.length === 1 ? marked[0] : undefined;      // two marked answers is no answer
  if (marked.length === 0) {
    const named = indexOfAnswer(attr(first[1], 'answer') ?? attr(first[1], 'correct') ?? attr(first[1], 'key'));
    if (named !== undefined && named < options.length) key = named;
  }
  const why = whyMatch ? cut(unTag(whyMatch[2]), WHY_CHARS) : '';
  const out: ParsedChoices = {
    text: words(lead),
    choices: options.map((o, i) => ({ label: LABELS[i], text: o.text })),
  };
  if (key !== undefined || truthy(attr(first[1], 'quiz'))) out.quiz = true;
  if (key !== undefined) out.key = key;
  if (why) out.why = why;
  return out;
}

/** An option that only means something where it stands ("all of the above", "both A and B"): a quick check with one is not shuffled. */
const ORDER_BOUND =
  /\b(?:all|none|both|neither|any) of (?:the (?:above|options|choices|answers)|these|them)\b|\b(?:above|previous|preceding|other) (?:option|answer|choice)s?\b|\boptions? [A-F]\b|\b[A-F] (?:and|or|&|,) [A-F]\b|\bboth [A-F]\b/i;

/**
 * A quick check with its answer marked, the options in a random order, the answer still the answer. A model puts the right option second
 * nearly every time (36 questions of gpt-oss on 2026-11-03: the answer was B in all but one), and a student who sees it twice stops
 * reading the question. Options that depend on their place are left where they are.
 */
export function shuffleQuiz(parsed: ParsedChoices, random: () => number = Math.random): ParsedChoices {
  const { choices, key } = parsed;
  if (!choices || key === undefined || choices.some((c) => ORDER_BOUND.test(c.text))) return parsed;
  const order = choices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return {
    ...parsed,
    choices: order.map((from, to) => ({ label: LABELS[to], text: choices[from].text })),
    key: order.indexOf(key),
  };
}
