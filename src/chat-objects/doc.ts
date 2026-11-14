import { DOC_ID, DOC_LIMITS, DOC_ORIGINS } from '../docs/types.js';
import { int, isRecord, oneLine } from './text.js';
import type { DocObject } from './types.js';

/** A document card as the history keeps it: a prepared document's id, a title on one line, how many pages, and where it opens; null when it is not one. */
export function cleanDoc(raw: unknown): DocObject | null {
  if (!isRecord(raw) || raw.t !== 'doc') return null;
  if (typeof raw.doc !== 'string' || !DOC_ID.test(raw.doc)) return null;
  const title = oneLine(raw.title, DOC_LIMITS.titleChars);
  const pages = int(raw.pages, 1, 500);
  if (!title || pages === null) return null;
  const page = int(raw.page, 1, pages);
  const origin = DOC_ORIGINS.find((o) => o === raw.origin);
  return { t: 'doc', doc: raw.doc, title, pages, ...(page !== null ? { page } : {}), ...(origin ? { origin } : {}) };
}

export const docSummary = (doc: DocObject): string => `Document: ${doc.title} (${doc.pages} page${doc.pages === 1 ? '' : 's'})`;
