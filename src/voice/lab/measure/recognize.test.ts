/**
 * recognize.ts against loopback fakes and hand-computed cases: no test touches the real network or LabGPU's box. The end-to-end runs use tiny synthetic clips (a 240 ms square wave) and short waits.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { KEYTERMS } from '../../settings.js';
import { DEFAULT_LABGPU_ASR, DEFAULT_FLUX_URL, DEFAULT_NOVA_URL } from '../config.js';
import { FakeAsr, until } from '../testing/fake-asr.js';
import { FakeListen } from '../testing/fake-listen.js';
import { AudioLibrary } from './scenario.js';
import {
  bootstrapMeanInterval,
  comparePaired,
  containsTerm,
  DEFAULT_TIMING,
  distinctTerms,
  editDistance,
  keyFromEnvText,
  LIVE_TURN,
  main,
  MARGIN_TERM_POINTS,
  MARGIN_WER_POINTS,
  pairedRecallInterval,
  parseRecognitionSet,
  parseRecords,
  planRun,
  recognizerConfig,
  renderComparison,
  resolveDeepgramKey,
  scoreUtterance,
  summarizeRecords,
  termMarginMet,
  USAGE,
  utteranceKey,
  werMarginMet,
  wordErrorRate,
  wordsOf,
  type Paired,
  type RecognizeEnv,
  type RecognizeTiming,
  type RecognitionSet,
  type UtteranceRecord,
} from './recognize.js';

// ---------------------------------------------------------------- fixtures

const KEY = 'test-key-0123456789abcdef';
/** A byte order mark (make_audio.ps1 writes its manifest with one) and a typographic apostrophe, by code so that this file stays plain ASCII. */
const BOM = String.fromCharCode(0xfeff);
const RIGHT_QUOTE = String.fromCharCode(0x2019);

/** A 16 kHz mono 16-bit WAV around PCM. */
function wavOf(pcm: Buffer): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(pcm.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + head.length + pcm.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, head, pcm]);
}

const LEAD_SAMPLES = 1000;
const TONE_SAMPLES = 3840;

/** 1000 samples of silence, 240 ms of a square wave, 1000 samples of silence: the engine's own leading and trailing silence, which the runner must trim. */
function tonePcm(): Buffer {
  const pcm = Buffer.alloc((LEAD_SAMPLES + TONE_SAMPLES + 1000) * 2);
  for (let i = 0; i < TONE_SAMPLES; i++) pcm.writeInt16LE(Math.floor(i / 8) % 2 === 0 ? 4000 : -4000, (LEAD_SAMPLES + i) * 2);
  return pcm;
}

const TEST_SET: RecognitionSet = {
  version: 2,
  note: 'test',
  voices: ['Voice A', 'Voice B'],
  recognition: [
    { id: 'q01', text: 'Does Raft need a majority of servers?', terms: ['raft'] },
    { id: 'q02', text: 'How does consistent hashing move the keys?', terms: ['consistent hashing'] },
  ],
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-recognize-'));
const files = {
  set: path.join(root, 'set.json'),
  audio: path.join(root, 'audio'),
  emptyAudio: path.join(root, 'empty-audio'),
  silentAudio: path.join(root, 'silent-audio'),
  envFile: path.join(root, 'env'),
};
let counter = 0;

/** A fresh path for a results file. */
const resultsFile = (): string => path.join(root, `results-${counter++}.jsonl`);

beforeAll(() => {
  fs.writeFileSync(files.set, JSON.stringify(TEST_SET));
  fs.mkdirSync(files.audio);
  const manifest: Record<string, string> = {};
  let n = 0;
  for (const voice of TEST_SET.voices) {
    for (const sentence of TEST_SET.recognition) {
      const name = `c${n++}.wav`;
      fs.writeFileSync(path.join(files.audio, name), wavOf(tonePcm()));
      manifest[`${voice}|${sentence.text}`] = name;
    }
  }
  // make_audio.ps1 writes the manifest with a byte order mark
  fs.writeFileSync(path.join(files.audio, 'manifest.json'), BOM + JSON.stringify(manifest), 'utf8');
  fs.mkdirSync(files.emptyAudio);
  fs.writeFileSync(path.join(files.emptyAudio, 'manifest.json'), '{}');
  fs.mkdirSync(files.silentAudio);
  fs.writeFileSync(path.join(files.silentAudio, 'quiet.wav'), wavOf(Buffer.alloc(8000)));
  const silentManifest: Record<string, string> = {};
  for (const voice of TEST_SET.voices) for (const sentence of TEST_SET.recognition) silentManifest[`${voice}|${sentence.text}`] = 'quiet.wav';
  fs.writeFileSync(path.join(files.silentAudio, 'manifest.json'), JSON.stringify(silentManifest));
  fs.writeFileSync(files.envFile, `# the service's file\nOTHER_SECRET=do-not-print-this\nexport DEEPGRAM_API_KEY="${KEY}"\nANOTHER=value\n`);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startAsr(): Promise<FakeAsr> {
  const fake = await FakeAsr.start();
  cleanups.push(() => fake.close());
  return fake;
}

async function startListen(): Promise<FakeListen> {
  const fake = await FakeListen.start();
  cleanups.push(() => fake.close());
  return fake;
}

function every(ms: number, fn: () => void): void {
  const timer = setInterval(fn, ms);
  cleanups.push(() => clearInterval(timer));
}

/** The waits of a run, short: a stream is a lead of 80 ms, 240 ms of speech with its margins and as long as the recognizer takes. */
const FAST: Partial<RecognizeTiming> = { leadMs: 80, maxWaitMs: 1200, graceMs: 80, connectTimeoutMs: 1500, pauseMs: 30, retryPauseMs: 30 };

interface Cli {
  code: number;
  out: string;
  err: string;
}

async function recognize(argv: string[], over: RecognizeEnv = {}): Promise<Cli> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { timing: FAST, environ: {}, ...over, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** What LabGPU's adapter does for one connection: a partial and an early final while the speech is still going (before 320 ms of stream), the late finals after it, or nothing, or the socket dies. */
type Reply = { partial?: string; early?: string; late?: string[]; gapMs?: number } | 'drop';

/**
 * Answers every connection of the fake the way a recognizer would, keyed to the audio it has received (LabGPU's frames are 20 ms: the speech ends at 320 ms of stream, frame 16): connection i
 * gets replies[i], the last reply serving all later connections.
 */
function labgpuAnswers(asr: FakeAsr, replies: Reply[]): void {
  const done = new Set<string>();
  every(5, () => {
    asr.connections.forEach((conn, i) => {
      const reply = replies[Math.min(i, replies.length - 1)];
      const frames = conn.frameSizes.length;
      if (reply === 'drop') {
        if (frames >= 12 && !done.has(`d${i}`)) {
          done.add(`d${i}`);
          conn.close(1011, 'bye');
        }
        return;
      }
      if (frames >= 12 && !done.has(`e${i}`)) {
        done.add(`e${i}`);
        if (reply.partial) conn.sendPartial(reply.partial);
        if (reply.early) conn.sendFinal(reply.early);
      }
      if (frames >= 30 && !done.has(`f${i}`)) {
        done.add(`f${i}`);
        (reply.late ?? []).forEach((text, k) => {
          // the late finals one after the other, `gapMs` apart (all at once by default)
          const timer = setTimeout(() => conn.sendFinal(text), k * (reply.gapMs ?? 0));
          cleanups.push(() => clearTimeout(timer));
        });
      }
    });
  });
}

const runArgs = (set: string, audio: string, out: string, ears: string, extra: string[] = []): string[] => ['run', '--audio', audio, '--set', set, '--ears', ears, '--out', out, ...extra];

const readJsonl = (file: string): Array<Record<string, unknown>> =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

// ---------------------------------------------------------------- words, WER, terms

describe('words', () => {
  it('are lower case runs of [a-z0-9\'] and nothing else', () => {
    expect(wordsOf("What's the EC2 limit? Raft, Paxos... CAP-theorem!")).toEqual(["what's", 'the', 'ec2', 'limit', 'raft', 'paxos', 'cap', 'theorem']);
    expect(wordsOf('')).toEqual([]);
    expect(wordsOf('?!, ...')).toEqual([]);
    // no clean-up beyond the documented rule: a typographic apostrophe splits a word, exactly as in round 1
    expect(wordsOf(`don${RIGHT_QUOTE}t`)).toEqual(['don', 't']);
  });
});

describe('word error rate', () => {
  it('is the word edit distance over the reference words', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(1);
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(editDistance(['a', 'c'], ['a', 'b', 'c'])).toBe(1);
    expect(editDistance(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'])).toBe(4);
    expect(editDistance([], ['a', 'b'])).toBe(2);
    expect(editDistance(['a', 'b'], [])).toBe(2);
    expect(wordErrorRate('Does Raft need a majority?', 'does raft need a majority')).toBe(0);
    expect(wordErrorRate('does raft need a majority', 'does raft need majority')).toBeCloseTo(0.2, 12);
    expect(wordErrorRate('does raft need a majority', 'does rafts need a majority')).toBeCloseTo(0.2, 12);
  });

  it('is 1 for a recognizer that returns nothing, and can be above 1', () => {
    expect(wordErrorRate('a b c d', '')).toBe(1);
    expect(wordErrorRate('a b', 'a b c d e')).toBe(1.5);
  });

  it('ignores case and punctuation in both texts', () => {
    expect(wordErrorRate('Is gRPC faster than REST?', 'is, grpc FASTER than rest')).toBe(0);
  });

  it('has no value for a reference without words', () => {
    expect(() => wordErrorRate('?!', 'anything')).toThrow(/no words/);
  });
});

describe('strict whole-term match', () => {
  it('needs every word of a term, in order and adjacent', () => {
    expect(containsTerm('we use consistent hashing here', 'consistent hashing')).toBe(true);
    expect(containsTerm('consistent and hashing', 'consistent hashing')).toBe(false);
    expect(containsTerm('hashing consistent', 'consistent hashing')).toBe(false);
    expect(containsTerm('consistent', 'consistent hashing')).toBe(false);
    expect(containsTerm('the cap theorem says', 'cap theorem')).toBe(true);
    expect(containsTerm('a load balancer', 'load balancer')).toBe(true);
    expect(containsTerm('a load balance', 'load balancer')).toBe(false);
  });

  it('is by whole words: a longer word, a plural or a split is not the term', () => {
    expect(containsTerm('goroutines are cheap', 'goroutine')).toBe(false);
    expect(containsTerm('a goroutine is cheap', 'goroutine')).toBe(true);
    expect(containsTerm('wait group', 'waitgroup')).toBe(false);
    expect(containsTerm('e c 2', 'ec2')).toBe(false);
    expect(containsTerm('on EC2.', 'ec2')).toBe(true);
  });

  it('ignores case and punctuation, and a hyphen splits words', () => {
    expect(containsTerm('Consistent-Hashing?', 'consistent hashing')).toBe(true);
    expect(containsTerm('CAP THEOREM.', 'cap theorem')).toBe(true);
    expect(containsTerm('TAi, are you there', 'TAi')).toBe(true);
  });

  it('is never hit by an empty text, and an empty term is never hit', () => {
    expect(containsTerm('', 'raft')).toBe(false);
    expect(containsTerm('raft', '')).toBe(false);
    expect(containsTerm('raft', '?!')).toBe(false);
  });

  it('lists the terms of a sentence once each, in their normalised form', () => {
    expect(distinctTerms({ id: 'x', text: 'a b', terms: ['Consistent  Hashing', 'consistent hashing', 'raft', ''] })).toEqual(['consistent hashing', 'raft']);
  });

  it('scores an utterance: its WER and each term', () => {
    const sentence = { id: 'q', text: 'Does consistent hashing need a ring?', terms: ['consistent hashing', 'ring'] };
    const exact = scoreUtterance(sentence, 'does consistent hashing need a ring');
    expect(exact.wer).toBe(0);
    expect(exact.terms).toEqual([
      { term: 'consistent hashing', hit: true },
      { term: 'ring', hit: true },
    ]);
    const nothing = scoreUtterance(sentence, '');
    expect(nothing.wer).toBe(1);
    expect(nothing.terms.map((t) => t.hit)).toEqual([false, false]);
    const split = scoreUtterance(sentence, 'does consistent and hashing need a wing');
    expect(split.terms.map((t) => t.hit)).toEqual([false, false]);
    expect(split.wer).toBeCloseTo(2 / 6, 12);
  });
});

// ---------------------------------------------------------------- the set and the records

describe('the test set', () => {
  const minimal = { voices: ['V'], recognition: [{ id: 'a', text: 'Does Raft work?', terms: ['raft'] }] };

  it('is read with a byte order mark and checked', () => {
    const set = parseRecognitionSet(BOM + JSON.stringify({ version: 2, note: 'n', ...minimal }));
    expect(set.version).toBe(2);
    expect(set.voices).toEqual(['V']);
    expect(set.recognition[0].terms).toEqual(['raft']);
  });

  it('refuses what it cannot score, with a message that says where', () => {
    const bad = (value: unknown): string => {
      try {
        parseRecognitionSet(typeof value === 'string' ? value : JSON.stringify(value), 'the set');
      } catch (err) {
        return (err as Error).message;
      }
      return 'accepted';
    };
    expect(bad('{nope')).toMatch(/^the set: not JSON/);
    expect(bad([])).toMatch(/not an object/);
    expect(bad({ ...minimal, voices: [] })).toMatch(/voices/);
    expect(bad({ ...minimal, recognition: [] })).toMatch(/recognition/);
    expect(bad({ voices: ['V'], recognition: [{ id: 'a', text: 'x y', terms: [] }, { id: 'a', text: 'x y', terms: [] }] })).toMatch(/the id a is used twice/);
    expect(bad({ voices: ['V'], recognition: [{ id: 'a', text: '?!', terms: [] }] })).toMatch(/no text/);
    expect(bad({ voices: ['V'], recognition: [{ id: 'a', text: 'Does Raft work?', terms: 'raft' }] })).toMatch(/terms/);
    expect(bad({ voices: ['V'], recognition: [{ id: 'a', text: 'Does Raft work?', terms: ['paxos'] }] })).toMatch(/the key term "paxos" is not in the sentence/);
  });
});

function line(id: string, voice: string, extra: Partial<UtteranceRecord> & { text?: string } = {}): string {
  return JSON.stringify({ id, voice, ears: 'labgpu', text: '', finals: [], firstPartialMs: -300, lastFinalMs: 1500, timedOut: false, attempts: 1, ...extra });
}

describe('the results files', () => {
  it('are read line by line, blank lines skipped, and keyed by sentence and voice', () => {
    const text = [line('q01', 'Voice A', { text: 'does raft need a majority of servers' }), '', line('q02', 'Voice B', { text: 'x', lastFinalMs: null })].join('\r\n') + '\r\n';
    const records = parseRecords(text, TEST_SET, 'r.jsonl');
    expect(records.size).toBe(2);
    expect(records.get(utteranceKey('q01', 'Voice A'))?.text).toBe('does raft need a majority of servers');
    expect(records.get(utteranceKey('q02', 'Voice B'))?.lastFinalMs).toBeNull();
    expect(records.get(utteranceKey('q01', 'Voice A'))?.error).toBeUndefined();
  });

  it('keep the error of a failed utterance, which needs no text', () => {
    const records = parseRecords(JSON.stringify({ id: 'q01', voice: 'Voice A', error: 'labgpu: connection refused', attempts: 2 }), TEST_SET, 'r.jsonl');
    expect(records.get(utteranceKey('q01', 'Voice A'))).toMatchObject({ error: 'labgpu: connection refused', text: '', attempts: 2, lastFinalMs: null });
  });

  it('are refused when a line is not a record of the set', () => {
    const bad = (text: string): string => {
      try {
        parseRecords(text, TEST_SET, 'r.jsonl');
      } catch (err) {
        return (err as Error).message;
      }
      return 'accepted';
    };
    expect(bad('nope')).toBe('r.jsonl, line 1: not JSON');
    expect(bad(line('q99', 'Voice A', { text: 'x' }))).toMatch(/line 1: the id "q99" is not in the set/);
    expect(bad(line('q01', 'Voice Z', { text: 'x' }))).toMatch(/the voice "Voice Z" is not in the set/);
    expect(bad(`${line('q01', 'Voice A', { text: 'x' })}\n${line('q01', 'Voice A', { text: 'y' })}`)).toMatch(/line 2: a second record for q01 with Voice A/);
    expect(bad(JSON.stringify({ id: 'q01', voice: 'Voice A' }))).toMatch(/no text and no error/);
  });
});

// ---------------------------------------------------------------- numbers of one recognizer

describe('summarizeRecords', () => {
  it('counts what was scored, leaves error records out and says so, and takes the delay of finals after the end of speech only', () => {
    const records = parseRecords(
      [
        line('q01', 'Voice A', { text: 'does raft need a majority of servers', lastFinalMs: 1400 }),
        line('q01', 'Voice B', { text: 'does rafts need a majority of servers', lastFinalMs: 1600 }),
        line('q02', 'Voice A', { text: 'how does consistent hashing move the keys', lastFinalMs: -50 }),
        JSON.stringify({ id: 'q02', voice: 'Voice B', error: 'labgpu: the socket closed', attempts: 2 }),
      ].join('\n'),
      TEST_SET,
      'a',
    );
    const s = summarizeRecords(TEST_SET, records);
    expect(s).toMatchObject({ expected: 4, records: 4, missing: 0, errors: 1, scored: 3, termHits: 2, termInstances: 3, noFinal: 1, ears: 'labgpu' });
    expect(s.meanWer).toBeCloseTo((0 + 1 / 7 + 0) / 3, 12);
    expect(s.delaysMs).toEqual([1400, 1600]);
  });

  it('counts the utterances that have no record, and an empty file has no numbers', () => {
    const s = summarizeRecords(TEST_SET, new Map());
    expect(s).toMatchObject({ expected: 4, records: 0, missing: 4, errors: 0, scored: 0, meanWer: null, termHits: 0, termInstances: 0 });
  });

  it('scores a recognizer that returned nothing as a total miss, not as an error', () => {
    const records = parseRecords(line('q01', 'Voice A', { text: '', lastFinalMs: null, timedOut: true }), TEST_SET, 'a');
    const s = summarizeRecords(TEST_SET, records);
    expect(s).toMatchObject({ errors: 0, scored: 1, termHits: 0, termInstances: 1, noFinal: 1 });
    expect(s.meanWer).toBe(1);
  });
});

// ---------------------------------------------------------------- the paired comparison

describe('pairedRecallInterval', () => {
  // Calculated apart from this code, in Python from the formulas in the comment above the function (Wilson intervals, phi with the n/2 term).
  const near = (actual: number | undefined, expected: number) => expect(actual).toBeCloseTo(expected, 5);

  it('hand case: 80 both, 10 only A, 5 only B, 5 neither (n 100): A 90 %, B 85 %', () => {
    // Wilson 90/100: 0.825634 to 0.944771; Wilson 85/100: 0.767164 to 0.906940; A*d - B*c = 400 - 50 = 350 > 50, so C = 300 and phi = 300 / sqrt(90*10*85*15) = 0.280056;
    // lower = 0.05 - sqrt(0.074366^2 - 2*0.280056*0.074366*0.056940 + 0.056940^2) = -0.030004; upper = 0.05 + sqrt(0.044771^2 - 2*0.280056*0.044771*0.082836 + 0.082836^2) = 0.132395
    const r = pairedRecallInterval({ both: 80, onlyA: 10, onlyB: 5, neither: 5 });
    near(r?.diff, 0.05);
    near(r?.lo, -0.030004);
    near(r?.hi, 0.132395);
  });

  it('swapping A and B negates the difference and mirrors the interval (A minus B)', () => {
    const r = pairedRecallInterval({ both: 80, onlyA: 5, onlyB: 10, neither: 5 });
    near(r?.diff, -0.05);
    near(r?.lo, -0.132395);
    near(r?.hi, 0.030004);
  });

  it('is symmetric about zero for a symmetric table', () => {
    const r = pairedRecallInterval({ both: 40, onlyA: 10, onlyB: 10, neither: 40 });
    near(r?.diff, 0);
    near(r?.lo, -0.08814);
    near(r?.hi, 0.08814);
  });

  it('does not collapse to a point when the two always agree (the continuity term)', () => {
    const r = pairedRecallInterval({ both: 50, onlyA: 0, onlyB: 0, neither: 50 });
    near(r?.diff, 0);
    near(r?.lo, -0.019234);
    near(r?.hi, 0.019234);
  });

  it('uses the Wilson interval alone when a marginal is empty or full (phi is 0)', () => {
    const all = pairedRecallInterval({ both: 30, onlyA: 0, onlyB: 0, neither: 0 });
    near(all?.diff, 0);
    near(all?.lo, -0.113513);
    near(all?.hi, 0.113513);
    const bOnly = pairedRecallInterval({ both: 0, onlyA: 0, onlyB: 12, neither: 8 });
    near(bOnly?.diff, -0.6);
    near(bOnly?.lo, -0.781193);
    near(bOnly?.hi, -0.332589);
  });

  it('puts the interval above zero when A is clearly better', () => {
    const r = pairedRecallInterval({ both: 60, onlyA: 20, onlyB: 0, neither: 20 });
    near(r?.diff, 0.2);
    near(r?.lo, 0.118435);
    near(r?.hi, 0.27987);
  });

  it('has no interval for an empty table', () => {
    expect(pairedRecallInterval({ both: 0, onlyA: 0, onlyB: 0, neither: 0 })).toBeNull();
  });
});

describe('bootstrapMeanInterval', () => {
  it('is the mean with a percentile interval, and for two values 0 and 1 the interval is exactly 0 to 1', () => {
    // resamples of two values have the mean 0, 0.5 or 1 with probabilities 1/4, 1/2, 1/4: the 2.5th and 97.5th percentiles are the ends
    expect(bootstrapMeanInterval([0, 1])).toEqual({ diff: 0.5, lo: 0, hi: 1 });
  });

  it('collapses for equal values and is repeatable for the same data', () => {
    expect(bootstrapMeanInterval([0.25, 0.25, 0.25])).toEqual({ diff: 0.25, lo: 0.25, hi: 0.25 });
    const data = [0.1, -0.2, 0.05, 0.3, 0, -0.1, 0.2];
    expect(bootstrapMeanInterval(data)).toEqual(bootstrapMeanInterval(data));
    const r = bootstrapMeanInterval(data);
    expect(r && r.lo <= r.diff && r.diff <= r.hi).toBe(true);
  });

  it('has nothing for no values', () => {
    expect(bootstrapMeanInterval([])).toBeNull();
  });
});

const recordsOf = (lines: string[]): Map<string, UtteranceRecord> => parseRecords(lines.join('\n'), TEST_SET, 'x');

describe('comparePaired', () => {
  const a = recordsOf([
    line('q01', 'Voice A', { text: 'does raft need a majority of servers' }),
    line('q01', 'Voice B', { text: 'does rafts need a majority of servers' }),
    line('q02', 'Voice A', { text: 'how does consistent hashing move the keys' }),
    JSON.stringify({ id: 'q02', voice: 'Voice B', error: 'labgpu: connection refused', attempts: 2 }),
  ]);
  const b = recordsOf([
    line('q01', 'Voice A', { ears: 'flux', text: 'Does Raft need a majority of servers?' }),
    line('q01', 'Voice B', { ears: 'flux', text: 'does raft need a majority of servers' }),
    line('q02', 'Voice A', { ears: 'flux', text: 'how does consistent hashing move keys' }),
    line('q02', 'Voice B', { ears: 'flux', text: 'how does consistent hashing move the keys' }),
  ]);

  it('pairs the utterances scored in both files, and leaves an error record out of both', () => {
    const p = comparePaired(TEST_SET, a, b);
    expect(p).toMatchObject({ utterances: 3, left: 1, instances: 3, hitsA: 2, hitsB: 3, table: { both: 2, onlyA: 0, onlyB: 1, neither: 0 } });
    expect(p.werA).toBeCloseTo(1 / 21, 12);
    expect(p.werB).toBeCloseTo(1 / 21, 12);
    expect(p.recall?.diff).toBeCloseTo(-1 / 3, 12);
    expect(p.wer?.diff).toBeCloseTo(0, 12);
  });

  it('pairs nothing when a file is empty', () => {
    const p = comparePaired(TEST_SET, a, new Map());
    expect(p).toMatchObject({ utterances: 0, left: 4, instances: 0, recall: null, wer: null, werA: null });
    expect(termMarginMet(p)).toBeNull();
    expect(werMarginMet(p)).toBeNull();
  });
});

describe('the pre-registered margins', () => {
  const paired = (hitsA: number, hitsB: number, werA: number, werB: number): Paired => ({
    utterances: 50,
    left: 0,
    instances: 100,
    hitsA,
    hitsB,
    table: { both: Math.min(hitsA, hitsB), onlyA: Math.max(0, hitsA - hitsB), onlyB: Math.max(0, hitsB - hitsA), neither: 0 },
    recall: null,
    werA,
    werB,
    wer: null,
  });

  it('are 5 points of recall and 2 points of WER', () => {
    expect(MARGIN_TERM_POINTS).toBe(5);
    expect(MARGIN_WER_POINTS).toBe(2);
  });

  it('recall: A at exactly 5 points below B is within, 5.01 is not (exact arithmetic)', () => {
    expect(termMarginMet(paired(85, 90, 0, 0))).toBe(true);
    expect(termMarginMet(paired(84, 90, 0, 0))).toBe(false);
    expect(termMarginMet(paired(95, 90, 0, 0))).toBe(true);
    expect(termMarginMet(paired(60, 100, 0, 0))).toBe(false);
  });

  it('WER: A at exactly 2 points above B is within, a little more is not', () => {
    expect(werMarginMet(paired(1, 1, 0.07, 0.05))).toBe(true);
    expect(werMarginMet(paired(1, 1, 0.0701, 0.05))).toBe(false);
    expect(werMarginMet(paired(1, 1, 0.04, 0.05))).toBe(true);
    // a tie at the margin must not depend on floating point noise (0.12 - 0.1 is 0.01999999999999999)
    expect(werMarginMet(paired(1, 1, 0.12, 0.1))).toBe(true);
  });
});

describe('compare', () => {
  it('prints each file, the paired numbers, the margins and the two sentences', async () => {
    const fileA = resultsFile();
    const fileB = resultsFile();
    fs.writeFileSync(
      fileA,
      [
        line('q01', 'Voice A', { text: 'does raft need a majority of servers', lastFinalMs: 1400 }),
        line('q01', 'Voice B', { text: 'does rafts need a majority of servers', lastFinalMs: 1600 }),
        line('q02', 'Voice A', { text: 'how does consistent hashing move the keys', lastFinalMs: 1500 }),
        JSON.stringify({ id: 'q02', voice: 'Voice B', ears: 'labgpu', error: 'labgpu: connection refused', attempts: 2 }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      fileB,
      [
        line('q01', 'Voice A', { ears: 'flux', text: 'Does Raft need a majority of servers?', lastFinalMs: 900 }),
        line('q01', 'Voice B', { ears: 'flux', text: 'does raft need a majority of servers', lastFinalMs: 1000 }),
        line('q02', 'Voice A', { ears: 'flux', text: 'how does consistent hashing move keys', lastFinalMs: 1100 }),
        line('q02', 'Voice B', { ears: 'flux', text: 'how does consistent hashing move the keys', lastFinalMs: 950 }),
      ].join('\n') + '\n',
    );
    const r = await recognize(['compare', '--a', fileA, '--b', fileB, '--set', files.set]);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const lines = r.out.split('\n');
    expect(lines[0]).toBe('recognition set: 2 sentences x 2 voices = 4 utterances, 2 key-term instances per voice pass (4 in all)');
    expect(r.out).toContain(`A: ${fileA} (labgpu)`);
    expect(r.out).toContain(`B: ${fileB} (flux)`);
    expect(r.out).toContain('3 of 4 utterances scored, 1 error record, 0 with no record');
    expect(r.out).toContain('4 of 4 utterances scored, 0 error records, 0 with no record');
    expect(r.out).toContain('key terms 2 / 3 (66.7 %)');
    expect(r.out).toContain('key terms 4 / 4 (100.0 %)');
    expect(r.out).toContain('final after the end of speech: p50 1500 ms, p90 1500 ms (3 utterances; 0 scored with none after the end of speech)');
    expect(r.out).toContain('paired: 3 utterances scored in both files (1 left out), 3 key-term instances');
    expect(r.out).toContain('key terms: both 2, only A 0, only B 1, neither 0');
    expect(r.out).toContain('A 2 / 3 = 66.7 %, B 3 / 3 = 100.0 %; A minus B -33.3 points, 95 % interval');
    expect(r.out).toContain('WER: A 4.76 %, B 4.76 %; A minus B +0.00 points');
    expect(r.out).toContain('MARGIN_TERM_POINTS = 5');
    expect(r.out).toContain('MARGIN_WER_POINTS = 2');
    expect(r.out).toContain("term recall of A is not worse than B's by more than 5 points: false");
    expect(r.out).toContain("WER of A is not worse than B's by more than 2 points: true");
    expect(r.out).toMatch(/the 95 % interval of the recall difference \(-[\d.]+ to \+[\d.]+ points\) does not exclude -5: not shown at this n/);
  });

  it('says non-inferiority is shown only when the whole interval is above -5, and says so when it is below', () => {
    const many = (n: number): RecognitionSet => ({
      version: 2,
      note: '',
      voices: ['V'],
      recognition: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, text: 'does raft work', terms: ['raft'] })),
    });
    const make = (set: RecognitionSet, hit: (i: number) => boolean): Map<string, UtteranceRecord> =>
      parseRecords(set.recognition.map((s, i) => JSON.stringify({ id: s.id, voice: 'V', ears: 'x', text: hit(i) ? 'does raft work' : 'does draft work', lastFinalMs: 1000 })).join('\n'), set, 'x');
    const set = many(400);
    const same = renderComparison({ set, fileA: 'a', fileB: 'b', a: make(set, () => true), b: make(set, () => true) });
    expect(same).toMatch(/excludes -5: non-inferiority shown/);
    const worse = renderComparison({ set, fileA: 'a', fileB: 'b', a: make(set, (i) => i < 100), b: make(set, () => true) });
    expect(worse).toMatch(/lies below -5: not shown at this n/);
    expect(worse).toContain("term recall of A is not worse than B's by more than 5 points: false");
  });

  it('says there is nothing to compare when no utterance was scored in both files', async () => {
    const fileA = resultsFile();
    const fileB = resultsFile();
    fs.writeFileSync(fileA, line('q01', 'Voice A', { text: 'x' }) + '\n');
    fs.writeFileSync(fileB, line('q02', 'Voice B', { text: 'x' }) + '\n');
    const r = await recognize(['compare', '--a', fileA, '--b', fileB, '--set', files.set]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('paired: no utterance was scored in both files, nothing to compare');
    expect(r.out).toContain("term recall of A is not worse than B's by more than 5 points: not computable");
  });

  it('is a usage error for a file that is not a record file of the set', async () => {
    const bad = resultsFile();
    fs.writeFileSync(bad, 'nope\n');
    const r = await recognize(['compare', '--a', bad, '--b', bad, '--set', files.set]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('line 1: not JSON');
    const missing = await recognize(['compare', '--a', path.join(root, 'nothing.jsonl'), '--b', bad, '--set', files.set]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/cannot read the results .*nothing\.jsonl \(ENOENT\)/);
  });
});

// ---------------------------------------------------------------- the key

describe('the Deepgram key', () => {
  it('is the last DEEPGRAM_API_KEY line of an env file, whatever else the file holds', () => {
    expect(keyFromEnvText('A=1\nDEEPGRAM_API_KEY=abc123\nB=2')).toBe('abc123');
    expect(keyFromEnvText('export DEEPGRAM_API_KEY = "quoted value"')).toBe('quoted value');
    expect(keyFromEnvText("DEEPGRAM_API_KEY='single'")).toBe('single');
    expect(keyFromEnvText('DEEPGRAM_API_KEY=plain # a comment')).toBe('plain');
    expect(keyFromEnvText('# DEEPGRAM_API_KEY=commented\nX=1')).toBeNull();
    expect(keyFromEnvText('DEEPGRAM_API_KEY=first\r\nDEEPGRAM_API_KEY=second\r\n')).toBe('second');
    expect(keyFromEnvText('DEEPGRAM_API_KEY=first\nDEEPGRAM_API_KEY=')).toBeNull();
    expect(keyFromEnvText('NOT_DEEPGRAM_API_KEY=x\nDEEPGRAM_API_KEY_2=y\nDEEPGRAM_API_KEYS=z')).toBeNull();
    expect(keyFromEnvText('')).toBeNull();
  });

  it('comes from --env-file first, then from the environment', () => {
    expect(resolveDeepgramKey({ envFile: files.envFile, environ: { DEEPGRAM_API_KEY: 'from-environment' } })).toBe(KEY);
    const without = path.join(root, 'env-without');
    fs.writeFileSync(without, 'OTHER=1\n');
    expect(resolveDeepgramKey({ envFile: without, environ: { DEEPGRAM_API_KEY: ' from-environment ' } })).toBe('from-environment');
    expect(resolveDeepgramKey({ environ: { DEEPGRAM_API_KEY: 'from-environment' } })).toBe('from-environment');
    expect(resolveDeepgramKey({ envFile: without, environ: {} })).toBeNull();
    expect(resolveDeepgramKey({ environ: { DEEPGRAM_API_KEY: '  ' } })).toBeNull();
  });

  it('is missing, and a file that cannot be read is named, without its content in the message', () => {
    expect(() => resolveDeepgramKey({ envFile: path.join(root, 'no-such-env'), environ: {} })).toThrow(/cannot read the env file .*no-such-env \(ENOENT\)/);
  });
});

describe('recognizerConfig', () => {
  it("has LabGPU's, Flux's and nova-3's own addresses by default, and replaces only the one asked for", () => {
    expect(DEFAULT_LABGPU_ASR).toBe('ws://192.0.2.29:8803/v1/listen?encoding=linear16&sample_rate=16000&language=en&label=tai-lab');
    expect(recognizerConfig('labgpu').earsUrl).toBe(DEFAULT_LABGPU_ASR);
    expect(recognizerConfig('flux').fluxUrl).toBe(DEFAULT_FLUX_URL);
    expect(recognizerConfig('nova').novaUrl).toBe(DEFAULT_NOVA_URL);
    const over = recognizerConfig('labgpu', 'ws://127.0.0.1:1/x');
    expect(over.earsUrl).toBe('ws://127.0.0.1:1/x');
    expect(over.fluxUrl).toBe(DEFAULT_FLUX_URL);
    expect(recognizerConfig('flux', 'ws://127.0.0.1:2/y').fluxUrl).toBe('ws://127.0.0.1:2/y');
    expect(recognizerConfig('nova', 'ws://127.0.0.1:3/z').novaUrl).toBe('ws://127.0.0.1:3/z');
  });

  it("uses the live conversation's end-of-turn fields", () => {
    expect(LIVE_TURN).toEqual({ eotThreshold: 0.75, eotTimeoutMs: 5000 });
    expect(DEFAULT_TIMING).toMatchObject({ leadMs: 600, maxWaitMs: 6000 });
  });
});

// ---------------------------------------------------------------- the audio of a stream

describe('planRun', () => {
  it('builds the stream: the lead, the clip cut to its speech plus a 40 ms margin, whole 40 ms frames', () => {
    const plans = planRun(TEST_SET, new AudioLibrary(files.audio), { ...DEFAULT_TIMING, leadMs: 80 });
    expect(plans.map((p) => `${p.id}|${p.voice}`)).toEqual(['q01|Voice A', 'q01|Voice B', 'q02|Voice A', 'q02|Voice B']);
    const plan = plans[0];
    // 80 ms of lead (1280 samples) + 5120 samples of clip (640 before the speech, 3840 of it, 640 after) = 6400 samples = 10 frames
    expect(plan.frames).toHaveLength(10);
    expect(plan.frames.every((f) => f.length === 1280)).toBe(true);
    // the speech begins at sample 1920 (frame 3) and its last sample, 5759, is in frame 8
    const loud = plan.frames.map((f) => f.some((byte) => byte !== 0));
    expect(loud.indexOf(true)).toBe(3);
    expect(plan.lastSpeechFrame).toBe(8);
    expect(loud.lastIndexOf(true)).toBe(8);
    expect(loud[9]).toBe(false);
  });

  it('puts 600 ms of silence in front by default', () => {
    const plan = planRun(TEST_SET, new AudioLibrary(files.audio), DEFAULT_TIMING, 1)[0];
    expect(plan.frames.map((f) => f.some((byte) => byte !== 0)).indexOf(true)).toBe(16);
    // the clip's 3840 samples of speech are six frames: 16 to 21
    expect(plan.lastSpeechFrame).toBe(21);
  });

  it('takes the first N utterances, sentence-major', () => {
    expect(planRun(TEST_SET, new AudioLibrary(files.audio), DEFAULT_TIMING, 3).map((p) => `${p.id}|${p.voice}`)).toEqual(['q01|Voice A', 'q01|Voice B', 'q02|Voice A']);
  });

  it('throws before any stream for a missing clip or a clip with no speech', () => {
    expect(() => planRun(TEST_SET, new AudioLibrary(files.emptyAudio), DEFAULT_TIMING)).toThrow(/no audio for/);
    expect(() => planRun(TEST_SET, new AudioLibrary(files.silentAudio), DEFAULT_TIMING)).toThrow(/has no speech above the threshold/);
  });
});

// ---------------------------------------------------------------- run, end to end, against loopback fakes

describe('run: LabGPU', () => {
  it('streams three utterances one at a time, in real time, from trimmed clips, and writes one record each', async () => {
    const asr = await startAsr();
    labgpuAnswers(asr, [
      { partial: 'does raft', late: ['Does Raft need a majority of servers?'] },
      { partial: 'does raft', late: ['does raft need majority of servers'] },
      { partial: 'how does', late: ['how does consistent hashing move the keys'] },
    ]);
    let open = 0;
    let mostOpen = 0;
    every(2, () => {
      open = asr.connections.filter((c) => !c.closed).length;
      mostOpen = Math.max(mostOpen, open);
    });
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url, '--limit', '3']));
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    const rows = readJsonl(file);
    expect(rows.map((x) => `${String(x.id)}|${String(x.voice)}`)).toEqual(['q01|Voice A', 'q01|Voice B', 'q02|Voice A']);
    expect(rows.map((x) => x.text)).toEqual(['Does Raft need a majority of servers?', 'does raft need majority of servers', 'how does consistent hashing move the keys']);
    for (const row of rows) {
      expect(row).toMatchObject({ ears: 'labgpu', attempts: 1, timedOut: false });
      expect(row.finals).toEqual([row.text]);
      expect(row.error).toBeUndefined();
      // the partial came while the speech was going (about 80 ms before its end) and the final about 280 ms after it: only what a busy machine cannot change is asserted
      expect(typeof row.firstPartialMs).toBe('number');
      expect(row.lastFinalMs as number).toBeGreaterThan(0);
      expect(row.lastFinalMs as number).toBeLessThan(3000);
      expect(row.firstPartialMs as number).toBeLessThan(row.lastFinalMs as number);
    }
    // the stdout: progress lines, the end line, the summary
    expect(r.out).toContain(`results in ${file}`);
    expect(r.out).toContain('3 utterances to run');
    expect(r.out).toMatch(/\[1\/3\] q01 Voice A: first partial -?\d+ ms, last final \d+ ms/);
    expect(r.out).toContain('[3/3] q02 Voice A');
    expect(r.out).toContain('done: 3 utterances, 0 error records');
    expect(r.out).toContain('mean WER 4.76 %');
    expect(r.out).toMatch(/final after the end of speech: p50 \d+ ms, p90 \d+ ms \(3 utterances; 0 scored with none after the end of speech\)/);
    // the host is named, the address with its query is not
    expect(r.out).toContain(`recognize: labgpu at 127.0.0.1:${asr.port}, 2 sentences x 2 voices, 3 utterances to run`);
    expect(r.out).not.toContain('language=en');
    // one connection each, one at a time, none left open, no credentials to LabGPU
    await until(() => asr.connections.every((c) => c.closed), 2000, 'every connection closed');
    expect(asr.connections).toHaveLength(3);
    expect(mostOpen).toBe(1);
    for (const conn of asr.connections) {
      expect(conn.url.pathname).toBe('/v1/listen');
      expect(conn.url.searchParams.get('language')).toBe('en');
      expect(conn.headers.authorization).toBeUndefined();
      // the recognizer's frames: 20 ms each, the first loud one is where the lead (80 ms) and the 40 ms margin put it, not where the clip's own silence would
      expect(conn.frameSizes.every((n) => n === 640)).toBe(true);
      const loud = conn.frames.map((f) => f.some((byte) => byte !== 0));
      expect(loud.indexOf(true)).toBe(6);
      // real time: not a burst; 40 ms of audio per 40 ms (the span of the frames is at least what the number of frames says, less a margin)
      const span = conn.frameTimes[conn.frameTimes.length - 1] - conn.frameTimes[0];
      expect(span).toBeGreaterThan(0.8 * ((conn.frameSizes.length / 2 - 1) * 40));
    }
  }, 20_000);

  it('joins every final of an utterance, one that came before the end of speech included', async () => {
    const asr = await startAsr();
    labgpuAnswers(asr, [{ partial: 'does', early: 'Does Raft', late: ['need a majority', 'of servers'] }]);
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url, '--limit', '1']));
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row.finals).toEqual(['Does Raft', 'need a majority', 'of servers']);
    expect(row.text).toBe('Does Raft need a majority of servers');
    expect(row.timedOut).toBe(false);
    expect(row.lastFinalMs as number).toBeGreaterThan(0);
  }, 20_000);

  it('keeps listening while the recognizer is still sending finals, until it has been quiet for the grace', async () => {
    const asr = await startAsr();
    labgpuAnswers(asr, [{ partial: 'does', late: ['Does Raft need', 'a majority of servers'], gapMs: 200 }]);
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url, '--limit', '1']), { timing: { ...FAST, graceMs: 600 } });
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row.finals).toEqual(['Does Raft need', 'a majority of servers']);
    expect(row.text).toBe('Does Raft need a majority of servers');
    // the first of them is about 280 ms after the end of speech, the second 200 ms later (inside the 600 ms of quiet): the record's last final is the second
    expect(row.lastFinalMs as number).toBeGreaterThan(400);
  }, 20_000);

  it('records a recognizer that sends nothing as an empty text that timed out, not as an error', async () => {
    const asr = await startAsr();
    labgpuAnswers(asr, [{}]);
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url, '--limit', '1']), { timing: { ...FAST, maxWaitMs: 400 } });
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row).toMatchObject({ text: '', finals: [], firstPartialMs: null, lastFinalMs: null, timedOut: true, attempts: 1 });
    expect(row.error).toBeUndefined();
    expect(r.out).toContain('no final (first partial n/a)');
    expect(r.out).toContain('done: 1 utterances, 0 error records');
  }, 20_000);

  it('tries a refused stream once more and records the second attempt', async () => {
    const asr = await startAsr();
    let upgrades = 0;
    Object.defineProperty(asr.handshake, 'refuseUpgrade', { get: () => (upgrades++ === 0 ? 503 : false), configurable: true });
    labgpuAnswers(asr, [{ late: ['Does Raft need a majority of servers?'] }]);
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url, '--limit', '1']));
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row).toMatchObject({ attempts: 2, text: 'Does Raft need a majority of servers?' });
    expect(row.error).toBeUndefined();
    expect(upgrades).toBe(2);
  }, 20_000);

  it('tries a stream whose socket dies before a final once more', async () => {
    const asr = await startAsr();
    labgpuAnswers(asr, ['drop', { late: ['does raft need a majority of servers'] }]);
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url, '--limit', '1']));
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row).toMatchObject({ attempts: 2, text: 'does raft need a majority of servers' });
    expect(asr.connections).toHaveLength(2);
  }, 20_000);

  it('records an error after two failed attempts and goes on with the next utterance', async () => {
    const asr = await startAsr();
    asr.handshake.refuseUpgrade = 503;
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url, '--limit', '2']));
    expect(r.code).toBe(0);
    const rows = readJsonl(file);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ attempts: 2, text: '', finals: [], lastFinalMs: null });
      expect(row.error).toBe('labgpu: the server refused the handshake (HTTP 503)');
    }
    expect(r.out).toContain('[1/2] q01 Voice A: ERROR after 2 attempts: labgpu: the server refused the handshake (HTTP 503)');
    expect(r.out).toContain('[2/2] q01 Voice B: ERROR after 2 attempts');
    expect(r.out).toContain('done: 2 utterances, 2 error records');
    expect(r.out).toContain('0 of 4 utterances scored, 2 error records, 2 with no record');
    // the records read back as errors that compare leaves out
    const records = parseRecords(fs.readFileSync(file, 'utf8'), TEST_SET, file);
    expect(summarizeRecords(TEST_SET, records)).toMatchObject({ errors: 2, scored: 0 });
  }, 30_000);
});

describe('run: Deepgram', () => {
  it('opens Flux with the live key terms and end-of-turn fields, takes the key from --env-file, and never shows it', async () => {
    const listen = await startListen();
    const file = resultsFile();
    const sent = new Set<string>();
    every(5, () => {
      for (const [i, conn] of listen.connections.entries()) {
        const frames = conn.frameSizes.length;
        if (frames >= 2 && !sent.has(`w${i}`)) {
          sent.add(`w${i}`);
          // a server that echoes the credential it was given: it must not get through
          conn.sendWarning('W1', `rejected token ${KEY}`);
        }
        if (frames >= 3 && !sent.has(`s${i}`)) {
          sent.add(`s${i}`);
          conn.sendTurnInfo('StartOfTurn', { transcript: 'does' });
        }
        if (frames >= 8 && !sent.has(`e${i}`)) {
          sent.add(`e${i}`);
          conn.sendTurnInfo('EndOfTurn', { transcript: 'Does Raft need a majority of servers?', confidence: 0.91, trigger: 'model' });
        }
      }
    });
    const r = await recognize(runArgs(files.set, files.audio, file, 'flux', ['--url', listen.v2Url, '--env-file', files.envFile, '--limit', '1']));
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row).toMatchObject({ ears: 'flux', text: 'Does Raft need a majority of servers?', attempts: 1, timedOut: false });
    expect(row.lastFinalMs as number).toBeGreaterThan(0);
    const conn = listen.connections[0];
    expect(conn.path).toBe('/v2/listen');
    const query = new URLSearchParams(conn.rawQuery);
    expect(query.getAll('keyterm')).toEqual(KEYTERMS);
    expect(query.get('model')).toBe('flux-general-en');
    expect(query.get('eot_threshold')).toBe('0.75');
    expect(query.get('eot_timeout_ms')).toBe('5000');
    expect(query.get('eager_eot_threshold')).toBeNull();
    expect(conn.authorization).toBe(`Token ${KEY}`);
    // 80 ms frames: what Deepgram wants
    expect(conn.frameSizes.every((n) => n === 2560)).toBe(true);
    // the key is in no address, no line of output, no record; nor is anything else the env file holds
    const everything = [r.out, r.err, fs.readFileSync(file, 'utf8'), conn.rawQuery].join('\n');
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('do-not-print-this');
    expect(r.err).toContain('Flux warning');
  }, 20_000);

  it('opens nova-3 with the same key terms, short endpointing and the key in a header only, and joins its segments', async () => {
    const listen = await startListen();
    const file = resultsFile();
    const sent = new Set<number>();
    every(5, () => {
      for (const [i, conn] of listen.connections.entries()) {
        const frames = conn.frameSizes.length;
        if (frames >= 3 && !sent.has(i * 2)) {
          sent.add(i * 2);
          conn.sendInterim('does raft');
        }
        if (frames >= 8 && !sent.has(i * 2 + 1)) {
          sent.add(i * 2 + 1);
          conn.sendSegment('does raft need');
          conn.sendSpeechFinal('a majority of servers');
        }
      }
    });
    const r = await recognize(runArgs(files.set, files.audio, file, 'nova', ['--url', listen.v1Url(), '--limit', '1']), { environ: { DEEPGRAM_API_KEY: KEY } });
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row).toMatchObject({ ears: 'nova', text: 'does raft need a majority of servers', attempts: 1 });
    const conn = listen.connections[0];
    expect(conn.path).toBe('/v1/listen');
    const query = new URLSearchParams(conn.rawQuery);
    expect(query.get('model')).toBe('nova-3');
    expect(query.get('endpointing')).toBe('300');
    expect(query.getAll('keyterm')).toEqual(KEYTERMS);
    expect(conn.authorization).toBe(`Token ${KEY}`);
    expect([r.out, r.err, fs.readFileSync(file, 'utf8'), conn.rawQuery].join('\n')).not.toContain(KEY);
  }, 20_000);

  it('stops with a clear message that does not hold the key when flux or nova has no key, before any connection or file', async () => {
    const listen = await startListen();
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'flux', ['--url', listen.v2Url]));
    expect(r.code).toBe(2);
    expect(r.err).toContain('flux needs a Deepgram key: set DEEPGRAM_API_KEY in the environment, or pass --env-file');
    expect(listen.connections).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
    const nova = await recognize(runArgs(files.set, files.audio, file, 'nova', ['--url', listen.v1Url()]));
    expect(nova.code).toBe(2);
    expect(nova.err).toContain('nova needs a Deepgram key');
  });

  it('records a refused key as an error without the key in it', async () => {
    const listen = await startListen();
    listen.handshake.refuseUpgrade = 401;
    const file = resultsFile();
    const r = await recognize(runArgs(files.set, files.audio, file, 'flux', ['--url', listen.v2Url, '--limit', '1']), { environ: { DEEPGRAM_API_KEY: KEY } });
    expect(r.code).toBe(0);
    const [row] = readJsonl(file);
    expect(row.error).toBe('flux: the server refused the handshake (HTTP 401)');
    expect([r.out, r.err, fs.readFileSync(file, 'utf8')].join('\n')).not.toContain(KEY);
  }, 20_000);
});

describe('run: what is refused before the first stream', () => {
  it('never overwrites a results file', async () => {
    const asr = await startAsr();
    const file = resultsFile();
    fs.writeFileSync(file, 'earlier results\n');
    const r = await recognize(runArgs(files.set, files.audio, file, 'labgpu', ['--url', asr.url]));
    expect(r.code).toBe(2);
    expect(r.err).toContain('already exists: results are never overwritten');
    expect(fs.readFileSync(file, 'utf8')).toBe('earlier results\n');
    expect(asr.connections).toHaveLength(0);
  });

  it('is a usage error when a clip is missing or silent, and leaves no results file behind', async () => {
    const file = resultsFile();
    const missing = await recognize(runArgs(files.set, files.emptyAudio, file, 'labgpu'));
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('no audio for');
    const silent = await recognize(runArgs(files.set, files.silentAudio, file, 'labgpu'));
    expect(silent.code).toBe(2);
    expect(silent.err).toContain('has no speech above the threshold');
    expect(fs.existsSync(file)).toBe(false);
    const noManifest = await recognize(runArgs(files.set, path.join(root, 'nowhere'), file, 'labgpu'));
    expect(noManifest.code).toBe(2);
    expect(noManifest.err).toContain('has no manifest.json');
  });

  it('has a usage text, and exit code 2 for every misuse', async () => {
    const none = await recognize([]);
    expect(none.code).toBe(2);
    expect(none.err).toBe(USAGE);
    const help = await recognize(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toBe(USAGE);
    expect(USAGE).toContain('--ears labgpu|flux|nova');
    const cases: Array<[string[], RegExp]> = [
      [['bogus'], /unknown command bogus/],
      [['run', '--ears', 'labgpu', '--bogus', 'x'], /unknown option --bogus for run/],
      [['run', '--ears'], /--ears needs a value/],
      [['run', 'stray'], /unexpected argument stray/],
      [['run', '--set', files.set, '--audio', files.audio], /--ears is required/],
      [['run', '--set', files.set, '--audio', files.audio, '--ears', 'whisper'], /--ears must be labgpu, flux or nova/],
      [['run', '--ears', 'labgpu', '--audio', files.audio], /--set is required/],
      [['run', '--ears', 'labgpu', '--set', path.join(root, 'none.json'), '--audio', files.audio], /cannot read the test set/],
      [['run', '--ears', 'labgpu', '--set', files.set, '--audio', files.audio, '--url', 'not a url'], /--url is not a URL/],
      [['run', '--ears', 'labgpu', '--set', files.set, '--audio', files.audio, '--url', 'http://127.0.0.1:1/x'], /--url must be a ws:\/\/ or wss:\/\/ address/],
      [['run', '--ears', 'labgpu', '--set', files.set, '--audio', files.audio, '--limit', '0'], /--limit must be a whole number of at least 1/],
      [['run', '--ears', 'labgpu', '--set', files.set, '--audio', files.audio, '--limit', 'two'], /--limit must be a whole number/],
      [['run', '--ears', 'flux', '--set', files.set, '--audio', files.audio, '--env-file', path.join(root, 'none-env')], /cannot read the env file/],
      [['compare', '--a', 'x'], /--b is required/],
      [['compare', '--a', 'x', '--b', 'y'], /--set is required/],
    ];
    for (const [argv, expected] of cases) {
      const r = await recognize(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err, argv.join(' ')).toMatch(expected);
    }
  });
});

// ---------------------------------------------------------------- the shipped test set

describe('eval/voice-lab/recognition2.json', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../eval/voice-lab');
  const set = parseRecognitionSet(fs.readFileSync(path.join(dir, 'recognition2.json'), 'utf8'), 'recognition2.json');
  const first = (JSON.parse(fs.readFileSync(path.join(dir, 'testset.json'), 'utf8')) as { recognition: Array<{ id: string; text: string }> }).recognition;
  const live = KEYTERMS.map((k) => k.toLowerCase());

  it('is the second set: 64 sentences of 8 to 25 words, two voices, unique ids and texts', () => {
    expect(set.version).toBe(2);
    expect(set.voices).toEqual(['Microsoft David Desktop', 'Microsoft Zira Desktop']);
    expect(set.recognition).toHaveLength(64);
    expect(new Set(set.recognition.map((s) => s.id)).size).toBe(64);
    expect(new Set(set.recognition.map((s) => s.text)).size).toBe(64);
    for (const s of set.recognition) {
      const words = s.text.trim().split(/\s+/).length;
      expect(words, s.id).toBeGreaterThanOrEqual(8);
      expect(words, s.id).toBeLessThanOrEqual(25);
      // plain written English: letters, spaces, commas and sentence ends; the only digit is the one in EC2; no apostrophe (a possessive would never match its term)
      expect(s.text.replace(/EC2/g, 'ECx'), s.id).toMatch(/^[A-Z][A-Za-z ,]*[.?]$/);
    }
  });

  it('lists only live key terms, each as the sentence has it, and every key term that occurs is listed', () => {
    for (const s of set.recognition) {
      const have = wordsOf(s.text);
      for (const term of s.terms) {
        expect(live, `${s.id} ${term}`).toContain(term);
        expect(term, s.id).toBe(term.toLowerCase());
        expect(containsTerm(have, term), `${s.id} ${term}`).toBe(true);
      }
      for (const k of live) if (containsTerm(have, k)) expect(s.terms, `${s.id} has ${k}`).toContain(k);
      expect(new Set(s.terms).size, s.id).toBe(s.terms.length);
      expect(s.terms.length, s.id).toBeGreaterThanOrEqual(1);
      expect(s.terms.length, s.id).toBeLessThanOrEqual(4);
    }
  });

  it('has every live key term in 5 to 14 sentences, and about two key terms a sentence', () => {
    const counts = new Map(live.map((k) => [k, 0]));
    for (const s of set.recognition) for (const t of distinctTerms(s)) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [term, n] of counts) {
      expect(n, term).toBeGreaterThanOrEqual(5);
      expect(n, term).toBeLessThanOrEqual(14);
    }
    const instances = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(instances / 64).toBeGreaterThanOrEqual(1.9);
    expect(instances / 64).toBeLessThanOrEqual(2.4);
  });

  it('repeats and paraphrases no sentence of the first set', () => {
    const jaccard = (a: string, b: string): number => {
      const x = new Set(wordsOf(a));
      const y = new Set(wordsOf(b));
      let both = 0;
      for (const w of x) if (y.has(w)) both++;
      return both / (x.size + y.size - both);
    };
    for (const s of set.recognition) {
      for (const old of first) {
        expect(s.text, `${s.id} repeats ${old.id}`).not.toBe(old.text);
        expect(jaccard(s.text, old.text), `${s.id} is close to ${old.id}`).toBeLessThan(0.5);
      }
    }
  });
});
