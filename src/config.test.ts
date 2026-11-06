import { afterEach, describe, expect, it, vi } from 'vitest';

describe('container naming settings', () => {
  afterEach(() => {
    delete process.env.CONTAINER_PREFIX;
    delete process.env.CONTAINER_NETWORK;
    vi.resetModules();
  });

  it('keeps the historical names unless told otherwise', async () => {
    const config = await import('./config.js');
    expect(config.CONTAINER_PREFIX).toBe('nanoclaw');
    expect(config.CONTAINER_NETWORK).toBe('nanoclaw-net');
  });

  it('takes a prefix and a network from the environment', async () => {
    process.env.CONTAINER_PREFIX = 'tailive';
    process.env.CONTAINER_NETWORK = 'tai-live-net';
    const config = await import('./config.js');
    expect(config.CONTAINER_PREFIX).toBe('tailive');
    expect(config.CONTAINER_NETWORK).toBe('tai-live-net');
  });

  it('refuses a prefix that could make the stale-container filter match more than its own containers', async () => {
    for (const bad of ['a b', 'x.y', 'a|b', '-lead', '^x', 'x'.repeat(40), '$(id)']) {
      process.env.CONTAINER_PREFIX = bad;
      vi.resetModules();
      await expect(import('./config.js'), bad).rejects.toThrow(/CONTAINER_PREFIX/);
    }
  });

  it('refuses a network name docker would not accept', async () => {
    process.env.CONTAINER_NETWORK = 'two words';
    await expect(import('./config.js')).rejects.toThrow(/CONTAINER_NETWORK/);
  });
});
