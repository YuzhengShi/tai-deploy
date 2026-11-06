/**
 * What a run of the text agent moved forward for a student, as the page's activity list says it: "Raft leader election: just started →
 * getting there". The agent keeps the student's COMPETENCY.md; the host reads it before the container starts and after it is done, and the
 * difference, in the words of the page's "What TAi remembers" panel (the same bands, src/voice/competency.ts), is the progress. Pure functions
 * and one file read, so the arithmetic is tested.
 */
import path from 'path';

import { levelWord, parseMastery, readText } from './voice/competency.js';

const RANK: Record<string, number> = { 'not started': 0, 'just started': 1, 'getting there': 2, solid: 3 };

/** Concept -> confidence, as the student's COMPETENCY.md has it now (empty when there is no file). */
export function masterySnapshot(groupsDir: string, folder: string): Map<string, number> {
  const text = readText(path.join(groupsDir, folder, 'COMPETENCY.md'), path.join(groupsDir, folder));
  return new Map(text ? parseMastery(text).map((entry): [string, number] => [entry.name, entry.confidence]) : []);
}

export interface ProgressStep {
  concept: string;
  was: string;
  now: string;
}

/**
 * The concepts that reached "getting there" or "solid" from a lower band, the biggest gain first, at most `max`. Slipping back is not
 * progress, a first touch ("just started") is not worth a line, and with nothing to compare to (`before` is empty: the file did not exist, or
 * came with its values) there is no progress to speak of.
 */
export function progressSteps(before: Map<string, number>, after: Map<string, number>, max = 3): ProgressStep[] {
  if (before.size === 0) return [];
  const steps: Array<ProgressStep & { gain: number }> = [];
  for (const [concept, confidence] of after) {
    const was = levelWord(before.get(concept) ?? 0);
    const now = levelWord(confidence);
    if ((now === 'getting there' || now === 'solid') && RANK[now] > RANK[was]) steps.push({ concept, was, now, gain: confidence - (before.get(concept) ?? 0) });
  }
  return steps
    .sort((a, b) => b.gain - a.gain)
    .slice(0, max)
    .map(({ concept, was, now }) => ({ concept, was, now }));
}
