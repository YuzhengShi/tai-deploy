/** The human-likeness report: what src/humanness/metrics.ts counts, over the period, as Markdown (docs/HUMANNESS.md says how to read it). */
import type { JudgePair, JudgeScore } from './judge.js';
import { openerRepeats, rate, repeatedLines, replyShape, stats, summarizeShapes, type ShapeSummary } from './metrics.js';
import type { Call, HistoryRow, Sources } from './sources.js';

export interface ReportOptions {
  now: Date;
  days: number;
  /** An ISO time: the text replies are summarized before it and after it, side by side (a change shipped at that time). */
  split?: string;
  judged?: JudgeScore[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const one = (x: number) => (Math.round(x * 10) / 10).toString();
const words = (s: ShapeSummary['words']) => `${one(s.mean)} / ${s.median} / ${s.p90} / ${s.max}`;

interface TextReply {
  folder: string;
  row: HistoryRow;
  /** The student's message it answers: the nearest earlier line of theirs. */
  asked: string;
}

function replies(src: Sources, from: string): TextReply[] {
  const out: TextReply[] = [];
  for (const [folder, rows] of src.histories) {
    let asked = '';
    for (const row of rows) {
      if (row.role === 'user' && (row.kind === 'text' || row.kind === 'audio') && row.text) asked = row.text;
      if (row.role === 'assistant' && row.kind === 'text' && row.text && row.ts >= from) out.push({ folder, row, asked });
    }
  }
  return out;
}

function shapeRow(label: string, s: ShapeSummary): string {
  return `| ${label} | ${s.n} | ${words(s.words)} | ${pct(s.overBudget)} | ${pct(s.bullets)} | ${pct(s.bold)} | ${pct(s.closer)} | ${pct(s.endsWithQuestion)} | ${pct(s.manyQuestions)} | ${pct(s.manyLinks)} | ${pct(s.openerRepeat)} |`;
}

const SHAPE_HEAD =
  '| | replies | words: mean / median / p90 / max | over 60 words | bullets | bold | closing formula or offer | ends with ? | 2+ questions | 2+ links | same opening words |\n' +
  '|---|---|---|---|---|---|---|---|---|---|---|';

function studentSignals(src: Sources, from: string, replied: TextReply[]): string[] {
  const emojis = new Map<string, number>();
  const ratings = { up: 0, down: 0 };
  const tags = new Map<string, number>();
  const longWords: number[] = [];
  const byFolder = new Map<string, Map<number, HistoryRow>>();
  for (const r of replied) {
    if (!byFolder.has(r.folder)) byFolder.set(r.folder, new Map());
    byFolder.get(r.folder)!.set(r.row.n, r.row);
  }
  for (const [folder, rows] of src.histories) {
    // the last line for a message is how it stands: an empty emoji or rating takes it back
    const emoji = new Map<number, string>();
    const rating = new Map<number, HistoryRow>();
    for (const row of rows) {
      if (row.role !== 'user' || row.ts < from || row.to === undefined) continue;
      if (row.kind === 'react') emoji.set(row.to, row.emoji ?? '');
      if (row.kind === 'feedback') rating.set(row.to, row);
    }
    for (const e of emoji.values()) if (e) emojis.set(e, (emojis.get(e) ?? 0) + 1);
    for (const [to, f] of rating) {
      if (f.rating === 'up') ratings.up++;
      else if (f.rating === 'down') ratings.down++;
      else continue;
      if (f.tag) tags.set(f.tag, (tags.get(f.tag) ?? 0) + 1);
      const target = rows.find((r) => r.n === to);
      if (f.tag === 'long' && target) longWords.push(replyShape(target.text).words);
    }
    void folder;
  }
  const lines: string[] = [];
  lines.push(emojis.size > 0 ? `- Emoji on TAi's messages: ${[...emojis].map(([e, c]) => `${e} ${c}`).join(', ')}` : '- Emoji on TAi\'s messages: none');
  lines.push(
    ratings.up + ratings.down > 0
      ? `- Ratings: ${ratings.up} up, ${ratings.down} down${tags.size > 0 ? ` (${[...tags].map(([t, c]) => `${t} ${c}`).join(', ')})` : ''}${longWords.length > 0 ? `; the ones marked too long averaged ${one(stats(longWords).mean)} words` : ''}`
      : '- Ratings: none yet',
  );
  return lines;
}

function agentTurns(calls: Call[]): string[] {
  return calls.flatMap((c) => c.turns.filter((t) => t.who === 'tai').map((t) => t.text));
}

function voiceSection(src: Sources, since: Date): string[] {
  const day = since.toISOString().slice(0, 10);
  const calls = src.calls.filter((c) => c.when.slice(0, 10) >= day);
  const dump = src.dump.filter((d) => d.at >= since.toISOString());
  const lines: string[] = [];
  if (calls.length === 0 && dump.length === 0) return ['None in the period.'];
  if (calls.length > 0) {
    const modes = new Map<string, number>();
    for (const c of calls) modes.set(c.mode, (modes.get(c.mode) ?? 0) + 1);
    const turns = agentTurns(calls);
    const shapes = turns.map(replyShape);
    const w = stats(shapes.map((s) => s.words));
    lines.push(`- ${calls.length} call(s), ${calls.reduce((a, c) => a + c.minutes, 0)} min (${[...modes].map(([m, c]) => `${m} ${c}`).join(', ')})`);
    lines.push(
      `- TAi's turns: ${w.n}; words mean ${one(w.mean)}, p90 ${w.p90}, max ${w.max}; over 40 words ${pct(rate(shapes.map((s) => s.words > 40)))}; ` +
        `2+ questions ${pct(rate(shapes.map((s) => s.questions > 1)))}; ends with a question ${pct(rate(shapes.map((s) => s.endsWithQuestion)))}; same opening words ${pct(openerRepeats(turns))}`,
    );
    const again = repeatedLines(turns).slice(0, 3);
    if (again.length > 0) lines.push(`- Said more than once: ${again.map((r) => `"${r.text}" x${r.count}`).join(', ')}`);
  }
  if (dump.length > 0) {
    const ms = stats(dump.map((d) => d.ms));
    lines.push(
      `- Relay: ${dump.length} requests to the model; sentences cut by the speech governor in ${pct(rate(dump.map((d) => d.notSpoken.length > 0)))}; ` +
        `function calls written as text in ${pct(rate(dump.map((d) => d.writtenAsText > 0)))}; answer time median ${ms.median} ms, p90 ${ms.p90} ms`,
    );
  }
  return lines;
}

/** Evenly spaced picks, so a sample covers the whole period. */
function pick<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]);
}

/** Exchanges for the judge: typed replies with what they answered, and spoken turns with the student's words before them. */
export function samplePairs(src: Sources, from: string, n: number): JudgePair[] {
  const text: JudgePair[] = replies(src, from).filter((r) => r.asked).map((r) => ({ kind: 'text', student: r.asked, reply: r.row.text }));
  const voice: JudgePair[] = [];
  for (const c of src.calls) {
    let said = '';
    for (const t of c.turns) {
      if (t.who === 'student') said = t.text;
      else if (said) voice.push({ kind: 'voice', student: said, reply: t.text });
    }
  }
  const half = Math.ceil(n / 2);
  return [...pick(text, half), ...pick(voice, n - Math.min(half, text.length))].slice(0, n);
}

function judgeSection(judged: JudgeScore[]): string[] {
  if (judged.length === 0) return ['No scores (the gateway did not answer, or the judge was not asked for).'];
  const lines: string[] = [];
  for (const kind of ['text', 'voice'] as const) {
    const of = judged.filter((j) => j.kind === kind);
    if (of.length === 0) continue;
    const mean = (f: (j: JudgeScore) => number) => one(of.reduce((a, j) => a + f(j), 0) / of.length);
    lines.push(`- ${kind}: ${of.length} exchanges; human ${mean((j) => j.human)}, brief ${mean((j) => j.brief)}, honest ${mean((j) => j.honest)} (of 5)`);
  }
  const tells = new Map<string, number>();
  for (const j of judged) for (const t of j.tells) tells.set(t.toLowerCase(), (tells.get(t.toLowerCase()) ?? 0) + 1);
  const top = [...tells].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length > 0) lines.push(`- What gave it away most often: ${top.map(([t, c]) => `${t} (${c})`).join(', ')}`);
  return lines;
}

export function buildReport(src: Sources, opt: ReportOptions): string {
  const since = new Date(opt.now.getTime() - opt.days * 86400000);
  const from = since.toISOString();
  const all = replies(src, from);
  const out: string[] = [];
  out.push('# TAi human-likeness report');
  out.push(
    `Period: the last ${opt.days} day(s), ${from.slice(0, 10)} to ${opt.now.toISOString().slice(0, 10)}. Read: ${src.histories.size} chat(s), ${src.calls.length} call transcript(s) (all time), ${src.dump.length} relay request(s) (all time).`,
  );
  out.push('', '## Text replies', '');
  if (all.length === 0) out.push('None in the period.');
  else {
    out.push(SHAPE_HEAD);
    out.push(shapeRow('all', summarizeShapes(all.map((r) => r.row.text))));
    if (opt.split) {
      const before = all.filter((r) => r.row.ts < opt.split!);
      const after = all.filter((r) => r.row.ts >= opt.split!);
      if (before.length > 0) out.push(shapeRow(`before ${opt.split}`, summarizeShapes(before.map((r) => r.row.text))));
      if (after.length > 0) out.push(shapeRow(`after ${opt.split}`, summarizeShapes(after.map((r) => r.row.text))));
    }
  }
  out.push('', '## What students did with them', '', ...studentSignals(src, from, all));
  out.push('', '## Voice calls', '', ...voiceSection(src, since));
  if (all.length > 0) {
    out.push('', '## Longest text replies', '');
    [...all]
      .sort((a, b) => replyShape(b.row.text).words - replyShape(a.row.text).words)
      .slice(0, 3)
      .forEach((r, i) => {
        const flat = (s: string, max: number) => (s.replace(/\s+/g, ' ').length > max ? s.replace(/\s+/g, ' ').slice(0, max) + '...' : s.replace(/\s+/g, ' '));
        out.push(`${i + 1}. n=${r.row.n} (${replyShape(r.row.text).words} words), after "${flat(r.asked, 60)}": "${flat(r.row.text, 110)}"`);
      });
  }
  if (opt.judged) out.push('', '## Judge (a model grading a sample, 1-5: a trend, not a verdict)', '', ...judgeSection(opt.judged));
  return out.join('\n') + '\n';
}
