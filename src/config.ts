import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ADMIN_PHONE_NUMBERS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'TAi';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
// Admin phone allowlist: comma-separated phone numbers (digits only, e.g. "8615112345678,12025551234")
// When set, only these numbers can send messages to the main (admin) channel.
// Empty = no restriction (all senders allowed).
export const ADMIN_PHONE_NUMBERS: string[] = (() => {
  const raw = process.env.ADMIN_PHONE_NUMBERS || envConfig.ADMIN_PHONE_NUMBERS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
})();

export const POLL_INTERVAL = 2000;
export const DEBOUNCE_MS = 1500; // Wait for student to finish typing before spawning agent
// Max characters per individual message before truncation (prevents context window exhaustion)
export const MAX_MESSAGE_LENGTH = 10000;
// A student's reply gets a length rule after their messages, and a closing formula taken off its end (src/reply-shape.ts); TAI_REPLY_RULE=0 switches both off
export const REPLY_RULE = process.env.TAI_REPLY_RULE !== '0';
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';

// Two orchestrators on one docker daemon (an evaluation and the live one) must not find each other's containers: every agent container's
// name starts with CONTAINER_PREFIX, the orchestrator removes the stale ones of ITS prefix at start (index.ts killStaleContainers), and
// the containers join CONTAINER_NETWORK. Keep the prefixes apart: one that is another's prefix plus "-" (nanoclaw, nanoclaw-live) would
// take its containers.
function dockerName(value: string | undefined, fallback: string, setting: string, pattern: RegExp): string {
  if (!value) return fallback;
  if (!pattern.test(value)) throw new Error(`${setting}=${JSON.stringify(value)} is not usable as a docker name (${pattern})`);
  return value;
}
export const CONTAINER_PREFIX = dockerName(process.env.CONTAINER_PREFIX, 'nanoclaw', 'CONTAINER_PREFIX', /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/);
export const CONTAINER_NETWORK = dockerName(process.env.CONTAINER_NETWORK, 'nanoclaw-net', 'CONTAINER_NETWORK', /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '900000',
  10,
); // 15min default — a container silent for this long is killed (was 30min: a stuck one held its slot that long)
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '120000',
  10,
); // 2min default — how long to keep container alive after last result (was 30min: five warm containers held every slot;
// the conversation is resumed by the next container, so a later follow-up only pays a cold start)
// How long a scheduled task's container is kept once its runner says it is done (the patrol, the grade bootstrap): nothing more is ever sent to it, so the
// slot it holds should go back at once. Before this a task whose answer had no text kept its container for the whole CONTAINER_TIMEOUT (937 s on 2026-11-03),
// and one with text for IDLE_TIMEOUT (140 s for 20 s of work). A few seconds are left for the files the task wrote last to reach the disk the host reads.
const taskCloseDelay = parseInt(process.env.TAI_TASK_CLOSE_DELAY_MS ?? '', 10);
export const TASK_CLOSE_DELAY = Number.isFinite(taskCloseDelay) && taskCloseDelay >= 0 ? taskCloseDelay : 5000;
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Container resource limits
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || '2g';
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || '1.0';
export const CONTAINER_PIDS_LIMIT = process.env.CONTAINER_PIDS_LIMIT || '256';

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
