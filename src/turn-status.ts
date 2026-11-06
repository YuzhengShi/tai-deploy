/**
 * What the student's page shows while TAi works on a message (docs/PROGRESS.md): "Checking Canvas", "Searching Piazza", "Waiting for a free slot".
 *
 * The runner in the container writes progress events (container/agent-runner/src/protocol.ts: one line, PROGRESS_MARKER and a JSON object); the
 * container runner parses them here and src/index.ts hands them to the web channel as an ephemeral status. Two rules hold the whole way:
 *
 *   - a status is NEVER text from the model, a student or a tool. The words come from a fixed table in this file; a tool that is not in it is
 *     "Working", and the name it came with is dropped. No argument is ever part of an event.
 *   - a place in line is said only when the queue knows it (src/group-queue.ts queuePosition): never an estimate.
 *
 * The events are not trusted either: the container's stdout can be written by anything that runs in it.
 */
import { shapeSources, type SourceChip } from './sources.js';

/** The line that starts a progress event on a container's stdout (container/agent-runner/src/protocol.ts: the two must match). */
export const PROGRESS_MARKER = '---NANOCLAW_PROGRESS---';

/**
 * A reply being written (TAI_PORTAL_STREAM, docs/STREAMING.md): `text` is everything of assistant message `n` so far (empty: the runner takes it
 * back, the message goes on to call a tool), `textError` is a line of that kind that did not parse. Only read from a container that was started with
 * the flag (parseProgressLine's `text` option); with it off the lines are not events at all.
 */
export type TextEvent = { type: 'text'; n: number; text: string } | { type: 'textError' };

export type ProgressEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; phase: 'start' | 'end' }
  | { type: 'sources'; seq: number; items: SourceChip[] }
  | TextEvent;

/** What the page is told: working (with what TAi is doing, once the runner has said) or waiting for a container (with how many are ahead, when known). */
export interface ChatStatus {
  state: 'working' | 'queued';
  label?: string;
  ahead?: number;
  /** Streaming only (TAI_PORTAL_STREAM): the words of the reply that may be shown so far. Never in a status when the flag is off. */
  partial?: string;
}

/** What a channel that can show progress (the web page) offers the orchestrator for a chat's turn. Optional on Channel: WhatsApp has none. */
export interface TurnView {
  /** What the runner reports (state working, with a label); null clears it. The channel tells whoever listens. */
  setStatus(jid: string, status: ChatStatus | null): void;
  /** The queue moved: whoever listens should read the status again. */
  refreshStatus(jid: string): void;
  addSources(jid: string, seq: number, items: SourceChip[]): void;
  /** The chips the next answer carries (once). */
  takeSources(jid: string): SourceChip[] | undefined;
  resetSources(jid: string): void;
  /** A turn begins: what was kept of the last one's preview goes. Streaming only (the web channel); a channel without it has no preview. */
  beginTurn?(jid: string): void;
  /** The runner's account of the reply it is writing; the channel decides what of it may be shown (src/stream-preview.ts). */
  previewEvent?(jid: string, event: TextEvent): void;
  /** A model request begins or a tool starts: the words written before it are not the reply. Does nothing when nothing is shown. */
  previewClear?(jid: string): void;
}

/** What goes with a message to the channel beyond its words. */
export interface MessageExtras {
  sources?: SourceChip[];
}

// --- the words ------------------------------------------------------------------------------------------------------------------

/** Every label a status can have. The page holds the same list (portal/web/status.js) and refuses any other. */
export const STATUS_LABELS = {
  canvas: 'Checking Canvas',
  github: 'Looking at your GitHub',
  piazza: 'Searching Piazza',
  course: 'Looking in the course materials',
  diagram: 'Drawing a diagram',
  file: 'Reading your file',
  web: 'Reading a web page',
  thinking: 'Thinking',
  working: 'Working',
} as const;

/** The coarse names the runner sends (container/agent-runner/src/progress.ts coarseToolName) that have a label of their own. */
const TOOL_LABEL: Record<string, string> = {
  canvas_query: STATUS_LABELS.canvas,
  github_query: STATUS_LABELS.github,
  piazza_query: STATUS_LABELS.piazza,
  query_knowledge: STATUS_LABELS.course,
  render_diagram: STATUS_LABELS.diagram,
  generate_teaching_image: STATUS_LABELS.diagram,
  read_upload: STATUS_LABELS.file,
  web_fetch: STATUS_LABELS.web,
};

/**
 * Tools that are TAi's own housekeeping, not something the student would be told about: they leave the label as "Thinking" (a read of TAi's own
 * notes is not "Reading your file", and a message sent through a tool is not work). Any tool that is in neither list is "Working".
 */
const QUIET_TOOLS = new Set([
  'send_message',
  'react_to_message',
  'memory_store',
  'memory_query',
  'set_student_identity',
  'schedule_task',
  'list_tasks',
  'pause_task',
  'resume_task',
  'cancel_task',
  'read',
  'write',
  'edit',
  'grep',
  'find',
  'ls',
]);

/** The label of a tool, from the fixed table. The name is never shown. */
export function labelForTool(name: string): string {
  if (Object.prototype.hasOwnProperty.call(TOOL_LABEL, name)) return TOOL_LABEL[name];
  return QUIET_TOOLS.has(name) ? STATUS_LABELS.thinking : STATUS_LABELS.working;
}

const MAX_OPEN = 32;

/**
 * What one container run is doing, from its events. Tools may run side by side, and an end comes in the order they finish, so the tools in flight
 * are kept and the label is the newest one's; with none in flight the model is reading what they returned, which is "Thinking". A model request
 * that begins means every tool of the step before it is over (a call a guard refused starts and never ends), so it clears them.
 */
export class TurnStatus {
  private readonly open: string[] = [];

  apply(event: { type: 'thinking' } | { type: 'tool'; name: string; phase: 'start' | 'end' }): ChatStatus {
    if (event.type === 'thinking') {
      this.open.length = 0;
    } else if (event.phase === 'start') {
      this.open.push(event.name);
      if (this.open.length > MAX_OPEN) this.open.shift();
    } else {
      const at = this.open.lastIndexOf(event.name);
      if (at >= 0) this.open.splice(at, 1);
    }
    const newest = this.open.length > 0 ? this.open[this.open.length - 1] : undefined;
    return { state: 'working', label: newest === undefined ? STATUS_LABELS.thinking : labelForTool(newest) };
  }
}

// --- reading the events ---------------------------------------------------------------------------------------------------------

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_LINE = 8192;

/** TAI_PORTAL_STREAM=1 in the orchestrator's environment: a student's web chat gets a preview of the reply while it is written. Off unless it is exactly "1". */
export function portalStreamOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.TAI_PORTAL_STREAM === '1';
}

/** How a text line starts (the runner's JSON.stringify puts the type first): the lines a log must not keep, and the ones that are errors when they do not parse. */
export const TEXT_EVENT_PREFIX = `${PROGRESS_MARKER} {"type":"text"`;

/** A container's stdout without its text lines: what may go to a log (the reply's words are there once, as the result that was delivered, never as previews). */
export function withoutTextEvents(stdout: string): string {
  if (!stdout.includes(TEXT_EVENT_PREFIX)) return stdout;
  return stdout
    .split('\n')
    .filter((line) => !line.startsWith(TEXT_EVENT_PREFIX))
    .join('\n');
}

/**
 * One progress line from a container's stdout, as an event; null for anything that is not one of the kinds, or is not well formed. `text` is true
 * only for a container that was started with TAI_PORTAL_STREAM: then a text line is an event, and one that does not parse (or is too long, or has
 * broken characters in it: a chunk cut inside a multi-byte character) is a `textError`, which ends the turn's preview. With it off (the default) a text
 * line is not an event: whatever wrote it, it is skipped like any other line.
 */
export function parseProgressLine(line: string, options: { text?: boolean } = {}): ProgressEvent | null {
  if (!line.startsWith(PROGRESS_MARKER)) return null;
  const body = line.slice(PROGRESS_MARKER.length).trim();
  const textLine = options.text === true && body.startsWith('{"type":"text"');
  const bad: ProgressEvent | null = textLine ? { type: 'textError' } : null;
  if (!body || body.length > MAX_LINE) return bad;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return bad;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad;
  const event = data as Record<string, unknown>;
  switch (event.type) {
    case 'text': {
      if (options.text !== true) return null;
      const n = event.n;
      return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1e9 && typeof event.text === 'string' && !event.text.includes('�')
        ? { type: 'text', n, text: event.text }
        : { type: 'textError' };
    }
    case 'thinking':
      return { type: 'thinking' };
    case 'tool':
      return typeof event.name === 'string' && TOOL_NAME.test(event.name) && (event.phase === 'start' || event.phase === 'end')
        ? { type: 'tool', name: event.name, phase: event.phase }
        : null;
    case 'sources': {
      const items = shapeSources(event.items);
      const seq = typeof event.seq === 'number' && Number.isInteger(event.seq) && event.seq >= 0 && event.seq <= 1e9 ? event.seq : null;
      return seq !== null && items.length > 0 ? { type: 'sources', seq, items } : null;
    }
    default:
      return null;
  }
}

/**
 * What src/index.ts does with each event of one container run: a tool or a thinking becomes the chat's status, chips are kept for the answer.
 * `view` is the channel's (undefined: WhatsApp has none, and the events are dropped).
 */
export function progressForwarder(options: {
  jid: string;
  turn: TurnStatus;
  view: TurnView | undefined;
  /** Streaming: true while the turn's answer is already going out another way (the marker the send tool leaves, src/index.ts); the words are not previewed then. */
  muted?: () => boolean;
}): (event: ProgressEvent) => void {
  return (event) => {
    const { view, jid, turn } = options;
    if (!view) return;
    if (event.type === 'sources') {
      view.addSources(jid, event.seq, event.items);
    } else if (event.type === 'text' || event.type === 'textError') {
      if (options.muted?.()) view.previewClear?.(jid);
      else view.previewEvent?.(jid, event);
    } else {
      if (event.type === 'thinking' || event.phase === 'start') view.previewClear?.(jid);      // what was written before a request or a tool is not the reply
      view.setStatus(jid, turn.apply(event));
    }
  };
}
