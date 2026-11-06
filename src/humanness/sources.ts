/**
 * The three places a human-likeness report reads, parsed (pure: text in, rows out) and then read from disk:
 *  - the page's history, `store/portal/<folder>.jsonl` (docs/PORTAL.md: one JSON line per thing),
 *  - a call's transcript, `groups/<folder>/competency/voice-transcripts/*.md` (src/voice/competency.ts writes them),
 *  - the relay's diagnostic dump, `TAI_VOICE_RELAY_DUMP` (src/voice/relay.ts: one line per request to the model).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface HistoryRow {
  n: number;
  ts: string;
  role: 'user' | 'assistant';
  /** `text` when the line has no kind. */
  kind: string;
  text: string;
  to?: number;
  emoji?: string;
  rating?: string;
  tag?: string;
}

export function parseHistory(jsonl: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.n !== 'number' || (r.role !== 'user' && r.role !== 'assistant')) continue;
      rows.push({ n: r.n, ts: String(r.ts ?? ''), role: r.role, kind: r.kind ?? 'text', text: String(r.text ?? ''), to: r.to, emoji: r.emoji, rating: r.rating, tag: r.tag });
    } catch {
      /* a half-written last line */
    }
  }
  return rows;
}

export interface Call {
  /** "2026-11-02 08:37", the clock of the host's time zone, as the transcript's title has it. */
  when: string;
  minutes: number;
  /** "conversation", "interview", "talk-through" ... as the title says. */
  mode: string;
  turns: Array<{ who: 'tai' | 'student'; text: string }>;
}

export function parseTranscript(md: string): Call | null {
  const head = /^# (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (\d+) min · (\S+)/m.exec(md);
  if (!head) return null;
  const body = md.split(/^Transcript:\s*$/m)[1] ?? '';
  const turns: Call['turns'] = [];
  for (const line of body.split('\n')) {
    const m = /^- (TAi|Interviewer|Student): (.*)$/.exec(line);
    if (m) turns.push({ who: m[1] === 'Student' ? 'student' : 'tai', text: m[2] });
    else if (turns.length > 0 && line.trim() && !line.startsWith('- ') && !line.startsWith('#')) turns[turns.length - 1].text += ' ' + line.trim();
  }
  return { when: head[1], minutes: Number(head[2]), mode: head[3], turns };
}

export interface DumpRow {
  at: string;
  sid: string;
  /** What the request took, as the relay measured it. */
  ms: number;
  spoken: string;
  notSpoken: string[];
  /** Function calls the model wrote as text instead of making them. */
  writtenAsText: number;
  calls: number;
}

export function parseDump(jsonl: string): DumpRow[] {
  const rows: DumpRow[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line);
      const a = r.answer ?? {};
      const count = (x: unknown) => (Array.isArray(x) ? x.length : typeof x === 'number' ? x : 0);
      rows.push({ at: String(r.at ?? ''), sid: String(r.sid ?? ''), ms: Number(r.ms ?? 0), spoken: String(a.spoken ?? ''), notSpoken: Array.isArray(a.notSpoken) ? a.notSpoken.map(String) : [], writtenAsText: count(a.writtenAsText), calls: count(a.calls) });
    } catch {
      /* a half-written last line */
    }
  }
  return rows;
}

export interface Sources {
  /** folder -> its history */
  histories: Map<string, HistoryRow[]>;
  calls: Call[];
  dump: DumpRow[];
}

function readIf(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Reads what is there. `store`: TAi's store directory (portal histories under portal/), `groups`: the groups directory, `dump`: the relay dump file.
 * The teaching-team chat (folder `main`) is a different conversation with a different reader: left out unless `includeMain`.
 */
export function readSources(opts: { store: string; groups: string; dump?: string; includeMain?: boolean }): Sources {
  const histories = new Map<string, HistoryRow[]>();
  const portal = path.join(opts.store, 'portal');
  for (const f of fs.existsSync(portal) ? fs.readdirSync(portal) : []) {
    if (!f.endsWith('.jsonl')) continue;
    const folder = f.slice(0, -'.jsonl'.length);
    if (folder === 'main' && !opts.includeMain) continue;
    histories.set(folder, parseHistory(readIf(path.join(portal, f))));
  }
  const calls: Call[] = [];
  for (const folder of fs.existsSync(opts.groups) ? fs.readdirSync(opts.groups) : []) {
    if (folder === 'main' && !opts.includeMain) continue;
    const dir = path.join(opts.groups, folder, 'competency', 'voice-transcripts');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
      const call = parseTranscript(readIf(path.join(dir, f)));
      if (call) calls.push(call);
    }
  }
  return { histories, calls, dump: opts.dump ? parseDump(readIf(opts.dump)) : [] };
}
