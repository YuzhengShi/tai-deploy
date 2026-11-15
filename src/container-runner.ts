/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Docker container and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_NETWORK,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_PREFIX,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { leanragGraphMount } from './leanrag-graph.js';
import { logger } from './logger.js';
import { buildMemoryContext, buildMemoryExport, pruneExpiredMemories } from './memory.js';
import { routeModel } from './model-route.js';
import { validateAdditionalMounts } from './mount-security.js';
import { writeFileAtomicSafe } from './safe-fs.js';
import { studentTimeZone } from './student-tz.js';
import { PROGRESS_MARKER, parseProgressLine, portalStreamOn, withoutTextEvents, type ProgressEvent } from './turn-status.js';
import { RegisteredGroup } from './types.js';
import { visionFor, visionForCall, type VisionLaunch } from './vision-env.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  // With isScheduledTask: the host itself made this task (the patrol, the bootstrap: src/task-origin.ts), the only kind whose container has its per-session tool limits
  // lifted. It reads no more than a student's chat does (only the admin chat reads the class). A task an agent scheduled is a scheduled task without this.
  isSystemTask?: boolean;
  secrets?: Record<string, string>;
  // Identity binding (from trusted DB, not student-writable files)
  canvasUserId?: string;
  githubUsername?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  // The runner retired the session (context overflow, or it had its turns): forget it, the next container starts a new one
  resetSession?: boolean;
  error?: string;
  // The model request failed and `result` is the runner's apology to the student, not an answer (the status stays "success": a chat shows it)
  apiFailure?: 'overflow' | 'busy' | 'auth' | 'other';
  // The runner has finished what it was asked and waits for the next message
  idle?: boolean;
  // With `idle`: how many follow-up messages the runner has received so far. GroupQueue.markIdle compares it with what was piped: a marker that
  // counts fewer is out of date (a message is on its way to the runner), and the container is busy. Absent: an image that does not count.
  received?: number;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain && process.env.TAI_ADMIN_FULL_PROJECT !== '1') {
    // The admin group here (the owner's second chat on the student page) gets what an instructor needs to look at the class, read-only: every
    // student's COMPETENCY.md and notes, the database and the chat histories, the audit log; and its own folder to write in. Not the project
    // root (the source, the .env with every token) and not other groups' sessions or IPC: this agent reads text that students write, and must
    // not be one prompt away from the keys. TAI_ADMIN_FULL_PROJECT=1 brings back the original's whole-project mount.
    const readOnly: Array<[string, string]> = [
      ['groups', GROUPS_DIR],
      ['store', STORE_DIR],
      ['data/audit', path.join(DATA_DIR, 'audit')],
    ];
    for (const [name, hostDir] of readOnly) {
      try {
        mounts.push({ hostPath: fs.realpathSync(hostDir), containerPath: `/workspace/project/${name}`, readonly: true });
      } catch {
        // not there yet (no audit log before the first admin operation) — skip
      }
    }
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // EC2 uses symlinks (groups/→/data/groups/, data/→/data/data/).
    // Docker preserves symlinks inside bind mounts but their targets don't
    // exist in the container. Mount the resolved targets at the same absolute
    // path so the symlinks resolve naturally inside the container.
    for (const [name, hostDir] of [['groups', GROUPS_DIR], ['data', DATA_DIR], ['store', STORE_DIR]] as const) {
      try {
        const resolved = fs.realpathSync(hostDir);
        if (resolved !== path.resolve(projectRoot, name)) {
          mounts.push({
            hostPath: resolved,
            containerPath: resolved,
            readonly: false,
          });
        }
      } catch {
        // Directory doesn't exist yet — skip
      }
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Docker bind mounts work with both files and directories
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  // (this directory is the container's too: a link planted where a file of the host's is written would be followed, so these writes refuse one: src/safe-fs.ts)
  if (!fs.existsSync(settingsFile)) {
    try {
      writeFileAtomicSafe(settingsFile, JSON.stringify({
        env: {
          // Enable agent swarms (subagent orchestration)
          // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          // Load CLAUDE.md from additional mounted directories
          // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          // Enable Claude's memory feature (persists user preferences between sessions)
          // https://code.claude.com/docs/en/memory#manage-auto-memory
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      }, null, 2) + '\n', groupSessionsDir);
    } catch (err) {
      logger.warn({ group: group.folder, err: (err as Error).message }, 'The group\'s Claude settings file was not written');
    }
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        try {
          writeFileAtomicSafe(dstFile, fs.readFileSync(srcFile), groupSessionsDir);   // not copyFileSync: it would write through a link the container planted
        } catch (err) {
          logger.warn({ group: group.folder, skill: skillDir, file, err: (err as Error).message }, 'A skill file was not copied into the group\'s sessions directory');
        }
      }
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Bedrock is configured via env vars (CLAUDE_CODE_USE_BEDROCK=1 + ANTHROPIC_MODEL)
  // injected through readSecrets() below. No .claude.json mount needed — mounting it
  // suppresses the env-var config and breaks the Bedrock connection.

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  // the host's answers to the container's task requests (src/ipc.ts answer(): the container's tools wait for a file here); made here, with the others, so the
  // watcher never has to make a directory that the container can replace
  fs.mkdirSync(path.join(groupIpcDir, 'results'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Mount agent-runner source from host — recompiled on container startup.
  // Bypasses Apple Container's sticky build cache for code changes.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // LeanRAG knowledge graph (read-only, shared across all groups)
  const leanragDir = path.join(projectRoot, 'leanrag');
  // A built graph (docs/LEANRAG.md): only with TAI_LEANRAG=1 and a graph folder the build wrote. Off, this is no mount and the lines below are what they were.
  const graph = leanragGraphMount(process.env, DATA_DIR);
  if (graph.on && !graph.mount) logger.warn({ reason: graph.reason }, 'TAI_LEANRAG=1 but no graph is mounted');
  if (fs.existsSync(path.join(leanragDir, 'graph.pkl')) || graph.mount) {
    mounts.push({
      hostPath: leanragDir,
      containerPath: '/workspace/leanrag',
      readonly: true,
    });
  }
  if (graph.mount) mounts.push(graph.mount);

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/** Cache for instance role credentials (refreshed when expiring). */
let cachedInstanceCreds: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: string } | null = null;

async function fetchInstanceRoleCreds(): Promise<typeof cachedInstanceCreds> {
  // Return cached if still valid. Refresh 35 min before expiry so containers
  // (up to 30 min timeout) never run with expired credentials.
  if (cachedInstanceCreds) {
    const expiresAt = new Date(cachedInstanceCreds.expiration).getTime();
    if (Date.now() < expiresAt - 35 * 60 * 1000) return cachedInstanceCreds;
  }
  try {
    const res = await fetch('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
    if (!res.ok) return null;
    const roleName = (await res.text()).trim();
    const credsRes = await fetch(`http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`);
    if (!credsRes.ok) return null;
    const data = await credsRes.json() as any;
    cachedInstanceCreds = {
      accessKeyId: data.AccessKeyId,
      secretAccessKey: data.SecretAccessKey,
      sessionToken: data.Token,
      expiration: data.Expiration,
    };
    return cachedInstanceCreds;
  } catch {
    return null;
  }
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 * Also picks up AWS credentials from process.env or EC2 instance role.
 */
async function readSecrets(useLight = false): Promise<Record<string, string>> {
  const secrets = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_MODEL_LIGHT',
    // A gateway in front of another provider (LiteLLM -> Cerebras): where Claude Code sends its requests, the key it
    // presents, and the name every model slot resolves to. Without the slots Claude Code's background calls ask for
    // its own default model names and fail at the gateway.
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    // How long the CLI keeps retrying a failed model request and waits for one response (the runner defaults them to 3 and 120000),
    // and when the runner retires a session (answers, context tokens; defaults 25 and 90000)
    'CLAUDE_CODE_MAX_RETRIES',
    'API_TIMEOUT_MS',
    'TAI_MAX_TURNS_PER_SESSION',
    'TAI_MAX_CONTEXT_TOKENS',
    // pi (the default harness) reads the same gateway settings; these override them (container/agent-runner/src/pi-support.ts)
    'TAI_LLM_API',
    'TAI_LLM_BASE_URL',
    'TAI_LLM_API_KEY',
    'TAI_LLM_MODEL',
    'TAI_LLM_CONTEXT_WINDOW',
    'TAI_LLM_MAX_TOKENS',
    'DISABLE_TELEMETRY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_AUTOUPDATER',
    'CANVAS_API_TOKEN',
    'CANVAS_BASE_URL',
    'CANVAS_COURSE_ID',
    'GITHUB_TOKEN',
    'GITHUB_TOKEN_PUBLIC',
    'GITHUB_BASE_URL',
    'GITHUB_BASE_URL_PUBLIC',
    'YOUTUBE_API_KEY',
    'YT_TRANSCRIPT_URL',
    'YT_TRANSCRIPT_TOKEN',
    'VOICE_INTERVIEW_SECRET',
    'VOICE_PORT',
    'VOICE_BASE_URL',
    'GITHUB_ALLOWED_ORGS',
    'TAI_DISABLED_TOOLS',
    'MS_EMAIL',
    'MS_PASSWORD',
    'PIAZZA_EMAIL',
    'PIAZZA_PASSWORD',
    'PIAZZA_NETWORK_ID',
  ]);

  // Fall back to process.env for AWS credentials (e.g. AWS sandbox/EC2 roles)
  const awsKeys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION'];
  for (const key of awsKeys) {
    if (!secrets[key] && process.env[key]) {
      secrets[key] = process.env[key]!;
    }
  }

  // Fall back to EC2 instance role metadata service (auto-rotating credentials)
  if (!secrets.AWS_ACCESS_KEY_ID) {
    const creds = await fetchInstanceRoleCreds();
    if (creds) {
      secrets.AWS_ACCESS_KEY_ID = creds.accessKeyId;
      secrets.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
      secrets.AWS_SESSION_TOKEN = creds.sessionToken;
    }
  }

  // Auto-enable Bedrock mode when AWS credentials are present but no Anthropic key
  const hasAnthropicKey = !!(secrets.ANTHROPIC_API_KEY || secrets.ANTHROPIC_AUTH_TOKEN || secrets.CLAUDE_CODE_OAUTH_TOKEN);
  const hasAwsCreds = !!(secrets.AWS_ACCESS_KEY_ID);
  if (hasAwsCreds && !hasAnthropicKey) {
    secrets['CLAUDE_CODE_USE_BEDROCK'] = '1';
    if (!secrets['ANTHROPIC_MODEL']) {
      secrets['ANTHROPIC_MODEL'] = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
    }
  }

  // Model routing: the scheduled tasks use the background model (ANTHROPIC_MODEL_LIGHT) when one is set; see model-route.ts for why every name is routed
  routeModel(secrets, useLight);

  return secrets;
}

/**
 * The harness that runs the conversation inside the container: pi (the default) or Claude Code (TAI_HARNESS=claude in .env or in the
 * orchestrator's environment, read at every spawn). Both speak the same container protocol; see container/entrypoint.sh.
 */
export function agentHarness(): 'pi' | 'claude' {
  const value = (readEnvFile(['TAI_HARNESS']).TAI_HARNESS || process.env.TAI_HARNESS || '').trim().toLowerCase();
  return value === 'claude' ? 'claude' : 'pi';
}

/**
 * Whether this run's container is asked to stream the reply it writes (TAI_PORTAL_STREAM=1 in the orchestrator's environment, off by default): only
 * for a student's chat on the web page, never the admin chat, a scheduled task, a chat of another channel or a voice call's tool host. The runner
 * writes text events only when it is started with the variable, and the host reads them only from a container that was (parseProgressLine).
 */
function streamsReply(input: ContainerInput): boolean {
  return portalStreamOn() && !input.isMain && input.isScheduledTask !== true && input.chatJid.startsWith('web:');
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string, isMain: boolean, studentTz?: string, streamText = false, vision: VisionLaunch | null = null): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Pass host timezone so the Claude Code preset's date injection is correct
  args.push('-e', `TZ=${TIMEZONE}`);

  // The student's own time zone (their page told us; validated by src/portal/prefs.ts), so a deadline can be told on their clock as well as in
  // Pacific (canvas_api.py: due_local). Not set when they have not said or it is no zone: the answers are then what they always were.
  if (studentTz) args.push('-e', `TAI_STUDENT_TZ=${studentTz}`);

  // The reply is written to the page as the model writes it (docs/STREAMING.md): the runner says nothing of it unless it is started with this
  if (streamText) args.push('-e', 'TAI_PORTAL_STREAM=1');

  // The picture tool (TAI_VISION, docs/VISION.md): a student's chat container is told it is on, and which gateway alias looks at pictures (a plain name, checked
  // by src/vision-env.ts). No key here: `docker run` arguments are logged at debug; the gateway's key is the one the model already uses, handed over as a secret on stdin.
  if (vision) {
    args.push('-e', 'TAI_VISION=1');
    if (vision.model) args.push('-e', `TAI_VISION_MODEL=${vision.model}`);
  }

  // Development: compile the mounted agent-runner source at start instead of running the dist built into the image
  if (process.env.TAI_COMPILE_ON_START === '1') args.push('-e', 'TAI_COMPILE_ON_START=1');

  // Which harness runs the conversation in the container (entrypoint.sh picks the runner by it)
  args.push('-e', `TAI_HARNESS=${agentHarness()}`);

  // The image has ONNX Runtime in it (PyMuPDF 2.0, which reads every PDF and Office file here, imports it), and the pip builds report to Microsoft's collector from the moment they are imported unless
  // told not to (measured for 1.32.0 on 2026-11-14, docs/LOCAL_VOICE.md, the opening section; the agent image holds 1.31.1, not measured, and carries the same collector strings). Off for every container this function starts: the text agent,
  // the scheduled tasks and the voice tool host, whatever image tag is run, with no rebuild.
  args.push('-e', 'ORT_DISABLE_TELEMETRY=1');

  // Resource limits — prevent runaway containers from exhausting host
  args.push('--memory', CONTAINER_MEMORY_LIMIT);
  args.push('--cpus', CONTAINER_CPU_LIMIT);
  args.push('--pids-limit', CONTAINER_PIDS_LIMIT);

  // Prevent privilege escalation inside container
  args.push('--security-opt', 'no-new-privileges');

  // Drop all Linux capabilities — minimizes kernel attack surface for container escape
  args.push('--cap-drop', 'ALL');

  // Limit /tmp to 512MB with noexec to prevent disk exhaustion and code execution
  args.push('--tmpfs', '/tmp:size=512m,noexec');

  // Network: CONTAINER_NETWORK (default nanoclaw-net: inter-container access for the gateway, yt-transcript-api etc.) for main and
  // students alike. The live deployment names its own, so its containers cannot reach an evaluation's stand-ins.
  // TODO: create a restricted network that only routes to approved services.
  args.push('--network', CONTAINER_NETWORK);

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Runs the agent in a container. `onOutput` (streaming mode) hears every result the runner writes. `onProgress` (only with `onOutput`) hears what
 * the runner says between results (src/turn-status.ts: a tool starts or ends, the model is thinking, what a lookup returned), in the order it was
 * written relative to the results: it goes through the same chain. It is not output: it does not count as the container having answered (a run that
 * is stopped by its timeout while it only reported progress is a timeout with no output) and it does not reset the container's hard timeout (a loop
 * of tool calls must still be stopped). A caller that passes none sees what it always saw: the progress lines are skipped.
 */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `${CONTAINER_PREFIX}-${safeName}-${Date.now()}`;
  const streamText = streamsReply(input);
  const containerArgs = buildContainerArgs(mounts, containerName, input.isMain, studentTimeZone(group.folder, STORE_DIR), streamText, visionFor(input));

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Prune expired memories before building context
  try { pruneExpiredMemories(); } catch { /* non-fatal */ }

  // Write memory context before container starts (pre-flight injection)
  const memCtxPath = path.join(groupDir, 'memory_context.md');
  try {
    const memCtx = buildMemoryContext(input.chatJid, group.folder, input.prompt);
    if (memCtx) {
      writeFileAtomicSafe(memCtxPath, memCtx, groupDir);       // (the student's folder is the container's too: never written through a link)
    } else {
      try { fs.unlinkSync(memCtxPath); } catch { /* ok */ }
    }
  } catch (err) {
    logger.warn({ err, group: group.folder }, 'Failed to build memory context');
    try { fs.unlinkSync(memCtxPath); } catch { /* ok */ }
  }

  // Write full memory store for in-session query (memory_query tool)
  try {
    const exportData = buildMemoryExport(group.folder, input.chatJid);
    writeFileAtomicSafe(path.join(groupDir, 'memory_store.json'), JSON.stringify(exportData), groupDir);
  } catch (err) {
    logger.warn({ err, group: group.folder }, 'Failed to write memory_store.json');
  }

  // Pass secrets via stdin (never written to disk or mounted as files)
  // Use light model (Haiku) for scheduled tasks to reduce cost
  input.secrets = await readSecrets(input.isScheduledTask === true);

  return new Promise((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input) + '\n');
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    // A chunk of the pipe can end inside a multi-byte character (a reply in Chinese, an emoji); the decoder holds the rest for the next one. Only for
    // a container that streams its reply, whose lines carry the words: the others are read as they always were.
    const decoder = streamText ? new StringDecoder('utf8') : null;

    container.stdout.on('data', (data) => {
      const chunk = decoder ? decoder.write(data) : data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers, and for the progress lines between them, in the order they were written
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        for (;;) {
          startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER);
          const progressIdx = onProgress ? parseBuffer.indexOf(PROGRESS_MARKER) : -1;
          if (progressIdx !== -1 && (startIdx === -1 || progressIdx < startIdx)) {
            const lineEnd = parseBuffer.indexOf('\n', progressIdx);
            if (lineEnd === -1) break; // an incomplete line: wait for the rest
            const event = parseProgressLine(parseBuffer.slice(progressIdx, lineEnd), { text: streamText });
            parseBuffer = parseBuffer.slice(lineEnd + 1);
            if (event) {
              // through the chain of the results: a result that is still being delivered is not overtaken by what came after it
              outputChain = outputChain.then(() => {
                try {
                  onProgress!(event);
                } catch (err) {
                  logger.warn({ group: group.name, error: err }, 'Progress listener failed');
                }
              });
            }
            continue;
          }
          if (startIdx === -1) break;
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.resetSession) {
              newSessionId = undefined;
            }
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(`docker stop ${containerName}`, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;
      // what a log keeps of a streaming container's stdout has no preview in it: the words are in it once, as the result that was delivered
      const loggedStdout = streamText ? withoutTextEvents(stdout) : stdout;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          loggedStdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, logLines.join('\n'));
        logger.debug({ logFile, verbose: isVerbose }, 'Container log written');
      } catch (logErr) {
        logger.warn({ logErr, logFile }, 'Failed to write container log (non-fatal)');
      }

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout: loggedStdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout: loggedStdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * A voice call's tool host (docs/VOICE.md, "Tool host"): the student's agent container, built exactly as runContainerAgent builds it
 * (mounts, limits, network, secrets, identity binding from the registered group), started with TAI_MODE=tool-host so that it answers
 * tool calls on stdio instead of running the agent. The ContainerInput line is written here; the caller (src/voice/tool-host.ts) owns
 * the process from then on. Never main: a call never gets the admin's mounts or rights. The Deepgram key and the relay's gateway key are
 * not secrets of the container.
 */
export async function spawnToolHost(group: RegisteredGroup, chatJid: string): Promise<{ process: ChildProcess; containerName: string; refresh: () => void }> {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const mounts = buildVolumeMounts(group, false);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `${CONTAINER_PREFIX}-voice-${safeName}-${Date.now()}`;
  // (a call that may look at pictures has its tool host started for the picture tool too, as a student's chat container is: src/vision-env.ts callVisionOn)
  const args = buildContainerArgs(mounts, containerName, false, studentTimeZone(group.folder, STORE_DIR), false, visionForCall());
  args.splice(args.length - 1, 0, '-e', 'TAI_MODE=tool-host'); // before the image, which buildContainerArgs puts last

  // memory_query reads this file, as in a text agent's container; a host kept for the student's next call has it written again (voice/tool-host-pool.ts)
  const writeMemoryStore = (): void => {
    try {
      writeFileAtomicSafe(path.join(groupDir, 'memory_store.json'), JSON.stringify(buildMemoryExport(group.folder, chatJid)), groupDir);
    } catch (err) {
      logger.warn({ err, group: group.folder }, 'Failed to write memory_store.json for the voice tool host');
    }
  };
  writeMemoryStore();

  const secrets = await readSecrets(false);
  delete secrets.DEEPGRAM_API_KEY;
  delete secrets.TAI_VOICE_LLM_KEY;
  const input: ContainerInput = {
    prompt: '',
    groupFolder: group.folder,
    chatJid,
    isMain: false,
    secrets,
    canvasUserId: group.canvasUserId,
    githubUsername: group.githubUsername,
  };

  logger.info({ group: group.name, containerName }, 'Spawning voice tool host');
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  // listeners before anything else can fire: an 'error' (no docker) or an EPIPE with nobody listening would end the orchestrator
  child.on('error', (err) => logger.warn({ group: group.folder, containerName, err: err.message }, 'Voice tool host spawn error'));
  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);
  child.stdin?.write(JSON.stringify(input) + '\n');
  return { process: child, containerName, refresh: writeMemoryStore };
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
    /** 'system' for the host's own tasks (the patrol, the bootstrap): list_tasks says so, and the container's tools do not offer to stop one (src/task-origin.ts). */
    origin?: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  try {
    writeFileAtomicSafe(tasksFile, JSON.stringify(filteredTasks, null, 2), groupIpcDir);   // (the container's directory: never written through a link it planted)
  } catch (err) {
    logger.warn({ group: groupFolder, err: (err as Error).message }, 'The tasks snapshot was not written');
  }
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    writeFileAtomicSafe(
      groupsFile,
      JSON.stringify(
        {
          groups: visibleGroups,
          lastSync: new Date().toISOString(),
        },
        null,
        2,
      ),
      groupIpcDir,
    );
  } catch (err) {
    logger.warn({ group: groupFolder, err: (err as Error).message }, 'The groups snapshot was not written');
  }
}
