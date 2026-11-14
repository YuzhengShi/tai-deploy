import { parseSandboxRequest } from '../sandbox/types.js';
import { isRecord, oneLine } from './text.js';
import { OBJECT_JSON_MAX } from './types.js';
import type { PredictObject } from './types.js';

const MAX_FILES = 6;
const MAX_FILE_CHARS = 6000;
const MAX_CHOICES = 6;

/**
 * A prediction card as the history keeps it (batch C of docs/CHAT_OBJECTS.md): a question, `run` or `test`, a package pattern, and the files of a SMALL program (at most 6 files of 6,000
 * characters). The program goes through the sandbox's own gate (parseSandboxRequest), so what a card holds is exactly what the sandbox would accept to run, with the file names cleaned the same
 * way; a card that the gate refuses is nothing. Two to six options to guess from are optional (each one line of at most 80 characters); with fewer than two the student types a guess.
 */
export function cleanPredict(raw: unknown): PredictObject | null {
  if (!isRecord(raw) || raw.t !== 'predict') return null;
  const question = oneLine(raw.question, 300);
  if (!question || (raw.action !== 'run' && raw.action !== 'test') || !Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > MAX_FILES) return null;
  for (const f of raw.files) {
    if (!isRecord(f) || typeof f.content !== 'string' || f.content.length > MAX_FILE_CHARS) return null;
  }
  const parsed = parseSandboxRequest({ action: raw.action, pkg: raw.pkg, files: raw.files });
  if (!parsed.ok || parsed.value.source.kind !== 'files') return null;
  // the gate has cleaned the names and checked the contents; the code is kept exactly as it was written (a trailing newline is part of a Go file)
  const files = parsed.value.source.files.map((f) => ({ path: f.path, content: f.content }));
  const out: PredictObject = { t: 'predict', question, action: raw.action, pkg: parsed.value.pkg, files };
  if (Array.isArray(raw.choices)) {
    const choices = raw.choices
      .slice(0, MAX_CHOICES)
      .map((c) => oneLine(c, 80))
      .filter(Boolean);
    if (choices.length >= 2) out.choices = choices;
  }
  return out;
}

export const predictSummary = (card: PredictObject): string => `Prediction: ${card.question}`;

/** The raw prediction card that the arguments of `ask_to_predict` (`question, action, pkg, files, choices?`) stand for: values go to `cleanObject` untouched, `whyNotPredict` says what is wrong when it refuses. */
export function predictFromArgs(args: unknown): Record<string, unknown> {
  const a = isRecord(args) ? args : {};
  return { t: 'predict', question: a.question, action: a.action, pkg: a.pkg, files: a.files, choices: a.choices };
}

/**
 * Why `cleanObject` would refuse this prediction card, in a plain sentence a model can act on, or null when it would not: no question, an action that is not `run` or `test`, no files or too many or too long,
 * a program the sandbox's own gate refuses (its sentence, without "Not run:", because nothing was going to run yet), a card too big for the history's gate. Answers null exactly when `cleanObject(raw)` is an object.
 */
export function whyNotPredict(raw: unknown): string | null {
  if (!isRecord(raw) || raw.t !== 'predict') return 'that is not a prediction card: give question, action, pkg and files';
  if (!oneLine(raw.question, 300)) return 'the card needs a question: what the student should guess (for example "what does this print?")';
  if (raw.action !== 'run' && raw.action !== 'test') return 'action is run (go run) or test (go test)';
  if (!Array.isArray(raw.files) || raw.files.length === 0) return `files is the program: 1 to ${MAX_FILES} files of { path, content }`;
  if (raw.files.length > MAX_FILES) return `the program has ${raw.files.length} files: at most ${MAX_FILES}, and a small program is the point`;
  for (let i = 0; i < raw.files.length; i++) {
    const f: unknown = raw.files[i];
    if (!isRecord(f) || typeof f.content !== 'string') return `file ${i + 1} needs a path and its content as text`;
    if (f.content.length > MAX_FILE_CHARS) return `file ${i + 1} is ${f.content.length} characters: at most ${MAX_FILE_CHARS}, and a small program is the point`;
  }
  const parsed = parseSandboxRequest({ action: raw.action, pkg: raw.pkg, files: raw.files });
  if (!parsed.ok) return `the sandbox's check refused the program: ${parsed.message.replace(/^Not run:\s*/, '')}`;
  const out = cleanPredict(raw);
  if (!out) return 'the program is not one the sandbox runs from files: give go files and a package inside them';
  const size = JSON.stringify(out).length;
  if (size > OBJECT_JSON_MAX) return `the card is too big (${size} characters, at most ${OBJECT_JSON_MAX} after cleaning): a smaller program`;
  return null;
}

/** What `cleanPredict` ignored: options that were given but are fewer than two, or more than six. The question and the program are kept as they were, or the card is nothing. */
export function predictDropped(raw: unknown, card: PredictObject): string {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) return '';
  if (card.choices) return card.choices.length < raw.choices.length ? `Only the first ${card.choices.length} of the ${raw.choices.length} options were kept (one line each, two to ${MAX_CHOICES}).` : '';
  return 'The options were not used (give two to six short options, or none): the student types a guess.';
}
