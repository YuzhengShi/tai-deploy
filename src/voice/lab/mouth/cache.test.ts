import { describe, expect, it } from 'vitest';

import { PcmCache } from './cache.js';

const pcm = (bytes: number, fill = 1): Buffer => Buffer.alloc(bytes, fill);
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('PcmCache: keeping lines', () => {
  it('gives back what was put, and nothing for what was not', () => {
    const cache = new PcmCache();
    cache.put('a', pcm(10, 7));
    expect(cache.has('a')).toBe(true);
    expect(cache.get('a')?.equals(pcm(10, 7))).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(10);
  });

  it('keeps a copy: changing the source later changes nothing, and a slice of a big Buffer does not hold the big one', () => {
    const cache = new PcmCache();
    const source = pcm(1000, 5);
    cache.put('a', source.subarray(10, 20));
    source.fill(9);
    const kept = cache.get('a');
    expect(kept?.equals(pcm(10, 5))).toBe(true);
    expect(kept?.buffer.byteLength).toBe(10);
  });

  it('replaces a line put again under the same key, and counts its bytes once', () => {
    const cache = new PcmCache();
    cache.put('a', pcm(10));
    cache.put('a', pcm(30, 2));
    expect(cache.bytes).toBe(30);
    expect(cache.size).toBe(1);
    expect(cache.get('a')?.equals(pcm(30, 2))).toBe(true);
  });

  it('does not keep empty audio, or audio larger than the whole cache (and drops the older line of that key)', () => {
    const cache = new PcmCache(100);
    cache.put('a', pcm(50));
    cache.put('a', pcm(0));
    expect(cache.has('a')).toBe(false);
    cache.put('big', pcm(101));
    expect(cache.has('big')).toBe(false);
    expect(cache.bytes).toBe(0);
    cache.put('exact', pcm(100));
    expect(cache.has('exact')).toBe(true);
  });

  it('forgets the least recently used lines when the total passes the limit', () => {
    const cache = new PcmCache(100);
    cache.put('a', pcm(40));
    cache.put('b', pcm(40));
    cache.put('c', pcm(40)); // 120 > 100: a goes
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b') && cache.has('c')).toBe(true);
    expect(cache.bytes).toBe(80);
    cache.get('b'); // b is used again, so c is now the oldest
    cache.put('d', pcm(40));
    expect(cache.has('c')).toBe(false);
    expect(cache.has('b') && cache.has('d')).toBe(true);
  });

  it('may forget several small lines for one large one, and never the line just put', () => {
    const cache = new PcmCache(100);
    for (const k of ['a', 'b', 'c', 'd']) cache.put(k, pcm(25));
    cache.put('big', pcm(90));
    expect(cache.size).toBe(1);
    expect(cache.has('big')).toBe(true);
    expect(cache.bytes).toBe(90);
  });

  it('does not count a check with `has` as a use, but counts `get`', () => {
    const cache = new PcmCache(80);
    cache.put('a', pcm(40));
    cache.put('b', pcm(40));
    cache.has('a');
    cache.put('c', pcm(40));
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  it('can be emptied', () => {
    const cache = new PcmCache();
    cache.put('a', pcm(10));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('holds 32 MiB by default, and refuses a nonsense size', () => {
    expect(new PcmCache().maxBytes).toBe(32 * 1024 * 1024);
    expect(() => new PcmCache(-1)).toThrow(RangeError);
    expect(() => new PcmCache(NaN)).toThrow(RangeError);
  });
});

describe('PcmCache.key', () => {
  it('differs for another mouth, voice, speed or text', () => {
    const base = PcmCache.key('labgpu', 'af_bella', 1.2, 'One sec.');
    expect(PcmCache.key('aura', 'af_bella', 1.2, 'One sec.')).not.toBe(base);
    expect(PcmCache.key('labgpu', 'af_heart', 1.2, 'One sec.')).not.toBe(base);
    expect(PcmCache.key('labgpu', 'af_bella', 1.1, 'One sec.')).not.toBe(base);
    expect(PcmCache.key('labgpu', 'af_bella', 1.2, 'One sec')).not.toBe(base);
    expect(PcmCache.key('labgpu', 'af_bella', 1.2, 'One sec.')).toBe(base);
  });

  it('is the same for no speed and a speed of 1', () => {
    expect(PcmCache.key('aura', 'aura-2-mars-en', undefined, 'Hi.')).toBe(PcmCache.key('aura', 'aura-2-mars-en', 1, 'Hi.'));
    expect(PcmCache.key('aura', 'aura-2-mars-en', undefined, 'Hi.')).not.toBe(PcmCache.key('aura', 'aura-2-mars-en', 1.05, 'Hi.'));
  });

  it('cannot be fooled by a separator inside a voice or a line', () => {
    expect(PcmCache.key('a|b', 'c', undefined, 'd')).not.toBe(PcmCache.key('a', 'b|c', undefined, 'd'));
    expect(PcmCache.key('a', 'b', undefined, 'c","d')).not.toBe(PcmCache.key('a', 'b', undefined, 'c')); // a line that looks like the end of a key
  });
});

describe('PcmCache.warm', () => {
  const lines = ['One sec.', 'Still looking.', 'Let me check.', 'Hold on.'].map((text) => ({ text }));
  const keyOf = (text: string): string => PcmCache.key('labgpu', 'af_bella', undefined, text);

  it('makes every line once, one at a time and in order by default', async () => {
    const cache = new PcmCache();
    const made: string[] = [];
    let inFlight = 0;
    let most = 0;
    const synth = async (text: string): Promise<Buffer | null> => {
      made.push(text);
      most = Math.max(most, ++inFlight);
      await tick(2);
      inFlight--;
      return pcm(100, text.length);
    };
    const result = await cache.warm(lines, synth, keyOf);
    expect(result).toEqual({ done: 4, failed: 0 });
    expect(made).toEqual(lines.map((l) => l.text));
    expect(most).toBe(1);
    for (const l of lines) expect(cache.get(keyOf(l.text))?.equals(pcm(100, l.text.length))).toBe(true);
  });

  it('skips a line that is already there, and counts it as done', async () => {
    const cache = new PcmCache();
    cache.put(keyOf('One sec.'), pcm(10, 9));
    const made: string[] = [];
    const result = await cache.warm(lines, async (t) => (made.push(t), pcm(10)), keyOf);
    expect(result).toEqual({ done: 4, failed: 0 });
    expect(made).not.toContain('One sec.');
    expect(cache.get(keyOf('One sec.'))?.equals(pcm(10, 9))).toBe(true); // not overwritten
  });

  it('counts a synth that fails, throws, returns null or returns nothing, and goes on', async () => {
    const cache = new PcmCache();
    const synth = async (text: string): Promise<Buffer | null> => {
      if (text === 'One sec.') throw new Error('down');
      if (text === 'Still looking.') return null;
      if (text === 'Let me check.') return Buffer.alloc(0);
      return pcm(10);
    };
    await expect(cache.warm(lines, synth, keyOf)).resolves.toEqual({ done: 1, failed: 3 });
    expect(cache.has(keyOf('Hold on.'))).toBe(true);
    expect(cache.has(keyOf('One sec.'))).toBe(false);
  });

  it('survives a synth that throws before it returns a promise, and a keyOf that throws', async () => {
    const cache = new PcmCache();
    const sync = ((): Promise<Buffer | null> => {
      throw new Error('sync');
    }) as (text: string) => Promise<Buffer | null>;
    await expect(cache.warm(lines, sync, keyOf)).resolves.toEqual({ done: 0, failed: 4 });
    const badKey = (text: string): string => {
      if (text === 'Hold on.') throw new Error('key');
      return keyOf(text);
    };
    await expect(cache.warm(lines, async () => pcm(10), badKey)).resolves.toEqual({ done: 3, failed: 1 });
  });

  it('makes a line that is listed twice once, however many run at once', async () => {
    for (const concurrency of [1, 3]) {
      const cache = new PcmCache();
      const made: string[] = [];
      const synth = async (t: string): Promise<Buffer | null> => {
        made.push(t);
        await tick(5);
        return pcm(10);
      };
      const result = await cache.warm([{ text: 'Same.' }, { text: 'Same.' }, { text: 'Other.' }, { text: 'Same.' }], synth, keyOf, { concurrency });
      expect(made.filter((t) => t === 'Same.')).toHaveLength(1);
      expect(result).toEqual({ done: 4, failed: 0 });
    }
  });

  it('runs as many at once as it is told', async () => {
    const cache = new PcmCache();
    let inFlight = 0;
    let most = 0;
    const synth = async (): Promise<Buffer | null> => {
      most = Math.max(most, ++inFlight);
      await tick(10);
      inFlight--;
      return pcm(10);
    };
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Line ${i}.` }));
    const result = await cache.warm(many, synth, keyOf, { concurrency: 3 });
    expect(result).toEqual({ done: 9, failed: 0 });
    expect(most).toBe(3);
  });

  it('starts nothing when the signal is already aborted', async () => {
    const cache = new PcmCache();
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    const result = await cache.warm(lines, async () => (calls++, pcm(10)), keyOf, { signal: ctl.signal });
    expect(result).toEqual({ done: 0, failed: 0 });
    expect(calls).toBe(0);
  });

  it('stops at the abort and returns at once, without waiting for a line that never comes back', async () => {
    const cache = new PcmCache();
    const ctl = new AbortController();
    const started: string[] = [];
    const synth = (text: string): Promise<Buffer | null> => {
      started.push(text);
      if (text === 'Still looking.') {
        setTimeout(() => ctl.abort(), 5);
        return new Promise<Buffer | null>(() => undefined); // never settles
      }
      return Promise.resolve(pcm(10));
    };
    const result = await Promise.race([
      cache.warm(lines, synth, keyOf, { signal: ctl.signal }),
      tick(1000).then(() => 'hung' as const),
    ]);
    expect(result).toEqual({ done: 1, failed: 0 });
    expect(started).toEqual(['One sec.', 'Still looking.']);
  });

  it('does not leave a listener on a signal that never aborts', async () => {
    const cache = new PcmCache();
    const ctl = new AbortController();
    let added = 0;
    let removed = 0;
    const add = ctl.signal.addEventListener.bind(ctl.signal);
    const remove = ctl.signal.removeEventListener.bind(ctl.signal);
    ctl.signal.addEventListener = ((...args: Parameters<typeof add>) => (added++, add(...args))) as typeof add;
    ctl.signal.removeEventListener = ((...args: Parameters<typeof remove>) => (removed++, remove(...args))) as typeof remove;
    await cache.warm(lines, async () => pcm(10), keyOf, { signal: ctl.signal });
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it('returns {0, 0} for no lines', async () => {
    await expect(new PcmCache().warm([], async () => pcm(10), keyOf)).resolves.toEqual({ done: 0, failed: 0 });
  });
});
