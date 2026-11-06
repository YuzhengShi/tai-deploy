/**
 * A student's COMPETENCY.md, from the template, the moment their chat is registered. In the original the instructor's admin agent copied
 * the template when it registered a student, and the Canvas bootstrap then filled the scores; here nobody does the first step, so every
 * student's first turn went into hunting for a file that was not there (and the model asked for the GitHub name the file would have held).
 *
 * Only the profile lines are filled, from what the allowlist knows: the name, the GitHub account and the Canvas user id. An existing file
 * is only ever completed (a line that is still the template's placeholder), never rewritten: what the model has written there is the
 * student's record.
 */
import fs from 'fs';
import path from 'path';

import { createFileExclusive, readTextSafe, writeFileAtomicSafe } from './safe-fs.js';

export interface SeedIdentity {
  name?: string;
  githubUsername?: string;
  canvasUserId?: string;
}

export type SeedResult = 'created' | 'completed' | 'kept' | 'no-template';

/**
 * The logs COMPETENCY.md sends the agent to (its "Detail Files" table). Without them the agent's first `edit` of one failed with ENOENT (the
 * models write a log with an edit, not a write), and the self-improving strategy loop never got going. interaction-summary.md is NOT here:
 * the persona takes its absence for "a new student" and runs the first-message welcome.
 */
const DETAIL_FILES: Record<string, string> = {
  'interviews.md':
    '# Interview History\n\n## Upcoming Interview Focus\n- Week: [update manually]\n- Homework: [update manually]\n\n## Verbal vs Written Gap Analysis\n- Concepts missing verbal scope: [auto-populated from COMPETENCY.md mastery scores]\n\n## Interview History (most recent first)\n\n',
  'strategy-log.md': '# Teaching Strategy Log\n\n',
  'intervention-log.md': '# Intervention Log\n\n',
};

/** Makes the ones that are missing (never touches one that is there). Returns the names it made. */
export function seedDetailFiles(groupDir: string): string[] {
  const dir = path.join(groupDir, 'competency');
  const made: string[] = [];
  for (const [name, text] of Object.entries(DETAIL_FILES)) {
    try {
      // exclusive, and only in a directory that stays inside the student's folder (a link there could lead anywhere: src/safe-fs.ts)
      createFileExclusive(path.join(dir, name), text, groupDir);
      made.push(name);
    } catch {
      /* it is there already, or the directory is not the student's own */
    }
  }
  return made;
}

const NAME_LINE = /^(- Name:) \[student name\]\s*$/m;
const GITHUB_LINE = /^(- GitHub:) (?:\[username\]|\(not given yet\))\s*$/m;
const CANVAS_LINE = /^- Canvas User ID:/m;

function cleanName(name: string | undefined): string | undefined {
  const clean = (name || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>`]/g, '').trim().slice(0, 80);
  return clean || undefined;
}

export function seedCompetencyFile(groupDir: string, templatePath: string, who: SeedIdentity): SeedResult {
  const name = cleanName(who.name);
  const github = who.githubUsername && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(who.githubUsername) ? who.githubUsername : undefined;
  const canvas = who.canvasUserId && /^\d{1,15}$/.test(who.canvasUserId) ? who.canvasUserId : undefined;
  const file = path.join(groupDir, 'COMPETENCY.md');
  seedDetailFiles(groupDir);

  let text: string;
  let created = false;
  const existing = readTextSafe(file, undefined, groupDir);          // (a link or a FIFO in the student's folder reads as nothing, and is not written through below)
  if (existing !== null) {
    text = existing;
  } else {
    try {
      text = fs.readFileSync(templatePath, 'utf-8');
    } catch {
      return 'no-template';
    }
    created = true;
  }

  // replacer functions, not replacement strings: a name with a "$&" in it must stay a name
  let next = text;
  if (name) next = next.replace(NAME_LINE, (_m, label: string) => `${label} ${name}`);
  if (github) next = next.replace(GITHUB_LINE, (_m, label: string) => `${label} ${github}`);
  else if (created) next = next.replace(GITHUB_LINE, (_m, label: string) => `${label} (not given yet)`);
  if (canvas && !CANVAS_LINE.test(next)) {
    // right under the GitHub line, where start_mock_interview's reader of this file looks for it
    next = next.replace(/^(- GitHub:.*)$/m, (line: string) => `${line}\n- Canvas User ID: ${canvas}`);
  }

  if (!created && next === text) return 'kept';
  fs.mkdirSync(groupDir, { recursive: true });
  try {
    writeFileAtomicSafe(file, next, groupDir);
  } catch {
    return 'kept';                                                   // a link or a FIFO is there: the student's own, and nothing is written through it
  }
  return created ? 'created' : 'completed';
}
