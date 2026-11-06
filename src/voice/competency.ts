/**
 * COMPETENCY.md from the voice side: read it (for the call's context and the read_competency function), change one concept at a time
 * (update_competency, behind a guard), and write what a mock interview and a whole call leave behind (competency/interviews.md,
 * competency/strategy-log.md, competency/voice-sessions.md and the interview summary of COMPETENCY.md).
 *
 * The file format is groups/global/COMPETENCY_TEMPLATE.md and COMPETENCY_PROTOCOL.md. A mastery line comes in two spellings, and the
 * text agent writes either, so both are read and a line is rewritten in the spelling it already has:
 *   Docker concepts: 0.3 | 0.1 | [theoretical] | [socratic_dialogue] | 2026-03-01                                       (the template)
 *   Docker concepts: confidence: 0.3 | stability: 0.1 | scope: [theoretical] | via: [socratic_dialogue] | last: 2026-03-01   (the protocol)
 * (and an older one with "confidence: ..." on the line under the name, which is read the same way).
 *
 * The guard is the voice twin of the text agent's (container/agent-runner/src/guards.ts, createCompetencyGuardHook): there a write that
 * newly puts three concepts at 0.8 or above is refused; here a change is one concept, at most 0.3 either way, at most five increases in a
 * call, and at most two concepts newly raised to 0.8 or above in a call (a third is held just under it). A student talking the model
 * into "you're an expert at everything" gets nowhere either way.
 */
import fs from 'fs';
import path from 'path';

import { readTextSafe, writeFileAtomicSafe } from '../safe-fs.js';
import type { AgentMode } from './types.js';

// ---------------------------------------------------------------- files

/**
 * The text of a file, or null (not there, a link, not a regular file, over 2 MB: src/safe-fs.ts says why). `root` is the student's folder for a file
 * inside it: a directory that leads out of it (`competency -> ../..`) is "no file" too.
 */
export function readText(file: string, root?: string): string | null {
  return readTextSafe(file, undefined, root);
}

/**
 * Write through a temporary file and a rename: a crash or a concurrent reader never sees half a file. Throws for a file that is a link or not a regular
 * file, and (with `root`, the student's folder) for a directory that leads out of it. Without a root only the file itself is checked.
 */
export function writeFileAtomic(file: string, content: string, root?: string): void {
  if (root === undefined) fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomicSafe(file, content, root ?? path.dirname(file));
}

export function competencyFile(groupDir: string): string {
  return path.join(groupDir, 'COMPETENCY.md');
}

// ---------------------------------------------------------------- mastery lines

export type MasteryFormat = 'compact' | 'labelled' | 'labelled2';

export interface MasteryEntry {
  /** Index of the (first) line in the file's lines. */
  line: number;
  /** How many lines it takes (2 for the older spelling). */
  span: number;
  prefix: string;
  /** The older spelling's second line starts with this. */
  indent2: string;
  name: string;
  confidence: number;
  stability: number;
  scope: string[];
  via: string[];
  last: string;
  format: MasteryFormat;
}

const NUM = String.raw`(\d*\.?\d+)`;
const COMPACT = new RegExp(
  String.raw`^(\s*(?:[-*]\s+)?)(.+?):\s*${NUM}\s*\|\s*${NUM}\s*(?:\|\s*\[([^\]]*)\]\s*)?(?:\|\s*\[([^\]]*)\]\s*)?(?:\|\s*(.*?))?\s*$`,
);
const LABELLED_FIELDS = String.raw`confidence\s*[:=]\s*${NUM}\s*\|\s*stability\s*[:=]\s*${NUM}\s*(?:\|\s*scope\s*[:=]\s*\[([^\]]*)\]\s*)?(?:\|\s*via\s*[:=]\s*\[([^\]]*)\]\s*)?(?:\|\s*last(?:_evidence)?\s*[:=]\s*(.*?))?\s*$`;
const LABELLED = new RegExp(String.raw`^(\s*(?:[-*]\s+)?)(.+?):\s*${LABELLED_FIELDS}`, 'i');
const NAME_ONLY = /^(\s*(?:[-*]\s+)?)([^:|#][^:|]*?):\s*$/;
const SECOND_LINE = new RegExp(String.raw`^(\s+)${LABELLED_FIELDS}`, 'i');

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 0 -> "0.0", 0.55 -> "0.55", 1 -> "1.0": the way the files spell scores. */
export function score(n: number): string {
  const rounded = Math.round(clamp01(n) * 100) / 100;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

/** Where a concept stands, in the words the student's page uses (the "What TAi remembers" panel and the activity of a call): one set of bands for both. */
export const SOLID_AT = 0.7;
export const GETTING_THERE_AT = 0.4;
export function levelWord(confidence: number): string {
  if (confidence >= SOLID_AT) return 'solid';
  if (confidence >= GETTING_THERE_AT) return 'getting there';
  return confidence > 0 ? 'just started' : 'not started';
}

/** Every mastery line of the file, whichever spelling. Headings and prose are skipped. */
export function parseMastery(text: string): MasteryEntry[] {
  const lines = text.split('\n');
  const out: MasteryEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (/^\s*#/.test(line)) continue;
    let m = line.match(LABELLED);
    if (m) {
      out.push(entry(i, 1, m[1], '', m[2], m[3], m[4], m[5], m[6], m[7], 'labelled'));
      continue;
    }
    m = line.match(COMPACT);
    if (m && !/confidence/i.test(m[2])) {
      out.push(entry(i, 1, m[1], '', m[2], m[3], m[4], m[5], m[6], m[7], 'compact'));
      continue;
    }
    const head = line.match(NAME_ONLY);
    const next = lines[i + 1]?.replace(/\r$/, '');
    const second = head && next !== undefined ? next.match(SECOND_LINE) : null;
    if (head && second) {
      out.push(entry(i, 2, head[1], second[1], head[2], second[2], second[3], second[4], second[5], second[6], 'labelled2'));
      i++;
    }
  }
  return out;
}

function entry(
  line: number,
  span: number,
  prefix: string,
  indent2: string,
  name: string,
  conf: string,
  stab: string,
  scope: string | undefined,
  via: string | undefined,
  last: string | undefined,
  format: MasteryFormat,
): MasteryEntry {
  return {
    line,
    span,
    prefix,
    indent2,
    name: name.trim(),
    confidence: clamp01(parseFloat(conf) || 0),
    stability: clamp01(parseFloat(stab) || 0),
    scope: list(scope),
    via: list(via),
    last: (last || 'never').trim() || 'never',
    format,
  };
}

/** The line(s) of an entry, in its own spelling. */
export function renderMastery(e: MasteryEntry): string[] {
  const scope = `[${e.scope.join(', ')}]`;
  const via = `[${e.via.join(', ')}]`;
  if (e.format === 'compact') return [`${e.prefix}${e.name}: ${score(e.confidence)} | ${score(e.stability)} | ${scope} | ${via} | ${e.last}`];
  const fields = `confidence: ${score(e.confidence)} | stability: ${score(e.stability)} | scope: ${scope} | via: ${via} | last: ${e.last}`;
  if (e.format === 'labelled') return [`${e.prefix}${e.name}: ${fields}`];
  return [`${e.prefix}${e.name}:`, `${e.indent2 || '  '}${fields}`];
}

// ---------------------------------------------------------------- finding a concept by what the model calls it

const STOP = new Set(['and', 'the', 'of', 'a', 'an', 'in', 'on', 'to', 'for', 'vs', 'with', 'how', 'what', 'is', 'its', 'their']);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w));
}

/**
 * The entry a name means: the same name, or the one whose words best cover the name's words ("Raft leader election" finds
 * "Raft (leader election, log replication)"). Nothing below two thirds of the words matching: a wrong concept is worse than a new one.
 */
export function findConcept(entries: MasteryEntry[], name: string): MasteryEntry | undefined {
  const wanted = name.trim().toLowerCase();
  const exact = entries.find((e) => e.name.toLowerCase() === wanted);
  if (exact) return exact;
  const q = [...new Set(words(name))];
  if (q.length === 0) return undefined;
  if (q.length === 1) {
    // one word is only a name when a concept starts with it ("raft", "paxos", "docker"), not when it appears somewhere inside ("leader")
    const firstWord = entries.filter((e) => words(e.name)[0] === q[0]);
    return firstWord.sort((a, b) => words(a.name).length - words(b.name).length)[0];
  }
  let best: { e: MasteryEntry; score: number; size: number } | undefined;
  for (const e of entries) {
    const w = new Set(words(e.name));
    if (w.size === 0) continue;
    const hit = q.filter((x) => w.has(x) || [...w].some((y) => y.length > 3 && x.length > 3 && (y.startsWith(x) || x.startsWith(y)))).length;
    const s = hit / q.length;
    if (s >= 0.66 && (!best || s > best.score || (s === best.score && w.size < best.size))) best = { e, score: s, size: w.size };
  }
  return best?.e;
}

// ---------------------------------------------------------------- reading

interface Misconception {
  belief: string;
  contradicts: string;
  line: string;
}

export function section(text: string, heading: RegExp): { start: number; end: number; body: string } | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start + 1, end).join('\n') };
}

export function parseMisconceptions(text: string): Misconception[] {
  const sec = section(text, /^##\s+Active Misconceptions/i);
  if (!sec) return [];
  const out: Misconception[] = [];
  for (const raw of sec.body.split('\n')) {
    const line = raw.trim();
    const fields = misconceptionFields(line);
    if (!/contradicts\s*:/i.test(fields) || line.startsWith('- Format') || line.startsWith('<!--')) continue;
    const belief = line.match(/"([^"]{3,})"/)?.[1] || line.replace(/^[-*]\s*/, '').split('|')[0].trim();
    const contradicts = fields.match(/contradicts\s*:\s*([^|]+)/i)?.[1]?.trim() || '';
    if (belief && !belief.startsWith('[')) out.push({ belief, contradicts, line });
  }
  return out;
}

function profileField(text: string, label: RegExp): string {
  const m = text.match(label);
  const value = m?.[1]?.trim() || '';
  return value.startsWith('[') ? '' : value;
}

export interface StudentProfile {
  name: string;
  currentWeek: string;
  learningStyle: string;
  github: string;
}

export function parseProfile(text: string): StudentProfile {
  return {
    name: profileField(text, /^(?:[-*\s]*)?\**(?:Student name|Student|Name)\**:\s*([^\n\r]+)/im),
    currentWeek: profileField(text, /^[-*\s]*Current week:\s*([^\n\r]+)/im),
    learningStyle: profileField(text, /^[-*\s]*Learning style:\s*([^\n\r]+)/im),
    github: profileField(text, /^[-*\s]*GitHub:\s*([^\n\r]+)/im),
  };
}

function describe(e: MasteryEntry): string {
  const scope = e.scope.length ? `, scope [${e.scope.join(', ')}]` : '';
  return `${e.name}: confidence ${score(e.confidence)}, stability ${score(e.stability)}${scope}`;
}

function approachesThatWork(text: string): string[] {
  const sec = section(text, /^##\s+Effective Approaches/i);
  if (!sec) return [];
  const lines = sec.body.split('\n');
  const start = lines.findIndex((l) => /^###\s+Approaches That Work/i.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^###/.test(l)) break;
    const t = l.trim();
    if (!t || t.startsWith('<!--') || /^None yet/i.test(t)) continue;
    out.push(t.replace(/^[-*]\s*/, ''));
    if (out.length >= 3) break;
  }
  return out;
}

/** Weak spots, verbal gaps and misconceptions: what an interviewer should probe (both mastery spellings). */
export function interviewProfile(text: string): { name: string; weakConcepts: string[]; verbalGaps: string[]; misconceptions: string[] } {
  const entries = parseMastery(text);
  return {
    name: parseProfile(text).name,
    weakConcepts: entries.filter((e) => e.confidence > 0 && e.confidence < 0.5).map((e) => `${e.name} (${score(e.confidence)})`),
    verbalGaps: entries.filter((e) => e.confidence >= 0.3 && !e.scope.includes('verbal')).map((e) => e.name),
    misconceptions: parseMisconceptions(text).map((m) => m.belief),
  };
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const nl = head.lastIndexOf('\n');
  return (nl > max * 0.6 ? head.slice(0, nl) : head) + '\n[...]';
}

/** The student's state in a few lines: what read_competency answers with no topic, and what a call starts with. */
export function summarizeCompetency(text: string | null, maxChars = 3000): string {
  if (!text || !text.trim()) return 'No competency record yet: this student has not been assessed. Find out where they are with a question or two.';
  const profile = parseProfile(text);
  const entries = parseMastery(text);
  const touched = entries.filter((e) => e.confidence > 0 || e.scope.length > 0);
  const lines: string[] = [];
  const who = [profile.name && `Student: ${profile.name}`, profile.currentWeek && `current week: ${profile.currentWeek}`, profile.learningStyle && `learning style: ${profile.learningStyle}`]
    .filter(Boolean)
    .join(' | ');
  if (who) lines.push(who);
  const strong = touched.filter((e) => e.confidence >= 0.7).sort((a, b) => b.confidence - a.confidence);
  const middle = touched.filter((e) => e.confidence >= 0.5 && e.confidence < 0.7);
  const weak = touched.filter((e) => e.confidence < 0.5).sort((a, b) => a.confidence - b.confidence);
  if (strong.length) lines.push(`Strong: ${strong.slice(0, 8).map(describe).join('; ')}`);
  if (middle.length) lines.push(`Getting there: ${middle.slice(0, 8).map(describe).join('; ')}`);
  if (weak.length) lines.push(`Weak: ${weak.slice(0, 10).map(describe).join('; ')}`);
  const gaps = entries.filter((e) => e.confidence >= 0.3 && !e.scope.includes('verbal'));
  if (gaps.length) lines.push(`Verbal gaps (knows it, has not explained it out loud): ${gaps.slice(0, 10).map((e) => e.name).join(', ')}`);
  const mis = parseMisconceptions(text);
  if (mis.length) lines.push(`Active misconceptions: ${mis.slice(0, 5).map((m) => `"${m.belief}"${m.contradicts ? ` (contradicts ${m.contradicts})` : ''}`).join('; ')}`);
  const works = approachesThatWork(text);
  if (works.length) lines.push(`What works for this student: ${works.join('; ')}`);
  const untouched = entries.length - touched.length;
  if (untouched > 0) lines.push(`${untouched} course concepts not discussed yet (confidence 0).`);
  if (lines.length === 0) lines.push('The competency record has no scores yet.');
  return cut(lines.join('\n'), maxChars);
}

/** read_competency with a topic: the matching concepts and misconceptions, or a note that nothing is recorded. */
export function competencyForTopic(text: string | null, topic: string, maxChars = 6000): string {
  if (!text) return summarizeCompetency(text, maxChars);
  const q = words(topic);
  if (q.length === 0) return summarizeCompetency(text, maxChars);
  const entries = parseMastery(text).filter((e) => {
    const w = new Set(words(e.name));
    return q.some((x) => w.has(x));
  });
  const mis = parseMisconceptions(text).filter((m) => q.some((x) => words(`${m.belief} ${m.contradicts}`).includes(x)));
  if (entries.length === 0 && mis.length === 0) return `Nothing recorded about "${topic}" yet.\n\n${summarizeCompetency(text, Math.min(maxChars, 1500))}`;
  const lines = entries.map((e) => `${describe(e)}, via [${e.via.join(', ')}], last ${e.last}`);
  for (const m of mis) lines.push(`Misconception: "${m.belief}"${m.contradicts ? ` (contradicts ${m.contradicts})` : ''}`);
  return cut(lines.join('\n'), maxChars);
}

// ---------------------------------------------------------------- update_competency

export interface CompetencyUpdate {
  concept?: unknown;
  confidence_delta?: unknown;
  new_scope?: unknown;
  misconception?: unknown;
  notes?: unknown;
}

export interface CompetencyChange {
  concept: string;
  before: number;
  after: number;
  scope: string[];
  misconception?: string;
}

export const SCOPES = ['theoretical', 'implementation', 'debugging', 'verbal'];

export interface GuardLimits {
  maxDelta: number;
  maxIncreases: number;
  maxNewHigh: number;
  high: number;
}

export const DEFAULT_LIMITS: GuardLimits = { maxDelta: 0.3, maxIncreases: 5, maxNewHigh: 2, high: 0.8 };

export function cleanName(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\r\n\t|[\]]+/g, ' ')
    .replace(/:/g, ' -')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanNote(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, max);
}

function skeleton(today: string): string {
  return [
    '# Student Competency Model',
    '',
    `Last updated: ${today}`,
    '',
    '## Mastery Scores',
    '',
    'Format: concept: confidence | stability | scope | via | last_evidence',
    '',
    '## Active Misconceptions',
    '',
    'None yet.',
    '',
    '## Mock Interview Summary',
    '',
    '- Most recent interview: none yet',
    '',
  ].join('\n');
}

/** The student's COMPETENCY.md, created from the template when there is none yet (the bootstrap normally makes it). */
export function loadOrCreateCompetency(groupDir: string, templateFile: string | undefined, today: string): string {
  const existing = readText(competencyFile(groupDir), groupDir);
  if (existing !== null) return existing;
  const template = templateFile ? readText(templateFile) : null;
  return (template ?? skeleton(today)).replace(/^Last updated:.*$/m, `Last updated: ${today}`);
}

function majorityFormat(entries: MasteryEntry[]): MasteryFormat {
  const labelled = entries.filter((e) => e.format !== 'compact').length;
  return labelled > entries.length / 2 ? 'labelled' : 'compact';
}

/** The heading a concept first met somewhere other than the template goes under: where it was met, so a reader can tell the course's own lines from these. */
export interface ConceptHeading {
  match: RegExp;
  title: string;
}
export const VOICE_HEADING: ConceptHeading = { match: /^###\s+Voice sessions/i, title: '### Voice sessions (concepts first met in a voice call)' };

/** Puts a new mastery line at the end of "## Mastery Scores", under a "### Voice sessions" heading of its own (the chat has its own: `under`). */
export function insertConcept(lines: string[], e: MasteryEntry, under: ConceptHeading = VOICE_HEADING): void {
  let start = lines.findIndex((l) => /^##\s+Mastery Scores/i.test(l));
  if (start === -1) {
    const before = lines.findIndex((l) => /^##\s+(Active Misconceptions|Mock Interview Summary)/i.test(l));
    const at = before === -1 ? lines.length : before;
    lines.splice(at, 0, '## Mastery Scores', '');
    start = at;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let heading = -1;
  for (let i = start + 1; i < end; i++) if (under.match.test(lines[i])) heading = i;
  const rendered = renderMastery(e);
  if (heading === -1) {
    let at = end;
    while (at > start + 1 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, '', under.title, ...rendered);
    return;
  }
  let at = heading + 1;
  while (at < end && lines[at].trim() !== '' && !/^#/.test(lines[at])) at++;
  lines.splice(at, 0, ...rendered);
}

/**
 * A belief as it may stand inside the quotes of a misconception line: no quote, no bar and no colon. A belief is a student's near-words (a model's
 * sentence about what they said), and the patrol's gate, the team view and the parser read the line's own fields with `status: confirmed`, `freq: 3`,
 * `contradicts: X` patterns: a belief that carried one would make a first sighting "confirmed", close the line, or file it under another concept.
 */
export function neutralBelief(raw: string): string {
  return raw.replace(/"/g, "'").replace(/\|/g, '/').replace(/[:：]/g, ' -').replace(/\s+/g, ' ').trim();
}

/** What a misconception line says after its quoted belief: its fields (`| contradicts: ... | status: ...`). Lines that have no leading quoted belief are read whole. No field is ever read out of the belief. */
export function misconceptionFields(line: string): string {
  const m = /^\s*(?:[-*]\s+)?"[^"]*"([\s\S]*)$/.exec(line);
  return m ? m[1] : line;
}

/** Returns what it did: a line is `recorded` (new), `counted` (seen again) or `confirmed` (the third sighting). `source` says where it was seen in the line's remediation field. */
export function recordMisconception(lines: string[], rawBelief: string, concept: string, today: string, source: 'voice' | 'chat' = 'voice'): 'recorded' | 'counted' | 'confirmed' {
  const belief = neutralBelief(rawBelief);
  const start = lines.findIndex((l) => /^##\s+Active Misconceptions/i.test(l));
  const line = `- "${belief}" | contradicts: ${concept} | status: candidate | freq: 1 | first: ${today} | last: ${today} | holding | remediation: none yet (${source}) | effective: unknown`;
  if (start === -1) {
    const before = lines.findIndex((l) => /^##\s+Mock Interview Summary/i.test(l));
    const at = before === -1 ? lines.length : before;
    lines.splice(at, 0, '## Active Misconceptions', '', line, '');
    return 'recorded';
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const lower = belief.toLowerCase();
  for (let i = start + 1; i < end; i++) {
    const quoted = lines[i].match(/"([^"]+)"/)?.[1];
    if (quoted && neutralBelief(quoted).toLowerCase() === lower && /contradicts\s*:/i.test(misconceptionFields(lines[i]))) {
      // seen before: count it, and three sightings make it confirmed (COMPETENCY_PROTOCOL.md, "Misconception Detection"). Only the fields after the quoted belief are edited
      const split = lines[i].indexOf('"', lines[i].indexOf('"') + 1) + 1;
      const head = lines[i].slice(0, split);
      let tail = lines[i].slice(split).replace(/freq:\s*(\d+)/i, (_m, n: string) => `freq: ${parseInt(n, 10) + 1}`).replace(/last:\s*[^|]+/i, `last: ${today} `);
      const freq = parseInt(tail.match(/freq:\s*(\d+)/i)?.[1] || '1', 10);
      if (freq >= 3) tail = tail.replace(/status:\s*candidate/i, 'status: confirmed');
      lines[i] = (head + tail).replace(/\s+\|/g, ' |');
      return freq >= 3 ? 'confirmed' : 'counted';
    }
  }
  const placeholder = lines.findIndex((l, i) => i > start && i < end && /^None yet\b/i.test(l.trim()));
  if (placeholder !== -1) {
    lines[placeholder] = line;
    return 'recorded';
  }
  let at = start + 1;
  while (at < end && lines[at].trim() === '') at++;
  lines.splice(at, 0, line);
  return 'recorded';
}

/** Prepends an entry under a file's first heading (the way the competency logs grow: newest first). */
export function prependLog(file: string, title: string, entry: string, root?: string): void {
  const current = readText(file, root);
  if (current === null) {
    // not there: a new log. There, and still not readable (a link, a FIFO, over 2 MB): the student's own doing, and not to be replaced by the host
    let there = true;
    try {
      fs.lstatSync(file);
    } catch {
      there = false;
    }
    if (there) throw new Error('refused: the log is not a regular file the host may read');
    writeFileAtomic(file, `# ${title}\n\n${entry}\n`, root);
    return;
  }
  const headingEnd = current.indexOf('\n\n');
  const at = headingEnd !== -1 && current.startsWith('#') ? headingEnd + 2 : 0;
  writeFileAtomic(file, current.slice(0, at) + entry + '\n' + current.slice(at), root);
}

export function signed(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r > 0 ? `+${r}` : String(r);
}

/** What a mastery line's `via` may say (COMPETENCY_PROTOCOL.md, "Demonstrated Via Update"). */
export const VIAS = ['socratic_dialogue', 'code_review', 'homework', 'mock_interview', 'explanation_to_peer'];

/** Where a concept first met in the text chat goes in "## Mastery Scores" (the voice side has its own: VOICE_HEADING). */
export const CHAT_HEADING: ConceptHeading = { match: /^###\s+Chat sessions/i, title: '### Chat sessions (concepts first met in a chat)' };

/** What a chat exchange showed about one concept, already weighed by the caller (src/competency-writer.ts); the guard decides what of it may be written. */
export interface ChatChange {
  concept: string;
  /** The confidence change the caller allows for this evidence; the guard still clamps it and spends its budgets. */
  delta: number;
  /** One of SCOPES. */
  scope?: string;
  /** One of VIAS (default socratic_dialogue). */
  via?: string;
  /** A belief the student holds. `existing` is the exact wording of the line it matches, so a paraphrase counts as another sighting of that line. */
  misconception?: { belief: string; existing?: string };
}

export interface ChatChangeResult {
  concept: string;
  ok: boolean;
  /** Why nothing, or less than asked, was written. */
  reason?: string;
  before: number;
  after: number;
  /** A third concept raised to 0.8 or above in one run is held just under it. */
  held: boolean;
  /** The concept had no line: one was added. */
  added: boolean;
  scope: string[];
  misconception?: 'recorded' | 'counted' | 'confirmed';
}

/** One call's memory of what it has already changed, so the limits hold across the call, not per function call. */
export class CompetencyGuard {
  private increases = 0;
  private newHigh = new Set<string>();
  readonly changes: CompetencyChange[] = [];
  private readonly limits: GuardLimits;

  constructor(limits: Partial<GuardLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Applies one update_competency call to groups/<folder>/COMPETENCY.md and answers what the model is told. Never throws: a file that
   * cannot be written is an answer too.
   */
  apply(groupDir: string, update: CompetencyUpdate, opts: { today: string; templateFile?: string }): { ok: boolean; message: string; change?: CompetencyChange } {
    const concept = cleanName(update.concept, 80);
    if (!concept) return { ok: false, message: 'No change made: name the concept (for example "Raft leader election").' };
    let delta = typeof update.confidence_delta === 'number' ? update.confidence_delta : parseFloat(String(update.confidence_delta ?? ''));
    if (!Number.isFinite(delta)) delta = 0;
    delta = Math.max(-this.limits.maxDelta, Math.min(this.limits.maxDelta, delta));
    const newScope = typeof update.new_scope === 'string' && SCOPES.includes(update.new_scope) ? update.new_scope : '';
    const misconception = cleanNote(update.misconception, 300);
    const notes = cleanNote(update.notes, 300);
    if (delta === 0 && !newScope && !misconception && !notes) return { ok: false, message: 'No change made: give a confidence_delta, a new_scope or a misconception.' };
    if (delta > 0 && this.increases >= this.limits.maxIncreases) {
      return { ok: false, message: `No change made: at most ${this.limits.maxIncreases} confidence increases per call. Keep teaching; the next session can record more.` };
    }

    try {
      const file = competencyFile(groupDir);
      const text = loadOrCreateCompetency(groupDir, opts.templateFile, opts.today);
      const lines = text.split('\n');
      const entries = parseMastery(text);
      const found = findConcept(entries, concept);
      const before = found?.confidence ?? 0;
      let after = clamp01(before + delta);
      let held = false;
      if (after >= this.limits.high && before < this.limits.high) {
        const key = (found?.name ?? concept).toLowerCase();
        if (!this.newHigh.has(key) && this.newHigh.size >= this.limits.maxNewHigh) {
          after = Math.max(before, Math.round((this.limits.high - 0.01) * 100) / 100);
          held = true;
        } else {
          this.newHigh.add(key);
        }
      }
      const appliedDelta = after - before;
      const e: MasteryEntry = found
        ? { ...found, scope: [...found.scope], via: [...found.via] }
        : { line: -1, span: 1, prefix: '', indent2: '', name: concept, confidence: 0, stability: 0, scope: [], via: [], last: 'never', format: majorityFormat(entries) };
      e.confidence = after;
      if (appliedDelta > 0) e.stability = clamp01(before > 0 ? Math.max(e.stability, 0.1) + 0.1 : Math.max(e.stability, 0.1));
      else if (appliedDelta < 0) e.stability = clamp01(e.stability - 0.2);
      const addScope = (s: string) => {
        if (s && !e.scope.includes(s)) e.scope.push(s);
      };
      addScope(newScope);
      if (appliedDelta > 0) addScope('verbal'); // it was said out loud: that is the verbal scope (COMPETENCY_PROTOCOL.md)
      if ((appliedDelta !== 0 || newScope) && !e.via.includes('socratic_dialogue')) e.via.push('socratic_dialogue');
      if (appliedDelta !== 0 || newScope) e.last = opts.today;

      if (found) lines.splice(found.line, found.span, ...renderMastery(e));
      else if (appliedDelta !== 0 || newScope) insertConcept(lines, e);
      if (misconception) recordMisconception(lines, misconception, e.name, opts.today);
      let out = lines.join('\n');
      out = /^Last updated:/m.test(out) ? out.replace(/^Last updated:.*$/m, `Last updated: ${opts.today}`) : out;
      writeFileAtomic(file, out, groupDir);
      if (delta > 0) this.increases++;

      if (appliedDelta !== 0 || notes) {
        const outcome = appliedDelta > 0 ? 'effective' : appliedDelta < 0 ? 'ineffective' : 'unclear';
        prependLog(
          path.join(groupDir, 'competency', 'strategy-log.md'),
          'Teaching Strategy Log',
          `- ${opts.today}: VOICE on ${e.name} | ${score(before)}→${score(after)} (${signed(appliedDelta)}) | voice call | ${outcome} | ${notes || 'from a voice call'}`,
          groupDir,
        );
      }

      const change: CompetencyChange = { concept: e.name, before, after, scope: e.scope, ...(misconception ? { misconception } : {}) };
      this.changes.push(change);
      const parts = [`Recorded for "${e.name}": confidence ${score(before)} -> ${score(after)}`, `scope [${e.scope.join(', ')}]`];
      if (held) parts.push(`held below ${this.limits.high}: at most ${this.limits.maxNewHigh} concepts are newly raised that high in one call, confirm it again in a later session`);
      if (misconception) parts.push('misconception noted (do not tell the student it was recorded)');
      return { ok: true, message: parts.join('; ') + '.', change };
    } catch (err) {
      return { ok: false, message: `No change made: the competency file could not be written (${(err as Error).message.slice(0, 120)}).` };
    }
  }

  /**
   * What the host writes after an exchange of the text chat (src/competency-writer.ts): the same limits as `apply`, one run's worth at a time, and
   * ONE read and ONE atomic write for all of it. `apply` is voice-shaped (it adds "verbal" to every increase, files every concept under the voice
   * heading, logs a "VOICE" strategy line), so the chat has its own method rather than a flag on that one: nothing here changes what `apply` writes.
   * What differs, and why:
   *   - scope and via come from the caller; nothing is "verbal" unless the caller says it was spoken (a typed answer is not the mock interview's risk);
   *   - a concept met in the chat goes under its own heading; the strategy log is the caller's (it knows the strategy and the outcome);
   *   - stability is "how confirmed": a first sighting is 0.1 and each later DAY that shows it again adds 0.1, so an hour of one conversation is one
   *     demonstration, not five; evidence against what it showed before takes 0.2 off;
   *   - an increase that the budget refuses, or a new concept over `maxNewConcepts`, is not an error: its misconception (if any) is still recorded;
   *   - `dryRun` computes everything and writes nothing (the writer's shadow mode).
   * Never throws.
   */
  applyChat(
    groupDir: string,
    changes: ChatChange[],
    opts: { today: string; templateFile?: string; maxNewConcepts?: number; dryRun?: boolean },
  ): ChatChangeResult[] {
    const nothing = (concept: string, reason: string, before = 0): ChatChangeResult => ({ concept, ok: false, reason, before, after: before, held: false, added: false, scope: [] });
    const results: ChatChangeResult[] = [];
    try {
      const lines = loadOrCreateCompetency(groupDir, opts.templateFile, opts.today).split('\n');
      let written = false;
      let added = 0;
      for (const change of changes) {
        const concept = cleanName(change.concept, 80);
        if (!concept) {
          results.push(nothing('', 'no concept name'));
          continue;
        }
        const entries = parseMastery(lines.join('\n')); // read again each time: a concept added above moves the lines below it
        const found = findConcept(entries, concept);
        const before = found?.confidence ?? 0;
        let delta = typeof change.delta === 'number' && Number.isFinite(change.delta) ? change.delta : 0;
        delta = Math.max(-this.limits.maxDelta, Math.min(this.limits.maxDelta, delta));
        const scope = typeof change.scope === 'string' && SCOPES.includes(change.scope) ? change.scope : '';
        const via = typeof change.via === 'string' && VIAS.includes(change.via) ? change.via : 'socratic_dialogue';
        const belief = change.misconception ? cleanNote(change.misconception.belief, 200).replace(/\|/g, '/') : '';
        let reason: string | undefined;
        if (delta > 0 && this.increases >= this.limits.maxIncreases) {
          delta = 0;
          reason = `at most ${this.limits.maxIncreases} confidence increases per run`;
        } else if (delta > 0 && !found && added >= (opts.maxNewConcepts ?? 2)) {
          delta = 0;
          reason = `at most ${opts.maxNewConcepts ?? 2} new concepts per exchange`;
        }
        let after = Math.round(clamp01(before + delta) * 100) / 100;
        let held = false;
        if (after >= this.limits.high && before < this.limits.high) {
          const key = (found?.name ?? concept).toLowerCase();
          if (!this.newHigh.has(key) && this.newHigh.size >= this.limits.maxNewHigh) {
            after = Math.max(before, Math.round((this.limits.high - 0.01) * 100) / 100);
            held = true;
          } else {
            this.newHigh.add(key);
          }
        }
        const applied = Math.round((after - before) * 100) / 100;
        const e: MasteryEntry = found
          ? { ...found, scope: [...found.scope], via: [...found.via] }
          : { line: -1, span: 1, prefix: '', indent2: '', name: concept, confidence: 0, stability: 0, scope: [], via: [], last: 'never', format: majorityFormat(entries) };
        let addedNow = false;
        if (applied !== 0) {
          e.confidence = after;
          if (applied > 0) e.stability = clamp01(Math.max(e.stability, 0.1) + (before > 0 && e.last !== opts.today ? 0.1 : 0));
          else e.stability = clamp01(e.stability - 0.2);
          if (scope && !e.scope.includes(scope)) e.scope.push(scope);
          if (!e.via.includes(via)) e.via.push(via);
          e.last = opts.today;
          if (found) lines.splice(found.line, found.span, ...renderMastery(e));
          else {
            insertConcept(lines, e, CHAT_HEADING);
            addedNow = true;
            added++;
          }
          written = true;
        }
        if (delta > 0) this.increases++;
        let misconception: ChatChangeResult['misconception'];
        if (belief) {
          // `existing` is the wording of a line the belief matches: the same text counts the sighting, a new wording would start a line that never reaches three
          misconception = recordMisconception(lines, change.misconception?.existing || belief, e.name, opts.today, 'chat');
          written = true;
        }
        const ok = applied !== 0 || misconception !== undefined;
        results.push({ concept: e.name, ok, ...(reason ? { reason } : ok ? {} : { reason: 'no change' }), before, after, held, added: addedNow, scope: e.scope, ...(misconception ? { misconception } : {}) });
        if (ok) this.changes.push({ concept: e.name, before, after, scope: e.scope, ...(belief ? { misconception: belief } : {}) });
      }
      if (written && !opts.dryRun) {
        let out = lines.join('\n');
        out = /^Last updated:/m.test(out) ? out.replace(/^Last updated:.*$/m, `Last updated: ${opts.today}`) : out;
        writeFileAtomic(competencyFile(groupDir), out, groupDir);
      }
      return results;
    } catch (err) {
      const why = `the competency file could not be written (${(err as Error).message.slice(0, 120)})`;
      return changes.map((c) => nothing(cleanName(c.concept, 80), why));
    }
  }
}

// ---------------------------------------------------------------- after a mock interview

export interface InterviewRubric {
  verbal_clarity: number;
  technical_accuracy: number;
  depth_of_reasoning: number;
  problem_solving_process: number;
}

export interface InterviewResults {
  assignmentName: string;
  date: string;
  durationMinutes: number;
  /** null: no answer was scored (the shadow evaluator was never called). */
  rubric: InterviewRubric | null;
  strengths: string[];
  weaknesses: string[];
  topicsCovered: string[];
  overallImpression?: string;
  questions: number;
}

export function overallRating(rubric: InterviewRubric | null): string {
  if (!rubric) return 'not scored';
  const avg = (rubric.verbal_clarity + rubric.technical_accuracy + rubric.depth_of_reasoning + rubric.problem_solving_process) / 4;
  if (avg >= 4) return 'strong';
  if (avg >= 2.5) return 'adequate';
  return 'needs-work';
}

export function rubricLine(rubric: InterviewRubric | null): string {
  if (!rubric) return 'no answers were scored';
  return `clarity ${rubric.verbal_clarity}/5, accuracy ${rubric.technical_accuracy}/5, depth ${rubric.depth_of_reasoning}/5, process ${rubric.problem_solving_process}/5`;
}

/**
 * Writes a mock interview's results (port of voice/competency-writer.ts): "verbal" and "mock_interview" on the concepts it covered, the
 * Mock Interview Summary of COMPETENCY.md, an entry at the top of competency/interviews.md and of competency/strategy-log.md. A
 * session with nothing scored and under three minutes is a test and stays out of the strategy log.
 */
export function writeInterviewResults(groupDir: string, r: InterviewResults, templateFile?: string): void {
  const file = competencyFile(groupDir);
  let index = loadOrCreateCompetency(groupDir, templateFile, r.date);
  const lines = index.split('\n');
  const entries = parseMastery(index);
  // later lines first, so the indices of the earlier ones stay right while lines are replaced
  const hits = new Map<number, MasteryEntry>();
  for (const topic of r.topicsCovered) {
    const e = findConcept(entries, topic);
    if (e) hits.set(e.line, e);
  }
  for (const e of [...hits.values()].sort((a, b) => b.line - a.line)) {
    const next = { ...e, scope: [...e.scope], via: [...e.via], last: r.date };
    if (!next.scope.includes('verbal')) next.scope.push('verbal');
    if (!next.via.includes('mock_interview')) next.via.push('mock_interview');
    lines.splice(e.line, e.span, ...renderMastery(next));
  }
  index = lines.join('\n');
  const gaps = interviewProfile(index).verbalGaps;
  const block = [
    '## Mock Interview Summary',
    '',
    `- Most recent interview: ${r.date}, ${r.assignmentName}, ${r.durationMinutes} min (voice) — ${overallRating(r.rubric)}: ${rubricLine(r.rubric)}`,
    `- Consistent gaps: ${r.weaknesses.length ? r.weaknesses.join('; ') : 'none noted this time'} (pattern: competency/interviews.md)`,
    `- Verbal scope earned: ${r.topicsCovered.length ? r.topicsCovered.join(', ') : 'none this session'}`,
    `- Verbal gaps (mock interview risk): ${gaps.length ? gaps.slice(0, 8).join(', ') : 'none recorded'}`,
    '- → Full history + upcoming focus: `competency/interviews.md`',
    '',
  ].join('\n');
  const all = index.split('\n');
  const sec = section(index, /^##\s+Mock Interview Summary/i);
  if (sec) {
    all.splice(sec.start, sec.end - sec.start, ...block.split('\n'));
    index = all.join('\n');
  } else {
    index = index.trimEnd() + '\n\n' + block;
  }
  index = index.replace(/^Last updated:.*$/m, `Last updated: ${r.date}`);
  writeFileAtomic(file, index, groupDir);

  const dir = path.join(groupDir, 'competency');
  const interviewsPath = path.join(dir, 'interviews.md');
  const entry = [
    `- ${r.date}: ${r.assignmentName} (voice mock interview, ${r.durationMinutes} min, ${r.questions} answers scored)`,
    `  Overall: ${overallRating(r.rubric)}`,
    `  Strengths: ${r.strengths.join(', ') || 'none noted'}`,
    `  Weaknesses: ${r.weaknesses.join(', ') || 'none noted'}`,
    `  Rubric scores: ${r.rubric ? `verbal_clarity: ${r.rubric.verbal_clarity}/5, technical_accuracy: ${r.rubric.technical_accuracy}/5, depth_of_reasoning: ${r.rubric.depth_of_reasoning}/5, problem_solving_process: ${r.rubric.problem_solving_process}/5` : 'none'}`,
    `  Topics: ${r.topicsCovered.join(', ') || 'none recorded'}`,
    ...(r.overallImpression ? [`  Interviewer's impression: ${cleanNote(r.overallImpression, 400)}`] : []),
    `  Strategy used: VOICE_INTERVIEW (Deepgram voice agent, ${r.durationMinutes} min)`,
    `  Follow-up needed: ${r.weaknesses[0] || 'none'}`,
    '',
  ].join('\n');
  const marker = '## Interview History (most recent first)';
  const current = readText(interviewsPath, groupDir);
  if (current === null) {
    const header = [
      '# Interview History',
      '',
      '## Upcoming Interview Focus',
      '- Week: [update manually]',
      '- Homework: [update manually]',
      '',
      '## Verbal vs Written Gap Analysis',
      '- Concepts missing verbal scope: [auto-populated from COMPETENCY.md mastery scores]',
      '',
      marker,
      '',
      '',
    ].join('\n');
    writeFileAtomic(interviewsPath, header + entry, groupDir);
  } else {
    const at = current.indexOf(marker);
    writeFileAtomic(interviewsPath, at === -1 ? entry + '\n' + current : current.slice(0, at + marker.length) + '\n\n' + entry + current.slice(at + marker.length).replace(/^\n+/, '\n'), groupDir);
  }

  const isTest = r.durationMinutes < 3 && !r.rubric;
  if (!isTest) {
    prependLog(
      path.join(dir, 'strategy-log.md'),
      'Teaching Strategy Log',
      `- ${r.date}: VOICE_INTERVIEW on ${r.assignmentName} — ${r.durationMinutes} min, ${r.topicsCovered.length} topics covered. Rubric: ${rubricLine(r.rubric)}`,
      groupDir,
    );
  }
}

// ---------------------------------------------------------------- the call's own record

export interface TranscriptLine {
  role: 'student' | 'tai';
  text: string;
  mode: AgentMode;
}

/** What marks a line of another mode in voice-sessions.md: the interview and the talk-through are read differently from a conversation. */
function modeTag(mode: AgentMode): string {
  return mode === 'interviewer' ? ' (interview)' : mode === 'listener' ? ' (talk-through)' : '';
}

export interface VoiceSessionRecord {
  startedAt: string; // "2026-11-01 14:05"
  minutes: number;
  modes: string;
  summary: string;
  competency: string[];
  transcript: TranscriptLine[];
}

const KEEP_SESSIONS = 30;
const MAX_TRANSCRIPT_CHARS = 12_000;
const KEEP_ARCHIVE = 200;

/**
 * competency/voice-sessions.md: the newest call first, the thirty newest kept, each transcript capped (the text agent reads it when a
 * student refers to a call). Every call is also kept whole in competency/voice-transcripts/, one file each: the owner's first call was
 * pushed out of the ten newest by a day of test calls, and a transcript is what shows what went wrong in a call.
 */
export function appendVoiceSession(groupDir: string, rec: VoiceSessionRecord): void {
  const file = path.join(groupDir, 'competency', 'voice-sessions.md');
  const header = '# Voice Sessions\n\nMost recent first. Written by the voice call when it ends (src/voice); read it when the student refers to a call.\n';
  const lines: string[] = [];
  let used = 0;
  for (const t of rec.transcript) {
    const line = `- ${t.role === 'student' ? 'Student' : 'TAi'}${modeTag(t.mode)}: ${t.text.replace(/\s+/g, ' ').trim()}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS) {
      lines.push(`- [... ${rec.transcript.length - lines.length} more turns not kept]`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const block = [
    `## ${rec.startedAt} · ${rec.minutes} min · ${rec.modes}`,
    '',
    `Summary: ${rec.summary.replace(/\s+/g, ' ').trim()}`,
    ...(rec.competency.length ? [`Competency: ${rec.competency.join('; ')}`] : []),
    '',
    'Transcript:',
    ...lines,
    '',
  ].join('\n');
  const current = readText(file, groupDir) ?? '';
  const previous = current.split(/\n(?=## )/).filter((part) => part.startsWith('## ')).slice(0, KEEP_SESSIONS - 1);
  writeFileAtomic(file, [header, block, ...previous.map((p) => p.trimEnd() + '\n')].join('\n'), groupDir);

  try {
    const archive = path.join(groupDir, 'competency', 'voice-transcripts');
    fs.mkdirSync(archive, { recursive: true });
    const stamp = rec.startedAt.replace(/[^0-9]/g, '').slice(0, 12);
    const whole = rec.transcript.map((t) => `- ${t.role === 'student' ? 'Student' : 'TAi'}${modeTag(t.mode)}: ${t.text.replace(/\s+/g, ' ').trim()}`);
    writeFileAtomic(path.join(archive, `${stamp}-${Date.now().toString(36)}.md`), [`# ${rec.startedAt} · ${rec.minutes} min · ${rec.modes}`, '', `Summary: ${rec.summary.replace(/\s+/g, ' ').trim()}`, '', 'Transcript:', ...whole, ''].join('\n'), groupDir);
    const names = fs.readdirSync(archive).filter((n) => n.endsWith('.md')).sort();
    for (const old of names.slice(0, Math.max(0, names.length - KEEP_ARCHIVE))) fs.rmSync(path.join(archive, old), { force: true });
  } catch {
    /* an archive that cannot be written is not worth a failed call record */
  }
}
