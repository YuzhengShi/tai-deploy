import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { measureDirMb } from './cache.js';
import type { DuSpawn } from './cache.js';

const fake = (plan: (child: EventEmitter & { stdout: PassThrough; kill: () => void }) => void): { spawnImpl: DuSpawn; started: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> } => {
  const started: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const spawnImpl = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => undefined });
    started.push({ command, args, options });
    setImmediate(() => plan(child));
    return child;
  }) as unknown as DuSpawn;
  return { spawnImpl, started };
};

describe('measuring a directory', () => {
  it('asks du for kilobytes with an argument array and no shell, and answers whole megabytes (rounded up)', async () => {
    const f = fake((child) => {
      child.stdout.end('3146753\t/srv/data/sandbox/gomodcache with spaces; rm -rf /\n');
      child.emit('close', 0);
    });
    expect(await measureDirMb('/srv/data/sandbox/gomodcache with spaces; rm -rf /', f.spawnImpl)).toBe(3074);
    expect(f.started).toHaveLength(1);
    expect(f.started[0].command).toBe('du');
    expect(f.started[0].args).toEqual(['-sk', '--', '/srv/data/sandbox/gomodcache with spaces; rm -rf /']);
    expect(f.started[0].options.shell).toBeUndefined();
  });

  it('is null when it cannot say: no du, an answer that is not a size, a du that does not end', async () => {
    expect(await measureDirMb('/x', fake((child) => child.emit('error', new Error('spawn du ENOENT'))).spawnImpl)).toBeNull();
    expect(
      await measureDirMb(
        '/x',
        fake((child) => {
          child.stdout.end('du: cannot access: No such file or directory\n');
          child.emit('close', 1);
        }).spawnImpl,
      ),
    ).toBeNull();
    expect(await measureDirMb('/x', fake(() => undefined).spawnImpl, 30)).toBeNull();
    expect(await measureDirMb('/x', (() => { throw new Error('no spawn'); }) as unknown as DuSpawn)).toBeNull();
  });
});
