/**
 * How often one conversation may use the tools that cost something (a Canvas, GitHub or Piazza request, an image, a voice message ...).
 * The limits are inherited from upstream NanoClaw, which counted them per container lifecycle: for a text chat that is one conversation.
 * A voice call's tool host is kept warm and reused for the student's next call (src/voice/tool-host-pool.ts), so the counts ran on from
 * one call into the next: on 2026-11-04 the fifth call of the morning was refused "max 30 calls per session" at its first Canvas lookup.
 * The tool host therefore counts them itself, per call, and the MCP server it starts does not count them again (it knows by TAI_MODE=tool-host,
 * which the host sets with `docker run -e` and which nothing the model can reach changes).
 *
 * Kept apart from ipc-mcp-stdio.ts, which starts a server when it is imported, so it can be unit tested.
 */

export const TOOL_LIMITS: Readonly<Record<string, number>> = {
  canvas_query: 30,
  github_query: 30,
  piazza_query: 20,
  generate_teaching_image: 5,
  send_voice_message: 10,
  render_diagram: 10,
  start_mock_interview: 3,
  // up to six helper runs (Canvas twice, GitHub up to twice, Piazza) and the student's own words in the answer: a few looks per conversation are plenty
  weekly_brief: 3,
  read_image_text: 10,
  // each look sends the student's picture to z.ai and costs roughly a thousand tokens and a few seconds (vision.ts, docs/VISION.md). Counted when a request is about to be sent, not for a refusal
  look_at_image: 5,
  // each run starts a disposable container on the host (docs/GO_SANDBOX.md) and spends one of the student's 10 runs an hour: a conversation about one program needs a few, and a model that tries again and again does not need more. Counted when a request is about to be sent
  run_go: 8,
  // each call may start a disposable container on the host that turns a PDF into page images (docs/DOCUMENTS.md; the host's own limit is 6 new documents in ten minutes and 20 a day), and a card in the chat is enough for one document. Counted when a request is about to be sent
  show_document: 6,
  // a card of numbers, of a sequence or of a program to guess the output of is a few kilobytes of the student's history and one more thing to read: a handful in a conversation is plenty (docs/CARDS.md; the host's own limit is 24 cards an hour for a student). Counted when a request is about to be sent
  show_chart: 6,
  show_trace: 6,
  ask_to_predict: 4,
  // a search of the course decks is an index in the host's memory (docs/COURSE_DOCS.md): cheap, but a model that searches again and again for the same thing does not need more than a few. Counted when a request is about to be sent
  find_course_document: 8,
};

export class ToolLimiter {
  private readonly counts = new Map<string, number>();

  /**
   * `unlimited`: the admin's container and the host's own tasks (the patrol, the bootstrap: access.ts liftsToolLimits) are not limited; a task an agent scheduled is,
   * like a student's chat. `scope` is the word the refusal uses for what the
   * limit is per ("session": a text chat's container; "voice call": the tool host, which resets the counts when a call begins).
   */
  constructor(
    private readonly limits: Readonly<Record<string, number>> = TOOL_LIMITS,
    private readonly unlimited = false,
    private readonly scope = 'session',
  ) {}

  /** Whether this tool has a limit at all. */
  limited(tool: string): boolean {
    return !this.unlimited && Object.prototype.hasOwnProperty.call(this.limits, tool);
  }

  /** Counts a use of the tool: null while it is within its limit, else the refusal the model is shown. */
  check(tool: string): string | null {
    if (!this.limited(tool)) return null;
    const limit = this.limits[tool];
    const used = (this.counts.get(tool) ?? 0) + 1;
    this.counts.set(tool, used);
    return used > limit ? `Rate limit exceeded for ${tool}: max ${limit} calls per ${this.scope}.` : null;
  }

  /** A new call begins: every count starts again from zero. */
  reset(): void {
    this.counts.clear();
  }
}
