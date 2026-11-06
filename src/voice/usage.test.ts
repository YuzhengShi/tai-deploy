import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatCompletionsUrl, isFluxModel, loadVoiceConfig } from './config.js';
import { INTERVIEW_TOKEN_TTL_MS, signInterviewToken, verifyInterviewToken } from './interview-token.js';
import { CallSlots, VoiceUsage } from './usage.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-usage-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the daily usage', () => {
  it('counts seconds per student per day, persists them, and starts a new day at midnight', () => {
    let now = new Date(2026, 10, 1, 23, 59, 0).getTime();
    const file = path.join(dir, 'voice-usage.json');
    const usage = new VoiceUsage(file, { now: () => now, flushDelayMs: 0 });
    usage.add('s_a', 30);
    usage.add('s_a', 15.5);
    usage.add('s_b', 10);
    usage.add('../evil', 100);
    usage.add('s_a', -5);
    expect(usage.usedSeconds('s_a')).toBe(45.5);
    const again = new VoiceUsage(file, { now: () => now });
    expect(again.usedSeconds('s_a')).toBe(45.5);
    expect(again.usedSeconds('s_b')).toBe(10);
    now += 2 * 60_000; // past midnight
    expect(again.usedSeconds('s_a')).toBe(0);
    again.add('s_a', 5);
    again.flush();
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Object.keys(data.days).sort()).toEqual(['2026-11-01', '2026-11-02']);
    expect(JSON.stringify(data)).not.toContain('evil');
  });

  it('keeps two weeks and survives a broken file', () => {
    const file = path.join(dir, 'voice-usage.json');
    let now = new Date(2026, 9, 1, 12).getTime();
    const usage = new VoiceUsage(file, { now: () => now, flushDelayMs: 0 });
    for (let d = 0; d < 20; d++) {
      usage.add('s_a', 1);
      now += 86_400_000;
    }
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).days)).toHaveLength(14);
    fs.writeFileSync(file, '{broken');
    const warnings: string[] = [];
    const fresh = new VoiceUsage(file, { now: () => now, warn: (m) => warnings.push(m) });
    expect(fresh.usedSeconds('s_a')).toBe(0);
    expect(warnings[0]).toMatch(/does not parse/);
    expect(fs.existsSync(`${file}.broken`)).toBe(true);
  });

  it('gives one call per student and at most the host limit', () => {
    const slots = new CallSlots(2);
    expect(slots.take('a')).toBe('ok');
    expect(slots.take('a')).toBe('student-busy');
    expect(slots.take('b')).toBe('ok');
    expect(slots.take('c')).toBe('host-full');
    slots.release('a');
    expect(slots.take('c')).toBe('ok');
    expect(slots.count).toBe(2);
  });
});

describe('the configuration', () => {
  it('has the defaults of docs/VOICE.md', () => {
    const c = loadVoiceConfig(() => undefined);
    expect(c).toMatchObject({
      enabled: false,
      llmUrl: 'http://127.0.0.1:4010',
      model: 'gpt-oss',
      evalModel: 'gpt-oss',
      think: 'relay',
      listenModel: 'flux-general-en',
      voiceChat: 'flux-hannah-en',
      voiceInterview: 'flux-miles-en',
      fallbackVoiceChat: 'aura-2-thalia-en',
      fallbackVoiceInterview: 'aura-2-mars-en',
      sessionMin: 30,
      interviewMin: 15,
      dailyMin: 45,
      maxConcurrent: 3,
      silenceSec: 180,
      maxTokens: 1200,
      eotThreshold: 0.75,
      eagerEotThreshold: 0,
      eotTimeoutMs: 5000,
      speed: 1.2,
      expressivity: 0,
      govern: true,
      maxSentences: 3,
      maxWords: 55,
      warmCourse: true,
      interviewEotThreshold: 0.88,
      interviewEotTimeoutMs: 8000,
      deepgramUrl: 'wss://agent.deepgram.com/v1/agent/converse',
    });
  });

  it('falls back to the default for anything that does not parse, and says so', () => {
    const warnings: string[] = [];
    const values: Record<string, string> = {
      TAI_VOICE: '1',
      TAI_VOICE_DAILY_MIN: 'lots',
      TAI_VOICE_MAX_CONCURRENT: '0',
      TAI_VOICE_SESSION_MIN: '30.5',
      TAI_VOICE_MODEL: 'gpt oss; drop',
      TAI_VOICE_LLM_URL: 'ftp://x',
      TAI_VOICE_THINK: 'bedrock',
      TAI_VOICE_EOT_THRESHOLD: '0.95',
    };
    const c = loadVoiceConfig((k) => values[k], (m) => warnings.push(m));
    expect(c).toMatchObject({ enabled: true, dailyMin: 45, maxConcurrent: 3, sessionMin: 30, model: 'gpt-oss', llmUrl: 'http://127.0.0.1:4010', think: 'relay', eotThreshold: 0.95 });
    expect(warnings).toHaveLength(6);
    expect(isFluxModel('flux-general-en')).toBe(true);
    expect(isFluxModel('nova-3')).toBe(false);
    expect(chatCompletionsUrl('http://gw:4000')).toBe('http://gw:4000/v1/chat/completions');
    expect(chatCompletionsUrl('http://gw:4000/v1/')).toBe('http://gw:4000/v1/chat/completions');
    expect(chatCompletionsUrl('http://gw:4000/v1/chat/completions')).toBe('http://gw:4000/v1/chat/completions');
  });
});

describe('the interview link token', () => {
  const secret = 'shh';
  const now = 1_800_000_000_000;
  it('accepts what start_mock_interview signs, for an hour', () => {
    const tok = signInterviewToken(secret, 's_0123456789abcdef0123', '4242', now);
    expect(verifyInterviewToken(tok, secret, now + 1000)).toEqual({ folder: 's_0123456789abcdef0123', assignmentId: '4242' });
    expect(verifyInterviewToken(tok, secret, now + INTERVIEW_TOKEN_TTL_MS + 1)).toBeNull();
    // the container's own way of signing, byte for byte (ipc-mcp-stdio.ts start_mock_interview)
    const json = Buffer.from(JSON.stringify({ folder: 's_x', assignmentId: '', ts: now })).toString('base64url');
    const theirs = `${json}.${crypto.createHmac('sha256', secret).update(json).digest('hex')}`;
    expect(verifyInterviewToken(theirs, secret, now)).toEqual({ folder: 's_x' });
  });

  it('refuses forged, future, odd or overlong tokens', () => {
    const tok = signInterviewToken(secret, 's_x', undefined, now);
    expect(verifyInterviewToken(tok, 'other', now)).toBeNull();
    expect(verifyInterviewToken(tok.replace(/.$/, (c) => (c === '0' ? '1' : '0')), secret, now)).toBeNull();
    expect(verifyInterviewToken(signInterviewToken(secret, 's_x', undefined, now + 3600_000), secret, now)).toBeNull();
    expect(verifyInterviewToken(signInterviewToken(secret, '../etc', undefined, now), secret, now)).toBeNull();
    expect(verifyInterviewToken(signInterviewToken(secret, 's_x', '12abc', now), secret, now)).toBeNull();
    expect(verifyInterviewToken('a.b.c', secret, now)).toBeNull();
    expect(verifyInterviewToken('x'.repeat(3000), secret, now)).toBeNull();
    expect(verifyInterviewToken(tok, undefined, now)).toBeNull();
  });
});
