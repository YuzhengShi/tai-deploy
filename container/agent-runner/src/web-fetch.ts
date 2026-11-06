/**
 * web_fetch for pi: one public web page as plain text. pi has no web tool of its own. Claude Code's WebFetch fetched a page and had a
 * small model answer a question about it; this returns the text, cut to what the caller asks for, and leaves the reading to the agent.
 *
 * A student's agent must not be a way into the container's own network (guards.ts: privateUrlReason), so a restricted fetch checks the
 * address of every hop, redirects included (the first URL passing the check says nothing about where it sends the client next). The
 * same limits as the guard hold here: a name can change its answer between the check and the fetch (DNS rebinding).
 */

import { privateUrlReason, type Resolver } from './guards.js';

export const DEFAULT_MAX_CHARS = 12_000;
export const HARD_MAX_CHARS = 30_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...' };

/** A page's visible text: no scripts, styles or tags, block elements as line breaks, the common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/blockquote|\/section|\/article|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface FetchedPage {
  url: string; // after the redirects
  status: number;
  contentType: string;
  bytes: number;
  text: string;
  truncated: boolean;
}

export interface FetchOptions {
  /** Check every hop against the private address rules (every container but the admin's). */
  restricted: boolean;
  maxChars?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; capped: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(await response.arrayBuffer()).slice(0, maxBytes), capped: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      capped = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const all = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, all.length - offset);
    all.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= all.length) break;
  }
  return { bytes: all, capped };
}

export async function fetchPage(rawUrl: string, options: FetchOptions): Promise<FetchedPage> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxChars = Math.min(Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, 200), HARD_MAX_CHARS);
  const signals = [AbortSignal.timeout(TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    if (options.restricted) {
      const why = await privateUrlReason(url, options.resolve);
      if (why) throw new Error(`Cannot fetch internal/private URLs (${why}). Only public web pages are accessible.`);
    }
    const response = await doFetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'TAi/1.0 (course assistant)', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
      url = new URL(response.headers.get('location')!, url).toString();
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`The page answered ${response.status} ${response.statusText}`.trim());
    }
    const textual = contentType === '' || contentType.startsWith('text/') || /(json|xml|javascript|yaml|csv)/.test(contentType);
    if (!textual) {
      await response.body?.cancel().catch(() => undefined);
      return { url, status: response.status, contentType, bytes: Number(response.headers.get('content-length')) || 0, text: `[${contentType} content, not shown as text]`, truncated: false };
    }
    const { bytes, capped } = await readCapped(response, MAX_BYTES);
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const text = contentType === 'text/html' || contentType === 'application/xhtml+xml' || (contentType === '' && /^\s*<(!doctype|html)/i.test(raw)) ? htmlToText(raw) : raw.trim();
    const truncated = capped || text.length > maxChars;
    return {
      url,
      status: response.status,
      contentType,
      bytes: bytes.length,
      text: text.length > maxChars ? `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} more characters not shown]` : text,
      truncated,
    };
  }
}
