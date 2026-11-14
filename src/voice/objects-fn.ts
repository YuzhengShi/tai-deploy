/**
 * show_chart, show_trace and ask_to_predict for a call (docs/CARDS.md, docs/CHAT_OBJECTS.md section 5): host functions in the conversation, no tool host and no container. Each builds the raw object from the
 * model's arguments (src/chat-objects: `chartFromArgs`, `traceFromArgs`, `predictFromArgs`, the same builders the text agent's verb uses), passes it through the history's one gate (`cleanObject`) and, when it is
 * accepted, puts the card in the student's chat with `env.postObject`. A refusal answers with the first thing wrong (`whyNotChart`, `whyNotTrace`, `whyNotPredict`) so that the model can fix it, and leaves no card.
 *
 * The answer to a card that was made says "A card for it is in the chat now." in the words show_document uses: the claim guard looks for "in the chat now" in a function's result (session.ts counts the answer as
 * something that went to the chat), and a sentence of TAi's that says the card is in the chat is let through only after one. It is said only when `postObject` did not throw.
 *
 * The interviewer and the talk-through have none of the three (functions.ts dispatch and session.ts allowed() refuse them). A call may make `CARDS` of each, counted next to the viewer's state (the session
 * keeps it across function calls; this env is made again for every one). Nothing here throws: a failure is an answer the model can say in a sentence.
 */
import { chartDropped, chartFromArgs, whyNotChart } from '../chat-objects/chart.js';
import { cleanObject, objectSummary } from '../chat-objects/clean.js';
import { predictDropped, predictFromArgs, whyNotPredict } from '../chat-objects/predict.js';
import { traceDropped, traceFromArgs, whyNotTrace } from '../chat-objects/trace.js';
import type { ChatObject } from '../chat-objects/types.js';
import type { FunctionDef, FunctionEnv } from './functions.js';

/** What one call may put in the chat of each kind (each a bound with a test). */
export const CARDS = { maxCharts: 5, maxTraces: 6, maxPredictions: 4 } as const;

export type CardKind = 'chart' | 'trace' | 'predict';

/** The function names, and the kind each makes: the session counts an answer of these as a send to the chat (session.ts). */
export const CARD_KINDS: Readonly<Record<string, CardKind>> = { show_chart: 'chart', show_trace: 'trace', ask_to_predict: 'predict' };
export const CARD_FUNCTIONS: ReadonlySet<string> = new Set(Object.keys(CARD_KINDS));

// ---------------------------------------------------------------- the definitions (short on purpose: they go to the model with every turn; functions-cards.test.ts pins the sizes)

export const SHOW_CHART_DEF: FunctionDef = {
  name: 'show_chart',
  description:
    'Draw a chart in the chat from numbers the student gave you or that run_code measured (line, bar or scatter).\n\n' +
    'WHEN TO CALL:\n- Their load-test results or a measurement: a picture compares them better than saying them\n\n' +
    'WRONG PATTERN:\n- Numbers you made up or remember: never draw those; say in note what the numbers are and where they came from\n- Reading the numbers aloud; a structure or a flow of messages (show_trace, render_diagram)',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What it shows, in a few words' },
      kind: { type: 'string', enum: ['line', 'bar', 'scatter'] },
      x_label: { type: 'string' },
      y_label: { type: 'string' },
      x_unit: { type: 'string' },
      y_unit: { type: 'string' },
      categories: { type: 'array', items: { type: 'string' }, description: 'Bar chart: the name of each bar' },
      series: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, points: { type: 'array', description: 'Numbers (y; x is the position) or [x, y] pairs' } },
          required: ['name', 'points'],
        },
      },
      note: { type: 'string', description: 'What the numbers are and where they came from' },
    },
    required: ['title', 'kind', 'x_label', 'y_label', 'series'],
  },
  // a card in the chat is something the student sees: a turn that is not confirmed yet must not make one
  defer_until_eot: true,
};

export const SHOW_TRACE_DEF: FunctionDef = {
  name: 'show_trace',
  description:
    'Draw a step-by-step sequence in the chat that the student steps through: who sends what to whom, in order.\n\n' +
    'WHEN TO CALL:\n- A picture of how something works helps (an election, a replication round, a request through a service): draw it INSTEAD of describing it at length\n\n' +
    'WRONG PATTERN:\n- Retelling the steps aloud: say in one sentence what to watch for\n- A system\'s structure (render_diagram), or a flow that is a homework solution',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What it shows, in a few words' },
      actors: { type: 'array', items: { type: 'string' }, description: '2 to 8 short names, one lane each' },
      events: {
        type: 'array',
        description: 'The steps in order, at most 120: a message from one actor to another, or something at one actor (no to)',
        items: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            label: { type: 'string', description: 'A few words' },
            note: { type: 'string' },
            state: { type: 'array', description: 'What actors hold after this step', items: { type: 'object', properties: { actor: { type: 'string' }, text: { type: 'string' } } } },
          },
          required: ['from', 'label'],
        },
      },
      note: { type: 'string' },
    },
    required: ['title', 'actors', 'events'],
  },
  defer_until_eot: true,
};

export const ASK_TO_PREDICT_DEF: FunctionDef = {
  name: 'ask_to_predict',
  description:
    'Put a small Go program in the chat for the student to guess the output of BEFORE it runs. Their own press of Run runs it once (one of their runs); you then get a note with their guess and the output to set side by side.\n\n' +
    'WHEN TO CALL:\n- A few lines they have not seen answered, showing ONE thing (a race, a deadlock, defer order)\n\n' +
    'WRONG PATTERN:\n- A graded solution; telling them the output; running it yourself with run_code (it skips their guess)',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'What to guess, e.g. what does this print?' },
      action: { type: 'string', enum: ['run', 'test'] },
      pkg: { type: 'string', description: '. for run, ./... for test' },
      files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      choices: { type: 'array', items: { type: 'string' }, description: 'Two to six options, or none' },
    },
    required: ['question', 'action', 'files'],
  },
  defer_until_eot: true,
};

// ---------------------------------------------------------------- the functions

/** What a call has made of each kind. */
interface CardCounts {
  chart: number;
  trace: number;
  predict: number;
}
const counted = new WeakMap<object, CardCounts>();

const error = (message: string): string => JSON.stringify({ error: message });

const MAXIMUM: Record<CardKind, { most: number; word: string }> = {
  chart: { most: CARDS.maxCharts, word: 'charts' },
  trace: { most: CARDS.maxTraces, word: 'sequences' },
  predict: { most: CARDS.maxPredictions, word: 'prediction cards' },
};

const CARD = 'A card for it is in the chat now.';
const NOTES: Record<CardKind, string> = {
  chart: 'Say in one short sentence what to look at and ask what they notice. Never read the numbers aloud, and claim no more than the data shows.',
  trace: 'Say in one short sentence what to watch for, then let them step through it and ask a question about it. Never retell the steps aloud.',
  predict:
    'Ask them what they think it prints, in one short sentence, and wait: they guess in the chat and press Run themselves, which runs it once as one of their runs. You will then get a System note with their guess and the output: set them side by side and ask what they make of it. Never say what it prints, and never run it yourself with run_code.',
};

const BUILD: Record<CardKind, { from: (args: unknown) => Record<string, unknown>; why: (raw: unknown) => string | null; dropped: (raw: unknown, obj: ChatObject) => string }> = {
  chart: { from: chartFromArgs, why: whyNotChart, dropped: (raw, obj) => (obj.t === 'chart' ? chartDropped(raw, obj) : '') },
  trace: { from: traceFromArgs, why: whyNotTrace, dropped: (raw, obj) => (obj.t === 'trace' ? traceDropped(raw, obj) : '') },
  predict: { from: predictFromArgs, why: whyNotPredict, dropped: (raw, obj) => (obj.t === 'predict' ? predictDropped(raw, obj) : '') },
};

/**
 * Makes one card for the student of this call. `args` are the model's own arguments, untouched: the builder gives the raw object, `whyNot...` says what is wrong, and `cleanObject` is the gate whose
 * answer is what is put in the chat.
 */
export function showCard(kind: CardKind, args: unknown, env: FunctionEnv): string {
  try {
    const build = BUILD[kind];
    const raw = build.from(args);
    const why = build.why(raw);
    const obj = why === null ? cleanObject(raw) : null;
    if (!obj) return error(`${why ?? 'that card cannot be made'}: nothing was put in the chat. Fix it and call again, or say it in words.`);

    const key = env.screenState;
    const used = key ? (counted.get(key) ?? { chart: 0, trace: 0, predict: 0 }) : { chart: 0, trace: 0, predict: 0 };
    const limit = MAXIMUM[kind];
    if (used[kind] >= limit.most) return error(`this call has put ${limit.most} ${limit.word} in the chat already: say it in words instead`);
    if (!env.postObject) return error('the chat is not available for cards here: say it in words instead');
    try {
      env.postObject(obj);
    } catch (err) {
      env.log.warn({ folder: env.folder, kind, err: err instanceof Error ? err.message : String(err) }, 'voice: a card could not be put in the chat');
      return error('the chat did not take the card, so the student has not seen it: say so in one short sentence and say it in words instead');
    }
    used[kind]++;
    if (key) counted.set(key, used);
    env.log.info({ folder: env.folder, kind }, "voice: a card was put in the student's chat");
    const dropped = build.dropped(raw, obj);
    return JSON.stringify({ status: 'in the chat', card: CARD, what: objectSummary(obj), ...(dropped ? { left_out: dropped } : {}), voice_note: NOTES[kind] });
  } catch (err) {
    env.log.warn({ folder: env.folder, kind, err: err instanceof Error ? err.message : String(err) }, 'voice: a card failed');
    return error('that did not work; say so briefly and carry on');
  }
}

export const showChart = (args: unknown, env: FunctionEnv): string => showCard('chart', args, env);
export const showTrace = (args: unknown, env: FunctionEnv): string => showCard('trace', args, env);
export const askToPredict = (args: unknown, env: FunctionEnv): string => showCard('predict', args, env);
