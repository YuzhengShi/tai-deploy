import { cleanProgramOutput } from '../sandbox/types.js';
import { int, isRecord, oneLine } from './text.js';
import { RUN_OUTPUT_CHARS } from './types.js';
import type { RunObject } from './types.js';

/** A run card as the history keeps it: the command on one line, the output cleaned and cut, numbers in range; null when it is not one (no command). */
export function cleanRun(raw: unknown): RunObject | null {
  if (!isRecord(raw) || raw.t !== 'run') return null;
  const command = oneLine(raw.command, 200);
  if (!command) return null;
  const exit = raw.exitCode === null ? null : int(raw.exitCode, -1000, 1000);
  const duration = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? Math.min(Math.max(Math.round(raw.durationMs), 0), 600_000) : 0;
  const output = typeof raw.output === 'string' ? cleanProgramOutput(raw.output, RUN_OUTPUT_CHARS) : '';
  const note = oneLine(raw.note, 300);
  return {
    t: 'run',
    command,
    ok: raw.ok === true,
    exitCode: exit,
    timedOut: raw.timedOut === true,
    durationMs: duration,
    output,
    truncated: raw.truncated === true || output.includes(' characters in the middle are not shown'),
    ...(note ? { note } : {}),
  };
}

/** The one line a run card is in the chat's search and in a screen reader's list: `Ran go test ./... (exit 1, 14.2 s)`. */
export function runSummary(run: RunObject): string {
  const secs = Math.round(run.durationMs / 100) / 10;
  if (!run.ok) return `Did not run ${run.command}`;
  const how = run.timedOut ? 'stopped at the time limit' : run.exitCode === null ? 'stopped' : `exit ${run.exitCode}`;
  return `Ran ${run.command} (${how}, ${secs} s)`;
}
