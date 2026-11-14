import { describe, expect, it } from 'vitest';

import { LabHistory } from './history.js';

describe('LabHistory', () => {
  it('puts the prompt first and merges consecutive lines of one role', () => {
    const h = new LabHistory();
    h.setPrompt('You are TAi.');
    h.addAssistant('Hi, it is TAi.');
    h.addAssistant('What shall we do?');
    h.addUser('Raft');
    h.addUser('and Paxos');
    expect(h.toMessages()).toEqual([
      { role: 'system', content: 'You are TAi.' },
      { role: 'assistant', content: 'Hi, it is TAi. What shall we do?' },
      { role: 'user', content: 'Raft and Paxos' },
    ]);
    expect(h.endsWithUser).toBe(true);
  });

  it('turns the Settings\' context into messages: text lines, and function_calls items into a call with its reply', () => {
    const h = new LabHistory();
    h.loadContext([
      { type: 'History', function_calls: [{ id: 'ctx_competency', name: 'read_competency', client_side: true, arguments: '{}', response: 'Docker: 0.4' }] },
      { type: 'History', role: 'user', content: 'hello' },
      { type: 'History', role: 'assistant', content: '' },
    ]);
    expect(h.toMessages()).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'ctx_competency', type: 'function', function: { name: 'read_competency', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'ctx_competency', content: 'Docker: 0.4' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('an UpdatePrompt is a system message at that point; an UpdateThink replaces only the first prompt', () => {
    const h = new LabHistory();
    h.setPrompt('first');
    h.addUser('hi');
    h.addSystemNote('Be brief.');
    h.setPrompt('second');
    expect(h.toMessages().map((m) => [m.role, m.content])).toEqual([['system', 'second'], ['user', 'hi'], ['system', 'Be brief.']]);
  });

  it('a call goes on the assistant message that holds the words before it, and its reply follows', () => {
    const h = new LabHistory();
    h.addUser('is there a slide on Raft?');
    h.addAssistant('Let me check.');
    h.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'find_course_document', arguments: '{"q":"raft"}' } }]);
    h.addToolResult('c1', '{"found":1}');
    h.addAssistant('Yes, page 9.');
    const m = h.toMessages();
    expect(m).toHaveLength(4);
    expect(m[1]).toMatchObject({ role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'c1' }] });
    expect(m[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(m[3]).toEqual({ role: 'assistant', content: 'Yes, page 9.' });
  });

  it('a call with no words before it gets an empty assistant message', () => {
    const h = new LabHistory();
    h.addUser('hi');
    h.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'recall_memory', arguments: '{}' } }]);
    expect(h.toMessages()[1]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] });
  });

  it('calls without replies are taken out, and what was said before them stays', () => {
    const h = new LabHistory();
    h.addUser('check Canvas');
    h.addAssistant('One sec.');
    h.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'query_canvas', arguments: '{}' } }]);
    h.dropUnansweredToolCalls();
    expect(h.toMessages().slice(1)).toEqual([{ role: 'assistant', content: 'One sec.' }]);
    // and answered ones are left alone
    h.addToolCalls([{ id: 'c2', type: 'function', function: { name: 'query_canvas', arguments: '{}' } }]);
    h.addToolResult('c2', '{}');
    h.dropUnansweredToolCalls();
    expect(h.toMessages().some((m) => m.role === 'tool')).toBe(true);
  });

  it('an interrupted answer is cut at its end to what was spoken; the lines before it in the message stay; a message left with no words goes', () => {
    const h = new LabHistory();
    h.addUser('explain Raft');
    h.addAssistant('One sec.');                                      // a filler said earlier in the turn
    h.addAssistant('Raft elects a leader.');
    h.addAssistant('Then the leader sends heartbeats.');
    h.cutTail('Raft elects a leader. Then the leader sends heartbeats.', 'Raft elects a leader. Then the');
    expect(h.lastAssistantText).toBe('One sec. Raft elects a leader. Then the');
    h.cutTail('Raft elects a leader. Then the', '');
    expect(h.lastAssistantText).toBe('One sec.');
    h.cutTail('One sec.', '');
    expect(h.toMessages()).toEqual([{ role: 'user', content: 'explain Raft' }]);
  });

  it('a cut leaves alone a message that does not end in what was added, and never reaches past the student words', () => {
    const h = new LabHistory();
    h.addUser('explain Raft');
    h.addAssistant('Raft elects a leader.');
    h.cutTail('Something else.', '');
    expect(h.lastAssistantText).toBe('Raft elects a leader.');
    h.addUser('wait');
    h.cutTail('Raft elects a leader.', '');
    expect(h.toMessages()).toEqual([{ role: 'user', content: 'explain Raft' }, { role: 'assistant', content: 'Raft elects a leader.' }, { role: 'user', content: 'wait' }]);
  });

  it('keeps a bounded conversation and starts it at a student turn', () => {
    const h = new LabHistory();
    for (let i = 0; i < 300; i++) {
      h.addUser(`question ${i}`);
      h.addAssistant(`answer ${i}`);
    }
    const m = h.toMessages();
    expect(m.length).toBeLessThanOrEqual(401);
    expect(m[0].role).toBe('user');
    expect(m[m.length - 1]).toEqual({ role: 'assistant', content: 'answer 299' });
  });
});
