/**
 * show_chart, show_trace and ask_to_predict: what the tools say to the model, what they send the host and how they answer (the MCP server, ipc-mcp-stdio.ts, only registers them). Each asks the host for a CARD in
 * the student's chat (docs/CARDS.md): a chart of numbers, a sequence they step through, a small program they guess the output of before it runs. The tool writes an IPC request `chat_object` into
 * /workspace/ipc/tasks, `{ kind: 'chart' | 'trace' | 'predict', args }` with the model's arguments untouched, and waits for the host's answer in /workspace/ipc/results/<id>.json, the way the task tools do
 * (ipc-result.ts). The host checks the data through the history's one gate (src/chat-objects), makes the card itself and answers in a sentence: that it is in the chat, or the first thing wrong. The container
 * validates nothing beyond the types of the arguments.
 *
 * They refuse in a scheduled task (a card needs the student in the conversation) and in a voice call's tool host (the call has its own functions, which are host code). Kept apart from ipc-mcp-stdio.ts, which
 * starts a server when it is imported, so it can be unit tested. The number below is a twin of the host's (src/chat-objects/ipc-verb.ts CHAT_OBJECT_ANSWER_CHARS): the container is built apart and cannot import
 * it, and test/chat-cards.test.ts fails when a copy differs.
 */

import { RESULT_WAIT_MS, awaitIpcResult, newRequestId } from './ipc-result.js';
import type { WaitOptions } from './ipc-result.js';
import type { ToolReply } from './retry-guard.js';

export const CHAT_CARDS_NUMBERS = {
  /** The host answers as soon as its watcher has the request (it looks every second): the usual wait of the task tools is plenty. */
  requestWaitMs: RESULT_WAIT_MS,
  /** The most of the host's answer that is kept (CHAT_OBJECT_ANSWER_CHARS). */
  answerChars: 900,
} as const;

export type CardKind = 'chart' | 'trace' | 'predict';

/** What the tools are given: the model's own arguments, which go to the host as they are (the host's cleaner decides what they are worth). */
export interface ShowChartArgs {
  title: string;
  kind: 'line' | 'bar' | 'scatter';
  x_label: string;
  y_label: string;
  x_unit?: string;
  y_unit?: string;
  categories?: string[];
  /** `points` are numbers or pairs [x, y]: the schema says so in words and does not use a union (one every model API takes), and the host's cleaner is what reads them. */
  series: Array<{ name: string; points: unknown[] }>;
  note?: string;
}
export interface ShowTraceArgs {
  title: string;
  actors: string[];
  events: Array<{ from: string; to?: string; label: string; note?: string; state?: Array<{ actor: string; text: string }> }>;
  note?: string;
}
export interface AskToPredictArgs {
  question: string;
  action: 'run' | 'test';
  pkg?: string;
  files: Array<{ path: string; content: string }>;
  choices?: string[];
}

export const SHOW_CHART_DESCRIPTION = `Put a chart in the chat for the student: a card drawn from numbers they gave you or that run_go measured. \`kind\` is line, bar or scatter. \`series\` is a list of { name, points }: a point is a number (its x is its position in the list) or a pair [x, y]. Label both axes and give units (x_label, y_label, x_unit, y_unit). A bar chart takes \`categories\`, the name of each bar. In \`note\` say what the numbers are and where they came from.

WHEN TO CALL:
- Their load-test results, a measurement from run_go, numbers they pasted: a picture shows how they compare, and what changes with what

NOT:
- Numbers you made up, or remember from somewhere: never draw those
- The structure of a system or a flow of messages (render_diagram for a structure, show_trace for messages in order)
- Homework answers

THE RESULT is the system's own words: that the card is in the chat, or the first thing wrong (fix it and call again, or say it in words). The student sees the chart: do not list the numbers back; say in a sentence what to look at and ask what they notice. Not available in a scheduled task.`;

export const SHOW_TRACE_DESCRIPTION = `Put a sequence in the chat that the student steps through with Previous, Next and Play: who sends what to whom, in order (a leader election, a replication round, a request through a service). \`actors\` are the lanes (2 to 8 names); \`events\` are the steps in order, each { from, to?, label, note?, state? }: a message from \`from\` to \`to\`, or, with no \`to\`, something that happens at \`from\`; \`state\` is what actors hold after the step: [{ actor, text }] (for example "term 2, voted for B"). At most 120 steps, one short label each.

WHEN TO CALL:
- A picture of how something works helps more than describing it at length: draw it as a sequence INSTEAD of writing the steps out

NOT:
- The structure of a system (render_diagram), or a flow that is the solution to their homework
- Retelling the steps afterwards: they step through it themselves

THE RESULT is the system's own words: that the card is in the chat, or the first thing wrong (fix it and call again, or say it in words). Say in one sentence what to watch for, then ask a question about it. Not available in a scheduled task.`;

export const ASK_TO_PREDICT_DESCRIPTION = `Put a small Go program in the chat for the student to guess the output of BEFORE it runs. They pick or type a guess and press Run themselves: their press runs the program once in the sandbox, as one of their own runs, and you do not run it. You then get a note, in lines that open with [The student sees], with their guess and what it printed: set them side by side and ask what they make of it. \`action\` is run or test, \`files\` the program (a few lines, at most six small files), \`choices\` two to six options (optional).

WHEN TO CALL:
- A program of a few lines they have not seen answered yet that shows ONE thing (a data race, a deadlock, the order of deferred calls)

NOT:
- A solution to a graded assignment, or code the student wrote (run_go runs theirs)
- Telling them what it prints, or hinting: wait for their guess
- Running the card's program yourself with run_go: that spends one of their runs and skips "predict first"
- Anything the sandbox does not run (Go only, no network, 20 seconds)

THE RESULT is the system's own words: that the card is in the chat, or the first thing wrong (fix it and call again). Not available in a scheduled task.`;

export const CHAT_CARD_NOT_IN_TASK = 'A card cannot be made from a scheduled task: it needs the student in the conversation to look at it with you. Say so, and carry on without it.';
export const CHAT_CARD_NOT_IN_CALL = 'This tool is for the text chat. During a voice call the call has its own show_chart, show_trace and ask_to_predict functions: use those.';
export const CHAT_CARD_UNCONFIRMED = `The request was sent, but the system did not confirm it within ${CHAT_CARDS_NUMBERS.requestWaitMs / 1000} seconds, so the card may or may not be in the chat. Say so honestly, and do not send it again at once.`;
export const CHAT_CARD_UNREADABLE = 'The system answered, but I could not read its answer, so the card may or may not be in the chat. Say so honestly.';
export const CHAT_CARD_NOT_SENT = 'The request could not be sent (the system\'s request folder did not take it). Say so in one short sentence and go on without it.';

export interface ChatCardContext {
  /** The container was started by the scheduler (NANOCLAW_IS_SCHEDULED_TASK): a task an agent scheduled and the host's own tasks alike. */
  scheduled: boolean;
  /** This is a voice call's tool host (TAI_MODE=tool-host): the call has its own functions, host code. */
  toolHost?: boolean;
  /** Counts a use against the per-conversation limit (tool-limits.ts): null while within it, else the refusal. */
  limit: () => string | null;
  /** Writes a request file into /workspace/ipc/tasks. */
  writeTask: (data: Record<string, unknown>) => void;
  /** /workspace/ipc/results */
  resultsDir: string;
  /** Tests: the clock and the way of waiting. */
  wait?: Pick<WaitOptions, 'now' | 'sleep' | 'pollMs'>;
}

const say = (text: string, isError = false): ToolReply => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });

/**
 * One call of one of the tools. In a scheduled task or a tool host it refuses at once (nothing is written, nothing is counted); otherwise it counts the use, sends `{type: 'chat_object', requestId, request:
 * {kind, args}}` with the model's arguments untouched, waits for the host's answer and relays its text: a card that was not made (the host's `ok: false`) is an error result, with the host's sentence.
 */
export async function makeCard(kind: CardKind, args: ShowChartArgs | ShowTraceArgs | AskToPredictArgs, ctx: ChatCardContext): Promise<ToolReply> {
  if (ctx.toolHost) return say(CHAT_CARD_NOT_IN_CALL, true);
  if (ctx.scheduled) return say(CHAT_CARD_NOT_IN_TASK, true);
  const refused = ctx.limit();
  if (refused) return say(refused, true);
  const requestId = newRequestId();
  try {
    ctx.writeTask({ type: 'chat_object', requestId, request: { kind, args }, timestamp: new Date().toISOString() });
  } catch {
    return say(CHAT_CARD_NOT_SENT, true);
  }
  const result = await awaitIpcResult(ctx.resultsDir, requestId, {
    timeoutMs: CHAT_CARDS_NUMBERS.requestWaitMs,
    maxMessageChars: CHAT_CARDS_NUMBERS.answerChars,
    unreadable: CHAT_CARD_UNREADABLE,
    ...ctx.wait,
  });
  if (!result) return say(CHAT_CARD_UNCONFIRMED);
  return say(result.message, !result.ok);
}

export const showChart = (args: ShowChartArgs, ctx: ChatCardContext): Promise<ToolReply> => makeCard('chart', args, ctx);
export const showTrace = (args: ShowTraceArgs, ctx: ChatCardContext): Promise<ToolReply> => makeCard('trace', args, ctx);
export const askToPredict = (args: AskToPredictArgs, ctx: ChatCardContext): Promise<ToolReply> => makeCard('predict', args, ctx);
