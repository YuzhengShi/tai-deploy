/**
 * Bookkeeping the model does not do on its own. Neither qwen nor gpt-oss wrote the strategy log or the interaction summary in the
 * evaluation (eval/RESULTS.md, item 1), so the persona's "is this student new?" test (no interaction-summary.md) kept saying yes and
 * "what did we talk about?" had nothing to read. The runner records every exchange itself, after the answer, in plain code.
 */

import fs from 'fs';
import path from 'path';

const HEADER = '# Interaction summary\n\nRecent exchanges, oldest first. The runner adds one line after every answer and keeps the last 20.\n\n';
const OURS = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — student: /;

export const KEEP_INTERACTIONS = 20;

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** The student's own words out of the host's <messages> wrapper, or the text itself when it is not wrapped. */
export function messageTexts(prompt: string): string[] {
  const found = [...prompt.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g)].map((m) => unescapeXml(m[1]).trim()).filter(Boolean);
  return found.length > 0 ? found : [prompt.trim()].filter(Boolean);
}

/** What the student sees of a reply: without the model's <internal> reasoning. */
export function visibleText(reply: string): string {
  return reply.replace(/<internal\b[\s\S]*?<\/internal\s*>/gi, '').replace(/<internal\b[\s\S]*$/i, '').trim();
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Add one exchange to competency/interaction-summary.md under groupDir and keep the last KEEP_INTERACTIONS of the runner's own lines.
 * Anything else in the file (notes the model wrote itself) is left where it is.
 */
export function appendInteraction(groupDir: string, when: Date, student: string, reply: string): void {
  const dir = path.join(groupDir, 'competency');
  const file = path.join(dir, 'interaction-summary.md');
  fs.mkdirSync(dir, { recursive: true });
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').split('\n');
  } catch {
    lines = HEADER.split('\n');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const stamp = when.toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`- ${stamp} UTC — student: "${oneLine(student, 160)}" → TAi: "${oneLine(reply, 200)}"`);

  const mine = lines.map((l, i) => (OURS.test(l) ? i : -1)).filter((i) => i >= 0);
  const drop = new Set(mine.slice(0, Math.max(0, mine.length - KEEP_INTERACTIONS)));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, lines.filter((_l, i) => !drop.has(i)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}
