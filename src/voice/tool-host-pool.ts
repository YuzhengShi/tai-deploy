/**
 * A student's tool host after their call. A call starts the container that answers its tool calls the moment it starts (in parallel with
 * Deepgram), and that container takes ten seconds or more to come up on this machine: a question asked in the first seconds of the call
 * waits for it, and so does the next call of a student who has just hung up, for a container that was running a minute ago. Here the host
 * of a call that ended stays up for a while (TAI_VOICE_TOOLHOST_KEEP_SEC) and serves that student's next call.
 *
 *   a call     acquire(folder, identity) gives it a lease: the warm host of that student when there is one, a new one when not. The lease
 *              is the call's ToolHost: close() gives the host back instead of closing it.
 *   identity   the host is bound to the student it was started for (their Canvas and GitHub accounts, as the container got them): a host
 *              is only ever handed to the call of the same folder AND the same binding. A student whose binding changed gets a new host.
 *   kept       at most `keepMax` idle hosts, each for at most `keepSec`; the oldest goes first. A host with a call still running in it, one
 *              that has died, and every host once the pool is closed, is closed at once and never kept.
 *   reused     refresh() first: what the container reads from the group folder and that comes from the database (memory_store.json) is
 *              written again, so that the second call does not recall what was true at the start of the first.
 *
 * With keepSec 0 there is no pool: acquire() is the plain spawn, and a call closes its host, as before.
 */
import type { ToolHost, ToolResult } from './tool-host.js';
import type { VoiceLog } from './types.js';
import { silentLog } from './types.js';

export interface ToolHostPoolOptions {
  /** A tool host for this student's group (VoiceDeps.spawnToolHost): nothing is started until its start() is called. */
  spawn: (folder: string) => ToolHost;
  /** How long an idle host is kept, in seconds (0: no pool). */
  keepSec: number;
  /** How many idle hosts at most. */
  keepMax: number;
  log?: VoiceLog;
}

export interface PoolEntry {
  key: string;
  folder: string;
  host: ToolHost;
  /** begin() starts the host once, whoever asks; undefined until a call asks. */
  starting?: Promise<void>;
  state: 'new' | 'starting' | 'ready' | 'failed';
  timer: NodeJS.Timeout | null;
  parkedAt: number;
}

/** A call's hold on a host. It is the ToolHost the call sees; close() gives it back to the pool. */
export class ToolHostLease implements ToolHost {
  closed = false;
  /** Calls made through this lease that have not answered yet: a host with one running is not worth keeping. */
  outstanding = 0;

  constructor(
    private readonly pool: ToolHostPool,
    readonly entry: PoolEntry,
  ) {}

  start(): Promise<void> {
    return this.pool.begin(this.entry);
  }

  get alive(): boolean {
    return !this.closed && this.entry.host.alive;
  }

  private track(result: Promise<ToolResult>): Promise<ToolResult> {
    this.outstanding++;
    return result.finally(() => {
      this.outstanding--;
    });
  }

  call(tool: string, args: Record<string, unknown>, opts?: { server?: string; timeoutMs?: number }): Promise<ToolResult> {
    if (this.closed) return Promise.resolve({ ok: false, text: 'closed' });
    return this.track(this.entry.host.call(tool, args, opts));
  }

  builtin(name: 'web_fetch' | 'read_file', args: Record<string, unknown>): Promise<ToolResult> {
    if (this.closed) return Promise.resolve({ ok: false, text: 'closed' });
    return this.track(this.entry.host.builtin(name, args));
  }

  close(): Promise<void> {
    return this.pool.release(this);
  }
}

export class ToolHostPool {
  private readonly idle = new Map<string, PoolEntry>();
  private closed = false;
  private readonly log: VoiceLog;

  constructor(private readonly opts: ToolHostPoolOptions) {
    this.log = opts.log ?? silentLog;
  }

  /** Hosts waiting for a next call (tests, the log). */
  get idleCount(): number {
    return this.idle.size;
  }

  /** The tool host for a call of this student: their warm one when it is up and bound as they are now, else a new one. */
  acquire(folder: string, identity: string): ToolHost {
    if (this.opts.keepSec <= 0 || this.closed) return this.opts.spawn(folder);
    const key = `${folder}\u0001${identity}`;
    // a host of the same student under another binding (their GitHub was linked, say) is not theirs any more
    for (const other of [...this.idle.values()]) if (other.folder === folder && other.key !== key) void this.discard(other, 'the student is bound differently now');
    const warm = this.idle.get(key);
    if (warm) {
      this.idle.delete(key);
      if (warm.timer) clearTimeout(warm.timer);
      warm.timer = null;
      if (warm.state === 'failed' || (warm.state === 'ready' && !warm.host.alive)) {
        this.log.info({ folder }, 'voice tool host: the kept one is gone; starting a new one');
        void warm.host.close().catch(() => undefined);
      } else {
        try {
          warm.host.refresh?.();
        } catch (err) {
          this.log.warn({ folder, err: (err as Error).message }, 'voice tool host: the kept one could not be refreshed');
        }
        this.log.info({ folder, idleSec: Math.round((Date.now() - warm.parkedAt) / 1000), ready: warm.state === 'ready' }, 'voice tool host: reused for the next call');
        return new ToolHostLease(this, warm);
      }
    }
    return new ToolHostLease(this, { key, folder, host: this.opts.spawn(folder), state: 'new', timer: null, parkedAt: 0 });
  }

  /**
   * Starts a student's host BEFORE their call asks for one: the page tells the server when the call button is pressed, and the container takes
   * ten seconds or more to come up, so what the browser spends on the microphone's permission prompt (a second or three) is already time the
   * container is coming up in. The host is parked as an idle one, under the same key a call's acquire() looks for, so the call that follows
   * takes it over (still starting, or up) and one that never follows is closed after `keepSec` like any kept host.
   *
   *   warming  a host was started now
   *   warm     the student already has one waiting (nothing is started)
   *   full     `keepMax` idle hosts are waiting for their students: this one does not take another's place (park() would drop the oldest)
   *   off      there is no pool (keepSec 0: nobody would ever close a host nobody called for), the pool is closed, or the host could not be made
   *
   * Never throws, never waits for the container.
   */
  warm(folder: string, identity: string): 'warming' | 'warm' | 'full' | 'off' {
    if (this.opts.keepSec <= 0 || this.closed) return 'off';
    const key = `${folder}\u0001${identity}`;
    // a host of the same student under another binding is not theirs any more (acquire does the same)
    for (const other of [...this.idle.values()]) if (other.folder === folder && other.key !== key) void this.discard(other, 'the student is bound differently now');
    const waiting = this.idle.get(key);
    if (waiting) {
      if (waiting.state !== 'failed' && !(waiting.state === 'ready' && !waiting.host.alive)) return 'warm';
      void this.discard(waiting, 'it is not running');
    }
    if (this.idle.size >= this.opts.keepMax) return 'full';
    let host: ToolHost;
    try {
      host = this.opts.spawn(folder);
    } catch (err) {
      this.log.warn({ folder, err: (err as Error).message }, 'voice tool host: could not be made ahead of the call');
      return 'off';
    }
    const entry: PoolEntry = { key, folder, host, state: 'new', timer: null, parkedAt: 0 };
    void this.begin(entry).catch(() => undefined);
    this.park(entry);
    this.log.info({ folder }, 'voice tool host: started ahead of the call');
    return 'warming';
  }

  /** Starts the entry's host (once), and notes how that went. */
  begin(entry: PoolEntry): Promise<void> {
    if (!entry.starting) {
      entry.state = 'starting';
      entry.starting = entry.host.start().then(
        () => {
          entry.state = 'ready';
        },
        (err: Error) => {
          entry.state = 'failed';
          throw err;
        },
      );
      entry.starting.catch(() => undefined); // whoever awaits it sees the error; nobody awaiting it must not crash the process
    }
    return entry.starting;
  }

  /** A call is done with its host: kept for the next one when it is worth keeping, closed when not. Never throws. */
  release(lease: ToolHostLease): Promise<void> {
    if (lease.closed) return Promise.resolve();
    lease.closed = true;
    const entry = lease.entry;
    if (this.closed || this.opts.keepSec <= 0) return this.discard(entry, 'no pool');
    if (lease.outstanding > 0) return this.discard(entry, 'a call was still running in it');
    if (entry.state === 'failed' || (entry.state === 'ready' && !entry.host.alive)) return this.discard(entry, 'it is not running');
    if (entry.state === 'new') return this.discard(entry, 'it was never started');
    this.park(entry);
    return Promise.resolve();
  }

  private park(entry: PoolEntry): void {
    // one idle host per student; and room for this one
    for (const other of [...this.idle.values()]) if (other.folder === entry.folder) void this.discard(other, 'a newer one of the same student');
    while (this.idle.size >= this.opts.keepMax) {
      const oldest = [...this.idle.values()].sort((a, b) => a.parkedAt - b.parkedAt)[0];
      void this.discard(oldest, 'the pool is full');
    }
    entry.parkedAt = Date.now();
    this.idle.set(entry.key, entry);
    entry.timer = setTimeout(() => void this.discard(entry, 'unused for its time'), this.opts.keepSec * 1000);
    entry.timer.unref?.();
    // a host still being started when its call ended is kept as well, and dropped if it turns out not to come up
    if (entry.state === 'starting') {
      entry.starting?.catch(() => {
        if (this.idle.get(entry.key) === entry) void this.discard(entry, 'it did not start');
      });
    }
  }

  private discard(entry: PoolEntry, why: string): Promise<void> {
    if (this.idle.get(entry.key) === entry) this.idle.delete(entry.key);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.log.debug({ folder: entry.folder, why }, 'voice tool host: closed');
    return entry.host.close().catch(() => undefined);
  }

  /** The service is going down (or voice is): every idle host is closed, and none is kept from now on. */
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.idle.values()].map((entry) => this.discard(entry, 'shutdown')));
  }
}
