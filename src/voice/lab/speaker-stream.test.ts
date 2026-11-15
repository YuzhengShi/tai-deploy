import { describe, expect, it } from 'vitest';

import { Speaker, type SpeakerHooks } from './speaker.js';
import { MouthError, OUT_BYTES_PER_MS, type SpeechTurn, type TurnSplit } from './types.js';

/** PCM of `ms` milliseconds. */
const pcm = (ms: number): Buffer => Buffer.alloc(Math.round(ms * OUT_BYTES_PER_MS), 1);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A streaming mouth's speech that the test drives: what it was given, and the audio it makes when told to. */
class FakeTurn implements SpeechTurn {
  readonly spoken: string[] = [];
  ended = false;
  abandoned = false;
  interruptedAt: number | null = null;
  durationMs: number | undefined;
  error: Error | null = null;
  private readonly chunks: Buffer[] = [];
  private done = false;
  private waiter: (() => void) | null = null;

  constructor(private readonly reply: TurnSplit | null = null) {}

  speak(text: string): string {
    this.spoken.push(text);
    return text;
  }

  end(): void {
    this.ended = true;
  }

  push(ms: number): void {
    this.chunks.push(pcm(ms));
    this.waiter?.();
  }

  finish(durationMs?: number): void {
    this.done = true;
    this.durationMs = durationMs;
    this.waiter?.();
  }

  fail(error: Error): void {
    this.error = error;
    this.waiter?.();
  }

  get audio(): AsyncIterable<Buffer> {
    return this.run();
  }

  private async *run(): AsyncGenerator<Buffer> {
    for (;;) {
      const c = this.chunks.shift();
      if (c) {
        yield c;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  async interrupt(playedMs: number): Promise<TurnSplit | null> {
    this.interruptedAt = playedMs;
    this.done = true;
    this.waiter?.();
    return this.reply;
  }

  abandon(): void {
    this.abandoned = true;
  }
}

/** A speaker on a fake clock that makes speeches with the turns it is given, in order (then none). */
function setup(turns: FakeTurn[], over: { canIdle?: () => boolean; failed?: string[]; streamFailed?: Error[] } = {}) {
  const clock = { t: 10_000 };
  const events: string[] = [];
  const asked = { turns: 0, sentences: [] as string[] };
  const hooks: SpeakerHooks = {
    audio: () => undefined,
    sentenceFirstChunk: (at, text) => events.push(`first@${at - 10_000}:${text}`),
    sentenceStart: (text, at) => events.push(`start@${at - 10_000}:${text}`),
    idle: (at) => events.push(`idle@${at - 10_000}`),
    failed: (text) => void (over.failed ?? events).push(`failed:${text}`),
    streamFailed: (err) => void over.streamFailed?.push(err),
    canIdle: over.canIdle,
  };
  const queue = [...turns];
  const speaker = new Speaker({
    clock: () => clock.t,
    synthesize: async function* (text) {
      asked.sentences.push(text);
      yield pcm(500);
    },
    hooks,
    leadMs: 500,
    autoTick: false,
    estimateMsPerChar: 60,
    openTurn: () => {
      const t = queue.shift() ?? null;
      if (t) asked.turns++;
      return t;
    },
  });
  const advance = (ms: number, step = 10): void => {
    for (let i = 0; i < ms / step; i++) {
      clock.t += step;
      speaker.tick();
    }
  };
  return { clock, events, speaker, advance, asked };
}

const S1 = 'Hello there friend.';           // 19 characters
const S2 = 'How are you today.';             // 18 characters
const S3 = 'Fine thanks.';

describe('Speaker with a streaming mouth: one speech for an answer', () => {
  it('gives every sentence of the answer to the same speech as it is said, and ends the speech when the model has finished', async () => {
    const turn = new FakeTurn();
    const s = setup([turn]);
    s.speaker.say(S1, 1);
    s.speaker.say(S2, 2);
    expect(turn.spoken).toEqual([S1, S2]);
    expect(s.asked.turns).toBe(1);
    expect(s.asked.sentences).toEqual([]);                   // nothing was made one by one
    expect(turn.ended).toBe(false);
    s.advance(10);                                           // canIdle is yes: the answer is complete
    expect(turn.ended).toBe(true);
  });

  it('holds the speech open while the model is still writing (canIdle false), and endText ends it', async () => {
    const turn = new FakeTurn();
    let thinking = true;
    const s = setup([turn], { canIdle: () => !thinking });
    s.speaker.say(S1, 1);
    s.advance(100);
    expect(turn.ended).toBe(false);
    s.speaker.say(S2, 2);
    expect(turn.spoken).toEqual([S1, S2]);
    s.speaker.endText();
    expect(turn.ended).toBe(true);
    thinking = false;
  });

  it('the next answer after endText is a new speech', async () => {
    const a = new FakeTurn();
    const b = new FakeTurn();
    const s = setup([a, b], { canIdle: () => false });
    s.speaker.say(S1, 1);
    s.speaker.endText();
    s.speaker.say(S2, 2);
    expect(a.spoken).toEqual([S1]);
    expect(b.spoken).toEqual([S2]);
    expect(s.asked.turns).toBe(2);
  });

  it('a speaker with no streaming mouth for the answer makes its sentences one by one, as before', async () => {
    const s = setup([]);
    s.speaker.say(S1, 1);
    s.speaker.say(S2, 2);
    await settle();
    expect(s.asked.sentences).toEqual([S1, S2]);
  });

  it('announces each sentence (the page\'s transcript line) when the clock reaches its place in the speech: by the estimate first, by the length the service gives once it has', async () => {
    const turn = new FakeTurn();
    const s = setup([turn], { canIdle: () => false });
    s.speaker.say(S1, 1);
    s.speaker.say(S2, 2);
    turn.push(1500);
    turn.push(1500);
    turn.push(900);
    await settle();
    s.advance(10);
    const firsts = s.events.filter((e) => e.startsWith('first'));
    expect(firsts).toHaveLength(1);                                       // the first chunk of the speech is the first sentence's, and only that one
    expect(firsts[0].endsWith(`:${S1}`)).toBe(true);
    turn.finish(3900);                                     // 100 ms a character: the second sentence begins at character 20, so 2000 ms
    await settle();
    s.advance(1900);
    expect(s.events.filter((e) => e.startsWith('start')).map((e) => e.slice(e.indexOf(':') + 1))).toEqual([S1]);
    s.advance(300);
    const starts = s.events.filter((e) => e.startsWith('start'));
    expect(starts.map((e) => e.slice(e.indexOf(':') + 1))).toEqual([S1, S2]);
    const at = Number(starts[1].slice(6, starts[1].indexOf(':')));
    expect(at).toBeGreaterThanOrEqual(2000);
    expect(at).toBeLessThanOrEqual(2100);
  });

  it('reports the speech as over when its audio has played out, after announcing every sentence', async () => {
    const turn = new FakeTurn();
    const s = setup([turn]);
    s.speaker.say(S1, 1);
    s.speaker.say(S2, 2);
    turn.push(2000);
    turn.push(1900);
    turn.finish(3900);
    await settle();
    s.advance(5000);
    const kinds = s.events.map((e) => e.slice(0, e.indexOf('@')));
    expect(kinds).toEqual(['first', 'start', 'start', 'idle']);
    expect(s.speaker.speaking).toBe(false);
  });
});

describe('Speaker with a streaming mouth: the student speaks', () => {
  it('while the service is still making the speech: an estimate at once, the exact words a moment later, and the speech cut with what had played', async () => {
    const turn = new FakeTurn({ spoken: 'Hello there', remaining: 'friend. How are you today.' });
    const s = setup([turn], { canIdle: () => false });
    s.speaker.say(S1, 1);
    s.speaker.say(S2, 2);
    turn.push(2000);
    await settle();
    s.advance(10);
    s.advance(1000);
    const report = s.speaker.stop();
    expect(turn.interruptedAt).not.toBeNull();
    expect(turn.interruptedAt!).toBeGreaterThanOrEqual(900);
    expect(turn.interruptedAt!).toBeLessThanOrEqual(1100);
    expect(report.wasSpeaking).toBe(true);
    expect(report.sentences.map((x) => [x.tag, x.started])).toEqual([[1, true], [2, false]]);
    expect(report.sentences[0].playedFraction).toBeGreaterThan(0.6);                  // about a second of the (19 + 1) x 60 ms the first sentence is estimated to take
    expect(report.sentences[0].playedFraction).toBeLessThan(1);
    const exact = await report.exact!;
    expect(exact).toEqual({ tags: [1, 2], split: { spoken: 'Hello there', remaining: 'friend. How are you today.' } });
  });

  it('a speech the service has already finished making has nothing to ask: only the estimate, and the speech is let go', async () => {
    const turn = new FakeTurn();
    const s = setup([turn], { canIdle: () => false });
    s.speaker.say(S1, 1);
    s.speaker.say(S2, 2);
    turn.push(3900);
    turn.finish(3900);
    await settle();
    s.advance(10);
    s.advance(2500);                                                     // inside the second sentence (it begins at 2000 ms)
    const report = s.speaker.stop();
    expect(report.exact).toBeUndefined();
    expect(turn.interruptedAt).toBeNull();
    expect(turn.abandoned).toBe(true);
    expect(report.sentences.map((x) => [x.tag, x.started])).toEqual([[1, true], [2, true]]);
    expect(report.sentences[0].playedFraction).toBe(1);
    expect(report.sentences[1].playedFraction).toBeGreaterThan(0.2);
    expect(report.sentences[1].playedFraction).toBeLessThan(0.8);
  });

  it('a stop before any audio has played reports nothing as spoken', async () => {
    const turn = new FakeTurn();
    const s = setup([turn], { canIdle: () => false });
    s.speaker.say(S1, 1);
    const report = s.speaker.stop();
    expect(report.sentences).toEqual([]);
    expect(report.wasSpeaking).toBe(false);
    expect(turn.interruptedAt).toBe(0);
  });

  it('the answer after a stop is a speech of its own: nothing is left open', async () => {
    const a = new FakeTurn();
    const b = new FakeTurn();
    const s = setup([a, b], { canIdle: () => false });
    s.speaker.say(S1, 1);
    s.speaker.stop();
    s.speaker.say(S2, 2);
    expect(b.spoken).toEqual([S2]);
  });
});

describe('Speaker with a streaming mouth: when the speech fails', () => {
  it('before any audio: the engine is told, and the answer is made one sentence at a time instead, in order: nothing is lost', async () => {
    const turn = new FakeTurn();
    const failed: string[] = [];
    const streamFailed: Error[] = [];
    const s = setup([turn], { failed, streamFailed, canIdle: () => false });
    s.speaker.say(S1, 1);
    s.speaker.say(S2, 2);
    turn.fail(new MouthError('down', 'gone'));
    await settle();
    s.speaker.say(S3, 3);                                                // said after the failure, before the speaker has looked: the failed speech takes no more text, and this one still comes last
    s.advance(20);
    await settle();
    s.advance(3000);
    expect(streamFailed).toHaveLength(1);
    expect(failed).toEqual([]);
    expect([...s.asked.sentences].sort()).toEqual([S1, S2, S3].sort());
    expect(s.events.filter((e) => e.startsWith('start')).map((e) => e.slice(e.indexOf(':') + 1))).toEqual([S1, S2, S3]);
  });

  it('after a failed speech the next answer is a speech of its own', async () => {
    const a = new FakeTurn();
    const b = new FakeTurn();
    const streamFailed: Error[] = [];
    const s = setup([a, b], { streamFailed, canIdle: () => false });
    s.speaker.say(S1, 1);
    s.speaker.endText();
    a.fail(new MouthError('down', 'gone'));
    await settle();
    s.advance(20);
    await settle();
    s.advance(1500);
    s.speaker.say(S2, 2);                                                // the next answer: a new speech
    expect(b.spoken).toEqual([S2]);
    expect(streamFailed).toHaveLength(1);
  });

  it('after some audio: what came is played, the speech ends there, and the engine is told once', async () => {
    const turn = new FakeTurn();
    const streamFailed: Error[] = [];
    const s = setup([turn], { streamFailed });
    s.speaker.say(S1, 1);
    turn.push(800);
    await settle();
    turn.fail(new MouthError('down', 'gone'));
    await settle();
    s.advance(1500);
    expect(streamFailed).toHaveLength(1);
    expect(s.events.map((e) => e.slice(0, e.indexOf('@')))).toEqual(['first', 'start', 'idle']);
  });
});
