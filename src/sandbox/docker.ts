/**
 * Docker for the Go sandbox (docs/GO_SANDBOX.md): the argument lists of the two kinds of container, and the client that runs them. Both are built from arrays: the
 * `docker` program is started with `spawn` and an argument list, never through a shell and never from a string, so nothing a student wrote can become a word of a
 * command. The argument builders are pure (the tests read them flag by flag); the client is what the tests replace with a fake.
 *
 * Two kinds of container, both from the one image, both with every flag in `hardening()`:
 *   - MODULES: a network, the shared module cache writable, runs only the image's `sandbox-modules` script (`go mod download`). The student's code is unpacked in it so that its
 *     go.mod can be read; no program of the student's ever runs in it, and nothing of the request but a validated folder name reaches its command line.
 *   - RUN: `--network none`, the module cache read-only, runs only `sandbox-run` with the request as separate argument elements.
 * The environment of each is the fixed list below (`-e NAME=value`): nothing is inherited from the host's own environment.
 */
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { SANDBOX_LIMITS } from './types.js';
import type { SandboxRequest } from './types.js';

export const SANDBOX_IMAGE = 'tai-go-sandbox:live';
export const CONTAINER_PREFIX = 'tai-sandbox-';
/** The only names the host ever kills or removes by name. */
export const CONTAINER_NAME = /^tai-sandbox-[0-9a-f]{12}$/;
export const LABEL = 'tai-sandbox';
export const LABEL_STARTED = 'tai-sandbox-started';

export const RUN_SCRIPT = '/usr/local/bin/sandbox-run';
export const MODULES_SCRIPT = '/usr/local/bin/sandbox-modules';

/** No single file a program writes may be bigger (`--ulimit fsize`): a race test binary is about 20 MB. */
export const FSIZE_BYTES = 50 * 1024 * 1024;
export const NOFILE = 256;
/** /tmp holds Go's build cache and the programs it builds; /work the project (what an archive may unpack to, and a little over). Both are memory, charged to the container's memory. */
export const TMP_TMPFS_MB = SANDBOX_LIMITS.tmpfsMb;
export const WORK_TMPFS_MB = Math.ceil(SANDBOX_LIMITS.unpackedBytes / (1024 * 1024)) + 16;

/** The environment of the run container: exactly this. Offline (no proxy), nothing verified against a checksum database that cannot be reached (the cache was filled by the checked download). */
export const RUN_ENV: readonly string[] = [
  'GOPROXY=off',
  'GOFLAGS=-mod=mod -buildvcs=false',
  'GOSUMDB=off',
  'GOTOOLCHAIN=local',
  'GOMODCACHE=/gomodcache',
  'GOCACHE=/tmp/gocache',
  'GOPATH=/tmp/gopath',
  'CGO_ENABLED=1',
  'HOME=/tmp',
  'GOWORK=off',
  'GOVCS=*:off',
];

/** The environment of the modules container: exactly this. The Go module proxy only (no `direct`), every module checked against the checksum database, nothing private. */
export const MODULES_ENV: readonly string[] = [
  'GOFLAGS=-mod=mod -modcacherw',
  'GOPROXY=https://proxy.golang.org',
  'GOSUMDB=sum.golang.org',
  'GOTOOLCHAIN=local',
  'GOPRIVATE=',
  'GONOSUMDB=',
  'GONOPROXY=',
  'GOINSECURE=',
  'GOMODCACHE=/gomodcache',
  'GOCACHE=/tmp/gocache',
  'GOPATH=/tmp/gopath',
  'HOME=/tmp',
  'GOWORK=off',
  'GOVCS=*:off',
];

export interface ContainerSpec {
  /** `tai-sandbox-<12 hex>`. */
  name: string;
  /** The words after `docker`. */
  args: string[];
}

export interface HostUser {
  uid: number;
  gid: number;
}

export const newContainerName = (): string => `${CONTAINER_PREFIX}${randomBytes(6).toString('hex')}`;

/** What can sit in a `-v src:dst:mode` source: the host's own directories, so a character that would change the option is a refusal, not an escape. */
export function mountable(dir: string): boolean {
  if (dir.length === 0 || dir.length > 400 || /[\u0000-\u001f,]/.test(dir)) return false;
  return process.platform === 'win32' || !dir.includes(':');
}

interface Common {
  name: string;
  startedMs: number;
  image: string;
  user: HostUser;
  /** The run directory's `in` (code, stdin): read-only in the container. */
  inDir: string;
  /** The shared module cache. */
  cacheDir: string;
}

/** The flags of both kinds of container. */
function hardening(c: Common): string[] {
  return [
    'run',
    '--name', c.name,
    '--label', `${LABEL}=1`,
    '--label', `${LABEL_STARTED}=${c.startedMs}`,
    '--pull', 'never',
    '--init',
    '--log-driver', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--pids-limit', String(SANDBOX_LIMITS.pids),
    '--memory', `${SANDBOX_LIMITS.memoryMb}m`,
    '--memory-swap', `${SANDBOX_LIMITS.memoryMb}m`,
    '--cpus', String(SANDBOX_LIMITS.cpus),
    '--user', `${c.user.uid}:${c.user.gid}`,
    '--ulimit', `nofile=${NOFILE}:${NOFILE}`,
    '--ulimit', `fsize=${FSIZE_BYTES}:${FSIZE_BYTES}`,
    '--ulimit', 'core=0',
    '--hostname', 'sandbox',
    '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${TMP_TMPFS_MB}m`,
    '--tmpfs', `/work:rw,exec,nosuid,nodev,size=${WORK_TMPFS_MB}m,mode=1777`,
    '--workdir', '/work',
    '-v', `${c.inDir}:/in:ro`,
  ];
}

const envFlags = (env: readonly string[]): string[] => env.flatMap((e) => ['-e', e]);

export interface RunSpecOptions {
  name: string;
  startedMs: number;
  image: string;
  user: HostUser;
  inDir: string;
  cacheDir: string;
  /** The request: validated by parseSandboxRequest (and again by the runner). */
  request: Pick<SandboxRequest, 'action' | 'pkg' | 'race' | 'testRun' | 'args'>;
  /** The wall clock the program gets inside the container, in whole seconds. */
  wallSeconds: number;
  /** A folder of the repository (`repo.path`), or none. */
  folder?: string;
}

/** The run container: no network, the module cache read-only, `sandbox-run` with the request as argument elements. */
export function runContainerSpec(o: RunSpecOptions): ContainerSpec {
  const r = o.request;
  const args = [
    ...hardening(o),
    '--network', 'none',
    '-v', `${o.cacheDir}:/gomodcache:ro`,
    ...envFlags(RUN_ENV),
    o.image,
    RUN_SCRIPT,
    r.action,
    r.pkg,
    r.race ? '1' : '0',
    r.testRun ?? '-',
    String(o.wallSeconds),
    o.folder ?? '-',
    '--',
    ...(r.action === 'run' ? r.args : []),
  ];
  return { name: o.name, args };
}

export interface ModulesSpecOptions {
  name: string;
  startedMs: number;
  image: string;
  user: HostUser;
  inDir: string;
  cacheDir: string;
  wallSeconds: number;
  folder?: string;
}

/** The modules container: the default network, the module cache writable, `sandbox-modules` and nothing of the request but the folder. */
export function modulesContainerSpec(o: ModulesSpecOptions): ContainerSpec {
  const args = [
    ...hardening(o),
    '-v', `${o.cacheDir}:/gomodcache:rw`,
    ...envFlags(MODULES_ENV),
    o.image,
    MODULES_SCRIPT,
    String(o.wallSeconds),
    o.folder ?? '-',
  ];
  return { name: o.name, args };
}

// ---------------------------------------------------------------- the client

export interface DockerInspect {
  exitCode: number;
  oomKilled: boolean;
  /** When the program began and ended, by Docker's own clock (ms since the epoch): the time between `docker run` and the first is what starting a container costs on this host. */
  startedAtMs?: number;
  finishedAtMs?: number;
}

export interface DockerClient {
  /** Whether the image is there (`docker image inspect`). */
  imageExists(image: string): Promise<boolean>;
  /**
   * `docker run <args>`, attached: `onOutput` gets what the program wrote (the scripts merge its two streams into one), `onDiag` what Docker itself said on its own stderr.
   * Resolves when the process ends. Never rejects: a `docker` that cannot be started is `{ exitCode: null, error }`.
   */
  run(spec: ContainerSpec, onOutput: (chunk: Buffer) => void, onDiag?: (chunk: Buffer) => void): Promise<{ exitCode: number | null; error?: string }>;
  /** The container's exit code and whether the kernel killed it for memory; null when there is no such container. */
  inspect(name: string): Promise<DockerInspect | null>;
  /** `docker kill`: whether it was sent. */
  kill(name: string): Promise<boolean>;
  /** `docker rm -f`: whether the container is gone (or never was). */
  remove(name: string): Promise<boolean>;
  /** The containers that carry the sandbox's label, with the time (ms since the epoch) their label says they were started. */
  list(): Promise<Array<{ name: string; startedMs: number | null }>>;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof spawn>;

export interface DockerClientOptions {
  bin?: string;
  /** For tests: what starts the process. */
  spawnImpl?: SpawnFn;
  /**
   * What makes a container this client's own (the document renderer, src/docs/render.ts, has its own set): the label `list()` asks for (`<label>=1`), the label that says when each was
   * started, and the only names `inspect`, `kill` and `remove` act on. Without them: the Go sandbox's.
   */
  label?: string;
  startedLabel?: string;
  namePattern?: RegExp;
}

const LABEL_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The real client. */
export function createDockerClient(options: DockerClientOptions = {}): DockerClient {
  const bin = options.bin ?? 'docker';
  const start: SpawnFn = options.spawnImpl ?? ((c, a, o) => spawn(c, a, o));
  const label = options.label ?? LABEL;
  const startedLabel = options.startedLabel ?? LABEL_STARTED;
  const namePattern = options.namePattern ?? CONTAINER_NAME;
  if (!LABEL_KEY.test(label) || !LABEL_KEY.test(startedLabel)) throw new Error('the labels of a docker client are lower case words');

  /** One short `docker` command, its output (at most 64 KB) and its end; never rejects. */
  function exec(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; error?: string }> {
    return new Promise((resolve) => {
      let out = '';
      let settled = false;
      const done = (code: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout: out, ...(error ? { error } : {}) });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = start(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      } catch (err) {
        resolve({ code: null, stdout: '', error: (err as Error).message });
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        done(null, 'timed out');
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        if (out.length < 65536) out += d.toString('utf8');
      });
      child.on('error', (err) => done(null, err.message));
      child.on('close', (code) => done(code));
    });
  }

  return {
    async imageExists(image) {
      const r = await exec(['image', 'inspect', '--format', '{{.Id}}', image], 15_000);
      return r.code === 0;
    },

    run(spec, onOutput, onDiag) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (exitCode: number | null, error?: string) => {
          if (settled) return;
          settled = true;
          resolve({ exitCode, ...(error ? { error } : {}) });
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = start(bin, spec.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
          done(null, (err as Error).message);
          return;
        }
        child.stdout?.on('data', (d: Buffer) => onOutput(d));
        child.stderr?.on('data', (d: Buffer) => onDiag?.(d));
        child.on('error', (err) => done(null, err.message));
        child.on('close', (code) => done(code));
      });
    },

    async inspect(name) {
      if (!namePattern.test(name)) return null;
      const r = await exec(['inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.StartedAt}} {{.State.FinishedAt}}', name], 15_000);
      if (r.code !== 0) return null;
      const m = /^(-?\d+) (true|false)(?: (\S+) (\S+))?\s*$/.exec(r.stdout);
      if (!m) return null;
      const started = Date.parse(m[3] ?? '');
      const finished = Date.parse(m[4] ?? '');
      return { exitCode: Number(m[1]), oomKilled: m[2] === 'true', ...(started > 1e12 ? { startedAtMs: started } : {}), ...(finished > 1e12 ? { finishedAtMs: finished } : {}) };
    },

    async kill(name) {
      if (!namePattern.test(name)) return false;
      return (await exec(['kill', name], 10_000)).code === 0;
    },

    async remove(name) {
      if (!namePattern.test(name)) return false;
      const r = await exec(['rm', '-f', name], 20_000);
      return r.code === 0;
    },

    async list() {
      const r = await exec(['ps', '-a', '--filter', `label=${label}=1`, '--format', `{{.Names}}|{{.Label "${startedLabel}"}}`], 20_000);
      if (r.code !== 0) return [];
      const out: Array<{ name: string; startedMs: number | null }> = [];
      for (const line of r.stdout.split('\n')) {
        const [name, started] = line.trim().split('|');
        if (!name) continue;
        const ms = /^\d{10,16}$/.test(started ?? '') ? Number(started) : null;
        out.push({ name, startedMs: ms });
      }
      return out;
    },
  };
}
