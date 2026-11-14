/**
 * The run card (docs/CHAT_OBJECTS.md, docs/RUN_CARDS.md): what a run of the student's Go code leaves in their chat, built by the HOST from the sandbox's own result and the request it
 * validated. A model never writes it: the text agent's verb (src/sandbox/ipc-verb.ts) and the voice function (src/voice/run-code.ts) both call `leaveRunCard`, so the two make the same card.
 *
 * A card is left only for a run that HAPPENED (`result.ok`): a refusal, a busy sandbox and a limit answer are sentences for the model and leave nothing in the chat.
 * Everything in it is bounded: the command is the host's own words for the request (`commandLine`), the numbers are the result's, the output is the program's text with terminal escapes and
 * control characters taken out and the middle cut when it is long (`cleanProgramOutput`). The chat's history takes an object only through `cleanObject`, which refuses one whose JSON is over
 * OBJECT_JSON_MAX: JSON doubles every quote, backslash, tab and line break (and writes a lone surrogate as six characters), so an output that is short enough in characters can still be too
 * long as JSON. The card is therefore built through the same gate here and the output is cut further, in the middle, until it passes: a run that happened always leaves a card.
 */
import { cleanObject } from '../chat-objects/clean.js';
import { RUN_OUTPUT_CHARS } from '../chat-objects/types.js';
import type { RunObject } from '../chat-objects/types.js';
import { cleanProgramOutput, commandLine } from './types.js';
import type { SandboxRequest, SandboxResult } from './types.js';

/**
 * `cleanProgramOutput(text, max)` returns up to `max` characters PLUS its own marker line (about 60 characters), and the card's gate cleans the output again with RUN_OUTPUT_CHARS as the cap:
 * a text that is a little over the cap would be cut a second time and its marker would then count the wrong number of characters. The first cut leaves this much room so that the second pass
 * has nothing to do.
 */
const MARKER_ROOM = 200;
/** Each further cut keeps this share of the last one, until the card's JSON fits. */
const SHRINK = 0.7;
/** Below this many characters of output a card is not worth keeping trying: something else is wrong with it. */
const SMALLEST = 400;

/**
 * The card for a run of the student's code, or null when there is none to leave: the run did not happen, the result is not a result, or the card could not be made to pass the chat's gate.
 * Never throws.
 */
export function runCard(result: SandboxResult | null | undefined, request: SandboxRequest): RunObject | null {
  try {
    if (!result || typeof result !== 'object' || result.ok !== true) return null;
    const raw = typeof result.output === 'string' ? result.output : '';
    const base = {
      t: 'run' as const,
      command: commandLine(request),
      ok: true,
      exitCode: typeof result.exitCode === 'number' && Number.isFinite(result.exitCode) ? result.exitCode : null,
      timedOut: result.timedOut === true,
      durationMs: typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? result.durationMs : 0,
      truncated: result.outputTruncated === true,
      ...(typeof result.message === 'string' && result.message ? { note: result.message } : {}),
    };
    for (let max = RUN_OUTPUT_CHARS - MARKER_ROOM; max >= SMALLEST; max = Math.floor(max * SHRINK)) {
      const card = cleanObject({ ...base, output: cleanProgramOutput(raw, max) });
      if (card && card.t === 'run') return card;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Puts the run's card in the student's chat through `post` (the host's way to write an object line: src/ipc.ts and the voice session give it) and says whether a card was left: false when there
 * is no way to post, nothing to post, or the posting threw. Best effort and never throws: what a container or a call is answered with never depends on it, but the answer's words do
 * (they say the student sees the output only when this is true).
 */
export function leaveRunCard(
  result: SandboxResult | null | undefined,
  request: SandboxRequest,
  post: ((obj: unknown) => void) | undefined,
  onError?: (err: unknown) => void,
): boolean {
  if (!post) return false;
  try {
    const card = runCard(result, request);
    if (!card) return false;
    post(card);
    return true;
  } catch (err) {
    try {
      onError?.(err);
    } catch {
      /* the log is a convenience */
    }
    return false;
  }
}
