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
  /** 'labgpu', 'aura' or 'flux': for the trace and the logs. */
  readonly name: string;
  readonly takesSpeed: boolean;
  /**
   * Speaks one sentence. Yields PCM16 mono little-endian at **24 kHz** in pieces as they arrive (LabGPU's adapter answers a whole sentence in about 0.1 to 0.3 s, Aura streams).
   * Rejects (from the first `next()`) with a MouthError. An abort ends the iterator quietly (no error). The text must already be cleaned for speech (`spokenText`).
   */
  synthesize(text: string, opts: SynthOptions): AsyncIterable<Buffer>;
  /**
   * False: the engine does not render its fixed lines (the fillers) ahead of time through this mouth. A streaming mouth serves one speech after the other and charges by the character, so a warm-up
   * would hold the first answer back and cost money on every call. Default true.
   */
  readonly prewarm?: boolean;
  /**
   * A mouth that can say a whole answer as ONE continuous speech (Flux TTS): the text is handed over as the model writes it and the audio comes back as one stream, so that the intonation runs
   * through the sentences the way a person's does. A mouth without it is used a sentence at a time with `synthesize`.
   */
  openTurn?(opts: TurnOptions): SpeechTurn;
  /** Starts what a first `openTurn` would have to wait for (the socket), so that the first sentence is not held back by it. */
  prepare?(opts: TurnOptions): void;
  /** The call is over: the service's connection is closed. */
  close?(): void;
}

export interface TurnOptions {
  /** The voice of the service (Flux: flux-hannah-en ...). */
  voice: string;
  /** The pace the voice itself takes (Flux: 0.5 to 1.5 in steps of 0.05), undefined for its own. */
  speed?: number;
}

/** What the service says about a speech that was cut short: the text that was heard and the text that was not (cut at a word). */
export interface TurnSplit {
  spoken: string;
  remaining: string;
}

/**
 * One continuous speech of a streaming mouth: `speak` as often as the model writes something, `end` when it has finished, `audio` for the PCM16 24 kHz as it is made. The audio ends when the speech is
 * complete; it throws a MouthError (after what had arrived) when the service fails, and ends quietly when the speech was cut by `interrupt` or `abandon`.
 */
export interface SpeechTurn {
  /** Adds text to the speech (it is cleaned for speech by the caller). Returns what was sent, so that the caller can count characters. */
  speak(text: string): string;
  /** No more text is coming. */
  end(): void;
  readonly audio: AsyncIterable<Buffer>;
  /**
   * The student spoke: the speech is cut now. `playedMs` is how much of THIS speech's audio had played. Resolves with what the service says was spoken and what was not, or null when it could not
   * tell (nothing had been made yet, or no answer came). Never rejects.
   */
  interrupt(playedMs: number): Promise<TurnSplit | null>;
  /** Nobody will read the audio any more (the call is over); it is dropped as it arrives. */
  abandon(): void;
  /** How long the whole speech lasts, according to the service, once it is complete. */
  readonly durationMs: number | undefined;
}

/** The sample rate of everything the stand-in sends the session (Settings `audio.output`), and the bytes of one millisecond of it. */
export const OUT_RATE = 24_000;
export const OUT_BYTES_PER_MS = (OUT_RATE * 2) / 1000;
/** The sample rate of what the browser sends, and the bytes of one millisecond of it. */
export const IN_RATE = 16_000;
export const IN_BYTES_PER_MS = (IN_RATE * 2) / 1000;
