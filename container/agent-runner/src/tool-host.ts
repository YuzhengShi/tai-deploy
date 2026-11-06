/**
 * The tool host: what the container does instead of running the agent when the host starts it with TAI_MODE=tool-host (entrypoint.sh).
 * Same image, mounts and environment as the student's text agent, and the same MCP servers started the same way (buildMcpServers: the
 * identity binding and the credentials are the agent's, so every tool keeps its own access control). It answers the host's tool calls
 * for the voice call (docs/VOICE.md, "Tool host") over the container's stdio:
 *
 *   stdin   Line 1: the usual ContainerInput (prompt empty, chatJid, groupFolder, isMain false, identity, secrets).
 *           Then one request per line: {"id","server"?,"tool","args"} for an MCP tool (server defaults to nanoclaw; the LeanRAG tool is
 *           {"server":"leanrag","tool":"query_knowledge"}), or {"id","builtin":"web_fetch"|"read_file","args"}. An optional
 *           "timeoutMs" raises the 60 s a call gets (to 120 s at most).
 *           <EOF>  ends the session: the servers are closed and the process exits within 5 s.
 *   stdout  "@@TOOLHOST ready@@" once the servers are up, or "@@TOOLHOST failed@@ <reason>"; then one line per answer,
 *           "@@TOOLHOST@@ " and {"id","ok":true,"text"} or {"id","ok":false,"error","text"} (a failed call has its message in both
 *           fields, whichever the reader looks at). Nothing else is ever written to stdout; the log goes to stderr.
 *
 * Calls are handled concurrently and each answer is one whole line, written when its call ends. The nanoclaw server runs its tools with
 * execSync, so it answers one call at a time: calls to it queue behind each other (and one that timed out here keeps it busy until the
 * tool returns); the concurrency is real across servers and for the built-ins. No answer holds a credential the host handed over: their
 * values are blanked out of every answer, whatever a tool printed.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { accessFlagsFromInput, liftsToolLimits } from './access.js';
import { CREDENTIAL_LIKE, isSensitivePath, newTurnCounters } from './guards.js';
import { buildMcpServers, type McpServerSpec } from './mcp-servers.js';
import { createPiGuard, type PiGuard } from './pi-guards.js';
import { StdinReader, envWithSecrets, log, type ContainerInput } from './protocol.js';
import { GUARDED_TOOLS, RetryGuard } from './retry-guard.js';
import { TOOL_LIMITS, ToolLimiter } from './tool-limits.js';
import { fetchPage } from './web-fetch.js';

export const READY_LINE = '@@TOOLHOST ready@@';
export const FAILED_PREFIX = '@@TOOLHOST failed@@ ';
export const ANSWER_PREFIX = '@@TOOLHOST@@ ';

/** What read_file gives back at most, and what any other answer is cut to (a tool that prints megabytes must not make a megabyte line). */
export const READ_FILE_MAX_CHARS = 20_000;
export const ANSWER_MAX_CHARS = 100_000;

const DEFAULT_SERVER = 'nanoclaw';
const PYTHON = '/opt/leanrag/bin/python3';
const CONVERT_OFFICE = '/opt/scripts/convert_office.py';
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico', '.heic']);

// --- what the host and the servers say ---------------------------------------------------------------------------------------------

/** Where the requests come from: StdinReader in the container, a queue in a test. null is the end of the input. */
export interface LineSource {
  nextLine(): Promise<string | null>;
}

/** The part of an MCP tool result the tool host reads. */
export interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/** One MCP server of the container, as the tool host sees it. McpToolServer is the real one (the MCP SDK's client over stdio). */
export interface ToolServer {
  /** Start the server and wait until it can be called; rejects when it cannot. */
  connect(): Promise<void>;
  /** One tool call; `signal` cancels it, `timeoutMs` is how long the caller will wait for it. */
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const execFileText: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

export interface ToolHostOptions {
  /** Where /workspace is: read_file reads what is under <workspaceRoot>/group/uploads. Default: TAI_WORKSPACE_ROOT, or /workspace. */
  workspaceRoot?: string;
  /** How long a call gets (default 60 s), the most a request may ask for with timeoutMs (120 s), how long a server gets to start (20 s). */
  callTimeoutMs?: number;
  maxCallTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** After the input ends: how long the servers get to close (3.5 s), and when hardExit is called if the shutdown is not done (4.5 s). */
  closeTimeoutMs?: number;
  hardExitMs?: number;
  hardExit?: () => void;
  /** Calls in flight at once; more are answered with an error at once. */
  maxInFlight?: number;
  /** The servers without which there is no tool host (default: nanoclaw). Another one that does not start is logged, and its calls fail. */
  required?: string[];
  /** Ends the session as the end of the input does (a signal). */
  signal?: AbortSignal;
  exec?: ExecFile;
  fetchImpl?: typeof fetch;
  /** Counts the uses of the tools that cost something, per call (default: TOOL_LIMITS, none for the admin's container and the scheduled tasks). */
  limiter?: ToolLimiter;
  /** Refuses a Canvas, GitHub or Piazza call that has failed twice already with the same arguments (retry-guard.ts). */
  guard?: RetryGuard;
}

/** What a call comes to; `error` is the short form of a failure (its text when there is nothing shorter). */
interface Outcome {
  ok: boolean;
  text: string;
  error?: string;
}

const succeed = (text: string): Outcome => ({ ok: true, text });
const failure = (error: string): Outcome => ({ ok: false, text: error, error });

// --- small helpers -------------------------------------------------------------------------------------------------------------

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The values of the credentials among the secrets the host handed over (by their names, as the shell guard does): at least 8 characters, longest first. */
export function credentialValues(secrets: Record<string, string> | undefined): string[] {
  const values = Object.entries(secrets || {})
    .filter(([name, value]) => CREDENTIAL_LIKE.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/**
 * The text without any of the credentials. Only credentials: the other settings the host hands over (the Canvas and GitHub addresses,
 * the course organisations, the interview link's address) are public and show up in honest answers, the interview link among them.
 */
export function redact(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (out.includes(value)) out = out.split(value).join('[redacted]');
  return out;
}

/** The text of an MCP result: its text blocks, a note for any other kind, the structured content when there is nothing else. */
export function resultText(result: McpCallResult): string {
  const parts: string[] = [];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block && typeof block.type === 'string') parts.push(`[${block.type} content not shown]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join('\n');
}

/** At most `limit` characters, the note that says so included. */
export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const note = `\n[... cut here: more than the ${limit} characters allowed]`;
  return text.slice(0, Math.max(0, limit - note.length)) + note;
}

/** A name safe for the log. */
const logName = (value: unknown): string => String(value).replace(/[^\w.:-]/g, '?').slice(0, 64);

/** `promise`, or a rejection after `ms`. A promise that loses the race is left to fail quietly. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  promise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

class CallTimeout extends Error {
  constructor() {
    super('timeout');
  }
}

// The characters other than a line feed that a line reader may split a line on (JSON does not escape them, JavaScript regards two of them as line ends)
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}${String.fromCharCode(0x85)}]`, 'g');

/** One answer as one line: the prefix and the JSON, every separator a line reader might split on written as an escape. */
function encodeAnswer(id: string | number, outcome: Outcome, values: readonly string[]): string {
  const answer: { id: string | number; ok: boolean; text: string; error?: string } = { id, ok: outcome.ok, text: redact(outcome.text, values) };
  if (!outcome.ok) answer.error = redact(outcome.error ?? outcome.text.slice(0, 1000), values);
  const json = JSON.stringify(answer).replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return ANSWER_PREFIX + json;
}

// --- read_file: a file the student attached ------------------------------------------------------------------------------------------

/** The last lines a failed script printed, for the message. */
function lastLines(stderr: unknown, count = 3): string {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-count).join(' ');
}

// pymupdf is in the venv (Dockerfile); `fitz` is its old name. The file and the limit are arguments, never part of the code.
const PDF_SCRIPT = [
  'import sys',
  'try:',
  '    import pymupdf',
  'except ImportError:',
  '    import fitz as pymupdf',
  'sys.stdout.reconfigure(encoding="utf-8")',
  'limit = int(sys.argv[2])',
  'doc = pymupdf.open(sys.argv[1])',
  'parts = []',
  'size = 0',
  'for number, page in enumerate(doc, 1):',
  '    text = page.get_text().strip()',
  '    if not text:',
  '        continue',
  '    parts.append("[page %d]" % number + chr(10) + text)',
  '    size += len(text)',
  '    if size > limit:',
  '        break',
  'sys.stdout.write((chr(10) * 2).join(parts))',
].join('\n');

/** The file a request names, when it is a regular file inside the uploads folder once every link is followed. */
function resolveUpload(workspaceRoot: string, raw: string): { real: string } | { error: string } {
  const groupDir = path.join(workspaceRoot, 'group');
  const uploads = path.join(groupDir, 'uploads');
  if (!raw || raw.includes('\0')) return { error: 'read_file needs the path of a file the student attached' };
  // an absolute path as it is; "uploads/x" from the group folder (the agent's working directory); a bare name from the uploads folder
  const candidate = path.isAbsolute(raw) ? raw : /^uploads[\\/]/.test(raw) ? path.join(groupDir, raw) : path.join(uploads, raw);
  let root: string;
  try {
    root = fs.realpathSync(uploads);
  } catch {
    return { error: 'the student has not attached any files' };
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { error: `no such file among the student's uploads: ${path.basename(raw)}` };
  }
  const relative = path.relative(root, real);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return { error: 'only the files the student attached (the uploads folder) can be read' };
  if (isSensitivePath(real.split(path.sep).join('/'))) return { error: 'This file contains sensitive data and cannot be read directly.' };
  try {
    if (!fs.statSync(real).isFile()) return { error: `${path.basename(real)} is not a file` }; // before any open: a FIFO would block it
  } catch (err) {
    return { error: `could not read ${path.basename(real)}: ${errorText(err)}` };
  }
  return { real };
}

async function readUpload(raw: string, workspaceRoot: string, exec: ExecFile): Promise<Outcome> {
  const found = resolveUpload(workspaceRoot, raw);
  if ('error' in found) return failure(found.error);
  const { real } = found;
  const extension = path.extname(real).toLowerCase();
  const name = path.basename(real);

  if (IMAGE_EXTENSIONS.has(extension)) return failure(`${name} is an image, and there is no way to see images here`);

  // PDF and Office files: text out of the venv's Python, whose failures say why on stderr
  const converter: string[] | null = extension === '.pdf' ? ['-c', PDF_SCRIPT, real, String(READ_FILE_MAX_CHARS)] : OFFICE_EXTENSIONS.has(extension) ? [CONVERT_OFFICE, real] : null;
  if (converter) {
    try {
      const { stdout } = await exec(PYTHON, converter, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      if (!stdout.trim()) return failure(`no text found in ${name}${extension === '.pdf' ? ' (a scan, or only pictures?)' : ''}`);
      return succeed(capText(stdout, READ_FILE_MAX_CHARS));
    } catch (err) {
      return failure(`could not read ${name}: ${lastLines((err as { stderr?: unknown }).stderr) || errorText(err)}`);
    }
  }

  // text and code: as they are, from the first bytes (at most 4 per character) of a regular file
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(real, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return failure(`${name} is not a file`);
    const buffer = Buffer.alloc(Math.min(stat.size, READ_FILE_MAX_CHARS * 4 + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, 8192).includes(0)) return failure(`${name} is not a text file`);
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    if (text.length > READ_FILE_MAX_CHARS || stat.size > bytesRead) {
      const note = `\n[... cut here: the file is longer than the ${READ_FILE_MAX_CHARS} characters allowed]`;
      return succeed(text.slice(0, READ_FILE_MAX_CHARS - note.length) + note);
    }
    return succeed(text === '' ? `(${name} is empty)` : text);
  } catch (err) {
    return failure(`could not read ${name}: ${errorText(err)}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// --- web_fetch ------------------------------------------------------------------------------------------------------------------------

/** What pi's web_fetch gives back: the page's address, status and type, then its text. */
async function fetchWeb(args: Record<string, unknown>, restricted: boolean, guard: PiGuard, fetchImpl: typeof fetch | undefined, signal: AbortSignal): Promise<Outcome> {
  const url = typeof args['url'] === 'string' ? args['url'].trim() : '';
  if (!url) return failure('web_fetch needs a url');
  // the guard of pi's web_fetch: the private-address rules, and at most 15 calls (there are no turns here: so for the life of the tool host)
  const blocked = await guard('web_fetch', { url });
  if (blocked) return failure(blocked.reason);
  const maxChars = typeof args['max_chars'] === 'number' ? args['max_chars'] : undefined;
  const page = await fetchPage(url, { restricted, maxChars, signal, fetchImpl });
  const head = `${page.url} (${page.status}${page.contentType ? `, ${page.contentType}` : ''})`;
  return succeed(`${head}\n\n${page.text}`);
}

// --- the loop -------------------------------------------------------------------------------------------------------------------------

interface Request {
  id: string | number;
  server?: unknown;
  tool?: unknown;
  builtin?: unknown;
  /** Not a tool call: something the host tells the tool host. "new-call": a call begins (the host reuses a tool host for the student's next call), so the per-call tool limits start from zero. */
  control?: unknown;
  args?: unknown;
  timeoutMs?: unknown;
}

/**
 * Serve the host's requests until the input ends. Resolves with the exit code: 0 after a normal end, 1 when the tool host could not start
 * (a required server did not come up; "@@TOOLHOST failed@@" was written). `write` takes one finished line; only protocol lines go to it.
 */
export async function runToolHost(
  input: ContainerInput,
  stdin: LineSource,
  write: (line: string) => void,
  servers: Record<string, ToolServer>,
  options: ToolHostOptions = {},
): Promise<number> {
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;
  const maxCallTimeoutMs = Math.max(options.maxCallTimeoutMs ?? 120_000, callTimeoutMs);
  const connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
  const closeTimeoutMs = options.closeTimeoutMs ?? 3_500;
  const maxInFlight = options.maxInFlight ?? 16;
  const required = options.required ?? [DEFAULT_SERVER];
  const exec = options.exec ?? execFileText;
  const workspaceRoot = options.workspaceRoot ?? (process.env['TAI_WORKSPACE_ROOT'] || '/workspace');
  // The limits of the nanoclaw tools, counted here per call: the nanoclaw server this host starts knows it is in tool-host mode and does not count (ipc-mcp-stdio.ts).
  // Who is not limited is access.ts's rule, the nanoclaw server's own. The orchestrator starts a call's tool host with isMain false and no task flag, so a call is
  // always limited; this line used to lift the limits for `isScheduledTask` alone, a branch that host never reaches, which is no reason to keep a second rule.
  const limiter = options.limiter ?? new ToolLimiter(TOOL_LIMITS, liftsToolLimits(accessFlagsFromInput(input)), 'voice call');
  // A lookup that failed twice with the same arguments is not sent a third time; the refusal is checked before the limit counts the call
  const retryGuard = options.guard ?? new RetryGuard();
  const values = credentialValues(input.secrets);
  const clean = (text: string) => redact(text, values);

  const emit = (line: string) => {
    try {
      write(line);
    } catch (err) {
      log(`Could not write to stdout: ${errorText(err)}`);
    }
  };
  const closeAll = async (list: ToolServer[]) => {
    await Promise.allSettled(list.map(async (server) => within(server.close(), closeTimeoutMs, 'close timed out')));
  };

  // --- start the servers, all at once ---
  const live = new Map<string, ToolServer>();
  const unavailable = new Map<string, string>();
  await Promise.all(
    Object.entries(servers).map(async ([name, server]) => {
      try {
        await within(server.connect(), connectTimeoutMs, `${name} did not start within ${connectTimeoutMs / 1000} s`);
        live.set(name, server);
      } catch (err) {
        unavailable.set(name, clean(errorText(err)));
        log(`MCP server ${name} did not start: ${unavailable.get(name)}`);
        await closeAll([server]);
      }
    }),
  );
  const missing = required.filter((name) => !live.has(name));
  if (missing.length > 0) {
    const reason = missing.map((name) => `${name}: ${unavailable.get(name) ?? 'not configured'}`).join('; ');
    emit(FAILED_PREFIX + clean(reason).replace(/\s+/g, ' ').trim().slice(0, 300));
    await closeAll([...live.values()]);
    return 1;
  }
  emit(READY_LINE);
  log(`Tool host ready: ${[...live.keys()].join(', ')}`);

  // --- what a request is run with ---
  const restricted = !input.isMain; // as for pi's web_fetch: only the admin's container may fetch from its own network
  const guard = createPiGuard({ isMain: input.isMain, secretNames: [], counters: newTurnCounters(), cwd: path.join(workspaceRoot, 'group') });
  const controllers = new Set<AbortController>();
  const inFlight = new Set<Promise<void>>();
  let ending = false;

  const answer = (id: string | number, outcome: Outcome) => {
    if (!ending) emit(encodeAnswer(id, outcome, values)); // after the end nobody is reading
  };

  const run = async (req: Request, signal: AbortSignal, timeoutMs: number): Promise<Outcome> => {
    if (req.control !== undefined) {
      if (req.control === 'new-call') {
        limiter.reset();
        retryGuard.reset();
        return succeed('ok');
      }
      return failure(`unknown control ${logName(req.control)}`);
    }
    const args = req.args ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return failure('args must be an object');
    const given = args as Record<string, unknown>;

    if (req.builtin !== undefined) {
      if (req.builtin === 'web_fetch') return fetchWeb(given, restricted, guard, options.fetchImpl, signal);
      if (req.builtin === 'read_file') return readUpload(typeof given['path'] === 'string' ? given['path'] : '', workspaceRoot, exec);
      return failure(`unknown builtin ${logName(req.builtin)}`);
    }
    if (typeof req.tool !== 'string' || !req.tool) return failure('a request needs a "tool" or a "builtin"');
    const serverName = req.server === undefined ? DEFAULT_SERVER : req.server;
    if (typeof serverName !== 'string') return failure('server must be a name');
    const server = live.get(serverName);
    if (!server) {
      const why = unavailable.get(serverName);
      return failure(why ? `server ${logName(serverName)} is not available: ${why}` : `unknown server ${logName(serverName)}`);
    }
    const guarded = serverName === DEFAULT_SERVER && GUARDED_TOOLS.has(req.tool);
    if (serverName === DEFAULT_SERVER) {
      const held = guarded ? retryGuard.check(req.tool, given) : null;
      if (held) return failure(held);
      const refused = limiter.check(req.tool);
      if (refused) return failure(refused);
    }
    let result: McpCallResult;
    try {
      result = await server.callTool(req.tool, given, signal, timeoutMs);
    } catch (err) {
      if (guarded) retryGuard.record(req.tool, given, true);
      throw err;
    }
    const text = capText(resultText(result), ANSWER_MAX_CHARS);
    if (guarded) retryGuard.record(req.tool, given, result.isError === true);
    if (!result.isError) return succeed(text);
    return { ok: false, text, error: text.slice(0, 1000) || 'the tool reported an error' };
  };

  const handle = async (line: string): Promise<void> => {
    let req: Request;
    try {
      const parsed: unknown = JSON.parse(line);
      const id = (parsed as { id?: unknown } | null)?.id;
      if (typeof parsed !== 'object' || parsed === null || (typeof id !== 'string' && typeof id !== 'number')) {
        log('Ignoring a line that is not a request with an id');
        return;
      }
      req = parsed as Request;
    } catch {
      log('Ignoring a line that is not JSON');
      return;
    }
    const id = req.id;
    if (inFlight.size >= maxInFlight) {
      answer(id, failure('too many calls in flight'));
      return;
    }
    const target =
      req.control !== undefined
        ? `control:${logName(req.control)}`
        : req.builtin !== undefined
          ? `builtin:${logName(req.builtin)}`
          : `${logName(req.server ?? DEFAULT_SERVER)}/${logName(req.tool)}`;
    const asked = typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) ? req.timeoutMs : callTimeoutMs;
    const timeoutMs = Math.min(Math.max(asked, 50), maxCallTimeoutMs);
    const controller = new AbortController();
    controllers.add(controller);
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CallTimeout());
        }, timeoutMs);
      });
      const running = run(req, controller.signal, timeoutMs);
      running.catch(() => undefined);
      const outcome = await Promise.race([running, expired]);
      answer(id, outcome);
      log(`call ${logName(id)} ${target}: ${outcome.ok ? 'ok' : 'failed'} in ${Date.now() - started} ms`);
    } catch (err) {
      const message = err instanceof CallTimeout ? 'timeout' : clean(errorText(err));
      answer(id, failure(message));
      log(`call ${logName(id)} ${target}: ${message.slice(0, 200)} after ${Date.now() - started} ms`);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  };

  // --- serve until the input ends ---
  const stop = new Promise<null>((resolve) => {
    if (options.signal?.aborted) resolve(null);
    options.signal?.addEventListener('abort', () => resolve(null), { once: true });
  });
  for (;;) {
    const line = await Promise.race([stdin.nextLine(), stop]);
    if (line === null) break;
    if (!line.trim()) continue;
    const task: Promise<void> = handle(line).catch((err) => log(`Request failed unexpectedly: ${clean(errorText(err))}`));
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }

  // --- the end: no more answers, the servers closed, out within 5 s ---
  ending = true;
  log('Input ended: closing the MCP servers');
  const hard = setTimeout(() => options.hardExit?.(), options.hardExitMs ?? 4_500);
  hard.unref();
  for (const controller of controllers) controller.abort();
  await closeAll([...live.values()]);
  clearTimeout(hard);
  return 0;
}

// --- the real MCP servers -------------------------------------------------------------------------------------------------------------

const stringEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/**
 * An MCP server started as the agent's harness starts it, with the MCP SDK's client over stdio: the container's whole environment with
 * the server's own settings over it (pi's way, and what the nanoclaw tools rely on: they pass their environment to their Python scripts),
 * and /workspace/group as the working directory. The host's secrets are not passed on as a whole, only what buildMcpServers gives that server.
 */
export class McpToolServer implements ToolServer {
  private client: McpClient | null = null;

  constructor(
    private readonly name: string,
    private readonly spec: McpServerSpec,
    private readonly cwd?: string,
  ) {}

  async connect(): Promise<void> {
    // loaded here, not at the top of the file: the tests of everything else need no MCP SDK
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args,
      env: { ...stringEnv(process.env), ...this.spec.env },
      cwd: this.cwd && fs.existsSync(this.cwd) ? this.cwd : undefined,
      stderr: 'pipe',
    });
    // the server's stderr goes to ours, and its last words go into the reason when it does not start
    let stderrTail = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    const client = new Client({ name: 'tai-tool-host', version: '1.0.0' });
    client.onerror = (err) => log(`MCP client ${this.name}: ${errorText(err)}`);
    this.client = client; // so that close() reaches a server that is still starting when the tool host gives up on it
    try {
      await client.connect(transport);
    } catch (err) {
      this.client = null;
      await client.close().catch(() => undefined);
      // the line that names the error (Node prints it first, Python last), or else the last two lines
      const lines = stderrTail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const said = lines.find((l) => /\b\w*Error\b/.test(l)) ?? lines.slice(-2).join(' ');
      throw new Error(said ? `${errorText(err)} (${said.slice(0, 250)})` : errorText(err));
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<McpCallResult> {
    if (!this.client) throw new Error(`server ${this.name} is not connected`);
    // the caller times the call out itself; the SDK's own limit is only the backstop, a little later
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs + 5_000 });
    return result as unknown as McpCallResult;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close();
  }
}

// --- the process ----------------------------------------------------------------------------------------------------------------------

/** Out, once what has been written to stdout is out: a pipe does not finish its writes by itself when the process exits. */
function exitAfterFlush(code: number): void {
  const bail = setTimeout(() => process.exit(code), 1000);
  bail.unref();
  process.stdout.write('', () => process.exit(code));
}

/** One last line (the failure), then out. */
function lastWords(line: string, code: number): void {
  process.stdout.write(line + '\n');
  exitAfterFlush(code);
}

async function main(): Promise<void> {
  // stdout is the protocol channel and nothing else: whatever a library prints with console.log goes to stderr
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0); // the host is gone
    log(`stdout: ${err.message}`);
  });
  process.on('unhandledRejection', (err) => log(`Unhandled rejection: ${errorText(err)}`));
  process.on('uncaughtException', (err) => log(`Uncaught exception: ${errorText(err)}`));

  const reader = new StdinReader();
  let input: ContainerInput;
  try {
    const first = await reader.nextLine();
    if (first === null) throw new Error('no input received');
    input = JSON.parse(first) as ContainerInput;
    if (typeof input !== 'object' || input === null) throw new Error('the first line is not an object');
  } catch (err) {
    return lastWords(FAILED_PREFIX + `cannot read the input: ${errorText(err)}`.replace(/\s+/g, ' ').slice(0, 300), 1);
  }
  log(`Tool host for group: ${input.groupFolder}`);

  const env = envWithSecrets(input);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const specs = buildMcpServers(process.env['TAI_MCP_SERVER_PATH'] || path.join(here, 'ipc-mcp-stdio.js'), input, env);
  const cwd = path.join(process.env['TAI_WORKSPACE_ROOT'] || '/workspace', 'group');
  const servers = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, new McpToolServer(name, spec, cwd)]));

  const stopping = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => stopping.abort());
  const write = (line: string) => {
    process.stdout.write(line + '\n');
  };
  const code = await runToolHost(input, reader, write, servers, { signal: stopping.signal, hardExit: () => process.exit(0) });
  exitAfterFlush(code);
}

// run only as the container's program, not when a test imports the module
function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    log(`Fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
    lastWords(FAILED_PREFIX + errorText(err).replace(/\s+/g, ' ').slice(0, 300), 1);
  });
}
