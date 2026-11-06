/**
 * A model that is told a lookup failed asks the very same lookup again, and again: twelve times in a row for one Piazza post in one call
 * (2026-11-04 21:13 UTC), each time a request to a service that had just answered "Sorry, too fast". The student heard "still looking" until
 * the call ended. After `maxFailures` identical failures within `windowMs` the same call is refused here, in words that tell the model what to
 * do instead, and nothing is sent. A different call (another post, another action) is a different key and is not affected; one success
 * forgets what was counted for its call.
 *
 * Used twice: by the nanoclaw MCP server around the three tools that call an outside service (the text agent, whose container it lives in) and by
 * the voice tool host in front of the same three, where a refusal is also not a use of the call's limit (tool-limits.ts counts after this).
 *
 * Kept apart from ipc-mcp-stdio.ts, which starts a server when it is imported, so it can be unit tested.
 */

// a type alias and not an interface: the MCP SDK's handler type wants an index signature, which only an alias of an object type has implicitly
export type ToolReply = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** The tools that call an outside service (Canvas, GitHub, Piazza): the ones a refusal helps, because the service is the one that gets hammered. */
export const GUARDED_TOOLS: ReadonlySet<string> = new Set(['canvas_query', 'github_query', 'piazza_query']);

const MAX_KEYS = 200;

/** JSON with the keys of every object in order, so that the same arguments written in another order are the same call. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export class RetryGuard {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 2,
    private readonly windowMs = 90_000,
    private readonly now: () => number = Date.now,
  ) {}

  private keyOf(tool: string, args: unknown): string {
    return `${tool}\u0001${stableStringify(args)}`;
  }

  /** The failures of this call that are still recent. */
  private recent(key: string): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => this.now() - at < this.windowMs);
    if (kept.length) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  private held(key: string, tool: string): string | null {
    const failed = this.recent(key).length;
    if (failed < this.maxFailures) return null;
    const seconds = Math.round(this.windowMs / 1000);
    return `This exact ${tool} request has already failed ${failed} times in the last ${seconds} seconds, so it was not sent again. Do not repeat it: tell the student it is not available right now, or ask for something different.`;
  }

  private noted(key: string, failed: boolean): void {
    if (!failed) {
      this.failures.delete(key);
      return;
    }
    const kept = this.recent(key);
    kept.push(this.now());
    this.failures.delete(key); // re-inserted last: the oldest keys are the ones dropped when there are too many
    this.failures.set(key, kept);
    while (this.failures.size > MAX_KEYS) this.failures.delete(this.failures.keys().next().value as string);
  }

  /**
   * Null while this exact call (the tool and its arguments as they came in) may go ahead; else what to tell the model. A refusal is not counted
   * as another failure: it ends when the window has gone by since the failures, whatever was asked meanwhile.
   */
  check(tool: string, args: unknown): string | null {
    return this.held(this.keyOf(tool, args), tool);
  }

  /** The call has ended: a failure is counted, a success forgets what was counted for its call. */
  record(tool: string, args: unknown, failed: boolean): void {
    this.noted(this.keyOf(tool, args), failed);
  }

  /** A new conversation begins (a call on a tool host that was kept): nothing that failed before is held against it. */
  reset(): void {
    this.failures.clear();
  }

  /**
   * Runs `fn` unless this exact call has already failed `maxFailures` times in the window. A reply with `isError` counts as a failure; so does a
   * throw (which goes on to the caller). The key is made from the arguments as they arrive, before `fn` (a handler fills in identity
   * parameters in the arguments it is given) can change them.
   */
  async run<T extends { isError?: boolean }>(tool: string, args: unknown, fn: () => Promise<T>): Promise<T | ToolReply> {
    const key = this.keyOf(tool, args);
    const refusal = this.held(key, tool);
    if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true };
    let reply: T;
    try {
      reply = await fn();
    } catch (err) {
      this.noted(key, true);
      throw err;
    }
    this.noted(key, reply.isError === true);
    return reply;
  }
}
