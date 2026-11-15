import { describe, expect, it } from 'vitest';

import { TurnTracker, judgeTurnText, wordKey, type TurnParams, type VadView } from './turn.js';

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

  it('complete: a short yes or no answer may end on an auxiliary or "not" (the owner\'s first call was held 1.8 s on "No, it\'s not.")', () => {
    for (const t of ['No, it\'s not.', 'Yes, it is.', 'Yes, I can.', 'No, it does not.', 'Yeah, it was.', 'Nope, it is not.', 'Sure, I would.', 'Yes, it should be.', 'No it is not']) {
      expect(judgeTurnText(t), t).toBe('complete');
    }
  });

  it('complete: "I think so." and its kind (the second tuning call held it 1.8 s)', () => {
    for (const t of ['I think so.', 'I don\'t think so.', 'I guess so.', 'I hope not.', 'I believe so', 'I suppose so.', 'I do not think so.']) {
      expect(judgeTurnText(t), t).toBe('complete');
    }
  });

  it('complete: a clause that ends on the preposition of its own what, who or which, with a full stop (the owner\'s call of 2026-11-15 held two such turns 1.8 s: 3.0 and 3.4 s to the first sound)', () => {
    for (const t of [
      'what things people will pay for.',
      'No, no, no, no, no, no, no, no, it\'s not what people would pay for.',
      'Who are you talking to.',
      'Which port does it listen on.',
      'What is this used for.',
      'I do not know what it is based on.',
      'Who did you give it to!',
      'What are you looking at.',
    ]) {
      expect(judgeTurnText(t), t).toBe('complete');
    }
  });

  it('still incomplete: a preposition at the end without a full stop, without a what, who or which, or one that takes two things', () => {
    for (const t of [
      'what things people will pay for',                         // no full stop: a partial that may go on
      'What does the leader send to',
      'How does the leader send heartbeats to.',                 // "how" is not the object of "to": the followers are still to come
      'I want to talk about.',
      'So the leader sends heartbeats to.',
      'What is the difference between.',
      'What are the trade-offs of.',
      'What do you want to do with,',
    ]) {
      expect(judgeTurnText(t), t).toBe('incomplete');
    }
  });

  it('still incomplete: a question mark after a preposition is judged by the question rule, as before', () => {
    expect(judgeTurnText('What is this used for?')).toBe('complete');          // four words or more: finished
    expect(judgeTurnText('What for?')).toBe('incomplete');                      // too short to tell from "what for, in the loop"
  });

  it('still incomplete: the same endings without a yes or no, a long sentence, a conjunction, or a trailing comma', () => {
    for (const t of ['A mutex is.', 'It is not.', 'The leader is.', 'Paxos is.', 'Yes, because', 'Yes, and', 'No, it is not,', 'Yes, I think that when a node fails and the client can.', 'I think it is not.', 'Ah, so.', 'So.', 'It is so.', 'I think so,']) {
      expect(judgeTurnText(t), t).toBe('incomplete');
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

describe('wordKey: the same words, as two recognizers may write them', () => {
  it('ignores case, punctuation and the spaces between words, so that a term in two pieces is the same term', () => {
    expect(wordKey('What is a mutex?')).toBe(wordKey('what is a MUTEX'));
    expect(wordKey('How does MapReduce handle failures?')).toBe(wordKey('How does map reduce handle failures.'));
    expect(wordKey('Add to the WaitGroup first.')).toBe(wordKey('Add to the wait group first'));
    expect(wordKey('Is DynamoDB consistent?')).toBe(wordKey('Is dynamo DB consistent?'));
    expect(wordKey("It's fine.")).toBe(wordKey("it's fine"));
  });

  it('keeps different words different: a changed letter, a missing word, a number spelled out', () => {
    expect(wordKey('What is a mutex?')).not.toBe(wordKey('What is a mutual?'));
    expect(wordKey('What is a mutex?')).not.toBe(wordKey('What is mutex?'));
    expect(wordKey('Start the EC2 server')).not.toBe(wordKey('Start the ec two server'));
    expect(wordKey('')).toBe('');
    expect(wordKey('Um.')).toBe('um');
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
