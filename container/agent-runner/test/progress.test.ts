import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseProgressLine } from '../../../src/turn-status.js';            // the host's reader of what this runner writes (a test only: the container never imports host code)
import { ProgressReporter, coarseToolName, sourceLabel, sourcesOf, textOfResult } from '../src/progress.js';
import { PROGRESS_MARKER, writeProgress, type ProgressEvent, type SourceChip } from '../src/protocol.js';

// What the four lookup tools return, as the tools themselves print it (test/fixtures/tool-results.json: the real canvas_api.py and github_api.py
// run against eval/mock_services.py, and the real formatters of piazza_query.py and leanrag/mcp_server.py on synthetic data).
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'tool-results.json'), 'utf-8')) as Record<string, { args: Record<string, unknown>; text: string }>;
const TOOL: Record<string, string> = { canvas: 'canvas_query', github: 'github_query', piazza: 'piazza_query', knowledge: 'query_knowledge' };

/** The chips the collector makes of one recorded result. */
function chipsOf(name: string): SourceChip[] {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`no fixture ${name}`);
  return sourcesOf(TOOL[name.split('.')[0]], fixture.args, fixture.text);
}

const labels = (chips: SourceChip[]) => chips.map((c) => c.label);
const parsed = (name: string) => JSON.parse(FIXTURES[name].text);

describe('the name of a tool call that goes to the host', () => {
  it('has no server prefix, and Claude Code\'s names are pi\'s', () => {
    expect(coarseToolName('mcp__nanoclaw__canvas_query', { action: 'assignments' })).toBe('canvas_query');
    expect(coarseToolName('mcp__leanrag__query_knowledge', {})).toBe('query_knowledge');
    expect(coarseToolName('mcp__nanoclaw__send_message', { text: 'hello' })).toBe('send_message');
    expect(coarseToolName('WebFetch', { url: 'https://example.com' })).toBe('web_fetch');
    expect(coarseToolName('Bash', { command: 'ls' })).toBe('bash');
    expect(coarseToolName('MultiEdit', {})).toBe('edit');
    expect(coarseToolName('web_fetch', {})).toBe('web_fetch');
  });

  it('is read_upload for a read of the student\'s attachment and read for TAi\'s own notes', () => {
    expect(coarseToolName('read', { path: '/workspace/group/uploads/hw3.pdf' })).toBe('read_upload');
    expect(coarseToolName('read', { path: 'uploads/hw3.pdf' })).toBe('read_upload');                 // relative to the working directory, /workspace/group
    expect(coarseToolName('Read', { file_path: '/workspace/group/uploads/notes.txt' })).toBe('read_upload');
    expect(coarseToolName('read', { path: '/workspace/group/COMPETENCY.md' })).toBe('read');
    expect(coarseToolName('read', { path: 'COMPETENCY.md' })).toBe('read');
    expect(coarseToolName('read', { path: '/workspace/group/memory_context.md' })).toBe('read');
    expect(coarseToolName('read', { path: '/workspace/group/uploads' })).toBe('read');               // the folder itself is not a file of the student's
  });

  it('is not fooled by a path that climbs out of uploads/ or only looks like it', () => {
    expect(coarseToolName('read', { path: '/workspace/group/uploads/../COMPETENCY.md' })).toBe('read');
    expect(coarseToolName('read', { path: 'uploads/../../global/CLAUDE.md' })).toBe('read');
    expect(coarseToolName('read', { path: '/workspace/group/uploads-old/x.txt' })).toBe('read');
    expect(coarseToolName('read', { path: '/elsewhere/workspace/group/uploads/x.txt' })).toBe('read');
    expect(coarseToolName('read', {})).toBe('read');
    expect(coarseToolName('read', null)).toBe('read');
    expect(coarseToolName('read', { path: 42 })).toBe('read');
  });

  it('follows the workspace it is told about', () => {
    expect(coarseToolName('read', { path: '/tmp/ws/group/uploads/a.txt' }, '/tmp/ws')).toBe('read_upload');
    expect(coarseToolName('read', { path: '/workspace/group/uploads/a.txt' }, '/tmp/ws')).toBe('read');
  });

  it('carries only the characters of a tool name, at most 64, and never an argument', () => {
    expect(coarseToolName('weird tool!<script>', {})).toBe('weirdtoolscript');
    expect(coarseToolName('!!!', {})).toBe('tool');
    expect(coarseToolName('x'.repeat(200), {})).toHaveLength(64);
    expect(coarseToolName('mcp__nanoclaw__canvas_query', { action: 'my_grades', params: { user_id: '1001' } })).not.toMatch(/1001|my_grades/);
  });
});

describe('what a Canvas result shows', () => {
  it('is one chip for each assignment of a short list, with the address Canvas gave', () => {
    const chips = chipsOf('canvas.upcoming');
    expect(chips).toEqual([
      { kind: 'canvas', label: 'Homework 6: Scalability?', url: 'https://canvas.example.edu/courses/1/assignments/107' },
      { kind: 'canvas', label: 'Midterm Mastery Part 2', url: 'https://canvas.example.edu/courses/1/assignments/108' },
    ]);
  });

  it('is one chip for a long list, named for the list: not the first three of eight', () => {
    expect(parsed('canvas.assignments').length).toBeGreaterThan(3);
    expect(chipsOf('canvas.assignments')).toEqual([{ kind: 'canvas', label: 'Assignments' }]);
  });

  it('is the assignment, with its address, for assignment_detail', () => {
    expect(chipsOf('canvas.assignment_detail')).toEqual([{ kind: 'canvas', label: 'Homework 6: Scalability?', url: 'https://canvas.example.edu/courses/1/assignments/107' }]);
  });

  it('is the module items by title and Canvas address, never the external link', () => {
    const chips = chipsOf('canvas.module_items');
    expect(labels(chips)).toEqual(['Raft paper (In Search of an Understandable Consensus Algorithm)', 'Slides: Leader election']);
    expect(chips.map((c) => c.url)).toEqual(['https://canvas.example.edu/m/501/1', 'https://canvas.example.edu/m/501/2']);
    expect(JSON.stringify(chips)).not.toContain('raft.github.io');
  });

  it('is a label with no address where the result has none: a page is named by a slug and a file by a signed link', () => {
    expect(chipsOf('canvas.page_detail')).toEqual([{ kind: 'canvas', label: 'Circuit breakers' }]);
    expect(chipsOf('canvas.pages')).toEqual([{ kind: 'canvas', label: 'Course pages' }]);
    expect(chipsOf('canvas.syllabus')).toEqual([{ kind: 'canvas', label: 'Syllabus' }]);
    expect(chipsOf('canvas.modules')).toEqual([{ kind: 'canvas', label: 'Course modules' }]);
  });

  it('is the titles of a few announcements and discussions, and a discussion with its address', () => {
    expect(labels(chipsOf('canvas.announcements'))).toEqual(['Midterm Mastery Part 2 opens soon', 'HW5 grading notes']);
    expect(chipsOf('canvas.announcements').every((c) => c.url === undefined)).toBe(true);
    expect(labels(chipsOf('canvas.discussions'))).toEqual(['Midterm Mastery Part 2 opens soon', 'HW5 grading notes', 'Questions about HW6']);
    expect(chipsOf('canvas.discussion_detail')).toEqual([{ kind: 'canvas', label: 'Midterm Mastery Part 2 opens soon', url: 'https://canvas.example.edu/courses/1/discussion_topics/9001' }]);
  });

  it('names the replies of a discussion as a list, with nobody\'s name in it', () => {
    const chips = chipsOf('canvas.discussion_entries');
    expect(chips).toEqual([{ kind: 'canvas', label: 'Discussion replies' }]);
    expect(JSON.stringify(chips)).not.toMatch(/Bob/);
  });

  it('is the student\'s own grades and submission, by words only: no score, no name', () => {
    expect(chipsOf('canvas.my_grades')).toEqual([{ kind: 'canvas', label: 'Your grades' }]);
    expect(chipsOf('canvas.student_submission')).toEqual([{ kind: 'canvas', label: 'Your submission' }]);
  });

  it('is nothing for an empty list, a refusal, an unknown action and a result that is not JSON', () => {
    expect(JSON.parse(FIXTURES['canvas.files'].text)).toEqual([]);
    expect(chipsOf('canvas.files')).toEqual([]);
    expect(chipsOf('canvas.assignment_detail_missing_id')).toEqual([]);          // {"error": "assignment_id required"} is a result, not a failed call
    expect(chipsOf('canvas.unknown_action')).toEqual([]);
    expect(sourcesOf('canvas_query', { action: 'assignments' }, 'Canvas query failed: boom')).toEqual([]);
    expect(sourcesOf('canvas_query', { action: 'assignments' }, '')).toEqual([]);
    expect(sourcesOf('canvas_query', { action: 'assignments' }, '[1, 2, 3]')).toEqual([]);
  });

  it('takes a rule from the action and a label from the result: an action the model made up shows nothing', () => {
    const fixture = FIXTURES['canvas.upcoming'];
    expect(sourcesOf('canvas_query', { action: 'something_else' }, fixture.text)).toEqual([]);
    expect(sourcesOf('canvas_query', undefined, fixture.text)).toEqual([]);
    expect(sourcesOf('canvas_query', { action: 42 }, fixture.text)).toEqual([]);
  });

  it('drops an address that is not https, has white space or is long, and keeps the label', () => {
    const body = (url: unknown) => JSON.stringify({ id: 1, name: 'HW', html_url: url });
    expect(sourcesOf('canvas_query', { action: 'assignment_detail' }, body('http://canvas.example.edu/a'))).toEqual([{ kind: 'canvas', label: 'HW' }]);
    expect(sourcesOf('canvas_query', { action: 'assignment_detail' }, body('javascript:alert(1)'))).toEqual([{ kind: 'canvas', label: 'HW' }]);
    expect(sourcesOf('canvas_query', { action: 'assignment_detail' }, body('https://canvas.example.edu/a b'))).toEqual([{ kind: 'canvas', label: 'HW' }]);
    expect(sourcesOf('canvas_query', { action: 'assignment_detail' }, body(`https://canvas.example.edu/${'x'.repeat(400)}`))).toEqual([{ kind: 'canvas', label: 'HW' }]);
    expect(sourcesOf('canvas_query', { action: 'assignment_detail' }, body(42))).toEqual([{ kind: 'canvas', label: 'HW' }]);
  });

  it('cuts a long title to one line of 80 characters and strips control characters and bidi overrides', () => {
    const body = JSON.stringify({ name: `${'Very long homework title '.repeat(10)}`, html_url: 'https://canvas.example.edu/x' });
    const [long] = sourcesOf('canvas_query', { action: 'assignment_detail' }, body);
    expect(long.label.length).toBeLessThanOrEqual(80);
    expect(long.label.endsWith('…')).toBe(true);
    const [odd] = sourcesOf('canvas_query', { action: 'assignment_detail' }, JSON.stringify({ name: 'Home\u0007work\n 3‮ evil​', html_url: 'https://canvas.example.edu/x' }));
    expect(odd.label).toBe('Home work 3 evil');
  });
});

describe('what a GitHub result shows', () => {
  it('is the repository, by name, with the address GitHub gave', () => {
    expect(chipsOf('github.list_repos')).toEqual([{ kind: 'github', label: 'ann-eval/cs6650-hw3', url: 'https://github.khoury.example.edu/ann-eval/cs6650-hw3' }]);
    expect(chipsOf('github.list_repos_org')).toEqual([{ kind: 'github', label: 'cs6650-course/starter', url: 'https://github.khoury.example.edu/cs6650-course/starter' }]);
  });

  it('is the file by its path from the result (it has no address), and the files of a directory as one chip', () => {
    expect(chipsOf('github.file_content')).toEqual([{ kind: 'github', label: 'worker/pool.go' }]);
    expect(chipsOf('github.repo_tree')).toEqual([{ kind: 'github', label: 'Repository files' }]);
    expect(chipsOf('github.repo_tree_recursive')).toEqual([{ kind: 'github', label: 'Repository files' }]);
  });

  it('is a commit by its short sha and the first line of its message, with its address, and a long history as one chip naming the repository', () => {
    const [only] = chipsOf('github.commits_one');
    const commit = parsed('github.commits_one')[0];
    expect(only).toEqual({ kind: 'github', label: `${commit.sha} ${commit.message}`, url: commit.url });
    expect(parsed('github.commits').length).toBeGreaterThan(3);
    expect(chipsOf('github.commits')).toEqual([{ kind: 'github', label: 'Commits in ann-eval/cs6650-hw3' }]);
    const detail = parsed('github.commit_detail');
    expect(chipsOf('github.commit_detail')).toEqual([{ kind: 'github', label: `${detail.sha.slice(0, 7)} fix typo in README` }]);
  });

  it('is the pull request by number and title, with its address', () => {
    const expected = [{ kind: 'github', label: '#1 Add worker pool', url: 'https://github.khoury.example.edu/ann-eval/cs6650-hw3/pull/1' }];
    expect(chipsOf('github.pull_requests')).toEqual(expected);
    expect(chipsOf('github.pr_detail')).toEqual(expected);
    expect(chipsOf('github.pr_reviews')).toEqual([{ kind: 'github', label: 'Pull request reviews' }]);
    expect(chipsOf('github.check_runs')).toEqual([{ kind: 'github', label: 'CI checks' }]);
  });

  it('shows nothing for a refusal', () => {
    expect(chipsOf('github.file_content_missing')).toEqual([]);
    expect(sourcesOf('github_query', { action: 'file_content' }, 'GitHub query failed: 404')).toEqual([]);
  });

  it('never puts the code of a file or the body of a pull request in a chip', () => {
    const all = JSON.stringify([...chipsOf('github.file_content'), ...chipsOf('github.pr_detail'), ...chipsOf('github.commit_detail')]);
    expect(all).not.toContain('sync.WaitGroup');
    expect(all).not.toContain('First version of the pool');
  });
});

describe('what a Piazza result shows', () => {
  it('is the post by its number and title, which Piazza gives no address a student could open', () => {
    expect(chipsOf('piazza.get_post')).toEqual([{ kind: 'piazza', label: '@45 Raft election timeout & heartbeats' }]);
    expect(chipsOf('piazza.get_pinned')).toEqual([{ kind: 'piazza', label: '@7 Office hours this week' }]);
    expect(chipsOf('piazza.search_stopped')).toEqual([{ kind: 'piazza', label: '@61 Docker networking question' }]);
  });

  it('is each post of a short search, and one chip for a long list', () => {
    expect(labels(chipsOf('piazza.search'))).toEqual(['@45 Raft election timeout & heartbeats', '@52 HW6 load test numbers']);
    expect(parsed('piazza.recent_posts').posts.length).toBeGreaterThan(3);
    expect(chipsOf('piazza.recent_posts')).toEqual([{ kind: 'piazza', label: 'Recent Piazza posts' }]);
  });

  it('is the tags as one chip, and nothing for a refusal', () => {
    expect(chipsOf('piazza.list_tags')).toEqual([{ kind: 'piazza', label: 'Piazza tags' }]);
    expect(chipsOf('piazza.error')).toEqual([]);
  });

  it('never carries the words of a post or of its answers', () => {
    const all = JSON.stringify([...chipsOf('piazza.get_post'), ...chipsOf('piazza.search')]);
    expect(all).not.toContain('randomized');
    expect(all).not.toContain('split votes');
  });
});

describe('what a query_knowledge result shows', () => {
  it('is the documents it lists as sources, by file name without folders or extension, the first three, in its order', () => {
    expect(chipsOf('knowledge.query')).toEqual([
      { kind: 'course', label: 'Raft_lecture' },
      { kind: 'course', label: 'In Search of an Understandable Consensus Algorithm' },
      { kind: 'course', label: 'professor_notes_week11' },
    ]);
  });

  it('is nothing when there are no sources or the graph could not be read', () => {
    expect(chipsOf('knowledge.empty')).toEqual([]);
    expect(chipsOf('knowledge.error')).toEqual([]);
  });

  it('names a document once however often the result mentions it', () => {
    const text = '**Source: a/lecture.pdf**\n```\nx\n```\n\n**Source: b/lecture.pdf**\n```\ny\n```\n';
    expect(labels(sourcesOf('query_knowledge', {}, text))).toEqual(['lecture']);
  });

  it('reads only a line that is a source heading, not the words of a chunk that look like one', () => {
    const text = '### Source Course Materials\n**Source: real.md**\n```\nthe model said **Source: fake.md** here\n```\n';
    expect(labels(sourcesOf('query_knowledge', {}, text))).toEqual(['real']);
  });

  it('keeps the extension of a name that is a title, not a file', () => {
    expect(sourceLabel('slides: Raft consensus (lecture 11)')).toBe('slides: Raft consensus (lecture 11)');
    expect(sourceLabel('week11\\Raft notes.PDF')).toBe('Raft notes');
  });
});

describe('what no other tool shows', () => {
  it('is nothing: only the four lookups have chips', () => {
    expect(sourcesOf('send_message', { text: 'hi' }, JSON.stringify({ name: 'x', html_url: 'https://canvas.example.edu/x' }))).toEqual([]);
    expect(sourcesOf('bash', {}, '**Source: x.md**')).toEqual([]);
    expect(sourcesOf('web_fetch', {}, 'https://example.com')).toEqual([]);
    expect(sourcesOf('read_upload', {}, 'anything')).toEqual([]);
  });
});

describe('the text of a tool result', () => {
  it('is read from a string, from content blocks, and from the blocks alone; images are not text', () => {
    expect(textOfResult('plain')).toBe('plain');
    expect(textOfResult({ content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'AAAA' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo');
    expect(textOfResult([{ type: 'text', text: 'blocks' }])).toBe('blocks');
    expect(textOfResult({ content: 'nope' })).toBe('');
    expect(textOfResult(null)).toBe('');
    expect(textOfResult(undefined)).toBe('');
    expect(textOfResult({ details: {} })).toBe('');
  });
});

describe('the reporter', () => {
  function make(options: { enabled?: boolean } = {}) {
    const events: ProgressEvent[] = [];
    return { events, reporter: new ProgressReporter({ write: (e) => events.push(e), ...options }) };
  }
  const result = (name: string) => ({ content: [{ type: 'text', text: FIXTURES[name].text }] });

  it('says a tool started and ended by its coarse name, and nothing of its arguments', () => {
    const { events, reporter } = make();
    reporter.thinking();
    reporter.toolStart('c1', 'mcp__nanoclaw__canvas_query', { action: 'my_grades', params: { user_id: '1001' } });
    reporter.toolEnd('c1', result('canvas.my_grades'), false);
    expect(events.slice(0, 3)).toEqual([{ type: 'thinking' }, { type: 'tool', name: 'canvas_query', phase: 'start' }, { type: 'tool', name: 'canvas_query', phase: 'end' }]);
    expect(JSON.stringify(events)).not.toMatch(/1001|my_grades/);
  });

  it('follows a tool call to its end by the call\'s id, and says the same name at the end as at the start', () => {
    const { events, reporter } = make();
    reporter.toolStart('r1', 'read', { path: '/workspace/group/uploads/a.pdf' });
    reporter.toolEnd('r1', { content: [{ type: 'text', text: 'pages' }] }, false);           // the end event has no arguments of its own
    expect(events).toEqual([{ type: 'tool', name: 'read_upload', phase: 'start' }, { type: 'tool', name: 'read_upload', phase: 'end' }]);
  });

  it('sends the chips of a lookup with the number of the call that made them, after its end', () => {
    const { events, reporter } = make();
    reporter.toolStart('c1', 'mcp__nanoclaw__github_query', { action: 'pr_detail', params: { repo: 'cs6650-hw3', number: '1' } });
    reporter.toolEnd('c1', result('github.pr_detail'), false);
    expect(events).toEqual([
      { type: 'tool', name: 'github_query', phase: 'start' },
      { type: 'tool', name: 'github_query', phase: 'end' },
      { type: 'sources', seq: 1, items: [{ kind: 'github', label: '#1 Add worker pool', url: 'https://github.khoury.example.edu/ann-eval/cs6650-hw3/pull/1' }] },
    ]);
  });

  it('numbers calls in the order they started, whichever finishes first (pi runs them side by side)', () => {
    const { events, reporter } = make();
    reporter.toolStart('a', 'mcp__nanoclaw__canvas_query', { action: 'assignment_detail' });
    reporter.toolStart('b', 'mcp__nanoclaw__piazza_query', { action: 'get_post' });
    reporter.toolEnd('b', result('piazza.get_post'), false);
    reporter.toolEnd('a', result('canvas.assignment_detail'), false);
    const sources = events.filter((e): e is Extract<ProgressEvent, { type: 'sources' }> => e.type === 'sources');
    expect(sources.map((e) => [e.seq, e.items[0].kind])).toEqual([[2, 'piazza'], [1, 'canvas']]);
  });

  it('sends no chips for a call that failed, a tool that is not a lookup, or a result with nothing in it', () => {
    const { events, reporter } = make();
    reporter.toolStart('1', 'mcp__nanoclaw__canvas_query', { action: 'assignments' });
    reporter.toolEnd('1', result('canvas.upcoming'), true);
    reporter.toolStart('2', 'bash', { command: 'ls' });
    reporter.toolEnd('2', { content: [{ type: 'text', text: JSON.stringify({ name: 'x', html_url: 'https://canvas.example.edu/x' }) }] }, false);
    reporter.toolStart('3', 'mcp__nanoclaw__canvas_query', { action: 'files' });
    reporter.toolEnd('3', result('canvas.files'), false);
    expect(events.filter((e) => e.type === 'sources')).toEqual([]);
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(6);
  });

  it('shows what a turn looked at once, and again in the next turn', () => {
    const { events, reporter } = make();
    const ask = (id: string) => {
      reporter.toolStart(id, 'mcp__nanoclaw__canvas_query', { action: 'assignment_detail' });
      reporter.toolEnd(id, result('canvas.assignment_detail'), false);
    };
    ask('1');
    ask('2');
    expect(events.filter((e) => e.type === 'sources')).toHaveLength(1);
    reporter.beginTurn();
    ask('3');
    expect(events.filter((e) => e.type === 'sources')).toHaveLength(2);
  });

  it('takes the name and arguments from the end event when it never saw the start (Claude Code\'s PostToolUse)', () => {
    const { events, reporter } = make();
    reporter.toolEnd('zzz', { content: [{ type: 'text', text: FIXTURES['piazza.get_post'].text }] }, false, { name: 'mcp__nanoclaw__piazza_query', args: { action: 'get_post' } });
    expect(events[0]).toEqual({ type: 'tool', name: 'piazza_query', phase: 'end' });
    expect(events[1]).toMatchObject({ type: 'sources', items: [{ kind: 'piazza' }] });
    const none = make();
    none.reporter.toolEnd('unknown', 'x', false);                                              // no start, nothing known: nothing said
    expect(none.events).toEqual([]);
  });

  it('says nothing when it is switched off (a scheduled task), and does not throw when the writer does', () => {
    const off = make({ enabled: false });
    off.reporter.thinking();
    off.reporter.toolStart('1', 'read', {});
    off.reporter.toolEnd('1', '', false);
    expect(off.events).toEqual([]);
    const broken = new ProgressReporter({ write: () => { throw new Error('stdout is gone'); } });
    expect(() => {
      broken.thinking();
      broken.toolStart('1', 'read', {});
      broken.toolEnd('1', '', false);
    }).not.toThrow();
  });

  it('does not keep every call that never ended: the table of open calls is bounded', () => {
    const { events, reporter } = make();
    for (let i = 0; i < 500; i++) reporter.toolStart(`call-${i}`, 'read', {});
    expect(events).toHaveLength(500);
    reporter.toolEnd('call-0', '', false);                                                      // the oldest were let go: its end is not known any more
    expect(events).toHaveLength(500);
    reporter.toolEnd('call-499', '', false);
    expect(events).toHaveLength(501);
  });
});

describe('the progress line on stdout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['TAI_MODE'];
  });

  it('is one line: the marker, a space and the event as JSON, which no text of a label can break into two', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    writeProgress({ type: 'sources', seq: 3, items: [{ kind: 'piazza', label: 'line one\nline two"quoted"' }] });
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${PROGRESS_MARKER} {`)).toBe(true);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0].slice(PROGRESS_MARKER.length + 1))).toEqual({ type: 'sources', seq: 3, items: [{ kind: 'piazza', label: 'line one\nline two"quoted"' }] });
  });

  it('is read back by the host\'s own parser as the event that was written, for every kind of event', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const events: ProgressEvent[] = [
      { type: 'thinking' },
      { type: 'tool', name: 'canvas_query', phase: 'start' },
      { type: 'tool', name: 'read_upload', phase: 'end' },
      { type: 'sources', seq: 4, items: [{ kind: 'canvas', label: 'Homework 6: Scalability?', url: 'https://canvas.example.edu/courses/1/assignments/107' }, { kind: 'piazza', label: '@45 Raft timeouts' }] },
    ];
    for (const event of events) writeProgress(event);
    expect(lines.map(parseProgressLine)).toEqual(events);
  });

  it('is not written by the voice tool host, whose stdout is the host\'s protocol', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env['TAI_MODE'] = 'tool-host';
    writeProgress({ type: 'thinking' });
    expect(log).not.toHaveBeenCalled();
  });

  it('never throws, whatever stdout does', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    expect(() => writeProgress({ type: 'thinking' })).not.toThrow();
  });
});
