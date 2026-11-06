import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompetencyGuard } from './competency.js';
import {
  CALL_FUNCTIONS,
  CONVERSATIONAL_FUNCTIONS,
  FunctionEnv,
  INTERVIEWER_FUNCTIONS,
  LISTENER_FUNCTIONS,
  PROMOTABLE_FUNCTIONS,
  RESULT_CAP,
  SLOW_FUNCTIONS,
  TOOL_HOST_FUNCTIONS,
  capResult,
  functionsFor,
  newCodeSeen,
  parseArgs,
  parseWhen,
  runFunction,
} from './functions.js';
import { FakeToolHost } from './tool-host.js';
import { silentLog } from './types.js';

let root: string;
let host: FakeToolHost | null;
let env: FunctionEnv;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-fn-'));
  fs.mkdirSync(path.join(root, 'groups', 's_x'), { recursive: true });
  host = new FakeToolHost();
  await host.start();
  env = {
    folder: 's_x',
    jid: 'web:s_x',
    githubUsername: 'ana-gh',
    groupDir: path.join(root, 'groups', 's_x'),
    ipcDir: path.join(root, 'data', 'ipc', 's_x'),
    today: '2026-11-01',
    now: () => new Date(2026, 10, 1, 14, 0, 0).getTime(),
    toolHost: async () => host,
    guard: new CompetencyGuard(),
    log: silentLog,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the function definitions', () => {
  it('are the sixteen, the five and the six of the contract, each with its WHEN TO CALL and a valid schema', () => {
    expect(CONVERSATIONAL_FUNCTIONS.map((f) => f.name)).toEqual([
      'query_knowledge', 'recall_memory', 'save_memory', 'read_competency', 'update_competency', 'query_canvas', 'query_github',
      'query_piazza', 'browse_url', 'read_file', 'render_diagram', 'send_to_chat', 'schedule_task', 'start_interview', 'start_talk_through', 'end_session',
    ]);
    expect(INTERVIEWER_FUNCTIONS.map((f) => f.name)).toEqual(['evaluate_answer', 'query_knowledge', 'read_competency', 'query_github', 'send_to_chat', 'end_interview']);
    // the listener checks facts, credits what was explained, remembers, and hands the call back: it cannot put anything in the chat
    expect(LISTENER_FUNCTIONS.map((f) => f.name)).toEqual(['query_knowledge', 'read_competency', 'update_competency', 'save_memory', 'end_talk_through', 'end_session']);
    expect(functionsFor('listener').map((f) => f.name)).toEqual(LISTENER_FUNCTIONS.map((f) => f.name));
    for (const f of [...CONVERSATIONAL_FUNCTIONS, ...INTERVIEWER_FUNCTIONS, ...LISTENER_FUNCTIONS]) {
      expect(f.description).toMatch(/WHEN TO CALL:/);
      expect(f.parameters.type).toBe('object');
      for (const r of f.parameters.required ?? []) expect(Object.keys(f.parameters.properties)).toContain(r);
      expect(f.description).not.toMatch(/whatsapp|youtube|sharepoint|generate_image/i);
    }
    expect([...SLOW_FUNCTIONS].sort()).toEqual(['start_interview']);
    // the two that switch the mode are the call's own and wait for the student's turn to be confirmed
    for (const name of ['start_talk_through', 'end_talk_through']) {
      expect(CALL_FUNCTIONS.has(name)).toBe(true);
      expect([...CONVERSATIONAL_FUNCTIONS, ...LISTENER_FUNCTIONS].find((f) => f.name === name)?.defer_until_eot).toBe(true);
    }
  });

  it('lets only look-ups be answered for now: nothing with an effect, nothing that changes the call', () => {
    expect([...PROMOTABLE_FUNCTIONS].sort()).toEqual(['browse_url', 'query_canvas', 'query_github', 'query_knowledge', 'query_piazza', 'read_file', 'recall_memory']);
    for (const name of PROMOTABLE_FUNCTIONS) {
      expect(CALL_FUNCTIONS.has(name)).toBe(false);
      expect(['send_to_chat', 'render_diagram', 'save_memory', 'update_competency', 'schedule_task']).not.toContain(name);
    }
    // the ones that go to the container are the ones that can run long
    for (const name of PROMOTABLE_FUNCTIONS) if (name !== 'recall_memory') expect(TOOL_HOST_FUNCTIONS.has(name)).toBe(true);
  });
});

describe('dispatch', () => {
  it('maps the voice functions onto the container tools with the right arguments', async () => {
    host!.handlers = {
      'leanrag:query_knowledge': () => ({ ok: true, text: 'Raft: leader election...' }),
      canvas_query: () => ({ ok: true, text: 'grades' }),
      github_query: () => ({ ok: true, text: 'repos' }),
      piazza_query: () => ({ ok: true, text: 'posts' }),
      memory_query: () => ({ ok: true, text: '[student_preference] analogies' }),
    };
    expect(await runFunction('query_knowledge', { question: 'raft?', difficulty: 'theme' }, env)).toBe('Raft: leader election...');
    expect(await runFunction('query_canvas', { action: 'grades' }, env)).toBe('grades');
    expect(await runFunction('query_github', { action: 'list_repos' }, env)).toBe('repos');
    expect(await runFunction('query_github', { action: 'file_content', repo: 'hw3', path: 'main.go' }, env)).toBe('repos');
    expect(await runFunction('query_piazza', { action: 'search', query: 'raft' }, env)).toBe('posts');
    expect(await runFunction('recall_memory', { query: 'learning style' }, env)).toContain('analogies');
    expect(await runFunction('save_memory', { content: 'likes analogies', decay_class: 'permanent' }, env)).toBe('Remembered.');
    expect(await runFunction('schedule_task', { description: 'check on raft', when: 'tomorrow 9am' }, env)).toBe('Scheduled for 2026-11-02 09:00.');
    const calls = host!.calls.map((c) => [c.server, c.tool, c.args]);
    expect(calls).toEqual([
      ['leanrag', 'query_knowledge', { question: 'raft?', difficulty: 'theme', top_k: 6 }],
      ['nanoclaw', 'canvas_query', { action: 'my_grades', params: {} }],
      ['nanoclaw', 'github_query', { action: 'list_repos', params: { user: 'ana-gh' } }],
      ['nanoclaw', 'github_query', { action: 'file_content', params: { owner: 'ana-gh', repo: 'hw3', path: 'main.go' } }],
      ['nanoclaw', 'piazza_query', { action: 'search', params: { query: 'raft' } }],
      ['nanoclaw', 'memory_query', { query: 'learning style', limit: 6 }],
    ]);
  });

  it('puts a message in the chat, a memory and a follow-up in files at once: none of them waits for the tool host (the first look-up does, for seconds)', async () => {
    let waited = false;
    env.toolHost = async () => {
      waited = true;
      return host;
    };
    expect(await runFunction('send_to_chat', { message: 'the steps' }, env)).toBe('It is in the chat now.');
    expect(await runFunction('save_memory', { content: 'likes analogies', decay_class: 'permanent' }, env)).toBe('Remembered.');
    expect(await runFunction('schedule_task', { description: 'check on raft', when: 'tomorrow 9am' }, env)).toBe('Scheduled for 2026-11-02 09:00.');
    expect(waited).toBe(false);
    expect(host!.calls).toHaveLength(0);
    const read = (sub: string) => fs.readdirSync(path.join(env.ipcDir, sub)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(env.ipcDir, sub, f), 'utf-8')));
    expect(read('messages')).toContainEqual(expect.objectContaining({ type: 'message', chatJid: 'web:s_x', text: 'the steps', groupFolder: 's_x' }));
    expect(read('tasks')).toHaveLength(1);
  });

  it('searches the memories itself while the tool host is not up yet, and asks the container once it is', async () => {
    fs.writeFileSync(path.join(env.groupDir, 'memory_store.json'), JSON.stringify({ memories: [{ text: 'gets Raft via elections', category: 'breakthrough', created_at: 1 }] }));
    host!.handlers = { memory_query: () => ({ ok: true, text: 'from the container' }) };
    env.toolHostNow = () => null;
    expect(await runFunction('recall_memory', { query: 'raft' }, env)).toContain('gets Raft via elections');
    expect(host!.calls).toHaveLength(0);
    env.toolHostNow = () => host;
    expect(await runFunction('recall_memory', { query: 'raft' }, env)).toBe('from the container');
  });

  describe('reading the course (the owner asked "why can\'t you read the PDF?")', () => {
    const FILES = JSON.stringify([
      { id: 4455, display_name: 'Week7_Raft_Slides.pdf', filename: 'Week7_Raft_Slides.pdf', size: 1_300_000, 'content-type': 'application/pdf', content_type: 'application/pdf', updated_at: '2026-10-20T10:00:00Z', url: 'https://northeastern.instructure.com/files/4455/download?download_frd=1&verifier=SECRETTOKEN' },
      { id: 7, display_name: 'Syllabus.pdf', filename: 'Syllabus.pdf', size: 90_000, content_type: 'application/pdf', url: 'https://northeastern.instructure.com/files/7/download?verifier=abc' },
    ]);
    const MODULES = JSON.stringify([
      {
        id: 1898085,
        name: 'Week 7: Consensus',
        items: [
          { title: 'Raft consensus slides', type: 'File', content_id: 4455, html_url: 'https://northeastern.instructure.com/courses/9/modules/items/1' },
          { title: 'Raft reading', type: 'Page', page_url: 'raft-reading', html_url: 'https://northeastern.instructure.com/courses/9/modules/items/2' },
          { title: 'Homework 7', type: 'Assignment', content_id: 3533300 },
        ],
      },
      { id: 2, name: 'Week 1', items: [{ title: 'Day 1 lecture', type: 'File', content_id: 99 }] },
    ]);
    const PAGES = JSON.stringify([{ url: 'raft-reading', title: 'Raft reading', updated_at: '2026-10-01T00:00:00Z' }, { url: 'office-hours', title: 'Office hours' }]);

    beforeEach(() => {
      host!.handlers = {
        canvas_query: (args) => {
          const action = (args as { action: string }).action;
          if (action === 'files') return { ok: true, text: FILES };
          if (action === 'modules') return { ok: true, text: MODULES };
          if (action === 'pages') return { ok: true, text: PAGES };
          if (action === 'file_content') return { ok: true, text: JSON.stringify({ display_name: 'Week7_Raft_Slides.pdf', content: 'Raft: a leader is elected by a majority of votes in a term.', truncated: false }) };
          if (action === 'page_detail') return { ok: true, text: JSON.stringify({ url: 'raft-reading', title: 'Raft reading', body: 'Read sections 5 and 6.' }) };
          if (action === 'assignments') return { ok: true, text: JSON.stringify([{ id: 3533222, name: 'Midterm Mastery Part 1' }, { id: 3533223, name: 'Midterm Mastery Part 2' }, { id: 3486457, name: "Homework 1a: Let's Get Going" }]) };
          if (action === 'assignment_detail') {
            return {
              ok: true,
              text: JSON.stringify({ id: 3533223, name: 'Midterm Mastery Part 2', due_at: '2026-11-02T17:00:00Z', points_possible: 0, submission_types: ['online_url'], description: '<p>Submit the <b>GitHub link</b> of your Raft lab.</p><p>Include a README.</p>', html_url: 'https://northeastern.instructure.com/courses/9/assignments/3533223', rubric_criteria: [{ description: 'The election works', points: 5 }] }),
            };
          }
          return { ok: true, text: '[]' };
        },
      };
    });

    it('finds the slides by words from their title across files, module items and pages, with the ids to read them', async () => {
      const out = await runFunction('query_canvas', { action: 'find', query: 'raft slides' }, env);
      expect(out).toContain('file_id=4455 "Week7_Raft_Slides.pdf"');
      expect(out).toContain('"Raft consensus slides" [File] file_id=4455');
      expect(out).toContain('"Raft reading" [Page] page_url=raft-reading');
      expect(out).not.toContain('Day 1 lecture');
      expect(out).not.toContain('SECRETTOKEN'); // the token in a download address is never shown to the model
      expect(await runFunction('query_canvas', { action: 'find', query: 'quantum computing' }, env)).toMatch(/Nothing in the course's files, modules, pages or assignments matches/);
      expect(await runFunction('query_canvas', { action: 'find' }, env)).toMatch(/needs query/);
    });

    it('finds the lecture material when all that is asked for is "slides": the titles say "lecture" and the day, never "slides"', async () => {
      for (const query of ['slides', 'the slides', 'can you see the slides', 'lecture pdf']) {
        const out = await runFunction('query_canvas', { action: 'find', query }, env);
        expect(out, query).toContain('file_id=4455 "Week7_Raft_Slides.pdf"');          // a deck, and any PDF
        expect(out, query).toContain('file_id=7 "Syllabus.pdf"');
        expect(out, query).toContain('"Day 1 lecture" [File] file_id=99');             // a module item that is a lecture
        expect(out, query).toContain('"Raft reading" [Page]');
        expect(out, query).not.toMatch(/Nothing in the course/);
      }
      // a request that names a topic is still a request for that topic
      const raft = await runFunction('query_canvas', { action: 'find', query: 'raft' }, env);
      expect(raft).not.toContain('Day 1 lecture');
    });

    it('finds an assignment by the words of its name, with the id to read it: "midterm mastery" is not in a file, a module or a page', async () => {
      const out = await runFunction('query_canvas', { action: 'find', query: 'midterm mastery' }, env);
      expect(out).toContain('Assignments (what one asks: assignment_detail with its assignment_id):');
      expect(out).toContain('assignment_id=3533222 "Midterm Mastery Part 1"');
      expect(out).toContain('assignment_id=3533223 "Midterm Mastery Part 2"');
      expect(out).not.toMatch(/Nothing in the course/);
      expect(await runFunction('query_canvas', { action: 'find', query: 'midterm' }, env)).toContain('assignment_id=3533223');
      // the assignments do not come with a request for the slides
      expect(await runFunction('query_canvas', { action: 'find', query: 'slides' }, env)).not.toContain('assignment_id');
    });

    it('tells the model, when a search finds nothing, to look in a module and not to tell the student there is nothing yet', async () => {
      const out = await runFunction('query_canvas', { action: 'find', query: 'quantum computing' }, env);
      expect(out).toMatch(/^Nothing in the course's files, modules, pages or assignments matches "quantum computing"/);
      expect(out).toContain('"Day1 lecture ONLINE 2026.pdf"');
      expect(out).toContain('Do not tell the student there is nothing yet');
      expect(out).toContain('module_items');
      expect(out).toContain('Week 7: Consensus');
      expect(out).not.toContain('finds nothing new');                                 // it used to say that asking again was useless
      const some = await runFunction('query_canvas', { action: 'find', query: 'raft' }, env);
      expect(some).not.toContain('do not ask find again');
      expect(some).toContain('find again with words from its title');
    });

    it('asks for the lists of the course once in fifteen minutes: a second find is not a second wait', async () => {
      env.cache = new Map();
      let now = 1_000_000;
      env.now = () => now;
      await runFunction('query_canvas', { action: 'find', query: 'raft' }, env);
      const asked = host!.calls.length;
      expect(asked).toBe(4); // files, modules, pages, assignments
      await runFunction('query_canvas', { action: 'find', query: 'syllabus' }, env);
      await runFunction('query_canvas', { action: 'files' }, env);
      expect(host!.calls).toHaveLength(asked);
      now += 14 * 60_000;                                                      // fourteen minutes into the call: still the lists asked for at the start
      await runFunction('query_canvas', { action: 'find', query: 'raft' }, env);
      expect(host!.calls).toHaveLength(asked);
      now += 2 * 60_000;                                                       // sixteen: asked again
      await runFunction('query_canvas', { action: 'find', query: 'raft' }, env);
      expect(host!.calls).toHaveLength(asked + 4);
    });

    it('reads a file, a page and a module with the ids a lookup gave', async () => {
      expect(await runFunction('query_canvas', { action: 'file_content', file_id: '4455' }, env)).toContain('a leader is elected by a majority');
      expect(await runFunction('query_canvas', { action: 'page_detail', page_url: 'https://northeastern.instructure.com/courses/9/pages/raft-reading?x=1' }, env)).toContain('Read sections 5 and 6.');
      await runFunction('query_canvas', { action: 'module_items', module_id: '1898085' }, env);
      const calls = host!.calls.map((c) => c.args);
      expect(calls).toContainEqual({ action: 'file_content', params: { file_id: '4455' } });
      expect(calls).toContainEqual({ action: 'page_detail', params: { page_url: 'raft-reading' } }); // the page's short name, not its address
      expect(calls).toContainEqual({ action: 'module_items', params: { module_id: '1898085' } });
      expect(await runFunction('query_canvas', { action: 'file_content', file_id: 'the raft pdf' }, env)).toMatch(/file_content needs file_id/);
      expect(await runFunction('query_canvas', { action: 'module_items' }, env)).toMatch(/module_items needs module_id/);
    });

    it('tells what an assignment says, in Pacific time and words, from its name (the model said "a short online quiz about Raft" of one whose description said nothing of the kind)', async () => {
      const out = await runFunction('query_canvas', { action: 'assignment_detail', assignment_id: 'midterm mastery part 2' }, env);
      expect(out).toContain('Assignment 3533223: Midterm Mastery Part 2');
      expect(out).toMatch(/Due: Mon, Nov 2, 9:00 AM PST \(in \d+ (?:hours?|days?)\)\./); // Pacific, with how far away it is (the test's clock is 2026-11-01 14:00 local)
      expect(out).toContain('Submit the GitHub link of your Raft lab.');
      expect(out).toContain('Rubric: The election works (5 points)');
      expect(out).not.toContain('<p>');
      expect(host!.calls.map((c) => c.args)).toContainEqual({ action: 'assignment_detail', params: { assignment_id: '3533223' } });
      // a name that fits none says which there are; one that is not a name is refused before anything is asked
      const none = JSON.parse(await runFunction('query_canvas', { action: 'assignment_detail', assignment_id: 'quantum' }, env)) as { error: string };
      expect(none.error).toMatch(/no assignment is called "quantum": the assignments are Midterm Mastery Part 1; Midterm Mastery Part 2/);
      const before = host!.calls.length;
      expect(await runFunction('query_canvas', { action: 'assignment_detail', assignment_id: '12; rm -rf' }, env)).toMatch(/assignment_id is the number/);
      expect(host!.calls).toHaveLength(before);
    });

    it('takes an assignment by its exact title when the title has a "?" or a "!" in it: "Homework 7: Cost savings?!" was refused 40 times in a day, and the model had to ask again with the number', async () => {
      const base = host!.handlers.canvas_query;
      host!.handlers = {
        canvas_query: (args) => {
          const action = (args as { action: string }).action;
          if (action === 'assignments') return { ok: true, text: JSON.stringify([{ id: 3540014, name: 'Homework 7: Cost savings?!' }, { id: 3533223, name: 'Midterm Mastery Part 2' }]) };
          if (action === 'assignment_detail') {
            return { ok: true, text: JSON.stringify({ id: 3540014, name: 'Homework 7: Cost savings?!', due_at: '2026-11-09T17:00:00Z', points_possible: 15, submission_types: ['online_text_entry'], description: '<p>Part 0 is the proposal.</p>', html_url: 'https://northeastern.instructure.com/courses/9/assignments/3540014' }) };
          }
          return base(args);
        },
      };
      const out = await runFunction('query_canvas', { action: 'assignment_detail', assignment_id: 'Homework 7: Cost savings?!' }, env);
      expect(out).toContain('Assignment 3540014: Homework 7: Cost savings?!');
      expect(out).not.toMatch(/assignment_id is the number/);
      expect(host!.calls.map((c) => c.args)).toContainEqual({ action: 'assignment_detail', params: { assignment_id: '3540014' } });
      // the typographic apostrophe and dash of a title are fine too; what is not a name is still refused before anything is asked
      for (const name of ['Don’t panic! Part 2', 'Lab 3 – Raft*']) expect(await runFunction('query_canvas', { action: 'assignment_detail', assignment_id: name }, env), name).toMatch(/^\{"error":"no assignment is called/);
      const before = host!.calls.length;
      for (const bad of ['12; rm -rf', '$(id)', 'a`b`', '1 | 2', 'x\ny', '<script>', '../../etc/passwd; x']) {
        expect(await runFunction('query_canvas', { action: 'assignment_detail', assignment_id: bad }, env), bad).toMatch(/assignment_id is the number/);
      }
      expect(host!.calls).toHaveLength(before);
    });

    it('lists the course files and modules short, with the ids and no tokens', async () => {
      const files = await runFunction('query_canvas', { action: 'files' }, env);
      expect(files).toContain('file_id=4455 "Week7_Raft_Slides.pdf" (application/pdf, 1.2 MB) link=https://northeastern.instructure.com/files/4455/download');
      expect(files).not.toContain('verifier');
      const modules = await runFunction('query_canvas', { action: 'modules' }, env);
      expect(modules).toContain('module_id=1898085 "Week 7: Consensus" (3 items: Raft consensus slides [File]; Raft reading [Page]; Homework 7 [Assignment])');
    });

    it('lets a link into the chat only if a lookup, the student or the course status gave it', async () => {
      env.urls = new Set(['https://example.com/from-the-status']);
      const refused = await runFunction('send_to_chat', { message: 'Here is the PDF: https://northeastern.instructure.com/courses/260797/files/xxxx/download' }, env);
      expect(refused).toMatch(/not sent: https:\/\/northeastern\.instructure\.com\/courses\/260797\/files\/xxxx\/download is not a link any lookup/);
      expect(fs.existsSync(path.join(env.ipcDir, 'messages'))).toBe(false); // nothing was written
      expect(await runFunction('send_to_chat', { message: 'From the status: https://example.com/from-the-status.' }, env)).toBe('It is in the chat now.');
      await runFunction('query_canvas', { action: 'find', query: 'raft' }, env); // the lookup's addresses are now seen
      expect(await runFunction('send_to_chat', { message: 'The slides: https://northeastern.instructure.com/files/4455/download' }, env)).toBe('It is in the chat now.');
      expect(await runFunction('send_to_chat', { message: 'No link at all, just words.' }, env)).toBe('It is in the chat now.');
    });
  });

  it('refuses bad arguments before anything reaches the container', async () => {
    expect(await runFunction('query_canvas', { action: 'grades_of_everyone' }, env)).toMatch(/action must be one of/);
    expect(await runFunction('query_canvas', { action: 'student_submission' }, env)).toMatch(/needs assignment_id/);
    expect(await runFunction('query_canvas', { action: 'assignment_detail', assignment_id: '12; rm' }, env)).toMatch(/assignment_id is the number/);
    expect(await runFunction('query_github', { action: 'file_content', repo: 'other/repo' }, env)).toMatch(/repository name only/);
    expect(await runFunction('query_github', { action: 'file_content', repo: 'hw3', path: '../../etc/passwd' }, env)).toMatch(/may not contain/);
    expect(await runFunction('browse_url', { url: 'file:///etc/passwd' }, env)).toMatch(/only http and https/);
    expect(await runFunction('read_file', { path: '../../.env' }, env)).toMatch(/give the file name/);
    expect(await runFunction('schedule_task', { description: 'x', when: 'whenever' }, env)).toMatch(/could not read that time/);
    expect(await runFunction('no_such_fn', {}, env)).toMatch(/there is no function/);
    expect(host!.calls).toHaveLength(0);
  });

  it('reads a file only from the uploads folder and fetches only http(s)', async () => {
    await runFunction('read_file', { path: '/workspace/group/uploads/main.go' }, env);
    await runFunction('read_file', { path: 'uploads\\report.pdf' }, env);
    await runFunction('browse_url', { url: 'https://raft.github.io/' }, env);
    expect(host!.calls.map((c) => [c.tool, c.args])).toEqual([
      ['read_file', { path: '/workspace/group/uploads/main.go' }],
      ['read_file', { path: '/workspace/group/uploads/report.pdf' }],
      ['web_fetch', { url: 'https://raft.github.io/' }],
    ]);
  });

  it('removes the flag that would swallow the text agent\'s next reply after a diagram or a message to the chat', async () => {
    const flag = path.join(env.ipcDir, 'messages', '.send_message_used');
    host!.handlers = {
      render_diagram: () => {
        fs.mkdirSync(path.dirname(flag), { recursive: true });
        fs.writeFileSync(flag, '');
        return { ok: true, text: 'Diagram sent.' };
      },
    };
    expect(await runFunction('render_diagram', { mermaid_code: 'graph TD; A-->B' }, env)).toBe('The diagram is in the chat now.');
    expect(host!.calls[0].args).toEqual({ mermaid_syntax: 'graph TD; A-->B', caption: 'A diagram from our call' });
    expect(fs.existsSync(flag)).toBe(false);
  });

  it('without a tool host: says what is unavailable, and writes the IPC files the orchestrator reads itself', async () => {
    env.toolHost = async () => null;
    expect(await runFunction('query_knowledge', { question: 'x' }, env)).toMatch(/not available right now/);
    expect(await runFunction('send_to_chat', { message: 'see `mu.Lock()`' }, env)).toBe('It is in the chat now.');
    expect(await runFunction('save_memory', { content: 'fact', category: 'breakthrough' }, env)).toBe('Remembered.');
    expect(await runFunction('schedule_task', { description: 'remind', when: 'in 2 hours' }, env)).toBe('Scheduled for 2026-11-01 16:00.');
    const read = (sub: string) => fs.readdirSync(path.join(env.ipcDir, sub)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(env.ipcDir, sub, f), 'utf-8')));
    const messages = read('messages');
    expect(messages).toContainEqual(expect.objectContaining({ type: 'message', chatJid: 'web:s_x', text: 'see `mu.Lock()`', groupFolder: 's_x' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'memory_store', studentFolder: 's_x', fact: { text: 'fact', category: 'breakthrough' } }));
    expect(read('tasks')).toEqual([expect.objectContaining({ type: 'schedule_task', schedule_type: 'once', schedule_value: '2026-11-01T16:00:00', targetJid: 'web:s_x', createdBy: 's_x' })]);
    // and recall_memory reads memory_store.json itself
    fs.writeFileSync(path.join(env.groupDir, 'memory_store.json'), JSON.stringify({ memories: [{ text: 'gets Raft via elections', category: 'breakthrough', created_at: 1 }] }));
    expect(await runFunction('recall_memory', { query: 'raft' }, env)).toContain('gets Raft via elections');
  });

  it('read_competency and update_competency are host code on the group folder', async () => {
    fs.writeFileSync(path.join(env.groupDir, 'COMPETENCY.md'), '## Mastery Scores\nPaxos: 0.2 | 0.1 | [] | [] | never\n');
    expect(await runFunction('read_competency', { topic: 'paxos' }, env)).toContain('Paxos: confidence 0.2');
    expect(await runFunction('update_competency', { concept: 'Paxos', confidence_delta: 0.1 }, env)).toContain('0.2 -> 0.3');
    expect(host!.calls).toHaveLength(0);
  });

  it('turns a failed or slow tool into a short error the model can say', async () => {
    host!.handlers = { canvas_query: () => ({ ok: false, text: 'timeout' }), piazza_query: () => ({ ok: false, text: 'Piazza not configured' }) };
    expect(JSON.parse(await runFunction('query_canvas', { action: 'upcoming' }, env)).error).toMatch(/took too long/);
    expect(JSON.parse(await runFunction('query_piazza', { action: 'stats' }, env)).error).toBe('Piazza not configured');
  });
});

/** A Go handler of the kind a homework has: what the interviewer reads from a student's repository. */
const GO_FILE = [
  'package main',
  '',
  'import "sync"',
  '',
  'type Store struct {',
  '\tmu    sync.Mutex',
  '\torders map[string]Order',
  '}',
  '',
  'func (s *Store) Create(o Order) error {',
  '\ts.mu.Lock()',
  '\tdefer s.mu.Unlock()',
  '\tif _, ok := s.orders[o.ID]; ok {',
  '\t\treturn ErrDuplicate',
  '\t}',
  '\ts.orders[o.ID] = o',
  '\treturn nil',
  '}',
  '',
  'func (s *Store) Get(id string) (Order, bool) {',
  '\ts.mu.Lock()',
  '\tdefer s.mu.Unlock()',
  '\to, ok := s.orders[id]',
  '\treturn o, ok',
  '}',
].join('\n');

const HANDLER_FILE = [
  'package main',
  '',
  'func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {',
  '\tvar o Order',
  '\tif err := json.NewDecoder(r.Body).Decode(&o); err != nil {',
  '\t\thttp.Error(w, "bad body", 400)',
  '\t\treturn',
  '\t}',
  '\tif err := h.store.Create(o); err != nil {',
  '\t\thttp.Error(w, err.Error(), 409)',
  '\t\treturn',
  '\t}',
  '\tw.WriteHeader(201)',
  '}',
].join('\n');

describe('the interviewer reads the student\'s own code', () => {
  const github = (over: Record<string, (args: Record<string, unknown>) => { ok: boolean; text: string }> = {}) => {
    host!.handlers = {
      github_query: (args) => {
        const { action } = args as { action: string };
        if (over[action]) return over[action](args);
        if (action === 'file_content') {
          const file = (args as { params: { path: string } }).params.path;
          const content = file === 'handlers/orders.go' ? HANDLER_FILE : GO_FILE;
          return { ok: true, text: JSON.stringify({ path: file, size: content.length, content }, null, 2) };
        }
        if (action === 'repo_tree') return { ok: true, text: JSON.stringify([{ name: 'handlers', type: 'dir' }, { name: 'main.go', type: 'file', size: 1500 }]) };
        if (action === 'list_repos') return { ok: true, text: JSON.stringify([{ name: 'hw3-concurrency', html_url: 'https://github.com/ana-gh/hw3-concurrency' }, { name: 'hw4-kafka' }]) };
        return { ok: true, text: '[]' };
      },
    };
  };
  const interviewing = () => {
    env.mode = 'interviewer';
    env.code = newCodeSeen();
  };
  const read = async (path = 'store/store.go') => runFunction('query_github', { action: 'file_content', repo: 'hw3-concurrency', path }, env);
  const sent = () => (fs.existsSync(path.join(env.ipcDir, 'messages')) ? fs.readdirSync(path.join(env.ipcDir, 'messages')).filter((f) => f.endsWith('.json')) : []);

  it('has a query_github of its own (three actions, no owner) and a send_to_chat of its own, in the style of the others', () => {
    const github = INTERVIEWER_FUNCTIONS.find((f) => f.name === 'query_github')!;
    expect((github.parameters.properties.action as { enum: string[] }).enum).toEqual(['list_repos', 'repo_tree', 'file_content']);
    expect(Object.keys(github.parameters.properties)).toEqual(['action', 'repo', 'path']); // no owner, sha or number: the account is not the model's to name
    for (const part of ['WHEN TO CALL:', 'CORRECT PATTERN:', 'WRONG PATTERN:']) expect(github.description).toContain(part);
    expect(github.description).toMatch(/OWN code/);
    expect(github.description).toMatch(/Reading code aloud/);
    expect(github.parameters.required).toEqual(['action']);
    const chat = INTERVIEWER_FUNCTIONS.find((f) => f.name === 'send_to_chat')!;
    for (const part of ['WHEN TO CALL:', 'CORRECT PATTERN:', 'WRONG PATTERN:']) expect(chat.description).toContain(part);
    expect(chat.description).toMatch(/25 lines/);
    expect(chat.defer_until_eot).toBe(true);
    // the conversation keeps its own, whole
    expect(CONVERSATIONAL_FUNCTIONS.find((f) => f.name === 'query_github')!.parameters.properties).toHaveProperty('owner');
    expect((CONVERSATIONAL_FUNCTIONS.find((f) => f.name === 'query_github')!.parameters.properties.action as { enum: string[] }).enum).toContain('commits');
    expect(CONVERSATIONAL_FUNCTIONS.find((f) => f.name === 'send_to_chat')!.description).not.toMatch(/25 lines/);
    expect(functionsFor('interviewer').map((f) => f.name)).toEqual(['evaluate_answer', 'query_knowledge', 'read_competency', 'query_github', 'send_to_chat', 'end_interview']);
  });

  it('reads only the student\'s own account: the bound username fills the owner, and one the model names is ignored', async () => {
    github();
    interviewing();
    await runFunction('query_github', { action: 'list_repos', owner: 'someone-else' }, env);
    await runFunction('query_github', { action: 'repo_tree', repo: 'hw3-concurrency', owner: 'classmate', path: 'handlers' }, env);
    await read();
    expect(host!.calls.map((c) => c.args)).toEqual([
      { action: 'list_repos', params: { user: 'ana-gh' } },
      { action: 'repo_tree', params: { owner: 'ana-gh', repo: 'hw3-concurrency', path: 'handlers' } },
      { action: 'file_content', params: { owner: 'ana-gh', repo: 'hw3-concurrency', path: 'store/store.go' } },
    ]);
  });

  it('is refused for a student whose account is not linked, before anything reaches the container', async () => {
    github();
    interviewing();
    env.githubUsername = undefined;
    const out = JSON.parse(await runFunction('query_github', { action: 'list_repos' }, env)) as { error: string };
    expect(out.error).toMatch(/not linked to TAi/);
    expect(host!.calls).toHaveLength(0);
  });

  it('offers list_repos, repo_tree and file_content and nothing else: no commits, pull requests or checks', async () => {
    github();
    interviewing();
    for (const action of ['commits', 'commit_detail', 'pull_requests', 'pr_detail', 'check_runs', 'delete_repo']) {
      expect(await runFunction('query_github', { action, repo: 'hw3-concurrency' }, env), action).toMatch(/action must be one of list_repos, repo_tree, file_content/);
    }
    expect(host!.calls).toHaveLength(0);
    // the conversation still has them (and an owner)
    delete env.mode;
    await runFunction('query_github', { action: 'commits', repo: 'hw3-concurrency' }, env);
    expect(host!.calls).toHaveLength(1);
  });

  it('keeps the checks of a path, a repository name and what a file needs', async () => {
    github();
    interviewing();
    expect(await runFunction('query_github', { action: 'file_content', repo: 'other/repo', path: 'a.go' }, env)).toMatch(/repository name only/);
    expect(await runFunction('query_github', { action: 'file_content', repo: 'hw3', path: '../../etc/passwd' }, env)).toMatch(/may not contain/);
    expect(await runFunction('query_github', { action: 'file_content', repo: 'hw3' }, env)).toMatch(/file_content needs path/);
    expect(await runFunction('query_github', { action: 'repo_tree' }, env)).toMatch(/that needs repo/);
    expect(host!.calls).toHaveLength(0);
  });

  it('answers in plain lines: names for repositories and folders, and a file as the code itself under a heading, not as a JSON string', async () => {
    github();
    interviewing();
    expect(await runFunction('query_github', { action: 'list_repos' }, env)).toBe('Repositories (newest first): hw3-concurrency, hw4-kafka.');
    expect(await runFunction('query_github', { action: 'repo_tree', repo: 'hw3-concurrency' }, env)).toBe('handlers/ (folder)\nmain.go (1.5 KB)');
    const file = await read();
    expect(file.startsWith(`File store/store.go (${GO_FILE.length} bytes):\n`)).toBe(true);
    expect(file).toContain('func (s *Store) Create(o Order) error {\n\ts.mu.Lock()');
    expect(file).not.toContain('\\n');
  });

  it('says what went wrong in a few words when GitHub does not answer, and still tells the guard nothing', async () => {
    github({ file_content: () => ({ ok: false, text: 'timeout' }) });
    interviewing();
    expect(JSON.parse(await read()).error).toMatch(/took too long/);
    expect(env.code!.files.size).toBe(0);
  });

  describe('and puts an excerpt of it in the chat', () => {
    const excerpt = (lines: string[], caption = 'store/store.go') => `${caption}\n\`\`\`go\n${lines.join('\n')}\n\`\`\``;
    const create = GO_FILE.split('\n').slice(9, 18); // Create, to its closing brace

    it('lets through lines of a file this call has read, once for each file, and writes what the chat shows', async () => {
      github();
      interviewing();
      await read();
      expect(await runFunction('send_to_chat', { message: excerpt(create) }, env)).toBe('It is in the chat now.');
      const files = sent();
      expect(files).toHaveLength(1);
      const written = JSON.parse(fs.readFileSync(path.join(env.ipcDir, 'messages', files[0]), 'utf-8'));
      expect(written.text).toContain('s.mu.Lock()');
      expect(written).toMatchObject({ type: 'message', chatJid: 'web:s_x', groupFolder: 's_x' });
      // the same file again: refused, and told to point at what is there
      expect(await runFunction('send_to_chat', { message: excerpt(GO_FILE.split('\n').slice(19, 24)) }, env)).toMatch(/excerpt of store\.go is in the chat already/);
      expect(sent()).toHaveLength(1);
      // another file is another excerpt
      await read('handlers/orders.go');
      expect(await runFunction('send_to_chat', { message: excerpt(HANDLER_FILE.split('\n').slice(2, 8), 'handlers/orders.go') }, env)).toBe('It is in the chat now.');
      expect(sent()).toHaveLength(2);
    });

    it('gives a second excerpt to the file that has none when two files have the same lines (one copied into the other)', async () => {
      github();
      interviewing();
      await read('store/store.go');
      await read('store/store_copy.go'); // the same text under another name
      expect(await runFunction('send_to_chat', { message: excerpt(create) }, env)).toBe('It is in the chat now.');
      expect(await runFunction('send_to_chat', { message: excerpt(create, 'store/store_copy.go') }, env)).toBe('It is in the chat now.');
      expect([...env.code!.excerpted].sort()).toEqual(['hw3-concurrency/store/store.go', 'hw3-concurrency/store/store_copy.go']);
      expect(await runFunction('send_to_chat', { message: excerpt(create) }, env)).toMatch(/is in the chat already/);
    });

    it('reads tabs and spaces alike and lets "..." stand for what is left out: a model writes Go with spaces, and shortens', async () => {
      github();
      interviewing();
      await read();
      const spaced = create.map((l) => l.replace(/\t/g, '    '));
      const shortened = [...spaced.slice(0, 3), '    // ...', ...spaced.slice(6)];
      expect(await runFunction('send_to_chat', { message: excerpt(shortened) }, env)).toBe('It is in the chat now.');
    });

    it('refuses lines that are not in a file this call has read: code the model wrote, or "fixed", is not the student\'s', async () => {
      github();
      interviewing();
      await read();
      const fixed = ['func (s *Store) Create(o Order) error {', '\ts.mu.RLock()', '\tdefer s.mu.RUnlock()', '\tif s.orders[o.ID].ID != "" {', '\t\treturn ErrDuplicate', '\t}', '\treturn nil', '}'];
      expect(await runFunction('send_to_chat', { message: excerpt(fixed) }, env)).toMatch(/not in a file you read in this call.*never write, change or fix code/);
      expect(await runFunction('send_to_chat', { message: excerpt(['func Solve() {', '\t// the answer', '\tbroadcast()', '}']) }, env)).toMatch(/not in a file you read/);
      expect(sent()).toHaveLength(0);
    });

    it('tolerates a line or two in five that are not the file\'s, and no more', async () => {
      github();
      interviewing();
      await read();
      const nearly = [...create.slice(0, 8), '\t// (this part is mine)'];
      expect(await runFunction('send_to_chat', { message: excerpt(nearly) }, env)).toBe('It is in the chat now.'); // 8 of 9 lines are the file's
      env.code!.excerpted.clear();
      const half = [...create.slice(0, 3), 'count := compute(total)', 'result := merge(count)', 'publish(result)'];
      expect(await runFunction('send_to_chat', { message: excerpt(half) }, env)).toMatch(/not in a file you read/);
    });

    it('refuses a message of more than a few dozen lines, however much of it is the file\'s, and one with no file read', async () => {
      github();
      interviewing();
      expect(await runFunction('send_to_chat', { message: excerpt(create) }, env)).toMatch(/have not read a file in this call/);
      await read();
      const whole = Array.from({ length: 60 }, (_, i) => GO_FILE.split('\n')[i % 25]);
      expect(await runFunction('send_to_chat', { message: excerpt(whole) }, env)).toMatch(/that is 63 lines.*at most 25 lines/);
      expect(await runFunction('send_to_chat', { message: excerpt(GO_FILE.split('\n').slice(0, 25)) }, env)).toBe('It is in the chat now.'); // 25 are fine
      expect(sent()).toHaveLength(1);
    });

    it('lets a question through (the interviewer\'s own, written down for a student who asked to see it), and no statement: an answer or a hint is not for the chat', async () => {
      github();
      interviewing();
      expect(await runFunction('send_to_chat', { message: 'Why is the lock taken inside Create and not in the handler?' }, env)).toBe('It is in the chat now.');
      expect(await runFunction('send_to_chat', { message: 'The lock is taken in Create.\nWhy is it not in the handler?' }, env)).toBe('It is in the chat now.'); // two lines, ends in a question
      expect(await runFunction('send_to_chat', { message: 'Why not "just" use a channel (a buffered one)?' }, env)).toBe('It is in the chat now.'); // a closing quote or bracket after the "?" is fine
      // the answer in one line, which an earlier version let through, a hint, a statement
      for (const answer of ['Use a sync.RWMutex: reads share it.\nThe handler then needs no lock.', 'Use an RWMutex here.', 'Think about the check and the insert being one step.']) {
        expect(await runFunction('send_to_chat', { message: answer }, env), answer).toMatch(/Yours was neither/);
      }
      expect(await runFunction('send_to_chat', { message: `${'Why '.repeat(100)}?` }, env)).toMatch(/Yours was neither/); // too long for a question
      expect(await runFunction('send_to_chat', { message: 'one?\ntwo?\nthree?' }, env)).toMatch(/Yours was neither/);
      expect(await runFunction('send_to_chat', { message: 'try s.mu = sync.RWMutex{}; return nil?' }, env)).toMatch(/Yours was neither/); // code outside a block is not an excerpt
      expect(sent()).toHaveLength(3);
    });

    it('allows the file\'s name next to the code, a few words, and no explanation', async () => {
      github();
      interviewing();
      await read();
      expect(await runFunction('send_to_chat', { message: excerpt(create, `store/store.go, Create: ${'a '.repeat(100)}`) }, env)).toMatch(/put only the file's name/);
      expect(await runFunction('send_to_chat', { message: excerpt(create, 'store/store.go, the Create function') }, env)).toBe('It is in the chat now.');
    });

    it('refuses an empty block, and a block of nothing but braces (they are in every file)', async () => {
      github();
      interviewing();
      await read();
      expect(await runFunction('send_to_chat', { message: '```go\n```' }, env)).toMatch(/block is empty/);
      expect(await runFunction('send_to_chat', { message: '```go\n}\n)\n}\n```' }, env)).toMatch(/block is empty/);
    });

    it('is the conversation\'s send_to_chat, untouched, outside the interview: any text, a long one too', async () => {
      const long = Array.from({ length: 80 }, (_, i) => `step ${i}`).join('\n');
      expect(await runFunction('send_to_chat', { message: long }, env)).toBe('It is in the chat now.');
      env.mode = 'conversational';
      expect(await runFunction('send_to_chat', { message: `\`\`\`go\nfunc Mine() {}\n\`\`\`` }, env)).toBe('It is in the chat now.');
      env.mode = 'listener';
      expect(await runFunction('send_to_chat', { message: long }, env)).toBe('It is in the chat now.');
    });

    it('does not mind a call that has no record of the files read: everything fenced is refused, a short line is not', async () => {
      env.mode = 'interviewer'; // no env.code at all
      expect(await runFunction('send_to_chat', { message: excerpt(create) }, env)).toMatch(/have not read a file/);
      expect(await runFunction('send_to_chat', { message: 'Which function takes the lock?' }, env)).toBe('It is in the chat now.');
    });

    it('still keeps the rule about links: one nobody gave the call is not sent', async () => {
      github();
      interviewing();
      env.urls = new Set();
      expect(await runFunction('send_to_chat', { message: 'Have you read https://example.com/answer?' }, env)).toMatch(/not a link any lookup in this call returned/);
    });
  });
});

describe('helpers', () => {
  const now = new Date(2026, 10, 1, 14, 30, 0).getTime();
  it('reads when a follow-up should run, in local time without a zone', () => {
    expect(parseWhen('2026-11-03T09:00', now)).toBe('2026-11-03T09:00:00');
    expect(parseWhen('2026-11-03', now)).toBe('2026-11-03T09:00:00');
    expect(parseWhen('in 2 hours', now)).toBe('2026-11-01T16:30:00');
    expect(parseWhen('in 30 minutes', now)).toBe('2026-11-01T15:00:00');
    expect(parseWhen('tomorrow 9am', now)).toBe('2026-11-02T09:00:00');
    expect(parseWhen('tomorrow at 9:15 pm', now)).toBe('2026-11-02T21:15:00');
    expect(parseWhen('9am', now)).toBe('2026-11-02T09:00:00'); // passed today
    expect(parseWhen('8pm', now)).toBe('2026-11-01T20:00:00');
    expect(parseWhen('tonight', now)).toBe('2026-11-01T20:00:00');
    expect(parseWhen('tomorrow morning', now)).toBe('2026-11-02T09:00:00');
    expect(parseWhen('2026-10-01T09:00', now)).toBeNull(); // the past
    expect(parseWhen('in 90 days', now)).toBeNull();
    expect(parseWhen('soonish', now)).toBeNull();
  });

  it('parses arguments defensively and caps results', () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs('[1]')).toEqual({});
    expect(parseArgs('{oops')).toEqual({});
    expect(parseArgs(undefined)).toEqual({});
    expect(capResult('x'.repeat(10_000)).length).toBe(RESULT_CAP);
    expect(capResult('short')).toBe('short');
  });
});

describe('schedule_task and the host\'s answer', () => {
  const written = (): Array<Record<string, unknown>> =>
    fs.readdirSync(path.join(env.ipcDir, 'tasks')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(env.ipcDir, 'tasks', f), 'utf-8')));

  it('puts a request id the host accepts in the file it writes', async () => {
    env.awaitIpcAnswer = async () => ({ ok: true, message: 'set' });
    await runFunction('schedule_task', { description: 'remind me', when: 'in 2 hours' }, env);
    const [task] = written();
    expect(String(task.requestId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('says it was set only when the host says so', async () => {
    let asked = '';
    env.awaitIpcAnswer = async (id) => {
      asked = id;
      return { ok: true, message: 'Task task-1 scheduled.' };
    };
    expect(await runFunction('schedule_task', { description: 'remind me', when: 'in 2 hours' }, env)).toBe('Scheduled for 2026-11-01 16:00.');
    expect(asked).toBe(String(written()[0].requestId));
  });

  it('passes a refusal of the host on as an error, not as "scheduled"', async () => {
    env.awaitIpcAnswer = async () => ({ ok: false, message: 'Not scheduled: 10 reminders or routines are already set up here.' });
    const answer = await runFunction('schedule_task', { description: 'remind me', when: 'in 2 hours' }, env);
    expect(JSON.parse(answer)).toEqual({ error: 'Not scheduled: 10 reminders or routines are already set up here.' });
  });

  it('says it is not sure when the host did not answer in time', async () => {
    env.awaitIpcAnswer = async () => null;
    const answer = JSON.parse(await runFunction('schedule_task', { description: 'remind me', when: 'in 2 hours' }, env));
    expect(answer.error).toMatch(/not sure/);
  });

  it('keeps the old behaviour where the call has no way to ask (no awaitIpcAnswer)', async () => {
    expect(env.awaitIpcAnswer).toBeUndefined();
    expect(await runFunction('schedule_task', { description: 'remind me', when: 'in 2 hours' }, env)).toBe('Scheduled for 2026-11-01 16:00.');
  });
});
