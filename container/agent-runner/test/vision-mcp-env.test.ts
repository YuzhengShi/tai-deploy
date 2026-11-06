import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

import { buildMcpServers } from '../src/mcp-servers.js';
import { escapeConfigValue, mcpEntries } from '../src/pi-support.js';
import { secretEnvNames } from '../src/guards.js';
import type { ContainerInput } from '../src/protocol.js';
import { visionConfigFromEnv } from '../src/vision.js';

// look_at_image (docs/VISION.md) needs the gateway the model already uses, its key and the alias that looks at pictures, and only the nanoclaw MCP server
// runs it. The host starts a student's chat container with TAI_VISION=1 (src/vision-env.ts) and hands over the gateway's settings as secrets, as for the
// model; buildMcpServers turns them into the server's own settings. The voice tool host runs the same function and must get nothing.
const input = { prompt: 'hi', groupFolder: 'student', chatJid: 'web:student', isMain: false } as ContainerInput;
const gateway = { ANTHROPIC_BASE_URL: 'http://tai-live-litellm:4000', ANTHROPIC_AUTH_TOKEN: 'gateway-key-$1!', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek' };
const VISION_NAMES = ['TAI_VISION_URL', 'TAI_VISION_API_KEY', 'TAI_VISION_MODEL'];

describe('the picture tool\'s settings reach the nanoclaw MCP server', () => {
  it('gives it the gateway\'s completions URL, the key the model already presents and the alias, when the host turned the tool on', () => {
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { ...gateway, TAI_VISION: '1', TAI_VISION_MODEL: 'glm-vision' });
    expect(servers.nanoclaw.env.TAI_VISION_URL).toBe('http://tai-live-litellm:4000/v1/chat/completions');
    expect(servers.nanoclaw.env.TAI_VISION_API_KEY).toBe('gateway-key-$1!');
    expect(servers.nanoclaw.env.TAI_VISION_MODEL).toBe('glm-vision');
    expect(visionConfigFromEnv(servers.nanoclaw.env)).toEqual({ url: 'http://tai-live-litellm:4000/v1/chat/completions', apiKey: 'gateway-key-$1!', model: 'glm-vision' });
  });

  it('uses the default alias when the host named none', () => {
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { ...gateway, TAI_VISION: '1' });
    expect(servers.nanoclaw.env.TAI_VISION_MODEL).toBe('glm-vision');
  });

  it('gives it nothing, and so the tool is not offered, unless TAI_VISION is exactly 1', () => {
    for (const flag of [undefined, '', '0', 'true', ' 1']) {
      const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { ...gateway, TAI_VISION: flag });
      for (const name of VISION_NAMES) expect(name in servers.nanoclaw.env, `${name} for ${JSON.stringify(flag)}`).toBe(false);
    }
  });

  it('gives it nothing without a gateway or a key', () => {
    for (const sdkEnv of [{ TAI_VISION: '1' }, { TAI_VISION: '1', ANTHROPIC_BASE_URL: gateway.ANTHROPIC_BASE_URL }, { TAI_VISION: '1', ANTHROPIC_AUTH_TOKEN: 'k' }]) {
      const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, sdkEnv);
      for (const name of VISION_NAMES) expect(name in servers.nanoclaw.env).toBe(false);
    }
  });

  it('gives the voice tool host nothing, which has the same container and runs this same function: not the key, not the address, not the alias', () => {
    const toolHost = { ...gateway, TAI_VISION: '1', TAI_VISION_MODEL: 'glm-vision', TAI_MODE: 'tool-host' };
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, toolHost);
    for (const name of VISION_NAMES) expect(name in servers.nanoclaw.env, name).toBe(false);
    expect(JSON.stringify(servers)).not.toContain('gateway-key');
    // and a server that was started with the settings in a tool host still offers no tool
    expect(visionConfigFromEnv({ ...servers.nanoclaw.env, TAI_MODE: 'tool-host', TAI_VISION_URL: 'http://g/v1/chat/completions', TAI_VISION_API_KEY: 'k' })).toBeNull();
  });

  it('puts the gateway\'s key in no other server: LeanRAG is started without it', () => {
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { ...gateway, TAI_VISION: '1' });
    for (const [name, spec] of Object.entries(servers)) {
      if (name === 'nanoclaw') continue;
      expect(JSON.stringify(spec), name).not.toContain('gateway-key');
    }
  });

  it('reaches the server as typed through pi\'s config resolver (which expands $VAR and runs !commands), a key with "$" and a leading "!" included', async () => {
    const file = path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js');
    for (const key of ['gateway-key-$1!', '!echo pwned', '$HOME', '${PATH}', 'pa$$word']) {
      const [entry] = mcpEntries(buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { ...gateway, ANTHROPIC_AUTH_TOKEN: key, TAI_VISION: '1' }));
      expect(entry.config.env.TAI_VISION_API_KEY, key).toBe(escapeConfigValue(key));                       // the same escaping every other value of the server gets
      if (!fs.existsSync(file)) continue;                                                                 // pi is not installed where the tests run
      const { resolveConfigValue } = (await import(pathToFileURL(file).href)) as { resolveConfigValue: (c: string, env?: Record<string, string>) => string | undefined };
      expect(resolveConfigValue(entry.config.env.TAI_VISION_API_KEY, { HOME: '/leaked', PATH: '/leaked' }), key).toBe(key);
    }
  });

  it('is a name that anything which hides credentials from a shell hides too', () => {
    const names = secretEnvNames({ ANTHROPIC_AUTH_TOKEN: 'x' }, { TAI_VISION_API_KEY: 'x', TAI_VISION_URL: 'http://g', TAI_VISION_MODEL: 'glm-vision' });
    expect(names).toContain('TAI_VISION_API_KEY');
  });
});
