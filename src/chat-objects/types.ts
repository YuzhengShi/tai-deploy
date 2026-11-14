/**
 * Chat objects (docs/CHAT_OBJECTS.md): structured things that live in the chat beside the words, as one line of the student's history with `kind: 'object'` and an `obj` that
 * is one of these. They are drawn by the page from DOM nodes (portal/web/objects.js, one renderer for each `t`): never from HTML or SVG that a model wrote. Only host code writes
 * them, and only through `cleanObject` (src/chat-objects/clean.ts): a model gives data (a chart's numbers, a trace's steps) and the host makes the object.
 */

export const OBJECT_TYPES = ['run', 'doc', 'chart', 'trace', 'predict'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

/** What an object may weigh as the history keeps it (its JSON): a line of the chat is never megabytes. */
export const OBJECT_JSON_MAX = 24_000;
/** The output a run card shows (the middle is left out when it is longer). */
export const RUN_OUTPUT_CHARS = 16_000;

/** The result of a run of a student's code (src/sandbox), as the student sees it. Written by the host from the sandbox's own result, never by a model. */
export interface RunObject {
  t: 'run';
  /** `go test -race ./...`: the host's words for the command (commandLine in src/sandbox/types.ts). */
  command: string;
  /** The program ran (false: it did not start; `note` says why and `output` is empty). */
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Cleaned program output (no terminal escapes, no control characters but tab and newline), at most RUN_OUTPUT_CHARS. */
  output: string;
  /** The output was cut: the sandbox's cap, or this card's. */
  truncated: boolean;
  /** One sentence of the host's (it ran out of memory, it was stopped at the time limit). */
  note?: string;
}

/** A prepared document (src/docs): the card opens the viewer on it. */
export interface DocObject {
  t: 'doc';
  /** The prepared document's id (src/docs/types.ts DOC_ID). */
  doc: string;
  title: string;
  pages: number;
  /** The page the card opens at (1-based). */
  page?: number;
  origin?: 'upload' | 'canvas' | 'course';
}

/** A chart of numbers a model gave and the host checked; the page draws it as DOM-built SVG. Batch C: the cleaner is src/chat-objects/chart.ts. */
export interface ChartObject {
  t: 'chart';
  title: string;
  kind: 'line' | 'bar' | 'scatter';
  xLabel: string;
  yLabel: string;
  xUnit?: string;
  yUnit?: string;
  /** A bar chart: the category of each bar (at most 24). Absent for line and scatter. */
  categories?: string[];
  /** At most 6 series of at most 200 points; a point is `y` (its x is its index, or the category of a bar) or `[x, y]`. */
  series: Array<{ name: string; points: Array<number | [number, number]> }>;
  note?: string;
}

/** A message-flow trace to step through (Raft, Paxos, a request through a service): batch C, cleaner src/chat-objects/trace.ts. */
export interface TraceObject {
  t: 'trace';
  title: string;
  /** Two to eight actors (a lane each). */
  actors: string[];
  /** At most 120 steps in order: a message from `from` to `to`, or an event of `from` alone when `to` is absent; `state` is what actors hold after it. */
  events: Array<{ from: string; to?: string; label: string; note?: string; state?: Array<{ actor: string; text: string }> }>;
  note?: string;
}

/** A question whose answer the student guesses before the code runs: batch C, cleaner src/chat-objects/predict.ts. The student's click runs it (src/sandbox) and the run is a `run` object. */
export interface PredictObject {
  t: 'predict';
  question: string;
  action: 'run' | 'test';
  pkg: string;
  files: Array<{ path: string; content: string }>;
  /** Two to six options to guess from; absent: the student types a guess. */
  choices?: string[];
}

export type ChatObject = RunObject | DocObject | ChartObject | TraceObject | PredictObject;
