import { describe, expect, it } from 'vitest';

import { buildMcpServers } from '../src/mcp-servers.js';
import { mcpEntries } from '../src/pi-support.js';
import type { ContainerInput } from '../src/protocol.js';

// The orchestrator starts the container with TAI_STUDENT_TZ (src/student-tz.ts). What puts the student's own clock next to a deadline is
// canvas_api.py, which the nanoclaw MCP server runs: the server is started with the environment buildMcpServers gives it, and pi hands an MCP
// server only that, so the variable must be named there or `due_local` never appears in a real container.
const input = { prompt: 'hi', groupFolder: 'student', chatJid: 'web:student', isMain: false } as ContainerInput;

describe('the student\'s time zone reaches the nanoclaw MCP server', () => {
  it('hands the zone to the server that runs the Canvas script', () => {
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { TAI_STUDENT_TZ: 'America/Vancouver', CANVAS_API_TOKEN: 'x' });
    expect(servers.nanoclaw.env.TAI_STUDENT_TZ).toBe('America/Vancouver');
  });

  it('sets nothing when the container was not given one (the Canvas answers are then what they always were)', () => {
    for (const sdkEnv of [{}, { TAI_STUDENT_TZ: '' }, { TAI_STUDENT_TZ: undefined }]) {
      const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, sdkEnv);
      expect('TAI_STUDENT_TZ' in servers.nanoclaw.env).toBe(false);
    }
  });

  it('is unchanged by pi\'s config-value escaping (an IANA name has no "$" and no leading "!")', () => {
    for (const zone of ['America/Vancouver', 'Asia/Kolkata', 'Etc/GMT+7', 'America/Port-au-Prince']) {
      const [entry] = mcpEntries(buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { TAI_STUDENT_TZ: zone }));
      expect(entry.config.env.TAI_STUDENT_TZ).toBe(zone);
    }
  });
});
