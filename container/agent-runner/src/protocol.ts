/**
 * What the agent container and the host say to each other, shared by both harnesses (index.ts runs the conversation through Claude Code,
 * pi-runner.ts through pi). The protocol does not depend on the harness:
 *
 *   stdin   Line 1: {<ContainerInput fields>}            the initial input
 *           Line N: {"type":"message","text":"..."}      follow-up messages
 *           <EOF>                                        close signal
 *   stdout  every result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER; a result with no text carries only the session id.
 *           Between results the runner may also write progress, one line each: PROGRESS_MARKER, a space and a JSON object (ProgressEvent).
 *           What a turn is doing (a tool starts or ends, the model is thinking) and what it looked at (sources), for the student's page
 *           (docs/PROGRESS.md). A host that does not know the line ignores it; progress is never part of a result.
 */

import { friendlyMessage, type ApiFailureKind } from './api-errors.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  /** With isScheduledTask: the host made the task itself (patrol, bootstrap). Only such a task's container has its tool limits lifted (access.ts); an agent's own schedule_task does not. Neither reads the class: only the admin chat (isMain) does. */
  isSystemTask?: boolean;
  secrets?: Record<string, string>;
  canvasUserId?: string;
  githubUsername?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  resetSession?: boolean; // the session was retired: the host forgets it
  error?: string;
  /**
   * The model request failed and `result` is the apology the student is told, not an answer. The status stays "success" (a chat must
   * still show the apology), so this field is how the host's scheduler knows that a task did nothing.
   */
  apiFailure?: ApiFailureKind;
  /** The runner has done what it was asked and waits for the next message: the host may start its idle timer (a task's container is closed a few seconds later). */
  idle?: boolean;
  /**
   * With `idle`: how many follow-up messages (the host's `{"type":"message"}` lines) this runner has received since it started. The host
   * counts what it piped and takes the runner for idle only when the two agree: an idle marker that was written before a message reached the
   * runner (the host piped one in between, or in answer to the result just before it) is stale, and the container is busy.
   */
  received?: number;
}

export const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/** The line that starts a progress event on stdout (src/turn-status.ts reads it; the two must match). */
export const PROGRESS_MARKER = '---NANOCLAW_PROGRESS---';

/** What kind of thing a "looked at" chip is: the host picks the words around it from this, never the container. */
export type SourceKind = 'canvas' | 'github' | 'piazza' | 'course';

/** One thing a tool's result showed the turn (progress.ts): a short label and, when the result had one, the link to it. */
export interface SourceChip {
  label: string;
  url?: string;
  kind: SourceKind;
}

/**
 * Progress events. `tool` names the tool by a coarse name (progress.ts: no server prefix, never an argument, and `read_upload` for a read
 * of the student's attachment), `thinking` says a model request begins, `sources` carries the chips one tool result gave: `seq` is the
 * order in which the tool calls started, so that the host can put them in order of use when calls run side by side.
 *
 * `text` (only when the container is started with TAI_PORTAL_STREAM=1, which the host does for a student's chat on the web page and only when its
 * own flag is on; docs/STREAMING.md): everything of assistant message `n` so far (`n` only goes up over the container's life), cut off at
 * 3,000 characters; an empty `text` takes it back (the message goes on to call a tool, or got too long). The host filters it like the final reply
 * and shows only whole sentences; nothing in the container logs it.
 */
export type ProgressEvent =
  | { type: 'thinking' }
  | { type: 'tool'; name: string; phase: 'start' | 'end' }
  | { type: 'sources'; seq: number; items: SourceChip[] }
  | { type: 'text'; n: number; text: string };

/**
 * Says a progress event. Nothing from a voice call's tool host (TAI_MODE=tool-host: its stdout is the host's JSON-RPC, and nobody is waiting
 * to see what it does), and a failure to write never reaches the turn.
 */
export function writeProgress(event: ProgressEvent): void {
  if (process.env['TAI_MODE'] === 'tool-host') return;
  try {
    console.log(`${PROGRESS_MARKER} ${JSON.stringify(event)}`);
  } catch {
    // progress is a courtesy
  }
}

export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/** What a failed model request is reported as: the apology for the student, and why it is one. Only an overflow retires the session. */
export function failureOutput(kind: ApiFailureKind, sessionId?: string): ContainerOutput {
  const apology = { status: 'success' as const, result: friendlyMessage(kind), apiFailure: kind };
  return kind === 'overflow' ? { ...apology, resetSession: true } : { ...apology, newSessionId: sessionId };
}

/**
 * The runner has finished its turn and waits (no text: the answer, if there was one, went out before). `received` is how many follow-up
 * messages it has taken in so far (ContainerOutput.received); a runner that cannot count leaves it out.
 */
export function idleOutput(sessionId?: string, received?: number): ContainerOutput {
  return { status: 'success', result: null, newSessionId: sessionId, idle: true, ...(received !== undefined ? { received } : {}) };
}

export function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * The settings a runner works with: the container's environment and, over it, the secrets the host handed over (the model's key, the
 * Canvas and GitHub tokens ...). They are never put into process.env, which the shell commands the agent runs inherit; they go to the
 * harness and to the MCP server that needs them (buildMcpServers). The pi runner and the tool host build them the same way.
 */
export function envWithSecrets(input: ContainerInput, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const [key, value] of Object.entries(input.secrets || {})) env[key] = value;
  return env;
}

/**
 * What one conversation session has been through, across the queries of the main loop. A session is retired when it has had
 * DEFAULT_MAX_TURNS_PER_SESSION answers or its context has grown to DEFAULT_MAX_CONTEXT_TOKENS (TAI_MAX_TURNS_PER_SESSION and
 * TAI_MAX_CONTEXT_TOKENS override them): the next message then starts a fresh session. The competency files carry what matters over.
 * Upstream counted queries of the main loop instead, but a warm container takes follow-ups into the one running query, so that cap
 * never fired.
 */
export interface SessionState {
  turns: number;
  contextTokens: number;
}
export const DEFAULT_MAX_TURNS_PER_SESSION = 25;
export const DEFAULT_MAX_CONTEXT_TOKENS = 90_000;

export function sessionLimits(env: Record<string, string | undefined>): { maxTurns: number; maxContextTokens: number } {
  return {
    maxTurns: parseInt(env['TAI_MAX_TURNS_PER_SESSION'] || '', 10) || DEFAULT_MAX_TURNS_PER_SESSION,
    maxContextTokens: parseInt(env['TAI_MAX_CONTEXT_TOKENS'] || '', 10) || DEFAULT_MAX_CONTEXT_TOKENS,
  };
}

/**
 * Reads NDJSON lines from stdin, buffers them, supports blocking nextLine()
 * and non-blocking drainBuffered().
 */
export class StdinReader {
  private buffer: string[] = [];
  private partial = '';
  private closed = false;
  private waiting: (() => void) | null = null;

  constructor() {
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk: string) => {
      const parts = (this.partial + chunk).split('\n');
      this.partial = parts.pop()!; // last element is incomplete or ''
      for (const line of parts) {
        if (line.length > 0) {
          this.buffer.push(line);
        }
      }
      this.waiting?.();
    });

    process.stdin.on('end', () => {
      // flush any trailing partial line
      if (this.partial.length > 0) {
        this.buffer.push(this.partial);
        this.partial = '';
      }
      this.closed = true;
      this.waiting?.();
    });

    process.stdin.on('error', () => {
      this.closed = true;
      this.waiting?.();
    });
  }

  /** Returns next buffered line or waits; returns null on EOF with empty buffer. */
  async nextLine(): Promise<string | null> {
    while (true) {
      if (this.buffer.length > 0) {
        return this.buffer.shift()!;
      }
      if (this.closed) return null;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }

  /** Returns all currently buffered lines (non-blocking). */
  drainBuffered(): string[] {
    const lines = this.buffer.splice(0);
    return lines;
  }

  /** True when EOF received and buffer empty. */
  get isClosed(): boolean {
    return this.closed && this.buffer.length === 0;
  }
}
