import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

import { buildMcpServers } from '../src/mcp-servers.js';
import { mcpEntries } from '../src/pi-support.js';
import type { ContainerInput } from '../src/protocol.js';

// Every value deploy/cs6650/tai_credentials.sh stores must reach the nanoclaw MCP server (Canvas, GitHub and Piazza tools) as typed, through
// the host's .env reader, the container's secrets and pi's own resolver of config values (which expands $VAR and runs !commands).
const CREDENTIALS = [
  'CANVAS_API_TOKEN', 'CANVAS_BASE_URL', 'CANVAS_COURSE_ID',
  'GITHUB_TOKEN', 'GITHUB_TOKEN_PUBLIC', 'GITHUB_BASE_URL', 'GITHUB_BASE_URL_PUBLIC', 'GITHUB_ALLOWED_ORGS',
  'PIAZZA_EMAIL', 'PIAZZA_PASSWORD', 'PIAZZA_NETWORK_ID',
];
const NASTY = ['1~a$b"c\'d#e!f\\g`h$(id)${HOME}=x', '!echo pwned', '$HOME', '${PATH}', 'pa$$word!', '  spaced  ', '$!x'];

const input: ContainerInput = { prompt: 'hi', groupFolder: 'student', chatJid: 'web:student', isMain: false } as ContainerInput;

describe('the credentials reach the MCP server as typed', () => {
  it('hands every stored credential to the nanoclaw server', () => {
    const sdkEnv = Object.fromEntries(CREDENTIALS.map((name) => [name, `value-of-${name}`]));
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, sdkEnv);
    for (const name of CREDENTIALS) expect(servers.nanoclaw.env[name], name).toBe(`value-of-${name}`);
  });

  it('keeps them intact through pi\'s config resolver, hostile characters included', async () => {
    const file = path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js');
    if (!fs.existsSync(file)) return; // pi is not installed where the tests run
    const { resolveConfigValue } = (await import(pathToFileURL(file).href)) as { resolveConfigValue: (c: string, env?: Record<string, string>) => string | undefined };
    for (const nasty of NASTY) {
      const sdkEnv = Object.fromEntries(CREDENTIALS.map((name) => [name, nasty]));
      const [entry] = mcpEntries(buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, sdkEnv));
      for (const name of CREDENTIALS) {
        expect(resolveConfigValue(entry.config.env![name], { HOME: '/leaked', PATH: '/leaked' }), `${name} = ${JSON.stringify(nasty)}`).toBe(nasty);
      }
    }
  });
});
