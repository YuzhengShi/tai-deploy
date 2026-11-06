/**
 * What the host decided about a request that a voice call wrote into its IPC `tasks` directory (src/ipc.ts answer()). The call's `schedule_task` used to write the file and tell the
 * student "scheduled" at once, so a task the host then refused (a limit, a schedule it could not read) was announced as set. The request now carries an id of the call's choosing; the
 * host's watcher writes `results/<id>.json` in the same IPC directory, and the call waits for it here for a few seconds, which is as long as a spoken answer can wait. The container's
 * own tools do the same (container/agent-runner/src/ipc-result.ts, ten seconds: nobody is listening to a silent line there).
 */

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface IpcAnswer {
  ok: boolean;
  /** A sentence of the host's, for the call to say as it stands. */
  message: string;
}

/** The shape the host accepts for the name of a request (src/ipc.ts REQUEST_ID): it names a file. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ANSWER_BYTES = 4096;

/** A fresh request id: the time and 48 random bits, which the host's rule accepts. */
export function newRequestId(now: number): string {
  return `${Math.max(0, Math.floor(now)).toString(36)}-${randomBytes(6).toString('hex')}`;
}

export interface WaitOptions {
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The answer in `results/<requestId>.json` of `ipcDir`, or null when it is not there (yet), is not a plain small file, or says something else than {ok, message}. The file is removed once read. */
export function readIpcAnswer(ipcDir: string, requestId: string): IpcAnswer | null {
  if (!REQUEST_ID.test(requestId)) return null;
  const file = path.join(ipcDir, 'results', `${requestId}.json`);
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_ANSWER_BYTES) return null;      // the host writes a plain file: anything else is not its answer
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as { ok?: unknown; message?: unknown };
    if (typeof body.ok !== 'boolean' || typeof body.message !== 'string') return null;
    try {
      fs.unlinkSync(file);
    } catch {
      /* the host's own cleanup will get it */
    }
    return { ok: body.ok, message: body.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) };
  } catch {
    return null;
  }
}

/** Waits up to `timeoutMs` for the host's answer to `requestId`; null when none came. */
export async function waitForIpcAnswer(ipcDir: string, requestId: string, timeoutMs: number, options: WaitOptions = {}): Promise<IpcAnswer | null> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 150;
  const until = now() + timeoutMs;
  for (;;) {
    const got = readIpcAnswer(ipcDir, requestId);
    if (got) return got;
    if (now() >= until) return null;
    await sleep(pollMs);
  }
}
