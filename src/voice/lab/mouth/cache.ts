/**
 * `PcmCache`: synthesized audio kept by sentence, so that the fixed lines of a call (the 24 filler lines "one sec", "still looking", and the greetings of
 * each mode) start with no wait for the synthesizer. They are the same for every call, so they are made once per voice when the lab starts (`warm`) and
 * played from memory afterwards.
 *
 * Least recently used goes first when the total passes `maxBytes`. The Buffers it hands out are the cache's own: treat them as read-only.
 */

export interface WarmItem {
  text: string;
}

export interface WarmOptions {
  /** How many lines are made at once. The synthesizer is another person's shared box, so the default is one. */
  concurrency?: number;
  /** Stops starting new lines; `warm` then returns at once, without waiting for the lines being made. */
  signal?: AbortSignal;
}

export class PcmCache {
  /** A Map keeps the order of insertion, so its first key is always the least recently used one (a read or a write moves a key to the end). */
  private readonly entries = new Map<string, Buffer>();
  private total = 0;

  constructor(readonly maxBytes = 32 * 1024 * 1024) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError(`PcmCache: bad size ${maxBytes}`);
  }

  /** Everything that decides how a line sounds: the same line in another voice, pace or mouth is another entry. A speed of 1 and no speed are the same. */
  static key(mouth: string, voice: string, speed: number | undefined, text: string): string {
    const pace = speed === undefined || !Number.isFinite(speed) || speed === 1 ? null : Math.round(speed * 100) / 100;
    return JSON.stringify([mouth, voice, pace, text]); // JSON, so no separator inside a voice or a line can make two keys look alike
  }

  /** The audio, or undefined. Counts as a use. */
  get(key: string): Buffer | undefined {
    const pcm = this.entries.get(key);
    if (pcm === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, pcm);
    return pcm;
  }

  /** Whether the line is there. Not a use: a check must not keep a line alive. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Keeps a copy (a slice of a big pooled Buffer would hold the whole pool in memory and make the byte count wrong). Empty audio, or audio larger than the whole cache, is not kept. */
  put(key: string, pcm: Buffer): void {
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.total -= old.length;
      this.entries.delete(key);
    }
    if (pcm.length === 0 || pcm.length > this.maxBytes) return;
    const copy = Buffer.allocUnsafeSlow(pcm.length);
    pcm.copy(copy);
    this.entries.set(key, copy);
    this.total += copy.length;
    while (this.total > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.total -= this.entries.get(oldest.value)?.length ?? 0;
      this.entries.delete(oldest.value);
    }
  }

  /** Bytes held now. */
  get bytes(): number {
    return this.total;
  }

  /** Lines held now. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  /**
   * Makes the lines that are not in the cache yet. `synth` returns the audio of one line, or null when it could not; `keyOf` names a line's entry. A line
   * already present is skipped (and counts as done: it is warm). A line made twice in the list is made once. Never throws: a synth that fails, throws or
   * returns nothing counts in `failed`. On abort no new line is started and the result is what had been counted by then.
   */
  async warm(
    items: readonly WarmItem[],
    synth: (text: string) => Promise<Buffer | null>,
    keyOf: (text: string) => string,
    opts: WarmOptions = {},
  ): Promise<{ done: number; failed: number }> {
    const signal = opts.signal;
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1) || 1);
    const queue = [...items];
    const making = new Map<string, Promise<boolean>>();
    let done = 0;
    let failed = 0;
    let next = 0;

    const make = async (key: string, text: string): Promise<boolean> => {
      try {
        const pcm = await synth(text);
        if (!pcm || pcm.length === 0) return false;
        this.put(key, pcm);
        return true;
      } catch {
        return false;
      }
    };

    const one = async (text: string): Promise<void> => {
      let key: string;
      try {
        key = keyOf(text);
      } catch {
        failed++;
        return;
      }
      if (this.has(key)) {
        done++;
        return;
      }
      let job = making.get(key);
      if (!job) {
        job = make(key, text).finally(() => making.delete(key));
        making.set(key, job);
      }
      if (await job) done++;
      else failed++;
    };

    const worker = async (): Promise<void> => {
      while (!signal?.aborted && next < queue.length) {
        const item = queue[next++];
        await one(item?.text ?? '');
      }
    };

    const all = Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    if (!signal) {
      await all;
    } else {
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      try {
        await Promise.race([all, aborted]);
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    }
    return { done, failed };
  }
}
