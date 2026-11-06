/**
 * What the model says is spoken as it arrives, so what must never be spoken is taken out on the way (in the relay, between the gateway and
 * Deepgram). Found in the owner's first real call, 2026-11-02: the model wrote a function call as text, {"function":"send_to_chat",
 * "arguments":{...}}, in the middle of its answer; Deepgram read it out as speech (and never ran it, though TAi then said it had put the
 * text in the chat); it also spoke bold markers, "1." list numbers and "≈" from a Markdown answer.
 *
 *   SpeechFilter       a text stream in, speakable text out: no Markdown, no list numbers, no pictographs or odd symbols, and any {...}
 *                      object held back until it is whole: a function call written as text is taken out and kept as a call, any other
 *                      object is dropped (an object is not a sentence)
 *   SseSpeechTransform the same on the gateway's chat completion stream (SSE lines in, SSE lines out): the content deltas are cleaned, and
 *                      a call written as text is sent on as a real tool_calls delta with finish_reason tool_calls, so Deepgram runs it
 */

import { GovernorOptions, SpeechGovernor } from './speech-governor.js';

export interface LeakedCall {
  name: string;
  arguments: string;
}

const MAX_OBJECT = 24_000; // a send_to_chat message may be 6000 characters; anything longer is not a call we would run
const SYMBOLS: Record<string, string> = {
  '‐': '-', // hyphens that a speech engine may say as "hyphen" or skip
  '‑': '-',
  '−': '-',
  '≈': ' about ',
  '~': ' about ',
  '→': ' to ',
  '⇒': ' to ',
  '×': ' times ',
  '≥': ' at least ',
  '≤': ' at most ',
  '≠': ' not equal to ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  _: ' ',
};
const DROPPED = new Set(['*', '`', '}', '​', '‌', '‍', '‎', '‏', '⁠', '﻿', '️']);
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const BULLETS = new Set(['-', '•', '·']);

export class SpeechFilter {
  private atLineStart = true;
  /** At the start of a line: what might be a list number ("1." or "12)") and is not yet known to be one. */
  private marker = '';
  /** A bullet at the start of a line: dropped when a space follows it, kept when it begins a word. */
  private bullet = '';
  /** A # heading or > quote mark at the start of a line, being dropped. */
  private lead: '' | '#' | '>' = '';
  private object: { text: string; depth: number; inString: boolean; escaped: boolean; discard: boolean; first: boolean } | null = null;
  readonly calls: LeakedCall[] = [];

  constructor(private readonly toolNames: ReadonlySet<string> = new Set()) {}

  /** The text that may be spoken now. */
  push(text: string): string {
    let out = '';
    for (const ch of text) out += this.one(ch);
    return out;
  }

  /** The end of the stream: what was held back (a half list number is text; half an object is lost). */
  end(): string {
    const held = this.marker + this.bullet;
    this.marker = '';
    this.bullet = '';
    this.lead = '';
    this.object = null; // cut off in the middle: it cannot be a call, and it cannot be spoken
    return held;
  }

  private one(ch: string): string {
    if (this.object) return this.inObject(ch);
    if (ch === '{') {
      const held = this.release();
      this.object = { text: '{', depth: 1, inString: false, escaped: false, discard: false, first: true };
      return held;
    }
    if (ch === '\n' || ch === '\r') {
      const held = this.release();
      this.atLineStart = true;
      this.lead = '';
      return held + ch;
    }
    if (DROPPED.has(ch) || PICTOGRAPH.test(ch)) return '';
    if (this.atLineStart) return this.lineStart(ch);
    return this.plain(ch);
  }

  /** What was held at the start of a line, now known to be text. */
  private release(): string {
    const held = this.marker + this.bullet;
    this.marker = '';
    this.bullet = '';
    this.atLineStart = false;
    return held;
  }

  /** The first characters of a line: headings, quotes, bullets and list numbers are marks on the page, not words. */
  private lineStart(ch: string): string {
    if (this.lead) {
      if (ch === this.lead || ch === ' ') return '';
      this.lead = '';
    }
    if (this.bullet) {
      const kept = ch === ' ' ? '' : this.bullet;
      this.bullet = '';
      this.atLineStart = false;
      return ch === ' ' ? '' : kept + this.plain(ch);
    }
    if (this.marker) {
      if (/\d/.test(ch) && /^\d+$/.test(this.marker)) {
        this.marker += ch;
        return '';
      }
      if ((ch === '.' || ch === ')') && /^\d+$/.test(this.marker)) {
        this.marker += ch;
        return '';
      }
      if (ch === ' ' && /^\d+[.)]$/.test(this.marker)) {
        this.marker = '';
        this.atLineStart = false;
        return '';
      }
      const held = this.marker;
      this.marker = '';
      this.atLineStart = false;
      return held + this.plain(ch);
    }
    if (ch === ' ' || ch === '\t') return '';
    if (ch === '#' || ch === '>') {
      this.lead = ch;
      return '';
    }
    if (/\d/.test(ch)) {
      this.marker = ch;
      return '';
    }
    if (BULLETS.has(ch)) {
      this.bullet = ch;
      return '';
    }
    this.atLineStart = false;
    return this.plain(ch);
  }

  private plain(ch: string): string {
    if (PICTOGRAPH.test(ch) || DROPPED.has(ch)) return '';
    return SYMBOLS[ch] ?? ch;
  }

  private inObject(ch: string): string {
    const o = this.object!;
    // JSON starts its first key (or closes at once) right after the brace: anything else is a brace in a sentence, which is spoken as it is
    if (o.first && !/\s/.test(ch)) {
      o.first = false;
      if (ch !== '"' && ch !== '}') {
        this.object = null;
        return this.one(ch);
      }
    }
    if (!o.discard) {
      o.text += ch;
      if (o.text.length > MAX_OBJECT) {
        o.discard = true; // too long to be a call we would run, and not a sentence: swallowed to its end, not spoken
        o.text = '';
      }
    }
    if (o.inString) {
      if (o.escaped) o.escaped = false;
      else if (ch === '\\') o.escaped = true;
      else if (ch === '"') o.inString = false;
      return '';
    }
    if (ch === '"') o.inString = true;
    else if (ch === '{') o.depth++;
    else if (ch === '}') {
      o.depth--;
      if (o.depth === 0) {
        this.object = null;
        if (!o.discard) {
          const call = this.asCall(o.text);
          if (call) this.calls.push(call);
        }
      }
    }
    return '';
  }

  /** {"function": name, "arguments": ...}, {"name": name, "arguments": ...} or {"function": {"name": name, "arguments": ...}}. */
  private asCall(text: string): LeakedCall | null {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const o = value as Record<string, unknown>;
    const inner = o.function && typeof o.function === 'object' ? (o.function as Record<string, unknown>) : null;
    const name = typeof o.function === 'string' ? o.function : typeof o.name === 'string' ? o.name : inner && typeof inner.name === 'string' ? inner.name : '';
    const args = inner && 'arguments' in inner ? inner.arguments : o.arguments;
    if (!name || !this.toolNames.has(name) || args === undefined) return null;
    if (typeof args === 'string') {
      try {
        const parsed: unknown = JSON.parse(args);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      } catch {
        return null;
      }
      return { name, arguments: args };
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { name, arguments: JSON.stringify(args) };
  }
}

// ---------------------------------------------------------------- the stream

type Json = Record<string, unknown>;

const emptyDelta = (delta: Json | null): boolean => !delta || Object.keys(delta).every((k) => k === 'content' && (delta[k] === '' || delta[k] === undefined));

export class SseSpeechTransform {
  private readonly filter: SpeechFilter;
  /** What is said in one answer (speech-governor.ts); none when the transform is built without options. */
  private readonly governor: SpeechGovernor | null;
  private meta: Json = {};
  private realCalls = false;
  private done = false;
  /** For a diagnostic: what the model sent before any of this (its text, and its calls with their arguments), and what was passed on to be spoken. */
  rawContent = '';
  spoken = '';
  readonly rawCalls = new Map<number, { name: string; arguments: string }>();
  finishReason = '';

  constructor(toolNames: ReadonlySet<string>, govern?: Partial<GovernorOptions> | null) {
    this.filter = new SpeechFilter(toolNames);
    this.governor = govern ? new SpeechGovernor(govern, toolNames) : null;
  }

  /** The sentences the governor did not let through (for the diagnostic), and how many of them said something was in the chat. */
  get dropped(): string[] {
    return this.governor?.dropped ?? [];
  }

  get droppedChatClaims(): number {
    return this.governor?.claims ?? 0;
  }

  /** The function calls the model wrote as text (they were sent on as real calls unless the model also made real ones). */
  get textCalls(): LeakedCall[] {
    return this.filter.calls;
  }

  /** Did the model make real function calls (tool_calls) in this answer? */
  get madeCalls(): boolean {
    return this.realCalls;
  }

  /** The stream is over (with or without [DONE]): what is still held, as lines to send. */
  close(): string[] {
    return this.finish(null);
  }

  /** One line of the stream in; the lines to send on out. */
  line(line: string): string[] {
    if (!line.startsWith('data:')) return [line];
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return [...this.finish(null), line];
    let ev: Json;
    try {
      ev = JSON.parse(payload) as Json;
    } catch {
      return [line];
    }
    if (!ev || typeof ev !== 'object' || !Array.isArray(ev.choices)) return [line];
    for (const k of ['id', 'object', 'created', 'model', 'system_fingerprint']) if (k in ev) this.meta[k] = ev[k];
    const choice = ev.choices[0] as Json | undefined;
    if (!choice || typeof choice !== 'object') return [line];
    const delta = (choice.delta && typeof choice.delta === 'object' ? choice.delta : null) as Json | null;
    if (delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      this.realCalls = true;
      for (const tc of delta.tool_calls as Json[]) {
        const at = typeof tc.index === 'number' ? tc.index : 0;
        const fn = (tc.function && typeof tc.function === 'object' ? tc.function : {}) as Json;
        const seen = this.rawCalls.get(at) ?? { name: '', arguments: '' };
        if (typeof fn.name === 'string' && fn.name) seen.name = fn.name;
        if (typeof fn.arguments === 'string') seen.arguments += fn.arguments;
        this.rawCalls.set(at, seen);
      }
    }
    let changed = false;
    if (delta && typeof delta.content === 'string') {
      this.rawContent += delta.content;
      const cleaned = this.filter.push(delta.content);
      const clean = this.governor ? this.governor.push(cleaned) : cleaned;
      this.spoken += clean;
      if (clean !== delta.content) {
        delta.content = clean;
        changed = true;
      }
    }
    const reason = typeof choice.finish_reason === 'string' && choice.finish_reason ? choice.finish_reason : '';
    if (!reason) {
      if (!changed) return [line];
      // a chunk that was only what must not be spoken is not sent (one that carries a role or a call still is)
      if (emptyDelta(delta)) return [];
      return [`data: ${JSON.stringify(ev)}`];
    }
    this.finishReason = reason;
    const more = this.finish(reason);
    if (!more.length) return changed ? [`data: ${JSON.stringify(ev)}`] : [line];
    // this chunk's own words first (without its end), then what was held back and the calls, then the end
    choice.finish_reason = null;
    return [...(emptyDelta(delta) ? [] : [`data: ${JSON.stringify(ev)}`, '']), ...more];
  }

  /** The end of the answer: the text still held, the calls found in the text, and (with `reason`) the closing chunk. Once. */
  private finish(reason: string | null): string[] {
    if (this.done) return [];
    const tail = this.filter.end();
    const text = this.governor ? this.governor.push(tail) + this.governor.end() : tail;
    const calls = this.realCalls ? [] : this.filter.calls;
    if (reason === null && !text && !calls.length) return [];
    this.done = true;
    if (!text && !calls.length) return [];
    const chunk = (delta: Json, end: string | null) => `data: ${JSON.stringify({ ...this.meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: end }] })}`;
    const out: string[] = [];
    this.spoken += text;
    if (text) out.push(chunk({ content: text }, null), '');
    if (calls.length) {
      const stamp = Date.now().toString(36);
      out.push(chunk({ tool_calls: calls.map((c, i) => ({ index: i, id: `call_${stamp}${i}`, type: 'function', function: { name: c.name, arguments: c.arguments } })) }, null), '');
    }
    out.push(chunk({}, calls.length ? 'tool_calls' : reason ?? 'stop'));
    if (reason === null) out.push('');
    return out;
  }
}
