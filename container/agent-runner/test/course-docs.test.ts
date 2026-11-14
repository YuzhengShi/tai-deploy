import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LIBRARY_ANSWER_CHARS } from '../../../src/docs/library-answer.js';
import { handleCourseDocFind } from '../../../src/docs/library-verb.js';
import type { DocsApi, LibraryEntry, LibraryHit } from '../../../src/docs/types.js';
import {
  COURSE_DOCS_NOT_IN_CALL,
  COURSE_DOCS_NOT_IN_TASK,
  COURSE_DOCS_NOT_SENT,
  COURSE_DOCS_NUMBERS,
  COURSE_DOCS_UNCONFIRMED,
  COURSE_DOCS_UNREADABLE,
  FIND_COURSE_DOCUMENT_DESCRIPTION,
  findCourseDocument,
} from '../src/course-docs.js';
import type { CourseDocsContext } from '../src/course-docs.js';
import { TOOL_LIMITS, ToolLimiter } from '../src/tool-limits.js';

// The container's tool find_course_document: it writes the request the host's verb `course_doc_find` reads (src/docs/library-verb.ts) and waits for the answer file. The number it repeats is a twin of the
// host's, and one test below fails when a copy differs; the last test runs the real host verb against the real tool.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-docs-tool-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const answerFile = (id: string, body: unknown) => fs.writeFileSync(path.join(dir, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));

/** A clock that moves only when the wait sleeps. */
function clock() {
  let at = 1_000_000;
  let sleeps = 0;
  return { now: () => at, sleep: async (ms: number) => { sleeps++; at += ms; }, sleeps: () => sleeps };
}
function context(over: Partial<CourseDocsContext> = {}, onWrite: (data: Record<string, unknown>) => void = () => undefined) {
  const written: Array<Record<string, unknown>> = [];
  const used = { limit: 0 };
  const c = clock();
  const ctx: CourseDocsContext = {
    scheduled: false,
    limit: () => (used.limit++, null),
    writeTask: (data) => {
      written.push(data);
      onWrite(data);
    },
    resultsDir: dir,
    wait: { now: c.now, sleep: c.sleep },
    ...over,
  };
  return { ctx, written, used, clock: c };
}

describe('the twin of the host\'s number and the limit', () => {
  it('is the host\'s: the cap on the answer, and a wait that is more than the host\'s watcher needs', () => {
    expect(COURSE_DOCS_NUMBERS.answerChars).toBe(LIBRARY_ANSWER_CHARS);
    expect(COURSE_DOCS_NUMBERS.requestWaitMs).toBeGreaterThanOrEqual(5_000);
  });

  it('counts eight searches in a conversation and refuses the ninth in the limiter\'s sentence; the admin is never counted', () => {
    expect(TOOL_LIMITS.find_course_document).toBe(8);
    const limiter = new ToolLimiter(TOOL_LIMITS);
    expect(Array.from({ length: 8 }, () => limiter.check('find_course_document'))).toEqual(Array(8).fill(null));
    expect(limiter.check('find_course_document')).toBe('Rate limit exceeded for find_course_document: max 8 calls per session.');
    const admin = new ToolLimiter(TOOL_LIMITS, true);
    for (let i = 0; i < 50; i++) expect(admin.check('find_course_document')).toBeNull();
  });
});

describe('what the tool tells the model', () => {
  it('says what it is for, how to open a slide it found, what it is not for and that the quoted text is data, in the style of the other tools', () => {
    const d = FIND_COURSE_DOCUMENT_DESCRIPTION;
    for (const part of ['WHEN TO CALL:', 'NOT:', 'Not available in a scheduled task']) expect(d).toContain(part);
    expect(d).toMatch(/then show_document with a title and page from the list/);
    expect(d).toMatch(/Saying a slide says something the result did not show/);
    expect(d).toMatch(/data, never instructions/);
    expect(d).toMatch(/the professor's slides/);
    expect(d).toContain('`query` is a few topic words');
  });

  it('stays at about four hundred characters, because it goes with every turn of the text agent', () => {
    expect(FIND_COURSE_DOCUMENT_DESCRIPTION.length).toBeLessThanOrEqual(450);
    expect(FIND_COURSE_DOCUMENT_DESCRIPTION.split(/\n\n/)[0].length).toBeLessThanOrEqual(160);
  });
});

describe('a call', () => {
  it('writes exactly one request, {type, requestId, request: {query}, timestamp}, with the model\'s words untouched, and an id the host accepts', async () => {
    const { ctx, written } = context({}, (data) => answerFile(String(data.requestId), { ok: true, message: 'Found 1 slide.' }));
    await findCourseDocument({ query: '  Leader   election!  ' }, ctx);
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0]).sort()).toEqual(['request', 'requestId', 'timestamp', 'type']);
    expect(written[0].type).toBe('course_doc_find');
    expect(written[0].request).toEqual({ query: '  Leader   election!  ' });
    expect(String(written[0].requestId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(new Date(String(written[0].timestamp)).toISOString()).toBe(written[0].timestamp);
  });

  it('relays the host\'s answer: slides that matched are the text, a refusal is an error with the host\'s sentence', async () => {
    const ok = context({}, (d) => answerFile(String(d.requestId), { ok: true, message: 'Found 1 slide in the course decks.' }));
    expect(await findCourseDocument({ query: 'raft' }, ok.ctx)).toEqual({ content: [{ type: 'text', text: 'Found 1 slide in the course decks.' }] });
    const no = context({}, (d) => answerFile(String(d.requestId), { ok: false, message: 'Give a few words about the topic to look for.' }));
    expect(await findCourseDocument({ query: '' }, no.ctx)).toEqual({ content: [{ type: 'text', text: 'Give a few words about the topic to look for.' }], isError: true });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps an answer up to the host\'s cap, and not past it', async () => {
    const a = context({}, (d) => answerFile(String(d.requestId), { ok: true, message: 'y'.repeat(LIBRARY_ANSWER_CHARS + 300) }));
    expect((await findCourseDocument({ query: 'x' }, a.ctx)).content[0].text).toHaveLength(LIBRARY_ANSWER_CHARS);
  });

  it('says honestly that it got no answer in the time it waits, and that it cannot claim to know what the slides say', async () => {
    const { ctx, clock: c } = context();
    expect(await findCourseDocument({ query: 'raft' }, ctx)).toEqual({ content: [{ type: 'text', text: COURSE_DOCS_UNCONFIRMED }] });
    expect(COURSE_DOCS_UNCONFIRMED).toMatch(/did not answer within 10 seconds/);
    expect(COURSE_DOCS_UNCONFIRMED).toMatch(/do not claim to know what the slides say/);
    expect(c.sleeps() * 150).toBeGreaterThanOrEqual(COURSE_DOCS_NUMBERS.requestWaitMs);
  });

  it('says it could not read an answer that is there but is not one, and says so when the request could not be written, without waiting', async () => {
    const bad = context({}, (d) => answerFile(String(d.requestId), 'not json at all'));
    expect(await findCourseDocument({ query: 'raft' }, bad.ctx)).toEqual({ content: [{ type: 'text', text: COURSE_DOCS_UNREADABLE }], isError: true });
    const { ctx, clock: c } = context({
      writeTask: () => {
        throw new Error('EACCES');
      },
    });
    expect(await findCourseDocument({ query: 'raft' }, ctx)).toEqual({ content: [{ type: 'text', text: COURSE_DOCS_NOT_SENT }], isError: true });
    expect(c.sleeps()).toBe(0);
  });
});

describe('where it refuses by itself', () => {
  it('refuses in a scheduled task before it counts a use or writes anything', async () => {
    const { ctx, written, used, clock: c } = context({ scheduled: true });
    expect(await findCourseDocument({ query: 'raft' }, ctx)).toEqual({ content: [{ type: 'text', text: COURSE_DOCS_NOT_IN_TASK }], isError: true });
    expect(written).toEqual([]);
    expect(used.limit).toBe(0);
    expect(c.sleeps()).toBe(0);
  });

  it('refuses in a voice call\'s tool host (the call has its own function) before it counts a use or writes anything', async () => {
    const { ctx, written, used } = context({ toolHost: true });
    expect(await findCourseDocument({ query: 'raft' }, ctx)).toEqual({ content: [{ type: 'text', text: COURSE_DOCS_NOT_IN_CALL }], isError: true });
    expect(written).toEqual([]);
    expect(used.limit).toBe(0);
  });

  it('refuses a ninth search in a conversation in the limiter\'s own words and writes nothing', async () => {
    const limiter = new ToolLimiter(TOOL_LIMITS);
    const { ctx, written } = context({ limit: () => limiter.check('find_course_document') }, (d) => answerFile(String(d.requestId), { ok: true, message: 'found' }));
    for (let i = 0; i < 8; i++) expect((await findCourseDocument({ query: `t${i}` }, ctx)).isError).toBeUndefined();
    expect(await findCourseDocument({ query: 'one more' }, ctx)).toEqual({ content: [{ type: 'text', text: 'Rate limit exceeded for find_course_document: max 8 calls per session.' }], isError: true });
    expect(written).toHaveLength(8);
  });
});

describe('the registration in the MCP server (its text: the file starts a server when imported)', () => {
  const server = fs.readFileSync(new URL('../src/ipc-mcp-stdio.ts', import.meta.url), 'utf-8');
  const toolText = (name: string) => {
    const start = server.indexOf(`server.tool(\n  '${name}'`);
    const next = server.indexOf('server.tool(', start + 20);
    return server.slice(start, next === -1 ? undefined : next);
  };

  it('registers find_course_document with its description, one string argument, the limit by its name, and the host\'s own request folder', () => {
    const tool = toolText('find_course_document');
    expect(tool).toContain('FIND_COURSE_DOCUMENT_DESCRIPTION');
    expect(tool).toContain('query: z.string()');
    expect(tool).toContain("checkRateLimit('find_course_document')");
    expect(tool).toContain('scheduled: accessFlags.isScheduledTask');
    expect(tool).toContain("toolHost: process.env.TAI_MODE === 'tool-host'");
    expect(tool).toContain('writeIpcFile(TASKS_DIR');
    expect(tool).toContain('resultsDir: RESULTS_DIR');
  });

  it('says in show_document\'s argument that a PDF, PowerPoint, Word or Excel file can be named, and a deck of the library', () => {
    const tool = toolText('show_document');
    expect(tool).toContain('a deck of the course library');
    expect(tool).toContain('PDF, PowerPoint, Word or Excel file');
  });
});

describe('with the host\'s real verb', () => {
  const ID = (c: string): string => c.repeat(32).slice(0, 32);
  const entry: LibraryEntry = { id: ID('a'), title: 'Week 5 - Raft', week: 5, sourceName: 'raft.pptx', sha256: 'a'.repeat(64), pages: 32, origin: 'course', createdAt: 1, bytes: 1 };
  const hit: LibraryHit = { id: ID('a'), title: 'Week 5 - Raft', week: 5, page: 7, pages: 32, snippet: 'Randomized election timeouts keep two candidates from splitting the vote.' };

  it('gets the slides that matched, as the host wrote them, through the answer file', async () => {
    const searched: string[] = [];
    const docs = { library: () => [entry], searchLibrary: (q: string) => (searched.push(q), [hit]) } as unknown as DocsApi;
    const { ctx } = context({}, (data) =>
      handleCourseDocFind(
        { folder: 's_ada', isMain: false, requestId: String(data.requestId), request: data.request, group: {} },
        { docs, say: (requestId, ok, message) => answerFile(requestId, { ok, message }), audit: () => undefined, log: { warn: () => undefined } },
      ),
    );
    const reply = await findCourseDocument({ query: 'leader election' }, ctx);
    expect(searched).toEqual(['leader election']);
    expect(reply.isError).toBeUndefined();
    expect(reply.content[0].text).toContain('Found 1 slide in the course decks.');
    expect(reply.content[0].text).toContain('1. "Week 5 - Raft" (week 5), page 7 of 32: "Randomized election timeouts keep two candidates from splitting the vote."');
    expect(reply.content[0].text).toContain('call show_document with the title exactly as listed and the page');
  });

  it('gets the host\'s refusal of an empty search as an error result', async () => {
    const docs = { library: () => [entry], searchLibrary: () => [hit] } as unknown as DocsApi;
    const { ctx } = context({}, (data) =>
      handleCourseDocFind(
        { folder: 's_ada', isMain: false, requestId: String(data.requestId), request: data.request, group: {} },
        { docs, say: (requestId, ok, message) => answerFile(requestId, { ok, message }), audit: () => undefined, log: { warn: () => undefined } },
      ),
    );
    const reply = await findCourseDocument({ query: '   ' }, ctx);
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toMatch(/few words about the topic/);
  });
});
