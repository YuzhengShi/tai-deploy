/**
 * look_at_week (2026-11-06): the interviewer's second look at the student's Canvas, GitHub and Piazza.
 *
 * The interviewer's prompt holds what the three showed when the interview began (the weekly brief, week-brief.ts). In the owner's call it could not
 * look again: asked "can you go take a look?" and "can you look at Canvas?" it answered "I can't open Canvas directly, only what's been passed to me",
 * while a student who says "I just submitted it" or "I just pushed" is exactly who needs the look. So the function asks the call's tool host for the same
 * brief again (the container's weekly_brief with format "json": the object start_mock_interview stores as `weekBrief`, for the same student and the same
 * assignment, the identity from the host's binding and never from the model) and this file turns the answer into
 *
 *   readLook   what the model is told, in the host's words: which sources arrived and which did not, what the sections show, the sections themselves
 *              (week-brief.ts weekSections, so what a student wrote stays quoted data), and what to do with it. Compact: the model reads it once and speaks.
 *              Also the view the interview keeps (mergeWeek), and nothing at all on a failure: a sentence the model can say plainly instead.
 *   limitLook  the answer after the last look a call may have: the view from before, and a note that it cannot look again.
 *
 * Only what a look found goes in: never a score, a grade, points, a hash or a link (the parser drops them, week-brief.ts). Nothing here throws.
 */
import { errorResult } from './functions.js';
import { BRIEF_CAPS, newNonce, oneLine, parseWeekBrief, practicingOf, weekFacts, weekSections } from './week-brief.js';
import type { BriefCaps, WeekAssignment, WeekBriefView } from './week-brief.js';

/**
 * How many looks a call may have. The container counts the same number per voice call (tool-limits.ts weekly_brief: the tool host resets it when a call
 * begins), so the host counts too: a refusal from the container then never comes first, and when it does (an older count) it is the same answer.
 */
export const LOOK_MAX = 3;
/** How long the container may take: the brief itself stops at 40 s (weekly-brief.ts BRIEF_TOTAL_MS). The host waits five seconds longer (tool-host.ts). */
export const LOOK_TIMEOUT_MS = 50_000;
/** The most characters of the sections in an answer: with what else it says, an answer is about 2,400 characters for a typical week and under 3,000 at the contract's maxima (the model reads it once and speaks). */
export const LOOK_DETAILS_MAX = 1_800;

const CARRY_ON = 'say so in one short sentence and carry on with a question about the assignment itself';
/** Nothing came back (the tool host is down, the tool failed, the answer was not a brief, every source failed). */
export const LOOK_FAILED = `I could not read Canvas, GitHub or Piazza just now: ${CARRY_ON}.`;
/** No source can be read for this student, and none failed: they are not linked or not set up. */
export const LOOK_UNAVAILABLE = `Canvas, GitHub and Piazza cannot be read for this student (their accounts are not linked or not set up in TAi): ${CARRY_ON}.`;
/** Their Canvas and GitHub accounts are not linked to TAi: the host knows it before it asks. */
export const LOOK_NOT_LINKED = `their Canvas and GitHub accounts are not linked to TAi, so there is nothing to look at: ${CARRY_ON}.`;
/** The last look is used up and there is no view from before to answer from. */
export const LOOK_NO_VIEW = `you have looked as often as you may in this call and have nothing from before to show: ${CARRY_ON}.`;

/** What the model does with an answer: in the host's words, because the freshest text before a question is what a model follows (docs/VOICE.md, "The week's evidence"). */
const INSTRUCTION =
  "Tell them what they asked about in one or two short sentences. If it shows nothing, say so in ONE short sentence, then ask about the assignment itself, never about what they finished or skipped. A source that could not be read is not 'nothing there'. Never read a commit message, post or submission aloud; never say a score, grade or points.";

// ---------------------------------------------------------------- the sources

export type SourceName = 'canvas' | 'github' | 'piazza';
export type SourceState = 'ok' | 'failed' | 'skipped' | 'unknown';

const SOURCES: readonly SourceName[] = ['canvas', 'github', 'piazza'];
const LABEL: Record<SourceName, string> = { canvas: 'Canvas', github: 'GitHub', piazza: 'Piazza' };

const asObject = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

interface ReadSources {
  state: Record<SourceName, SourceState>;
  /** The producer's closed phrase for a source it skipped ("no GitHub account is linked"), cleaned and capped; '' for none. */
  skipped: Record<SourceName, string>;
}

/** The brief's `sources` (parseWeekBrief leaves it out): which source answered, failed or was skipped. Whatever else is in it is dropped. */
function readSources(value: unknown): ReadSources {
  const s = asObject(value);
  const state = { canvas: 'unknown', github: 'unknown', piazza: 'unknown' } as Record<SourceName, SourceState>;
  const skipped = { canvas: '', github: '', piazza: '' } as Record<SourceName, string>;
  for (const name of SOURCES) {
    const v = s?.[name];
    if (v === 'ok' || v === 'failed' || v === 'skipped') state[name] = v;
  }
  for (const e of Array.isArray(s?.errors) ? (s?.errors as unknown[]).slice(0, 5) : []) {
    const m = /^(canvas|github|piazza): skipped \((.{1,120})\)$/.exec(oneLine(e, 160));
    if (m) skipped[m[1] as SourceName] = m[2];
  }
  return { state, skipped };
}

/** Why a source was skipped, in the host's words: what the producer's phrase says, for the few phrases it has; '' for any other. */
function skippedBecause(source: SourceName, phrase: string): string {
  if (/not linked|no (?:canvas|github) account/i.test(phrase)) return `their ${LABEL[source]} account is not linked to TAi`;
  if (/not configured/i.test(phrase)) return `${LABEL[source]} is not set up in TAi`;
  if (source === 'github' && /no token/i.test(phrase)) return 'TAi has no access to that GitHub host';
  if (source === 'piazza' && /e-?mail|name/i.test(phrase)) return 'TAi cannot tell which Piazza account is theirs';
  return '';
}

interface LineInfo {
  /** Piazza: whether the account was identified (null: not known). */
  matched: boolean | null;
  /** Piazza: why not, as the helper says it (cleaned, capped). */
  reason: string;
  /** The interview held something of this source before this look. */
  before: boolean;
  /** Why it was skipped. */
  why: string;
}

/** One source in a sentence: arrived, did not, or is not there for this student. "Could not be identified" is never "has not posted". */
function sourceLine(source: SourceName, state: SourceState, i: LineInfo): string {
  const label = LABEL[source];
  if (state === 'ok') {
    if (source === 'piazza' && i.matched === false) return `Piazza: their account could not be identified${i.reason ? ` (${i.reason})` : ''}, which is not the same as not posting.`;
    return `${label}: read just now.`;
  }
  const earlier = i.before ? ' What you already had of it is from before.' : '';
  if (state === 'skipped') return `${label}: not available for them${i.why ? ` (${i.why})` : ''}, so you cannot see it.${earlier}`;
  return `${label}: could not be read just now.${earlier}`;
}

// ---------------------------------------------------------------- what the interview keeps

/**
 * What the interview holds of the week after a look: the fresh part for every source that answered, and what it held before for every source that did
 * not (a Canvas that timed out gives no assignments, and replacing the week wholesale would take the assignment being practiced, and with it the status
 * beat, out of the interview). Null when there is nothing at all.
 */
export function mergeWeek(previous: WeekBriefView | null, fresh: WeekBriefView | null, ok: Record<SourceName, boolean>): WeekBriefView | null {
  const now: WeekBriefView = fresh ?? { window: null, week: null, assignments: [], commits: null, piazza: null };
  const old = previous;
  const merged: WeekBriefView = {
    // (the window and the course week only describe the week: Canvas that answered with none of them leaves the ones the interview had)
    window: ok.canvas ? (now.window ?? old?.window ?? null) : (old?.window ?? now.window),
    week: ok.canvas ? (now.week ?? old?.week ?? null) : (old?.week ?? now.week),
    assignments: ok.canvas ? now.assignments : (old?.assignments ?? now.assignments),
    commits: ok.github && now.commits ? now.commits : (old?.commits ?? now.commits),
    piazza: ok.piazza && now.piazza ? now.piazza : (old?.piazza ?? now.piazza),
  };
  return merged.assignments.length || merged.commits || merged.piazza ? merged : null;
}

// ---------------------------------------------------------------- what the model reads

/** Tighter than the prompt's own levels: the model reads this once and speaks one or two sentences of it. */
const TIGHT: BriefCaps = { requirements: 0, others: 0, names: 40, commits: 2, message: 50, files: 0, posts: 1, postText: 60, comments: 1, commentText: 60, rubric: 0 };
const LOOK_LEVELS: readonly BriefCaps[] = [BRIEF_CAPS[3], BRIEF_CAPS[4], TIGHT];
const FEEDBACK = '## FEEDBACK ON THEIR SUBMISSIONS';

const joined = (sections: readonly string[]): string => sections.join('\n\n');

/** What a section is called when the answer says it was left out ("not there" would say they have none). */
const SECTION_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['## THIS WEEK', 'what is due and where their assignments stand'],
  ['## THEIR COMMITS THIS WEEK', 'their commits'],
  ['## THEIR PIAZZA THIS WEEK', 'their Piazza posts'],
  [FEEDBACK, "the teaching team's notes on their submissions"],
];
const nameOf = (section: string): string => SECTION_NAMES.find(([heading]) => section.startsWith(heading))?.[1] ?? 'some detail';

/**
 * The sections of the view in at most LOOK_DETAILS_MAX characters: the prompt's own renderer (so what a student wrote is quoted data, framed with
 * this answer's nonce), at the first level that fits. The feedback on their submissions is the section least likely to be asked about: it goes first
 * at any level; when even the tightest level does not fit, whole sections go from the end, and the first (what is due and where it stands) stays.
 * `left` names what was dropped: an answer that said nothing would read as "they have none".
 */
function sectionsFor(view: WeekBriefView, practicing: WeekAssignment | null, specText: string, nonce: string): { text: string; left: string[] } {
  let last: string[] = [];
  let all: string[] = [];
  for (const caps of LOOK_LEVELS) {
    all = weekSections(view, { practicing, specText, caps, nonce });
    const kept = [...all];
    while (kept.length > 1 && joined(kept).length > LOOK_DETAILS_MAX && kept[kept.length - 1].startsWith(FEEDBACK)) kept.pop();
    if (joined(kept).length <= LOOK_DETAILS_MAX) return { text: joined(kept), left: all.slice(kept.length).map(nameOf) };
    last = kept;
  }
  while (last.length > 1 && joined(last).length > LOOK_DETAILS_MAX) last.pop();
  return { text: joined(last), left: all.slice(last.length).map(nameOf) };
}

interface Answer {
  status: string;
  note?: string;
  sources?: string;
  shows?: string;
  details?: string;
  /** What the sections would have shown but this answer leaves out to be short. */
  left?: string[];
}

function answer(a: Answer): string {
  return JSON.stringify({
    status: a.status,
    ...(a.note ? { note: a.note } : {}),
    ...(a.sources ? { sources: a.sources } : {}),
    ...(a.shows ? { shows: a.shows } : {}),
    ...(a.details ? { details: a.details } : {}),
    ...(a.left?.length ? { left_out: `Left out to keep this short, not because there is none: ${a.left.join('; ')}.` } : {}),
    instruction: INSTRUCTION,
  });
}

export interface LookOptions {
  /** The call's clock: due times are told as they stand now. */
  now: number;
  /** The interview's assignment ('' when it has none) and the requirements the interview has (the Piazza section says whether the assignment asks for a post). */
  assignmentId: string;
  specText: string;
  /** What the interview held of the week until now (null: nothing). */
  previous: WeekBriefView | null;
  /** A value for this answer's quote markers (a test passes one). */
  nonce?: string;
}

export type Looked =
  | { ok: true; content: string; week: WeekBriefView | null; sources: Record<SourceName, SourceState> }
  | { ok: false; error: string };

const failed = (message: string): Looked => ({ ok: false, error: errorResult(message) });

/**
 * The container's weekly_brief answer (format "json": the brief object itself) as what the model is told, and the week the interview keeps. A failure
 * (not JSON, not a version 1 brief, every source failed or skipped) is a sentence the model can say, never a throw. `week` is null when there is
 * nothing to keep.
 */
export function readLook(text: string, o: LookOptions): Looked {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failed(LOOK_FAILED);
  }
  const b = asObject(parsed);
  if (!b || b.version !== 1) return failed(LOOK_FAILED);

  const read = readSources(b.sources);
  const fresh = parseWeekBrief(b, o.now);
  const has: Record<SourceName, boolean> = { canvas: !!fresh && fresh.assignments.length > 0, github: !!fresh?.commits, piazza: !!fresh?.piazza };
  // a producer that says nothing of a source: it arrived if something of it is there
  const state = {} as Record<SourceName, SourceState>;
  for (const s of SOURCES) state[s] = read.state[s] !== 'unknown' ? read.state[s] : has[s] ? 'ok' : 'failed';
  const ok: Record<SourceName, boolean> = { canvas: state.canvas === 'ok', github: state.github === 'ok', piazza: state.piazza === 'ok' };
  if (!ok.canvas && !ok.github && !ok.piazza) return failed(SOURCES.some((s) => state[s] === 'failed') ? LOOK_FAILED : LOOK_UNAVAILABLE);

  const before: Record<SourceName, boolean> = { canvas: !!o.previous && o.previous.assignments.length > 0, github: !!o.previous?.commits, piazza: !!o.previous?.piazza };
  const reason = oneLine(asObject(b.piazza)?.reason, 100);
  const sources = SOURCES.map((s) => sourceLine(s, state[s], { matched: fresh?.piazza?.matched ?? null, reason, before: before[s], why: skippedBecause(s, read.skipped[s]) })).join(' ');

  const practicing = fresh ? practicingOf(fresh, o.assignmentId) : null;
  const facts = [fresh ? weekFacts(fresh, practicing) : '', ok.canvas && !has.canvas ? 'Canvas: no assignment is listed for this week' : ''].filter(Boolean).join('; ');
  const specText = o.specText || practicing?.requirements || '';
  const sections = fresh ? sectionsFor(fresh, practicing, specText, o.nonce || newNonce()) : { text: '', left: [] };
  return {
    ok: true,
    content: answer({ status: 'looked just now', sources, shows: facts, details: sections.text, left: sections.left }),
    week: mergeWeek(o.previous, fresh, ok),
    sources: state,
  };
}

/** What a call's last look left, as the answer when it may not look again (or when the container says it may not): the view from before, and why it is not a new one. */
export function limitLook(week: WeekBriefView | null, o: { assignmentId: string; specText: string; nonce?: string }): string {
  if (!week) return errorResult(LOOK_NO_VIEW);
  const practicing = practicingOf(week, o.assignmentId);
  const sections = sectionsFor(week, practicing, o.specText || practicing?.requirements || '', o.nonce || newNonce());
  return answer({
    status: 'not looked again',
    note: `You have already looked ${LOOK_MAX} times in this call, so you cannot look again. This is what you had at your last look, or when the interview began: tell them you cannot check again just now.`,
    shows: weekFacts(week, practicing),
    details: sections.text,
    left: sections.left,
  });
}

// ---------------------------------------------------------------- how many looks a call has had

/**
 * The looks a call has made, kept here with the rule that limits them and keyed on the call's session (a call is a session; the container counts per call as
 * well). Every request actually sent counts, a failed or timed-out one too: the container counted it when it checked, whatever came of it.
 */
const looks = new WeakMap<object, number>();
export const looksSoFar = (call: object): number => looks.get(call) ?? 0;
export function countLook(call: object): number {
  const n = looksSoFar(call) + 1;
  looks.set(call, n);
  return n;
}
/** The tool host said the call has had its looks (its count ran ahead of this one): this one counts no more, and no further request is sent for the call. */
export function exhaustLooks(call: object): void {
  looks.set(call, Math.max(looksSoFar(call), LOOK_MAX));
}
