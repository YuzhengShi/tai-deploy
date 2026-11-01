/**
 * PreToolUse guards of the agent container. They live apart from index.ts so they can be unit tested (index.ts starts the agent when it
 * is imported).
 *
 * A guard that stops a tool returns deny(): the Agent SDK reads a PreToolUse decision from hookSpecificOutput.permissionDecision
 * ('deny') and permissionDecisionReason. Upstream returned `decision: 'block'` and `reason` inside hookSpecificOutput, which the SDK
 * ignores, so none of its guards ever stopped a tool (eval/RESULTS.md, item 2a).
 *
 * These are depth, not a wall: the container has network access by design and the agent runs as the same user as the process that
 * holds the credentials. The checks close the routes a model is actually led down; they do not make the agent a sandbox.
 */

import { execSync } from 'child_process';
import { lookup } from 'dns/promises';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

export type HookResult = Awaited<ReturnType<HookCallback>>;

export function deny(reason: string): HookResult {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

/** The reason a hook result denies the tool with, or null when it does not deny. */
export function denial(result: HookResult): string | null {
  const out = (result as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
  return out?.permissionDecision === 'deny' ? out.permissionDecisionReason ?? '' : null;
}

function toolInput(input: unknown): Record<string, unknown> {
  return ((input as PreToolUseHookInput).tool_input as Record<string, unknown>) || {};
}

/**
 * Several guards of one tool as ONE hook. With more than one hook matching a tool the CLI tells the model only "Hook PreToolUse:Bash
 * denied this tool" and drops the reason, so the model cannot say anything useful to the student; one hook keeps its reason. The first
 * denial wins. A hook that rewrites the input (Bash's unset prefix) goes last: the ones before it see the command as written.
 */
export function composeHooks(...hooks: HookCallback[]): HookCallback {
  return async (input, toolUseId, options) => {
    let rewritten: HookResult = {};
    for (const hook of hooks) {
      const result = await hook(input, toolUseId, options);
      if (denial(result) !== null) return result;
      if ((result as { hookSpecificOutput?: { updatedInput?: unknown } }).hookSpecificOutput?.updatedInput) rewritten = result;
    }
    return rewritten;
  };
}

// --- Bash: secrets, dangerous commands ---------------------------------------------------------------------------------------

// Credentials the SDK needs in its own environment (API access) and that no command the agent runs may see.
const API_CREDENTIAL_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CANVAS_API_TOKEN',
  'GITHUB_TOKEN',
];
const CREDENTIAL_LIKE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_?KEY|ACCESS_?KEY)/i;

/**
 * Names of the environment variables Bash must not see: everything the host handed to this container as a secret (whatever it is
 * called), anything in the SDK's environment that is named like a credential, and the API credentials above. Derived, not listed by
 * hand: the hand-written list upstream named 7 of about 25 secrets.
 */
export function secretEnvNames(
  secrets: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): string[] {
  const names = new Set<string>(API_CREDENTIAL_NAMES);
  for (const name of Object.keys(secrets || {})) names.add(name);
  for (const name of Object.keys(env)) if (CREDENTIAL_LIKE.test(name)) names.add(name);
  return [...names].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)).sort();
}

// Dangerous commands blocked for non-main containers. Checked against the raw command and against the command with its quotes and
// escapes removed (c''url, cu\rl and "curl" are all curl).
const BLOCKED_COMMANDS: RegExp[] = [
  // Destructive filesystem operations
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+\//, // rm -rf / (anything starting from root)
  /\bmkfs\b/,
  /\bdd\b.*\bof\s*=\s*\/dev\//,
  // Outbound network tools (data exfiltration, proxy attacks)
  /\bcurl\b/,
  /\bwget\b/,
  /\bncat?\b/, // nc / ncat
  /\bsocat\b/,
  /\btelnet\b/,
  /\/dev\/(tcp|udp)\//, // bash's own sockets
  /\bpython3?\b.*\b(http\.server|SimpleHTTPServer|requests\.|urllib|socket\b|aiohttp|httpx)/,
  /\bnode\b.*\b(http|https|net|fetch)\b/,
  // Indirect execution (blocklist bypass via encoding or eval)
  /\bbase64\b.*\|\s*(ba)?sh\b/, // base64 -d | bash
  /\beval\b/, // eval "$cmd"
  /\bsource\s+\/dev\/stdin\b/, // source /dev/stdin (pipe to shell)
  /\b(ba)?sh\s+-c\s.*\$[({]/, // sh -c "...$(...)" or sh -c "...${...}"
];

/** The command as the shell will see it once quotes and escapes are gone. */
export function unquote(command: string): string {
  return command.replace(/\\\n/g, '').replace(/['"\\]/g, '');
}

// procfs entries a student's agent has no business with (environ, cmdline, mem, maps, fd, root, cwd of any process); the plain system
// summaries stay readable.
const HARMLESS_PROC = /^(cpuinfo|meminfo|loadavg|uptime|version)$/;

/** Does the command mention /proc other than for a plain system summary? */
export function touchesProc(command: string): boolean {
  for (const m of unquote(command).matchAll(/\/proc\b\/?([^\s;|&<>()`$]*)/gi)) {
    if (!HARMLESS_PROC.test(m[1] || '')) return true;
  }
  return false;
}

/** A Bash command that names COMPETENCY.md may only read it: the competency guard sees Write and Edit, not what a shell does. */
export function writesCompetency(command: string): boolean {
  return /COMPETENCY\.md/i.test(command) && !readsOnly(command);
}

/** One or more plain readers joined by pipes (cat COMPETENCY.md | head -20), no redirection, chaining or substitution. */
function readsOnly(command: string): boolean {
  if (/[<>;&`\n]|\$\(/.test(command)) return false;
  return command.split('|').every((part) => /^\s*(cat|head|tail|grep|egrep|fgrep|wc|ls|stat|diff|nl|sort)\b[^;&<>`$()]*$/.test(part));
}

/** Commands that only remove or measure files: allowed even when the workspace is full. */
export function isCleanupCommand(command: string): boolean {
  return /^\s*(rm|rmdir|du|ls|df|stat|wc)\b[^;&|<>`$()]*$/.test(command);
}

/**
 * Bash for every container: sensitive files and /proc are off limits and every credential is unset for the command. Non-main
 * containers also lose the dangerous and network commands and may not write COMPETENCY.md through a shell, and every file a command
 * writes is capped (ulimit -f, in 1024-byte blocks).
 */
export function createSanitizeBashHook(isMain: boolean, secretNames: string[]): HookCallback {
  return async (input) => {
    const command = (toolInput(input) as { command?: string }).command;
    if (!command) return {};
    const plain = unquote(command);

    // Block attempts to read sensitive files via shell commands
    // Broad match: any command mentioning .env/.db files with common read/copy/edit tools
    if (
      touchesProc(command) ||
      ((/\.(env|db|sqlite)\b/.test(command) || /\.(env|db|sqlite)\b/.test(plain)) &&
        /(cat|head|tail|less|more|strings|xxd|hexdump|sqlite3|cp|mv|vi|vim|nano|sed|awk|grep|sort|tee|dd|tar|zip|base64)\b/.test(plain))
    ) {
      return deny('Access to sensitive files (.env, .db, /proc) is blocked.');
    }

    if (!isMain) {
      if (BLOCKED_COMMANDS.some((pattern) => pattern.test(command) || pattern.test(plain))) {
        return deny(
          'Command blocked for security: matches restricted pattern. If you need network access, use the provided MCP tools (canvas_query, github_query, youtube_transcript, etc.) instead.',
        );
      }
      if (writesCompetency(command)) {
        return deny('COMPETENCY.md can only be changed with the Edit or Write tool, one concept at a time; a shell command may read it.');
      }
    }

    const caps = isMain ? '' : 'ulimit -f 51200 2>/dev/null; ';
    const unsetPrefix = `unset ${secretNames.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...toolInput(input),
          command: caps + unsetPrefix + command,
        },
      },
    };
  };
}

// --- Read / Grep: sensitive files ----------------------------------------------------------------------------------------------

// Sensitive file patterns blocked from Read and Grep (all containers, including main).
// Even admin agents shouldn't read these — prevents prompt injection from leaking secrets.
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\/proc\/(self|thread-self|\d+)(\/|$)/i, // procfs of a process: environ, cmdline, mem, maps, fd, root, cwd ...
  /\/\.env$/, // .env files
  /\/\.env\..+$/, // .env.local, .env.production, etc.
  /\/nanoclaw\.db$/, // SQLite database (all messages, groups, sessions)
  /\/nanoclaw\.db-(wal|shm)$/, // SQLite WAL/SHM files
];

/** The path as written, as resolved against the working directory, and with symlinks followed (a link called notes.txt to .env). */
function pathCandidates(raw: string): string[] {
  const resolved = path.posix.resolve(raw);
  const out = [raw, resolved];
  try {
    out.push(fs.realpathSync(resolved));
  } catch {
    // not there (yet): nothing to follow
  }
  return out;
}

export function isSensitivePath(raw: string): boolean {
  return pathCandidates(raw).some((p) => SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(p)));
}

export function createSensitiveFileReadHook(): HookCallback {
  return async (input) => {
    const ti = toolInput(input);
    const target = (ti.file_path ?? ti.path) as string | undefined; // Read: file_path; Grep: path
    if (!target) return {};
    if (isSensitivePath(target)) return deny('This file contains sensitive data and cannot be read directly.');
    return {};
  };
}

// --- WebFetch: private addresses, rate limit -----------------------------------------------------------------------------------

/** What the guards count per turn of the conversation; index.ts resets it when the model has answered. */
export interface TurnCounters {
  webFetch: number;
}

export function newTurnCounters(): TurnCounters {
  return { webFetch: 0 };
}

function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link local, the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // includes docker's bridge networks
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

function ipv6Words(ip: string): number[] | null {
  let s = ip.split('%')[0]; // zone id
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/); // an embedded dotted quad is two more words
  if (dotted) {
    const [, a, b, c, d] = dotted.map(Number);
    s = s.slice(0, s.length - dotted[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/** Is this address one a student's agent must not fetch from: loopback, private, link-local, docker, multicast, reserved? */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return privateV4(a, b, c);
  }
  if (net.isIPv6(ip)) {
    const w = ipv6Words(ip);
    if (!w) return true; // unreadable: do not fetch
    const embedded = (hi: number, lo: number) => privateV4(hi >> 8, hi & 255, lo >> 8);
    if (w.slice(0, 7).every((x) => x === 0) && w[7] <= 1) return true; // :: and ::1
    if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((w[0] & 0xff00) === 0xff00) return true; // multicast
    if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return embedded(w[6], w[7]); // ::ffff:a.b.c.d
    if (w.slice(0, 6).every((x) => x === 0)) return embedded(w[6], w[7]); // ::a.b.c.d
    if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return embedded(w[6], w[7]); // NAT64
    if (w[0] === 0x2002) return embedded(w[1], w[2]); // 6to4
    return false;
  }
  return true; // not an address
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.intranet', '.corp', '.home', '.home.arpa', '.docker', '.svc'];

export type Resolver = (host: string) => Promise<string[]>;

async function resolveHost(host: string): Promise<string[]> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 3000).unref());
  const found = await Promise.race([lookup(host, { all: true, verbatim: true }), timeout]);
  return found.map((a) => a.address);
}

/**
 * Why this URL must not be fetched, or null. new URL() already turns 2130706433, 0x7f.1 and 017700000001 into 127.0.0.1; names are
 * resolved, so a public-looking name that points inside (or a docker service name) is refused too. A name can still change its answer
 * between this check and the fetch (DNS rebinding); the container's network is not otherwise restricted.
 */
export async function privateUrlReason(rawUrl: string, resolve: Resolver = resolveHost): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `only http and https URLs can be fetched (not ${url.protocol})`;
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return 'no host in the URL';
  if (net.isIP(host)) return isPrivateAddress(host) ? 'a private or internal address' : null;
  if (!host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return 'an internal host name';
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return 'a host name that does not resolve';
  }
  if (addresses.length === 0) return 'a host name that does not resolve';
  return addresses.some(isPrivateAddress) ? 'a host name that points at a private or internal address' : null;
}

/** WebFetch for non-main containers: at most maxCalls per turn, and nothing inside the container's own network. */
export function createWebFetchGuardHook(counters: TurnCounters, maxCalls: number, resolve: Resolver = resolveHost): HookCallback {
  return async (input) => {
    const url = (toolInput(input).url as string) || '';

    counters.webFetch++;
    if (counters.webFetch > maxCalls) {
      return deny(`WebFetch rate limit exceeded: max ${maxCalls} calls per answer.`);
    }

    const why = await privateUrlReason(url, resolve);
    if (why) return deny(`Cannot fetch internal/private URLs (${why}). Only public web pages are accessible.`);
    return {};
  };
}

// --- Write / Edit: size, workspace, competency ---------------------------------------------------------------------------------

/** Block writes larger than maxBytes (non-main only). */
export function createFileSizeGuardHook(maxBytes: number): HookCallback {
  return async (input) => {
    const ti = toolInput(input);
    const content = (ti.content as string) || (ti.new_string as string) || '';
    const size = Buffer.byteLength(content);
    if (size > maxBytes) {
      return deny(`File content too large (${(size / 1024 / 1024).toFixed(1)}MB). Maximum allowed: ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`);
    }
    return {};
  };
}

function workspaceMB(): number | null {
  try {
    const output = execSync('du -sm /workspace/group', { timeout: 3000, encoding: 'utf-8' });
    return parseInt(output.trim().split(/\s+/)[0], 10);
  } catch {
    return null; // du failed or timed out: allow (defense in depth: tmpfs + file size limits still apply)
  }
}

/** Block writes if the workspace directory is at maxMB (non-main only). A command that only deletes or measures is let through. */
export function createWorkspaceSizeGuardHook(
  maxMB: number,
  measure: () => number | null = workspaceMB,
  exempt: (command: string) => boolean = () => false,
): HookCallback {
  return async (input) => {
    const command = (toolInput(input).command as string) || '';
    if (command && exempt(command)) return {};
    const sizeMB = measure();
    if (sizeMB !== null && sizeMB >= maxMB) {
      return deny(`Workspace is full (${sizeMB}MB / ${maxMB}MB limit). Remove unnecessary files before writing new ones.`);
    }
    return {};
  };
}

// A mastery line is `Docker: confidence: 0.3 | stability: 0.1 | scope: [] | via: [] | last: never` (COMPETENCY_PROTOCOL.md) or, as
// in COMPETENCY_TEMPLATE.md, `Docker: 0.3 | 0.1 | [] | [] | never`.
const MASTERY_LINES: RegExp[] = [
  /^\s*(?:[-*]\s*)?(.+?):\s*confidence\s*[:=]\s*(\d*\.?\d+)/i,
  /^\s*(?:[-*]\s*)?(.+?):\s*(\d*\.?\d+)\s*\|\s*\d*\.?\d+\s*\|/,
];

/** concept -> confidence for every mastery line in the text (a bare `confidence: x` counts too, under a made-up name). */
export function masteryScores(text: string): Map<string, number> {
  const scores = new Map<string, number>();
  text.split('\n').forEach((line, i) => {
    for (const pattern of MASTERY_LINES) {
      const m = line.match(pattern);
      if (m) {
        scores.set(m[1].trim().toLowerCase(), parseFloat(m[2]));
        return;
      }
    }
    let k = 0;
    for (const m of line.matchAll(/confidence\s*[:=]\s*(\d*\.?\d+)/gi)) scores.set(`line ${i + 1}#${k++}`, parseFloat(m[1]));
  });
  return scores;
}

/** Concepts that are at or above the threshold in `after` and were not in `before`. */
export function raisedToHigh(before: string, after: string, threshold = 0.8): string[] {
  const old = masteryScores(before);
  const raised: string[] = [];
  for (const [name, value] of masteryScores(after)) {
    if (value >= threshold && !((old.get(name) ?? 0) >= threshold)) raised.push(name);
  }
  return raised;
}

/**
 * Hook to prevent suspicious bulk modifications to COMPETENCY.md.
 * Normal teaching updates 1-2 concepts at a time with small increments. A student tricking the agent into setting all confidences to
 * 1.0 shows as three or more concepts newly at 0.8 or above in one write; what was already high does not count.
 */
export function createCompetencyGuardHook(isMain: boolean, readCurrent: (file: string) => string = readFileOrEmpty): HookCallback {
  return async (input) => {
    if (isMain) return {}; // Admin can do anything

    const ti = toolInput(input);
    const filePath = (ti.file_path as string) || '';
    if (!pathCandidates(filePath).some((p) => p.endsWith('COMPETENCY.md'))) return {};

    // Write rewrites the file: compare with what is there. Edit (and MultiEdit) replace one text with another.
    const pairs: Array<[string, string]> = [];
    if (typeof ti.content === 'string') pairs.push([readCurrent(filePath), ti.content]);
    if (typeof ti.new_string === 'string') pairs.push([(ti.old_string as string) || '', ti.new_string]);
    for (const e of (ti.edits as Array<{ old_string?: string; new_string?: string }>) || []) {
      pairs.push([e.old_string || '', e.new_string || '']);
    }
    const raised = pairs.flatMap(([before, after]) => raisedToHigh(before, after));

    if (raised.length >= 3) {
      return deny(
        `Blocked: setting ${raised.length} concepts to confidence >= 0.8 in a single edit is not allowed. Mastery scores must be updated incrementally based on demonstrated understanding, not in bulk. Update concepts one at a time after each interaction.`,
      );
    }
    return {};
  };
}

function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * The PreToolUse hooks of a container, one hook per tool (see composeHooks). Main is the admin's chat: it gets the guards that protect
 * the host's secrets and files; every other group also gets the ones against abuse.
 */
export function preToolUseHooks(isMain: boolean, secretNames: string[], counters: TurnCounters) {
  const studentOnly = (hooks: HookCallback[]) => (isMain ? [] : hooks);
  const writeGuards = () =>
    composeHooks(createCompetencyGuardHook(isMain), ...studentOnly([createFileSizeGuardHook(5 * 1024 * 1024), createWorkspaceSizeGuardHook(500)]));
  return [
    {
      matcher: 'Bash',
      hooks: [composeHooks(...studentOnly([createWorkspaceSizeGuardHook(500, undefined, isCleanupCommand)]), createSanitizeBashHook(isMain, secretNames))],
    },
    { matcher: 'Read', hooks: [createSensitiveFileReadHook()] },
    { matcher: 'Grep', hooks: [createSensitiveFileReadHook()] },
    { matcher: 'Write', hooks: [writeGuards()] },
    { matcher: 'Edit', hooks: [writeGuards()] },
    { matcher: 'MultiEdit', hooks: [writeGuards()] },
    ...(isMain ? [] : [{ matcher: 'WebFetch', hooks: [createWebFetchGuardHook(counters, 15)] }]),
  ];
}
