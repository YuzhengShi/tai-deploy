/**
 * The parts of the pi runner (pi-runner.ts) that need no pi: how the model is configured, how a value is handed to a server so pi does
 * not interpret it, which environment a shell command gets, where a session file is, and what a run came to. Kept apart so they can be
 * unit tested without starting pi.
 */

import fs from 'fs';
import path from 'path';
import { failureOfAssistantMessage, type ApiFailure } from './api-errors.js';
import type { McpServerSpec } from './mcp-servers.js';
import { visibleText } from './session-log.js';

// --- the model ----------------------------------------------------------------------------------------------------------------

export interface LlmConfig {
  api: 'openai-completions' | 'anthropic-messages';
  baseUrl: string;
  apiKey: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
}

const int = (value: string | undefined, fallback: number) => parseInt(value || '', 10) || fallback;

/**
 * Where pi sends its requests. The gateway (LiteLLM, in front of Cerebras) speaks both APIs; pi uses the OpenAI one (chat completions
 * at <gateway>/v1), which Cerebras speaks itself, where Claude Code had to go through the gateway's translation of the Anthropic one.
 * Unset, everything follows the ANTHROPIC_* settings the runner already has: the same gateway, key and model alias. TAI_LLM_* override
 * them; TAI_LLM_API=anthropic-messages talks to the scripted model of the evaluation, which only speaks that.
 */
export function llmConfig(env: Record<string, string | undefined>): LlmConfig {
  const api = env['TAI_LLM_API'] === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
  const gateway = (env['ANTHROPIC_BASE_URL'] || '').replace(/\/+$/, '');
  return {
    api,
    baseUrl: (env['TAI_LLM_BASE_URL'] || (api === 'openai-completions' ? `${gateway}/v1` : gateway)).replace(/\/+$/, ''),
    apiKey: env['TAI_LLM_API_KEY'] || env['ANTHROPIC_AUTH_TOKEN'] || env['ANTHROPIC_API_KEY'] || '',
    modelId: env['TAI_LLM_MODEL'] || env['ANTHROPIC_DEFAULT_SONNET_MODEL'] || env['ANTHROPIC_MODEL'] || 'qwen',
    contextWindow: int(env['TAI_LLM_CONTEXT_WINDOW'], 131_072),
    maxTokens: int(env['TAI_LLM_MAX_TOKENS'], 8_192),
  };
}

// --- values handed to pi's configuration ---------------------------------------------------------------------------------------

/**
 * pi reads a configuration value (the env of an MCP server, a header, a key) as a template: $NAME and ${NAME} are replaced by the
 * environment variable of that name, and a value that begins with "!" is a shell command whose output is used (resolve-config-value.js).
 * A token or a GitHub user name that happened to contain "$" or start with "!" must reach the server as it is, so every "$" is doubled
 * and a leading "!" is written "$!" (pi's own escapes for a literal "$" and "!").
 */
export function escapeConfigValue(value: string): string {
  const doubled = value.replace(/\$/g, () => '$$');
  return doubled.startsWith('!') ? `$${doubled}` : doubled;
}

export interface PiMcpEntry {
  name: string;
  config: { type: 'stdio'; command: string; args: string[]; env: Record<string, string>; exposure: 'direct'; timeout: number };
  source: string;
  scope: 'extension';
}

/**
 * The MCP servers as pi's MCP extension takes them. exposure "direct" declares their tools to the model like any other (pi's default,
 * "codemode", hides them behind a script tool); the tools are named mcp__<server>__<tool>, as in Claude Code.
 */
export function mcpEntries(servers: Record<string, McpServerSpec>, timeoutSeconds = 120): PiMcpEntry[] {
  return Object.entries(servers).map(([name, spec]) => ({
    name,
    config: {
      type: 'stdio' as const,
      command: spec.command,
      args: spec.args,
      env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, escapeConfigValue(value)])),
      exposure: 'direct' as const,
      timeout: timeoutSeconds,
    },
    source: 'tai',
    scope: 'extension' as const,
  }));
}

// --- the shell ---------------------------------------------------------------------------------------------------------------

const CREDENTIAL_LIKE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)/i;

/**
 * The environment of a command the agent runs: the container's, without anything named like a credential. The runner holds the
 * secrets the host handed over in its memory, not in its environment, so there should be none; this is for the one that slips in.
 */
export function bashEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !CREDENTIAL_LIKE.test(key)) out[key] = value;
  }
  return out;
}

// --- sessions ----------------------------------------------------------------------------------------------------------------

/** pi names a session file <timestamp>_<session id>.jsonl. An id that is not one of ours (Claude Code's, or lost) finds nothing. */
export function findSessionFile(dir: string, id: string | undefined): string | undefined {
  if (!id || !/^[A-Za-z0-9-]{8,80}$/.test(id)) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const name = names.find((n) => n.endsWith(`_${id}.jsonl`));
  return name ? path.join(dir, name) : undefined;
}

// --- what a run came to --------------------------------------------------------------------------------------------------------

interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: UsageLike;
}

export interface RunSummary {
  /** The answer (chooseReply): the text of the last assistant message, or the reply it points back to; null when there is none or the request failed. */
  text: string | null;
  failure: ApiFailure | null;
  /** The size of the context at the last model call (what the session cap watches), when the provider reported it. */
  contextTokens: number | null;
  /** Usage of every model call of the run, for the log. */
  calls: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;
  /** The model sent something to the student through mcp__nanoclaw__send_message: no text at the end may be all right. */
  sentViaTool: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => !!block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

const SUBSTANTIVE_WORDS = 8;
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Nothing for the student in it: empty, only punctuation or markup ("...", "*", "<i></i>"), or a short note to nobody about the reply
 * itself ("*(response already sent above)*", "(silently ignored with no reply)"), which qwen wrote in place of an answer.
 */
function isMeta(visible: string): boolean {
  const text = visible.trim();
  if (/^[*_\s]*\([\s\S]*\)[*_\s]*$/.test(text) && !/\n\s*\n/.test(text)) return true; // one parenthetical paragraph: a stage direction
  const bare = text.replace(/<[^>]*>/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (bare === '') return true;
  if (words(bare) > 12) return false;
  const aboutTheReply = /\b(response|reply|answer|message)\b/i.test(bare) && /\b(already|above|earlier|previously|sent|ignored|skipped|omitted)\b/i.test(bare);
  const nothingToSay = /\b(no reply|no response|nothing to (say|add|send)|silently ignored|silently skipped)\b/i.test(bare);
  return aboutTheReply || nothingToSay;
}

/**
 * The reply the student gets, from the text of each assistant message of the run (oldest first, '' for one without text): the last
 * message's, as with Claude Code's `result`. The one exception: when the last message holds nothing for the student (empty, only
 * reasoning, or a note to nobody such as "*response already sent above*", which qwen writes after answering next to a tool call), the
 * nearest earlier message with a real sentence in it is the reply.
 *
 * Not "everything the model said in the turn": qwen narrates next to its tool calls ("Let me check their competency first", "The strategy
 * log is empty ..."), and joining those sent a student 1,396 words of working notes (eval/RESULTS.md, "Switching the harness to pi").
 * What this rule cannot do is give back a reply that sits in an earlier message while the last one is a real sentence of its own
 * ("I'm ready for your answer"): the same exposure Claude Code's last-message `result` has, one run in eight in the measurements.
 */
export function chooseReply(texts: readonly string[]): string | null {
  if (texts.length === 0) return null;
  const last = texts[texts.length - 1].trim();
  if (!isMeta(visibleText(last))) return last;
  for (let i = texts.length - 2; i >= 0; i--) {
    const earlier = visibleText(texts[i]);
    if (words(earlier) >= SUBSTANTIVE_WORDS && !isMeta(earlier)) return texts[i].trim();
  }
  return null;
}

/** The summary of the messages a prompt added to the session (the user message, then assistant and tool results). */
export function summarizeRun(messages: readonly unknown[]): RunSummary {
  const assistants = (messages as MessageLike[]).filter((m) => m && m.role === 'assistant');
  const last = assistants[assistants.length - 1];
  const failure = failureOfAssistantMessage(last);
  const answer = chooseReply(assistants.map((m) => (m.stopReason === 'error' || m.stopReason === 'aborted' ? '' : textOf(m.content))));

  const calls = assistants
    .filter((m) => m.usage)
    .map((m) => ({ input: m.usage!.input || 0, output: m.usage!.output || 0, cacheRead: m.usage!.cacheRead || 0, cacheWrite: m.usage!.cacheWrite || 0 }));
  const lastCall = calls.length > 0 ? calls[calls.length - 1] : undefined;
  const contextTokens = lastCall && lastCall.input + lastCall.cacheRead + lastCall.cacheWrite > 0 ? lastCall.input + lastCall.cacheRead + lastCall.cacheWrite : null;

  const sentViaTool = assistants.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => !!b && (b as { type?: string; name?: string }).type === 'toolCall' && (b as { name?: string }).name === 'mcp__nanoclaw__send_message'),
  );

  return { text: failure ? null : answer, failure, contextTokens, calls, sentViaTool };
}

/** What the model is asked when its turn ended with nothing for the student in it (pi-runner.ts asks once). */
export const EMPTY_REPLY_NUDGE =
  'Your last message had nothing in it for the student. Reply to the student\'s message now, in your own voice, as plain text, without calling any tool.';

/** The model sometimes echoes the host's XML message format as part of its output; drop everything from there on. */
export function stripEchoedHumanTurn(text: string | null): string | null {
  if (!text || !/Human:\s*<messages>/.test(text)) return text;
  return text.replace(/Human:\s*<messages>[\s\S]*/g, '').trim() || null;
}
