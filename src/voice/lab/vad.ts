/**
 * The lab's own voice-activity detector: it tells the engine when the student's speech begins and when it stopped, on the audio the engine itself receives, because the
 * recognizers cannot be trusted with that: LabGPU's adapter reports `SpeechStarted` about 1.1 s after the onset (it works in rounds), and its partials come once a second.
 * Barge-in and the end-of-turn hold-off need the onset within tens of milliseconds and the end of speech to the frame.
 *
 * An energy gate over a tracked noise floor, the numbers of Nora's `agent/speech_gate.py` (RMS above 350 and above 3x the quietest frame of the last 3 s; the browser sends
 * noise-suppressed, levelled audio, which is what makes an absolute floor workable) and no dependency. Frames are 20 ms of 16 kHz PCM16; input of any size is regrouped.
 *
 * Two views of the same frames: the normal one (onset after `openFrames` voiced frames, 60 ms) and a strict one (the threshold times `strictFactor`) whose run length the
 * barge-in rule reads: while the agent speaks, a little echo gets past the browser's echo cancellation, and a cough is short, so a barge-in wants a sustained, louder run.
 */
import { IN_BYTES_PER_MS, type LabClock } from './types.js';

export interface VadOptions {
  rmsMin: number;
  ratio: number;
  /** Voiced frames in a row that open a speech run (3 x 20 ms = 60 ms). */
  openFrames: number;
  /** Quiet frames in a row that close it (a plosive's closure inside a word is shorter). The END time of speech is still the last voiced frame's. */
  closeFrames: number;
  frameMs: number;
  floorWindowMs: number;
  strictFactor: number;
}

const MIN_HISTORY_FRAMES = 25;
/** How many frames of the strict view are kept for `strictWindow` (3 s). */
const STRICT_HISTORY_FRAMES = 150;

export const DEFAULT_VAD: VadOptions = { rmsMin: 350, ratio: 3, openFrames: 3, closeFrames: 6, frameMs: 20, floorWindowMs: 3000, strictFactor: 1.5 };

export interface VadEvents {
  /** The normal view saw `openFrames` voiced frames in a row; `at` is the start of the first of them. */
  onset?(at: number): void;
}

/** RMS of 16-bit little-endian samples in units of the sample (0 to 32768). */
export function rmsOf(pcm: Buffer, start = 0, end = pcm.length): number {
  const n = Math.floor((end - start) / 2);
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(start + i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export class Vad {
  private readonly frameBytes: number;
  private carry: Buffer = Buffer.alloc(0);
  private readonly recent: number[] = [];
  private readonly maxRecent: number;
  private voicedRun = 0;
  private quietRun = 0;
  private strictRun = 0;
  private _voiced = false;
  private _lastVoicedEndAt = 0;
  private _runStartedAt = 0;
  private _onsets = 0;
  private _frames = 0;
  private _voicedFrames = 0;
  private lastRms = 0;
  /** The strict view of the latest frames (loud or not, and when each ended), for `strictWindow`. */
  private readonly strictHist: Array<{ loud: boolean; endAt: number }> = [];

  constructor(
    private readonly clock: LabClock,
    private readonly events: VadEvents = {},
    private readonly opts: VadOptions = DEFAULT_VAD,
  ) {
    this.frameBytes = Math.round(IN_BYTES_PER_MS * opts.frameMs);
    this.maxRecent = Math.max(1, Math.round(opts.floorWindowMs / opts.frameMs));
  }

  /** Whether the student is speaking now: true from the onset until `closeFrames` quiet frames in a row. */
  get voiced(): boolean {
    return this._voiced;
  }

  /** The end time (clock ms) of the last voiced frame: when the student stopped, as far as the audio says. 0 before any speech. */
  get lastVoicedEndAt(): number {
    return this._lastVoicedEndAt;
  }

  /** How many speech onsets have been seen in all. A change tells a caller that the student has begun to speak again. */
  get onsets(): number {
    return this._onsets;
  }

  /** How long the current run of strictly loud frames has lasted (ms; 0 when the latest frame was not loud enough). */
  get strictRunMs(): number {
    return this.strictRun * this.opts.frameMs;
  }

  /** How long the current run of voiced frames has lasted (ms; 0 when the latest frame was not voiced). */
  get voicedRunMs(): number {
    return this.voicedRun * this.opts.frameMs;
  }

  /**
   * The strict view over a window instead of a run (amendment A11): how much loud speech (strict frames) the last `windowMs` held, and where the first of those frames began. The
   * latest frame must be loud, else 0 (a dip is waited out: the next frame reads the window again). A stop consonant or the gap between two syllables drops a frame or three below the
   * bar, and a run that must be unbroken restarts at each of them (round 1: two of eight interruptions took 0.9 and 1.2 s to confirm, against 0.2 to 0.45 s for the others); a window
   * that must hold 240 ms of loud frames in 300 still needs the same sustained speech (a cough or a click does not hold 12 loud frames in 15), and the echo is kept out by the bar, as before.
   */
  strictWindow(windowMs: number): { voicedMs: number; startedAt: number } {
    const hist = this.strictHist;
    if (!hist.length || !hist[hist.length - 1].loud) return { voicedMs: 0, startedAt: 0 };
    const n = Math.min(hist.length, Math.max(1, Math.round(windowMs / this.opts.frameMs)));
    let loud = 0;
    let first = -1;
    for (let i = hist.length - n; i < hist.length; i++) {
      if (!hist[i].loud) continue;
      loud++;
      if (first < 0) first = i;
    }
    return { voicedMs: loud * this.opts.frameMs, startedAt: first < 0 ? 0 : hist[first].endAt - this.opts.frameMs };
  }

  /** The start of the current (or last) voiced run, clock ms. */
  get runStartedAt(): number {
    return this._runStartedAt;
  }

  /** All the voiced time seen so far (ms): the frames that passed the speech bar, in a run or not, never reset. The difference of two readings is the speech in between, whatever the pauses. */
  get voicedTotalMs(): number {
    return this._voicedFrames * this.opts.frameMs;
  }

  /** Frames seen and voiced, and the latest frame's level, for the trace. */
  get stats(): { frames: number; voicedFrames: number; lastRms: number } {
    return { frames: this._frames, voicedFrames: this._voicedFrames, lastRms: Math.round(this.lastRms) };
  }

  /** Clears the state of a speech run (not the noise floor): the end of a mute, a new call. */
  reset(): void {
    this.carry = Buffer.alloc(0);
    this.voicedRun = 0;
    this.quietRun = 0;
    this.strictRun = 0;
    this._voiced = false;
    this.strictHist.length = 0;
  }

  /**
   * PCM that has just arrived (so its last sample is "now"): framed, measured, and the state updated. Each frame is given the time it would have had if the audio
   * had arrived in real time, counted back from `now` in whole frames.
   */
  feed(pcm: Buffer): void {
    const data = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    const frames = Math.floor(data.length / this.frameBytes);
    this.carry = data.subarray(frames * this.frameBytes);
    if (!frames) return;
    const now = this.clock();
    for (let i = 0; i < frames; i++) {
      const endAt = now - (frames - 1 - i) * this.opts.frameMs;
      this.frame(rmsOf(data, i * this.frameBytes, (i + 1) * this.frameBytes), endAt);
    }
  }

  private frame(rms: number, endAt: number): void {
    this._frames++;
    this.lastRms = rms;
    this.recent.push(rms);
    if (this.recent.length > this.maxRecent) this.recent.shift();
    let floor = Infinity;
    for (const v of this.recent) if (v < floor) floor = v;
    // the noise floor needs some history: a stream that begins with speech must not take its first frames for the room's noise and then shut speech out
    const threshold = this.recent.length < MIN_HISTORY_FRAMES ? this.opts.rmsMin : Math.max(this.opts.rmsMin, this.opts.ratio * floor);
    const loud = rms >= threshold * this.opts.strictFactor;
    this.strictRun = loud ? this.strictRun + 1 : 0;
    this.strictHist.push({ loud, endAt });
    if (this.strictHist.length > STRICT_HISTORY_FRAMES) this.strictHist.shift();
    if (rms < threshold) {
      this.voicedRun = 0;
      this.quietRun++;
      if (this._voiced && this.quietRun >= this.opts.closeFrames) this._voiced = false;
      return;
    }
    this._voicedFrames++;
    this.quietRun = 0;
    if (this.voicedRun === 0) this._runStartedAt = endAt - this.opts.frameMs;
    this.voicedRun++;
    this._lastVoicedEndAt = endAt;
    if (!this._voiced && this.voicedRun >= this.opts.openFrames) {
      this._voiced = true;
      this._onsets++;
      try {
        this.events.onset?.(this._runStartedAt);
      } catch {
        /* a listener that throws must not stop the audio */
      }
    }
  }
}
