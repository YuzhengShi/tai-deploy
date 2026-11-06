/**
 * A student taps an option of TAi's (src/choices.ts says what an option is): what their message says, what TAi is told with it, and whether
 * the tap was the answer TAi marked. Pure functions on a history line, so the arithmetic of grading can be tested without a server.
 */
import type { HistoryEntry } from './history.js';

const oneLine = (text: string, max: number): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
};

export interface Tap {
  /** The student's message: the letter and the option, as they would have typed it. */
  text: string;
  /** The line for TAi only, ahead of the student's words (it begins "[The student", which the reply budget does not count as theirs). */
  note: string;
  /** Whether the tap was the answer TAi marked; absent when TAi marked none (a quick reply, or a quick check it did not key). */
  correct?: boolean;
}

/** The tap on option `index` of TAi's line, or null when the line has no such option. */
export function tapOn(line: HistoryEntry, index: number): Tap | null {
  const options = line.choices;
  const picked = options?.[index];
  if (!options || !picked) return null;
  const key = line.secret?.key;
  const marked = key !== undefined ? options[key] : undefined;
  const correct = marked ? key === index : undefined;
  const ask = oneLine(line.text, 240);
  const listed = line.quiz ? ` The options were: ${options.map((o) => `${o.label}) ${oneLine(o.text, OPTION_ECHO)}`).join('; ')}.` : '';
  const chose = `${picked.label}, "${oneLine(picked.text, OPTION_ECHO)}"`;
  let verdict = '';
  if (correct === true) verdict = ' That is the answer you marked.';
  else if (correct === false && marked) verdict = ` The answer you marked was ${marked.label}, "${oneLine(marked.text, OPTION_ECHO)}".`;
  else if (line.secret?.doubt) {
    verdict = ' The answer you marked did not hold up when other models checked it, so it was not kept: judge their pick on its merits, and say so if more than one option is defensible or none is.';
  }
  const why = line.secret?.why ? ` Your note on it: ${oneLine(line.secret.why, 400)}` : '';
  const what = line.quiz ? 'answered your multiple-choice question' : 'picked an option on your question';
  return {
    text: `${picked.label}. ${picked.text}`,
    note: `[The student ${what} "${ask}".${listed} They chose ${chose}.${verdict}${why}]\n`,
    ...(correct !== undefined ? { correct } : {}),
  };
}

const OPTION_ECHO = 140;
