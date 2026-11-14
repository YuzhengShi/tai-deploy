import { describe, expect, it } from 'vitest';

import { TurnTracker, judgeTurnText, type TurnParams, type VadView } from './turn.js';

describe('judgeTurnText', () => {
  it('complete: what students ask, as the adapter writes it', () => {
    for (const t of [
      'Can you explain how Raft elects a new leader when the old one crashes?',
      'I am confused about the difference between Paxos and Raft.',
      'Yes.',
      'Raft.',
      'I do not know.',
      'Okay, that makes sense. Thank you.',
      'What is a partition key?',
      'Can you explain what a mutex is?',
      'I understand that.',
      'If you want, I can show you the code.',
      'Why is my channel blocking?',
    ]) {
      expect(judgeTurnText(t), t).toBe('complete');
    }
  });

  it('incomplete: the adapter punctuates a sentence the student has not finished', () => {
    for (const t of [
      'The thing I do not get about Paxos is.',          // the adapter's own text for a 1.5 s pause
      'If I put the lock around the whole function.',
      'So the leader sends heartbeats to.',
      'I think the problem is that the.',
      'When a node fails, the client should.',
      'My understanding of consistent hashing is that.',
      'Okay so first the container starts, then,',
      'Because the queue can grow without limit.',
      'I am trying to decide between Kafka and',
    ]) {
      expect(judgeTurnText(t), t).toBe('incomplete');
    }
  });

  it('filler and nothing', () => {
    expect(judgeTurnText('')).toBe('empty');
    expect(judgeTurnText('   ')).toBe('empty');
    expect(judgeTurnText('Um.')).toBe('filler');
    expect(judgeTurnText('Uh, um.')).toBe('filler');
    expect(judgeTurnText('Hmm')).toBe('filler');
    expect(judgeTurnText('啊。')).toBe('filler');              // what the adapter wrote for "uh, so"
    expect(judgeTurnText('Ah, so.')).not.toBe('filler');       // "so" is a word: it is a dangling one
  });
});

const params: TurnParams = { completeMs: 0, incompleteMs: 1800, timeoutMs: 5000, coverAfterMs: 350 };

/** A student at the microphone and a recognizer: the tracker is told what each says and asked at every 50 ms. */
class Scene {
  now = 0;
  voiced = false;
  lastVoicedEndAt = 0;
  onsets = 0;
  readonly tracker: TurnTracker;
  constructor(p: TurnParams = params) {
    this.tracker = new TurnTracker(p);
  }
  view(): VadView {
    return { voiced: this.voiced, lastVoicedEndAt: this.lastVoicedEndAt, onsets: this.onsets };
  }
  speak(ms: number): void {
    if (!this.voiced) this.onsets++;
    this.voiced = true;
    this.advance(ms);
    this.lastVoicedEndAt = this.now;
  }
  /** Time passes in silence; returns the first decision, if any, with the time it came. */
  silence(ms: number) {
    this.voiced = false;
    return this.advance(ms);
  }
  private advance(ms: number) {
    for (let i = 0; i < ms / 50; i++) {
      this.now += 50;
      const d = this.tracker.tick(this.now, this.view());
      if (d) return d;
    }
    return null;
  }
  partial(text: string): void {
    this.tracker.onPartial(text, this.now, this.view());
  }
  final(text: string): void {
    this.tracker.onFinal(text, this.now, this.view());
  }
}

describe('TurnTracker, a conversation', () => {
  it('commits the first text that covers the speech, not the adapter\'s final that comes a second later', () => {
    const s = new Scene();
    s.speak(1500);
    s.tracker.tick(s.now, s.view());
    s.partial('Can you explain how Raft elects?');            // a partial that arrived while the student was still speaking: covers nothing
    expect(s.silence(300)).toBeNull();
    expect(s.tracker.isOpen).toBe(true);
    s.silence(100);                                               // 400 ms of quiet: the next round of the recognizer covers the speech
    s.partial('Can you explain how Raft elects a new leader?');
    const d = s.silence(100);
    expect(d).toMatchObject({ kind: 'commit', text: 'Can you explain how Raft elects a new leader?', reason: 'complete' });
    if (d?.kind === 'commit') expect(d.speechEndAt).toBe(s.lastVoicedEndAt);
  });

  it('does not take a partial that arrived too soon after the end of speech for the whole text', () => {
    const s = new Scene();
    s.speak(1000);
    s.silence(100);
    s.partial('What is a mutex');                              // 100 ms after the end: the last words may still be missing
    expect(s.silence(200)).toBeNull();
    s.silence(100);                                               // 400 ms in
    s.partial('What is a mutex?');
    expect(s.silence(50)).toMatchObject({ kind: 'commit', text: 'What is a mutex?' });
  });

  it('holds a text that looks unfinished and merges what the student adds', () => {
    const s = new Scene();
    s.speak(2000);
    s.silence(400);
    s.partial('The thing I do not get about Paxos is.');
    expect(s.silence(1200)).toBeNull();                          // 1.6 s of silence: still held (needs 1.8 s)
    s.final('The thing I do not get about Paxos is.');           // the adapter ended its utterance in the pause
    s.speak(1500);                                                // and the student goes on: a new stretch
    s.silence(400);
    s.partial('Why a proposer needs two phases.');
    const d = s.silence(100);
    expect(d).toMatchObject({ kind: 'commit', text: 'The thing I do not get about Paxos is. Why a proposer needs two phases.' });
  });

  it('commits an unfinished-looking text once the hold is over', () => {
    const s = new Scene();
    s.speak(1500);
    s.silence(400);
    s.partial('I think the problem is that the.');
    expect(s.silence(1300)).toBeNull();                           // 1.7 s: the hold is 1.8 s
    const d = s.silence(300);
    expect(d).toMatchObject({ kind: 'commit', reason: 'incomplete-hold', text: 'I think the problem is that the.' });
  });

  it('cumulative partials replace each other when the adapter did not end its utterance', () => {
    const s = new Scene();
    s.speak(1200);
    s.silence(400);
    s.partial('Um. How do I start the home?');
    s.speak(1000);
    s.silence(400);
    s.partial('Um. How do I start the homework?');
    expect(s.silence(100)).toMatchObject({ kind: 'commit', text: 'Um. How do I start the homework?' });
  });

  it('a filler alone is forgotten and never committed; what follows it is judged by itself', () => {
    const s = new Scene();
    s.speak(500);
    s.silence(400);
    s.partial('Um.');
    s.final('Um.');
    expect(s.silence(2500)).toBeNull();
    s.speak(1500);
    s.silence(400);
    s.partial('How do I start the homework?');
    expect(s.silence(100)).toMatchObject({ kind: 'commit', text: 'How do I start the homework?' });
  });

  it('a lone filler that nobody follows is discarded at the timeout', () => {
    const s = new Scene();
    s.speak(500);
    s.silence(400);
    s.partial('Um.');
    expect(s.silence(5000)).toMatchObject({ kind: 'discard' });
    expect(s.tracker.isOpen).toBe(false);
  });

  it('commits whatever there is at the timeout when nothing ever covered the speech', () => {
    const s = new Scene();
    s.speak(1500);
    s.partial('Can you hear me');                                   // while speaking
    const d = s.silence(5500);
    expect(d).toMatchObject({ kind: 'commit', reason: 'timeout', text: 'Can you hear me' });
  });

  it('drops the adapter\'s late final of a turn already committed, even when the student has begun again', () => {
    const s = new Scene();
    s.speak(1500);
    s.silence(400);
    s.partial('What is a mutex?');
    expect(s.silence(100)).toMatchObject({ kind: 'commit' });
    s.speak(800);                                                  // the student says "wait" at once
    s.final('What is a mutex?');                                   // the adapter's final of the first turn arrives now
    s.silence(400);
    s.partial('Wait.');
    expect(s.silence(100)).toMatchObject({ kind: 'commit', text: 'Wait.' });
  });
});

describe('TurnTracker, the patient modes', () => {
  it('an interview waits 600 ms after a finished-looking text and 3.5 s after an unfinished one', () => {
    const p: TurnParams = { completeMs: 600, incompleteMs: 3500, timeoutMs: 8000, coverAfterMs: 350 };
    const a = new Scene(p);
    a.speak(2000);
    a.silence(400);
    a.partial('The leader replicates the entry to a majority.');
    expect(a.silence(150)).toBeNull();
    expect(a.silence(100)).toMatchObject({ kind: 'commit', reason: 'complete' });
    const b = new Scene(p);
    b.speak(2000);
    b.silence(400);
    b.partial('I would say the leader replicates the log entry to.');
    expect(b.silence(2900)).toBeNull();
    expect(b.silence(300)).toMatchObject({ kind: 'commit', reason: 'incomplete-hold' });
  });

  it('a mid-answer pause of 2.5 s is not the end of an interview turn', () => {
    const p: TurnParams = { completeMs: 600, incompleteMs: 3500, timeoutMs: 8000, coverAfterMs: 350 };
    const s = new Scene(p);
    s.speak(2500);
    s.silence(400);
    s.partial('I would say the leader replicates the log entry to.');
    s.final('I would say the leader replicates the log entry to.');
    expect(s.silence(2100)).toBeNull();                              // 2.5 s in
    s.speak(1500);
    s.silence(400);
    s.partial('a majority of the followers before it commits.');
    expect(s.silence(700)).toMatchObject({ kind: 'commit', text: 'I would say the leader replicates the log entry to. a majority of the followers before it commits.' });
  });
});
