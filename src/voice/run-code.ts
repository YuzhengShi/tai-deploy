/**
 * run_code: the voice call's way to run a student's Go code (docs/GO_SANDBOX.md, docs/VOICE.md "Running their code"). A HOST function: it calls the sandbox (src/sandbox) itself, with no tool host
 * and no container of the student's, for the student of THIS call: the folder and the GitHub account are the call's user record's, never anything the model says. The model's arguments are
 * checked by the same gate as the text agent's (parseSandboxRequest: nothing else reaches a file name, a command line or a container).
 *
 * What the model is told is the host's framing of the result (frameSandboxResult: how it ended, the command and the output QUOTED as data) plus a note for a student who is SPEAKING: one or two short
 * sentences, never the output read aloud. The output is cut first (RUN_CODE_OUTPUT_CHARS), so that the whole answer, note included, is far inside the 6,000 characters a function's answer may have
 * (functions.ts capResult would cut the end of it, where the markers close).
 *
 * A run can take a minute (SANDBOX_TOTAL_MS) and a student is waiting on the line: the function answers within RUN_CODE_ANSWER_MS whatever the runner does, with a sentence that it is still
 * running (the sandbox stops its container at its own time limit anyway, and the result of a run that goes on is not delivered). While it goes on, a second call of this call is told so: a run
 * is one of the student's ten an hour, and a model that asks again would spend another. Never throws.
 */
import { leaveRunCard } from '../sandbox/run-card.js';
import { SANDBOX_OFF, SANDBOX_TOTAL_MS, cleanProgramOutput, commandLine, frameSandboxResult, parseSandboxRequest } from '../sandbox/types.js';
import type { SandboxRequest, SandboxResult } from '../sandbox/types.js';
import type { FunctionEnv } from './functions.js';

/** How long the function takes to answer, whatever the runner does. */
export const RUN_CODE_ANSWER_MS = 50_000;
/** How much of the program's output the model is given: a student hears one or two sentences about it, and the model reads it once. */
export const RUN_CODE_OUTPUT_CHARS = 1_800;

/**
 * For a student who is listening: what to say about the result. The output itself is the host's to put in the chat, as a card (src/sandbox/run-card.ts; frameSandboxResult's note says so when it was
 * left), so the model's words are its own: the conversation may put anything longer in the chat in its own words, the interviewer may not put anything of the run there.
 */
export const RUN_CODE_NOTE = {
  conversational:
    'They are listening, not reading: say one or two short sentences about what it showed (a number or a name from it at most), never read the output aloud, and ask what they make of it. Anything longer goes in the chat with send_to_chat, in your own words and never the output itself. Do not tell them the fix.',
  interviewer:
    'They are listening, not reading: say one or two short sentences about what it showed (a number or a name from it at most), never read the output aloud and never put it in the chat yourself, and ask them why. Do not say what is wrong or how to fix it: this is an interview.',
} as const;

export const RUN_CODE_STILL_RUNNING =
  'The run has not finished yet and its output will not come back in this call (the sandbox stops it at its own time limit). Say in one short sentence that it is taking too long and ask what they think is slow: a loop that does not end, or a wait for something that never comes. Never guess what it would have printed. Do not ask for it again at once: a run counts as one of their runs.';
export const RUN_CODE_GOING = 'A run for this call is still going. Say in one short sentence that you are waiting for it, and do not ask for another.';
const RUN_CODE_FAILED = 'that did not work; say so briefly and carry on';

const error = (message: string): string => JSON.stringify({ error: message });

/** The calls (by student folder) that have a run going, until the run ends or, whatever happens, a little after the sandbox's own time. */
const going = new Map<string, { until: number; token: symbol }>();
/** Tests: forget every run that is going. */
export const _resetRunCode = (): void => going.clear();

type Settled = { result: SandboxResult } | { err: unknown };

/**
 * The result as the model is told it: the host's frame with the output cut short, and the note for a listener. `card` is true only when the host really left the run's card in the chat (the
 * student then reads the output there, and the frame's note says so); the default is the words there were before cards.
 */
export function runCodeAnswer(result: SandboxResult, request: SandboxRequest, mode: FunctionEnv['mode'], card = false): string {
  const cut = { ...result, output: cleanProgramOutput(typeof result?.output === 'string' ? result.output : '', RUN_CODE_OUTPUT_CHARS) };
  const framed = JSON.parse(frameSandboxResult(cut, request, undefined, { card })) as Record<string, unknown>;
  framed.voice_note = mode === 'interviewer' ? RUN_CODE_NOTE.interviewer : RUN_CODE_NOTE.conversational;
  return JSON.stringify(framed);
}

export async function runCode(args: Record<string, unknown>, env: FunctionEnv): Promise<string> {
  try {
    if (!env.runSandbox) return error(`${SANDBOX_OFF} Say so in one short sentence and go on without running it.`);
    const parsed = parseSandboxRequest(args);
    if (!parsed.ok) return error(parsed.message);
    const request = parsed.value;
    const now = env.now();
    const busy = going.get(env.folder);
    if (busy && busy.until > now) return error(RUN_CODE_GOING);

    // the student of this call: its folder and the account the host bound to it, nothing from the arguments
    const who = { folder: env.folder, ...(env.githubUsername ? { githubUsername: env.githubUsername } : {}) };
    const run = env.runSandbox;
    const token = Symbol(env.folder);
    going.set(env.folder, { until: now + SANDBOX_TOTAL_MS + 10_000, token });
    const settled: Promise<Settled> = Promise.resolve()
      .then(() => run(who, request))
      .then(
        (result): Settled => ({ result }),
        (err: unknown): Settled => ({ err }),
      );
    void settled.then(() => {
      if (going.get(env.folder)?.token === token) going.delete(env.folder);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), env.codeAnswerMs ?? RUN_CODE_ANSWER_MS);
      timer.unref?.();
    });
    const first = await Promise.race([settled, slow]);
    if (timer) clearTimeout(timer);

    if (first === null) {
      env.log.warn({ folder: env.folder, action: request.action }, 'voice: a code run was still going when the function had to answer');
      return JSON.stringify({ status: 'still running', command: commandLine(request), note: RUN_CODE_STILL_RUNNING });
    }
    if ('err' in first) {
      env.log.warn({ folder: env.folder, action: request.action, err: first.err instanceof Error ? first.err.message : String(first.err) }, 'voice: the sandbox failed');
      return error(RUN_CODE_FAILED);
    }
    // The card first, for a run that finished inside this wait (one that is still going when the function answers leaves none, above): the student reads the output in the chat as the model starts
    // to speak of it. It is made from the whole result, not from the shorter cut the model is given, and it never throws: a card that could not be left only changes what the model is told.
    const card = leaveRunCard(first.result, request, env.postObject, (err) =>
      env.log.warn({ folder: env.folder, action: request.action, err: err instanceof Error ? err.message : String(err) }, 'voice: the run card could not be left'),
    );
    // the kind of run and how it ended, never the code or the output
    env.log.info({ folder: env.folder, action: request.action, source: request.source.kind, ok: first.result?.ok, phase: first.result?.phase, exitCode: first.result?.exitCode, card }, 'voice: code run');
    return runCodeAnswer(first.result, request, env.mode, card);
  } catch (err) {
    env.log.warn({ folder: env.folder, err: err instanceof Error ? err.message : String(err) }, 'voice: run_code failed');
    return error(RUN_CODE_FAILED);
  }
}
