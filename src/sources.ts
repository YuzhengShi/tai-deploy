/**
 * "Looked at": the chips under a reply that say what TAi opened to write it (docs/PROGRESS.md). The runner in the container collects them from the
 * RESULTS of its lookup tools (container/agent-runner/src/progress.ts) and sends them as progress events. This file is the host's side of that, and
 * the host trusts none of it: a container that has been talked into writing to its own stdout can send anything. What it holds to:
 *
 *   - a chip is a `kind` from a fixed list, a label of one line (80 characters) and, only if present, an https address of an allowed host
 *     (the Canvas host and the GitHub host from the environment, github.com, and TAI_SOURCE_HOSTS: the course site is a setting, not a guess);
 *     an address that is anything else (another scheme, a user name in it, a port, another host) is dropped and the chip stays, as a label;
 *   - at most four chips to a message, in the order the tool calls started, each once;
 *   - what is kept for a message is kept for two minutes and by chat: the next answer takes it (SourceNotes).
 *
 * What the host cannot do is tell a label from the tool that was said to give it: it is what the container claims. The words in the page say so
 * ("Looked at", not "Sources"), and docs/PROGRESS.md says it. No import here: the page's own modules and the dev server compile this file.
 */

export type SourceKind = 'canvas' | 'github' | 'piazza' | 'course';
export const SOURCE_KINDS: readonly SourceKind[] = ['canvas', 'github', 'piazza', 'course'];

export interface SourceChip {
  label: string;
  url?: string;
  kind: SourceKind;
}

export const MAX_CHIPS = 4;
export const LABEL_CHARS = 80;
export const URL_CHARS = 300;

/** One line of at most `max` characters: control, format (bidi override, zero width) and line-separator characters gone, white space collapsed, cut with an ellipsis. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The address as the browser will read it, or undefined when it is not one a chip may link to: https only, no user name or password, no port, no
 * white space or control character, at most URL_CHARS long.
 */
export function plainHttps(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > URL_CHARS || /[\s\p{Cc}\p{Cf}]/u.test(text)) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/**
 * The chips of an event as the host takes them from a container: only well-formed ones, labels cut, an address kept when it is a plain https one
 * (whether its host is allowed is clipSources' business). At most `max`; anything that is not a list gives none.
 */
export function shapeSources(raw: unknown, max: number = MAX_CHIPS): SourceChip[] {
  if (!Array.isArray(raw)) return [];
  const chips: SourceChip[] = [];
  for (const entry of raw) {
    if (chips.length >= max) break;
    if (!entry || typeof entry !== 'object') continue;
    const { kind, label, url } = entry as Record<string, unknown>;
    if (typeof kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(kind)) continue;
    const text = oneLine(label, LABEL_CHARS);
    if (!text) continue;
    const link = plainHttps(url);
    chips.push({ kind: kind as SourceKind, label: text, ...(link ? { url: link.href } : {}) });
  }
  return chips;
}

/** What a history line may carry: the chips of shapeSources, and an address only when its host is in `hosts` (lower case, no port). */
export function clipSources(raw: unknown, hosts: ReadonlySet<string>, max: number = MAX_CHIPS): SourceChip[] {
  return shapeSources(raw, max).map((chip) => {
    if (!chip.url) return chip;
    const url = plainHttps(chip.url);
    if (url && hosts.has(url.hostname.toLowerCase())) return chip;
    return { kind: chip.kind, label: chip.label };
  });
}

const hostOf = (value: string | undefined): string => {
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/**
 * The hosts a chip may link to: the Canvas host (CANVAS_BASE_URL), the GitHub the students use (GITHUB_BASE_URL's web host: api.github.com is
 * github.com; github_api.py's own default, the department's GitHub Enterprise, when it is unset), github.com (a call may say host=github.com), and
 * what TAI_SOURCE_HOSTS lists (comma separated: the course site). `read` is readEnvFile: the settings live in .env, not in the environment.
 */
export function sourceHosts(read: (keys: string[]) => Record<string, string>, env: Record<string, string | undefined> = {}): Set<string> {
  const file = read(['CANVAS_BASE_URL', 'GITHUB_BASE_URL', 'TAI_SOURCE_HOSTS']);
  const value = (key: string) => env[key] || file[key];
  const hosts = new Set<string>(['github.com']);
  const canvas = hostOf(value('CANVAS_BASE_URL'));
  if (canvas) hosts.add(canvas);
  const github = value('GITHUB_BASE_URL') ? hostOf(value('GITHUB_BASE_URL')) : 'github.khoury.northeastern.edu';
  if (github) hosts.add(github.startsWith('api.') ? github.slice(4) : github);
  for (const entry of (value('TAI_SOURCE_HOSTS') || '').split(',')) {
    const host = entry.trim().toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) hosts.add(host);
  }
  return hosts;
}

const MAX_GROUPS_PER_CHAT = 16;

/**
 * The chips a chat's turn has collected so far, until the answer that takes them. They are kept by chat, not by message: an answer sent through the
 * send_message tool reaches the host a poll of the IPC directory (up to a second) after the lookup it follows, and after the runner has gone idle, so
 * the turn's end cannot be what clears them; the next turn beginning (reset) and the time (ttl) do. `seq` is the order the tool calls started in, which
 * is the order of use when calls ran side by side.
 */
export class SourceNotes {
  private readonly byChat = new Map<string, { at: number; groups: Array<{ seq: number; items: SourceChip[] }> }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = 120_000,
  ) {}

  add(jid: string, seq: number, items: readonly SourceChip[]): void {
    if (items.length === 0 || !Number.isFinite(seq)) return;
    const entry = this.byChat.get(jid) ?? { at: 0, groups: [] };
    entry.at = this.now();
    if (entry.groups.length < MAX_GROUPS_PER_CHAT) entry.groups.push({ seq, items: [...items] });
    this.byChat.set(jid, entry);
  }

  /** The chips for the next answer of this chat, in order of use, each once, at most MAX_CHIPS; they are not given twice. */
  take(jid: string): SourceChip[] | undefined {
    const entry = this.byChat.get(jid);
    this.byChat.delete(jid);
    if (!entry || this.now() - entry.at > this.ttlMs) return undefined;
    const seen = new Set<string>();
    const chips: SourceChip[] = [];
    for (const group of [...entry.groups].sort((a, b) => a.seq - b.seq)) {
      for (const chip of group.items) {
        const key = `${chip.kind}\u0000${chip.label}\u0000${chip.url ?? ''}`;
        if (seen.has(key) || chips.length >= MAX_CHIPS) continue;
        seen.add(key);
        chips.push(chip);
      }
    }
    return chips.length > 0 ? chips : undefined;
  }

  /** A new turn begins, or the container is gone: what was collected belongs to an answer that will not come. */
  reset(jid: string): void {
    this.byChat.delete(jid);
  }
}
