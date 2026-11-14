import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_NAME,
  FSIZE_BYTES,
  MODULES_ENV,
  MODULES_SCRIPT,
  RUN_ENV,
  RUN_SCRIPT,
  TMP_TMPFS_MB,
  WORK_TMPFS_MB,
  createDockerClient,
  modulesContainerSpec,
  mountable,
  newContainerName,
  runContainerSpec,
} from './docker.js';
import { SANDBOX_LIMITS } from './types.js';

const base = { name: 'tai-sandbox-0123456789ab', startedMs: 1_700_000_000_000, image: 'tai-go-sandbox:live', user: { uid: 1001, gid: 1002 }, inDir: '/srv/run-x/in', cacheDir: '/srv/gomodcache' };
const request = { action: 'test' as const, pkg: './...', race: true, testRun: 'TestA|TestB', args: [] as string[] };

/** The values that follow a flag, every time it appears. */
const values = (args: string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe('the flags of both kinds of container', () => {
  const containers = {
    run: runContainerSpec({ ...base, request, wallSeconds: 45 }).args,
    modules: modulesContainerSpec({ ...base, wallSeconds: 40 }).args,
  };

  for (const [kind, args] of Object.entries(containers)) {
    it(`${kind}: every security flag is there, with its value`, () => {
      expect(args[0]).toBe('run');
      expect(values(args, '--name')).toEqual(['tai-sandbox-0123456789ab']);
      expect(values(args, '--label').sort()).toEqual(['tai-sandbox-started=1700000000000', 'tai-sandbox=1']);
      expect(values(args, '--cap-drop')).toEqual(['ALL']);
      expect(values(args, '--security-opt')).toEqual(['no-new-privileges']);
      expect(args).toContain('--read-only');
      expect(values(args, '--pids-limit')).toEqual(['128']);
      expect(values(args, '--memory')).toEqual(['512m']);
      expect(values(args, '--memory-swap')).toEqual(['512m']);
      expect(values(args, '--cpus')).toEqual(['1']);
      expect(values(args, '--user')).toEqual(['1001:1002']);
      expect(values(args, '--ulimit').sort()).toEqual(['core=0', `fsize=${FSIZE_BYTES}:${FSIZE_BYTES}`, 'nofile=256:256']);
      expect(args).toContain('--init');
      expect(values(args, '--log-driver')).toEqual(['none']);
      expect(values(args, '--hostname')).toEqual(['sandbox']);
      expect(values(args, '--pull')).toEqual(['never']);
      expect(values(args, '--tmpfs').sort()).toEqual([`/tmp:rw,exec,nosuid,nodev,size=${TMP_TMPFS_MB}m`, `/work:rw,exec,nosuid,nodev,size=${WORK_TMPFS_MB}m,mode=1777`].sort());
      expect(values(args, '--workdir')).toEqual(['/work']);
      expect(values(args, '-v')).toContain('/srv/run-x/in:/in:ro');
    });

    it(`${kind}: nothing that widens the container is there`, () => {
      const text = args.join(' ');
      for (const bad of ['--privileged', '--cap-add', '--device', 'docker.sock', '--pid ', '--pid=', '--ipc', '--userns', '--network host', '--network=host', '--security-opt seccomp=unconfined', '--security-opt apparmor', '--volumes-from', '-p ', '--publish', '--env-file', '--add-host', '--sysctl', '--mount', '/var/run', '/etc/', ' -e SECRET']) {
        expect(text, bad).not.toContain(bad);
      }
      expect(args.filter((a) => a === '--security-opt')).toHaveLength(1);
      expect(values(args, '-v').every((v) => v.startsWith('/srv/'))).toBe(true); // only the run's `in` and the module cache are mounted
      expect(values(args, '-v')).toHaveLength(2);
    });

    it(`${kind}: its environment is exactly the fixed list, and nothing is inherited from this process`, () => {
      process.env.SANDBOX_TEST_CANARY = 'canary-value-1234';
      const fresh = kind === 'run' ? runContainerSpec({ ...base, request, wallSeconds: 45 }).args : modulesContainerSpec({ ...base, wallSeconds: 40 }).args;
      delete process.env.SANDBOX_TEST_CANARY;
      expect(fresh.join(' ')).not.toContain('canary-value-1234');
      expect(values(fresh, '-e')).toEqual([...(kind === 'run' ? RUN_ENV : MODULES_ENV)]);
      expect(fresh.filter((a, i) => fresh[i - 1] === '-e').every((e) => /^[A-Z_]+=/.test(e))).toBe(true); // always NAME=value: never a bare name, which would copy the host's
    });
  }

  it('the run container has no network and the module cache read-only; the modules container has the default network and the cache writable', () => {
    expect(values(containers.run, '--network')).toEqual(['none']);
    expect(values(containers.run, '-v')).toEqual(['/srv/run-x/in:/in:ro', '/srv/gomodcache:/gomodcache:ro']);
    expect(containers.modules).not.toContain('--network');
    expect(values(containers.modules, '-v')).toEqual(['/srv/run-x/in:/in:ro', '/srv/gomodcache:/gomodcache:rw']);
    expect(values(containers.run, '-e')).toContain('GOPROXY=off');
    expect(values(containers.modules, '-e')).toContain('GOPROXY=https://proxy.golang.org');
    expect(values(containers.modules, '-e')).toContain('GOSUMDB=sum.golang.org');
    expect(values(containers.modules, '-e')).toEqual(expect.arrayContaining(['GOPRIVATE=', 'GONOSUMDB=', 'GONOPROXY=', 'GOTOOLCHAIN=local']));
  });

  it('what follows the image is one fixed script and the request as separate elements; the modules container gets no request field at all', () => {
    const afterImage = (args: string[]) => args.slice(args.indexOf('tai-go-sandbox:live') + 1);
    expect(afterImage(containers.run)).toEqual([RUN_SCRIPT, 'test', './...', '1', 'TestA|TestB', '45', '-', '--']);
    const withArgs = runContainerSpec({ ...base, request: { action: 'run', pkg: './cmd/x', race: false, args: ['-n', '5', 'a=b'] }, wallSeconds: 20, folder: 'hw2/server' }).args;
    expect(afterImage(withArgs)).toEqual([RUN_SCRIPT, 'run', './cmd/x', '0', '-', '20', 'hw2/server', '--', '-n', '5', 'a=b']);
    expect(afterImage(containers.modules)).toEqual([MODULES_SCRIPT, '40', '-']);
    expect(afterImage(modulesContainerSpec({ ...base, wallSeconds: 12, folder: 'hw2/server' }).args)).toEqual([MODULES_SCRIPT, '12', 'hw2/server']);
    // arguments only go to a `run`: a stray list on a test is dropped
    expect(afterImage(runContainerSpec({ ...base, request: { ...request, args: ['x'] }, wallSeconds: 45 }).args).slice(-1)).toEqual(['--']);
  });

  it('the limits are the contract numbers', () => {
    expect(SANDBOX_LIMITS.pids).toBe(128);
    expect(SANDBOX_LIMITS.memoryMb).toBe(512);
    expect(SANDBOX_LIMITS.cpus).toBe(1);
    expect(WORK_TMPFS_MB * 1024 * 1024).toBeGreaterThanOrEqual(SANDBOX_LIMITS.unpackedBytes);
  });

  it('knows which source paths Docker may take in a -v', () => {
    expect(mountable('/home/ubuntu/tai-live/tai/data/sandbox/run-0123/in')).toBe(true);
    for (const bad of ['', '/a,b', '/a\nb', `/a${String.fromCharCode(0)}b`, 'x'.repeat(401)]) expect(mountable(bad), JSON.stringify(bad)).toBe(false);
    if (process.platform !== 'win32') expect(mountable('/a:rw')).toBe(false);
  });

  it('names containers so that only its own can ever be named in a kill or a remove', () => {
    expect(newContainerName()).toMatch(CONTAINER_NAME);
    expect(newContainerName()).not.toBe(newContainerName());
    for (const bad of ['tai-live-litellm', 'tai-sandbox-', 'tai-sandbox-XYZ', 'tai-sandbox-0123456789abc', 'x tai-sandbox-0123456789ab', 'tai-sandbox-0123456789ab; rm -rf /']) expect(CONTAINER_NAME.test(bad), bad).toBe(false);
  });
});

// ---------------------------------------------------------------- the client

type Started = { command: string; args: readonly string[]; options: Record<string, unknown> };

function fakeSpawn(plan: (s: Started, child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }) => void) {
  const started: Started[] = [];
  const spawnImpl = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => undefined });
    const s = { command, args, options };
    started.push(s);
    setImmediate(() => plan(s, child));
    return child;
  }) as unknown as NonNullable<Parameters<typeof createDockerClient>[0]>['spawnImpl'];
  return { started, spawnImpl };
}

describe('the real client', () => {
  it('starts docker with an argument list and no shell, whatever it is asked', async () => {
    const f = fakeSpawn((_s, child) => {
      child.stdout.end('0 false\n');
      child.emit('close', 0);
    });
    const docker = createDockerClient({ spawnImpl: f.spawnImpl });
    await docker.imageExists('tai-go-sandbox:live');
    await docker.inspect('tai-sandbox-0123456789ab');
    await docker.kill('tai-sandbox-0123456789ab');
    await docker.remove('tai-sandbox-0123456789ab');
    await docker.list();
    await docker.run({ name: 'tai-sandbox-0123456789ab', args: ['run', '--name', 'tai-sandbox-0123456789ab', 'img', 'x; id'] }, () => undefined);
    expect(f.started.map((s) => s.args.slice(0, 2).join(' '))).toEqual(['image inspect', 'inspect --format', 'kill tai-sandbox-0123456789ab', 'rm -f', 'ps -a', 'run --name']);
    for (const s of f.started) {
      expect(s.command).toBe('docker');
      expect(s.options.shell).toBeUndefined();
      expect(Array.isArray(s.args)).toBe(true);
    }
    expect(f.started[2].args).toEqual(['kill', 'tai-sandbox-0123456789ab']);
    expect(f.started[3].args).toEqual(['rm', '-f', 'tai-sandbox-0123456789ab']);
    expect(f.started[5].args).toEqual(['run', '--name', 'tai-sandbox-0123456789ab', 'img', 'x; id']); // passed through as one element, never split or interpreted
  });

  it('never kills, removes or inspects a container whose name is not one of its own (nothing is even started)', async () => {
    const f = fakeSpawn((_s, child) => child.emit('close', 0));
    const docker = createDockerClient({ spawnImpl: f.spawnImpl });
    for (const name of ['tai-live-litellm', 'cs6650-nora-1', 'tai-sandbox-0123456789ab; docker rm -f x', '--all', '$(id)']) {
      expect(await docker.kill(name)).toBe(false);
      expect(await docker.remove(name)).toBe(false);
      expect(await docker.inspect(name)).toBeNull();
    }
    expect(f.started).toHaveLength(0);
  });

  it('reads the exit code and the OOM flag, the list with its labels, and the image', async () => {
    const out: Record<string, string> = { inspect: '137 true\n', ps: 'tai-sandbox-0123456789ab|1700000000000\ntai-sandbox-aaaaaaaaaaaa|\n\n' };
    const f = fakeSpawn((s, child) => {
      child.stdout.end(out[s.args[0]] ?? '');
      child.emit('close', s.args[0] === 'image' ? 1 : 0);
    });
    const docker = createDockerClient({ spawnImpl: f.spawnImpl });
    expect(await docker.inspect('tai-sandbox-0123456789ab')).toEqual({ exitCode: 137, oomKilled: true });
    expect(await docker.list()).toEqual([
      { name: 'tai-sandbox-0123456789ab', startedMs: 1_700_000_000_000 },
      { name: 'tai-sandbox-aaaaaaaaaaaa', startedMs: null },
    ]);
    expect(await docker.imageExists('nope:live')).toBe(false);
  });

  it('streams the program output and keeps docker its own words apart; a docker that cannot start is an error result, not a throw', async () => {
    const f = fakeSpawn((_s, child) => {
      child.stdout.write('program says hi\n');
      child.stderr.write('docker: Error response from daemon: boom\n');
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 125));
    });
    const docker = createDockerClient({ spawnImpl: f.spawnImpl });
    let out = '';
    let diag = '';
    const ended = await docker.run({ name: 'tai-sandbox-0123456789ab', args: ['run'] }, (c) => (out += c.toString()), (c) => (diag += c.toString()));
    expect(ended).toEqual({ exitCode: 125 });
    expect(out).toBe('program says hi\n');
    expect(diag).toMatch(/Error response from daemon/);
    const broken = createDockerClient({ spawnImpl: (() => { throw new Error('spawn docker ENOENT'); }) as never });
    expect(await broken.run({ name: 'tai-sandbox-0123456789ab', args: ['run'] }, () => undefined)).toEqual({ exitCode: null, error: 'spawn docker ENOENT' });
    expect(await broken.imageExists('x')).toBe(false);
    expect(await broken.list()).toEqual([]);
  });

  it('answers an error when the process cannot be started or does not end in time', async () => {
    const f = fakeSpawn((_s, child) => child.emit('error', new Error('spawn docker ENOENT')));
    const docker = createDockerClient({ spawnImpl: f.spawnImpl });
    expect(await docker.run({ name: 'tai-sandbox-0123456789ab', args: ['run'] }, () => undefined)).toEqual({ exitCode: null, error: 'spawn docker ENOENT' });
    expect(await docker.kill('tai-sandbox-0123456789ab')).toBe(false);
  });
});
