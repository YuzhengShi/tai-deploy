/**
 * What a turn is doing, and what it looked at, for the student's page (docs/PROGRESS.md). The runner says it with progress events
 * (protocol.ts writeProgress); this file decides what to say:
 *
 *   - a coarse name for every tool call (`coarseToolName`): never an argument. The host maps it to a fixed label ("Checking Canvas") and
 *     never shows a name as it came; an upload is told from any other file only here, where the path is known;
 *   - the chips of a turn (`sourcesOf`): what canvas_query, github_query, piazza_query and query_knowledge RETURNED, read from known fields
 *     of their results, one rule per action. Never from the model's words, and a failed call shows nothing.
 *
 * Nothing here imports pi or the Agent SDK: both harnesses feed the same reporter, and the tests run without either.
 *
 * The shapes read here are the ones the scripts print (container/scripts/canvas_api.py, github_api.py, piazza_query.py) and
 * leanrag/mcp_server.py formats; test/fixtures/tool-results.json holds the real output of each for the tests.
 */

import path from 'path';
import { writeProgress, type ProgressEvent, type SourceChip, type SourceKind } from './protocol.js';

export const LABEL_MAX = 80;
export const URL_MAX = 300;
/** A call that returns up to this many things gives a chip for each of them; a longer list gives one chip, for the list. */
export const PER_CALL_MAX = 3;
const DEFAULT_WORKSPACE = '/workspace';

// --- the names of tools -----------------------------------------------------------------------------------------------------------

/** Claude Code's tool names, as pi names the same tools. */
const CLAUDE_TOOLS: Record<string, string> = {
  Read: 'read',
  WebFetch: 'web_fetch',
  Bash: 'bash',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'grep',
  Glob: 'find',
  WebSearch: 'web_search',
};

/** Whether a read is of something the student attached (the page puts attachments in /workspace/group/uploads/): every other read is TAi's own notes. */
function readsUpload(args: unknown, workspace: string): boolean {
  const a = (args && typeof args === 'object' ? args : {}) as { path?: unknown; file_path?: unknown };
  const target = typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : '';
  if (!target) return false;
  const group = path.posix.join(workspace, 'group');
  // the container's paths, whatever machine this runs on; resolve() settles "..", so uploads/../COMPETENCY.md is not an upload
  return path.posix.resolve(group, target).startsWith(`${group}/uploads/`);
}

/**
 * The name the host is told for a tool call: the tool's own name without its `mcp__<server>__` prefix (canvas_query, not
 * mcp__nanoclaw__canvas_query), Claude Code's names as pi's, and `read_upload` for a read of the student's attachment. Only characters of
 * a tool name, at most 64: what is not one is not sent.
 */
export function coarseToolName(raw: string, args: unknown, workspace: string = DEFAULT_WORKSPACE): string {
  const prefixed = /^mcp__[A-Za-z0-9_-]+?__(.+)$/.exec(raw);
  const base = prefixed ? prefixed[1] : (CLAUDE_TOOLS[raw] ?? raw);
  const name = base.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || 'tool';
  return name === 'read' && readsUpload(args, workspace) ? 'read_upload' : name;
}

// --- chips ----------------------------------------------------------------------------------------------------------------------

/** One line of at most `max` characters: control characters gone, white space collapsed, cut with an ellipsis. Only a string or a number is text. */
function oneLine(value: unknown, max = LABEL_MAX): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const flat = String(value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A link a result carried: https, short, no white space. (The host checks it again, against its own list of hosts: this only keeps rubbish off the wire.) */
function linkOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  return /^https:\/\/[^\s]+$/i.test(url) && url.length <= URL_MAX ? url : undefined;
}

function chip(kind: SourceKind, label: string, url?: string): SourceChip | null {
  return label ? { kind, label, ...(url ? { url } : {}) } : null;
}

const present = (chips: Array<SourceChip | null>): SourceChip[] => chips.filter((c): c is SourceChip => c !== null);

/** The first line of a commit message, cut short. */
const firstLine = (message: unknown, max = 60): string => oneLine(typeof message === 'string' ? message.split('\n')[0] : '', max);

/**
 * What a call that returned a list shows: a chip for each item when there are up to PER_CALL_MAX of them (those are everything the call
 * returned, so "looked at" is exact), one chip for the list when there are more. An empty list shows nothing.
 */
function listChips(data: unknown, item: (entry: Record<string, unknown>) => SourceChip | null, listing: SourceChip | null): SourceChip[] {
  if (!Array.isArray(data) || data.length === 0) return [];
  if (data.length <= PER_CALL_MAX) return present(data.map((entry) => (entry && typeof entry === 'object' ? item(entry as Record<string, unknown>) : null)));
  return listing ? [listing] : [];
}

const field = (data: unknown, name: string): unknown => (data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>)[name] : undefined);

function canvasChips(action: string, data: unknown): SourceChip[] {
  const c = (label: string, url?: unknown) => chip('canvas', oneLine(label), linkOf(url));
  const one = (label: unknown, url?: unknown): SourceChip[] => present([c(oneLine(label), url)]);
  switch (action) {
    case 'assignment_detail':
      return one(field(data, 'name'), field(data, 'html_url'));
    case 'assignments':
      return listChips(data, (a) => c(oneLine(a.name), a.html_url), c('Assignments'));
    case 'upcoming':
      return listChips(data, (a) => c(oneLine(a.name), a.html_url), c('Upcoming deadlines'));
    case 'modules':
      return Array.isArray(data) && data.length ? present([c('Course modules')]) : [];
    case 'module_items':
      return listChips(data, (i) => c(oneLine(i.title), i.html_url), c('Module items'));
    case 'pages':
      return Array.isArray(data) && data.length ? present([c('Course pages')]) : [];
    case 'page_detail':
      return one(field(data, 'title'));            // Canvas names a page by a slug: there is no address to link
    case 'syllabus':
      return typeof field(data, 'syllabus') === 'string' ? one('Syllabus') : [];
    case 'announcements':
      return listChips(data, (a) => c(oneLine(a.title)), c('Announcements'));
    case 'discussions':
      return listChips(data, (d) => c(oneLine(d.title)), c('Discussions'));
    case 'discussion_detail':
      return one(field(data, 'title'), field(data, 'html_url'));
    case 'discussion_entries':
      return Array.isArray(data) && data.length ? present([c('Discussion replies')]) : [];   // other students' words: the list, never a name
    case 'files':
      return Array.isArray(data) && data.length ? present([c('Course files')]) : [];         // a file's `url` is a signed download link: never shown
    case 'file_content':
      return one(field(data, 'display_name'));
    case 'my_grades':
      return Array.isArray(data) && data.length ? present([c('Your grades')]) : [];
    case 'student_submission':
      return data && typeof data === 'object' ? one('Your submission') : [];
    case 'grades':
      return Array.isArray(data) && data.length ? present([c('Gradebook')]) : [];
    case 'submissions':
      return Array.isArray(data) && data.length ? present([c('Submissions')]) : [];
    case 'users':
      return Array.isArray(data) && data.length ? present([c('Class list')]) : [];
    default:
      return [];
  }
}

/** "owner/repo" from the address of a commit or a pull request (https://host/owner/repo/commit/<sha>), when it is one. */
function repoOfUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : '';
  } catch {
    return '';
  }
}

function githubChips(action: string, data: unknown): SourceChip[] {
  const g = (label: string, url?: unknown) => chip('github', oneLine(label), linkOf(url));
  const one = (label: unknown, url?: unknown): SourceChip[] => present([g(oneLine(label), url)]);
  switch (action) {
    case 'list_repos':
      return listChips(data, (r) => g(oneLine(r.full_name) || oneLine(r.name), r.html_url), g('GitHub repositories'));
    case 'repo_tree': {
      // a directory is a list of names with no address; a path that is a file comes back whole, with its own
      if (Array.isArray(data)) return data.length ? present([g('Repository files')]) : [];
      return one(field(data, 'path'), field(data, 'html_url'));
    }
    case 'commits': {
      const first = Array.isArray(data) && data.length ? (data[0] as Record<string, unknown>) : null;
      const repo = repoOfUrl(first?.url);
      return listChips(data, (m) => g(`${oneLine(m.sha, 12)} ${firstLine(m.message)}`.trim(), m.url), g(repo ? `Commits in ${repo}` : 'Commits'));
    }
    case 'commit_detail': {
      const sha = field(data, 'sha');
      return one(`${typeof sha === 'string' ? oneLine(sha.slice(0, 7)) : ''} ${firstLine(field(data, 'message'))}`.trim());
    }
    case 'pull_requests':
      return listChips(data, (p) => g(`#${oneLine(p.number, 8)} ${oneLine(p.title)}`.trim(), p.html_url), g('Pull requests'));
    case 'pr_detail':
      return one(`#${oneLine(field(data, 'number'), 8)} ${oneLine(field(data, 'title'))}`.trim(), field(data, 'html_url'));
    case 'pr_reviews':
      return Array.isArray(data) && data.length ? present([g('Pull request reviews')]) : [];
    case 'check_runs':
      return Array.isArray(data) && data.length ? present([g('CI checks')]) : [];
    case 'file_content':
      return one(field(data, 'path'));
    default:
      return [];
  }
}

function piazzaChips(action: string, data: unknown): SourceChip[] {
  const p = (label: string) => chip('piazza', oneLine(label));
  const post = (entry: Record<string, unknown>) => p(`@${oneLine(entry.id, 8)} ${oneLine(entry.subject)}`.trim());
  const posts = field(data, 'posts');
  switch (action) {
    case 'get_post':
      return present([post((data && typeof data === 'object' ? data : {}) as Record<string, unknown>)]);
    case 'search':
      return listChips(posts, post, p('Piazza search results'));
    case 'recent_posts':
      return listChips(posts, post, p('Recent Piazza posts'));
    case 'get_pinned':
      return listChips(posts, post, p('Pinned Piazza posts'));
    case 'get_by_tag':
      return listChips(posts, post, p('Piazza posts by tag'));
    case 'list_tags':
      return Array.isArray(field(data, 'tags')) ? present([p('Piazza tags')]) : [];
    case 'stats':
      return field(data, 'total_posts') !== undefined ? present([p('Piazza statistics')]) : [];
    default:
      return [];
  }
}

const FILE_EXTENSION = /\.(md|txt|pdf|pptx?|docx?|html?|ipynb|py|go|java|csv|json|rst)$/i;

/** A course document as the chip names it: the file's name without its folders and its extension. */
export function sourceLabel(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return oneLine(base.replace(FILE_EXTENSION, ''));
}

/** The documents leanrag's query_knowledge lists under "Source Course Materials" (mcp_server.py: `**Source: <file>**`), in its order, each once. */
function knowledgeChips(text: string): SourceChip[] {
  const seen = new Set<string>();
  const chips: SourceChip[] = [];
  for (const match of text.matchAll(/^\*\*Source: (.+?)\*\*[ \t]*$/gm)) {
    const label = sourceLabel(match[1]);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const made = chip('course', label);
    if (made) chips.push(made);
    if (chips.length >= PER_CALL_MAX) break;
  }
  return chips;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

/** The scripts report a refusal as a JSON object with an `error` (exit 0 for a bad request, so it is a result, not a failed call). */
const isErrorBody = (data: unknown): boolean => !!data && typeof data === 'object' && !Array.isArray(data) && 'error' in (data as Record<string, unknown>);

/** The tools whose results show a chip. */
export const LOOKUP_TOOLS: readonly string[] = ['canvas_query', 'github_query', 'piazza_query', 'query_knowledge'];

/**
 * The chips one successful call of a lookup tool gives, from the text of its result. `tool` is the coarse name; `args` the call's arguments (only
 * `action` is read, to pick the rule: every label and address is the result's). A result that is not what the tool prints gives none.
 */
export function sourcesOf(tool: string, args: unknown, resultText: string): SourceChip[] {
  if (tool === 'query_knowledge') return knowledgeChips(resultText);
  if (tool !== 'canvas_query' && tool !== 'github_query' && tool !== 'piazza_query') return [];
  const data = parseJson(resultText);
  if (data === undefined || isErrorBody(data)) return [];
  const action = typeof (args as { action?: unknown } | null)?.action === 'string' ? (args as { action: string }).action : '';
  if (tool === 'canvas_query') return canvasChips(action, data);
  if (tool === 'github_query') return githubChips(action, data);
  return piazzaChips(action, data);
}

/** The text of a tool result in any of the shapes the harnesses hand over: a string, `{content: [{type: "text", text}]}`, or the blocks alone. */
export function textOfResult(result: unknown): string {
  if (typeof result === 'string') return result;
  const blocks = Array.isArray(result) ? result : Array.isArray((result as { content?: unknown } | null)?.content) ? (result as { content: unknown[] }).content : null;
  if (!blocks) return '';
  return blocks
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

// --- the reporter ---------------------------------------------------------------------------------------------------------------

export interface ReporterOptions {
  /** Where events go: the marker on stdout by default. */
  write?: (event: ProgressEvent) => void;
  /** False: says nothing (a scheduled task has no student looking at it). */
  enabled?: boolean;
  /** The container's /workspace (a test points it elsewhere). */
  workspace?: string;
  /**
   * Streaming (TAI_PORTAL_STREAM=1 in the container, docs/STREAMING.md): also say the words of the reply as the model writes them (`text` events).
   * Off (the default), the reporter never writes one: the same lines as before, byte for byte.
   */
  stream?: boolean;
  /** The clock of the throttle (a test's). */
  now?: () => number;
}

const MAX_OPEN_CALLS = 64;
/** A message longer than this is not previewed (the host looks at 4,000 at most, and a line of the protocol may be 8 KB). */
export const TEXT_CAP = 3000;
/** At most one text event this often: a reply of two sentences is a few events, not one per token. */
export const TEXT_INTERVAL_MS = 150;
/**
 * The tools that say the answer themselves: each leaves `.send_message_used` (ipc-mcp-stdio.ts markSendMessageUsed), and the host then drops the
 * turn's closing text. After one of them nothing more of the turn is streamed, as it would be a preview of words that are never sent.
 */
const SPEAKING_TOOLS: ReadonlySet<string> = new Set(['send_message', 'render_diagram', 'generate_teaching_image']);

/**
 * Turns the harness's tool events into progress events. A harness calls thinking() when a model request begins, toolStart() and toolEnd()
 * around every tool call (several may be open at once: pi runs them side by side, and a tool_execution_end comes in the order they finish),
 * and beginTurn() when a new message is being answered. It never throws and never blocks the turn.
 */
export class ProgressReporter {
  private readonly write: (event: ProgressEvent) => void;
  private readonly enabled: boolean;
  private readonly workspace: string;
  private seq = 0;
  private readonly open = new Map<string, { name: string; args: unknown; seq: number }>();
  private readonly sent = new Set<string>();
  // streaming (docs/STREAMING.md): the assistant message being written
  private readonly stream: boolean;
  private readonly now: () => number;
  /** The number of the assistant message: it goes up for every message over the container's whole life, so the host never sees it go back. */
  private msgN = 0;
  private msgOpen = false;
  private msgText = '';
  /** This message says no more: it called a tool, or it was too long. */
  private msgShut = false;
  /** A text event with words in it was sent for this message (so a clear is worth sending). */
  private emitted = false;
  private lastTextAt = 0;
  /** A tool has said the answer itself in this turn: no more text is streamed until the next message begins a turn. */
  private muted = false;

  constructor(options: ReporterOptions = {}) {
    this.write = options.write ?? writeProgress;
    this.enabled = options.enabled !== false;
    this.workspace = options.workspace ?? DEFAULT_WORKSPACE;
    this.stream = options.stream === true;
    this.now = options.now ?? Date.now;
  }

  private say(event: ProgressEvent): void {
    if (!this.enabled) return;
    try {
      this.write(event);
    } catch {
      // progress is a courtesy
    }
  }

  /** A new message is being answered: what it looks at is shown again even if the last one looked at the same thing. */
  beginTurn(): void {
    this.sent.clear();
    this.muted = false;
  }

  thinking(): void {
    this.say({ type: 'thinking' });
  }

  // --- the words of the reply (streaming only) ---------------------------------------------------------------------------------

  /** An assistant message begins. */
  messageStart(): void {
    if (!this.stream) return;
    this.msgN++;
    this.msgOpen = true;
    this.msgText = '';
    this.msgShut = false;
    this.emitted = false;
  }

  messageEnd(): void {
    this.msgOpen = false;
  }

  /**
   * The model wrote `delta` more of the message. The whole text so far goes to the host (cumulative: a line the host dropped costs nothing, and a
   * clear is just an empty text), at most every TEXT_INTERVAL_MS. Nothing is written when streaming is off, when this is a scheduled task, after a
   * tool has said the answer itself, or once the message has called a tool or grown past TEXT_CAP.
   */
  textDelta(delta: string): void {
    if (!this.stream || !this.enabled || this.muted || this.msgShut || typeof delta !== 'string' || delta === '') return;
    try {
      if (!this.msgOpen) this.messageStart();
      this.msgText += delta;
      if (this.msgText.length > TEXT_CAP) return this.shut();
      const at = this.now();
      if (this.emitted && at - this.lastTextAt < TEXT_INTERVAL_MS) return;
      this.lastTextAt = at;
      this.emitted = true;
      this.say({ type: 'text', n: this.msgN, text: this.msgText });
    } catch {
      // see say()
    }
  }

  /** The message goes on to call a tool: its words are not the reply, and the arguments of the call may take seconds to be written, so it is taken back now. */
  toolCallStart(): void {
    if (this.stream && this.msgOpen) this.shut();
  }

  /** Takes back what was sent of this message, and says no more of it. */
  private shut(): void {
    this.msgShut = true;
    this.msgText = '';
    if (this.emitted) {
      this.emitted = false;
      this.say({ type: 'text', n: this.msgN, text: '' });
    }
  }

  toolStart(id: string, rawName: string, args: unknown): void {
    if (!this.enabled) return;
    try {
      const name = coarseToolName(rawName, args, this.workspace);
      if (this.open.size >= MAX_OPEN_CALLS) this.open.delete(this.open.keys().next().value as string);
      this.open.set(id, { name, args, seq: ++this.seq });
      this.say({ type: 'tool', name, phase: 'start' });
      if (this.stream && SPEAKING_TOOLS.has(name)) {
        this.muted = true;
        if (this.msgOpen) this.shut();
      }
    } catch {
      // see say()
    }
  }

  /** `known` is for a harness whose end event carries the name and arguments itself (Claude Code's PostToolUse); pi's does not, so they are the start's. */
  toolEnd(id: string, result: unknown, isError: boolean, known?: { name: string; args: unknown }): void {
    if (!this.enabled) return;
    try {
      const started = this.open.get(id);
      this.open.delete(id);
      const name = started?.name ?? (known ? coarseToolName(known.name, known.args, this.workspace) : undefined);
      if (!name) return;
      this.say({ type: 'tool', name, phase: 'end' });
      if (isError || !LOOKUP_TOOLS.includes(name)) return;
      const fresh = sourcesOf(name, started?.args ?? known?.args, textOfResult(result)).filter((c) => {
        const key = `${c.kind}\u0000${c.label}\u0000${c.url ?? ''}`;
        if (this.sent.has(key)) return false;
        this.sent.add(key);
        return true;
      });
      if (fresh.length > 0) this.say({ type: 'sources', seq: started?.seq ?? ++this.seq, items: fresh });
    } catch {
      // see say()
    }
  }
}
