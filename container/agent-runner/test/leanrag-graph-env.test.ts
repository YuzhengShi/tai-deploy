import { describe, expect, it } from 'vitest';

import { LEANRAG_GRAPH_DIR, buildMcpServers } from '../src/mcp-servers.js';
import type { ContainerInput } from '../src/protocol.js';

// The knowledge tool's server and the built graph (docs/LEANRAG.md). The host mounts the graph at /workspace/leanrag-graph only when TAI_LEANRAG=1; inside the container its being there is
// the whole switch. These tests pin both halves: with it absent the servers are exactly what they were (deep equality), and with it present the server gets LEANRAG_GRAPH_DIR and is
// registered even without the old graph.pkl flag file.
const input = { prompt: 'hi', groupFolder: 'student', chatJid: 'web:student', isMain: false } as ContainerInput;
const MCP = '/app/dist/ipc-mcp-stdio.js';
const onDisk = (...paths: string[]) => (p: string) => paths.includes(p);

const LEGACY_LEANRAG = { command: '/opt/leanrag/bin/python3', args: ['-m', 'leanrag.mcp_server'], env: { PYTHONPATH: '/workspace' } };

describe('the knowledge tool server with no graph mounted (the switch is off): exactly as before', () => {
  it('is registered by the old flag file, with the same command, arguments and environment', () => {
    const servers = buildMcpServers(MCP, input, {}, onDisk('/workspace/leanrag/graph.pkl'));
    expect(servers.leanrag).toEqual(LEGACY_LEANRAG);
    expect('LEANRAG_GRAPH_DIR' in servers.leanrag.env).toBe(false);
  });

  it('is registered for the admin chat from the project mount the same way', () => {
    const servers = buildMcpServers(MCP, input, {}, onDisk('/workspace/project/leanrag/graph.pkl'));
    expect(servers.leanrag).toEqual({ ...LEGACY_LEANRAG, env: { PYTHONPATH: '/workspace/project' } });
  });

  it('is not registered without the flag file, and the code being there is not enough', () => {
    expect(buildMcpServers(MCP, input, {}, onDisk()).leanrag).toBeUndefined();
    expect(buildMcpServers(MCP, input, {}, onDisk('/workspace/leanrag/mcp_server.py')).leanrag).toBeUndefined();
  });

  it('passes the AWS settings it always passed', () => {
    const servers = buildMcpServers(MCP, input, { AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'AKIA-test' }, onDisk('/workspace/leanrag/graph.pkl'));
    expect(servers.leanrag.env).toEqual({ PYTHONPATH: '/workspace', AWS_REGION: 'us-west-2', AWS_ACCESS_KEY_ID: 'AKIA-test' });
  });

  it('is what the three-argument call gives on a machine with none of these folders (the call every other caller makes)', () => {
    expect(buildMcpServers(MCP, input, {}).leanrag).toBeUndefined();
  });
});

describe('the knowledge tool server with a built graph mounted (the switch is on)', () => {
  const graph = `${LEANRAG_GRAPH_DIR}/manifest.json`;

  it('hands the server the graph folder and keeps everything else the same', () => {
    const servers = buildMcpServers(MCP, input, {}, onDisk(graph, '/workspace/leanrag/graph.pkl'));
    expect(servers.leanrag).toEqual({ ...LEGACY_LEANRAG, env: { PYTHONPATH: '/workspace', LEANRAG_GRAPH_DIR: '/workspace/leanrag-graph' } });
    expect(LEANRAG_GRAPH_DIR).toBe('/workspace/leanrag-graph');
  });

  it('registers the server from the code alone, so a host that has no graph.pkl flag still serves the graph', () => {
    const servers = buildMcpServers(MCP, input, {}, onDisk(graph, '/workspace/leanrag/mcp_server.py'));
    expect(servers.leanrag.env.LEANRAG_GRAPH_DIR).toBe('/workspace/leanrag-graph');
    expect(servers.leanrag.env.PYTHONPATH).toBe('/workspace');
  });

  it('registers nothing when the graph is mounted but there is no code to serve it', () => {
    expect(buildMcpServers(MCP, input, {}, onDisk(graph)).leanrag).toBeUndefined();
  });

  it('does not touch the nanoclaw server: its environment is the same with the graph and without', () => {
    const without = buildMcpServers(MCP, input, { CANVAS_API_TOKEN: 't' }, onDisk('/workspace/leanrag/graph.pkl'));
    const withGraph = buildMcpServers(MCP, input, { CANVAS_API_TOKEN: 't' }, onDisk(graph, '/workspace/leanrag/graph.pkl'));
    expect(withGraph.nanoclaw).toEqual(without.nanoclaw);
  });

  it('keeps the graph folder out of the voice tool host and the text agent alike: both call this one function', () => {
    const toolHost = buildMcpServers(MCP, input, { TAI_MODE: 'tool-host' }, onDisk(graph, '/workspace/leanrag/graph.pkl'));
    expect(toolHost.leanrag.env.LEANRAG_GRAPH_DIR).toBe('/workspace/leanrag-graph');
  });
});
