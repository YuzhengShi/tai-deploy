/**
 * What goes out to the browser as the agent's voice: sentences in order, each synthesised as soon as it is said (the next one while the current one plays), and the audio
 * sent at about real time with a small lead (docs/VOICE_SELFBUILT.md 3.1 and 5.5). Pacing is what makes barge-in honest: Deepgram's agent may send audio faster than it plays and
 * let the browser queue it; here at most `leadMs` is ever in the browser's queue, so when the student speaks the audio stops within that, and what was SPOKEN of an answer
 * (which is what the model must remember it said) can be told from the clock instead of guessed.
 *
 * The playhead is the moment at which everything sent so far has finished playing, assuming the browser plays chunks back to back as they come: a chunk sent at time t that lasts d
 * starts at max(playhead, t). The sentence's `sentenceStart` (the page's transcript line) and the turn's end (`idle`, Deepgram's AgentAudioDone) are events at those moments.
 *
 * Everything is driven by `tick()`, which the engine calls every 10 ms while there is anything to do; tests call it themselves with a fake clock.
 *
 * TWO WAYS TO MAKE A SENTENCE. A mouth that speaks one sentence per request (LabGPU, Aura's REST) is asked for each sentence by itself: each is an item of the queue with its own audio. A streaming
 * mouth (Flux TTS, `openTurn`) says a whole answer as ONE continuous speech so that the intonation runs through it: the sentences of an answer are handed to one `SpeechTurn` as they come
 * (`say`), `endText` says the answer is complete, and the speech's audio is one item of the queue whose sentences ("segments") are placed on its timeline by their characters, since the service
 * tells where the audio is, not where a sentence begins: a segment is announced (the page's transcript line) when the clock reaches its estimated start, by the speech's real length once the service
 * has said it. On a stop the same estimate says how much of each sentence was heard, and, while the service is still making the speech, it is asked for the exact words.
 */
import { MouthError, OUT_BYTES_PER_MS, type LabClock, type SpeechTurn, type TurnSplit } from './types.js';

export type Synthesize = (text: string, signal: AbortSignal) => AsyncIterable<Buffer>;

export interface SpeakerHooks {
  /** PCM16 24 kHz to the browser. */
  audio(chunk: Buffer, at: number): void;
  /** The first chunk of a sentence goes out (the first sentence after the agent had been silent is when speech begins: the engine's latency report; a later one is its answer behind a filler). */
  sentenceFirstChunk(at: number, text: string, tag: number): void;
  /** The sentence begins to play (about when its first chunk is audible): the page's transcript line. */
  sentenceStart(text: string, at: number, tag: number): void;
  /** Everything said has been played out. */
  idle(at: number): void;
  /** A sentence could not be made and nothing of it was played. */
  failed(text: string, err: Error): void;
  /**
   * May the speech be reported as over now? False while more of it is on its way (the model is still writing the answer: a gap between two sentences is not the end of a turn, and
   * Deepgram's AgentAudioDone does not come in it). Asked at every tick once everything queued has been played out. Default: yes.
   */
  canIdle?(): boolean;
  /** A streaming mouth failed a speech (the connection went, the service refused): the engine should stop using it for a while. */
  streamFailed?(err: Error): void;
}

export interface SpokenSentence {
  tag: number;
  text: string;
  /** Its audio began to play before the speaker was stopped. */
  started: boolean;
  /** How much of it had played (0 to 1). */
  playedFraction: number;
}

export interface SpokenReport {
  sentences: SpokenSentence[];
  /** The agent was speaking (audio sent and not yet played out) when it was stopped. */
  wasSpeaking: boolean;
  /**
   * Set when a speech of a streaming mouth was cut while the service was still making it: it resolves, within a moment, with what the service says was heard of that speech (cut at a word) and the
   * tags of the sentences that make it. The `sentences` above are an estimate that is there at once; this is the exact one. Resolves with null when the service could not tell.
   */
  exact?: Promise<{ tags: number[]; split: TurnSplit } | null>;
}

/** One sentence inside a streamed speech. */
interface Segment {
  tag: number;
  text: string;
  /** The characters sent to the speech before this sentence (a space counts after each). */
  before: number;
  chars: number;
  announced: boolean;
}

interface StreamState {
  turn: SpeechTurn;
  segments: Segment[];
  /** The characters sent to the speech so far. */
  chars: number;
}

interface Item {
  tag: number;
  text: string;
  abort: AbortController;
  chunks: Buffer[];
  bytes: number;
  complete: boolean;
  error: Error | null;
  /** The next piece to send (chunk index and byte offset into it) and what has been sent. */
  sentBytes: number;
  playStart: number | null;
  /** The text was handed to the model-side history when it began to play. */
  announced: boolean;
  failedReported: boolean;
  /** Present when this item is a whole speech of a streaming mouth instead of one sentence. */
  stream?: StreamState;
}

export interface SpeakerOptions {
  clock: LabClock;
  synthesize: Synthesize;
  hooks: SpeakerHooks;
  leadMs?: number;
  chunkMs?: number;
  /** Words per second used to estimate how long a sentence whose synthesis is still arriving will take (for the played fraction at a stop). */
  estimateWordsPerSecond?: number;
  /** Set false in tests that call `tick()` themselves. */
  autoTick?: boolean;
  tickMs?: number;
  /** A streaming mouth's speech for the answer that begins now, or null when the sentences are to be made one by one (no such mouth, or it is not to be used now). */
  openTurn?: () => SpeechTurn | null;
  /** Milliseconds of audio per character of text, to place the sentences of a streamed speech before the service has said how long it is (flux-hannah-en: about 60 at its own pace). */
  estimateMsPerChar?: number | (() => number);
}

const wordCount = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

export class Speaker {
  private readonly clock: LabClock;
  private readonly synthesize: Synthesize;
  private readonly hooks: SpeakerHooks;
  private readonly leadMs: number;
  private readonly chunkBytes: number;
  private readonly wps: number;
  private readonly autoTick: boolean;
  private readonly tickMs: number;
  private queue: Item[] = [];
  /** Sentences whose audio has been (at least partly) sent, newest last, until they have been played out: what a stop reports. */
  private played: Item[] = [];
  private playhead = 0;
  private speakingNow = false;
  private idleAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private starts: Array<{ item: Item; at: number }> = [];
  private stopped = false;
  private readonly openTurn: (() => SpeechTurn | null) | undefined;
  private readonly msPerChar: () => number;
  /** The streamed speech that still takes sentences. */
  private openStream: Item | null = null;

  constructor(opts: SpeakerOptions) {
    this.clock = opts.clock;
    this.synthesize = opts.synthesize;
    this.hooks = opts.hooks;
    this.leadMs = opts.leadMs ?? 500;
    const chunkMs = opts.chunkMs ?? 40;
    this.chunkBytes = Math.max(2, Math.round(chunkMs * OUT_BYTES_PER_MS) & ~1);
    this.wps = opts.estimateWordsPerSecond ?? 3.45;
    this.autoTick = opts.autoTick ?? true;
    this.tickMs = opts.tickMs ?? 10;
    this.openTurn = opts.openTurn;
    const est = opts.estimateMsPerChar ?? 60;
    this.msPerChar = typeof est === 'function' ? est : () => est;
  }

  /** True from the first chunk of speech until it has been played out (or the speaker is stopped). */
  get speaking(): boolean {
    return this.speakingNow;
  }

  /** Something is waiting to be spoken or being synthesised. */
  get pending(): boolean {
    return this.queue.length > 0;
  }

  /** Queues a sentence and starts making its audio at once. */
  say(text: string, tag = 0): void {
    const t = text.trim();
    if (!t || this.stopped) return;
    if (this.sayToStream(t, tag)) return;
    const item = this.sentenceItem(t, tag);
    this.queue.push(item);
    this.idleAt = null;
    void this.collect(item);
    this.arm();
  }

  private sentenceItem(text: string, tag: number): Item {
    return { tag, text, abort: new AbortController(), chunks: [], bytes: 0, complete: false, error: null, sentBytes: 0, playStart: null, announced: false, failedReported: false };
  }

  /** The text of the answer is complete (the model has finished, or a line said by itself): a streamed speech is told so, and the next sentence begins a new one. */
  endText(): void {
    const item = this.openStream;
    if (!item?.stream) return;
    this.openStream = null;
    try {
      item.stream.turn.end();
    } catch {
      /* the turn reports its own failure through its audio */
    }
  }

  /** The sentence goes into the streamed speech that is open, or opens one when a streaming mouth is there for it. False: it is to be made on its own. */
  private sayToStream(text: string, tag: number): boolean {
    let item = this.openStream;
    if (item?.error) {
      this.openStream = null;                      // a speech that has failed takes no more: the rest of the answer is made sentence by sentence
      item = null;
    }
    if (!item) {
      const turn = this.openTurn?.() ?? null;
      if (!turn) return false;
      item = { ...this.sentenceItem(text, tag), stream: { turn, segments: [], chars: 0 } };
      this.queue.push(item);
      this.openStream = item;
      void this.collectStream(item);
    }
    const st = item.stream!;
    const sent = st.turn.speak(text);
    st.segments.push({ tag, text, before: st.chars, chars: sent.length, announced: false });
    st.chars += sent.length + 1;
    this.idleAt = null;
    this.arm();
    return true;
  }

  private async collectStream(item: Item): Promise<void> {
    const st = item.stream!;
    try {
      for await (const piece of st.turn.audio) {
        if (item.abort.signal.aborted) return;
        if (piece.length) {
          item.chunks.push(piece);
          item.bytes += piece.length;
        }
      }
    } catch (err) {
      if (!item.abort.signal.aborted) {
        item.error = err instanceof Error ? err : new MouthError('down', 'the synthesizer failed');
        try {
          this.hooks.streamFailed?.(item.error);
        } catch {
          /* the engine's hook */
        }
      }
    } finally {
      item.complete = true;
    }
  }

  /** Milliseconds of audio per character for this streamed speech: the service's own length once it has said it, else the estimate. */
  private msPerCharOf(st: StreamState): number {
    const d = st.turn.durationMs;
    return d && st.chars > 0 ? d / st.chars : this.msPerChar();
  }

  private async collect(item: Item): Promise<void> {
    try {
      for await (const piece of this.synthesize(item.text, item.abort.signal)) {
        if (item.abort.signal.aborted) return;
        if (piece.length) {
          item.chunks.push(piece);
          item.bytes += piece.length;
        }
      }
    } catch (err) {
      if (!item.abort.signal.aborted) item.error = err instanceof Error ? err : new MouthError('down', 'the synthesizer failed');
    } finally {
      item.complete = true;
    }
  }

  private arm(): void {
    if (!this.autoTick || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One step: send what the lead allows, announce sentences that have begun to play, and report the end when everything has played out. */
  tick(): void {
    if (this.stopped) return;
    const now = this.clock();
    // the model has finished and nobody said so: a speech that is still open is ended (it would never complete, and the turn would never be reported as over)
    if (this.openStream && (this.hooks.canIdle?.() ?? true)) this.endText();
    this.send(now);
    this.announceSegments(now);
    for (const s of this.starts.filter((x) => x.at <= now)) {
      this.starts.splice(this.starts.indexOf(s), 1);
      if (!s.item.announced) {
        s.item.announced = true;
        try {
          this.hooks.sentenceStart(s.item.text, now, s.item.tag);
        } catch {
          /* the engine's hook must not stop the audio */
        }
      }
    }
    if (this.idleAt !== null && now >= this.idleAt && this.queue.length === 0 && (this.hooks.canIdle?.() ?? true)) {
      this.announceSegments(now, true);              // (a speech that failed has no length to place its last sentences by: they are announced now rather than never)
      this.idleAt = null;
      this.speakingNow = false;
      this.played = [];
      this.disarm();
      try {
        this.hooks.idle(now);
      } catch {
        /* as above */
      }
    }
  }

  /** The sentences of a streamed speech whose estimated start the audio has reached, in order. */
  private announceSegments(now: number, all = false): void {
    for (const item of this.played) {
      const st = item.stream;
      if (!st || item.playStart === null) continue;
      const sentMs = item.sentBytes / OUT_BYTES_PER_MS;
      const mpc = this.msPerCharOf(st);
      for (const seg of st.segments) {
        if (seg.announced) continue;
        const off = seg.before * mpc;
        if (!all && (now < item.playStart + off || sentMs < off)) break;
        seg.announced = true;
        try {
          this.hooks.sentenceStart(seg.text, now, seg.tag);
        } catch {
          /* the engine's hook must not stop the audio */
        }
      }
    }
  }

  private send(now: number): void {
    while (this.queue.length) {
      const item = this.queue[0];
      if (item.sentBytes >= item.bytes) {
        if (item.stream && item.error && item.bytes === 0 && !item.failedReported) {
          // a whole speech that failed before it made any audio: its sentences are made one by one instead, in its place (the engine has been told, and the synthesizer it falls back to makes them),
          // so that the student still hears the answer
          item.failedReported = true;
          this.queue.shift();
          if (this.openStream === item) this.openStream = null;
          const redo = item.stream.segments.map((seg) => this.sentenceItem(seg.text, seg.tag));
          this.queue.unshift(...redo);
          for (const r of redo) void this.collect(r);
          continue;
        }
        if (item.error && item.bytes === 0 && !item.failedReported) {
          // nothing of it came: skipped, said so (a sentence missing from a turn is better than one that holds the rest back)
          item.failedReported = true;
          this.queue.shift();
          try {
            this.hooks.failed(item.text, item.error);
          } catch {
            /* the engine's hook */
          }
          continue;
        }
        if (!item.complete) return;
        // all of this sentence has been sent: the next one, or the end of the speech
        this.queue.shift();
        if (!this.queue.length) this.idleAt = Math.max(this.playhead, now);
        continue;
      }
      if (this.playhead - now > this.leadMs) return;
      const start = Math.max(this.playhead, now);
      const piece = this.take(item);
      if (item.playStart === null) {
        item.playStart = start;
        this.played.push(item);
        if (!item.stream) this.starts.push({ item, at: start });
        this.speakingNow = true;
        try {
          this.hooks.sentenceFirstChunk(now, item.stream?.segments[0]?.text ?? item.text, item.stream?.segments[0]?.tag ?? item.tag);
        } catch {
          /* the engine's hook */
        }
      }
      this.playhead = start + piece.length / OUT_BYTES_PER_MS;
      try {
        this.hooks.audio(piece, now);
      } catch {
        /* a socket that went away is the engine's to notice; the timer must not die of it */
      }
    }
    if (this.idleAt === null && this.speakingNow && this.queue.length === 0) this.idleAt = Math.max(this.playhead, now);
  }

  /** The next `chunkBytes` (or what is left, always whole samples) of the sentence's audio. */
  private take(item: Item): Buffer {
    const want = Math.min(this.chunkBytes, item.bytes - item.sentBytes);
    const out = Buffer.alloc(want & ~1 || want);
    let filled = 0;
    let skip = item.sentBytes;
    for (const c of item.chunks) {
      if (skip >= c.length) {
        skip -= c.length;
        continue;
      }
      const n = Math.min(c.length - skip, out.length - filled);
      c.copy(out, filled, skip, skip + n);
      filled += n;
      skip = 0;
      if (filled >= out.length) break;
    }
    item.sentBytes += filled;
    return filled === out.length ? out : out.subarray(0, filled);
  }

  /**
   * The student spoke (or the call ends): no more audio, every synthesis aborted, the queue dropped. Returns what had been spoken: the sentences whose audio had begun to play, each
   * with the fraction of it that had played by now (the clock against its play start and its length), so that the model's memory of what it said can be cut to that.
   */
  stop(): SpokenReport {
    const now = this.clock();
    const report: SpokenSentence[] = [];
    const exact = this.stopStreams(now, report);
    for (const item of this.played) {
      if (item.stream) continue;
      const started = item.playStart !== null && item.playStart <= now;
      let fraction = 0;
      if (started && item.playStart !== null) {
        const known = item.bytes / OUT_BYTES_PER_MS;
        const estimate = (wordCount(item.text) / this.wps) * 1000;
        const length = item.complete ? known : Math.max(known, estimate);
        fraction = length > 0 ? Math.min(1, Math.max(0, (now - item.playStart) / length)) : 0;
      }
      report.push({ tag: item.tag, text: item.text, started, playedFraction: Math.round(fraction * 100) / 100 });
    }
    const wasSpeaking = this.speakingNow;
    for (const item of [...this.queue, ...this.played]) item.abort.abort();
    this.queue = [];
    this.played = [];
    this.starts = [];
    this.openStream = null;
    this.idleAt = null;
    this.speakingNow = false;
    this.playhead = 0;
    this.disarm();
    return { sentences: report, wasSpeaking, ...(exact ? { exact } : {}) };
  }

  /**
   * The streamed speeches at a stop: each one's sentences as an estimate (a sentence began when the clock passed its place on the speech's timeline; of the one that was playing, the part by what
   * played), and the first speech that the service is still making is cut with the offset of what of it had played, which the service answers with the exact words. The others are let go.
   */
  private stopStreams(now: number, report: SpokenSentence[]): SpokenReport['exact'] {
    let exact: SpokenReport['exact'];
    let cut = false;
    const items = [...this.played, ...this.queue.filter((q) => !this.played.includes(q))].filter((i) => i.stream);
    for (const item of items) {
      const st = item.stream;
      if (!st) continue;
      const sent = item.bytes / OUT_BYTES_PER_MS;
      const playedMs = item.playStart === null ? 0 : Math.min(sent, Math.max(0, now - item.playStart));
      const mpc = this.msPerCharOf(st);
      if (item.playStart !== null) {
        for (const seg of st.segments) {
          const off = seg.before * mpc;
          const length = (seg.chars + 1) * mpc;
          const started = item.playStart <= now && playedMs > off;
          const fraction = started ? Math.min(1, Math.max(0, (playedMs - off) / length)) : 0;
          report.push({ tag: seg.tag, text: seg.text, started, playedFraction: Math.round(fraction * 100) / 100 });
        }
      }
      if (!item.complete && !cut) {
        cut = true;
        const tags = st.segments.map((s) => s.tag);
        exact = st.turn
          .interrupt(playedMs)
          .then((split) => (split ? { tags, split } : null))
          .catch(() => null);
      } else st.turn.abandon();
    }
    return exact;
  }

  /** Ends the speaker for good (the call is over): like `stop`, and nothing can be said after it. */
  close(): void {
    this.stop();
    this.stopped = true;
  }
}

/** The part of the words a sentence had played: cut at a word boundary, with no ellipsis (the model reads its own memory of what it said). */
export function wordsPlayed(text: string, fraction: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (fraction >= 0.98) return words.join(' ');
  const n = Math.floor(words.length * fraction);
  return words.slice(0, Math.max(0, n)).join(' ');
}

/** The text of an answer the student interrupted, as far as it was spoken: whole sentences that played, and the one that was playing cut by its played fraction. */
export function spokenTextOf(report: SpokenReport): string {
  const out: string[] = [];
  for (const s of report.sentences) {
    if (!s.started) continue;
    const part = wordsPlayed(s.text, s.playedFraction);
    if (part) out.push(part);
  }
  return out.join(' ');
}
