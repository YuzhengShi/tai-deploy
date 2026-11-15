import { describe, expect, it } from 'vitest';

import { forChain, isChainName, loadLabConfig, turnParamsFor, DEFAULT_LABGPU_ASR, DEFAULT_LABGPU_TTS, DEFAULT_EAGER_EOT } from './config.js';

const cfg = (env: Record<string, string> = {}, warnings: string[] = []) => loadLabConfig((k) => env[k], (m) => warnings.push(m));

describe('loadLabConfig', () => {
  it('is off unless TAI_VOICE_LAB is exactly 1, and its defaults are LabGPU\'s services with Flux and Aura as fallbacks', () => {
    expect(cfg().enabled).toBe(false);
    expect(cfg({ TAI_VOICE_LAB: 'true' }).enabled).toBe(false);
    const c = cfg({ TAI_VOICE_LAB: '1' });
    expect(c).toMatchObject({ enabled: true, ears: 'labgpu', earsFallback: 'flux', mouth: 'labgpu', mouthFallback: 'aura', shadowEars: 'flux', tempo: true, earsUrl: DEFAULT_LABGPU_ASR, ttsUrl: DEFAULT_LABGPU_TTS });
    expect(c.hold.chat).toEqual({ completeMs: 0, incompleteMs: 1800 });
    expect(c.hold.interview).toEqual({ completeMs: 600, incompleteMs: 3500 });
    expect(c.hold.talk).toEqual({ completeMs: 2000, incompleteMs: 6000 });
    expect(c.livePace).toBe(3.45);
    expect(c.labgpuPace).toBe(2.69);
  });

  it('the control chain: Flux ears with Aura, the shadow is LabGPU\'s, no fallback for the Flux ears themselves', () => {
    const c = cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EARS: 'flux', TAI_VOICE_LAB_MOUTH: 'aura' });
    expect(c).toMatchObject({ ears: 'flux', earsFallback: 'none', mouth: 'aura', mouthFallback: 'none', shadowEars: 'labgpu' });
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_SHADOW_EARS: 'none' }).shadowEars).toBe('none');
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_SHADOW_EARS: 'labgpu' }).shadowEars).toBe('none');    // a recognizer is not its own shadow
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EARS_FALLBACK: 'labgpu' }).earsFallback).toBe('none');
  });

  it('a value that does not parse falls back to its default and says so', () => {
    const warnings: string[] = [];
    const c = cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EARS: 'whisper', TAI_VOICE_LAB_COVER_MS: 'soon', TAI_VOICE_LAB_HOLD_CHAT: 'fast', TAI_VOICE_LAB_EARS_URL: 'http://192.0.2.29:8803', TAI_VOICE_LAB_TRACE: 'turns.jsonl' }, warnings);
    expect(c.ears).toBe('labgpu');
    expect(c.coverAfterMs).toBe(350);
    expect(c.hold.chat).toEqual({ completeMs: 0, incompleteMs: 1800 });
    expect(c.earsUrl).toBe(DEFAULT_LABGPU_ASR);
    expect(c.traceFile).toBe('');
    expect(warnings).toHaveLength(4);
  });

  it('takes the numbers it is given', () => {
    const c = cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_COVER_MS: '250', TAI_VOICE_LAB_BARGE_MS: '300', TAI_VOICE_LAB_HOLD_INTERVIEW: '800, 4000', TAI_VOICE_LAB_TRACE: '/tmp/lab/turns.jsonl', TAI_VOICE_LAB_TEMPO: '0', TAI_VOICE_LAB_AURA_SPEED_SCALE: '1.3' });
    expect(c).toMatchObject({ coverAfterMs: 250, bargeMinVoicedMs: 300, traceFile: '/tmp/lab/turns.jsonl', tempo: false, auraSpeedScale: 1.3 });
    expect(c.hold.interview).toEqual({ completeMs: 800, incompleteMs: 4000 });
  });

  it('never takes DrBerg for LabGPU\'s voice', () => {
    const warnings: string[] = [];
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_LABGPU_VOICE: 'DrBerg' }, warnings).labgpuVoice).toBe('af_bella');
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_LABGPU_VOICE: 'dr-berg' }).labgpuVoice).toBe('af_bella');
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_LABGPU_VOICE: 'af_heart' }).labgpuVoice).toBe('af_heart');
    expect(warnings).toHaveLength(1);
  });
});

describe('the barge-in and the eager end of turn (round 2, A10 and A11)', () => {
  it('ask for 200 ms of loud speech in a window of 300 ms, and for nothing early, unless told', () => {
    const c = cfg({ TAI_VOICE_LAB: '1' });
    expect(c).toMatchObject({ bargeMinVoicedMs: 200, bargeWindowMs: 300, bargeRmsFactor: 1.5, eagerEot: 0, chain: '' });
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_BARGE_WINDOW_MS: '500', TAI_VOICE_LAB_BARGE_MS: '240' })).toMatchObject({ bargeMinVoicedMs: 240, bargeWindowMs: 500 });
  });

  it('the eager threshold is 0 (off) or in the range Flux takes, and a value outside it leaves it off with a warning', () => {
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EAGER_EOT: '0.45' }).eagerEot).toBe(0.45);
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EAGER_EOT: '0.1' }).eagerEot).toBe(0.3);       // lifted to the lowest Flux takes
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EAGER_EOT: '0' }).eagerEot).toBe(0);
    const warnings: string[] = [];
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EAGER_EOT: '0.95' }, warnings).eagerEot).toBe(0);
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EAGER_EOT: 'soon' }, warnings).eagerEot).toBe(0);
    expect(warnings).toHaveLength(2);
  });
});

describe('forChain', () => {
  const base = cfg({ TAI_VOICE_LAB: '1' });

  it('knows exactly five chains', () => {
    expect(['d', 'h', 'fd', 'c', 'cf'].every(isChainName)).toBe(true);
    for (const x of ['', 'D', 'labgpu', 'h ', 'hh', undefined, null, 4]) expect(isChainName(x)).toBe(false);
  });

  it('d: LabGPU ears and mouth, nothing asked early; h: the same with Flux beside LabGPU asking the model early', () => {
    expect(forChain(base, 'd')).toMatchObject({ chain: 'd', ears: 'labgpu', mouth: 'labgpu', shadowEars: 'flux', eagerEot: 0 });
    expect(forChain(base, 'h')).toMatchObject({ chain: 'h', ears: 'labgpu', mouth: 'labgpu', shadowEars: 'flux', eagerEot: DEFAULT_EAGER_EOT });
  });

  it('fd: Flux ears and LabGPU mouth; c: Flux ears and Aura mouth, both with the eager end of turn, LabGPU ears as the shadow and as the fallback', () => {
    expect(forChain(base, 'fd')).toMatchObject({ chain: 'fd', ears: 'flux', earsFallback: 'labgpu', shadowEars: 'labgpu', mouth: 'labgpu', eagerEot: DEFAULT_EAGER_EOT });
    expect(forChain(base, 'c')).toMatchObject({ chain: 'c', ears: 'flux', earsFallback: 'labgpu', shadowEars: 'labgpu', mouth: 'aura', mouthFallback: 'labgpu', eagerEot: DEFAULT_EAGER_EOT });
  });

  it('cf: Flux ears and the Flux TTS mouth (the live call\'s voice, one speech per answer), Aura as the mouth that takes over, LabGPU ears as the shadow and the fallback', () => {
    expect(forChain(base, 'cf')).toMatchObject({ chain: 'cf', ears: 'flux', earsFallback: 'labgpu', shadowEars: 'labgpu', mouth: 'flux', mouthFallback: 'aura', eagerEot: DEFAULT_EAGER_EOT });
  });

  it('the Flux TTS settings: the address, the voice, the scale of the Settings\' speed; the mouth can be chosen for the process', () => {
    expect(base).toMatchObject({ fluxTtsUrl: 'wss://api.deepgram.com', fluxVoiceChat: 'flux-hannah-en', fluxSpeedScale: 1 });
    const own = cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_MOUTH: 'flux', TAI_VOICE_LAB_FLUX_TTS_URL: 'ws://127.0.0.1:9/', TAI_VOICE_LAB_FLUX_SPEED_SCALE: '0.9' });
    expect(own).toMatchObject({ mouth: 'flux', mouthFallback: 'aura', fluxTtsUrl: 'ws://127.0.0.1:9', fluxSpeedScale: 0.9 });
    expect(cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_FLUX_TTS_URL: 'https://x.test' }).fluxTtsUrl).toBe('wss://api.deepgram.com');   // not a ws address: the default, said once
  });

  it('the threshold of TAI_VOICE_LAB_EAGER_EOT is the one the chains that use the eager end of turn take', () => {
    const tuned = cfg({ TAI_VOICE_LAB: '1', TAI_VOICE_LAB_EAGER_EOT: '0.6' });
    expect(forChain(tuned, 'h').eagerEot).toBe(0.6);
    expect(forChain(tuned, 'd').eagerEot).toBe(0);
  });

  it('anything else is the settings of the process, untouched (a typo does not turn a call into another chain)', () => {
    for (const x of [undefined, null, '', 'x', 'H', 'labgpu']) expect(forChain(base, x)).toBe(base);
  });

  it('does not change the configuration it was given', () => {
    const copy = { ...base };
    forChain(base, 'c');
    expect(base).toEqual(copy);
  });
});

describe('turnParamsFor', () => {
  it('uses the hold-offs of the mode and never waits less than the longest hold for the timeout', () => {
    const c = cfg({ TAI_VOICE_LAB: '1' });
    expect(turnParamsFor(c, 'chat', 5000)).toEqual({ completeMs: 0, incompleteMs: 1800, timeoutMs: 5000, coverAfterMs: 350 });
    expect(turnParamsFor(c, 'talk', 3000)).toEqual({ completeMs: 2000, incompleteMs: 6000, timeoutMs: 6000, coverAfterMs: 350 });
  });
});
