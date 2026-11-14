/**
 * The host's side of the course knowledge graph's switch (docs/LEANRAG.md). The switch is `TAI_LEANRAG=1` in the orchestrator's environment, and it is OFF unless it is exactly that.
 * When it is on and a built graph is at `<data>/leanrag/current` (or at `TAI_LEANRAG_DIR`), the agent containers get that folder, read-only, at /workspace/leanrag-graph; the container's
 * MCP server (container/agent-runner/src/mcp-servers.ts) sees it there, and leanrag/query.py answers from it. Nothing else changes: with the switch off this module returns no mount,
 * and the containers, their environment and what the knowledge tool answers are exactly what they were.
 *
 * A folder is mounted only when it is what the build wrote: a real directory (not a link), with a manifest of format 1 that is not marked synthetic (a dry run), graph.json and chunks.jsonl,
 * and not larger than a graph for this course can be. Anything else is "no graph", with the reason in words for the log. Pure: no logger, no clock, nothing written.
 */
import fs from 'fs';
import path from 'path';

export const GRAPH_CONTAINER_PATH = '/workspace/leanrag-graph';
/** The largest a graph folder may be: the corpus is a few hundred slides, a graph of it a few MB. */
export const GRAPH_MAX_BYTES = 64 * 1024 * 1024;
const FILES = ['manifest.json', 'graph.json', 'chunks.jsonl'] as const;

export interface GraphMount {
  hostPath: string;
  containerPath: string;
  readonly: true;
}

export interface GraphDecision {
  /** TAI_LEANRAG is exactly "1". */
  on: boolean;
  mount: GraphMount | null;
  /** Why there is no mount, when the switch is on (for the log); empty when there is one or the switch is off. */
  reason: string;
}

export function leanragGraphMount(env: Record<string, string | undefined>, dataDir: string, fsLike: Pick<typeof fs, 'lstatSync' | 'readFileSync' | 'realpathSync' | 'statSync'> = fs): GraphDecision {
  if (env.TAI_LEANRAG !== '1') return { on: false, mount: null, reason: '' };
  const dir = env.TAI_LEANRAG_DIR ? path.resolve(env.TAI_LEANRAG_DIR) : path.join(dataDir, 'leanrag', 'current');
  const none = (reason: string): GraphDecision => ({ on: true, mount: null, reason });
  let st;
  try {
    st = fsLike.lstatSync(dir);
  } catch {
    return none(`no graph folder at ${dir}`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return none(`${dir} is not a real directory`);
  let total = 0;
  for (const name of FILES) {
    try {
      const f = fsLike.lstatSync(path.join(dir, name));
      if (!f.isFile()) return none(`${name} is not a plain file`);
      total += f.size;
    } catch {
      return none(`${name} is missing from ${dir}`);
    }
  }
  if (total > GRAPH_MAX_BYTES) return none(`the graph folder is ${total} bytes, over the ${GRAPH_MAX_BYTES} limit`);
  let manifest: { format?: unknown; synthetic?: unknown };
  try {
    manifest = JSON.parse(String(fsLike.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
  } catch {
    return none('manifest.json is not JSON');
  }
  if (!manifest || manifest.format !== 1) return none('the graph is not format 1');
  if (manifest.synthetic) return none('the graph is synthetic (a dry run)');
  let real: string;
  try {
    real = fsLike.realpathSync(dir);
  } catch {
    return none(`cannot resolve ${dir}`);
  }
  return { on: true, mount: { hostPath: real, containerPath: GRAPH_CONTAINER_PATH, readonly: true }, reason: '' };
}
