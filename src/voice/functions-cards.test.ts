/**
 * The three card functions as the model is given them and as a call runs them (docs/CARDS.md): show_chart, show_trace and ask_to_predict. The names and arguments the brief fixes, which mode has them (the
 * conversation only), what they cost on every turn (the descriptions, the schemas and the section of the prompt are short on purpose, and the sizes are pinned), what the model is told in the prompt, how a call
 * runs them (host functions through the history's gate, a refusal that says what is wrong and leaves no card, a limit for each kind, "in the chat now" only when the card was written) and what the session makes of
 * the answer (a send to the chat, which the claim guard counts).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { CompetencyGuard } from './competency.js';
import { CALL_FUNCTIONS, LONG_WAIT_FUNCTIONS, PROMOTABLE_FUNCTIONS, SLOW_FUNCTIONS, TOOL_HOST_FUNCTIONS, functionsFor, runFunction } from './functions.js';
import type { FunctionDef, FunctionEnv } from './functions.js';
import { ASK_TO_PREDICT_DEF, CARDS, CARD_FUNCTIONS, CARD_KINDS, SHOW_CHART_DEF, SHOW_TRACE_DEF } from './objects-fn.js';
import { conversationalPrompt, interviewerPrompt, listenerPrompt } from './prompts.js';
import { newScreenState } from './screen.js';
import { SpeechGovernor } from './speech-governor.js';
import { Harness, createHarness } from './testing/harness.js';
import type { BrowserClient } from './testing/harness.js';
import type { FakeDeepgramConnection } from './testing/fake-deepgram.js';
import type { Caller, ChatExtra } from './types.js';

const NAMES = ['show_chart', 'show_trace', 'ask_to_predict'];
const find = (mode: 'conversational' | 'interviewer' | 'listener', name: string): FunctionDef | undefined => functionsFor(mode).find((f) => f.name === name);
const size = (f: FunctionDef) => JSON.stringify(f).length;

describe('the definitions', () => {
  it('have the names and arguments of the contract', () => {
    expect(Object.keys(find('conversational', 'show_chart')!.parameters.properties)).toEqual(['title', 'kind', 'x_label', 'y_label', 'x_unit', 'y_unit', 'categories', 'series', 'note']);
    expect(find('conversational', 'show_chart')!.parameters.required).toEqual(['title', 'kind', 'x_label', 'y_label', 'series']);
    expect((find('conversational', 'show_chart')!.parameters.properties.kind as { enum: string[] }).enum).toEqual(['line', 'bar', 'scatter']);
    expect(Object.keys(find('conversational', 'show_trace')!.parameters.properties)).toEqual(['title', 'actors', 'events', 'note']);
    expect(find('conversational', 'show_trace')!.parameters.required).toEqual(['title', 'actors', 'events']);
    const events = find('conversational', 'show_trace')!.parameters.properties.events as { items: { properties: Record<string, unknown>; required: string[] } };
    expect(Object.keys(events.items.properties)).toEqual(['from', 'to', 'label', 'note', 'state']);
    expect(events.items.required).toEqual(['from', 'label']);
    expect(Object.keys(find('conversational', 'ask_to_predict')!.parameters.properties)).toEqual(['question', 'action', 'pkg', 'files', 'choices']);
    expect(find('conversational', 'ask_to_predict')!.parameters.required).toEqual(['question', 'action', 'files']);
    expect((find('conversational', 'ask_to_predict')!.parameters.properties.action as { enum: string[] }).enum).toEqual(['run', 'test']);
  });

  it('are the conversation\'s alone: none in the interview, none in the talk-through', () => {
    expect(functionsFor('conversational').map((f) => f.name).filter((n) => NAMES.includes(n))).toEqual(NAMES);
    expect(functionsFor('interviewer').map((f) => f.name).filter((n) => NAMES.includes(n))).toEqual([]);
    expect(functionsFor('listener').map((f) => f.name).filter((n) => NAMES.includes(n))).toEqual([]);
  });

  it('are written like the others: WHEN TO CALL, and what is wrong to do, in at most 450 characters, and they wait for the turn to be confirmed', () => {
    for (const name of NAMES) {
      const f = find('conversational', name)!;
      expect(f.description).toContain('WHEN TO CALL:');
      expect(f.description).toContain('WRONG PATTERN:');
      expect(f.description.length).toBeLessThanOrEqual(450);
      // a card is something the student sees: a speculative end of turn must not make one
      expect(f.defer_until_eot).toBe(true);
    }
  });

  it('tell the model the rules: numbers it was given or measured, a sequence instead of a long description, a program they have not seen, never a graded solution', () => {
    expect(SHOW_CHART_DEF.description).toMatch(/numbers the student gave you or that run_code measured/);
    expect(SHOW_CHART_DEF.description).toMatch(/Numbers you made up or remember: never draw those/);
    expect(SHOW_CHART_DEF.description).toMatch(/say in note what the numbers are and where they came from/);
    expect(SHOW_TRACE_DEF.description).toMatch(/INSTEAD of describing it at length/);
    expect(SHOW_TRACE_DEF.description).toMatch(/render_diagram/);
    expect(ASK_TO_PREDICT_DEF.description).toMatch(/BEFORE it runs/);
    expect(ASK_TO_PREDICT_DEF.description).toMatch(/have not seen answered/);
    expect(ASK_TO_PREDICT_DEF.description).toMatch(/A graded solution/);
    expect(ASK_TO_PREDICT_DEF.description).toMatch(/Their own press of Run runs it once \(one of their runs\)/);
    expect(ASK_TO_PREDICT_DEF.description).toMatch(/you then get a note with their guess and the output to set side by side/);
    expect(ASK_TO_PREDICT_DEF.description).toMatch(/running it yourself with run_code \(it skips their guess\)/);
  });

  it('cost what is pinned on every turn of a conversation, and use no schema form a model API may not take', () => {
    expect(size(SHOW_CHART_DEF)).toBeLessThanOrEqual(1_300);
    expect(size(SHOW_TRACE_DEF)).toBeLessThanOrEqual(1_350);
    expect(size(ASK_TO_PREDICT_DEF)).toBeLessThanOrEqual(1_060);
    expect(NAMES.reduce((n, name) => n + size(find('conversational', name)!), 0)).toBeLessThanOrEqual(3_600);
    for (const f of [SHOW_CHART_DEF, SHOW_TRACE_DEF, ASK_TO_PREDICT_DEF]) expect(JSON.stringify(f.parameters)).not.toMatch(/oneOf|anyOf|allOf|prefixItems|\$ref/);
  });
});

describe('how a call runs them', () => {
  it('are host functions: not the tool host\'s, not answered for now, not the call\'s own, no filler (they answer at once)', () => {
    for (const name of NAMES) {
      expect(TOOL_HOST_FUNCTIONS.has(name)).toBe(false);
      expect(PROMOTABLE_FUNCTIONS.has(name)).toBe(false);
      expect(CALL_FUNCTIONS.has(name)).toBe(false);
      expect(SLOW_FUNCTIONS.has(name)).toBe(false);
      expect(LONG_WAIT_FUNCTIONS.has(name)).toBe(false);
    }
    expect([...CARD_FUNCTIONS].sort()).toEqual([...NAMES].sort());
    expect(CARD_KINDS).toEqual({ show_chart: 'chart', show_trace: 'trace', ask_to_predict: 'predict' });
  });

  it('are not spoken when the model names one in a sentence (it is thinking about its tools, not talking)', () => {
    for (const name of NAMES) {
      const governor = new SpeechGovernor();
      const out = governor.push(`I will call ${name} now. The leader needs a majority.`) + governor.end();
      expect(out).not.toContain(name);
      expect(out).toContain('The leader needs a majority.');
    }
  });
});

describe('what the prompts say', () => {
  const person = { studentName: 'Ada Lovelace', firstName: 'Ada', today: 'Monday, November 2, 2026' };
  const ctx = { competencySummary: 'Raft: confidence 0.4', competencyText: null, memories: [], work: [], recentChat: [], courseStatus: '' };
  const ic = { studentName: 'Ada', assignmentId: '1', assignmentName: 'HW3 Concurrency', assignmentSpec: 'Build an order service in Go.', submissionText: '', codeExcerpts: '', lectureContent: '', weakConcepts: [], verbalGaps: [], misconceptions: [], source: 'file' as const, week: null };
  const section = () => {
    const prompt = conversationalPrompt(person, ctx);
    const from = prompt.indexOf('## CHARTS, SEQUENCES AND PREDICTIONS');
    return prompt.slice(from, prompt.indexOf('## THE VIEWER'));
  };

  it('has a short section in the conversation, before the viewer\'s: a sequence instead of describing at length, a chart only of numbers it was given, a prediction only of a program not seen', () => {
    const prompt = conversationalPrompt(person, ctx);
    expect(prompt.indexOf('## CHARTS, SEQUENCES AND PREDICTIONS')).toBeGreaterThan(prompt.indexOf('## THE CHAT ON THIS PAGE'));
    expect(prompt.indexOf('## CHARTS, SEQUENCES AND PREDICTIONS')).toBeLessThan(prompt.indexOf('## THE VIEWER'));
    const text = section();
    for (const part of ['show_trace INSTEAD of describing it at length', 'render_diagram is for structure', 'show_chart only for numbers they gave you or run_code measured', 'never numbers you made up', 'say what the numbers are', 'ask_to_predict only for a small program they have not seen answered yet', 'they guess before it runs', 'their own press of Run runs it', 'never run it yourself with run_code', 'never a graded solution', 'Never read a card aloud']) expect(text).toContain(part);
    expect(text.length).toBeLessThanOrEqual(850);
  });

  it('leaves the viewer\'s own section alone (its test slices from its heading to the background)', () => {
    const prompt = conversationalPrompt(person, ctx);
    const viewer = prompt.slice(prompt.indexOf('## THE VIEWER'), prompt.indexOf('## BACKGROUND ABOUT THEM'));
    expect(viewer).not.toContain('show_chart');
    expect(viewer.length).toBeLessThanOrEqual(1_100);      // (it grew from 560 when the page they have open was put first: functions-screen.test.ts holds its words)
  });

  it('lets the model say that a card is in the chat once any of these has returned', () => {
    const rule = conversationalPrompt(person, ctx).split('\n').find((l) => l.startsWith('10. '))!;
    for (const name of ['send_to_chat', 'render_diagram', 'show_document', 'show_chart', 'show_trace', 'ask_to_predict']) expect(rule).toContain(name);
  });

  it('says nothing in the interview and the talk-through: none of the three is theirs', () => {
    const interview = interviewerPrompt(person, ic as never, 15, null, { nonce: 'n0nce' });
    const talk = listenerPrompt(person, ctx, 'Raft', 10);
    for (const name of [...NAMES, 'CHARTS, SEQUENCES']) {
      expect(interview).not.toContain(name);
      expect(talk).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------- the functions

const MAIN = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n';
const chartArgs = { title: 'p99 latency by threads', kind: 'line', x_label: 'threads', y_label: 'latency', y_unit: 'ms', series: [{ name: 'gin', points: [[1, 12], [2, 15.5], [4, 31]] }], note: 'measured with run_code' };
const traceArgs = { title: 'Raft election', actors: ['A', 'B', 'C'], events: [{ from: 'A', label: 'election timeout' }, { from: 'A', to: 'B', label: 'RequestVote', state: [{ actor: 'A', text: 'candidate, term 2' }] }] };
const predictArgs = { question: 'What does this print?', action: 'run', pkg: '.', files: [{ path: 'main.go', content: MAIN }], choices: ['hi', 'nothing'] };

function setup(over: Partial<FunctionEnv> = {}) {
  const cards: unknown[] = [];
  const warns: string[] = [];
  const screenState = newScreenState();
  const env = {
    folder: 's_ada',
    jid: 'web:ada',
    groupDir: '/nowhere/group',
    ipcDir: '/nowhere/ipc',
    today: '2026-11-07',
    now: () => 1_000_000,
    toolHost: async () => null,
    guard: new CompetencyGuard(),
    mode: 'conversational',
    postObject: (obj: unknown) => void cards.push(obj),
    screenState,
    log: { info: () => undefined, warn: (_f: unknown, m: string) => void warns.push(m), error: () => undefined, debug: () => undefined },
    ...over,
  } as unknown as FunctionEnv;
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(await runFunction(name, args, env));
  return { env, call, cards, warns };
}

describe('a card that is made', () => {
  it('is a chart: through the gate, in the chat, and the answer says it is there, what it is and what to do', async () => {
    const t = setup();
    const answer = await t.call('show_chart', chartArgs);
    expect(t.cards).toHaveLength(1);
    expect(t.cards[0]).toMatchObject({ t: 'chart', title: 'p99 latency by threads', kind: 'line', xLabel: 'threads', yLabel: 'latency', yUnit: 'ms', note: 'measured with run_code' });
    expect(answer.status).toBe('in the chat');
    expect(answer.card).toBe('A card for it is in the chat now.');
    expect(JSON.stringify(answer)).toMatch(/in the chat now/);
    expect(answer.what).toBe('Chart: p99 latency by threads (1 series)');
    expect(answer.voice_note).toMatch(/Never read the numbers aloud/);
    expect(answer.left_out).toBeUndefined();
  });

  it('is a sequence, and the model is told to let them step through it and not to retell the steps', async () => {
    const t = setup();
    const answer = await t.call('show_trace', traceArgs);
    expect(t.cards[0]).toMatchObject({ t: 'trace', actors: ['A', 'B', 'C'] });
    expect(answer.card).toMatch(/in the chat now/);
    expect(answer.what).toBe('Sequence: Raft election (2 steps)');
    expect(answer.voice_note).toMatch(/step through it/);
    expect(answer.voice_note).toMatch(/Never retell the steps aloud/);
  });

  it('is a prediction card, and the model is told not to say what it prints, and that it will be told the guess and the output', async () => {
    const t = setup();
    const answer = await t.call('ask_to_predict', predictArgs);
    expect(t.cards[0]).toMatchObject({ t: 'predict', action: 'run', pkg: '.', choices: ['hi', 'nothing'] });
    expect(answer.card).toMatch(/in the chat now/);
    expect(answer.voice_note).toMatch(/Never say what it prints, and never run it yourself with run_code/);
    expect(answer.voice_note).toMatch(/press Run themselves, which runs it once as one of their runs/);
    expect(answer.voice_note).toMatch(/System note with their guess and the output: set them side by side and ask what they make of it/);
  });

  it('says what the gate left out, so the model does not describe another card', async () => {
    const t = setup();
    expect((await t.call('show_chart', { ...chartArgs, series: [{ name: 'a', points: [1, 'x', 3] }] })).left_out).toMatch(/Left out of the chart: 0 of 1 series and 1 of 3 points/);
    expect((await t.call('show_trace', { ...traceArgs, events: [...traceArgs.events, { from: 'Z', label: 'lost' }] })).left_out).toMatch(/Left out of the trace: 1 of 3 steps/);
    expect((await t.call('ask_to_predict', { ...predictArgs, choices: ['only one'] })).left_out).toMatch(/options were not used/);
    expect(t.cards).toHaveLength(3);
  });

  it('is the object the gate gives: a field of the arguments that the type does not have, or a type the model names, is not taken', async () => {
    const t = setup();
    await t.call('show_chart', { ...chartArgs, t: 'doc', doc: 'a'.repeat(32), pages: 5, html: '<script>x</script>' });
    expect(Object.keys(t.cards[0] as object).sort()).toEqual(['kind', 'note', 'series', 't', 'title', 'xLabel', 'yLabel', 'yUnit']);
    expect((t.cards[0] as { t: string }).t).toBe('chart');
  });
});

describe('a card that is refused', () => {
  it('says the first thing wrong, in plain words, and leaves no card and no count', async () => {
    const t = setup();
    expect((await t.call('show_chart', { ...chartArgs, kind: 'pie' })).error).toMatch(/^kind is line, bar or scatter \(it was "pie"\): nothing was put in the chat\. Fix it and call again, or say it in words\.$/);
    expect((await t.call('show_trace', { ...traceArgs, events: [{ from: 'Z', label: 'x' }] })).error).toMatch(/^step 1: from is "Z", which is not one of the actors \(A, B, C\): nothing was put in the chat/);
    expect((await t.call('ask_to_predict', { ...predictArgs, files: [{ path: '../main.go', content: MAIN }] })).error).toMatch(/^the sandbox's check refused the program: /);
    expect(t.cards).toEqual([]);
    // refusals are not counted against the call's few cards
    for (let i = 0; i < CARDS.maxCharts + 3; i++) await t.call('show_chart', { ...chartArgs, kind: 'pie' });
    expect((await t.call('show_chart', chartArgs)).status).toBe('in the chat');
  });

  it('takes arguments that are not even an object, without throwing', async () => {
    const t = setup();
    for (const name of NAMES) {
      expect((await runFunction(name, {} as never, t.env)).length).toBeGreaterThan(0);
      expect(JSON.parse(await runFunction(name, {}, t.env)).error).toMatch(/nothing was put in the chat/);
    }
    expect(t.cards).toEqual([]);
  });

  it('is refused in the interview and the talk-through, which have none of the three', async () => {
    for (const mode of ['interviewer', 'listener'] as const) {
      const t = setup({ mode });
      for (const name of NAMES) expect((await t.call(name, chartArgs)).error).toBe(`${name} is not available here`);
      expect(t.cards).toEqual([]);
    }
  });
});

describe('what a call may make', () => {
  it('is a few of each kind, then it is said in words: the limits are the CARDS', async () => {
    expect(CARDS).toEqual({ maxCharts: 5, maxTraces: 6, maxPredictions: 4 });
    const t = setup();
    for (let i = 0; i < CARDS.maxCharts; i++) expect((await t.call('show_chart', chartArgs)).status).toBe('in the chat');
    expect((await t.call('show_chart', chartArgs)).error).toBe('this call has put 5 charts in the chat already: say it in words instead');
    for (let i = 0; i < CARDS.maxTraces; i++) expect((await t.call('show_trace', traceArgs)).status).toBe('in the chat');
    expect((await t.call('show_trace', traceArgs)).error).toBe('this call has put 6 sequences in the chat already: say it in words instead');
    for (let i = 0; i < CARDS.maxPredictions; i++) expect((await t.call('ask_to_predict', predictArgs)).status).toBe('in the chat');
    expect((await t.call('ask_to_predict', predictArgs)).error).toBe('this call has put 4 prediction cards in the chat already: say it in words instead');
    expect(t.cards).toHaveLength(CARDS.maxCharts + CARDS.maxTraces + CARDS.maxPredictions);
  });

  it('is counted for the call (its state), not for the function call, and not for another call', async () => {
    const a = setup();
    const b = setup();
    for (let i = 0; i < CARDS.maxCharts; i++) await a.call('show_chart', chartArgs);
    expect((await a.call('show_chart', chartArgs)).error).toBeDefined();
    expect((await b.call('show_chart', chartArgs)).status).toBe('in the chat');
  });
});

describe('a chat that does not take the card', () => {
  it('is told so, and the model is not told that the card is in the chat (the claim guard looks for those words)', async () => {
    const t = setup({
      postObject: () => {
        throw new Error('the history refused it');
      },
    });
    for (const [name, args] of [['show_chart', chartArgs], ['show_trace', traceArgs], ['ask_to_predict', predictArgs]] as const) {
      const answer = await t.call(name, args);
      expect(answer.error).toMatch(/the chat did not take the card, so the student has not seen it/);
      expect(JSON.stringify(answer)).not.toMatch(/in the chat now/);
    }
    expect(t.warns).toEqual(Array(3).fill('voice: a card could not be put in the chat'));
  });

  it('does not count the card that did not go, and says so when no chat is wired at all', async () => {
    let fail = true;
    const cards: unknown[] = [];
    const t = setup({
      postObject: (obj: unknown) => {
        if (fail) throw new Error('no');
        cards.push(obj);
      },
    });
    for (let i = 0; i < CARDS.maxCharts + 2; i++) await t.call('show_chart', chartArgs);
    fail = false;
    expect((await t.call('show_chart', chartArgs)).status).toBe('in the chat');
    const none = setup({ postObject: undefined });
    expect((await none.call('show_trace', traceArgs)).error).toMatch(/the chat is not available for cards here/);
  });
});

// ---------------------------------------------------------------- through the hub: the card in the chat, and what the session makes of the answer

describe('in a call', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  const until = async (check: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  async function startCall(harness: Harness, user: Caller, start: Record<string, unknown> = { type: 'start', mode: 'chat' }): Promise<{ browser: BrowserClient; conn: FakeDeepgramConnection }> {
    const browser = await harness.browser(user);
    browser.send(start);
    const conn = await harness.dg.connection(harness.dg.connections.length + 1);
    await browser.next('ready');
    return { browser, conn };
  }
  const ask = async (conn: FakeDeepgramConnection, id: string, name: string, args: Record<string, unknown> = {}): Promise<string> => {
    conn.callFunction(id, name, args);
    return String((await conn.waitFor('FunctionCallResponse', (m) => m.id === id)).content);
  };

  it('leaves each card in the student\'s chat as a line with the object, and the session counts the answer as a send to the chat', async () => {
    const chat: Array<{ folder: string; role: string; text: string; extra?: ChatExtra }> = [];
    const facts: string[][] = [];
    h = await createHarness({
      deps: {
        appendChat: (folder: string, role: 'user' | 'assistant', text: string, extra?: ChatExtra) => void chat.push({ folder, role, text, extra }),
        workFromCall: async (input: { facts: string[] }) => void facts.push(input.facts),
      },
    });
    const u = h.user(1);
    const { browser, conn } = await startCall(h, u);
    conn.userSays('can you show me how a Raft election goes?');
    const answer = JSON.parse(await ask(conn, 'f1', 'show_trace', traceArgs));
    expect(answer.card).toMatch(/in the chat now/);
    const cards = chat.filter((c) => c.extra?.kind === 'object');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ folder: u.folder, role: 'assistant', text: '' });
    expect(cards[0].extra!.obj).toMatchObject({ t: 'trace', title: 'Raft election' });
    // a refusal is no card and no send
    expect(JSON.parse(await ask(conn, 'f2', 'show_chart', { ...chartArgs, kind: 'pie' })).error).toMatch(/kind is line, bar or scatter/);
    expect(chat.filter((c) => c.extra?.kind === 'object')).toHaveLength(1);
    browser.send({ type: 'end' });
    conn.close(1000);
    await until(() => facts.length === 1);
    expect(facts[0][0]).toBe('TAi put 1 thing in the chat during the call');
  });

  it('is among the functions a conversation starts with in its Settings', async () => {
    h = await createHarness({});
    const u = h.user(1);
    const { conn } = await startCall(h, u);
    const settings = (await conn.waitFor('Settings')) as { agent: { think: { functions: Array<{ name: string }> } } };
    expect(settings.agent.think.functions.map((f) => f.name)).toEqual(expect.arrayContaining(NAMES));
  });
});
