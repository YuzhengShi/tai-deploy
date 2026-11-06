/**
 * TAI_DISABLED_TOOLS: the tools of the nanoclaw MCP server this deployment has dropped (the owner dropped YouTube, the Amazon ones
 * and Microsoft), by name, comma separated. ipc-mcp-stdio.ts does not register them, so no harness lists them and the model never
 * sees them; a call to one through the tool host fails as an unknown tool. Kept apart from that file, which starts a server when it is
 * imported, so it can be unit tested.
 */

const SERVER_PREFIX = 'mcp__nanoclaw__';

/** The names in the setting: separated by commas or white space, the harness's own prefix (mcp__nanoclaw__) tolerated, anything that is not a tool name dropped. */
export function parseDisabledTools(value: string | undefined): Set<string> {
  const names = (value || '')
    .split(/[\s,]+/)
    .map((name) => (name.startsWith(SERVER_PREFIX) ? name.slice(SERVER_PREFIX.length) : name))
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name));
  return new Set(names);
}

/** What the server needs to be filtered: McpServer's `tool(name, ...)`, the one place every tool is registered through. */
export interface ToolRegistry {
  tool: (...args: any[]) => unknown;
}

/**
 * Make `server.tool(name, ...)` do nothing for the names in `disabled` (the others register as they did). `onSkip` hears each name that
 * was left out. Returns the server, changed in place; with nothing disabled it is not touched.
 */
export function withoutDisabledTools<T extends ToolRegistry>(server: T, disabled: ReadonlySet<string>, onSkip?: (name: string) => void): T {
  if (disabled.size === 0) return server;
  const register = server.tool.bind(server);
  server.tool = ((name: unknown, ...rest: unknown[]) => {
    if (typeof name === 'string' && disabled.has(name)) {
      onSkip?.(name);
      return undefined;
    }
    return register(name, ...rest);
  }) as unknown as T['tool'];
  return server;
}
