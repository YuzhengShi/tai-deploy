/**
 * COURSE_STATUS.md, the class-wide page of the course (syllabus, modules, announcements, files, assignments, deadlines, what is new),
 * rebuilt from Canvas every few hours. The original had a model do it in the instructor's admin group: with the whole project mounted
 * writable, reading text every student can write, and putting each student's submissions and GitHub activity into a file every student's
 * agent reads. Here a script does it (container/scripts/course_status.py, no model, nothing about one student), in a throwaway container
 * that has the Canvas token and nothing else; the orchestrator checks what comes back and puts it in place.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, CONTAINER_NETWORK, CONTAINER_PREFIX, GROUPS_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type CourseStatusResult = 'written' | 'unchanged' | 'skipped' | 'failed';

export interface CourseStatusRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CourseStatusDeps {
  /** Runs the script with the config line on its stdin; the default is a throwaway docker container. */
  run?: (config: string) => Promise<CourseStatusRun>;
  now?: () => Date;
  file?: string;
  readSecrets?: () => Record<string, string | undefined>;
  /** Told when a rebuild changed the file, with the file as it was and as it is now (the students' activity lists: src/course-updates.ts). Never allowed to fail the job. */
  onChange?: (previous: string, current: string) => void;
}

export const COURSE_STATUS_FILE = path.join(GROUPS_DIR, 'global', 'COURSE_STATUS.md');
const MAX_BYTES = 120_000;
const MIN_BYTES = 200;
const RUN_TIMEOUT_MS = 180_000;

/** The file with its "Last synced" line left out: a run that finds nothing new is not a change. */
function body(text: string): string {
  return text.replace(/^Last synced:.*$/m, '');
}

/** What the script wrote is a Course Status page or it is not put in place: a half answer must not replace a good file. */
export function acceptable(text: string): boolean {
  return text.startsWith('# Course Status') && text.length >= MIN_BYTES && text.length <= MAX_BYTES && !text.includes('\u0000');
}

function dockerRun(config: string): Promise<CourseStatusRun> {
  const args = [
    'run', '-i', '--rm', '--name', `${CONTAINER_PREFIX}-status-${Date.now()}`,
    '--network', CONTAINER_NETWORK,
    '--read-only', '--tmpfs', '/tmp:size=64m,noexec',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
    '-e', 'PYTHONDONTWRITEBYTECODE=1',
    '--entrypoint', '/opt/leanrag/bin/python3',
    CONTAINER_IMAGE, '/opt/scripts/course_status.py',
  ];
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += '\n(timed out)';
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BYTES * 2) stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(config + '\n');
  });
}

/** One rebuild of the file. Never throws: the job must not take the orchestrator down. */
export async function refreshCourseStatus(deps: CourseStatusDeps = {}): Promise<CourseStatusResult> {
  const file = deps.file ?? COURSE_STATUS_FILE;
  const now = deps.now ?? (() => new Date());
  const secrets = (deps.readSecrets ?? (() => readEnvFile(['CANVAS_API_TOKEN', 'CANVAS_BASE_URL', 'CANVAS_COURSE_ID'])))();
  if (!secrets.CANVAS_API_TOKEN || !secrets.CANVAS_BASE_URL || !secrets.CANVAS_COURSE_ID) {
    logger.info('Course status: Canvas is not configured, nothing to sync');
    return 'skipped';
  }
  let previous = '';
  try {
    previous = fs.readFileSync(file, 'utf-8');
  } catch {
    /* the first run */
  }
  const config = JSON.stringify({
    env: { CANVAS_API_TOKEN: secrets.CANVAS_API_TOKEN, CANVAS_BASE_URL: secrets.CANVAS_BASE_URL, CANVAS_COURSE_ID: secrets.CANVAS_COURSE_ID },
    previous,
    now: now().toISOString(),
  });
  try {
    const done = await (deps.run ?? dockerRun)(config);
    if (done.code !== 0 || !acceptable(done.stdout)) {
      // the script's own reason (one line, no secret: it never prints one), or what went wrong around it
      logger.warn({ code: done.code, reason: (done.stderr || '').trim().split('\n').pop()?.slice(0, 200) }, 'Course status: not updated');
      return 'failed';
    }
    if (body(done.stdout) === body(previous)) {
      logger.info('Course status: nothing changed');
      return 'unchanged';
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, done.stdout, { mode: 0o644 });
    fs.renameSync(tmp, file);
    logger.info({ bytes: done.stdout.length }, 'Course status: written');
    try {
      deps.onChange?.(previous, done.stdout);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Course status: the file is in place, but telling the students of what changed failed');
    }
    return 'written';
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Course status: failed');
    return 'failed';
  }
}

/** Runs the rebuild a minute after start and then every `hours` (default 6, TAI_COURSE_STATUS_HOURS; 0 turns it off). Returns how to stop it. */
export function startCourseStatusJob(env: NodeJS.ProcessEnv = process.env, deps: CourseStatusDeps = {}): () => void {
  const hours = parseFloat(env.TAI_COURSE_STATUS_HOURS ?? '6');
  if (!Number.isFinite(hours) || hours <= 0) {
    logger.info('Course status job is off (TAI_COURSE_STATUS_HOURS=0)');
    return () => undefined;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await refreshCourseStatus(deps);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  const every = setInterval(() => void tick(), Math.max(hours, 0.05) * 3_600_000);
  first.unref();
  every.unref();
  logger.info({ hours }, 'Course status job started');
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
