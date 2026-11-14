import { describe, expect, it } from 'vitest';

import { Speaker, spokenTextOf, wordsPlayed, type SpeakerHooks } from './speaker.js';
import { MouthError, OUT_BYTES_PER_MS } from './types.js';

/** PCM of `ms` milliseconds (non-zero samples). */
const pcm = (ms: number): Buffer => Buffer.alloc(Math.round(ms * OUT_BYTES_PER_MS), 1);

/** A speaker on a fake clock: nothing runs unless the test ticks. */
function setup(synth: (text: string, signal: AbortSignal) => AsyncIterable<Buffer>, leadMs = 500, canIdle?: () => boolean) {
  const clock = { t: 10_000 };
  const events: string[] = [];
  const audio: Array<{ at: number; ms: number }> = [];
  const hooks: SpeakerHooks = {
    audio: (chunk, at) => audio.push({ at, ms: chunk.length / OUT_BYTES_PER_MS }),
    sentenceFirstChunk: (at, text) => events.push(`first@${at - 10_000}:${text}`),
    sentenceStart: (text, at) => events.push(`start@${at - 10_000}:${text}`),
    idle: (at) => events.push(`idle@${at - 10_000}`),
    failed: (text) => events.push(`failed:${text}`),
    canIdle,
  };
  const speaker = new Speaker({ clock: () => clock.t, synthesize: synth, hooks, leadMs, autoTick: false });
  const advance = (ms: number, step = 10): void => {
    for (let i = 0; i < ms / step; i++) {
      clock.t += step;
      speaker.tick();
    }
  };
  return { clock, events, audio, speaker, advance };
}

async function* whole(ms: number): AsyncGenerator<Buffer> {
  yield pcm(ms);
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('Speaker', () => {
  it('sends the first half second at once, then at about real time, and says it is idle when the last chunk has played', async () => {
    const s = setup(() => whole(2000));
    s.speaker.say('One two three four five.');
    await settle();
    s.advance(10);
    const sentAtOnce = s.audio.reduce((a, x) => a + x.ms, 0);
    expect(sentAtOnce).toBeGreaterThanOrEqual(500);
    expect(sentAtOnce).toBeLessThanOrEqual(560);
    expect(s.speaker.speaking).toBe(true);
    s.advance(1000);
    const sent1 = s.audio.reduce((a, x) => a + x.ms, 0);
    expect(sent1).toBeGreaterThan(1450);                            // 1.01 s of the clock + the half second of lead
    expect(sent1).toBeLessThanOrEqual(1560);
    s.advance(2000);
    expect(s.audio.reduce((a, x) => a + x.ms, 0)).toBe(2000);
    const idle = s.events.find((e) => e.startsWith('idle'))!;
    const at = Number(idle.slice(5));
    expect(at).toBeGreaterThanOrEqual(2000);                        // played out: 2 s of audio from the start
    expect(at).toBeLessThanOrEqual(2040);
    expect(s.speaker.speaking).toBe(false);
  });

  it('announces a sentence when it begins to play, not when it was sent ahead', async () => {
    const s = setup(() => whole(1500));
    s.speaker.say('First sentence here.');
    s.speaker.say('Second sentence here.');
    await settle();
    s.advance(10);
    s.advance(3200);
    const starts = s.events.filter((e) => e.startsWith('start'));
    expect(starts).toHaveLength(2);
    expect(Number(starts[0].slice(6, starts[0].indexOf(':')))).toBeLessThanOrEqual(30);
    const second = Number(starts[1].slice(6, starts[1].indexOf(':')));
    expect(second).toBeGreaterThanOrEqual(1500);
    expect(second).toBeLessThanOrEqual(1560);
    expect(s.events.filter((e) => e.startsWith('first'))).toHaveLength(2);
  });

  it('the next sentence is made while the current one plays', async () => {
    const started: string[] = [];
    const s = setup(async function* (text) {
      started.push(text);
      yield pcm(800);
    });
    s.speaker.say('First one.');
    s.speaker.say('Second one.');
    await settle();
    expect(started).toEqual(['First one.', 'Second one.']);        // both synthesised at once
  });

  it('holds the audio of a sentence that is still being made, and goes on when it arrives', async () => {
    let release: (() => void) | null = null;
    const s = setup(async function* (text) {
      if (text.startsWith('Slow')) await new Promise<void>((r) => (release = r));
      yield pcm(600);
    });
    s.speaker.say('Slow one here.');
    await settle();
    s.advance(300);
    expect(s.audio).toHaveLength(0);
    expect(s.speaker.speaking).toBe(false);
    release!();
    await settle();
    s.advance(30);
    expect(s.audio.length).toBeGreaterThan(0);
  });

  it('stop drops everything, aborts the synthesis and reports what had played, the playing sentence by fraction', async () => {
    let aborted = false;
    const s = setup(async function* (text, signal) {
      signal.addEventListener('abort', () => (aborted = true));
      yield pcm(text.startsWith('Third') ? 1000 : 1000);
    });
    s.speaker.say('One two three four.');
    s.speaker.say('Five six seven eight.');
    s.speaker.say('Third sentence never played.');
    await settle();
    s.advance(1500);                                                // the first has played out, the second has played 500 ms
    const report = s.speaker.stop();
    expect(report.wasSpeaking).toBe(true);
    expect(report.sentences.filter((x) => x.started).map((x) => x.text)).toEqual(['One two three four.', 'Five six seven eight.']);
    expect(report.sentences[1].playedFraction).toBeGreaterThan(0.4);
    expect(report.sentences[1].playedFraction).toBeLessThan(0.6);
    expect(report.sentences.find((x) => x.text.startsWith('Third'))?.started ?? false).toBe(false);
    expect(aborted).toBe(true);
    expect(s.speaker.speaking).toBe(false);
    const before = s.audio.length;
    s.advance(1000);
    expect(s.audio.length).toBe(before);                            // nothing goes out after a stop
    expect(s.events.some((e) => e.startsWith('idle'))).toBe(false); // and a stop is not an AgentAudioDone
  });

  it('spokenTextOf and wordsPlayed cut at word boundaries', () => {
    expect(wordsPlayed('one two three four', 0.5)).toBe('one two');
    expect(wordsPlayed('one two three four', 0.99)).toBe('one two three four');
    expect(wordsPlayed('one two three four', 0.1)).toBe('');
    expect(
      spokenTextOf({
        wasSpeaking: true,
        sentences: [
          { tag: 1, text: 'Raft elects a leader.', started: true, playedFraction: 1 },
          { tag: 2, text: 'Then the leader sends heartbeats.', started: true, playedFraction: 0.5 },
          { tag: 3, text: 'Never heard.', started: false, playedFraction: 0 },
        ],
      }),
    ).toBe('Raft elects a leader. Then the');
  });

  it('a sentence that could not be made is skipped and reported; the ones after it are spoken', async () => {
    const s = setup(async function* (text) {
      if (text.startsWith('Broken')) throw new MouthError('down', 'refused');
      yield pcm(300);
    });
    s.speaker.say('Broken sentence.');
    s.speaker.say('Good sentence.');
    await settle();
    s.advance(100);
    expect(s.events).toContain('failed:Broken sentence.');
    expect(s.events.some((e) => e.startsWith('first') && e.endsWith('Good sentence.'))).toBe(true);
  });

  it('a sentence made after a pause starts a new speech (idle in between)', async () => {
    const s = setup(() => whole(400));
    s.speaker.say('First.');
    await settle();
    s.advance(900);
    expect(s.events.filter((e) => e.startsWith('idle'))).toHaveLength(1);
    s.speaker.say('Second.');
    await settle();
    s.advance(900);
    expect(s.events.filter((e) => e.startsWith('idle'))).toHaveLength(2);
  });

  it('does not say the speech is over while more of it is on its way, and says so once nothing is', async () => {
    let more = true;
    const s = setup(() => whole(400), 500, () => !more);
    s.speaker.say('First sentence only.');
    await settle();
    s.advance(1500);                                                // long past the end of the audio: the model is still writing
    expect(s.events.some((e) => e.startsWith('idle'))).toBe(false);
    expect(s.speaker.speaking).toBe(true);
    more = false;
    s.advance(30);
    expect(s.events.filter((e) => e.startsWith('idle'))).toHaveLength(1);
    expect(s.speaker.speaking).toBe(false);
  });

  it('a sentence added before the playout ends continues the same speech', async () => {
    const s = setup(() => whole(1000));
    s.speaker.say('First.');
    await settle();
    s.advance(600);
    s.speaker.say('Second.');
    await settle();
    s.advance(3000);
    expect(s.events.filter((e) => e.startsWith('idle'))).toHaveLength(1);
  });
});
