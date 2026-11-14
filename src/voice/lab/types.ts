/**
 * The contracts between the parts of the voice lab (docs/VOICE_SELFBUILT.md): what a recognizer ("ears") and a synthesizer ("mouth") look like to the
 * engine, so that LabGPU's services and Deepgram's hosted ones (the controls) can be swapped, and so that the parts can be built and tested apart.
 * Pure types, two small error classes and constants: no I/O in this file.
 */
import type { VoiceLog } from '../types.js';

/** A monotonic clock in milliseconds (performance.now in production, a fake in tests). Every `at` below is on the clock the engine gave the part. */
export type LabClock = () => number;

/** How patient the end of a turn is: a conversation, a mock interview (the student thinks aloud), a talk-it-through (the student explains at length). */
export type TurnProfile = 'chat' | 'interview' | 'talk';

/** The turn-taking fields of the Settings (Flux's own names): the confidence at which a turn ends, and the silence after which it ends whatever the confidence. */
export interface TurnFields {
  eotThreshold: number;
  eotTimeoutMs: number;
}

// ---------------------------------------------------------------- ears

/** What an ears implementation tells the engine. Called on the socket's own events; never throws into the caller's loop (the engine guards it). */
export interface EarsHandlers {
  /** The recognizer itself heard a turn begin (Flux `StartOfTurn`; its transcript is never empty). Recognizers with no such event never call it: the engine's own VAD hears the onset. */
  startOfTurn?(at: number, text: string): void;
  /** The running text of the utterance so far. LabGPU's adapter: about once a second (rounds of 1.1 s); Flux: every 0.25 s (`Update`). May repeat or change earlier words. */
  partial(text: string, at: number): void;
  /**
   * The recognizer's own final. LabGPU's adapter and nova (v1): `speech_final`, with the `is_final` segments of the utterance joined (Deepgram splits an utterance
   * over several segments; LabGPU's adapter sends it whole). Flux: `EndOfTurn`. `trigger` is Flux's (`model`, `manual`, `timeout`), `confidence` its `end_of_turn_confidence`.
   */
  final(text: string, at: number, info: { trigger?: string; confidence?: number }): void;
  /**
   * Flux `EagerEndOfTurn`, only when the stream was opened with an `eager_eot_threshold`: the turn may be over; `text` is what has been said so far. It is a guess that `turnResumed` may
   * take back, so nothing may be said or done on it (docs/VOICE_SELFBUILT.md 5.2 rule 5: the engine only asks the model early, and keeps the answer back until the turn is confirmed).
   */
  eagerEndOfTurn?(text: string, at: number): void;
  /** Flux `TurnResumed`: the student went on after an eager end of turn. */
  turnResumed?(at: number): void;
  /** The socket went away after it had been up (closed by the far side, an error, or no data at all while audio was being sent). `connect()` is for the first time only. */
  down(reason: string): void;
}

export interface Ears {
  /** 'labgpu', 'flux' or 'nova': for the trace and the logs. */
  readonly name: string;
  /**
   * True when the recognizer decides where a turn ends (Flux: its `final` IS the end of the turn, and the engine commits at once). False when it only transcribes (LabGPU's
   * adapter, nova): its `final` is a candidate, and the engine's own turn policy (src/voice/lab/turn.ts) decides.
   */
  readonly decidesTurn: boolean;
  /** Opens the socket. Rejects with a plain Error (never one that carries a key) when it is refused, does not answer within `timeoutMs`, or the handshake fails. */
  connect(timeoutMs: number): Promise<void>;
  readonly connected: boolean;
  /** 16 kHz mono PCM16 little-endian, 20 to 80 ms at a time; the implementation regroups to what its server wants (Deepgram: 80 ms). Dropped, not buffered, while not connected. */
  sendAudio(pcm16: Buffer): void;
  /** Flux: the turn-taking fields of a new mode (a `Configure` message). Other recognizers ignore it. */
  setTurnFields?(fields: TurnFields): void;
  /** Flux: end the turn now (`ForceEndTurn`). */
  forceEndTurn?(): void;
  /** Closes the socket for good (Flux: `CloseStream` first). Idempotent. */
  close(): void;
}

export interface EarsContext {
  clock: LabClock;
  log: VoiceLog;
}

/** What the engine tells a factory about the stream it wants besides the handlers: the course words, the turn-taking fields, and (Flux only) the eager end-of-turn threshold, 0 or undefined for none. */
export interface EarsRequest {
  keyterms: string[];
  turn: TurnFields;
  eagerEot?: number;
}

export type EarsFactory = (handlers: EarsHandlers, ctx: EarsContext) => Ears;

// ---------------------------------------------------------------- mouth

/** Why a sentence could not be made: the service is not there (`down`: refused, timed out, HTTP error), it answered with a substituted voice (`fallback`: LabGPU's adapter served ElevenLabs), or what came back is not PCM (`bad-audio`). */
export type MouthErrorKind = 'down' | 'fallback' | 'bad-audio';

export class MouthError extends Error {
  constructor(
    readonly kind: MouthErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'MouthError';
  }
}

export interface SynthOptions {
  /** The voice of the service (LabGPU: af_bella ...; Aura: aura-2-mars-en ...). */
  voice: string;
  /** A pace multiplier the voice itself takes (Aura's `speed`); a mouth with `takesSpeed` false ignores it and the engine time-stretches (src/voice/lab/mouth/tempo.ts). */
  speed?: number;
  /** Aborted when the student barges in or the call ends: the HTTP request is dropped and the iterator ends. */
  signal?: AbortSignal;
}

export interface Mouth {
  /** 'labgpu' or 'aura': for the trace and the logs. */
  readonly name: string;
  readonly takesSpeed: boolean;
  /**
   * Speaks one sentence. Yields PCM16 mono little-endian at **24 kHz** in pieces as they arrive (LabGPU's adapter answers a whole sentence in about 0.1 to 0.3 s, Aura streams).
   * Rejects (from the first `next()`) with a MouthError. An abort ends the iterator quietly (no error). The text must already be cleaned for speech (`spokenText`).
   */
  synthesize(text: string, opts: SynthOptions): AsyncIterable<Buffer>;
}

/** The sample rate of everything the stand-in sends the session (Settings `audio.output`), and the bytes of one millisecond of it. */
export const OUT_RATE = 24_000;
export const OUT_BYTES_PER_MS = (OUT_RATE * 2) / 1000;
/** The sample rate of what the browser sends, and the bytes of one millisecond of it. */
export const IN_RATE = 16_000;
export const IN_BYTES_PER_MS = (IN_RATE * 2) / 1000;
