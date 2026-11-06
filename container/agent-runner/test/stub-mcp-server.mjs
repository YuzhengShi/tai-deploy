// A tiny MCP server over stdio for the tool host tests (tool-host.test.ts): two ordinary tools, one that fails, and a few that report
// what the tool host started them with. Needs @modelcontextprotocol/sdk and zod, as the container's own node_modules has them.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'stub', version: '1.0.0' });
const answer = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

server.tool('echo', 'Echo the text back', { text: z.string() }, async ({ text }) => answer(`echo: ${text}`));

server.tool('fail', 'Always fails, the way the nanoclaw tools do: an error result', { reason: z.string().optional() }, async ({ reason }) =>
  answer(`failed on purpose: ${reason ?? 'no reason'}`, true),
);

server.tool('slow', 'Answers after ms milliseconds', { ms: z.number(), text: z.string().optional() }, async ({ ms, text }) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return answer(`slow: ${text ?? 'done'}`);
});

server.tool('pid', 'The process id of this server', {}, async () => answer(String(process.pid)));

server.tool('env', 'The value of an environment variable of this server', { name: z.string() }, async ({ name }) => answer(String(process.env[name] ?? '(unset)')));

server.tool('cwd', 'The working directory of this server', {}, async () => answer(process.cwd()));

server.tool('picture', 'An image and a text', {}, async () => ({
  content: [
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'text', text: 'a picture' },
  ],
}));

await server.connect(new StdioServerTransport());
