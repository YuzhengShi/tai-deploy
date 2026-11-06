/**
 * What the host decided about a request the container made through a task tool (schedule_task, pause_task, resume_task, cancel_task). These tools write a request file into
 * /workspace/ipc/tasks and the host's watcher handles it a moment later (src/ipc.ts), and until now they answered "scheduled" or "requested" at once: a request the host
 * dropped (a typo in a schedule, a task that is not the group's, a limit) left the agent, and through it the student, told something false. Now the request carries an
 * id of the container's own choosing, the host writes its answer to /workspace/ipc/results/<id>.json (src/ipc.ts answer()), and the tool waits for it here and says what
 * the host said, or, when nothing came in time, says that nothing did.
 *
 * Kept apart from ipc-mcp-stdio.ts, which starts a server when it is imported, so that it is unit tested.
 */

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface IpcResult {
  ok: boolean;
  /** A sentence for the agent to say as it stands. */
  message: string;
  taskId?: string;
}

/** The host's watcher looks every second (IPC_POLL_INTERVAL): ten seconds is ten looks, and a host that is busy for longer is told so honestly instead. */
export const RESULT_WAIT_MS = 10_000;
const POLL_MS = 150;
/** An answer nobody collected (the container was stopped before it did) is dropped after an hour. */
const STALE_MS = 60 * 60 * 1000;
/** The same shape the host accepts for the name of a request (src/ipc.ts): it names a file. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A fresh request id: the time and 48 random bits, which the host's rule accepts. */
export function newRequestId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** For tests: the clock, and how to wait. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Removes the answers in `dir` that are older than an hour and were never collected. Best effort: nothing here is the tool's business to fail on. */
function dropStale(dir: string, now: number): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.unlinkSync(file);
      } catch {
        /* gone already, or not ours to remove */
      }
    }
  } catch {
    /* no such directory */
  }
}

/**
 * Waits for the host's answer to `requestId` in `dir` and returns it, taking the file away; null when none came within the time, when the id is not a plain id, or when the
 * directory is not there (a host from before this existed never makes it, and no answer will ever come). An answer that is there but cannot be read is an answer too:
 * a refusal that says so, never a success.
 */
export async function awaitIpcResult(dir: string, requestId: string, options: WaitOptions = {}): Promise<IpcResult | null> {
  if (!REQUEST_ID.test(requestId)) return null;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? POLL_MS;
  const deadline = now() + (options.timeoutMs ?? RESULT_WAIT_MS);
  if (!fs.existsSync(dir)) return null;
  dropStale(dir, now());
  const file = path.join(dir, `${requestId}.json`);
  for (;;) {
    let text: string | null = null;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      text = null;
    }
    if (text !== null) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* a file the host owns and the container may not remove: the hour's cleanup does not reach it either, and it does no harm */
      }
      try {
        const parsed = JSON.parse(text) as Partial<IpcResult>;
        if (typeof parsed.ok === 'boolean' && typeof parsed.message === 'string') {
          return { ok: parsed.ok, message: parsed.message.slice(0, 600), ...(typeof parsed.taskId === 'string' ? { taskId: parsed.taskId } : {}) };
        }
      } catch {
        /* handled below */
      }
      return { ok: false, message: 'The system answered, but I could not read its answer. Check list_tasks before you tell the student anything is set up.' };
    }
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}
