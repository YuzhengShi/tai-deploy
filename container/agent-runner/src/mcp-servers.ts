/**
 * The MCP servers of an agent container, the same for both harnesses: the nanoclaw tools (ipc-mcp-stdio.js: messages, tasks, Canvas,
 * GitHub, YouTube, memory ...) and, where the LeanRAG graph is mounted, the LeanRAG search. Credentials are handed to the server process
 * that needs them, not to the agent's own environment.
 */

import fs from 'fs';
import path from 'path';
import type { ContainerInput } from './protocol.js';
import { log } from './protocol.js';
import { visionServerEnv } from './vision.js';

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Where the host mounts a built course knowledge graph (src/leanrag-graph.ts GRAPH_CONTAINER_PATH). */
export const LEANRAG_GRAPH_DIR = '/workspace/leanrag-graph';

export function buildMcpServers(
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  fileExists: (p: string) => boolean = (p) => fs.existsSync(p),   // (a seam for the tests: what the container's file system has)
): Record<string, McpServerSpec> {
  // AWS credentials for MCP tools that call boto3 scripts (tts.py, image_gen.py)
  const awsEnv = Object.fromEntries(
    ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID',
     'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']
      .filter(k => sdkEnv[k])
      .map(k => [k, sdkEnv[k]!])
  );

  const servers: Record<string, McpServerSpec> = {
    nanoclaw: {
      command: 'node',
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        NANOCLAW_IS_SCHEDULED_TASK: containerInput.isScheduledTask ? '1' : '0',
        // 1 only for a scheduled task the host made itself (patrol, bootstrap): the one kind of task whose per-session tool limits are lifted (access.ts; what it may READ is
        // the same as a student's chat's: only the admin chat, NANOCLAW_IS_MAIN, reads the class). Never without the task flag.
        NANOCLAW_IS_SYSTEM_TASK: containerInput.isScheduledTask && containerInput.isSystemTask ? '1' : '0',
        // Identity binding (from trusted DB — containers cannot modify)
        ...(containerInput.canvasUserId ? { NANOCLAW_CANVAS_USER_ID: containerInput.canvasUserId } : {}),
        ...(containerInput.githubUsername ? { NANOCLAW_GITHUB_USERNAME: containerInput.githubUsername } : {}),
        ...awsEnv,
        // Canvas LMS + GitHub integration credentials
        ...(sdkEnv['CANVAS_API_TOKEN'] ? { CANVAS_API_TOKEN: sdkEnv['CANVAS_API_TOKEN'] } : {}),
        ...(sdkEnv['CANVAS_BASE_URL'] ? { CANVAS_BASE_URL: sdkEnv['CANVAS_BASE_URL'] } : {}),
        ...(sdkEnv['CANVAS_COURSE_ID'] ? { CANVAS_COURSE_ID: sdkEnv['CANVAS_COURSE_ID'] } : {}),
        ...(sdkEnv['GITHUB_TOKEN'] ? { GITHUB_TOKEN: sdkEnv['GITHUB_TOKEN'] } : {}),
        ...(sdkEnv['GITHUB_TOKEN_PUBLIC'] ? { GITHUB_TOKEN_PUBLIC: sdkEnv['GITHUB_TOKEN_PUBLIC'] } : {}),
        ...(sdkEnv['GITHUB_BASE_URL'] ? { GITHUB_BASE_URL: sdkEnv['GITHUB_BASE_URL'] } : {}),
        ...(sdkEnv['GITHUB_ALLOWED_ORGS'] ? { GITHUB_ALLOWED_ORGS: sdkEnv['GITHUB_ALLOWED_ORGS'] } : {}),
        // The tools this deployment has dropped, by name (ipc-mcp-stdio.ts does not register them)
        ...(sdkEnv['TAI_DISABLED_TOOLS'] ? { TAI_DISABLED_TOOLS: sdkEnv['TAI_DISABLED_TOOLS'] } : {}),
        // The student's own time zone (the orchestrator sets it from their page's preferences): canvas_api.py puts their clock next to the Pacific one of a deadline
        ...(sdkEnv['TAI_STUDENT_TZ'] ? { TAI_STUDENT_TZ: sdkEnv['TAI_STUDENT_TZ'] } : {}),
        // look_at_image (vision.ts): the gateway the model already uses, its key and the alias that looks at pictures, only for a container the host started
        // for the tool (TAI_VISION=1: a student's own chat, or a voice call's tool host: src/vision-env.ts visionForCall)
        ...visionServerEnv(sdkEnv),
        ...(sdkEnv['YOUTUBE_API_KEY'] ? { YOUTUBE_API_KEY: sdkEnv['YOUTUBE_API_KEY'] } : {}),
        ...(sdkEnv['VOICE_INTERVIEW_SECRET'] ? { VOICE_INTERVIEW_SECRET: sdkEnv['VOICE_INTERVIEW_SECRET'] } : {}),
        ...(sdkEnv['VOICE_BASE_URL'] ? { VOICE_BASE_URL: sdkEnv['VOICE_BASE_URL'] } : {}),
        ...(sdkEnv['VOICE_PORT'] ? { VOICE_PORT: sdkEnv['VOICE_PORT'] } : {}),
        // What the helper scripts of the Piazza, YouTube and GitHub tools read. Claude Code gave its MCP servers its whole environment, so
        // these reached them without being named; pi hands a server only what it is given.
        ...Object.fromEntries(
          ['GITHUB_BASE_URL_PUBLIC', 'PIAZZA_EMAIL', 'PIAZZA_PASSWORD', 'PIAZZA_NETWORK_ID', 'YT_TRANSCRIPT_URL', 'YT_TRANSCRIPT_TOKEN']
            .filter((k) => sdkEnv[k])
            .map((k) => [k, sdkEnv[k]!]),
        ),
      },
    },
  };

  // LeanRAG is at /workspace/leanrag for non-main groups (dedicated mount)
  // or /workspace/project/leanrag for main (project root mount).
  const leanragPaths = ['/workspace/leanrag', '/workspace/project/leanrag'];
  // A built graph (docs/LEANRAG.md) is in the container only when the host mounted it (TAI_LEANRAG=1, src/leanrag-graph.ts): its being here is the switch, and
  // without it nothing below differs from what it was. With it, the code at /workspace/leanrag is enough to register the server (graph.pkl is only the old flag).
  const graphDir = fileExists(`${LEANRAG_GRAPH_DIR}/manifest.json`) ? LEANRAG_GRAPH_DIR : '';
  const leanragRoot = leanragPaths.find(p => fileExists(`${p}/graph.pkl`) || (graphDir !== '' && fileExists(`${p}/mcp_server.py`)));
  if (leanragRoot) {
    log(graphDir ? `LeanRAG registered: ${leanragRoot} with the built graph at ${graphDir}` : `LeanRAG registered: ${leanragRoot}/graph.pkl`);
    servers.leanrag = {
      command: '/opt/leanrag/bin/python3',
      args: ['-m', 'leanrag.mcp_server'],
      env: {
        PYTHONPATH: path.dirname(leanragRoot),
        ...(graphDir ? { LEANRAG_GRAPH_DIR: graphDir } : {}),
        ...awsEnv,
      },
    };
  } else {
    log(`LeanRAG NOT found (checked: ${leanragPaths.join(', ')})`);
  }

  return servers;
}
