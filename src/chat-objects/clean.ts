/**
 * The one door by which a chat object enters a student's history (docs/CHAT_OBJECTS.md): `cleanObject` checks and normalizes it (every field bounded, no field it does not know,
 * its JSON at most OBJECT_JSON_MAX), `objectSummary` is the one line it is in the chat's search, copy and screen-reader text, and `clipObject` is both for what a caller hands over.
 */
import { chartSummary, cleanChart } from './chart.js';
import { cleanDoc, docSummary } from './doc.js';
import { cleanPredict, predictSummary } from './predict.js';
import { cleanRun, runSummary } from './run.js';
import { isRecord } from './text.js';
import { cleanTrace, traceSummary } from './trace.js';
import { OBJECT_JSON_MAX } from './types.js';
import type { ChatObject } from './types.js';

export function cleanObject(raw: unknown): ChatObject | null {
  if (!isRecord(raw)) return null;
  let obj: ChatObject | null;
  switch (raw.t) {
    case 'run':
      obj = cleanRun(raw);
      break;
    case 'doc':
      obj = cleanDoc(raw);
      break;
    case 'chart':
      obj = cleanChart(raw);
      break;
    case 'trace':
      obj = cleanTrace(raw);
      break;
    case 'predict':
      obj = cleanPredict(raw);
      break;
    default:
      return null;
  }
  if (!obj) return null;
  try {
    return JSON.stringify(obj).length <= OBJECT_JSON_MAX ? obj : null;
  } catch {
    return null;
  }
}

/** One line (at most about 200 characters) for the line of the history that holds the object. */
export function objectSummary(obj: ChatObject): string {
  switch (obj.t) {
    case 'run':
      return runSummary(obj);
    case 'doc':
      return docSummary(obj);
    case 'chart':
      return chartSummary(obj);
    case 'trace':
      return traceSummary(obj);
    case 'predict':
      return predictSummary(obj);
  }
}

/** What a history line for an object is made of: its summary as the line's `text`, and the cleaned object; null when what was handed over is no object. */
export function clipObject(raw: unknown): { text: string; obj: ChatObject } | null {
  const obj = cleanObject(raw);
  return obj ? { text: objectSummary(obj).slice(0, 240), obj } : null;
}
