/**
 * The per-turn trace of the voice lab (docs/VOICE_SELFBUILT.md section 6): one JSON line per turn with the moments the engine saw, in milliseconds from the start of the call, so that
 * the owner's real calls can be read the way he reads transcripts, and so that a number in the report can be traced to the step that made it (the recognizer's final, the first model
 * token, the first byte of the synthesis, the first audio out). It holds the owner's own words (the first 80 characters of what he said) because the endpoint is his alone, and no secret.
 * Writing it never fails a call: an error is a warning, once.
 */
import fs from 'fs';
import path from 'path';

import type { VoiceLog } from '../types.js';

export interface BargeTrace {
  /** The first loud frame of the student's speech, the moment the engine was sure (240 ms of it), and when the last audio went out. */
  onset: number;
  confirmed: number;
  audioStopped: number;
  /** What had been spoken of the answer: the sentences that began, each with the fraction played. */
  spoken: Array<{ words: number; played: number }>;
  by: 'vad' | 'startOfTurn';
}

/**
 * One request to the model made before the turn was confirmed (the eager end of turn, amendment A10): when it was asked, by which recognizer's event, and what became of it. A request
 * that was adopted belongs to the turn it is in; one that was dropped is written with the next turn of the call (a call that ends after it loses the note).
 */
export interface SpecTrace {
  /** When the request went out (ms from the start of the call). */
  askedAt: number;
  /** 'flux': the ears' own eager end of turn; 'flux-shadow': the second recognizer's, beside LabGPU's. */
  source: 'flux' | 'flux-shadow';
  outcome: 'adopted' | 'dropped';
  /** Why a request was dropped: 'resumed' (Flux's TurnResumed), 'start of turn' (Flux's StartOfTurn), 'speech' (the engine heard the student begin again), 'different words', 'history changed', 'failed', 'replaced' (a newer eager text), 'closed'. */
  why?: string;
  /** When it ended up (ms from the start of the call): the commit that adopted it, or the moment it was dropped. */
  endedAt: number;
  /** The first sentence of its answer was ready at this time (ms from the start of the call), when it was before it ended up. */
  readyAt?: number;
}

/** One request to the model within a turn (a turn with function calls has several). */
export interface RoundTrace {
  /** When the request went out, in milliseconds from the start of the call. */
  thinkSent: number;
  /** The first text of its answer. */
  firstToken?: number;
  /** Rounds after the first: the engine's own part of the function round trip (docs 9.4 C5, amendment A3), this request's `thinkSent` minus the moment the last function of the previous round answered. */
  afterAnswerMs?: number;
}

export interface TurnTrace {
  sid: string;
  mode: string;
  ears: string;
  mouth: string;
  /** 1-based, in the call. 0 is the greeting. */
  turn: number;
  /** The chain the call asked for (`?chain=`: d, h, fd or c), absent when the process's own settings ran it. */
  chain?: string;
  /** Wall clock of the commit (ISO), for finding the turn in a journal. */
  at: string;
  speechStart?: number;
  speechEnd?: number;
  earsPartialFirst?: number;
  earsFinal?: number;
  /** The end of turn: the student's words handed to the model. */
  commit?: number;
  commitReason?: string;
  thinkSent?: number;
  firstToken?: number;
  firstSentence?: number;
  /** An eagerly requested answer: when its first sentence was ready (the sentence itself goes out at the commit if that is later: `firstSentence`). */
  firstSentenceReady?: number;
  ttsSent?: number;
  ttsFirstByte?: number;
  firstAudioOut?: number;
  audioDone?: number;
  bargeIn?: BargeTrace;
  functions: Array<{ name: string; startedAt: number; answeredAt?: number }>;
  /** Every request to the model of this turn, in order (the first round's `thinkSent` and `firstToken` are also the turn's own fields above). */
  rounds: RoundTrace[];
  /** The requests made before a turn was confirmed that this turn found (the one it adopted, and those dropped since the last turn): docs A10. */
  specs?: SpecTrace[];
  fillers: Array<{ text: string; injectedAt: number; audioAt?: number }>;
  fallbacks: string[];
  userText?: string;
  /** What the shadow recognizer heard of the same speech (its finals that arrived since the speech began), with their times: for comparing recognizers on real calls. */
  shadow?: { ears: string; finals: Array<{ text: string; at: number }> };
  agentWords?: number;
  /** What the report reads: the end-of-turn wait (commit - speechEnd), Deepgram's `total` (commit to first audio), the whole wait from the end of speech, and the head start an adopted eager request had (commit - thinkSent, when the model was asked before the commit). */
  derived: { eotWait?: number; total?: number; fromSpeechEnd?: number; headStart?: number };
}

export function newTurnTrace(base: { sid: string; mode: string; ears: string; mouth: string; turn: number; at: string }): TurnTrace {
  return { ...base, functions: [], rounds: [], fillers: [], fallbacks: [], derived: {} };
}

export function finishDerived(t: TurnTrace): void {
  if (t.commit !== undefined && t.speechEnd !== undefined) t.derived.eotWait = Math.round(t.commit - t.speechEnd);
  if (t.commit !== undefined && t.firstAudioOut !== undefined) t.derived.total = Math.round(t.firstAudioOut - t.commit);
  if (t.speechEnd !== undefined && t.firstAudioOut !== undefined) t.derived.fromSpeechEnd = Math.round(t.firstAudioOut - t.speechEnd);
  if (t.commit !== undefined && t.thinkSent !== undefined && t.thinkSent < t.commit) t.derived.headStart = Math.round(t.commit - t.thinkSent);
}

export interface TraceSink {
  write(turn: TurnTrace): void;
}

export const nullSink: TraceSink = { write: () => undefined };

/** Appends lines to `file` (directory made 0700, file 0600). The numbers are rounded to whole milliseconds on the way out. */
export function fileSink(file: string, log: VoiceLog): TraceSink {
  let warned = false;
  let ready = false;
  const round = (_k: string, v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : v);
  return {
    write(turn) {
      try {
        if (!ready) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          ready = true;
        }
        // synchronous on purpose: one short line a turn, so the lines stay in the order of the turns (two asynchronous appends can finish in either order)
        fs.appendFileSync(file, JSON.stringify(turn, round) + '\n', { mode: 0o600 });
      } catch (err) {
        if (!warned) {
          warned = true;
          log.warn({ err: (err as Error).message }, 'voice lab: the trace could not be written');
        }
      }
    },
  };
}
