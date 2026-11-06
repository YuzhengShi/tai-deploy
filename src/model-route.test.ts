import { describe, expect, it } from 'vitest';

import { routeModel } from './model-route.js';

const LIVE = () => ({
  ANTHROPIC_MODEL: 'gpt-oss',
  ANTHROPIC_MODEL_LIGHT: 'deepseek',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-oss',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-oss',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-oss',
  ANTHROPIC_SMALL_FAST_MODEL: 'gpt-oss',
  ANTHROPIC_BASE_URL: 'http://tai-live-litellm:4000',
});

describe('routeModel', () => {
  it('points every name pi and Claude Code read at the background model for a scheduled task', () => {
    const secrets: Record<string, string> = LIVE();
    routeModel(secrets, true);
    for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
      expect(secrets[name], name).toBe('deepseek');
    }
    expect(secrets.ANTHROPIC_BASE_URL).toBe('http://tai-live-litellm:4000');            // nothing else is touched
  });

  it('leaves a student chat alone, and never sends the setting itself to the container', () => {
    const secrets: Record<string, string> = LIVE();
    routeModel(secrets, false);
    expect(secrets.ANTHROPIC_MODEL).toBe('gpt-oss');
    expect(secrets.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-oss');
    expect('ANTHROPIC_MODEL_LIGHT' in secrets).toBe(false);
  });

  it('is a no-change for a scheduled task when the background model is the chats\' (what the deployment had until now) or not set', () => {
    const same: Record<string, string> = { ...LIVE(), ANTHROPIC_MODEL_LIGHT: 'gpt-oss' };
    routeModel(same, true);
    expect(same.ANTHROPIC_MODEL).toBe('gpt-oss');
    expect(same.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-oss');
    const none: Record<string, string> = LIVE();
    delete (none as Partial<typeof none>).ANTHROPIC_MODEL_LIGHT;
    routeModel(none, true);
    expect(none.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-oss');
    const blank: Record<string, string> = { ...LIVE(), ANTHROPIC_MODEL_LIGHT: '   ' };
    routeModel(blank, true);
    expect(blank.ANTHROPIC_MODEL).toBe('gpt-oss');
  });

  it('beats an explicit TAI_LLM_MODEL for a scheduled task (pi reads that name first), and does not invent names that were not set', () => {
    const secrets: Record<string, string> = { ANTHROPIC_MODEL: 'qwen', ANTHROPIC_MODEL_LIGHT: 'deepseek', TAI_LLM_MODEL: 'qwen' };
    routeModel(secrets, true);
    expect(secrets.TAI_LLM_MODEL).toBe('deepseek');
    expect(secrets.ANTHROPIC_MODEL).toBe('deepseek');
    expect('ANTHROPIC_DEFAULT_SONNET_MODEL' in secrets).toBe(false);
    const chat: Record<string, string> = { ANTHROPIC_MODEL: 'qwen', ANTHROPIC_MODEL_LIGHT: 'deepseek', TAI_LLM_MODEL: 'qwen' };
    routeModel(chat, false);
    expect(chat.TAI_LLM_MODEL).toBe('qwen');
  });

  it('sets ANTHROPIC_MODEL for a scheduled task even where it was not set (the old behaviour)', () => {
    const secrets: Record<string, string> = { ANTHROPIC_MODEL_LIGHT: 'haiku-x' };
    routeModel(secrets, true);
    expect(secrets.ANTHROPIC_MODEL).toBe('haiku-x');
  });
});
