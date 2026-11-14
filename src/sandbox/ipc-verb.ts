/**
 * The host's side of the container tool `run_go` (docs/GO_SANDBOX.md): the IPC verb `sandbox_run`, kept apart from src/ipc.ts (which imports the database) so that its rules are tested without one.
 *
 * `processTaskIpc` is awaited once for every file of every group (startIpcWatcher), and a run takes up to a minute: the verb STARTS the run and returns at once, and writes the answer when the run is over,
 * so that one student's run never holds up the other groups' requests. Every request gets exactly one answer (`results/<requestId>.json`, which the container's tool waits for), whatever happens: a
 * refusal, a result, a runner that throws, one that never answers (a watchdog answers for it). The folder is released BEFORE the answer is written, so a container that asks again at once is not told a
 * run is still going.
 *
 * The order of the checks is the order of what they cost: a request nobody can be answered (no usable id) is dropped without a run; a sandbox that is off says so; a chat that is not registered is
 * refused (the admin chat may be run without a registration); a second request while one runs for the same folder is answered at once; then the ONE gate, `parseSandboxRequest`; then the run. The
 * student is the folder of the IPC directory the file was in and the account a repository is fetched from is that group's registered `githubUsername`: nothing in the file names either.
 * What is logged is the kind of run and how it ended, never the request (the code, a file name, a repository) or the output.
 */
import { leaveRunCard } from './run-card.js';
import { SANDBOX_LIMITS, SANDBOX_OFF, frameSandboxResult, parseSandboxRequest } from './types.js';
import type { SandboxApi, SandboxLog, SandboxRequest } from './types.js';

/**
 * The most the host puts in the answer file's `message` (the container's tool reads up to the same number: container/agent-runner/src/run-go.ts keeps a twin, and a test fails when they differ).
 * The ordinary answers of the other task tools are cut at 600 characters, which would cut a framed result (up to 6,000 characters of program output, which JSON escaping can double) in the middle.
 */
export const SANDBOX_ANSWER_CHARS = 32_000;

/** How long the host waits for the runner before it answers for it: the container's tool has given up by then (SANDBOX_LIMITS.requestWaitMs), and the folder must not stay locked for ever. */
export const SANDBOX_WATCHDOG_MS = SANDBOX_LIMITS.requestWaitMs + 5_000;

export const SANDBOX_ALREADY_GOING = 'Not run: a run for this student is still going. Wait for its answer before asking for another; say so in a short sentence if the student asked again.';
export const SANDBOX_NOT_REGISTERED = 'Not run: this chat is not registered, so there is no student to run it for.';
export const SANDBOX_FAILED = 'Not run: the sandbox itself failed (not the code). Say so in one short sentence and go on by reading the code.';
export const SANDBOX_NO_ANSWER = 'Not run to the end: the sandbox did not answer in time, so the run may or may not have happened. Say so honestly and go on by reading the code.';

export interface SandboxVerbInput {
  /** The folder of the IPC directory the file was in: the student the run is for (never read from the file). */
  folder: string;
  isMain: boolean;
  /** The request's id when it has a usable one (src/ipc.ts REQUEST_ID), else null. */
  requestId: string | null;
  /** What the file says the request is: checked by parseSandboxRequest, nothing else of it is used. */
  request: unknown;
  /** The registered group of that folder, the host's own record: its `githubUsername` is the binding. */
  group?: { githubUsername?: string };
}

export interface SandboxVerbEnv {
  /** The host's runner (src/index.ts); without it the sandbox is off. */
  runSandbox?: SandboxApi['run'];
  /** Writes the answer for the container that asked (src/ipc.ts answer(), with SANDBOX_ANSWER_CHARS). It may throw: that is caught. */
  say: (requestId: string, ok: boolean, message: string) => void;
  /** One line for the audit log (never the code or the output). Best effort. */
  audit: (operation: string, fields: Record<string, unknown>) => void;
  /**
   * Puts a card in the student's chat (docs/CHAT_OBJECTS.md): `obj` is what src/chat-objects/clean.ts `cleanObject` accepts, and the page's history gate checks it again. Best effort: a throw is caught,
   * and the card is never what the container is answered with. Batch A: a run that happened leaves a `run` card (the student sees the output the model was given).
   */
  postObject?: (folder: string, obj: unknown) => void;
  log: SandboxLog;
  /** Tests: how long before the watchdog answers. */
  watchdogMs?: number;
}

/** The folders that have a run going, each with the token of that run (a run releases only its own). */
const inFlight = new Map<string, symbol>();

/** How many folders have a run going now (tests, and the log line that says the host is busy). */
export const sandboxRunsInFlight = (): number => inFlight.size;
/** Tests: forget every run in flight. */
export const _resetSandboxRuns = (): void => inFlight.clear();

const kindOf = (request: SandboxRequest): string => request.source.kind;

/**
 * A refusal's sentence can name a file ("the file x.go is given twice": a name the gate has checked, but still the student's): the container is told the whole sentence, which is the student's own,
 * and the logs are not told the name.
 */
export const withoutFileNames = (message: string): string => message.replace(/the file [^ ]+/g, 'a file').slice(0, 200);

/**
 * Starts the run for a request from a container, and returns at once. Never throws and never rejects: every way out writes exactly one answer (or, for a request with no usable id, none).
 */
export function startSandboxRun(input: SandboxVerbInput, env: SandboxVerbEnv): void {
  const { folder, requestId } = input;
  if (requestId === null) {
    // nobody could be told what it printed, and a run would spend one of the student's runs for nothing
    env.log.warn({ folder }, 'sandbox_run without a usable request id: dropped');
    return;
  }

  const token = Symbol(folder);
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The one answer. The folder goes free first: the container that is answered may ask again at once. */
  const settle = (ok: boolean, message: string): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (inFlight.get(folder) === token) inFlight.delete(folder);
    try {
      env.say(requestId, ok, message);
    } catch (err) {
      env.log.warn({ folder, err: err instanceof Error ? err.message : String(err) }, 'sandbox_run: the answer could not be written');
    }
  };
  const audit = (operation: string, fields: Record<string, unknown>): void => {
    try {
      env.audit(operation, { sourceGroup: folder, isMain: input.isMain, ...fields });
    } catch {
      /* the log is a convenience: it never changes what the container is told */
    }
  };

  if (!env.runSandbox) return settle(false, SANDBOX_OFF);
  if (!input.group && !input.isMain) {
    env.log.warn({ folder }, 'sandbox_run from a chat that is not registered: refused');
    return settle(false, SANDBOX_NOT_REGISTERED);
  }
  if (inFlight.has(folder)) return settle(false, SANDBOX_ALREADY_GOING);

  const parsed = parseSandboxRequest(input.request);
  if (!parsed.ok) {
    audit('sandbox_run_refused', { reason: withoutFileNames(parsed.message) });
    return settle(false, parsed.message);
  }
  const request = parsed.value;
  const who = { folder, ...(input.group?.githubUsername ? { githubUsername: input.group.githubUsername } : {}) };
  const run = env.runSandbox;

  inFlight.set(folder, token);
  timer = setTimeout(() => {
    env.log.warn({ folder, action: request.action }, 'sandbox_run: the runner did not answer in time: answered for it');
    settle(false, SANDBOX_NO_ANSWER);
  }, env.watchdogMs ?? SANDBOX_WATCHDOG_MS);
  timer.unref?.();

  // (a runner that throws before it returns a promise is a rejection too)
  void Promise.resolve()
    .then(() => run(who, request))
    .then((result) => {
      // The card first (a run that happened: src/sandbox/run-card.ts): the student reads the output in the chat before they read what TAi says of it, and the model is told they see it only if it was
      // really left. The watchdog may have answered already, with "may or may not have happened": a late result leaves no card. Nothing the card does can stop the answer (it never throws).
      const post = env.postObject;
      const card =
        !settled &&
        leaveRunCard(result, request, post ? (obj) => post(folder, obj) : undefined, (err) =>
          env.log.warn({ folder, action: request.action, err: err instanceof Error ? err.message : String(err) }, 'sandbox_run: the run card could not be left'),
        );
      // the message next, then the log: nothing the log does can stop the answer
      const message = frameSandboxResult(result, request, undefined, { card });
      audit('sandbox_run', {
        action: request.action,
        source: kindOf(request),
        ...(request.source.kind === 'files' ? { files: request.source.files.length } : {}),
        ok: result.ok,
        card,
        ...(result.phase ? { phase: result.phase } : {}),
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: Math.round(result.durationMs),
      });
      settle(result.ok, message);
    })
    .catch((err) => {
      env.log.warn({ folder, action: request.action, err: err instanceof Error ? err.message : String(err) }, 'sandbox_run: the runner failed');
      settle(false, SANDBOX_FAILED);
    })
    .catch(() => undefined);
}
