/**
 * The size of the shared module cache (docs/GO_SANDBOX.md). A student's go.mod can name any public module and the download phase fetches it, so the cache has a cap
 * (SANDBOX_LIMITS.moduleCacheMb) and the reaper looks at it now and then. The measuring is `du -sk` started with an argument array: never a shell, never a string command.
 */
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

export type DuSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof spawn>;

/** The size of `dir` in whole megabytes, or null when it cannot be measured (no `du`, no directory, no answer in time). Never rejects. */
export function measureDirMb(dir: string, spawnImpl?: DuSpawn, timeoutMs = 120_000): Promise<number | null> {
  const start: DuSpawn = spawnImpl ?? ((c, a, o) => spawn(c, a, o));
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* gone */
      }
      done(null);
    }, timeoutMs);
    try {
      child = start('du', ['-sk', '--', dir], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      done(null);
      return;
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 4096) out += d.toString('utf8');
    });
    child.on('error', () => done(null));
    child.on('close', () => {
      const m = /^(\d+)\s/.exec(out);
      done(m ? Math.ceil(Number(m[1]) / 1024) : null);
    });
  });
}
