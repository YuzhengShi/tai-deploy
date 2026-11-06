/**
 * The guards of guards.ts, applied to pi's tool calls. guards.ts is written against Claude Code's tool names and inputs (Bash with
 * `command`, Read with `file_path`, Edit with `old_string` ...) and is tested to the last case; pi calls the same operations bash, read,
 * write, edit, grep and web_fetch with `path` and `edits: [{oldText, newText}]`. Rather than copy the rules, a pi call is turned into the
 * Claude-style calls the rules know and run through the same composed hooks (preToolUseHooks), so a rule added there applies here.
 *
 * What differs is how a path is read: pi strips a leading "@", expands "~" and reads "file://" URLs (utils/paths.js), so `@.env` or
 * `file:///workspace/group/.env` open the file the guard never saw by name. The path is resolved the way pi resolves it before the
 * check, and the raw spelling is checked as well.
 *
 * A guard that fails (throws) blocks the call.
 */

import os from 'os';
import path from 'path';
import { denial, preToolUseHooks, type TurnCounters } from './guards.js';

export interface GuardCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

const UNICODE_SPACES = /[  -   　]/g;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The absolute path pi opens for `raw` (utils/paths.js: resolvePath with unicode spaces, "@" prefix, "~" and file:// URLs). */
export function piResolvedPath(raw: string, cwd: string, home: string = os.homedir()): string {
  let p = raw.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = path.posix.join(home, p.slice(2));
  if (/^file:\/\//.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname); // what fileURLToPath gives on Linux, without its host check: check more, not less
    } catch {
      // not a URL pi could open either
    }
  }
  return path.posix.isAbsolute(p) ? path.posix.resolve(p) : path.posix.resolve(cwd, p);
}

/** One call per spelling of the path: as written and as pi resolves it. */
function pathCalls(toolName: string, raw: string, cwd: string, home: string): GuardCall[] {
  if (!raw) return [];
  const resolved = piResolvedPath(raw, cwd, home);
  const spellings = raw === resolved ? [raw] : [raw, resolved];
  return spellings.map((p) => ({ tool_name: toolName, tool_input: { file_path: p, path: p } }));
}

/** The Claude-style calls a pi tool call stands for. Tools the guards have no rule for (MCP tools, find, ls) map to none. */
export function toGuardCalls(toolName: string, input: Record<string, unknown>, cwd: string, home: string = os.homedir()): GuardCall[] {
  switch (toolName) {
    case 'bash':
      return [{ tool_name: 'Bash', tool_input: { command: str(input.command) } }];
    case 'read':
      return pathCalls('Read', str(input.path), cwd, home);
    case 'grep':
      return pathCalls('Grep', str(input.path), cwd, home);
    case 'write': {
      const file = str(input.path);
      return [{ tool_name: 'Write', tool_input: { file_path: file ? piResolvedPath(file, cwd, home) : '', content: str(input.content) } }];
    }
    case 'edit': {
      // pi's edit is a list of replacements in one call, which guards.ts knows as the MultiEdit shape
      const list = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
      const edits = list.map((e) => ({ old_string: str(e?.oldText), new_string: str(e?.newText) }));
      if (edits.length === 0 && (typeof input.oldText === 'string' || typeof input.newText === 'string')) {
        edits.push({ old_string: str(input.oldText), new_string: str(input.newText) }); // the older single-replacement shape
      }
      const file = str(input.path);
      return [{ tool_name: 'Edit', tool_input: { file_path: file ? piResolvedPath(file, cwd, home) : '', edits } }];
    }
    case 'web_fetch':
      return [{ tool_name: 'WebFetch', tool_input: { url: str(input.url) } }];
    default:
      return [];
  }
}

/** Claude Code's Bash gave a command 120 s unless the model asked for more, and at most 600 s; pi's bash tool has no limit at all. */
export const DEFAULT_BASH_SECONDS = 120;
export const MAX_BASH_SECONDS = 600;

/** The timeout, in seconds, a bash call gets: what the model asked for, within bounds. A command that never ends would otherwise hold a container until the host's timeout. */
export function boundedBashTimeout(asked: unknown): number {
  const seconds = typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_BASH_SECONDS;
  return Math.min(seconds, MAX_BASH_SECONDS);
}

export interface PiGuardOptions {
  isMain: boolean;
  secretNames: string[];
  counters: TurnCounters;
  /** The agent's working directory: where a relative path points. */
  cwd: string;
  home?: string;
}

export type PiGuard = (toolName: string, input: Record<string, unknown>) => Promise<{ block: true; reason: string } | undefined>;

/**
 * The guard for pi's tool_call event: undefined lets the call through (a Bash command may come back rewritten in `input`: the file
 * size cap and the unset of every credential go in front of it), a result with block stops it with the reason the model reads.
 */
export function createPiGuard(options: PiGuardOptions): PiGuard {
  const byTool = new Map(preToolUseHooks(options.isMain, options.secretNames, options.counters).map((h) => [h.matcher, h.hooks]));
  return async (toolName, input) => {
    try {
      for (const call of toGuardCalls(toolName, input, options.cwd, options.home)) {
        for (const hook of byTool.get(call.tool_name) ?? []) {
          const result = await hook(
            { hook_event_name: 'PreToolUse', tool_name: call.tool_name, tool_input: call.tool_input } as never,
            undefined,
            { signal: new AbortController().signal },
          );
          const reason = denial(result);
          if (reason !== null) return { block: true, reason: reason || 'This action is not allowed.' };
          const rewritten = (result as { hookSpecificOutput?: { updatedInput?: { command?: unknown } } }).hookSpecificOutput?.updatedInput;
          if (toolName === 'bash' && typeof rewritten?.command === 'string') input.command = rewritten.command;
        }
      }
      if (toolName === 'bash') input.timeout = boundedBashTimeout(input.timeout);
    } catch (err) {
      return { block: true, reason: `A safety check could not be completed (${err instanceof Error ? err.message : String(err)}), so the action was not run.` };
    }
    return undefined;
  };
}
