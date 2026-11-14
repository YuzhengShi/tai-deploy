/**
 * Where a student's turn ends, for a recognizer that only transcribes (LabGPU's adapter, nova). Flux decides this itself with a model of whether the sentence is finished;
 * LabGPU's adapter has an energy gate (its own `speech_final` comes 1.0 to 1.6 s after the end of speech, and partials come in rounds of about 1.1 s). Without a
 * dependency (no ONNX, no model of our own) the tools are what is here: the engine's own VAD for when the student stopped, the text of the latest partial or final for
 * whether the turn looks finished, a hold-off that depends on the mode, and a merge when the student goes on (docs/VOICE_SELFBUILT.md section 5.2).
 *
 * `TurnTracker` is pure: it is told what the VAD and the recognizer said (with times) and asked, at each tick, whether the turn is over. Time never comes from a clock in here.
 */

export interface TurnParams {
  /** Silence after the end of speech (ms, from the last voiced frame) before a text that looks finished is committed. 0 in a conversation: the first text that covers the speech goes. */
  completeMs: number;
  /** The same for a text that looks unfinished (it ends on a dangling word or a comma, or is an opening clause with nothing after it). */
  incompleteMs: number;
  /** The most silence that is waited for whatever the text looks like (the Settings' eot_timeout_ms). */
  timeoutMs: number;
  /** A partial counts as covering the speech only if it arrived at least this long after the speech stopped (a partial made just before the end lacks the last words). */
  coverAfterMs: number;
}

export type TurnVerdict = 'empty' | 'filler' | 'incomplete' | 'complete';

/** What a student says while thinking: not a turn. Anything with no Latin letters at all (the adapter writes an interjection in Chinese for "uh") counts too. */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'eh', 'hm', 'hmm', 'hmmm', 'mm', 'mmm', 'mhm', 'mmhm', 'huh', 'oh']);

/**
 * A turn that ends on one of these has more to come ("the leader sends heartbeats to ..."), whatever punctuation the recognizer put after it: the adapter writes "Paxos is."
 * and "...around the whole function." for sentences the student has not finished, so the full stop says nothing. Conjunctions, prepositions, articles, possessives,
 * relative pronouns, auxiliaries and modals: a sentence does not end on them.
 */
const STRONG_DANGLING = new Set([
  'and', 'but', 'so', 'because', 'or', 'if', 'when', 'while', 'although', 'though', 'since', 'until', 'unless', 'whether', 'as', 'then', 'than',
  'to', 'of', 'with', 'in', 'on', 'at', 'for', 'from', 'by', 'about', 'into', 'onto', 'between', 'after', 'before',
  'a', 'an', 'the', 'my', 'your', 'our', 'their', 'its', 'his', 'her',
  'which', 'who', 'whose', 'where',
  'is', 'are', 'was', 'were', 'will', 'would', 'should', 'could', 'can', 'must', 'might', 'may', 'does', 'did', 'has', 'had', 'be', 'been', 'being', 'not',
]);
/** Words that often end a finished sentence too ("I understand that.", "me too", "I like it very much"): they hold a turn open only when it is long enough to be a clause. */
const WEAK_DANGLING = new Set(['that', 'like', 'also', 'just', 'very', 'really', 'such', 'both', 'either', 'neither', 'every', 'each']);

/** An opening clause that needs a main clause after it: "If I put the lock around the whole function" is not finished without the "then ..." that follows. */
const SUBORDINATORS = new Set(['if', 'when', 'because', 'although', 'though', 'while', 'since', 'unless', 'once', 'whenever', 'whereas', 'after', 'before', 'as', 'until']);

/**
 * A short answer that opens with yes or no ends on an auxiliary or "not" and is finished ("Yes, it is.", "No, it's not.", "Yes, I can."). The owner's first call on the lab was held
 * 1.8 s on "No, it's not." because "not" is a dangling word. Only auxiliaries, modals and "not" count here: "Yes, because" and "Yes, and" still have more to come.
 */
const ANSWER_OPENERS = new Set(['yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah', 'sure', 'right', 'exactly', 'correct', 'absolutely', 'definitely']);
const ANSWER_ENDS = new Set(['is', 'are', 'was', 'were', 'will', 'would', 'should', 'could', 'can', 'must', 'might', 'may', 'does', 'did', 'has', 'had', 'be', 'been', 'not']);

/** "I think so.", "I don't think so.", "I hope not.": "so" and "not" after these verbs end a finished answer, not a clause that goes on. (The second tuning call held "I think so." 1.8 s.) */
const ANSWER_VERBS = new Set(['think', 'guess', 'hope', 'believe', 'suppose', 'expect', 'imagine', 'say', 'do', 'did']);

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * The words of a text, lower case, without punctuation and without the spaces between them, as one string: two recognizers heard "the same words" when their keys are equal ("What is a mutex?"
 * and "what is a mutex" are). The spaces are left out because the recognizers write a course term in different pieces: round 2's recognition set had LabGPU's adapter write "map reduce" for
 * MapReduce (5 of 10), "wait group" for WaitGroup (10 of 10), "dynamo db", "far gate" for what Flux, given the live key terms, writes as one word (amendment A10a).
 */
export const wordKey = (text: string): string => wordsOf(text).join('');

/** Is this text a finished turn, a half-said one, only a filler, or nothing? Pure, tested on real texts (the adapter's own output is in the tests). */
export function judgeTurnText(text: string): TurnVerdict {
  const t = text.trim();
  if (!t) return 'empty';
  const words = wordsOf(t);
  if (words.length === 0) return 'filler';
  if (words.every((w) => FILLERS.has(w))) return 'filler';
  // a trailing comma, dash or ellipsis is a speaker who is going on
  if (/(?:,|;|:|-|—|–|…|\.\.\.)\s*$/.test(t)) return 'incomplete';
  const last = words[words.length - 1];
  const asksQuestion = /\?\s*$/.test(t);
  // "Can you explain what a mutex is?" is a question that ends on "is"
  const questionEnd = asksQuestion && words.length >= 4 && last !== 'a' && last !== 'an' && last !== 'the';
  if (ANSWER_OPENERS.has(words[0]) && ANSWER_ENDS.has(last) && words.length >= 2 && words.length <= 5) return 'complete';
  if ((last === 'so' || last === 'not') && words.length >= 2 && words.length <= 6 && ANSWER_VERBS.has(words[words.length - 2])) return 'complete';
  if (STRONG_DANGLING.has(last) && !questionEnd) return 'incomplete';
  if (WEAK_DANGLING.has(last) && words.length >= 4 && !asksQuestion) return 'incomplete';
  if (SUBORDINATORS.has(words[0]) && !t.includes(',') && !asksQuestion && words.length >= 3) return 'incomplete';
  return 'complete';
}

export interface VadView {
  /** The student is speaking now. */
  voiced: boolean;
  /** End time of the last voiced frame (clock ms; 0 before any speech). */
  lastVoicedEndAt: number;
  /** How many speech onsets the VAD has seen in all: a change is a new stretch of speech. */
  onsets: number;
}

export type TurnDecision =
  | { kind: 'commit'; text: string; at: number; reason: 'complete' | 'incomplete-hold' | 'timeout'; speechEndAt: number; coverAt: number }
  | { kind: 'discard'; text: string; at: number };

const join = (a: string, b: string): string => (a && b ? `${a} ${b}` : a || b).trim();
const norm = (s: string): string => wordsOf(s).join(' ');
/** A final of the stretch just committed may still arrive (the adapter finalises 0.5 to 1 s after a partial that was committed on): for this long it is recognised and dropped. */
const STALE_MS = 5000;

export class TurnTracker {
  /** What the recognizer finalised earlier in this turn (its utterance ended in a pause, then the student went on): a later partial is a new stretch and is appended to it. */
  private prefix = '';
  /** The latest partial of the stretch being said (the recognizer's partials are cumulative within a stretch). */
  private current = '';
  /** The latest full candidate text (prefix and current) that is known to cover the speech, and when it arrived. */
  private cover: { text: string; at: number } | null = null;
  private seenOnsets = 0;
  private open = false;
  /** After a commit or a discard nothing from the recognizer counts until the student speaks again. */
  private settled = true;
  private last: { text: string; at: number } | null = null;

  constructor(private params: TurnParams) {}

  setParams(params: TurnParams): void {
    this.params = params;
  }

  /** The turn was taken elsewhere (the recognizer decided it, or the student typed): forget this one. `onsets` is the VAD's count now, so that no stale onset opens a turn. */
  settle(onsets: number): void {
    this.clear();
    this.seenOnsets = onsets;
  }

  /** True while a turn is open (the student has begun to speak and it has not been committed or discarded). */
  get isOpen(): boolean {
    return this.open;
  }

  /** The text of the turn so far, for the trace and for logs. */
  get text(): string {
    return join(this.prefix, this.current);
  }

  private clear(): void {
    this.prefix = '';
    this.current = '';
    this.cover = null;
    this.open = false;
    this.settled = true;
  }

  private stale(text: string, at: number): boolean {
    return !!this.last && at - this.last.at < STALE_MS && !!norm(text) && (norm(this.last.text) === norm(text) || norm(this.last.text).endsWith(norm(text)));
  }

  onPartial(text: string, at: number, vad: VadView): void {
    const t = text.trim();
    if (!t || this.settled || this.stale(t, at)) return;
    this.current = t;
    this.noteCover(at, vad);
  }

  /** The recognizer's own final of a stretch: it is the text of that stretch, whole; what comes after it is a new stretch. */
  onFinal(text: string, at: number, vad: VadView): void {
    const t = text.trim();
    if (!t || this.settled || this.stale(t, at)) return;
    this.prefix = join(this.prefix, t);
    this.current = '';
    this.noteCover(at, vad);
  }

  private noteCover(at: number, vad: VadView): void {
    // a text covers the speech when it arrived after the student had been quiet long enough that nothing was still going into the recognizer's last round
    if (vad.voiced || vad.lastVoicedEndAt <= 0 || at - vad.lastVoicedEndAt < this.params.coverAfterMs) return;
    this.cover = { text: join(this.prefix, this.current), at };
  }

  /** Called every few tens of milliseconds with the time and the VAD's view. Returns a decision when the turn is over, else null. */
  tick(now: number, vad: VadView): TurnDecision | null {
    if (vad.onsets !== this.seenOnsets) {
      // the student has begun to speak (again): a turn opens, or the open one goes on; what covered the speech before no longer does
      this.seenOnsets = vad.onsets;
      this.open = true;
      this.settled = false;
      this.cover = null;
    }
    if (!this.open || vad.voiced || vad.lastVoicedEndAt <= 0) return null;
    const silence = now - vad.lastVoicedEndAt;
    // the time is out and nothing covered the speech (the recognizer was slow, or only sent partials from before the end): the best text there is
    if (!this.cover && silence >= this.params.timeoutMs) {
      const t = this.text;
      if (t) this.cover = { text: t, at: now };
    }
    const cover = this.cover;
    if (!cover) return silence >= this.params.timeoutMs ? this.give({ kind: 'discard', text: '', at: now }) : null;
    const verdict = judgeTurnText(cover.text);
    if (verdict === 'filler' || verdict === 'empty') {
      // "um": nothing to answer. Forgotten, so that "um ... what is a mutex" is judged as what comes after it
      if (silence >= this.params.timeoutMs) return this.give({ kind: 'discard', text: cover.text, at: now });
      this.prefix = '';
      this.current = '';
      this.cover = null;
      return null;
    }
    if (silence >= this.params.timeoutMs) return this.give({ kind: 'commit', text: cover.text, at: now, reason: 'timeout', speechEndAt: vad.lastVoicedEndAt, coverAt: cover.at });
    const hold = Math.min(verdict === 'complete' ? this.params.completeMs : this.params.incompleteMs, this.params.timeoutMs);
    if (silence >= hold && now >= cover.at) {
      return this.give({ kind: 'commit', text: cover.text, at: now, reason: verdict === 'complete' ? 'complete' : 'incomplete-hold', speechEndAt: vad.lastVoicedEndAt, coverAt: cover.at });
    }
    return null;
  }

  private give(decision: TurnDecision): TurnDecision {
    if (decision.kind === 'commit') this.last = { text: decision.text, at: decision.at };
    this.clear();
    return decision;
  }
}
