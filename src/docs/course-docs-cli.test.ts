import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { USAGE, documentsUnder, runCourseDocs } from './course-docs-cli.js';
import type { CliDeps } from './course-docs-cli.js';
import { createRenderer } from './render.js';
import { DocStore } from './store.js';
import { FakeDocker, pdfBytes, writeOutput } from './testing/harness.js';

const TOKEN = 'canvas-token-1234567890-SECRET';
const idOf = (n: number): string => n.toString(16).padStart(32, '0');
const zip = (extra = 300): Buffer => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]), Buffer.alloc(extra, 5)]);

let dir: string;
let incoming: string;
let docker: FakeDocker;
let store: DocStore;
let counter: number;
let out: string[];
let err: string[];
let fetches: Array<{ url: string; auth?: string }>;
let canvas: (url: string) => Response;
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

function deps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    store,
    renderer: createRenderer({ dir: path.join(dir, 'data'), log, docker, hostUser: { uid: 1000, gid: 1000 }, operator: true }),
    env: { CANVAS_BASE_URL: 'https://canvas.example.edu/api/v1', CANVAS_COURSE_ID: '260797', CANVAS_API_TOKEN: TOKEN },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetches.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      return canvas(url);
    }) as typeof fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
}
const run = (...args: string[]) => runCourseDocs(args, deps());
const text = (): string => `${out.join('\n')}\n${err.join('\n')}`;
const json = (body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const listed = (id: number, name: string, size: number, extra: Record<string, unknown> = {}) => ({ id, display_name: name, 'content-type': 'application/pdf', size, url: `https://canvas.example.edu/files/${id}/download?download_frd=1&verifier=ONETIMEKEY${id}`, ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-cli-'));
  incoming = path.join(dir, 'incoming');
  fs.mkdirSync(incoming);
  docker = new FakeDocker();
  docker.behave = async (ctl) => {
    writeOutput(ctl.outDir, 3, { inFile: 3 });
    ctl.write('doc-conv 900\n');
    return { exitCode: 0, startedAtMs: 1000, finishedAtMs: 2500 };
  };
  counter = 0;
  store = new DocStore(path.join(dir, 'store'), { newId: () => idOf(++counter), log });
  out = [];
  err = [];
  fetches = [];
  canvas = () => json([]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('add', () => {
  it('renders every document under the directory into the library and says what it added, with the week and the pages', async () => {
    fs.writeFileSync(path.join(incoming, 'Week_5_Raft.pptx'), zip());
    fs.writeFileSync(path.join(incoming, 'syllabus.pdf'), pdfBytes(100, 2));
    fs.mkdirSync(path.join(incoming, 'extra'));
    fs.writeFileSync(path.join(incoming, 'extra', 'W7 notes.docx'), zip(500));
    fs.writeFileSync(path.join(incoming, 'readme.txt'), 'not a document by name');
    fs.writeFileSync(path.join(incoming, '.hidden.pdf'), pdfBytes(100, 3));
    expect(await run('add', '--dir', incoming)).toBe(0);
    expect(out.filter((l) => l.startsWith('added '))).toHaveLength(3);
    expect(out.join('\n')).toContain('added "Week 5 Raft": week 5, 3 page(s), id 00000000');
    expect(out.join('\n')).toContain('conversion 0.9 s');
    expect(store.library().map((e) => [e.title, e.week])).toEqual([['Week 5 Raft', 5], ['W7 notes', 7], ['syllabus', null]]);
    expect(docker.specs.map((s) => s.args.at(-3))).toEqual(['pdf', 'office', 'office']); // (the files of the directory first, then the directories in it)
  });

  it('skips a file whose SHA-256 is in the index and says so, and adds only what is new', async () => {
    fs.writeFileSync(path.join(incoming, 'a.pdf'), pdfBytes(100, 1));
    expect(await run('add', '--dir', incoming)).toBe(0);
    fs.writeFileSync(path.join(incoming, 'copy-of-a.pdf'), pdfBytes(100, 1));
    fs.writeFileSync(path.join(incoming, 'b.pdf'), pdfBytes(100, 2));
    out = [];
    expect(await run('add', '--dir', incoming)).toBe(0);
    expect(out.filter((l) => l.startsWith('already in the library'))).toHaveLength(2);
    expect(out.filter((l) => l.startsWith('added '))).toEqual([expect.stringContaining('"b"')]);
    expect(store.library()).toHaveLength(2);
    expect(docker.specs).toHaveLength(2);
  });

  it('takes a title and a week for one file, and refuses a title for several', async () => {
    fs.writeFileSync(path.join(incoming, 'x.pdf'), pdfBytes(100, 1));
    expect(await run('add', '--dir', incoming, '--title', 'Raft: the paper', '--week', '9')).toBe(0);
    expect(store.library()[0]).toMatchObject({ title: 'Raft: the paper', week: 9 });
    fs.writeFileSync(path.join(incoming, 'y.pdf'), pdfBytes(100, 2));
    out = [];
    expect(await run('add', '--dir', incoming, '--title', 'One title')).toBe(2);
    expect(err.join('\n')).toContain('--title names one deck');
    expect(store.library()).toHaveLength(1);
  });

  it('says what went wrong for a file and goes on with the others, and ends with a failure code', async () => {
    fs.writeFileSync(path.join(incoming, 'fine.pdf'), pdfBytes(100, 1));
    fs.writeFileSync(path.join(incoming, 'broken.pdf'), 'plain text with a .pdf name');
    fs.writeFileSync(path.join(incoming, 'empty.pptx'), '');
    expect(await run('add', '--dir', incoming)).toBe(1);
    expect(err.join('\n')).toContain('FAILED broken.pdf: not a PDF, PowerPoint, Word or Excel file');
    expect(err.join('\n')).toContain('FAILED empty.pptx:');
    expect(out.join('\n')).toContain('added "fine"');
  });

  it('refuses what it does not understand with the usage and the code for it, and a directory with nothing to add', async () => {
    for (const args of [['add'], ['add', incoming], ['add', '--dir'], ['add', '--dir', incoming, '--week', 'x'], ['add', '--dir', incoming, '--week', '0'], ['add', '--dir', incoming, '--week', '31'], ['add', '--dir', incoming, '--frobnicate', 'x'], ['add', '--dir', incoming, '--dir', incoming]]) {
      err = [];
      expect(await run(...args), args.join(' ')).toBe(2);
    }
    expect(err.join('\n')).toContain('course-docs add <file-or-directory>');
    err = [];
    expect(await run('add', '--dir', incoming)).toBe(1);
    expect(err.join('\n')).toContain('there is no PDF, PowerPoint, Word or Excel file to add');
    expect(docker.specs).toEqual([]);
  });

  it('finds documents shallow first, never through a link, never a hidden one, at most 200', () => {
    fs.writeFileSync(path.join(incoming, 'b.pdf'), 'x');
    fs.writeFileSync(path.join(incoming, 'A.PPTX'), 'x');
    fs.writeFileSync(path.join(incoming, 'c.xlsx'), 'x');
    fs.writeFileSync(path.join(incoming, 'old.ppt'), 'x');
    fs.mkdirSync(path.join(incoming, 'sub', 'deeper', 'deepest', 'too-deep'), { recursive: true });
    fs.writeFileSync(path.join(incoming, 'sub', 'd.docx'), 'x');
    fs.writeFileSync(path.join(incoming, 'sub', 'deeper', 'deepest', 'e.pdf'), 'x');
    fs.writeFileSync(path.join(incoming, 'sub', 'deeper', 'deepest', 'too-deep', 'f.pdf'), 'x');
    try {
      fs.symlinkSync(path.join(incoming, 'b.pdf'), path.join(incoming, 'link.pdf'));
    } catch {
      /* a platform that does not let this user make links */
    }
    const found = documentsUnder(incoming).map((f) => path.relative(incoming, f).split(path.sep).join('/'));
    expect(found).toEqual(['A.PPTX', 'b.pdf', 'c.xlsx', 'sub/d.docx', 'sub/deeper/deepest/e.pdf']);
    const many = path.join(dir, 'many');
    fs.mkdirSync(many);
    for (let i = 0; i < 230; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.pdf`), 'x');
    expect(documentsUnder(many)).toHaveLength(200);
  });
});

describe('list and remove', () => {
  it('lists the library, shortening the ids, and says when it is empty', async () => {
    expect(await run('list')).toBe(0);
    expect(out[0]).toContain('the course library is empty');
    fs.writeFileSync(path.join(incoming, 'Week 5 Raft.pdf'), pdfBytes(100, 1));
    await run('add', '--dir', incoming);
    out = [];
    expect(await run('list')).toBe(0);
    expect(out[0]).toBe('00000000  week 5    3 page(s)  "Week 5 Raft"  (from "Week 5 Raft.pdf")');
    expect(out[1]).toMatch(/^library: 1 deck\(s\), 3 page\(s\), [\d.]+ MB$/);
    expect(await run('list', 'extra')).toBe(2);
  });

  it('removes a deck by its id or the start of it, and says what it did', async () => {
    fs.writeFileSync(path.join(incoming, 'a.pdf'), pdfBytes(100, 1));
    await run('add', '--dir', incoming);
    out = [];
    err = [];
    expect(await run('remove', 'zzzzzz')).toBe(1);
    expect(err[0]).toContain('give the id of a deck');
    expect(await run('remove', 'abcdef')).toBe(1);
    expect(err[1]).toBe('no deck of the library has that id');
    expect(await run('remove', idOf(1).slice(0, 8))).toBe(0);
    expect(out).toEqual(['removed "a"']);
    expect(store.library()).toEqual([]);
    expect(await run('remove')).toBe(2);
    expect(await run('remove', 'a', 'b')).toBe(2);
  });
});

describe('rename', () => {
  it('changes the title and the week of a deck and says what they were and what they are now', async () => {
    fs.writeFileSync(path.join(incoming, 'day5-apis.pdf'), pdfBytes(100, 1));
    await run('add', '--dir', incoming);
    out = [];
    err = [];
    expect(await run('rename', idOf(1).slice(0, 8), '--title', 'Day 5 - APIs and Load Balancers', '--week', '5')).toBe(0);
    expect(out).toEqual(['renamed 00000000: "day5-apis" (week -) -> "Day 5 - APIs and Load Balancers" (week 5)']);
    expect(store.library().map((e) => [e.title, e.week])).toEqual([['Day 5 - APIs and Load Balancers', 5]]);
    out = [];
    expect(await run('rename', idOf(1), '--week', 'none')).toBe(0);
    expect(out).toEqual(['renamed 00000000: "Day 5 - APIs and Load Balancers" (week 5) -> "Day 5 - APIs and Load Balancers" (week -)']);
    out = [];
    expect(await run('rename', idOf(1), '--title', 'Day 5 - APIs and Load Balancers')).toBe(0);
    expect(out).toEqual(['nothing to change: 00000000 is "Day 5 - APIs and Load Balancers" (week -) already']);
    expect(err).toEqual([]);
  });

  it('says in words why it did not, and refuses what it does not understand with the usage and the code for it', async () => {
    fs.writeFileSync(path.join(incoming, 'a.pdf'), pdfBytes(100, 1));
    fs.writeFileSync(path.join(incoming, 'b.pdf'), pdfBytes(100, 2));
    await run('add', '--dir', incoming);
    out = [];
    err = [];
    expect(USAGE).toContain('tai_live.sh course-docs rename <id> [--title T] [--week N|none]');
    expect(await run('rename', 'zzzzzz', '--title', 'x')).toBe(1);
    expect(err.at(-1)).toContain('give the id of a deck');
    expect(await run('rename', 'abcdef', '--title', 'x')).toBe(1);
    expect(err.at(-1)).toBe('no deck of the library has that id');
    expect(await run('rename', idOf(1), '--title', 'B')).toBe(1);
    expect(err.at(-1)).toContain('a title of its own');
    expect(await run('rename', idOf(1), '--title', '   ')).toBe(1);
    expect(err.at(-1)).toBe('the title is empty');
    err = [];
    for (const args of [['rename'], ['rename', idOf(1)], ['rename', idOf(1), '--title'], ['rename', idOf(1), '--title', 'a', '--title', 'b'], ['rename', idOf(1), idOf(2), '--title', 'x'], ['rename', idOf(1), '--colour', 'red']]) {
      expect(await run(...args), args.join(' ')).toBe(2);
      expect(err.at(-1)).toBe(USAGE);
      err = [];
    }
    for (const week of ['0', '31', '5.5', 'abc', '-1', '']) {
      expect(await run('rename', idOf(1), '--week', week), `week ${week}`).toBe(2);
      expect(err.at(-1)).toBe('--week is a number from 1 to 30, or none');
    }
    expect(store.library().map((e) => e.title)).toEqual(['a', 'b']); // and nothing was changed
  });
});

describe('canvas', () => {
  const course = (listing: unknown[]) => (url: string): Response => (url.includes('/modules') ? json([{ name: 'Week 8', items: [{ type: 'File', content_id: 3 }] }]) : url.includes('/files?') ? json(listing) : new Response(PDF_BYTES, { status: 200 }));
  const PDF_BYTES = pdfBytes(300, 7);

  it('lists the files with name, size, type and week and downloads NOTHING without --yes, and prints no token and no address of a file', async () => {
    canvas = course([listed(1, 'Week 5 - Raft.pdf', 5_000_000), listed(2, 'Syllabus.pdf', 1_000_000), listed(3, 'Consistency.pdf', 2_500_000), listed(4, 'hidden.pdf', 1000, { hidden: true }), listed(5, 'big.pdf', 40_000_000)]);
    expect(await run('canvas')).toBe(0);
    const lines = out.join('\n');
    expect(lines).toContain('Canvas course 260797: 5 file(s) that are PDF, PowerPoint, Word or Excel (1 module(s) read for weeks)');
    expect(lines).toContain('  Week 5 - Raft.pdf  |  4.8 MB  |  pdf  |  week 5  |  new');
    expect(lines).toContain('  Consistency.pdf  |  2.4 MB  |  pdf  |  week 8  |  new');
    expect(lines).toContain('  hidden.pdf  |  0.0 MB  |  pdf  |  week -  |  skipped: hidden or locked for students');
    expect(lines).toContain('  big.pdf  |  38.1 MB  |  pdf  |  week -  |  skipped: over 20 MB');
    expect(lines).toContain('Nothing was downloaded.');
    expect(fetches.every((f) => f.url.includes('/files?') || f.url.includes('/modules'))).toBe(true);
    expect(fetches.every((f) => f.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(docker.specs).toEqual([]);
    expect(store.library()).toEqual([]);
    for (const secret of [TOKEN, 'ONETIMEKEY', 'verifier', 'download_frd']) expect(text()).not.toContain(secret);
  });

  it('marks a file the library already has by its name, and uses the course id it is given over the stored one', async () => {
    fs.writeFileSync(path.join(incoming, 'Week 5 - Raft.pdf'), pdfBytes(100, 1));
    await run('add', '--dir', incoming);
    out = [];
    canvas = course([listed(1, 'Week 5 - Raft.pdf', 1000), listed(2, 'Other.pdf', 1000)]);
    expect(await run('canvas', '--course', '12345')).toBe(0);
    expect(out.join('\n')).toContain('Canvas course 12345');
    expect(out.join('\n')).toContain('week 5  |  in the library (same name)');
    expect(fetches[0].url).toContain('/courses/12345/files');
  });

  it('downloads each file with --yes and adds it (the same file is not added twice), and the token goes to Canvas\' host only', async () => {
    canvas = course([listed(1, 'Week 5 - Raft.pdf', 1000), listed(2, 'Copy of Raft.pdf', 1000), listed(4, 'hidden.pdf', 1000, { hidden: true })]);
    expect(await run('canvas', '--yes')).toBe(0);
    expect(out.filter((l) => l.startsWith('added '))).toEqual([expect.stringContaining('"Week 5 - Raft": week 5')]);
    expect(out.filter((l) => l.startsWith('already in the library'))).toHaveLength(1);
    expect(store.library()).toHaveLength(1);
    const downloads = fetches.filter((f) => f.url.includes('/download'));
    expect(downloads).toHaveLength(2); // the hidden one was not asked for
    expect(downloads.every((d) => d.url.startsWith('https://canvas.example.edu/'))).toBe(true);
    for (const secret of [TOKEN, 'ONETIMEKEY', 'verifier']) expect(text()).not.toContain(secret);
  });

  it('says which download failed and why, never to where it was sent without the host\'s name, and goes on', async () => {
    canvas = (url) => {
      if (url.includes('/modules')) return json([]);
      if (url.includes('/files?')) return json([listed(1, 'moved.pdf', 1000), listed(2, 'fine.pdf', 1000)]);
      if (url.includes('/files/1/')) return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal?x=1' } });
      return new Response(PDF_BYTES, { status: 200 });
    };
    expect(await run('canvas', '--yes')).toBe(1);
    expect(err.join('\n')).toContain('FAILED moved.pdf: Canvas sent the download to evil.example.com');
    expect(out.join('\n')).toContain('added "fine"');
    expect(fetches.some((f) => f.url.includes('evil.example.com'))).toBe(false);
    expect(text()).not.toContain(TOKEN);
    // the operator may say a host is fine
    err = [];
    out = [];
    canvas = (url) => {
      if (url.includes('/modules')) return json([]);
      if (url.includes('/files?')) return json([listed(1, 'moved.pdf', 1000)]);
      if (url.includes('/files/1/')) return new Response(null, { status: 302, headers: { location: 'https://files.school.example/x' } });
      return new Response(PDF_BYTES, { status: 200 });
    };
    expect(await run('canvas', '--yes', '--allow-host', 'files.school.example')).toBe(0);
    expect(fetches.at(-1)?.auth).toBeUndefined();
  });

  it('says what is missing when the address or the token is not stored, and refuses a host to allow that is not a host name', async () => {
    expect(await runCourseDocs(['canvas'], deps({ env: {} }))).toBe(1);
    expect(err.join('\n')).toContain('tai_credentials.sh canvas');
    err = [];
    expect(await runCourseDocs(['canvas'], deps({ env: { CANVAS_BASE_URL: 'https://canvas.example.edu/api/v1', CANVAS_COURSE_ID: '1' } }))).toBe(1);
    expect(err.join('\n')).toContain('no Canvas token');
    for (const host of ['x', 'not a host', 'a;b.com', 'evil']) {
      err = [];
      expect(await run('canvas', '--allow-host', host), host).toBe(2);
    }
    expect(fetches).toEqual([]);
  });

  it('refuses a course that is not a number and a Canvas that does not answer, in words', async () => {
    expect(await run('canvas', '--course', 'abc')).toBe(1);
    expect(err.join('\n')).toContain('the course id is a number');
    err = [];
    canvas = () => new Response('nope', { status: 403 });
    expect(await run('canvas')).toBe(1);
    expect(err.join('\n')).toContain('refused the token');
    expect(text()).not.toContain(TOKEN);
  });
});

describe('what it is told', () => {
  it('answers a command it does not know, and none, with the usage and the code for it', async () => {
    expect(await run()).toBe(2);
    expect(await run('frobnicate')).toBe(2);
    expect(err.join('\n')).toBe(`${USAGE}\n${USAGE}`);
    expect(USAGE).toContain('course-docs add');
    expect(USAGE).toContain('course-docs canvas');
  });
});

describe('canvas, for an account that may not list the course\'s files', () => {
  it('lists the files of the course\'s modules and says that is where they come from', async () => {
    canvas = (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/courses/260797/files')) return new Response('{}', { status: 403 });
      if (pathname.endsWith('/users/self')) return json({ id: 7 });
      if (pathname.endsWith('/modules')) return json([{ name: 'Week 5', items: [{ type: 'File', content_id: 11 }] }]);
      if (pathname.endsWith('/files/11')) return json(listed(11, 'Raft overview.pdf', 3_000_000));
      return new Response('{}', { status: 404 });
    };
    expect(await run('canvas')).toBe(0);
    expect(out.join('\n')).toContain("(this account cannot list the course's files: these are the ones in the course's modules that it can read)");
    expect(out.join('\n')).toContain('  Raft overview.pdf  |  2.9 MB  |  pdf  |  week 5  |  new');
    expect(out.join('\n')).toContain('Nothing was downloaded.');
    for (const secret of [TOKEN, 'ONETIMEKEY', 'verifier']) expect(text()).not.toContain(secret);
  });
});
