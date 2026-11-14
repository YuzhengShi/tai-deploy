import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AudioLibrary,
  buildBargeIn,
  buildScenario,
  FROZEN_TESTSET,
  fingerprintOf,
  isLabSet,
  LAB_SETS,
  LEAD_SILENCE_MS,
  loadTestSet,
  modeForSet,
  planSet,
  scenariosFor,
  voiceFor,
  type ScenarioSpec,
  type TestSet,
} from './scenario.js';
import { FROZEN_SHA256 } from './analyze.js';
import { frameOfSample, sampleCount, silence } from './wav.js';

/** A 16 kHz mono PCM16 WAV file's bytes (with a LIST chunk to skip, as real ones have). */
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
  const list = Buffer.from('LIST\u0004\u0000\u0000\u0000INFO', 'latin1');
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(pcm.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + list.length + head.length + pcm.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, list, head, pcm]);
}

/** silence, then a run of speech at amplitude 4000, then silence (sample counts) */
function clip(before: number, speech: number, after: number): Buffer {
  const buf = Buffer.alloc((before + speech + after) * 2);
  for (let i = 0; i < speech; i++) buf.writeInt16LE(Math.floor(i / 8) % 2 === 0 ? 4000 : -4000, (before + i) * 2);
  return buf;
}

const VOICES = ['Voice A', 'Voice B'];
const pause = (id: string, cls: 'pause' | 'filler', a: string, b: string, ms: number): ScenarioSpec => ({ id, class: cls, segments: [{ text: a, pauseAfterMs: ms }, { text: b }] });

const MINI: TestSet = {
  version: 1,
  voices: VOICES,
  recognition: [],
  latency: [
    { id: 'l01', text: 'hello there' },
    { id: 'l02', text: 'what is raft' },
    { id: 'l03', text: 'third prompt' },
  ],
  turntaking: {
    tuning: [pause('t-p1', 'pause', 'seg one', 'seg two', 500), { id: 't-s1', class: 'short', segments: [{ text: 'yes' }] }],
    eval: [pause('e-p01', 'pause', 'seg one', 'seg two', 500), { id: 'e-s01', class: 'short', segments: [{ text: 'yes' }] }, pause('e-f01', 'filler', 'um', 'seg two', 300)],
  },
  bargein: { ask: 'tell me everything', afterFirstAudioMs: 500, tuning: ['wait stop'], eval: ['hold on', 'excuse me'] },
  modes: { interview: { eval: [pause('i-p1', 'pause', 'seg one', 'seg two', 700)] }, talk: { eval: [pause('k-p1', 'pause', 'seg one', 'seg two', 900)] } },
};
/** round 2's shape: the same, with a `tools` list */
const TOOLS: TestSet = { ...MINI, tools: [{ id: 'x01', text: 'search it' }, { id: 'x02', text: 'run it' }] };

/** What each text is as audio: [samples of silence before, of speech, of silence after]; the same for both voices. */
const SHAPES: Record<string, [number, number, number]> = {
  'hello there': [3000, 4480, 2000],
  'what is raft': [100, 3200, 50],
  'third prompt': [0, 2560, 0],
  'seg one': [2000, 5120, 4000],
  'seg two': [1500, 3840, 1000],
  yes: [5000, 1920, 3000], // 3 whole frames of speech: with the lead and margin it ends exactly on a frame boundary of the stream
  um: [800, 1280, 800],
  'tell me everything': [2000, 6400, 2000],
  'hold on': [1000, 1920, 1000],
  'excuse me': [1000, 2560, 500],
  'wait stop': [700, 1600, 700],
  'search it': [500, 3200, 400],
  'run it': [500, 2560, 400],
};

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-lab-measure-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** An audio directory the way make_audio.ps1 leaves it: one WAV per (voice, text) and a manifest written with a UTF-8 BOM. */
function audioDir(): string {
  const dir = tmp();
  const manifest: Record<string, string> = {};
  let n = 0;
  for (const voice of VOICES) {
    for (const [text, [before, speech, after]] of Object.entries(SHAPES)) {
      const name = `clip${n++}.wav`;
      fs.writeFileSync(path.join(dir, name), wavOf(clip(before, speech, after)));
      manifest[`${voice}|${text}`] = name;
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), '﻿' + JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

describe('AudioLibrary', () => {
  it('reads a manifest with a BOM and gives the PCM of a clip', () => {
    const lib = new AudioLibrary(audioDir());
    expect(lib.has('Voice A', 'yes')).toBe(true);
    expect(lib.has('Voice A', 'nothing')).toBe(false);
    const pcm = lib.clip('Voice A', 'yes');
    expect(sampleCount(pcm)).toBe(5000 + 1920 + 3000);
    expect(lib.clip('Voice A', 'yes')).toBe(pcm); // cached
  });

  it('says how to make the audio when the directory, the manifest or a clip is missing', () => {
    expect(() => new AudioLibrary(path.join(tmp(), 'nope'))).toThrow(/make_audio\.ps1/);
    const lib = new AudioLibrary(audioDir());
    expect(() => lib.clip('Voice A', 'a text that was never spoken')).toThrow(/no audio for "Voice A\|a text that was never spoken".*make_audio\.ps1/);
  });

  it('refuses a clip that is not 16 kHz mono PCM16 (the smoke client\'s parser says how to convert it)', () => {
    const dir = tmp();
    const bad = wavOf(Buffer.alloc(100));
    bad.writeUInt32LE(44100, 24); // the sample rate field of the fmt chunk
    fs.writeFileSync(path.join(dir, 'bad.wav'), bad);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ 'Voice A|x': 'bad.wav' }));
    expect(() => new AudioLibrary(dir).clip('Voice A', 'x')).toThrow(/16 kHz mono/);
  });
});

describe('buildScenario', () => {
  const lib = () => new AudioLibrary(audioDir());

  it('is the lead silence, then the clip trimmed to its speech plus 40 ms each side, with the speech marked sample-exact', () => {
    const built = buildScenario(MINI.latency.map((l) => ({ id: l.id, class: 'latency' as const, segments: [{ text: l.text }] }))[0], 'Voice A', lib());
    const leadSamples = (LEAD_SILENCE_MS * 16000) / 1000;
    expect(leadSamples).toBe(9600);
    expect(sampleCount(built.pcm)).toBe(leadSamples + 640 + 4480 + 640);
    expect(built.speech).toHaveLength(1);
    const [m] = built.speech;
    expect(m.text).toBe('hello there');
    expect(m.beginSample).toBe(leadSamples + 640);
    expect(m.endSample).toBe(leadSamples + 640 + 4480);
    expect(m.beginMs).toBe(m.beginSample / 16);
    expect(m.endMs).toBe(m.endSample / 16);
    expect(m.endMs).toBe(10240 / 16 + 4480 / 16); // 640 ms + 280 ms
    // the lead is digital silence and the speech is where it says
    expect(built.pcm.subarray(0, leadSamples * 2).every((b) => b === 0)).toBe(true);
    expect(built.pcm.readInt16LE((m.beginSample - 1) * 2)).toBe(0);
    expect(Math.abs(built.pcm.readInt16LE(m.beginSample * 2))).toBe(4000);
    expect(Math.abs(built.pcm.readInt16LE((m.endSample - 1) * 2))).toBe(4000);
    expect(built.pcm.readInt16LE(m.endSample * 2)).toBe(0);
  });

  it('puts the pause back as digital silence between the segments and marks both', () => {
    const spec = MINI.turntaking.eval[0];
    const built = buildScenario(spec, 'Voice B', lib());
    const [one, two] = built.speech;
    expect(one.text).toBe('seg one');
    expect(two.text).toBe('seg two');
    // segment one: lead, 640 margin, 5120 speech, 640 margin; then 500 ms = 8000 samples of silence; then segment two's own margin
    expect(one.beginSample).toBe(9600 + 640);
    expect(one.endSample).toBe(9600 + 640 + 5120);
    const gapStart = one.endSample;
    expect(two.beginSample - gapStart).toBe(640 + 8000 + 640); // margin after one + the pause + margin before two
    expect(built.pcm.subarray((gapStart + 640) * 2, (gapStart + 640 + 8000) * 2).every((b) => b === 0)).toBe(true);
    expect(two.endSample - two.beginSample).toBe(3840);
    expect(sampleCount(built.pcm)).toBe(two.endSample + 640);
    expect(built.speech[built.speech.length - 1].endMs).toBe(two.endSample / 16); // the scenario's UE
  });

  it('knows UE to the sample, also when speech ends exactly on a frame boundary of the stream', () => {
    const built = buildScenario(MINI.turntaking.eval[1], 'Voice A', lib()); // "yes": 1920 samples of speech after 600 ms and a 640-sample margin
    const [m] = built.speech;
    expect(m.beginSample).toBe(10240); // 16 frames of 640
    expect(m.endSample).toBe(12160); // 19 frames: the last speech sample is the LAST sample of frame 18
    expect(m.endSample % 640).toBe(0);
    // the frame that carries the last speech sample is floor((endSample - 1) / 640) = 18, not floor(endSample / 640) = 19
    expect(frameOfSample(m.endSample - 1, 640)).toBe(18);
    expect(frameOfSample(m.endSample, 640)).toBe(19);
    expect(m.endMs).toBe(760);
  });

  it('is exact where the margin is clamped at the edge of a clip (no margin to keep)', () => {
    const lib2 = lib();
    const none = buildScenario({ id: 'x', class: 'latency', segments: [{ text: 'third prompt' }] }, 'Voice A', lib2); // speech from the first to the last sample of the clip
    expect(none.speech[0].beginSample).toBe(9600); // no 640 added: the clip has no silence before its speech
    expect(none.speech[0].endSample).toBe(9600 + 2560);
    expect(sampleCount(none.pcm)).toBe(9600 + 2560); // nor after
    const tight = buildScenario({ id: 'y', class: 'latency', segments: [{ text: 'what is raft' }] }, 'Voice A', lib2); // 100 samples before, 50 after
    expect(tight.speech[0].beginSample).toBe(9600 + 100);
    expect(tight.speech[0].endSample).toBe(9600 + 100 + 3200);
    expect(sampleCount(tight.pcm)).toBe(9600 + 100 + 3200 + 50);
  });

  it('takes a shorter lead when asked (tests only; the document says 600 ms)', () => {
    const built = buildScenario(MINI.turntaking.eval[1], 'Voice A', lib(), 100);
    expect(built.speech[0].beginSample).toBe(1600 + 640);
  });

  it('refuses a clip with no speech', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mute.wav'), wavOf(silence(300)));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ 'Voice A|mute': 'mute.wav' }));
    expect(() => buildScenario({ id: 'm', class: 'latency', segments: [{ text: 'mute' }] }, 'Voice A', new AudioLibrary(dir))).toThrow(/no speech/);
  });
});

describe('the test set', () => {
  const real = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../eval/voice-lab/testset.json');

  it('is the frozen one: the fingerprints of docs 9.7 (blob and sha256 of the LF file)', () => {
    const { fingerprint } = loadTestSet(real);
    expect(fingerprint.sha256).toBe(FROZEN_TESTSET.sha256);
    expect(fingerprint.blob).toBe(FROZEN_TESTSET.blob);
  });

  it('is pinned in one place: the analysis and the CLI know the same frozen fingerprint', () => {
    expect(FROZEN_SHA256).toBe(FROZEN_TESTSET.sha256);
  });

  it('has the groups of scenarios the document counts, in the file\'s own order', () => {
    const { testset } = loadTestSet(real);
    const count = (set: (typeof LAB_SETS)[number]) => scenariosFor(testset, set).length;
    expect(count('latency')).toBe(10);
    expect(count('pause')).toBe(10);
    expect(count('short')).toBe(10);
    expect(count('filler')).toBe(10);
    expect(count('bargein')).toBe(8);
    expect(count('interview')).toBe(5);
    expect(count('talk')).toBe(3);
    expect(count('tuning')).toBe(12); // 10 turn-taking + 2 barge-in
    expect(scenariosFor(testset, 'pause').map((s) => s.id)).toEqual(['e-p01', 'e-p02', 'e-p03', 'e-p04', 'e-p05', 'e-p06', 'e-p07', 'e-p08', 'e-p09', 'e-p10']);
    const bargeIn = scenariosFor(testset, 'bargein');
    expect(bargeIn.every((s) => s.class === 'bargein' && s.segments.length === 1 && s.segments[0].text === testset.bargein.ask && !!s.interruption)).toBe(true);
    expect(bargeIn[0].interruption).toBe('Sorry, hold on a second.');
    expect(testset.bargein.afterFirstAudioMs).toBe(2000);
    // the evaluation sets never contain a tuning scenario (`tools` is round 2's set: this file, round 1's, has none, see the tests of its own below)
    const tuningIds = new Set(scenariosFor(testset, 'tuning').map((s) => s.id));
    for (const set of LAB_SETS.filter((s) => s !== 'tuning' && s !== 'tools')) for (const s of scenariosFor(testset, set)) expect(tuningIds.has(s.id)).toBe(false);
    expect(() => scenariosFor(testset, 'tools')).toThrow(/asked for the set tools, but this test set has no `tools` prompts/);
  });

  it('keeps the frozen fingerprint of round 1 as the document gives it (round 2\'s test set is another file with another one)', () => {
    expect(FROZEN_TESTSET).toEqual({ sha256: '89b4b8d2a10568988e21841fa8d15f118914ece03e73e0f13aff141d1edf7612', blob: '5066b76d5863429013bebd953f4305b5771f834b' });
  });

  it('loads round 2\'s file, which is not the frozen one, and holds the eight `tools` prompts x01 to x08 as scenarios of class `tool`', () => {
    const real2 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../eval/voice-lab/testset2.json');
    const { testset, fingerprint } = loadTestSet(real2);
    expect(fingerprint.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint.blob).toMatch(/^[0-9a-f]{40}$/);
    expect(fingerprint.sha256).not.toBe(FROZEN_TESTSET.sha256);
    expect(fingerprint.blob).not.toBe(FROZEN_TESTSET.blob);
    const tools = scenariosFor(testset, 'tools');
    expect(tools.map((s) => s.id)).toEqual(['x01', 'x02', 'x03', 'x04', 'x05', 'x06', 'x07', 'x08']);
    expect(tools.every((s) => s.class === 'tool' && s.segments.length === 1 && s.segments[0].text.length > 0 && s.segments[0].pauseAfterMs === undefined && s.interruption === undefined)).toBe(true);
    expect(modeForSet('tools')).toBe('chat');
    // every set can be asked of it, and no scenario of an evaluation set is a tuning one
    for (const set of LAB_SETS) expect(scenariosFor(testset, set).length).toBeGreaterThan(0);
    const tuningIds = new Set(scenariosFor(testset, 'tuning').map((s) => s.id));
    for (const set of LAB_SETS.filter((s) => s !== 'tuning')) for (const s of scenariosFor(testset, set)) expect(tuningIds.has(s.id)).toBe(false);
  });

  it('reads a `tools` list when the file has one, loads a file that has none, and refuses a list that is not one of { id, text }', () => {
    const dir = tmp();
    const file = path.join(dir, 'ts.json');
    const write = (extra: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ ...MINI, ...extra }));
    fs.writeFileSync(file, JSON.stringify(MINI));
    expect(loadTestSet(file).testset.tools).toBeUndefined(); // round 1's shape still loads
    write({ tools: [{ id: 'x01', text: 'search it' }] });
    expect(loadTestSet(file).testset.tools).toEqual([{ id: 'x01', text: 'search it' }]);
    write({ tools: [] });
    expect(loadTestSet(file).testset.tools).toEqual([]); // a list, if an empty one: asking for the set is what fails (below)
    for (const notAList of ['search it', {}, null, 7]) {
      write({ tools: notAList });
      expect(() => loadTestSet(file), JSON.stringify(notAList)).toThrow(/test set: tools is not a list of \{ id, text \}/);
    }
    for (const badEntry of [null, 'text only', 4, {}, { id: 'x01' }, { text: 'a' }, { id: 3, text: 'a' }, { id: 'x01', text: 4 }, { id: '', text: 'a' }, { id: 'x01', text: '' }]) {
      write({ tools: [{ id: 'x00', text: 'fine' }, badEntry] });
      expect(() => loadTestSet(file), JSON.stringify(badEntry)).toThrow(/test set: tools has an entry without an id or a text/);
    }
  });

  it('is read with a BOM, and refused with a plain reason when it is broken', () => {
    const dir = tmp();
    const file = path.join(dir, 'ts.json');
    fs.writeFileSync(file, '﻿' + JSON.stringify(MINI), 'utf8');
    expect(loadTestSet(file).testset.latency).toHaveLength(3);
    fs.writeFileSync(file, '{"voices": []}');
    expect(() => loadTestSet(file)).toThrow(/no voices/);
    fs.writeFileSync(file, 'not json');
    expect(() => loadTestSet(file)).toThrow(/not JSON/);
    fs.writeFileSync(file, JSON.stringify({ ...MINI, turntaking: { tuning: [], eval: [{ id: 'x', class: 'pause', segments: [] }] } }));
    expect(() => loadTestSet(file)).toThrow(/without id, class or segments/);
    fs.writeFileSync(file, JSON.stringify({ ...MINI, bargein: { ask: 'x' } }));
    expect(() => loadTestSet(file)).toThrow(/bargein is incomplete/);
  });
});

describe('the `tools` set', () => {
  it('is one single-segment scenario of class `tool` per prompt, in the file\'s own order, played in conversation mode', () => {
    expect(scenariosFor(TOOLS, 'tools')).toEqual([
      { id: 'x01', class: 'tool', segments: [{ text: 'search it' }] },
      { id: 'x02', class: 'tool', segments: [{ text: 'run it' }] },
    ]);
    expect(scenariosFor({ ...TOOLS, tools: [...TOOLS.tools!].reverse() }, 'tools').map((s) => s.id)).toEqual(['x02', 'x01']);
    expect(modeForSet('tools')).toBe('chat');
  });

  it('cannot be asked of a test set with no `tools` list, or an empty one: a plain error that says where the prompts are, and the other sets are untouched', () => {
    expect(() => scenariosFor(MINI, 'tools')).toThrow(/test set: asked for the set tools, but this test set has no `tools` prompts \(round 2 adds them: eval\/voice-lab\/testset2\.json\)/);
    expect(() => scenariosFor({ ...MINI, tools: [] }, 'tools')).toThrow(/no `tools` prompts/);
    expect(scenariosFor(MINI, 'latency')).toHaveLength(3);
    expect(scenariosFor(TOOLS, 'latency')).toHaveLength(3);
    expect(scenariosFor(TOOLS, 'tuning').every((s) => s.class !== 'tool')).toBe(true);
  });

  it('is planned as audio with the voices alternating by position, like every set, and a missing clip fails before any call', () => {
    const lib = new AudioLibrary(audioDir());
    const plans = planSet(TOOLS, 'tools', lib);
    expect(plans.map((p) => [p.id, p.position, p.voice, p.class, p.set])).toEqual([
      ['x01', 0, 'Voice A', 'tool', 'tools'],
      ['x02', 1, 'Voice B', 'tool', 'tools'],
    ]);
    expect(plans.every((p) => p.interruption === undefined && p.built.speech.length === 1)).toBe(true);
    expect(plans[0].built.speech[0].text).toBe('search it');
    expect(planSet(TOOLS, 'tools', lib, 1).map((p) => p.voice)).toEqual(['Voice B', 'Voice A']);
    const dir = audioDir();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
    delete manifest['Voice B|run it'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    expect(() => planSet(TOOLS, 'tools', new AudioLibrary(dir))).toThrow(/no audio for "Voice B\|run it"/);
  });
});

describe('fingerprintOf', () => {
  it('is the git blob id and the sha256 of the content, the same for CRLF and for a BOM', () => {
    const f = fingerprintOf('hello\n');
    expect(f.blob).toBe('ce013625030ba8dba906f756967f9e9ca394464a'); // echo hello | git hash-object --stdin
    expect(f.sha256).toBe('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03');
    expect(fingerprintOf('hello\r\n')).toEqual(f);
    expect(fingerprintOf('﻿hello\n')).toEqual(f);
    expect(fingerprintOf('hello')).not.toEqual(f);
  });
});

describe('voices and plans', () => {
  it('alternates the voices by position, shifted by the offset, and wraps negatives', () => {
    expect([0, 1, 2, 3].map((i) => voiceFor(MINI, i))).toEqual(['Voice A', 'Voice B', 'Voice A', 'Voice B']);
    expect([0, 1, 2].map((i) => voiceFor(MINI, i, 1))).toEqual(['Voice B', 'Voice A', 'Voice B']);
    expect(voiceFor(MINI, 0, -1)).toBe('Voice B');
  });

  it('knows its sets and the mode each is played in', () => {
    expect([...LAB_SETS]).toEqual(['latency', 'pause', 'short', 'filler', 'bargein', 'interview', 'talk', 'tuning', 'tools']);
    expect(LAB_SETS.every(isLabSet)).toBe(true);
    expect(isLabSet('all')).toBe(false);
    expect(isLabSet('')).toBe(false);
    expect(modeForSet('interview')).toBe('interview');
    expect(modeForSet('talk')).toBe('talk');
    for (const s of ['latency', 'pause', 'short', 'filler', 'bargein', 'tuning', 'tools'] as const) expect(modeForSet(s)).toBe('chat');
  });

  it('plans every scenario of a set as audio with its voice, in order', () => {
    const lib = new AudioLibrary(audioDir());
    const plans = planSet(MINI, 'latency', lib);
    expect(plans.map((p) => [p.id, p.position, p.voice, p.class, p.set])).toEqual([
      ['l01', 0, 'Voice A', 'latency', 'latency'],
      ['l02', 1, 'Voice B', 'latency', 'latency'],
      ['l03', 2, 'Voice A', 'latency', 'latency'],
    ]);
    expect(plans[0].interruption).toBeUndefined();
    expect(planSet(MINI, 'latency', lib, 1).map((p) => p.voice)).toEqual(['Voice B', 'Voice A', 'Voice B']);
    expect(planSet(MINI, 'latency', lib, 0, 100)[0].built.speech[0].beginSample).toBe(1600 + 640);
  });

  it('plans a barge-in scenario as the question and an interruption to place later', () => {
    const lib = new AudioLibrary(audioDir());
    const plans = planSet(MINI, 'bargein', lib);
    expect(plans.map((p) => p.id)).toEqual(['b1', 'b2']);
    expect(plans[0].built.speech[0].text).toBe('tell me everything');
    const bi = plans[0].interruption!;
    expect(bi.text).toBe('hold on');
    expect(bi.afterFirstAudioMs).toBe(500);
    // trimmed to speech plus margin; the speech inside is where it says (1000 samples of silence before it in the source: 640 are kept)
    expect(sampleCount(bi.pcm)).toBe(640 + 1920 + 640);
    expect(bi.firstSample).toBe(640);
    expect(bi.lastSample).toBe(640 + 1920 - 1);
    expect(plans[1].interruption!.text).toBe('excuse me');
    expect(plans[1].voice).toBe('Voice B');
    const pair = buildBargeIn(MINI, 'wait stop', 'Voice A', lib);
    expect(pair.ask.speech[0].text).toBe('tell me everything');
    expect(pair.interruption.text).toBe('wait stop');
    expect(planSet(MINI, 'tuning', lib).map((p) => p.id)).toEqual(['t-p1', 't-s1', 'tb1']);
  });

  it('fails before any call when a clip is missing', () => {
    const dir = audioDir();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
    delete manifest['Voice B|what is raft'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    expect(() => planSet(MINI, 'latency', new AudioLibrary(dir))).toThrow(/no audio for "Voice B\|what is raft"/);
  });
});
