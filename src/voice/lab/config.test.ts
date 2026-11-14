import { describe, expect, it } from 'vitest';

import { loadLabConfig, turnParamsFor, DEFAULT_LABGPU_ASR, DEFAULT_LABGPU_TTS } from './config.js';

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

describe('turnParamsFor', () => {
  it('uses the hold-offs of the mode and never waits less than the longest hold for the timeout', () => {
    const c = cfg({ TAI_VOICE_LAB: '1' });
    expect(turnParamsFor(c, 'chat', 5000)).toEqual({ completeMs: 0, incompleteMs: 1800, timeoutMs: 5000, coverAfterMs: 350 });
    expect(turnParamsFor(c, 'talk', 3000)).toEqual({ completeMs: 2000, incompleteMs: 6000, timeoutMs: 6000, coverAfterMs: 350 });
  });
});
