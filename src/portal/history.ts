/**
 * What a student sees in the page: their own messages and TAi's replies, one JSON line each, one file per student. The page reads it
 * (so a reload or a second tab shows the same conversation), and it numbers the messages itself (`n`), so a client's position
 * survives a restart of the orchestrator, unlike the web channel's in-memory outbox sequence.
 *
 * A line is a text message unless it says otherwise (`kind`): a picture TAi sent (`media`: the id the page asks `/api/media/` for, `text`:
 * its caption), an emoji reaction (`to`: the `n` of the message it is on, `emoji`; from TAi on a student's message when `role` is
 * assistant, from the student on one of TAi's when it is user, and an empty `emoji` takes the student's back), a voice call's summary, or a
 * voice note the student sent (`audio`: `mediaId` is the recording's id in the media store, `duration` its seconds, `peaks` the bars of its
 * waveform, `text` the transcript, empty when there was none), or the student's thumb on one of TAi's messages or on a call's summary
 * (`feedback`: `to`, `rating`, and for a thumb down the `tag` of what was wrong; an empty `rating` takes it back), or something that
 * happened for the student and is worth finding again (`activity`: a call, a note TAi kept, a reminder it set; `type`, a `title`, one line of
 * `text` and the rest in `detail`: the page shows it as a compact card in the chat and in its Activity list, not as something TAi said), or
 * what was said aloud in a voice call (`speech`: `text` the words of one turn, `call` the session, or a marker with an `event`: the call began,
 * changed kind or ended; the page draws it as the call's words in the thread: it is not a message).
 * Lines written before these existed have no `kind` and are text.
 */
import fs from 'fs';
import path from 'path';

import { cleanObject, clipObject } from '../chat-objects/clean.js';
import type { ChatObject } from '../chat-objects/types.js';
import type { Choice } from '../choices.js';
import type { SourceChip } from '../sources.js';

export type EntryKind = 'text' | 'image' | 'react' | 'voice' | 'audio' | 'feedback' | 'activity' | 'speech' | 'object';
/** What a marker line of a voice call stands for: the call began, it went into another kind of call, it ended. */
export type SpeechEvent = 'start' | 'mode' | 'end';
export const SPEECH_EVENTS: readonly SpeechEvent[] = ['start', 'mode', 'end'];
/** The kinds of call (src/voice/types.ts AgentMode). */
export const SPEECH_MODES: readonly string[] = ['conversational', 'interviewer', 'listener'];
/**
 * What an activity line is about: the three kinds of call, a note TAi kept, a reminder it set, a concept that moved up in the student's
 * progress, a change in the course (an announcement, a file, an assignment: the same for the whole class).
 */
export type ActivityType = 'voice' | 'interview' | 'talk' | 'memory' | 'reminder' | 'progress' | 'course';
export const ACTIVITY_TYPES: readonly ActivityType[] = ['voice', 'interview', 'talk', 'memory', 'reminder', 'progress', 'course'];
/** The activities that are a call: the ones a thumb may be given to. */
export const isCallType = (type: string | undefined): boolean => type === 'voice' || type === 'interview' || type === 'talk';
/** The student's thumb on a reply; '' on a line that takes it back. */
export type Rating = 'up' | 'down';
/** What a thumb down says was wrong with the reply. */
export type FeedbackTag = 'long' | 'robotic' | 'wrong' | 'other';

export interface EntryFile {
  name: string;
  size: number;
  kind: 'text' | 'document' | 'image' | 'audio' | 'archive';
  /** An image the student sent: the id of its copy in the media store (the page shows it as a thumbnail). */
  media?: string;
}

export interface HistoryEntry {
  n: number;
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: EntryKind;
  /** A student's message: the id TAi sees on it (`<message id=...>`), which its reactions name. */
  id?: string;
  media?: string;
  /** A voice note: the id of the recording in the media store (served by `/api/media/<id>`), its length in seconds, and 0-100 bars for its waveform. */
  mediaId?: string;
  duration?: number;
  peaks?: number[];
  to?: number;
  emoji?: string;
  /** A `feedback` line: the thumb ('' takes it back) and, on a thumb down, what was wrong. */
  rating?: Rating | '';
  tag?: FeedbackTag;
  files?: EntryFile[];
  /** An `activity` line: what it is about, its title ("Voice call · 4 min"), and the longer account the card opens ('' or absent: none; `text` is the one line). */
  type?: ActivityType;
  title?: string;
  detail?: string;
  /** A mock interview's `activity` line: the questions it asked, for the card to list with a way to practise each (at most eight, see cleanItems). */
  items?: ActivityItem[];
  /**
   * A message of TAi's that asks the student to pick: the options (two to six; `text` is the question), and whether it is a quick check
   * (a question with an answer) or a few ways to answer a question TAi asks.
   */
  choices?: Choice[];
  quiz?: boolean;
  /**
   * The answer TAi marked (the index of an option) and its note on it. The host's: `tail`, `since` and `activities` leave it out of what
   * they hand to the page, and only `get` (the host's own reading) returns it.
   */
  secret?: { key?: number; why?: string; doubt?: boolean };
  /**
   * A reply of TAi's: what it opened to write it ("Looked at": at most four chips, each a kind, a label of one line and, only for an allowed host,
   * an https address; src/sources.ts clipSources, applied by the server before the line is written). Not what the reply cites: what TAi's tools returned.
   */
  sources?: SourceChip[];
  /**
   * An `object` line (docs/CHAT_OBJECTS.md): a card that lives in the chat beside the words (a run of the student's code, a document, a chart, a trace, a prediction). `text` is its one-line summary
   * (what search and a screen reader have); the page draws `obj` (portal/web/objects.js). Written only through `appendObject`, which has it cleaned (src/chat-objects/clean.ts).
   */
  obj?: ChatObject;
  /** A student's message that is a tap on an option: the line of TAi's it answers, the option, and whether it was the answer TAi marked (absent when none was marked). */
  choice?: { to: number; index: number; correct?: boolean };
  /**
   * A `speech` line: `text` is what was said aloud in a voice call (role user: the student; assistant: TAi), the words of one turn; `call` is the
   * call's session id. A marker line has no words (`text` is '') and an `event`: `start` and `mode` carry the kind of call (`mode`), `end` carries
   * how long the call was (`seconds`). Not a message: the page draws it as the call's words in the thread.
   */
  call?: string;
  event?: SpeechEvent;
  mode?: string;
  seconds?: number;
}

/** What `append` may add to a line beyond who said it and what. */
export type EntryExtra = Partial<Pick<HistoryEntry, 'kind' | 'id' | 'media' | 'mediaId' | 'duration' | 'peaks' | 'to' | 'emoji' | 'rating' | 'tag' | 'files' | 'type' | 'title' | 'detail' | 'items' | 'choices' | 'quiz' | 'secret' | 'sources' | 'choice' | 'obj' | 'call' | 'event' | 'mode' | 'seconds'>>;

const SPEECH_CHARS = 2000;

/**
 * A line of a voice call as the history keeps it: the words on one line and bounded, or a marker with an event and no words; null when there is
 * nothing to say (no words and no event) or the call has no usable id.
 */
export function clipSpeech(input: { text?: string; call?: string; event?: string; mode?: string; seconds?: number }): { text: string; extra: EntryExtra } | null {
  const call = String(input.call ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!call) return null;
  const event = SPEECH_EVENTS.find((e) => e === input.event);
  const words = String(input.text ?? '').replace(/\s+/g, ' ').trim();
  if (!event && !words) return null;
  const text = event ? '' : words.length > SPEECH_CHARS ? words.slice(0, SPEECH_CHARS - 1).trimEnd() + '…' : words;
  const mode = SPEECH_MODES.find((m) => m === input.mode);
  const seconds = Number.isFinite(input.seconds) ? Math.min(Math.max(Math.round(input.seconds as number), 0), 86_400) : undefined;
  return {
    text,
    extra: {
      kind: 'speech',
      call,
      ...(event ? { event } : {}),
      ...(event && event !== 'end' && mode ? { mode } : {}),
      ...(event === 'end' && seconds !== undefined ? { seconds } : {}),
    },
  };
}

/** A line as the page may have it: without what is the host's alone. */
function publicLine(entry: HistoryEntry): HistoryEntry {
  if (!entry.secret) return entry;
  const { secret: _secret, ...rest } = entry;
  return rest;
}

/**
 * One question of a mock interview as its card lists it (portal/web/review.js draws it): the question, a paraphrase of what the student said
 * (never a transcript), how it went in a level WORD (src/voice/competency.ts levelWord: students see no scores), one sentence on a stronger
 * answer, and the topic. All of it is the student's own, and only they see it.
 */
export interface ActivityItem {
  question: string;
  said: string;
  band: string;
  better: string;
  topic: string;
}

const ITEMS_MAX = 8;
const ITEM_CHARS = 240;
const ITEM_TOPIC_CHARS = 120;
/** A band is a word or two ("solid", "getting there", "just started", "not started"): letters, spaces and a hyphen. A digit makes it a score, and no band at all. */
const BAND_WORDS = /^[a-z][a-z -]{0,23}$/;

/**
 * The `items` of an activity line as the history keeps them: an array of at most eight objects, each with a question (an item without one says
 * nothing and is dropped), and strings of at most 240 characters on one line; anything that is not a string is empty, and a `band` that is not
 * a word is empty. Never throws: what a caller (or an older line) hands over may be anything.
 */
export function cleanItems(raw: unknown): ActivityItem[] {
  if (!Array.isArray(raw)) return [];
  const line = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';
    const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
  };
  const out: ActivityItem[] = [];
  for (const entry of raw) {
    if (out.length >= ITEMS_MAX) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const question = line(item.question, ITEM_CHARS);
    if (!question) continue;
    const band = line(item.band, 24).toLowerCase();
    out.push({ question, said: line(item.said, ITEM_CHARS), band: BAND_WORDS.test(band) ? band : '', better: line(item.better, ITEM_CHARS), topic: line(item.topic, ITEM_TOPIC_CHARS) });
  }
  return out;
}

/** What the rest of the orchestrator hands over when something belongs in a student's activity list. */
export interface ActivityInput {
  type: ActivityType;
  title: string;
  /** One line: the gist. */
  text: string;
  detail?: string;
  /** A mock interview's questions (see cleanItems); anything else is ignored. */
  items?: unknown;
}

const TITLE_CHARS = 60;
const TEXT_CHARS = 140;
const DETAIL_CHARS = 1500;

/** An activity as the history keeps it: the title and the gist on one line each and short, the detail with its line breaks and bounded; null when there is nothing to say. */
export function clipActivity(input: ActivityInput): { text: string; extra: EntryExtra } | null {
  if (!ACTIVITY_TYPES.includes(input.type)) return null;
  const oneLine = (s: string, max: number) => {
    const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
  };
  const title = oneLine(input.title, TITLE_CHARS);
  const text = oneLine(input.text, TEXT_CHARS);
  if (!title || !text) return null;
  const detail = String(input.detail ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, DETAIL_CHARS);
  const items = cleanItems(input.items);
  return { text, extra: { kind: 'activity', type: input.type, title, ...(detail ? { detail } : {}), ...(items.length ? { items } : {}) } };
}

/** Something the student said, typed or spoken: not their emoji on one of TAi's messages, and not anything TAi said. */
export const isStudentMessage = (entry: HistoryEntry): boolean => entry.role === 'user' && (!entry.kind || entry.kind === 'text' || entry.kind === 'audio');

/** A reaction as the agent hears of it: the emoji, and the start of the message of TAi's it is on. */
export interface ReactionNote {
  to: number;
  emoji: string;
  excerpt: string;
}

/** A thumb as the agent hears of it: which, why, the start of what it is on, and whether that was a voice call's summary. */
export interface FeedbackNote {
  to: number;
  rating: Rating;
  tag?: FeedbackTag;
  excerpt: string;
  call: boolean;
}

/** The thumb that stands on a message now: '' when there is none or it was taken back. */
export interface FeedbackState {
  rating: Rating | '';
  tag?: FeedbackTag;
}

export const STUDENT_FOLDER = /^s_[0-9a-f]{20}$/;
/** The owner's second chat, with the instructor's admin group (folder `main`): one for the whole deployment, never a student's. */
export const ADMIN_FOLDER = 'main';
/** A folder that may have a history and pictures here: a student's, or the admin chat's. */
export const isChatFolder = (folder: string): boolean => STUDENT_FOLDER.test(folder) || folder === ADMIN_FOLDER;
// a call's words are lines too (an 8-minute call is about 140 of them), so the window a student's history keeps in memory is wider than it was
const KEEP_IN_MEMORY = 2500;
const KINDS: readonly string[] = ['text', 'image', 'react', 'voice', 'audio', 'feedback', 'activity', 'speech', 'object'];
const EXCERPT_CHARS = 80;

/** The start of a message of TAi's, as the agent is shown it with a reaction or a thumb: one line, no quotation marks inside. */
function excerptOf(target: HistoryEntry | undefined): string {
  const words = (target?.text || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  if (words) return words.length > EXCERPT_CHARS ? `${words.slice(0, EXCERPT_CHARS).trimEnd()}…` : words;
  return target?.kind === 'image' ? '(a picture)' : target?.kind === 'object' ? '(a card)' : '';
}

export class History {
  private entries: HistoryEntry[] = [];
  private lastN = 0;
  /** The agent has been told of everything up to this line (a reply that was started by the student's emoji carried the notes): the next message does not repeat them. */
  private toldUpTo = 0;

  constructor(private readonly file: string) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      /* no conversation yet */
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        let kindOk = entry.kind === undefined || KINDS.includes(entry.kind);
        if (kindOk && entry.kind === 'object') {
          // a card is kept only as the gate would make it now: a line whose object is no longer valid is not worth failing for
          const obj = cleanObject(entry.obj);
          if (obj) entry.obj = obj;
          else kindOk = false;
        }
        if (typeof entry.n === 'number' && typeof entry.text === 'string' && (entry.role === 'user' || entry.role === 'assistant') && kindOk) {
          this.entries.push(entry);
          this.lastN = Math.max(this.lastN, entry.n);
        }
      } catch {
        /* a half-written last line after a crash is not worth failing for */
      }
    }
    if (this.entries.length > KEEP_IN_MEMORY) this.entries.splice(0, this.entries.length - KEEP_IN_MEMORY);
  }

  get last(): number {
    return this.lastN;
  }

  append(role: HistoryEntry['role'], text: string, now: Date = new Date(), extra: EntryExtra = {}): HistoryEntry {
    const entry: HistoryEntry = { n: ++this.lastN, ts: now.toISOString(), role, text };
    // only the fields that are set are written, so a plain message stays the line it always was
    for (const key of Object.keys(extra) as (keyof EntryExtra)[]) {
      if (extra[key] !== undefined) (entry as unknown as Record<string, unknown>)[key] = extra[key];
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    this.entries.push(entry);
    if (this.entries.length > KEEP_IN_MEMORY) this.entries.shift();
    return entry;
  }

  /** A card in the chat (a chat object): cleaned by the gate, its summary the line's text; null when what was handed over is no object. */
  appendObject(raw: unknown, now: Date = new Date()): HistoryEntry | null {
    const clipped = clipObject(raw);
    if (!clipped) return null;
    return this.append('assistant', clipped.text, now, { kind: 'object', obj: clipped.obj });
  }

  /**
   * The newest `limit` entries, oldest first. The words of a voice call (`speech`) are not what a page asks for when it asks for the last N
   * lines of a conversation: they do not use up its places, so a long call does not push the chat before it off the first screen. The speech
   * lines among the entries that are returned come with them, the newest twice `limit` of them at most (so three times `limit` lines in all).
   */
  tail(limit: number): HistoryEntry[] {
    let from = 0;
    let counted = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].kind === 'speech') continue;
      if (++counted > limit) {
        from = i + 1;
        break;
      }
    }
    const window = this.entries.slice(from);
    let drop = Math.max(0, window.filter((e) => e.kind === 'speech').length - limit * 2);
    const out: HistoryEntry[] = [];
    for (const entry of window) {
      if (entry.kind === 'speech' && drop > 0) {
        drop--;
        continue;
      }
      out.push(publicLine(entry));
    }
    return out;
  }

  /**
   * The activity list: activity lines and the old call summaries (`voice`), newest first, only those numbered below `before` when it is given,
   * at most `limit`; `more` says there are older ones.
   */
  activities(limit: number, before?: number): { entries: HistoryEntry[]; more: boolean } {
    const entries: HistoryEntry[] = [];
    let more = false;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.role !== 'assistant' || (entry.kind !== 'activity' && entry.kind !== 'voice')) continue;
      if (before !== undefined && entry.n >= before) continue;
      if (entries.length >= limit) {
        more = true;
        break;
      }
      entries.push(publicLine(entry));
    }
    return { entries, more };
  }

  /** The agent has just been told, in a message of its own, of the emoji and thumbs up to here: the next message of the student's starts after them. */
  markTold(): void {
    this.toldUpTo = this.lastN;
  }

  /** Entries after position `n` (at most `limit`), oldest first. */
  since(n: number, limit = 200): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (const entry of this.entries) {
      if (entry.n > n) {
        out.push(publicLine(entry));
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Whether the options of TAi's line `n` can still be tapped: `open` while it is the last thing either of them has said; `answered` once a
   * tap on it is in the history; `closed` when the student has written or spoken something else, or TAi has said more, since. (An emoji, a
   * thumb, a card in the activity list or TAi's own emoji is not something said.)
   */
  choiceState(n: number): 'open' | 'answered' | 'closed' {
    for (const entry of this.entries) {
      if (entry.n <= n) continue;
      if (entry.role === 'user' && entry.choice?.to === n) return 'answered';
      if (isStudentMessage(entry)) return 'closed';
      if (entry.role === 'assistant' && (!entry.kind || entry.kind === 'text' || entry.kind === 'image')) return 'closed';
    }
    return 'open';
  }

  /** The student's message that carries this id (what a reaction names), if it is still in memory. */
  findUserById(id: string): HistoryEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.role === 'user' && entry.id === id) return entry;
    }
    return undefined;
  }

  /** The student's newest message (typed or a voice note, never their emoji on one of TAi's), if it is no older than `maxAgeMs`. A reaction that names an id nobody knows goes to it. */
  latestUser(maxAgeMs: number, now: number): HistoryEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!isStudentMessage(entry)) continue;
      return now - Date.parse(entry.ts) <= maxAgeMs ? entry : undefined;
    }
    return undefined;
  }

  /** One line by its number, if it is still in memory. */
  get(n: number): HistoryEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.n === n) return entry;
      if (entry.n < n) return undefined;           // numbers only grow
    }
    return undefined;
  }

  /** The student's emoji on one of TAi's messages as it stands now (their newest `react` line for it), or '' when there is none or they took it back. */
  reactionOn(n: number): string {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.role === 'user' && entry.kind === 'react' && entry.to === n) return entry.emoji || '';
      if (entry.n < n) break;                      // a reaction cannot come before the message it is on
    }
    return '';
  }

  /**
   * What the student has reacted to since their last message, as the agent should hear of it with their next one: the net result per
   * message of TAi's (an emoji that was set and taken back says nothing, a changed one says its final value), oldest first, at most `max`
   * (the newest). Call it BEFORE the new message is appended, or there is nothing "since" it.
   */
  reactionsSinceLastMessage(max = 3): ReactionNote[] {
    const latest = new Map<number, string>();      // newest first: the first line met for a message is its final state
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (isStudentMessage(entry) || entry.n <= this.toldUpTo) break;
      if (entry.role === 'user' && entry.kind === 'react' && typeof entry.to === 'number' && !latest.has(entry.to)) latest.set(entry.to, entry.emoji || '');
    }
    const notes: ReactionNote[] = [];
    for (const [to, emoji] of [...latest].reverse()) {
      if (!emoji) continue;
      notes.push({ to, emoji, excerpt: excerptOf(this.get(to)) });
    }
    return notes.slice(-max);
  }

  /** The student's thumb on one of TAi's messages as it stands now (their newest `feedback` line for it). */
  feedbackOn(n: number): FeedbackState {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.role === 'user' && entry.kind === 'feedback' && entry.to === n) return entry.rating ? { rating: entry.rating, ...(entry.tag ? { tag: entry.tag } : {}) } : { rating: '' };
      if (entry.n < n) break;                      // a thumb cannot come before the message it is on
    }
    return { rating: '' };
  }

  /**
   * The thumbs the student has given since their last message, as the agent should hear of them with their next one: the net result per
   * message (a thumb that was given and taken back says nothing, a changed one says its final value), oldest first, at most `max` (the
   * newest). Like reactionsSinceLastMessage it is called BEFORE the new message is appended.
   */
  feedbackSinceLastMessage(max = 3): FeedbackNote[] {
    const latest = new Map<number, FeedbackState>();      // newest first: the first line met for a message is its final state
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (isStudentMessage(entry) || entry.n <= this.toldUpTo) break;
      if (entry.role === 'user' && entry.kind === 'feedback' && typeof entry.to === 'number' && !latest.has(entry.to)) {
        latest.set(entry.to, entry.rating ? { rating: entry.rating, ...(entry.tag ? { tag: entry.tag } : {}) } : { rating: '' });
      }
    }
    const notes: FeedbackNote[] = [];
    for (const [to, state] of [...latest].reverse()) {
      if (!state.rating) continue;
      const target = this.get(to);
      notes.push({ to, rating: state.rating, ...(state.tag ? { tag: state.tag } : {}), excerpt: excerptOf(target), call: target?.kind === 'voice' || (target?.kind === 'activity' && isCallType(target.type)) });
    }
    return notes.slice(-max);
  }
}

export class HistoryStore {
  private open = new Map<string, History>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** The history of a student folder (s_ and 20 hex digits) or of the admin chat: nothing else becomes a file name. */
  forFolder(folder: string): History {
    if (!isChatFolder(folder)) throw new Error('not a chat folder');
    let history = this.open.get(folder);
    if (!history) {
      history = new History(path.join(this.dir, `${folder}.jsonl`));
      this.open.set(folder, history);
    }
    return history;
  }
}
