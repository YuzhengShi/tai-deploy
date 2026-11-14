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
    h.addToolResult('c1', '{}');                                     // (a request is only made with the reply in: a call with no reply is repaired away, see below)
    expect(h.toMessages()[1]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] });
    expect(h.toMessages()[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
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

  it('a line said while the calls run (a filler) goes into the words of the message that holds them, and the replies still follow it directly', () => {
    const h = new LabHistory();
    h.addUser('What did I ask before?');
    h.addAssistant('Let me check.');
    h.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'recall_memory', arguments: '{}' } }]);
    h.addAssistant('One sec.');                       // the filler, while the function runs
    h.addToolResult('c1', '{"found":"Raft"}');
    h.addAssistant('You asked about Raft.');
    expect(h.toMessages()).toEqual([
      { role: 'user', content: 'What did I ask before?' },
      { role: 'assistant', content: 'Let me check. One sec.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'recall_memory', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"found":"Raft"}' },
      { role: 'assistant', content: 'You asked about Raft.' },
    ]);
    expect(h.takeRepairs()).toBe(0);
  });

  it('a filler between a call with no words and its reply makes the words of the call message', () => {
    const h = new LabHistory();
    h.addUser('Check my memory.');
    h.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'recall_memory', arguments: '{}' } }]);
    h.addAssistant('One sec.');
    h.addToolResult('c1', 'ok');
    const m = h.toMessages();
    expect(m[1]).toMatchObject({ role: 'assistant', content: 'One sec.' });
    expect(m[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
    expect(h.takeRepairs()).toBe(0);
  });

  it('repairs a request whose calls have no replies, or whose replies have no calls (a model refuses such a conversation for the rest of the call), and counts it', () => {
    const h = new LabHistory();
    h.addUser('q');
    h.addAssistant('Let me look.');
    h.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }]);
    h.addToolResult('c1', 'only the first answered');
    h.addUser('and then');                            // the student spoke before the second came back, and nothing dropped the calls
    h.addToolResult('orphan', 'a reply nobody asked for');
    expect(h.toMessages()).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'Let me look.' },
      { role: 'user', content: 'and then' },
    ]);
    expect(h.takeRepairs()).toBeGreaterThanOrEqual(2);
    expect(h.takeRepairs()).toBe(0);
    // a call with no words and no reply goes altogether
    const g = new LabHistory();
    g.addUser('q');
    g.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }]);
    g.addUser('again');
    expect(g.toMessages()).toEqual([{ role: 'user', content: 'q' }, { role: 'user', content: 'again' }]);
    expect(g.takeRepairs()).toBe(1);
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

describe('LabHistory: the revision and the conversation of an eager request', () => {
  it('the revision changes with every write to the conversation and with nothing else', () => {
    const h = new LabHistory();
    const seen = [h.revision];
    const bump = (write: () => void): void => {
      write();
      seen.push(h.revision);
    };
    bump(() => h.setPrompt('You are TAi.'));
    bump(() => h.addUser('What is a mutex?'));
    bump(() => h.addAssistant('A lock.'));
    bump(() => h.addSystemNote('Be brief.'));
    bump(() => h.addToolCalls([{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }]));
    bump(() => h.addToolResult('c1', 'ok'));
    bump(() => h.cutTail('A lock.', 'A'));
    bump(() => h.dropUnansweredToolCalls());
    bump(() => h.loadContext([{ role: 'user', content: 'earlier' }]));
    expect(new Set(seen).size).toBe(seen.length);                       // every write moved it
    const before = h.revision;
    h.toMessages();
    h.messagesWithUser('anything');
    h.takeRepairs();
    expect(h.revision).toBe(before);                                    // reading does not
  });

  it('messagesWithUser is the conversation with the student\'s words as addUser would put them in, and writes nothing', () => {
    const h = new LabHistory();
    h.setPrompt('You are TAi.');
    h.addAssistant('Hi.');
    const before = h.toMessages();
    expect(h.messagesWithUser('What is a mutex?')).toEqual([...before, { role: 'user', content: 'What is a mutex?' }]);
    expect(h.toMessages()).toEqual(before);
    // an unanswered line of the student's and the new words are one message, as addUser joins them
    h.addUser('Tell me about Raft.');
    expect(h.messagesWithUser('And about Paxos too?').slice(-1)).toEqual([{ role: 'user', content: 'Tell me about Raft. And about Paxos too?' }]);
    expect(h.toMessages().slice(-1)).toEqual([{ role: 'user', content: 'Tell me about Raft.' }]);
    const joined = new LabHistory();
    joined.addUser('Tell me about Raft.');
    joined.addUser('And about Paxos too?');
    expect(h.messagesWithUser('And about Paxos too?').slice(-1)).toEqual(joined.toMessages().slice(-1));
    expect(h.messagesWithUser('   ')).toEqual(h.toMessages());
  });
});
