/**
 * The host's side of the container tools `show_chart`, `show_trace` and `ask_to_predict` (docs/CARDS.md): the IPC verb `chat_object`, kept apart from src/ipc.ts (which imports the database) so that its
 * rules are tested without one. The model of src/docs/ipc-verb.ts and src/sandbox/ipc-verb.ts, with one difference: nothing here takes long (the data is checked and a card is written), so the answer is
 * written before the function returns, and there is no timer.
 *
 * Every request gets exactly one answer (`results/<requestId>.json`, which the container's tool waits for): a refusal with the first thing wrong, a card left in the chat, a chat that did not take the card.
 * The student is the folder of the IPC directory the file was in: nothing in the file names a student. The request is `{ kind: 'chart' | 'trace' | 'predict', args }` with the arguments of the tool as the
 * model gave them; they become the object through the type's own builder and the history's one gate (`cleanObject`), the same as the voice functions' (src/voice/objects-fn.ts), and what the gate left out is said.
 * A student may be given `CHAT_OBJECT_LIMITS.perWindow` cards an hour whatever the container's own count says (a container is started again for each conversation). What is logged is the kind and how it ended,
 * never the data.
 */
import { chartDropped, chartFromArgs, whyNotChart } from './chart.js';
import { cleanObject, objectSummary } from './clean.js';
import { predictDropped, predictFromArgs, whyNotPredict } from './predict.js';
import { isRecord } from './text.js';
import { traceDropped, traceFromArgs, whyNotTrace } from './trace.js';
import type { ChatObject } from './types.js';

export const CHAT_OBJECT_KINDS = ['chart', 'trace', 'predict'] as const;
export type ChatObjectKind = (typeof CHAT_OBJECT_KINDS)[number];

/** The most of the host's answer that is kept (src/ipc.ts answer() is given it; the container's tool reads up to the same number: container/agent-runner/src/chat-cards.ts keeps a twin, and a test fails when they differ). */
export const CHAT_OBJECT_ANSWER_CHARS = 900;
/** A request whose JSON is longer than this is refused unread (the gate's own limits are far below it). */
export const CHAT_OBJECT_REQUEST_CHARS = 150_000;
/** What one student may be given, whatever a container counts: cards in the window, and how many students the count remembers. */
export const CHAT_OBJECT_LIMITS = { windowMs: 60 * 60 * 1000, perWindow: 24, folders: 500 } as const;

export const CHAT_OBJECT_NOT_REGISTERED = 'Not drawn: this chat is not registered, so there is no student to show a card to.';
export const CHAT_OBJECT_KIND_UNKNOWN = `Not drawn: the kind of card is one of ${CHAT_OBJECT_KINDS.join(', ')}.`;
export const CHAT_OBJECT_TOO_BIG = 'Not drawn: the request is far too big. A card holds a few dozen numbers or steps, or a small program.';
export const CHAT_OBJECT_LIMIT_MESSAGE = `Not drawn: this student has been given ${CHAT_OBJECT_LIMITS.perWindow} cards in the last hour, which is the limit. Say it in words instead.`;
export const CHAT_OBJECT_NO_CARD = 'The card was fine, but the chat did not take it, so the student has not seen it. Say so in one short sentence and say it in words instead; asking again may work.';

export interface ChatObjectVerbInput {
  /** The folder of the IPC directory the file was in: the student the card is for (never read from the file). */
  folder: string;
  isMain: boolean;
  /** The request's id when it has a usable one (src/ipc.ts REQUEST_ID), else null. */
  requestId: string | null;
  /** What the file says the request is: `{ kind, args }`, checked here, nothing else of it is used. */
  request: unknown;
  /** The registered group of that folder, the host's own record. */
  group?: object;
}

export interface ChatObjectVerbEnv {
  /** Writes the answer for the container that asked (src/ipc.ts answer()). It may throw: that is caught. */
  say: (requestId: string, ok: boolean, message: string) => void;
  /** One line for the audit log (the kind and how it ended, never the data). Best effort. */
  audit: (operation: string, fields: Record<string, unknown>) => void;
  /** Puts a card in the student's chat (docs/CHAT_OBJECTS.md): `obj` is what src/chat-objects/clean.ts accepts. It throws when the chat did not take the card. Without it no card can be made. */
  postObject?: (folder: string, obj: unknown) => void;
  log: { warn(fields: Record<string, unknown>, message: string): void };
  /** Tests: the clock. */
  now?: () => number;
}

/** The cards each student was given lately (times), bounded in the number of students. */
const given = new Map<string, number[]>();
/** Tests: forget what was given. */
export const _resetChatObjects = (): void => given.clear();

/** Whether this student may be given one more card now (and, if so, that it was). */
function takeOne(folder: string, now: number): boolean {
  const recent = (given.get(folder) ?? []).filter((t) => now - t < CHAT_OBJECT_LIMITS.windowMs);
  if (recent.length >= CHAT_OBJECT_LIMITS.perWindow) {
    given.set(folder, recent);
    return false;
  }
  recent.push(now);
  given.delete(folder);
  given.set(folder, recent);
  while (given.size > CHAT_OBJECT_LIMITS.folders) {
    const oldest = given.keys().next();
    if (oldest.done) break;
    given.delete(oldest.value);
  }
  return true;
}

interface Kind {
  from: (args: unknown) => Record<string, unknown>;
  why: (raw: unknown) => string | null;
  dropped: (raw: unknown, obj: ChatObject) => string;
  /** What the model is told when the card is in the chat (the summary is the object's own one-line text). */
  done: (summary: string) => string;
}

const KINDS: Record<ChatObjectKind, Kind> = {
  chart: {
    from: chartFromArgs,
    why: whyNotChart,
    dropped: (raw, obj) => (obj.t === 'chart' ? chartDropped(raw, obj) : ''),
    done: (summary) =>
      `${summary}: it is in the chat now as a card, drawn from the numbers you gave. Say in one or two sentences what to look at and ask what they notice; do not list the numbers back, and do not claim more than the data shows.`,
  },
  trace: {
    from: traceFromArgs,
    why: whyNotTrace,
    dropped: (raw, obj) => (obj.t === 'trace' ? traceDropped(raw, obj) : ''),
    done: (summary) => `${summary}: it is in the chat now as a card with Previous, Next and Play, and they step through it. Say in one sentence what to watch for, then let them step; do not retell the steps.`,
  },
  predict: {
    from: predictFromArgs,
    why: whyNotPredict,
    dropped: (raw, obj) => (obj.t === 'predict' ? predictDropped(raw, obj) : ''),
    done: (summary) =>
      `${summary}: it is in the chat now as a card. They pick or type a guess and press Run themselves: that runs it once, as one of their own runs. You then get a note with their guess and what it printed (in lines that open [The student sees]): set them side by side and ask what they make of it. Do not say what it prints and do not run it yourself with run_go; wait for their guess.`,
  },
};

/**
 * Handles a request from a container. Never throws: every way out writes exactly one answer (or, for a request with no usable id, none).
 */
export function handleChatObject(input: ChatObjectVerbInput, env: ChatObjectVerbEnv): void {
  const { folder, requestId } = input;
  if (requestId === null) {
    env.log.warn({ folder }, 'chat_object without a usable request id: dropped');
    return;
  }
  let answered = false;
  const settle = (ok: boolean, message: string): void => {
    if (answered) return;
    answered = true;
    try {
      env.say(requestId, ok, message.slice(0, CHAT_OBJECT_ANSWER_CHARS));
    } catch (err) {
      env.log.warn({ folder, err: err instanceof Error ? err.message : String(err) }, 'chat_object: the answer could not be written');
    }
  };
  const audit = (fields: Record<string, unknown>): void => {
    try {
      env.audit('chat_object', { sourceGroup: folder, isMain: input.isMain, ...fields });
    } catch {
      /* the log is a convenience: it never changes what the container is told */
    }
  };

  try {
    if (!input.group && !input.isMain) {
      env.log.warn({ folder }, 'chat_object from a chat that is not registered: refused');
      return settle(false, CHAT_OBJECT_NOT_REGISTERED);
    }
    const body = isRecord(input.request) ? input.request : {};
    const kind = CHAT_OBJECT_KINDS.find((k) => k === body.kind);
    if (!kind) {
      audit({ ok: false, reason: 'kind' });
      return settle(false, CHAT_OBJECT_KIND_UNKNOWN);
    }
    let size = Infinity;
    try {
      size = JSON.stringify(body.args)?.length ?? 0;
    } catch {
      /* not JSON: too big for our purposes */
    }
    if (size > CHAT_OBJECT_REQUEST_CHARS) {
      audit({ kind, ok: false, reason: 'too-big' });
      return settle(false, CHAT_OBJECT_TOO_BIG);
    }

    const spec = KINDS[kind];
    const raw = spec.from(body.args);
    const why = spec.why(raw);
    const obj = why === null ? cleanObject(raw) : null;
    if (!obj) {
      audit({ kind, ok: false, reason: 'refused' });
      return settle(false, `Not drawn: ${why ?? 'the card is not one the chat can hold'}. Fix it and call again, or say it in words.`);
    }
    if (!takeOne(folder, (env.now ?? Date.now)())) {
      audit({ kind, ok: false, reason: 'limit' });
      return settle(false, CHAT_OBJECT_LIMIT_MESSAGE);
    }
    // the model is told "it is in the chat" only when the card was written (the host's postObject throws when the chat did not take it)
    let left = false;
    if (env.postObject) {
      try {
        env.postObject(folder, obj);
        left = true;
      } catch (err) {
        env.log.warn({ folder, kind, err: err instanceof Error ? err.message : String(err) }, 'chat_object: the card could not be left');
      }
    }
    if (!left) {
      audit({ kind, ok: false, reason: 'no-card' });
      return settle(false, CHAT_OBJECT_NO_CARD);
    }
    audit({ kind, ok: true });
    const dropped = spec.dropped(raw, obj);
    return settle(true, [spec.done(objectSummary(obj)), dropped].filter(Boolean).join(' '));
  } catch (err) {
    env.log.warn({ folder, err: err instanceof Error ? err.message : String(err) }, 'chat_object: the work failed');
    settle(false, 'Not drawn: the card could not be made (not the student\'s fault). Say so in one short sentence and say it in words instead.');
  }
}
