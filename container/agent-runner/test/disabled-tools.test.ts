import { describe, expect, it } from 'vitest';

import { parseDisabledTools, withoutDisabledTools } from '../src/disabled-tools.js';
import { buildMcpServers } from '../src/mcp-servers.js';
import type { ContainerInput } from '../src/protocol.js';

/** What McpServer does with `tool(name, ...)`, as far as the filter can see: it is told the name. */
function fakeServer() {
  const registered: string[] = [];
  return {
    registered,
    tool(name: string, ..._rest: unknown[]) {
      registered.push(name);
      return { name };
    },
  };
}

describe('TAI_DISABLED_TOOLS: the setting', () => {
  it('reads comma separated names, with white space around them', () => {
    expect([...parseDisabledTools('youtube_info,youtube_transcript')]).toEqual(['youtube_info', 'youtube_transcript']);
    expect([...parseDisabledTools(' youtube_info , send_voice_message\n, generate_teaching_image ,')]).toEqual([
      'youtube_info',
      'send_voice_message',
      'generate_teaching_image',
    ]);
  });

  it('is empty when nothing is set', () => {
    expect(parseDisabledTools(undefined).size).toBe(0);
    expect(parseDisabledTools('').size).toBe(0);
    expect(parseDisabledTools(' , ,').size).toBe(0);
  });

  it('takes the name the harness shows as well, and drops what is not a name', () => {
    expect([...parseDisabledTools('mcp__nanoclaw__youtube_info,not-a-name!,youtube_info,../x')]).toEqual(['youtube_info']);
  });

  it('reads names separated by white space only as well (a missing comma must not leave a tool on)', () => {
    expect([...parseDisabledTools('youtube_info youtube_transcript')]).toEqual(['youtube_info', 'youtube_transcript']);
  });
});

describe('TAI_DISABLED_TOOLS: the registration', () => {
  it('does not register a disabled tool and registers the others as before', () => {
    const server = fakeServer();
    const heard: string[] = [];
    const same = withoutDisabledTools(server, parseDisabledTools('youtube_info,send_voice_message'), (name) => heard.push(name));
    expect(same).toBe(server);

    expect(server.tool('send_message', 'text', {}, async () => ({}))).toEqual({ name: 'send_message' }); // the others answer as they did
    server.tool('youtube_info', 'text', {}, async () => ({}));
    server.tool('canvas_query', 'text', {}, async () => ({}));
    server.tool('send_voice_message', 'text', {}, async () => ({}));
    expect(server.registered).toEqual(['send_message', 'canvas_query']);
    expect(heard).toEqual(['youtube_info', 'send_voice_message']);
  });

  it('leaves the server alone when nothing is disabled', () => {
    const server = fakeServer();
    const before = server.tool;
    withoutDisabledTools(server, new Set());
    expect(server.tool).toBe(before);
    server.tool('youtube_info');
    expect(server.registered).toEqual(['youtube_info']);
  });

  it('passes the whole call on, so the tool keeps its description, schema and handler', () => {
    const calls: unknown[][] = [];
    const server = {
      tool(...args: unknown[]) {
        calls.push(args);
        return undefined;
      },
    };
    withoutDisabledTools(server, new Set(['gone']));
    const schema = { text: 'z.string()' };
    const handler = async () => ({});
    server.tool('kept', 'its description', schema, handler);
    expect(calls).toEqual([['kept', 'its description', schema, handler]]);
  });
});

describe('TAI_DISABLED_TOOLS: how it reaches the server', () => {
  const input = { prompt: '', groupFolder: 'student', chatJid: 'web:student', isMain: false } as ContainerInput;

  it('is handed to the nanoclaw server from the settings the runner holds (the .env secrets or the container environment)', () => {
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { TAI_DISABLED_TOOLS: 'youtube_info,youtube_transcript' });
    expect(servers.nanoclaw.env['TAI_DISABLED_TOOLS']).toBe('youtube_info,youtube_transcript');
  });

  it('is not set for the server when it is not set', () => {
    const servers = buildMcpServers('/app/dist/ipc-mcp-stdio.js', input, { GITHUB_ALLOWED_ORGS: 'cs6650-course' });
    expect('TAI_DISABLED_TOOLS' in servers.nanoclaw.env).toBe(false);
  });
});

// The real McpServer, where the MCP SDK is installed (the container's own node_modules; the repository's root install has none).
const sdk = await (async () => {
  try {
    const load = (name: string) => import(/* @vite-ignore */ name);
    const [{ McpServer }, { Client }, { InMemoryTransport }, { z }] = await Promise.all([
      load('@modelcontextprotocol/sdk/server/mcp.js'),
      load('@modelcontextprotocol/sdk/client/index.js'),
      load('@modelcontextprotocol/sdk/inMemory.js'),
      load('zod'),
    ]);
    return { McpServer, Client, InMemoryTransport, z };
  } catch {
    return null;
  }
})();

describe.skipIf(!sdk)('TAI_DISABLED_TOOLS: with the real McpServer', () => {
  it('lists the tools that are left, and a call to a disabled one fails', async () => {
    const { McpServer, Client, InMemoryTransport, z } = sdk!;
    const server = new McpServer({ name: 'nanoclaw', version: '1.0.0' });
    withoutDisabledTools(server, parseDisabledTools('youtube_info,send_voice_message'));
    const answer = (text: string) => async () => ({ content: [{ type: 'text' as const, text }] });
    server.tool('send_message', 'send', { text: z.string() }, answer('sent'));
    server.tool('youtube_info', 'dropped', { url: z.string() }, answer('video'));
    server.tool('send_voice_message', 'dropped', { text: z.string() }, answer('voice'));
    server.tool('canvas_query', 'kept', { action: z.string() }, answer('canvas'));

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(['canvas_query', 'send_message']);

      const kept = await client.callTool({ name: 'canvas_query', arguments: { action: 'x' } });
      expect(kept).toMatchObject({ content: [{ type: 'text', text: 'canvas' }] });
      // an unknown tool is an error either way the SDK reports it: a rejected call or an isError result
      const dropped = await client.callTool({ name: 'youtube_info', arguments: { url: 'https://example.test/' } }).catch((err: unknown) => ({ isError: true, err }));
      expect(dropped).toMatchObject({ isError: true });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
