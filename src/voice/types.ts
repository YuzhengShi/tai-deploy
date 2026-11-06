/** Small types the voice modules share. */
import type { ActivityItem } from '../portal/history.js';

/** The orchestrator's pino logger fits this; tests pass a recorder. Never give it a secret (the Deepgram key, a relay token, a cookie). */
export interface VoiceLog {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const silentLog: VoiceLog = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** The modes of one call: the TA, the mock interviewer, and the listener of a talk-it-through (the student explains out loud, TAi hardly speaks). */
export type AgentMode = 'conversational' | 'interviewer' | 'listener';

/**
 * What a line the voice side adds to the student's chat may carry beyond its words: an old call summary (`voice`), or an `activity` (what it is
 * about, its title, and the longer account the page's card opens: src/portal/history.ts).
 */
export interface ChatExtra {
  kind?: 'voice' | 'activity' | 'speech';
  type?: string;
  title?: string;
  detail?: string;
  /** activity of a mock interview: the questions it asked (at most eight; src/portal/history.ts cleanItems cleans them), each with how it went in a word and a stronger answer. */
  items?: ActivityItem[];
  /** speech: the call's session id; a marker line (text '') says `event` (start, mode, end) with the call's `mode`, or on `end` how many `seconds` it lasted */
  call?: string;
  event?: 'start' | 'mode' | 'end';
  mode?: string;
  seconds?: number;
}

/** Why a call ended, as the browser is told in `closed`. */
export type CloseReason = 'user' | 'timeout' | 'agent' | 'error' | 'budget';

/** Who is calling: the portal's authenticated PortalUser (src/portal/auth.ts) has these fields; nothing of it comes from the browser. */
export interface Caller {
  email?: string;
  name: string;
  role?: 'owner' | 'student';
  folder: string;
  jid: string;
  canvasUserId?: string;
  githubUsername?: string;
}
