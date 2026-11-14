/**
 * The logic of the `course-docs` commands of tai_live.sh (docs/COURSE_DOCS.md), kept apart from the entry file (src/docs/course-docs.ts) so that it is tested with a fake renderer and a fake Canvas:
 *
 *   add --dir DIR [--title T] [--week N]     renders every PDF, PowerPoint, Word and Excel file under DIR (shipped to the host by the PC side) into the library; a file whose SHA-256 is in the index is skipped
 *   list                                     the library: id, week, pages, title, source name
 *   remove ID                                takes a deck out (the id, or the first six or more characters of it)
 *   rename ID [--title T] [--week N|none]    changes a deck's title and/or week (the title is what students and TAi call it by: it must not be another deck's)
 *   canvas [--course ID] [--yes] [--allow-host H]
 *                                            lists the course's files on Canvas (name, size, type, week); with --yes downloads each (at most 20 MB, never to a host that is not Canvas' own) and adds it
 *
 * A library entry is course material shown to EVERY student: it is the operator's to keep clear of solutions to graded assignments. Nothing here looks at what a deck says. The Canvas token comes from the
 * environment of the process (the shell reads it from the host's env file by name and passes it that way, never on a command line) and is never printed or logged.
 */
import fs from 'node:fs';
import path from 'node:path';

import { readBytesSafe } from '../safe-fs.js';
import { downloadCanvasFile, hostsOf, listCanvasFiles, parseBase } from './canvas-files.js';
import type { CanvasOptions } from './canvas-files.js';
import { createLibraryAdmin } from './library.js';
import { cleanWeek, titleKey } from './library-index.js';
import type { Renderer } from './render.js';
import type { DocStore } from './store.js';
import { DOC_LIMITS, LIBRARY_LIMITS } from './types.js';

export interface CliDeps {
  store: DocStore;
  renderer: Renderer;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Tests: the clock for the Canvas download (ms per file). */
  canvasWallMs?: number;
}

export const USAGE = [
  'tai_live.sh course-docs add <file-or-directory> [--title T] [--week N]',
  'tai_live.sh course-docs list',
  'tai_live.sh course-docs remove <id>',
  'tai_live.sh course-docs rename <id> [--title T] [--week N|none]',
  'tai_live.sh course-docs canvas [--course ID] [--yes] [--allow-host HOST]',
].join('\n');

const DOCUMENT = /\.(?:pdf|pptx|docx|xlsx)$/i;
const MAX_FILES = 200;
const MAX_DEPTH = 3;

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const secs = (ms: number | undefined): string => (ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`);

interface Flags {
  positional: string[];
  values: Record<string, string[]>;
  switches: Set<string>;
}

/** `--name value` pairs and `--switch` flags; anything unknown is a usage error (null). */
function parseFlags(args: readonly string[], valued: readonly string[], switches: readonly string[]): Flags | null {
  const out: Flags = { positional: [], values: {}, switches: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return null;
      (out.values[a] ??= []).push(v);
      i++;
    } else if (switches.includes(a)) {
      out.switches.add(a);
    } else if (a.startsWith('--')) {
      return null;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

/** The documents under a directory (regular files only, no link followed), shallow first, sorted by path. */
export function documentsUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number): void => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = names.filter((e) => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    // the files of a directory before the directories in it
    for (const entry of sorted) {
      if (found.length >= MAX_FILES) return;
      if (entry.isFile() && DOCUMENT.test(entry.name)) found.push(path.join(current, entry.name));
    }
    for (const entry of sorted) {
      if (found.length >= MAX_FILES) return;
      if (entry.isDirectory() && depth < MAX_DEPTH) walk(path.join(current, entry.name), depth + 1);
    }
  };
  walk(dir, 0);
  return found;
}

export async function runCourseDocs(args: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = args;
  const admin = createLibraryAdmin({ store: deps.store, renderer: deps.renderer });
  const { out, err } = deps;

  if (command === 'list' && rest.length === 0) {
    const entries = admin.list();
    if (entries.length === 0) out('the course library is empty (tai_live.sh course-docs add <file-or-directory>)');
    for (const e of entries) out(`${e.id.slice(0, 8)}  week ${e.week ?? '-'}  ${String(e.pages).padStart(3)} page(s)  ${JSON.stringify(e.title)}  (from ${JSON.stringify(e.sourceName)})`);
    const pages = entries.reduce((n, e) => n + e.pages, 0);
    out(`library: ${entries.length} deck(s), ${pages} page(s), ${mb(entries.reduce((n, e) => n + e.bytes, 0))}`);
    return 0;
  }

  if (command === 'remove') {
    if (rest.length !== 1) {
      err(USAGE);
      return 2;
    }
    const r = admin.remove(rest[0]);
    if (r.ok) {
      out(`removed ${JSON.stringify(r.title)}`);
      return 0;
    }
    err(r.message);
    return 1;
  }

  if (command === 'rename') {
    const flags = parseFlags(rest, ['--title', '--week'], []);
    const titles = flags?.values['--title'] ?? [];
    const weeks = flags?.values['--week'] ?? [];
    if (!flags || flags.positional.length !== 1 || titles.length > 1 || weeks.length > 1 || titles.length + weeks.length === 0) {
      err(USAGE);
      return 2;
    }
    let week: number | null | undefined;
    if (weeks.length === 1) {
      const text = weeks[0].trim();
      if (text.toLowerCase() === 'none') week = null;
      else if (/^[0-9]{1,2}$/.test(text) && cleanWeek(Number(text)) !== null) week = Number(text);
      else {
        err(`--week is a number from 1 to ${LIBRARY_LIMITS.maxWeek}, or none`);
        return 2;
      }
    }
    const r = admin.rename(flags.positional[0], { ...(titles.length === 1 ? { title: titles[0] } : {}), ...(week !== undefined ? { week } : {}) });
    if (!r.ok) {
      err(r.message);
      return 1;
    }
    const show = (title: string, w: number | null): string => `${JSON.stringify(title)} (week ${w ?? '-'})`;
    out(r.changed ? `renamed ${r.entry.id.slice(0, 8)}: ${show(r.before.title, r.before.week)} -> ${show(r.entry.title, r.entry.week)}` : `nothing to change: ${r.entry.id.slice(0, 8)} is ${show(r.entry.title, r.entry.week)} already`);
    return 0;
  }

  if (command === 'add') {
    const flags = parseFlags(rest, ['--dir', '--title', '--week'], []);
    if (!flags || flags.positional.length > 0 || flags.values['--dir']?.length !== 1 || (flags.values['--title']?.length ?? 0) > 1 || (flags.values['--week']?.length ?? 0) > 1) {
      err(USAGE);
      return 2;
    }
    const dir = path.resolve(flags.values['--dir'][0]);
    const title = flags.values['--title']?.[0];
    const weekText = flags.values['--week']?.[0];
    const week = weekText === undefined ? undefined : /^\d{1,2}$/.test(weekText) ? cleanWeek(Number(weekText)) : null;
    if (week === null) {
      err(`--week is a number from 1 to ${LIBRARY_LIMITS.maxWeek}`);
      return 2;
    }
    const files = documentsUnder(dir);
    if (files.length === 0) {
      err('there is no PDF, PowerPoint, Word or Excel file to add');
      return 1;
    }
    if (title !== undefined && files.length > 1) {
      err('--title names one deck: give it when adding one file');
      return 2;
    }
    let failed = 0;
    for (const file of files) {
      const name = path.basename(file);
      const bytes = readBytesSafe(file, DOC_LIMITS.sourceBytes, dir);
      if (!bytes) {
        failed++;
        err(`FAILED ${name}: not a regular file, or over ${mb(DOC_LIMITS.sourceBytes)}`);
        continue;
      }
      const r = await admin.add({ bytes, name, ...(title !== undefined ? { title } : {}), ...(week !== undefined ? { week } : {}) });
      if (!r.ok) {
        failed++;
        err(`FAILED ${name}: ${r.message}`);
      } else if (r.status === 'already') {
        out(`already in the library: ${JSON.stringify(r.entry.title)} (id ${r.entry.id.slice(0, 8)}): ${name} was not added again`);
      } else {
        const e = r.entry;
        out(`added ${JSON.stringify(e.title)}: week ${e.week ?? '-'}, ${e.pages} page(s)${e.pagesInFile ? ` of ${e.pagesInFile}` : ''}, id ${e.id.slice(0, 8)} (${secs(r.timing.totalMs)}${r.timing.convertMs !== undefined ? `, conversion ${secs(r.timing.convertMs)}` : ''})`);
      }
    }
    return failed > 0 ? 1 : 0;
  }

  if (command === 'canvas') {
    const flags = parseFlags(rest, ['--course', '--allow-host'], ['--yes']);
    if (!flags || flags.positional.length > 0 || (flags.values['--course']?.length ?? 0) > 1) {
      err(USAGE);
      return 2;
    }
    const course = flags.values['--course']?.[0] ?? deps.env.CANVAS_COURSE_ID ?? '';
    const allowHosts = flags.values['--allow-host'] ?? [];
    if (allowHosts.some((h) => !/^[a-z0-9.-]{3,100}$/i.test(h) || !h.includes('.'))) {
      err('--allow-host is a host name such as files.example.com');
      return 2;
    }
    const base = deps.env.CANVAS_BASE_URL ?? '';
    const token = deps.env.CANVAS_API_TOKEN ?? '';
    if (!parseBase(base)) {
      err('the Canvas address stored on this host is not an https address with a host name: tai_credentials.sh canvas stores it');
      return 1;
    }
    const options: CanvasOptions = { base, token, course, fetchImpl: deps.fetchImpl, allowHosts, maxBytes: DOC_LIMITS.sourceBytes, wallMs: deps.canvasWallMs ?? 120_000 };
    const listing = await listCanvasFiles({ ...options, wallMs: 60_000 });
    if (!listing.ok) {
      err(listing.message);
      return 1;
    }
    const files = listing.files;
    const known = new Set(deps.store.library().map((e) => titleKey(e.sourceName)));
    out(`Canvas course ${course}: ${files.length} file(s) that are PDF, PowerPoint, Word or Excel${listing.modules ? ` (${listing.modules} module(s) read for weeks)` : ''}`);
    if (listing.via === 'modules') out("(this account cannot list the course's files: these are the ones in the course's modules that it can read)");
    for (const f of files) out(`  ${f.name}  |  ${mb(f.size)}  |  ${f.kind}  |  week ${f.week ?? '-'}  |  ${f.skip ? `skipped: ${f.skip}` : known.has(titleKey(f.name)) ? 'in the library (same name)' : 'new'}`);
    if (!flags.switches.has('--yes')) {
      out(files.some((f) => !f.skip) ? 'Nothing was downloaded. To add them to the library (every student sees what is added): tai_live.sh course-docs canvas --yes' : 'Nothing to add.');
      return 0;
    }

    const hosts = hostsOf(files);
    let failed = 0;
    for (const f of files) {
      if (f.skip) continue;
      const d = await downloadCanvasFile(options, f, hosts);
      if (!d.ok) {
        failed++;
        err(`FAILED ${f.name}: ${d.message}`);
        continue;
      }
      const r = await admin.add({ bytes: d.bytes, name: f.name, week: f.week });
      if (!r.ok) {
        failed++;
        err(`FAILED ${f.name}: ${r.message}`);
      } else if (r.status === 'already') {
        out(`already in the library: ${JSON.stringify(r.entry.title)} (id ${r.entry.id.slice(0, 8)})`);
      } else {
        out(`added ${JSON.stringify(r.entry.title)}: week ${r.entry.week ?? '-'}, ${r.entry.pages} page(s), id ${r.entry.id.slice(0, 8)} (${secs(r.timing.totalMs)})`);
      }
    }
    return failed > 0 ? 1 : 0;
  }

  err(USAGE);
  return 2;
}
