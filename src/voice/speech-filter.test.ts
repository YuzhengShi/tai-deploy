import { describe, expect, it } from 'vitest';

import { SpeechFilter, SseSpeechTransform } from './speech-filter.js';

const TOOLS = new Set(['send_to_chat', 'update_competency', 'query_canvas']);

/** The text pushed in pieces of `size` characters, as a stream would bring it. */
function spoken(text: string, size = 3, tools: ReadonlySet<string> = TOOLS): { out: string; calls: SpeechFilter['calls'] } {
  const f = new SpeechFilter(tools);
  let out = '';
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  out += f.end();
  return { out, calls: f.calls };
}
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('what is not said aloud', () => {
  it('leaves a plain answer as it is, however it arrives', () => {
    const text = 'Homework 1a is due on September 14 at nine, and it is worth 100 points (3.5 percent). Does that help?';
    for (const size of [1, 2, 7, 500]) expect(spoken(text, size).out).toBe(text);
  });

  it('takes the Markdown marks out of an answer, and keeps its words', () => {
    expect(spoken('**Presenting a paper** (MapReduce) and `code` here, with *emphasis* and snake_case.').out).toBe('Presenting a paper (MapReduce) and code here, with emphasis and snake case.');
  });

  it('drops headings, quotes, bullets and list numbers at the start of a line, and only there', () => {
    const text = '# The plan\n1. First step\n2) Second step\n12. Twelfth\n- a dash bullet\n• a dot bullet\n> quoted\n-5 degrees and a well-known fact\n2026 was a year\n3.5 is a number';
    for (const size of [1, 2, 5]) {
      expect(spoken(text, size).out).toBe('The plan\nFirst step\nSecond step\nTwelfth\na dash bullet\na dot bullet\nquoted\n-5 degrees and a well-known fact\n2026 was a year\n3.5 is a number');
    }
  });

  it('turns symbols a speech engine would mangle into words, and drops pictographs', () => {
    expect(flat(spoken('≈ 2‑minute answer → fast, 3 × as many ≥ 2 🎯 Nice work 👍!', 500).out)).toBe('about 2-minute answer to fast, 3 times as many at least 2 Nice work !');
  });

  it('holds a number at the end of the stream as the text it is', () => {
    expect(spoken('Page\n2').out).toBe('Page\n2');
  });
});

describe('a function call written as text', () => {
  const call = '{"function":"update_competency","arguments":{"concept":"service discovery","confidence_delta":0.1,"notes":"a shared address book"}}';

  it('is not spoken, however the stream cuts it, and is kept as a call', () => {
    for (const size of [1, 2, 3, 11, 500]) {
      const r = spoken(`Think of a shared address book, what might it look like?${call}`, size);
      expect(r.out).toBe('Think of a shared address book, what might it look like?');
      expect(r.calls).toEqual([{ name: 'update_competency', arguments: '{"concept":"service discovery","confidence_delta":0.1,"notes":"a shared address book"}' }]);
    }
  });

  it('is found in each of the shapes models write it in', () => {
    const shapes = [
      '{"function":"send_to_chat","arguments":{"message":"hi"}}',
      '{"name":"send_to_chat","arguments":{"message":"hi"}}',
      '{"function":"send_to_chat","arguments":"{\\"message\\":\\"hi\\"}"}',
      '{"function":{"name":"send_to_chat","arguments":{"message":"hi"}}}',
    ];
    for (const shape of shapes) {
      const r = spoken(`Sure, I will.${shape}`);
      expect(r.out).toBe('Sure, I will.');
      expect(r.calls).toEqual([{ name: 'send_to_chat', arguments: '{"message":"hi"}' }]);
    }
  });

  it('may hold braces, quotes and Markdown in its text, and be long', () => {
    const message = 'Step {1}: say \\"hi\\" **now**\\n\\n' + 'x'.repeat(9000);
    const r = spoken(`Yes.{"function":"send_to_chat","arguments":{"message":"${message}"}} Done.`, 7);
    expect(r.out).toBe('Yes. Done.');
    expect(r.calls).toHaveLength(1);
    expect(JSON.parse(r.calls[0].arguments).message).toBe(`Step {1}: say "hi" **now**\n\n${'x'.repeat(9000)}`);
  });

  it('is dropped when it names a function the call does not have, and so is any other object', () => {
    expect(spoken('Ok.{"function":"delete_everything","arguments":{}}').calls).toEqual([]);
    expect(spoken('Ok.{"function":"delete_everything","arguments":{}}').out).toBe('Ok.');
    expect(spoken('Ok.{"a":1,"b":{"c":2}} Fine.').out).toBe('Ok. Fine.');
    expect(spoken('Ok.{"function":"send_to_chat","arguments":{"message":').out).toBe('Ok.'); // cut off in the middle
  });

  it('swallows an object too long to be a call to its end without speaking the rest of it', () => {
    const r = spoken(`Start.{"function":"send_to_chat","arguments":{"message":"${'y'.repeat(40_000)}"}} After.`, 1000);
    expect(r.out).toBe('Start. After.');
    expect(r.calls).toEqual([]);
  });

  it('is told from a brace in a sentence, which is spoken', () => {
    expect(spoken('Put the name in {name} here.').out).toBe('Put the name in name here.');
  });
});

describe('the stream', () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss', choices: [{ index: 0, delta, finish_reason: finish }] })}`;
  /** Every line through the transform, as the relay does it (a blank line after each event), then the end. */
  function run(lines: string[], names: ReadonlySet<string> = TOOLS) {
    const t = new SseSpeechTransform(names);
    const out: string[] = [];
    for (const l of lines) {
      out.push(...t.line(l));
      if (l.startsWith('data:')) out.push(...t.line(''));
    }
    out.push(...t.close());
    const events = out.filter((l) => l.startsWith('data:') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(5)));
    const choices = events.map((e) => e.choices[0]);
    return {
      text: choices.map((c) => c.delta.content ?? '').join(''),
      calls: choices.flatMap((c) => c.delta.tool_calls ?? []),
      finishes: choices.map((c) => c.finish_reason).filter(Boolean),
      out,
      t,
    };
  }

  it('passes a clean answer on untouched, line for line', () => {
    const lines = [chunk({ role: 'assistant', content: 'A leader ' }), chunk({ content: 'needs a majority.' }, 'stop'), 'data: [DONE]'];
    const r = run(lines);
    expect(r.text).toBe('A leader needs a majority.');
    expect(r.finishes).toEqual(['stop']);
    expect(r.out.filter((l) => l.startsWith('data:'))).toEqual(lines);
  });

  it('cleans what is said and keeps the role and the end of the answer', () => {
    const r = run([chunk({ role: 'assistant', content: '**Great**' }), chunk({ content: ' work 🎉' }), chunk({}, 'stop'), 'data: [DONE]']);
    expect(r.text).toBe('Great work ');
    expect(r.out.some((l) => l.includes('"role":"assistant"'))).toBe(true);
    expect(r.finishes).toEqual(['stop']);
  });

  it('turns a call written as text into a real tool call and ends with tool_calls', () => {
    const r = run([
      chunk({ role: 'assistant', content: 'Sure, I will put it in the chat.{"function":"send_to_' }),
      chunk({ content: 'chat","arguments":{"message":"Homework 1a: build a **Go** server"}}' }),
      chunk({}, 'stop'),
      'data: [DONE]',
    ]);
    expect(r.text).toBe('Sure, I will put it in the chat.');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ index: 0, type: 'function', function: { name: 'send_to_chat', arguments: '{"message":"Homework 1a: build a **Go** server"}' } });
    expect(r.calls[0].id).toMatch(/^call_/);
    expect(r.finishes).toEqual(['tool_calls']);
    expect(r.t.textCalls).toHaveLength(1);
    expect(r.t.madeCalls).toBe(false);
  });

  it('does the same when the end of the answer comes in the same chunk as its last words', () => {
    const r = run([chunk({ role: 'assistant', content: 'Done.{"function":"query_canvas","arguments":{"action":"upcoming"}}' }, 'stop'), 'data: [DONE]']);
    expect(r.text).toBe('Done.');
    expect(r.calls[0].function.name).toBe('query_canvas');
    expect(r.finishes).toEqual(['tool_calls']);
  });

  it('sends the calls when the stream ends without a finish chunk', () => {
    const r = run([chunk({ role: 'assistant', content: 'Ok.{"function":"query_canvas","arguments":{}}' }), 'data: [DONE]']);
    expect(r.calls).toHaveLength(1);
    expect(r.finishes).toEqual(['tool_calls']);
    expect(r.out.filter((l) => l.startsWith('data:')).pop()).toBe('data: [DONE]');
  });

  it('leaves a real call alone and drops the same call written as text beside it', () => {
    const real = { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'query_canvas', arguments: '{"action":"upcoming"}' } }] };
    const r = run([chunk({ role: 'assistant', content: 'One moment.{"function":"query_canvas","arguments":{"action":"upcoming"}}' }), chunk(real), chunk({}, 'tool_calls'), 'data: [DONE]']);
    expect(r.text).toBe('One moment.');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].id).toBe('call_1');
    expect(r.finishes).toEqual(['tool_calls']);
    expect(r.t.madeCalls).toBe(true);
  });

  it('keeps what the model sent, for the diagnostic', () => {
    const r = run([chunk({ role: 'assistant', content: '**Hi**{"function":"query_canvas","arguments":{}}' }), chunk({}, 'stop'), 'data: [DONE]']);
    expect(r.t.rawContent).toBe('**Hi**{"function":"query_canvas","arguments":{}}');
    expect(r.t.spoken).toBe('Hi');
    expect(r.t.finishReason).toBe('stop');
  });

  it('lets lines that are not data, and data that is not a chunk, through', () => {
    const t = new SseSpeechTransform(TOOLS);
    expect(t.line(': keep-alive')).toEqual([': keep-alive']);
    expect(t.line('data: not json')).toEqual(['data: not json']);
    expect(t.line('data: {"usage":{"total_tokens":3}}')).toEqual(['data: {"usage":{"total_tokens":3}}']);
    expect(t.line('data: {"choices":[]}')).toEqual(['data: {"choices":[]}']);
  });
});
