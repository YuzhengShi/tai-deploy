/**
 * What the teaching patrol decided, written down by code in the student's competency/intervention-log.md. The persona and the protocol tell the model
 * to log every patrol decision, "including when you decide NOT to intervene", and it does not (the same 0-for-every-model as the strategy log: see
 * src/competency-writer.ts), so the scheduler writes one line per patrol run after it. A line is made of the gate's signal keys (ids and hashes),
 * numbers and fixed words: never anything a student wrote, and never the model's own reasoning (that is its to log, in its own words).
 *
 * Newest first, like the other competency logs (src/voice/competency.ts `prependLog`).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { prependLog } from './voice/competency.js';

export type PatrolRecord =
  /** The gate decided no model was needed today: no container, no model. `keys`: the signals still open. */
  | { kind: 'skipped'; keys: string[]; weekly: boolean }
  /** The model ran and finished. `sent`: a message went to the student; otherwise it decided not to intervene. */
  | { kind: 'ran'; sent: boolean; keys: string[]; weekly: boolean; seconds: number; gate: string; shadowSkip: boolean }
  /** The run did not finish its work: the model could not be reached, the runner never said it was done, or something else failed. */
  | { kind: 'failed'; why: 'model' | 'unfinished' | 'error'; apiFailure?: string; sent: boolean; keys: string[]; weekly: boolean; seconds: number; gate: string };

const key = (k: string): string => k.replace(/[^A-Za-z0-9:_.-]/g, '').slice(0, 60);
const keyList = (keys: string[]): string => (keys.length ? keys.slice(0, 12).map(key).join(', ') : 'none');

/** One line of the log, from keys, numbers and fixed words. `today` is the day the patrol ran (YYYY-MM-DD). */
export function interventionLine(today: string, r: PatrolRecord): string {
  switch (r.kind) {
    case 'skipped':
      return `- ${today}: no-action — the gate skipped the run (no container, no model) | open signals: ${keyList(r.keys)} | ${r.weekly ? 'weekly check due' : 'weekly check not due'}`;
    case 'ran': {
      const how = r.sent ? 'intervene — the model ran and sent the student a message' : 'no-action — the model ran and sent no message';
      return `- ${today}: ${how} | signals: ${keyList(r.keys)} | ${r.weekly ? 'weekly check' : 'new signal'} | gate ${key(r.gate)}${r.shadowSkip ? ' (it would have skipped)' : ''} | ${Math.max(0, Math.round(r.seconds))} s`;
    }
    case 'failed': {
      const why =
        r.why === 'model' ? `the model could not be reached${r.apiFailure ? ` (${key(r.apiFailure)})` : ''}` : r.why === 'unfinished' ? 'the run did not finish (its container was stopped, or it ran out of time)' : 'the run failed';
      return `- ${today}: failed — ${why} | signals: ${keyList(r.keys)} | ${r.sent ? 'a message had already been sent' : 'no message sent'} | nothing kept, the next patrol looks again | gate ${key(r.gate)} | ${Math.max(0, Math.round(r.seconds))} s`;
    }
  }
}

const FOLDER = /^[A-Za-z0-9_-]{1,64}$/;

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Adds the line to competency/intervention-log.md under groupDir. Never throws: a log that cannot be written must not fail the patrol. */
export function logPatrolDecision(groupDir: string, record: PatrolRecord, now: number = Date.now(), warn: (message: string) => void = () => undefined): void {
  try {
    prependLog(path.join(groupDir, 'competency', 'intervention-log.md'), 'Intervention Log', interventionLine(localDay(now), record), groupDir);
  } catch (err) {
    warn(`could not write the patrol's decision to the intervention log: ${(err as Error).message}`);
  }
}

/**
 * The marker the agent's send_message (and render_diagram) tool leaves in data/ipc/<folder>/messages when it has sent the student something
 * (container/agent-runner/src/ipc-mcp-stdio.ts `markSendMessageUsed`). The chat path removes it when it finds one (src/index.ts); nothing removed it after a
 * scheduled task, so a patrol that sent a message left it behind and the student's next reply in the chat was held back as "already sent by the tool".
 * Taking it before a patrol (so an old one is not read as this run's) and after (so this run's is not left behind) answers "did the patrol send a
 * message?" and removes that trap. A folder that is not a plain name, or no marker: false.
 */
export function takeSendFlag(folder: string, dataDir: string = DATA_DIR): boolean {
  if (!FOLDER.test(folder)) return false;
  try {
    fs.unlinkSync(path.join(dataDir, 'ipc', folder, 'messages', '.send_message_used'));
    return true;
  } catch {
    return false;
  }
}
