import { isRecord, oneLine } from './text.js';
import { OBJECT_JSON_MAX } from './types.js';
import type { TraceObject } from './types.js';

const MAX_ACTORS = 8;
const MAX_EVENTS = 120;
const MAX_STATE = 8;

/**
 * A trace as the history keeps it (batch C of docs/CHAT_OBJECTS.md): a title, two to eight distinct actors, and at most 120 steps in order, each a message from one actor to another or, with no
 * `to` (or the same actor), something that happens at one actor; a label, an optional note and the state some actors hold after it. A step that names an actor the trace does not have is
 * dropped (so the numbering of the steps the page shows is the numbering the host keeps); a trace with fewer than two actors or no step left is nothing.
 */
export function cleanTrace(raw: unknown): TraceObject | null {
  if (!isRecord(raw) || raw.t !== 'trace') return null;
  const title = oneLine(raw.title, 120);
  if (!title || !Array.isArray(raw.actors) || !Array.isArray(raw.events)) return null;
  const actors: string[] = [];
  for (const a of raw.actors) {
    const name = oneLine(a, 24);
    if (name && !actors.includes(name) && actors.length < MAX_ACTORS) actors.push(name);
  }
  if (actors.length < 2) return null;

  const events: TraceObject['events'] = [];
  for (const e of raw.events) {
    if (events.length >= MAX_EVENTS) break;
    if (!isRecord(e)) continue;
    const from = oneLine(e.from, 24);
    const label = oneLine(e.label, 80);
    if (!actors.includes(from) || !label) continue;
    const toRaw = typeof e.to === 'string' ? oneLine(e.to, 24) : '';
    if (toRaw && !actors.includes(toRaw)) continue;
    const step: TraceObject['events'][number] = { from, label };
    if (toRaw && toRaw !== from) step.to = toRaw;
    const note = oneLine(e.note, 200);
    if (note) step.note = note;
    if (Array.isArray(e.state)) {
      const state: Array<{ actor: string; text: string }> = [];
      for (const s of e.state.slice(0, MAX_STATE)) {
        if (!isRecord(s)) continue;
        const actor = oneLine(s.actor, 24);
        const text = oneLine(s.text, 80);
        if (actors.includes(actor) && text) state.push({ actor, text });
      }
      if (state.length) step.state = state;
    }
    events.push(step);
  }
  if (events.length === 0) return null;
  const out: TraceObject = { t: 'trace', title, actors, events };
  const note = oneLine(raw.note, 200);
  if (note) out.note = note;
  return out;
}

export const traceSummary = (trace: TraceObject): string => `Sequence: ${trace.title} (${trace.events.length} steps)`;

/** The raw trace that the arguments of `show_trace` (`title, actors, events, note?`) stand for: values go to `cleanObject` untouched, `whyNotTrace` says what is wrong when it refuses. */
export function traceFromArgs(args: unknown): Record<string, unknown> {
  const a = isRecord(args) ? args : {};
  return { t: 'trace', title: a.title, actors: a.actors, events: a.events, note: a.note };
}

/** The actors a trace names, as the cleaner reads them (one line each, distinct, at most MAX_ACTORS). */
function actorsOf(raw: Record<string, unknown>): string[] {
  const actors: string[] = [];
  if (Array.isArray(raw.actors)) {
    for (const a of raw.actors) {
      const name = oneLine(a, 24);
      if (name && !actors.includes(name) && actors.length < MAX_ACTORS) actors.push(name);
    }
  }
  return actors;
}

/**
 * Why `cleanObject` would refuse this trace, in a plain sentence a model can act on, or null when it would not: no title, fewer than two distinct actors, no steps, no step that fits (the first one that
 * does not is named by its number), a trace too big for the history's gate. Answers null exactly when `cleanObject(raw)` is an object.
 */
export function whyNotTrace(raw: unknown): string | null {
  if (!isRecord(raw) || raw.t !== 'trace') return 'that is not a trace: give title, actors and events';
  if (!oneLine(raw.title, 120)) return 'the trace needs a title: a few words saying what it shows';
  const actors = actorsOf(raw);
  if (actors.length < 2) return `actors is the list of 2 to 8 distinct names, one lane each (it had ${actors.length})`;
  if (!Array.isArray(raw.events) || raw.events.length === 0) return 'events is the list of steps in order: { from, to?, label, note?, state? }';
  const out = cleanTrace(raw);
  if (!out) {
    const events = raw.events.slice(0, MAX_EVENTS);
    for (let i = 0; i < events.length; i++) {
      const e: unknown = events[i];
      if (!isRecord(e)) return `step ${i + 1} is not an object: each step is { from, to?, label, note?, state? }`;
      if (!actors.includes(oneLine(e.from, 24))) return `step ${i + 1}: from is ${JSON.stringify(oneLine(e.from, 24))}, which is not one of the actors (${actors.join(', ')})`;
      if (!oneLine(e.label, 80)) return `step ${i + 1} has no label: say in a few words what happens`;
      const to = typeof e.to === 'string' ? oneLine(e.to, 24) : '';
      if (to && !actors.includes(to)) return `step ${i + 1}: to is ${JSON.stringify(to)}, which is not one of the actors (${actors.join(', ')})`;
    }
    return 'no step fits the actors: each step needs a from that is one of the actors, and a label';
  }
  const size = JSON.stringify(out).length;
  if (size > OBJECT_JSON_MAX) return `the trace is too big (${size} characters, at most ${OBJECT_JSON_MAX} after cleaning): send fewer steps or shorter notes and states`;
  return null;
}

/** What `cleanTrace` left out (steps that name an actor the trace does not have, or have no label, or come after the 120th), because the steps are numbered from what was kept. */
export function traceDropped(raw: unknown, trace: TraceObject): string {
  if (!isRecord(raw) || !Array.isArray(raw.events)) return '';
  const dropped = raw.events.length - trace.events.length;
  if (dropped <= 0) return '';
  return `Left out of the trace: ${dropped} of ${raw.events.length} steps (they name an actor that is not in actors, have no label, or come after the ${MAX_EVENTS}th); the steps are numbered from the ones kept.`;
}
