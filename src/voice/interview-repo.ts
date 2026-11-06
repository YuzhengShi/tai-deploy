/**
 * The student's code in a mock interview. The real TA interview has the student walk through their own homework code, so the interviewer can
 * read their repository (functions.ts: `query_github`, their own account only). What this file does is the part that must not wait for the
 * first question: which of their repositories is the assignment's, and the NAMES of its code files (nothing is read), so that the interviewer
 * can pick a file the moment it needs one. It runs in the background of the interview's start (session.ts) and the answer is appended to the
 * prompt like the rest of the material.
 *
 *   which repository   by the assignment's name against the repositories' names, conservatively, because a wrong repository is worse than none (the
 *                      container's own matcher, ipc-mcp-stdio.ts, takes the most recent repo that merely contains the number "6" for homework 6: it
 *                      would take "cs6650-notes", and says nothing when none fits, which is the right half of it). A homework NUMBER next to hw/
 *                      homework/assignment in both names is a match; failing that, two words of the title in common. Nothing else: no "newest repo".
 *   which files        code and configuration, not vendored or generated or binary, the likelier ones first (main, server, handlers, Dockerfile, Terraform),
 *                      at most forty names, so that the prompt stays short.
 *
 * Everything goes through the tool host's `github_query`, so the container's identity check applies to every call: the account is the one the
 * host bound to the student, and only that one is ever named here.
 */
import type { ToolHost } from './tool-host.js';
import type { VoiceLog } from './types.js';
import { silentLog } from './types.js';

export interface RepoListing {
  repo: string;
  /** Paths of code files, likeliest first. */
  files: string[];
  /** How many more there were than are listed. */
  more: number;
}

/** What the interviewer is told about the student's code: a repository and its files, or the reason there is none. */
export type RepoLookup = ({ found: true } & RepoListing) | { found: false; why: 'unlinked' | 'no-match' | 'unavailable' };

export const MAX_LISTED_FILES = 40;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ---------------------------------------------------------------- which repository

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
};
/** What names a homework: "hw3", "homework-03", "assignment_3". */
const MARKERS = new Set(['hw', 'homework', 'hmwk', 'assignment', 'asgn', 'assn']);
/** Words that are in the name of most repositories and assignments of the course and say nothing about which. */
const COMMON = new Set([
  'cs', 'course', 'class', 'distributed', 'systems', 'system', 'scalable', 'northeastern', 'neu', 'homework', 'assignment', 'project', 'part', 'lets',
  'the', 'and', 'for', 'with', 'repo', 'repository', 'code', 'work', 'submission', 'final', 'draft', 'copy', 'test', 'tests', 'demo',
]);

/** The letter and digit runs of a name, lower case, number words as digits ("Homework three" is "homework", "3"). */
function chunks(text: string): string[] {
  return (text.toLowerCase().replace(/['’]/g, '').match(/\d+|[a-z]+/g) ?? []).map((c) => NUMBER_WORDS[c] ?? c);
}

/** The homework a name is about: the number straight after hw/homework/assignment (and its letter, "1a"), or null ("Midterm Mastery Part 2" is no homework). */
export function homeworkOf(name: string): { n: number; letter: string } | null {
  const c = chunks(name);
  for (let i = 0; i < c.length - 1; i++) {
    if (!MARKERS.has(c[i]) || !/^\d{1,2}$/.test(c[i + 1])) continue;
    const letter = /^[a-d]$/.test(c[i + 2] ?? '') ? c[i + 2] : '';
    return { n: parseInt(c[i + 1], 10), letter };
  }
  return null;
}

/** The words of a title that tell one assignment from another: four letters or more, not one every repository has. */
function titleWords(name: string): Set<string> {
  return new Set(chunks(name).filter((w) => /^[a-z]{4,}$/.test(w) && !COMMON.has(w) && !MARKERS.has(w)));
}

/**
 * The repository of the list whose name is the assignment's, or null. `repos` is what `list_repos` answered (newest update first): objects with a
 * `name`. A homework number in both names (and the same one) is a match; without a number on both sides, two words of the title in common are;
 * two different homework numbers are not, whatever else they share. Among matches the one updated last. Never the newest repository for want
 * of a match: the interviewer would walk the student through code that is not the assignment's.
 */
export function pickRepo(assignment: string, repos: unknown): string | null {
  if (!Array.isArray(repos)) return null;
  const wanted = homeworkOf(assignment);
  const words = titleWords(assignment);
  let best: { name: string; score: number; updated: number } | null = null;
  for (const repo of repos) {
    if (!repo || typeof repo !== 'object') continue;
    const name = (repo as { name?: unknown }).name;
    if (typeof name !== 'string' || !NAME.test(name)) continue;
    const has = homeworkOf(name);
    let score = 0;
    if (wanted && has) {
      if (has.n !== wanted.n || (has.letter && wanted.letter && has.letter !== wanted.letter)) continue;
      score = 10;
    } else {
      const shared = [...titleWords(name)].filter((w) => words.has(w)).length;
      if (shared < 2) continue;
      score = shared;
    }
    const stamp = Date.parse(String((repo as { updated_at?: unknown }).updated_at ?? ''));
    const updated = Number.isFinite(stamp) ? stamp : 0;
    if (!best || score > best.score || (score === best.score && updated > best.updated)) best = { name, score, updated };
  }
  return best ? best.name : null;
}

// ---------------------------------------------------------------- which files

const CODE_FILE = /\.(?:go|py|java|kt|kts|scala|js|jsx|mjs|cjs|ts|tsx|rs|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|sql|proto|tf|tfvars|hcl|ya?ml|toml)$/i;
const NAMED_FILE = /^(?:Dockerfile|Makefile|docker-compose\.ya?ml|README(?:\.md)?|Jenkinsfile|Procfile)$/i;
const SKIPPED_DIR = /(?:^|\/)(?:node_modules|vendor|\.git|\.github|\.idea|\.vscode|dist|build|target|bin|obj|__pycache__|\.venv|venv|coverage|\.terraform|\.next|out|third_party|testdata)(?:\/|$)/i;
const SKIPPED_FILE = /(?:\.pb\.go|\.min\.(?:js|css)|_generated\.\w+|\.generated\.\w+|\.lock|\.sum|\.map)$/i;
const MAX_FILE_BYTES = 300_000;
const MAX_PATH_CHARS = 100;
const PLAIN_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** How much a file is worth asking about: lower is likelier. */
function priority(file: string): number {
  const base = file.split('/').pop() ?? file;
  if (/(?:_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|^test_.*\.py|_test\.py)$/i.test(base) || /(?:^|\/)tests?\//i.test(file)) return 6;
  if (/^main\.\w+$/i.test(base)) return 0;
  // (the whole path: "handlers/orders.go" is a handler, whatever the file is called)
  if (/(?:server|app|handler|service|route|router|api|consumer|producer|worker|controller|store|cache|queue)/i.test(file)) return 1;
  if (/^(?:Dockerfile|docker-compose\.ya?ml)$/i.test(base) || /\.tf$/i.test(base)) return 2;
  if (/^README/i.test(base)) return 5;
  if (/\.ya?ml$|\.toml$/i.test(base)) return 4;
  return 3;
}

/**
 * The names of the code files in a repository tree (`repo_tree` with recursive: an array of { path, type, size }), the likeliest first and at
 * most forty of them; `more` counts the rest. Vendored, generated, binary and huge files are not code to ask about. Never throws.
 */
export function codeFiles(tree: unknown, max = MAX_LISTED_FILES): { files: string[]; more: number } {
  if (!Array.isArray(tree)) return { files: [], more: 0 };
  const found: Array<{ path: string; rank: number; depth: number }> = [];
  for (const entry of tree) {
    if (!entry || typeof entry !== 'object') continue;
    const { path, type, size } = entry as { path?: unknown; type?: unknown; size?: unknown };
    // (a path goes into the interviewer's prompt as the student's file names have it: letters, digits and . _ - / only, so that a file name is a name and never a sentence)
    if (typeof path !== 'string' || type !== 'file' || path.length > MAX_PATH_CHARS || !PLAIN_PATH.test(path)) continue;
    if (SKIPPED_DIR.test(path) || SKIPPED_FILE.test(path)) continue;
    // (a size of 0 is kept: the wrapper behind `repo_tree` answers 0 where the API gave no size, and every file would be lost to it)
    if (typeof size === 'number' && size > MAX_FILE_BYTES) continue;
    const base = path.split('/').pop() ?? path;
    if (!CODE_FILE.test(base) && !NAMED_FILE.test(base)) continue;
    // only the root's README is worth a mention: the others are the course's boilerplate
    if (/^README/i.test(base) && path.includes('/')) continue;
    found.push({ path, rank: priority(path), depth: path.split('/').length });
  }
  found.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.path.localeCompare(b.path));
  return { files: found.slice(0, max).map((f) => f.path), more: Math.max(0, found.length - max) };
}

// ---------------------------------------------------------------- what the interviewer's look-ups answer (short, plain, for a model that speaks)

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `list_repos` as the names only ("Repositories: hw3-concurrency, hw4-kafka"), or null when it is not a list. */
export function compactRepos(text: string): string | null {
  const list = parsed(text);
  if (!Array.isArray(list)) return null;
  const names = list.map((r) => (r && typeof r === 'object' ? (r as { name?: unknown }).name : undefined)).filter((n): n is string => typeof n === 'string' && NAME.test(n));
  return names.length ? `Repositories (newest first): ${names.slice(0, 30).join(', ')}.` : 'They have no repositories.';
}

function sizeWord(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
}

/** `repo_tree` as one line a file or folder ("handlers/ (folder)", "main.go (1.2 KB)"), at most sixty, or null when it is not a list. */
export function compactTree(text: string): string | null {
  const list = parsed(text);
  if (!Array.isArray(list)) return null;
  const rows: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, path, type, size } = entry as { name?: unknown; path?: unknown; type?: unknown; size?: unknown };
    const label = typeof path === 'string' ? path : typeof name === 'string' ? name : '';
    if (!label) continue;
    const folder = type === 'dir';
    rows.push(folder ? `${label}/ (folder)` : typeof size === 'number' && size > 0 ? `${label} (${sizeWord(size)})` : label);
  }
  if (!rows.length) return 'That folder is empty.';
  return `${rows.slice(0, 60).join('\n')}${rows.length > 60 ? `\n(${rows.length - 60} more: ask for a folder with a path)` : ''}`;
}

/** What `file_content` read: its path, its size and the text itself, as plain lines, or null when it is not that. */
export function readFileAnswer(text: string): { path: string; size: number; content: string } | null {
  const value = parsed(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { path, size, content } = value as { path?: unknown; size?: unknown; content?: unknown };
  if (typeof content !== 'string') return null;
  return { path: typeof path === 'string' ? path : '', size: typeof size === 'number' ? size : content.length, content };
}

/** `file_content` as plain text with a heading, so that the model reads code and not a JSON string full of \n and \t; null when it is not a file. */
export function compactFile(text: string): string | null {
  const file = readFileAnswer(text);
  if (!file) return null;
  const cut = file.size > file.content.length + 16 ? `, the first ${file.content.length} characters shown` : '';
  return `File ${file.path || '(no name)'} (${sizeWord(file.size)}${cut}):\n${file.content}`;
}

// ---------------------------------------------------------------- the look-up

/**
 * The student's repository for an assignment and its files' names, through the call's tool host. `username` is the GitHub account the host bound
 * to them (the allowlist's: nothing the student said); the container checks it again. Two calls to GitHub (the repository list, then its tree),
 * each given 25 s. Never throws.
 */
export async function lookUpRepo(th: ToolHost, username: string | undefined, assignment: string, log: VoiceLog = silentLog): Promise<RepoLookup> {
  if (!username || !NAME.test(username)) return { found: false, why: 'unlinked' };
  try {
    const list = await th.call('github_query', { action: 'list_repos', params: { user: username } }, { timeoutMs: 25_000 });
    if (!list.ok) return { found: false, why: 'unavailable' };
    const repos = parsed(list.text);
    if (!Array.isArray(repos)) return { found: false, why: 'unavailable' };
    const repo = pickRepo(assignment, repos);
    if (!repo) return { found: false, why: 'no-match' };
    // the tree is asked for in one request ("recursive": the tool's params are all strings); a tree that cannot be had still names the repository
    const tree = await th.call('github_query', { action: 'repo_tree', params: { owner: username, repo, recursive: 'true' } }, { timeoutMs: 25_000 });
    if (!tree.ok) return { found: true, repo, files: [], more: 0 };
    const { files, more } = codeFiles(parsed(tree.text));
    return { found: true, repo, files, more };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'voice: the interview\'s repository could not be looked up');
    return { found: false, why: 'unavailable' };
  }
}
