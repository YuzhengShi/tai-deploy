/**
 * The conversation the stand-in keeps for the think step, with the behaviours of Deepgram's Voice Agent that the rest of TAi was written against (docs/VOICE_SELFBUILT.md 3.1):
 * consecutive lines of one role are one message; an `UpdatePrompt` is a system message put in at that point of the conversation (the relay's `questionLast` moves it when it
 * ends up behind the student's words); an `UpdateThink` replaces the first system prompt and keeps everything said; `function_calls` items of the Settings' context become an
 * assistant message with its tool calls and the tool replies; and an answer that the student interrupted is in the history only as far as it was spoken.
 */
import type { HistoryItem } from '../context-builder.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const MAX_MESSAGES = 400;

export class LabHistory {
  private prompt = '';
  private items: ChatMessage[] = [];
  private repairs = 0;

  setPrompt(prompt: string): void {
    this.prompt = prompt;
  }

  /** The Settings' `context.messages` (Deepgram's `History` items), at the start of the call. */
  loadContext(items: ReadonlyArray<HistoryItem | Record<string, unknown>>): void {
    for (const raw of items) {
      const item = raw as { role?: unknown; content?: unknown; function_calls?: unknown };
      if (Array.isArray(item.function_calls)) {
        const calls: ToolCall[] = [];
        const replies: ChatMessage[] = [];
        for (const f of item.function_calls as Array<{ id?: unknown; name?: unknown; arguments?: unknown; response?: unknown }>) {
          if (typeof f?.id !== 'string' || typeof f.name !== 'string') continue;
          calls.push({ id: f.id, type: 'function', function: { name: f.name, arguments: typeof f.arguments === 'string' ? f.arguments : '{}' } });
          replies.push({ role: 'tool', tool_call_id: f.id, content: typeof f.response === 'string' ? f.response : '' });
        }
        if (calls.length) this.items.push({ role: 'assistant', content: '', tool_calls: calls }, ...replies);
      } else if ((item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim()) {
        this.push(item.role, item.content);
      }
    }
  }

  /** A system message at this point of the conversation (what `UpdatePrompt` does). */
  addSystemNote(text: string): void {
    if (text.trim()) this.items.push({ role: 'system', content: text });
    this.trim();
  }

  addUser(text: string): void {
    this.push('user', text);
  }

  /** What the agent said (a sentence of the model's answer or an injected line); joins the assistant message before it when there is one without tool calls. */
  addAssistant(text: string): void {
    this.push('assistant', text);
  }

  /**
   * The model asked for functions: they go on the assistant message that holds what it said before them (the sentences of this very completion, which were added as they were
   * cut), or on a new one with no words when it said nothing. Their replies follow with `addToolResult`.
   */
  addToolCalls(calls: ToolCall[]): void {
    const last = this.items[this.items.length - 1];
    if (last && last.role === 'assistant' && !last.tool_calls?.length) last.tool_calls = calls;
    else this.items.push({ role: 'assistant', content: '', tool_calls: calls });
    this.trim();
  }

  addToolResult(id: string, content: string): void {
    this.items.push({ role: 'tool', tool_call_id: id, content });
  }

  /** The calls that have no reply yet (the student spoke before the functions came back): taken out of the conversation with the assistant message that made them, so that the next request is a valid one. */
  dropUnansweredToolCalls(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const answered = new Set(this.items.slice(i + 1).filter((x) => x.role === 'tool').map((x) => (x as { tool_call_id: string }).tool_call_id));
        if (m.tool_calls.every((c) => answered.has(c.id))) return;
        // some or all unanswered: the calls and the replies that did come go, the words it said before them stay if there were any
        const kept = m.content.trim();
        const rest = this.items.slice(i + 1).filter((x) => x.role !== 'tool');
        this.items.length = i;
        if (kept) this.items.push({ role: 'assistant', content: kept });
        this.items.push(...rest);
        return;
      }
      if (m.role === 'user') return;
    }
  }

  /**
   * The end of the last assistant message (what was added to it since the student last spoke: `added`) replaced by `kept`, the part of it that was spoken before the student spoke over
   * it; the lines before it in the same message (a greeting, a filler, sentences played out) stay as they were. A message left with no words is removed. A message that does not end in
   * `added` is left alone, and so is one with tool calls.
   */
  cutTail(added: string, kept: string): void {
    const tail = added.trim();
    if (!tail) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      if (m.role === 'user') return;
      if (m.role === 'assistant' && !m.tool_calls?.length) {
        if (!m.content.endsWith(tail)) return;
        const rest = m.content.slice(0, m.content.length - tail.length).trimEnd();
        const joined = [rest, kept.trim()].filter(Boolean).join(' ');
        if (joined) m.content = joined;
        else this.items.splice(i, 1);
        return;
      }
    }
  }

  /** The text of the assistant message that is last in the conversation, or '' when the last message is another one (for tests and the trace). */
  get lastAssistantText(): string {
    const m = this.items[this.items.length - 1];
    return m && m.role === 'assistant' && !m.tool_calls?.length ? m.content : '';
  }

  /** The last message is the student's (an answer is owed): for a resumed turn whose first part was never answered, `addUser` joins the two. */
  get endsWithUser(): boolean {
    return this.items[this.items.length - 1]?.role === 'user';
  }

  /** The messages for a request: the prompt first (when there is one), then the conversation as a model accepts it (see `valid`). */
  toMessages(): ChatMessage[] {
    const out: ChatMessage[] = [];
    if (this.prompt) out.push({ role: 'system', content: this.prompt });
    for (const m of this.valid()) out.push(m.role === 'tool' ? { ...m } : { ...m, ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c) => ({ ...c, function: { ...c.function } })) } : {}) });
    return out;
  }

  /** How many times a request had to be repaired since the last call of this (zero: the conversation was always valid). The agent warns when it is not. */
  takeRepairs(): number {
    const n = this.repairs;
    this.repairs = 0;
    return n;
  }

  /**
   * The conversation as a model takes it: an assistant message with calls is followed at once by the replies to ALL of them, and no reply stands without its call (DeepSeek, like OpenAI,
   * answers 400 to anything else, and a conversation that is refused once is refused for the rest of the call: the first call on the lab was lost that way, 2026-11-14, when a filler was
   * said between a call and its reply). The sequence should never be wrong; if it is, the request is repaired here (the words of a message whose calls are not all answered stay, the calls
   * and the replies that did come go) and the repair is counted.
   */
  private valid(): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const m = this.items[i];
      if (m.role === 'tool') {
        this.repairs++; // a reply that no call before it asked for
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const replies: ChatMessage[] = [];
        let j = i + 1;
        while (j < this.items.length && this.items[j].role === 'tool') replies.push(this.items[j++]);
        const answered = new Set(replies.map((r) => (r as { tool_call_id: string }).tool_call_id));
        if (m.tool_calls.every((c) => answered.has(c.id))) {
          const asked = new Set(m.tool_calls.map((c) => c.id));
          out.push(m, ...replies.filter((r) => asked.has((r as { tool_call_id: string }).tool_call_id)));
          if (replies.some((r) => !asked.has((r as { tool_call_id: string }).tool_call_id))) this.repairs++;
        } else {
          this.repairs++;
          if (m.content.trim()) out.push({ role: 'assistant', content: m.content });
        }
        i = j - 1;
        continue;
      }
      out.push(m);
    }
    return out;
  }

  /** Every line the student and the agent said, in order, for the reconnect context and the tests: user and assistant text only. */
  get spoken(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.items.filter((m): m is { role: 'user' | 'assistant'; content: string } => (m.role === 'user' || m.role === 'assistant') && !('tool_calls' in m && m.tool_calls?.length) && !!m.content).map((m) => ({ role: m.role, content: m.content }));
  }

  private push(role: 'user' | 'assistant', text: string): void {
    const t = text.trim();
    if (!t) return;
    const last = this.items[this.items.length - 1];
    if (role === 'assistant' && last && last.role === 'assistant' && last.tool_calls?.length) {
      // said while the calls run (a filler: "one sec."): it goes into the words of the message that holds the calls, so that their replies still follow that message directly
      last.content = `${last.content} ${t}`.trim();
      return;
    }
    if (last && last.role === role && !('tool_calls' in last && last.tool_calls?.length)) last.content = `${last.content} ${t}`.trim();
    else this.items.push({ role, content: t });
    this.trim();
  }

  /** A call is at most two hours: the oldest messages go before a request becomes unreasonable (the relay refuses more than 500), never in the middle of a tool exchange. */
  private trim(): void {
    while (this.items.length > MAX_MESSAGES) {
      let cut = 1;
      while (cut < this.items.length && this.items[cut].role !== 'user') cut++;
      this.items.splice(0, cut);
    }
  }
}
