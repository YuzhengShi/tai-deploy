import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { loadVoiceConfig } from './config.js';
import { clampSpeed, isFluxVoice, listenConfig, listenUpdate, speakConfig, turnFields } from './settings.js';
import { PREF_SPEED_MAX, PREF_SPEED_MIN, prefsFile, speedFor, speedFromPrefs } from './speed.js';

const config = (env: Record<string, string> = {}) => loadVoiceConfig((key) => env[key]);

describe('turn-taking', () => {
  it('is quicker in a conversation than in an interview, with eager mode off (it started a search nobody had asked for in the owner\'s call)', () => {
    const c = config();
    expect(turnFields(c, 'chat')).toEqual({ eot_threshold: 0.75, eot_timeout_ms: 5000 });
    expect(turnFields(c, 'interview')).toEqual({ eot_threshold: 0.88, eot_timeout_ms: 8000 });
  });

  it('can turn eager mode on, and never asks for an eager threshold above the one that confirms (Deepgram refuses that)', () => {
    expect(turnFields(config({ TAI_VOICE_EAGER_EOT_THRESHOLD: '0.4' }), 'chat')).toEqual({ eot_threshold: 0.75, eager_eot_threshold: 0.4, eot_timeout_ms: 5000 });
    expect(config({ TAI_VOICE_EOT_THRESHOLD: '0.6', TAI_VOICE_EAGER_EOT_THRESHOLD: '0.9' }).eagerEotThreshold).toBe(0.6);
  });

  it('gives only Flux listen models the end-of-turn fields', () => {
    const c = config({ TAI_VOICE_EAGER_EOT_THRESHOLD: '0.4' });
    expect(listenConfig(c, 'flux-general-en', 'interview')).toMatchObject({ provider: { version: 'v2', eot_threshold: 0.88, eager_eot_threshold: 0.4 } });
    const nova = listenConfig(c, 'nova-3') as { provider: Record<string, unknown> };
    expect(nova.provider.version).toBe('v1');
    expect(nova.provider).not.toHaveProperty('eot_threshold');
    expect(listenUpdate(c, 'nova-3', 'chat')).toBeNull();
  });

  it('changes only the turn-taking in an UpdateListen (the keyterms and the rest keep their value)', () => {
    expect(listenUpdate(config(), 'flux-general-en', 'interview')).toEqual({
      type: 'UpdateListen',
      listen: { provider: { type: 'deepgram', version: 'v2', model: 'flux-general-en', eot_threshold: 0.88, eot_timeout_ms: 8000 } },
    });
  });

  it('is the most patient in a talk-it-through: the student explains at length and a pause is not an ending', () => {
    const c = config();
    expect(turnFields(c, 'talk')).toEqual({ eot_threshold: 0.9, eot_timeout_ms: 10000 });
    expect(c.talkEotThreshold).toBeGreaterThan(c.interviewEotThreshold);
    expect(c.talkEotTimeoutMs).toBeGreaterThan(c.interviewEotTimeoutMs);
    expect(listenUpdate(c, 'flux-general-en', 'talk')).toEqual({
      type: 'UpdateListen',
      listen: { provider: { type: 'deepgram', version: 'v2', model: 'flux-general-en', eot_threshold: 0.9, eot_timeout_ms: 10000 } },
    });
    expect(listenConfig(c, 'flux-general-en', 'talk')).toMatchObject({ provider: { version: 'v2', eot_threshold: 0.9, eot_timeout_ms: 10000 } });
    // eager mode, when it is on, still never goes above the threshold that confirms
    expect(turnFields(config({ TAI_VOICE_EAGER_EOT_THRESHOLD: '0.4' }), 'talk')).toEqual({ eot_threshold: 0.9, eager_eot_threshold: 0.4, eot_timeout_ms: 10000 });
    expect(turnFields(config({ TAI_VOICE_TALK_EOT_THRESHOLD: '0.7', TAI_VOICE_TALK_EOT_TIMEOUT_MS: '15000' }), 'talk')).toEqual({ eot_threshold: 0.7, eot_timeout_ms: 15000 });
    expect(listenUpdate(c, 'nova-3', 'talk')).toBeNull();
  });
});

describe('the settings of the batch-1 voice features', () => {
  it('keeps a student\'s tool host ten minutes, three at most; closes it with the call when told to; answers a look-up for now only when told to', () => {
    expect(config()).toMatchObject({ toolHostKeepSec: 600, toolHostKeepMax: 3, asyncAfterMs: 0, talkMin: 15 });
    expect(config({ TAI_VOICE_TOOLHOST_KEEP_SEC: '0' }).toolHostKeepSec).toBe(0);
    expect(config({ TAI_VOICE_TOOLHOST_KEEP_SEC: '900', TAI_VOICE_TOOLHOST_KEEP_MAX: '5' })).toMatchObject({ toolHostKeepSec: 900, toolHostKeepMax: 5 });
    expect(config({ TAI_VOICE_ASYNC_AFTER_MS: '4000' }).asyncAfterMs).toBe(4000);
    expect(config({ TAI_VOICE_TALK_MAX_MIN: '20' }).talkMin).toBe(20);
  });

  it('sends a talk-it-through to qwen unless told otherwise, and leaves the model of a conversation alone', () => {
    expect(config()).toMatchObject({ model: 'gpt-oss', talkModel: 'qwen' });
    expect(config({ TAI_VOICE_TALK_MODEL: 'gpt-oss' }).talkModel).toBe('gpt-oss');
    expect(config({ TAI_VOICE_MODEL: 'qwen' })).toMatchObject({ model: 'qwen', talkModel: 'qwen' });
  });

  it('falls back to the defaults for a value that is not one, and says so', () => {
    const warnings: string[] = [];
    const bad = loadVoiceConfig(
      (key) => ({ TAI_VOICE_TOOLHOST_KEEP_SEC: 'forever', TAI_VOICE_TOOLHOST_KEEP_MAX: '0', TAI_VOICE_ASYNC_AFTER_MS: '-5', TAI_VOICE_TALK_MAX_MIN: '1', TAI_VOICE_TALK_EOT_THRESHOLD: '2' })[key as never],
      (m) => warnings.push(m),
    );
    expect(bad).toMatchObject({ toolHostKeepSec: 600, toolHostKeepMax: 3, asyncAfterMs: 0, talkMin: 15, talkEotThreshold: 0.9 });
    expect(warnings).toHaveLength(5);
  });
});

describe('the voices', () => {
  it('tells a Flux TTS voice (v2) from an Aura one (v1)', () => {
    expect(isFluxVoice('flux-hannah-en')).toBe(true);
    expect(isFluxVoice('flux-general-en')).toBe(true); // a listen model's name has the same shape: speakConfig is only ever given a voice
    expect(isFluxVoice('aura-2-thalia-en')).toBe(false);
    expect(speakConfig('flux-miles-en')).toEqual({ provider: { type: 'deepgram', version: 'v2', model: 'flux-miles-en' } });
    expect(speakConfig('aura-2-mars-en')).toEqual({ provider: { type: 'deepgram', model: 'aura-2-mars-en' } });
  });

  it('starts with the Flux voices and keeps the Aura ones to fall back to', () => {
    const c = config();
    expect([c.voiceChat, c.voiceInterview]).toEqual(['flux-hannah-en', 'flux-miles-en']);
    expect([c.fallbackVoiceChat, c.fallbackVoiceInterview]).toEqual(['aura-2-thalia-en', 'aura-2-mars-en']);
    expect(config({ TAI_VOICE_VOICE_CHAT: 'aura-2-thalia-en' }).voiceChat).toBe('aura-2-thalia-en');
  });

  it('speaks faster than the voice\'s own pace (the owner found it slow), in the steps Deepgram takes, and sends speed and expressivity only when they differ from the voice\'s own', () => {
    const c = config();
    expect(c.speed).toBe(1.2);
    expect(speakConfig('flux-hannah-en', { speed: c.speed, expressivity: c.expressivity })).toEqual({ provider: { type: 'deepgram', version: 'v2', model: 'flux-hannah-en', speed: 1.2 } });
    expect(speakConfig('aura-2-thalia-en', { speed: 1.2, expressivity: 2 })).toEqual({ provider: { type: 'deepgram', model: 'aura-2-thalia-en', speed: 1.2 } }); // expressivity is Flux's alone
    expect(speakConfig('flux-hannah-en', { speed: 1.2, expressivity: 1 })).toMatchObject({ provider: { speed: 1.2, expressivity: 1 } });
    expect(config({ TAI_VOICE_SPEED: '1' }).speed).toBeUndefined();
    expect(config({ TAI_VOICE_SPEED: '1.23' }).speed).toBe(1.25);
    expect(config({ TAI_VOICE_SPEED: '3' }).speed).toBe(1.2); // out of range: the default
    expect(config({ TAI_VOICE_EXPRESSIVITY: '-2' }).expressivity).toBe(-2);
    expect(config({ TAI_VOICE_EXPRESSIVITY: '9' }).expressivity).toBe(0);
  });

  it('limits what one answer may say, and lets it be switched off', () => {
    expect(config()).toMatchObject({ govern: true, maxSentences: 3, maxWords: 55 });
    expect(config({ TAI_VOICE_GOVERN: '0' }).govern).toBe(false);
    expect(config({ TAI_VOICE_MAX_WORDS: '60', TAI_VOICE_MAX_SENTENCES: '3' })).toMatchObject({ maxSentences: 3, maxWords: 60 });
  });
});

describe('the pace of a voice, whatever it is set from', () => {
  it('fits the voice it is for: Flux voices take 0.5 to 1.5, Aura voices 0.7 to 1.5, both in steps of 0.05', () => {
    expect(clampSpeed(1.2, 'flux-hannah-en')).toBe(1.2);
    expect(clampSpeed(0.6, 'flux-miles-en')).toBe(0.6);
    expect(clampSpeed(0.6, 'aura-2-mars-en')).toBe(0.7); // Aura starts at 0.7
    expect(clampSpeed(0.3, 'flux-miles-en')).toBe(0.5);
    expect(clampSpeed(9, 'flux-hannah-en')).toBe(1.5);
    expect(clampSpeed(9, 'aura-2-thalia-en')).toBe(1.5);
    expect(clampSpeed(1.23, 'flux-hannah-en')).toBe(1.25);
    expect(clampSpeed(1.12, 'aura-2-thalia-en')).toBe(1.1);
    expect(clampSpeed(undefined, 'flux-hannah-en')).toBeUndefined();
    expect(clampSpeed(Number.NaN, 'flux-hannah-en')).toBeUndefined();
    expect(clampSpeed(Infinity, 'flux-hannah-en')).toBeUndefined();
  });

  it('goes into the speak block clamped for that voice, and is left out at the voice\'s own pace', () => {
    expect(speakConfig('flux-hannah-en', { speed: 1.35 })).toEqual({ provider: { type: 'deepgram', version: 'v2', model: 'flux-hannah-en', speed: 1.35 } });
    expect(speakConfig('aura-2-thalia-en', { speed: 0.6 })).toEqual({ provider: { type: 'deepgram', model: 'aura-2-thalia-en', speed: 0.7 } });
    expect(speakConfig('flux-miles-en', { speed: 0.6 })).toMatchObject({ provider: { speed: 0.6 } });
    expect(speakConfig('flux-miles-en', { speed: 2 })).toMatchObject({ provider: { speed: 1.5 } });
    expect(speakConfig('flux-miles-en', { speed: 1 }).provider).not.toHaveProperty('speed');
    expect(speakConfig('flux-miles-en', {}).provider).not.toHaveProperty('speed');
  });
});

describe('the pace a student chose in Settings (speedFor)', () => {
  const folder = 's_0123456789abcdef0123';
  const reads = (text: string | null) => ({ storeDir: '/store', read: () => text });

  it('is their voiceSpeed when the file has a usable one, in the steps the voices take', () => {
    expect(speedFor(folder, 1.2, reads('{"voiceSpeed": 1.1}'))).toBe(1.1);
    expect(speedFor(folder, 1.2, reads('{"voiceSpeed": 0.8, "theme": "dark"}'))).toBe(0.8);
    expect(speedFor(folder, 1.2, reads('{"voiceSpeed": 1.4}'))).toBe(1.4);
    expect(speedFor(folder, 1.2, reads('{"voiceSpeed": 1.12}'))).toBe(1.1);
    expect(speedFor(folder, 1.2, reads('{"voiceSpeed": "1.3"}'))).toBe(1.3); // a form hands numbers over as text
    expect(speedFor(folder, undefined, reads('{"voiceSpeed": 1.25}'))).toBe(1.25);
  });

  it('is the voice\'s own pace (1) when they chose 1.0, even where the deployment speaks faster: they said so', () => {
    expect(speedFor(folder, 1.2, reads('{"voiceSpeed": 1}'))).toBe(1);
    expect(speakConfig('flux-hannah-en', { speed: speedFor(folder, 1.2, reads('{"voiceSpeed": 1.0}')) }).provider).not.toHaveProperty('speed');
  });

  it('is the default for a file that is missing, a value that is missing or not a number, and one outside 0.8 to 1.4', () => {
    for (const text of [null, '', '   ', '{', 'not json', '[]', '[1.1]', '"1.1"', 'null', '7', '{}', '{"voiceSpeed": null}', '{"voiceSpeed": "fast"}', '{"voiceSpeed": ""}', '{"voiceSpeed": {}}', '{"voiceSpeed": [1.1]}', '{"voiceSpeed": true}',
      '{"voiceSpeed": 0.79}', '{"voiceSpeed": 1.41}', '{"voiceSpeed": 0}', '{"voiceSpeed": -1.2}', '{"voiceSpeed": 12}', '{"voiceSpeed": "1.2.3"}', '{"voiceSpeed": "1e1"}', '{"voiceSpeed": 1e999}', '{"voice_speed": 1.1}']) {
      expect(speedFor(folder, 1.2, reads(text)), String(text)).toBe(1.2);
      expect(speedFor(folder, undefined, reads(text)), String(text)).toBeUndefined();
    }
    expect([PREF_SPEED_MIN, PREF_SPEED_MAX]).toEqual([0.8, 1.4]);
  });

  it('never reads a file for a folder that is not a folder name, and takes a read that throws for no file', () => {
    let read = 0;
    const spy = { storeDir: '/store', read: () => { read++; return '{"voiceSpeed": 1.4}'; } };
    for (const bad of ['', '../../etc', 'a/b', 'a\\b', 'x'.repeat(65), 's_ x']) expect(speedFor(bad, 1.2, spy), bad).toBe(1.2);
    expect(read).toBe(0);
    expect(speedFor(folder, 1.2, { storeDir: '/store', read: () => { throw new Error('EACCES'); } })).toBe(1.2);
  });

  it('reads <store>/portal/<folder>.prefs.json, and a broken or huge or absent file is the default', () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-speed-'));
    try {
      expect(prefsFile(store, folder)).toBe(path.join(store, 'portal', `${folder}.prefs.json`));
      expect(speedFor(folder, 1.2, { storeDir: store })).toBe(1.2); // no directory, no file
      fs.mkdirSync(path.join(store, 'portal'), { recursive: true });
      fs.writeFileSync(prefsFile(store, folder), JSON.stringify({ voiceSpeed: 1.35 }));
      expect(speedFor(folder, 1.2, { storeDir: store })).toBe(1.35);
      expect(speedFor('s_other', 1.2, { storeDir: store })).toBe(1.2); // nobody else's
      fs.writeFileSync(prefsFile(store, folder), '{"voiceSpeed": 1.35');
      expect(speedFor(folder, 1.2, { storeDir: store })).toBe(1.2);
      fs.writeFileSync(prefsFile(store, folder), JSON.stringify({ voiceSpeed: 1.35, filler: 'x'.repeat(70_000) }));
      expect(speedFor(folder, 1.2, { storeDir: store })).toBe(1.2); // not a preferences file
      fs.rmSync(prefsFile(store, folder));
      fs.mkdirSync(prefsFile(store, folder)); // a directory where the file should be
      expect(speedFor(folder, 1.2, { storeDir: store })).toBe(1.2);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it('reads a value out of a preferences text, and nothing out of anything else', () => {
    expect(speedFromPrefs('{"voiceSpeed": 1.05}')).toBe(1.05);
    expect(speedFromPrefs(undefined)).toBeUndefined();
  });
});
