/**
 * What a failed model request looks like to the agent runner, and what the student is told about it.
 *
 * The Claude Code CLI turns a request that failed (after its own retries) into a result whose text is "API Error: <status> <body>",
 * or "Prompt is too long". Upstream treated every "API Error: 500" as a full context ("my memory got too full") and cleared the
 * session, and showed the raw text of anything else (eval/RESULTS.md, item 2b).
 */

export type ApiFailureKind = 'overflow' | 'busy' | 'auth' | 'other';

export interface ApiFailure {
  kind: ApiFailureKind;
  status: number | null;
}

// The context no longer fits: the session has to start over.
const OVERFLOW =
  /prompt is too long|context[ _-]?(length|window)|maximum context|too many (input )?tokens|input (is )?too long|reduce the length of the messages/i;
// The provider is busy or unreachable: the same request is likely to work in a minute.
const BUSY =
  /overloaded|rate[ _-]?limit|too[ _-]many[ _-]requests|queue[ _-]exceeded|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|timed? ?out|econnreset|socket hang up|fetch failed|connection (error|refused|reset)/i;
const AUTH = /invalid api key|credit balance|authentication|unauthorized|forbidden/i;
// A rate limit says "too many tokens" too (Cerebras: "Tokens per minute limit exceeded - too many tokens processed"), and it is not an
// overflow: the context is fine, the bucket is empty. It is checked before OVERFLOW.
const RATE_LIMITED = /tokens per minute|too_many_tokens_error|rate[ _-]?limit|quota/i;

/** Null when the text is not a model failure. A reply that merely mentions "API Error" in passing is not one: the text must open with it. */
export function classifyApiError(text: string | null | undefined): ApiFailure | null {
  if (!text) return null;
  if (/^\s*Prompt is too long/i.test(text)) return { kind: 'overflow', status: 400 };
  const head = text.match(/^\s*API Error:\s*(?:\(?(\d{3})\)?)?/i);
  if (!head) return null;
  const status = head[1] ? parseInt(head[1], 10) : null;

  if (status === 429 || RATE_LIMITED.test(text)) return { kind: 'busy', status };
  if (OVERFLOW.test(text)) return { kind: 'overflow', status };
  if (status === 401 || status === 403 || AUTH.test(text)) return { kind: 'auth', status };
  if (status === null) return { kind: BUSY.test(text) ? 'busy' : 'other', status };
  if ([408, 429, 500, 502, 503, 504, 529].includes(status) || BUSY.test(text)) return { kind: 'busy', status };
  return { kind: 'other', status };
}

/**
 * pi (pi-runner.ts): a model request that failed, after pi's own retries, ends as an assistant message with stopReason "error" and the
 * provider's message as errorMessage ("429 {...}", "Connection error.", "Request timed out."), not as a result that opens with
 * "API Error:". Same kinds as classifyApiError; null when the text is empty.
 */
export function classifyProviderError(errorMessage: string | null | undefined): ApiFailure | null {
  const text = (errorMessage || '').trim();
  if (!text) return null;
  const found = text.slice(0, 160).match(/(?:^|[^\d.])([45]\d\d)(?!\d)/);
  const status = found ? parseInt(found[1], 10) : null;

  if (status === 429 || RATE_LIMITED.test(text)) return { kind: 'busy', status };
  if (OVERFLOW.test(text)) return { kind: 'overflow', status };
  if (status === 401 || status === 403 || AUTH.test(text)) return { kind: 'auth', status };
  if ((status !== null && [408, 429, 500, 502, 503, 504, 529].includes(status)) || BUSY.test(text)) return { kind: 'busy', status };
  return { kind: 'other', status };
}

/** The failure an assistant message of pi ended in, or null when it answered (or was cut off by max tokens: that text is still an answer). */
export function failureOfAssistantMessage(message: { stopReason?: string; errorMessage?: string } | null | undefined): ApiFailure | null {
  if (!message || message.stopReason !== 'error') return null;
  return classifyProviderError(message.errorMessage) ?? { kind: 'other', status: null };
}

/** What the student hears, in TAi's voice. Only an overflow means the context was cleared. */
export function friendlyMessage(kind: ApiFailureKind): string {
  switch (kind) {
    case 'overflow':
      return "sorry, my memory got too full — I've cleared my context and I'm ready to go. could you send that last message again?";
    case 'busy':
      return "i'm getting a lot of questions at once and couldn't think that one through — give me a minute and send it again?";
    case 'auth':
      return "sorry, i can't reach my brain at the moment — try again in a few minutes?";
    default:
      return 'sorry, something went wrong on my end — give me a sec and try again?';
  }
}
