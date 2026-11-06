/**
 * What may be said in ONE answer. The model is a reasoning one and does not keep to "one sentence": in the owner's seven-minute call
 * (2026-11-02) a single completion held its answer, the student's imagined reply to it, a function call's arguments written as text, a
 * tool result it had never been given ("[]"), its own thinking ("We need to call query piazza.") and a claim that something was in the
 * chat, all spoken, and all fed back to it as history, which made the next answers worse. A prompt rule does not stop that; this does,
 * between the gateway and Deepgram (speech-filter.ts feeds it):
 *
 *   - the answer is cut into sentences (also where the model glued them together without a space), and each is judged on its own;
 *   - a sentence that is the model's thinking out loud (about the tools, in the inner voice: "We need to...", "Now send to chat.", a
 *     function's name), that has no words in it ("[]"), that repeats the one before, or that says something is in the chat when nothing
 *     was sent in this turn, is not spoken; a link is never read out;
 *   - at most `maxSentences` sentences and `maxWords` words are spoken (the first sentence whole, up to `firstSentenceWords`), and
 *     nothing after the first question: a question hands the turn to the student, and what follows it was never going to be an answer.
 *
 * What is not spoken is not recorded in the call's history either (Deepgram records what it was given to say).
 */
import { isChatClaim } from './chat-claim.js';

export interface GovernorOptions {
  maxSentences: number;
  maxWords: number;
  firstSentenceWords: number;
  /** false: a sentence that says something is in the chat is not spoken (nothing has gone to the chat in this turn). */
  chatClaimsAllowed: boolean;
}

export const GOVERNOR_DEFAULTS: GovernorOptions = { maxSentences: 2, maxWords: 40, firstSentenceWords: 45, chatClaimsAllowed: true };

/**
 * What one answer may say in a talk-it-through (session.ts speechLimits picks between the two). While the student has said little, TAi's
 * turns are nudges ("mm-hm, go on") and the odd short answer to a question: a monologue of its own would be an interruption. Once they have
 * explained enough to deserve it, TAi gives its feedback: one thing that was strong, one probing question, and later two sentences of what
 * to firm up.
 */
export const LISTENER_NUDGE: Partial<GovernorOptions> = { maxSentences: 2, maxWords: 18, firstSentenceWords: 14 };
export const LISTENER_FEEDBACK: Partial<GovernorOptions> = { maxSentences: 3, maxWords: 60, firstSentenceWords: 30 };
/** A question that closes an answer may take the answer past maxWords if it is this short. */
const QUESTION_WORDS = 14;

/** Where the period belongs to an abbreviation, a sentence does not end. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|dr|mr|mrs|ms|prof|st|no|approx|fig|cf|inc|a\.m|p\.m)\.$/i;
/** ...nor where a period joins a package or an object to what it has (CS6650 is a Go course: time.Now, errors.Is, client.Do). */
const CODE_PREFIX = /(?:^|[\s(`])(?:time|errors|client|ctx|context|http|sync|fmt|os|io|strings|sort|math|rand|json|log|atomic|self|this|std)\.$/i;
/**
 * A sentence ends at . ! ? followed by a space, or at a line break. The model also glues sentences together ("clear?Great", "today.I put
 * it"): after ? or ! a capital letter is enough, after a period only the capital of a word a sentence begins with, so that code
 * ("sync.Mutex", "fmt.Println") is not cut in two.
 */
const STARTERS = 'I|We|It|Now|Great|Okay|Ok|Sure|Yes|No|So|Then|The|This|That|These|Those|You|Your|What|Which|Why|How|Who|When|Where|Want|Do|Does|Did|Is|Are|Can|Could|Should|Would|Here|There|Thanks|Sorry|Alright|Right|Good|Nice|Let|Any|Anything|And|But';
// the model writes in lowercase when it is talking ("heartbeats.does that help"): the same words, in lowercase, after a period
const STARTERS_LOWER = STARTERS.toLowerCase();
const BOUNDARY = new RegExp(
  String.raw`[!?…]+["'”’)\]]*(?:\s+|(?=[A-Z“"‘(]|(?:${STARTERS_LOWER})\b))|\.+["'”’)\]]*(?:\s+|(?=(?:${STARTERS}|${STARTERS_LOWER})\b))|\n+`,
  'g',
);

const FUNCTION_NAMES =
  /\b(?:query_(?:knowledge|canvas|github|piazza)|recall_memory|save_memory|read_competency|update_competency|browse_url|read_file|render_diagram|send_to_chat|schedule_task|start_interview|end_session|evaluate_answer|end_interview|start_talk_through|end_talk_through|canvas_query|github_query|piazza_query)\b/i;
const TOOLISH = /\b(?:query|canvas|piazza|github|action|actions|pages?|modules?|files?|api|tool|tools|function|search|filter|list|pdf|link|chat|slides?|url|posts?|repos?|repository)\b/i;

/** The model's inner voice about what to call next. Written for what was seen; a TA talking to a student does not say any of these. */
const THINKING: RegExp[] = [
  /\bthe (?:user|student)\s+(?:is|wants|asks|asked|said|says|needs|might|may|probably|did|didn't|has|have)\b/i,
  /^(?:now|next|then),?\s+(?:send|call|query|search|use|list|fetch|check|run)\b/i,
  new RegExp(
    String.raw`^(?:we(?:'ll| will)\s+(?:try|need to|have to|search|query|list|call|use)|(?:we|let's|let us)\s+(?:need to|have to|must|might need to|already have|already know|can't|cannot|don't have|do not have|better))\b.*${TOOLISH.source}`,
    'i',
  ),
  /^let's\s+(?:call|query|list|search|use|fetch|filter|run)\b/i,
  /^(?:probably|maybe|might need|could (?:list|search|try|query)|there's no (?:search|pdf|filter|listing|such)|time low|just say|need to)\b/i,
  /^i(?:'ll| will| need to| should)\s+(?:call|query|use)\s+(?:the\s+)?(?:\w+_\w+|tool|function)\b/i,
  /\bmaybe[.!?\s]*$/i,
];

const wordsIn = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * A question that is not a question: "Honestly?", "Right?", "You know what?" in front of what is about to be said. In the owner's call of
 * 2026-11-02 22:47 TAi said "Honestly?" and nothing more (the rest was after a question mark, so it was cut) and the student had to say
 * "Yes." to hear the answer. Such an interjection does not hand the turn over and is not counted as a sentence.
 */
const INTERJECTION = /^(?:honestly|really|seriously|right|okay|ok|so|well|look|listen|actually|hmm+|huh|you know|you know what|guess what|wait|true)\s*[?!.…]*\s*\?[?!.…"'”’)\]\s]*$/i;

export class SpeechGovernor {
  /** Sentences that were not spoken, for the diagnostic. */
  readonly dropped: string[] = [];
  /** Sentences that said something was in the chat when nothing had gone there. */
  claims = 0;
  private held = '';
  private sentences = 0;
  private words = 0;
  private stopped = false;
  private lastKept = '';
  private openers = 0;
  /** What was handed out last: a sentence that follows it without a space gets one. */
  private lastOut = '';
  private readonly opts: GovernorOptions;

  constructor(
    opts: Partial<GovernorOptions> = {},
    private readonly toolNames: ReadonlySet<string> = new Set(),
  ) {
    this.opts = { ...GOVERNOR_DEFAULTS, ...opts };
  }

  /** Text in (cleaned by the SpeechFilter); the sentences that may be spoken out. The one still being written is held. */
  push(text: string): string {
    // an empty "[]" or "{}" is what a tool answered, repeated by the model: it is not part of any sentence, and between two it hides the glue ("branch?[]No open PRs")
    this.held = (this.held + text).replace(/\[\s*\]|\{\s*\}/g, '');
    return this.release(false);
  }

  /** The end of the answer: the sentence still held is judged like the others. */
  end(): string {
    return this.release(true);
  }

  private release(all: boolean): string {
    let out = '';
    for (;;) {
      const end = this.boundary(all);
      if (end <= 0) break;
      const unit = this.held.slice(0, end);
      this.held = this.held.slice(end);
      const spoken = this.judge(unit);
      if (!spoken) continue;
      // sentences the model glued together are spoken with the space they lack, also across two calls
      const before = out || this.lastOut;
      if (before && !/\s$/.test(before) && !/^\s/.test(spoken)) out += ' ';
      out += spoken;
    }
    if (out) this.lastOut = out;
    return out;
  }

  /** Where the first sentence of what is held ends, after the white space that follows it; -1 while it is not known to have ended. */
  private boundary(all: boolean): number {
    BOUNDARY.lastIndex = 0;
    // a link is one word (its dots and question mark end nothing), also while it is still being written: looked at as if it were letters
    const masked = this.held.replace(/\bhttps?:\/\/\S+/gi, (m) => 'u'.repeat(m.length));
    let m: RegExpExecArray | null;
    while ((m = BOUNDARY.exec(masked))) {
      if (m[0].startsWith('\n')) return m.index + m[0].length;
      const stop = m.index + (/^[.!?…]+/.exec(m[0])?.[0].length ?? 0);
      const before = this.held.slice(0, stop);
      if (ABBREVIATION.test(before) || CODE_PREFIX.test(before)) continue;
      return m.index + m[0].length;
    }
    return all && this.held.length ? this.held.length : -1;
  }

  private isThinking(norm: string): boolean {
    if (FUNCTION_NAMES.test(norm)) return true;
    for (const name of this.toolNames) if (name.includes('_') && norm.toLowerCase().includes(name.toLowerCase())) return true;
    return THINKING.some((re) => re.test(norm));
  }

  private drop(unit: string): string {
    const text = unit.trim();
    if (text) this.dropped.push(text.slice(0, 200));
    return '';
  }

  /** One whole sentence: what of it is spoken. */
  private judge(unit: string): string {
    if (this.stopped) return this.drop(unit);
    // An e-mail or a post the model wrote for the student to READ is not said (the owner's call of 2026-11-03: "Here's a draft email for Professor
    // Coady: Subject: Final Project Presentation Format Hi Professor Coady,"): what comes before its "Subject:" is, what comes after it, and the rest
    // of the answer, is not. The draft belongs in the chat.
    const draft = /\bSubject:\s/.exec(unit);
    if (draft || /^\s*(?:Dear|Hi|Hello)\s+(?:Professor|Prof\.?|Dr\.?|everyone|all|team)\b/.test(unit)) {
      const at = draft ? draft.index : 0;
      const said = at > 0 ? this.judge(`${unit.slice(0, at).replace(/[:\s]+$/, '')}.`) : '';
      this.dropped.push(unit.slice(at, at + 200).trim());
      this.stopped = true;
      return said;
    }
    // a link is never read out (a speech engine would spell it), nor an empty "[]" or "{}" (a tool's answer the model repeated): the sentence goes on without them
    // (and the little word in front of it: "signing in at <link> and making sure" is "signing in and making sure", not "signing in at and making sure")
    let spoken = unit
      .replace(/\s+(?:at|on|via|from|to|see|visit|open|using|here|in)\s+https?:\/\/[^\s<>"]*[^\s<>"').,;:!?]/gi, '')
      .replace(/\bhttps?:\/\/[^\s<>"]*[^\s<>"').,;:!?]/gi, '')
      .replace(/\s*\(\s*\)/g, '')
      .replace(/\[\s*\]|\{\s*\}/g, '')
      .replace(/[ \t]{2,}/g, ' ');
    if (spoken !== unit) spoken = spoken.replace(/\s+([.,;:!?])/g, '$1').replace(/:(\s*)$/, '.$1');
    const plain = spoken.trim();
    if (!/\p{L}/u.test(plain)) return this.drop(unit); // "[]", "{}", a bare number: nothing to say
    const norm = plain.replace(/[’‘]/g, "'");
    if (this.isThinking(norm)) return this.drop(unit);
    if (!this.opts.chatClaimsAllowed && isChatClaim(norm)) {
      this.claims++;
      return this.drop(unit);
    }
    if (norm.toLowerCase() === this.lastKept) return this.drop(unit); // the same sentence again
    const n = wordsIn(plain);
    const asks = /\?["'”’)\]\s]*$/.test(plain);
    const interjection = asks && n <= 3 && INTERJECTION.test(plain);
    const question = asks && !interjection;                       // a question that hands the turn over
    // "Nice." "Right, exactly." "Honestly?" in front of the answer is a person's way of beginning, not a sentence of it: two of them do not count
    if (this.sentences === 0 && n <= 3 && !question && this.openers < 2) {
      this.openers++;
      this.lastKept = norm.toLowerCase();
      return spoken;
    }
    if (this.sentences === 0) {
      if (n > this.opts.firstSentenceWords) spoken = this.shorten(spoken);
    } else if (this.sentences >= this.opts.maxSentences || (this.words + n > this.opts.maxWords && !(question && n <= QUESTION_WORDS))) {
      // the one thing that may go beyond the words: a short question that closes the answer ("...caching. Want to start with how one server handles many requests?")
      this.stopped = true;
      return this.drop(unit);
    }
    this.sentences++;
    this.words += wordsIn(spoken);
    this.lastKept = norm.toLowerCase();
    // a question hands the turn over; so does the last sentence there is room for
    if (question || this.sentences >= this.opts.maxSentences) this.stopped = true;
    return spoken;
  }

  /** A first sentence that goes on and on: cut at the last comma, dash or colon before the 40th word (or at the 40th; at the limit of a mode that allows less), and ended. */
  private shorten(text: string): string {
    const limit = Math.min(40, this.opts.firstSentenceWords);
    const words = text.trim().split(/\s+/);
    const head = words.slice(0, limit).join(' ');
    const at = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf(':'), head.lastIndexOf('—'), head.lastIndexOf('–'));
    const cut = at > 0 && wordsIn(head.slice(0, at)) >= Math.min(12, Math.ceil(limit / 2)) ? head.slice(0, at) : head;
    this.dropped.push(words.slice(cut.split(/\s+/).length).join(' ').slice(0, 200));
    return `${cut.replace(/[,;:—–\s]+$/, '')}. `;
  }
}
