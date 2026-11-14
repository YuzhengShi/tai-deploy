/**
 * The host side of a call's tool host (docs/VOICE.md, "Tool host"). Most of what the voice agent can do (the course knowledge graph,
 * Canvas, GitHub, Piazza, memories, messages to the chat, diagrams, schedules) is a tool of the student's agent container, behind that
 * tool's own access control and identity binding. Rather than re-implement any of it on the host, a call starts one short-lived
 * container of the same image, mounts and credentials as the student's text agent, in tool-host mode: it starts the same MCP servers and
 * answers tool calls on stdio, one JSON line each way.
 *
 *   host -> container   line 1: the ContainerInput (src/container-runner.ts spawnToolHost writes it)
 *                       then:   {"id":"7","server":"nanoclaw","tool":"canvas_query","args":{...}}   or   {"id":"8","builtin":"web_fetch","args":{...}}
 *   container -> host   "@@TOOLHOST ready@@" | "@@TOOLHOST failed@@ <reason>"   once, when its servers are up (or not)
 *                       "@@TOOLHOST@@ {"id":"7","ok":true,"text":"..."}"          one per answer; any other output is logged and ignored
 *
 * The host ends it by closing stdin (the container exits within 5 s), and removes the container by name in any case.
 */
import { ChildProcess, execFile } from 'child_process';

import type { VoiceLog } from './types.js';
import { silentLog } from './types.js';

export interface ToolResult {
  ok: boolean;
  text: string;
}

export interface ToolHost {
  /** Resolves when the container says ready; rejects when it says failed, exits, or is not ready in 30 s. */
  start(): Promise<void>;
  call(tool: string, args: Record<string, unknown>, opts?: { server?: string; timeoutMs?: number }): Promise<ToolResult>;
  builtin(name: 'web_fetch' | 'read_file', args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
  readonly alive: boolean;
  /**
   * Writes again what the container reads from the mounted group folder and that is made from the database (memory_store.json), so that a
   * host kept for a student's next call does not answer from what was true when it started (tool-host-pool.ts calls it before a reuse).
   */
  refresh?(): void;
}

export interface SpawnedToolHost {
  process: ChildProcess;
  containerName: string;
  /** src/container-runner.ts spawnToolHost: the memory export, written again. */
  refresh?: () => void;
}

export interface DockerToolHostOptions {
  /** Starts the container (src/container-runner.ts spawnToolHost for this student's group). */
  spawn: () => Promise<SpawnedToolHost>;
  readyTimeoutMs?: number;
  /** How long the host waits for one answer; the container gives up on a tool at 60 s and says so. */
  callTimeoutMs?: number;
  exitWaitMs?: number;
  /** Removes the container by name (default: docker rm -f). */
  remove?: (containerName: string) => Promise<void>;
  log?: VoiceLog;
}

const READY = '@@TOOLHOST ready@@';
const FAILED = '@@TOOLHOST failed@@';
const ANSWER = '@@TOOLHOST@@';
const MAX_LINE = 4 * 1024 * 1024;

function dockerRemove(containerName: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      execFile('docker', ['rm', '-f', containerName], { timeout: 15_000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

interface Pending {
  resolve: (r: ToolResult) => void;
  timer: NodeJS.Timeout;
}

export class DockerToolHost implements ToolHost {
  private proc: ChildProcess | null = null;
  private containerName = '';
  private starting: Promise<void> | null = null;
  private ready = false;
  private exited = false;
  private closing = false;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private buffer = '';
  private exitWaiters: Array<() => void> = [];
  private failedReason = '';
  private tearingDown: Promise<void> | null = null;
  private refreshCaches: (() => void) | undefined;
  private readonly log: VoiceLog;

  constructor(private readonly opts: DockerToolHostOptions) {
    this.log = opts.log ?? silentLog;
  }

  get alive(): boolean {
    return this.ready && !this.exited && !this.closing;
  }

  refresh(): void {
    try {
      this.refreshCaches?.();
    } catch (err) {
      this.log.warn({ container: this.containerName, err: (err as Error).message }, 'voice tool host: its caches could not be refreshed');
    }
    this.newCall();
  }

  /**
   * A call begins on a host that was kept from the last one: tells the container, so that its per-call tool limits start from zero (they ran on
   * from call to call: the fifth call of a morning was refused "max 30 calls" at its first Canvas lookup). Nothing waits for the answer line, which has
   * no one pending and is ignored; the container reads its lines in order, so every call after this one sees the reset.
   */
  private newCall(): void {
    const stdin = this.proc?.stdin;
    if (!this.alive || !stdin || stdin.destroyed) return;
    try {
      stdin.write(JSON.stringify({ id: `new-call-${++this.seq}`, control: 'new-call' }) + '\n');
    } catch {
      // the container is gone: the next call finds out, as it does for any tool
    }
  }

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.launch();
      this.starting.catch(() => undefined); // whoever awaits it sees the error; nobody awaiting it must not crash the process
    }
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (this.closing) throw new Error('closed');
    const spawned = await this.opts.spawn();
    this.proc = spawned.process;
    this.containerName = spawned.containerName;
    this.refreshCaches = spawned.refresh;
    const proc = spawned.process;

    // the listeners go on at once, whatever happens next: the exit must be seen even by a teardown that starts right away
    let settle: (err?: Error) => void = () => undefined;
    const onExit = (code: number | null) => {
      if (this.exited) return;
      this.exited = true;
      settle(new Error(`the tool host exited (${code ?? 'signal'}) before it was ready`));
      this.failAll(this.closing ? 'closed' : 'the tool host stopped');
      for (const wake of this.exitWaiters.splice(0)) wake();
      if (!this.closing) this.log.warn({ container: this.containerName, code }, 'voice tool host exited');
    };
    proc.on('error', (err) => {
      this.log.warn({ container: this.containerName, err: err.message }, 'voice tool host process error');
      onExit(null);
    });
    proc.on('exit', onExit);
    proc.stdin?.on('error', () => undefined); // EPIPE when the container is gone: the pending calls fail on exit
    proc.stdout?.on('error', () => undefined);
    proc.stderr?.on('error', () => undefined);
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) this.log.debug({ container: this.containerName, stderr: text.slice(0, 500) }, 'voice tool host');
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      if (this.buffer.length > MAX_LINE && !this.buffer.includes('\n')) {
        this.log.warn({ container: this.containerName }, 'voice tool host: a line over 4 MB was dropped');
        this.buffer = '';
        return;
      }
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, '');
        this.buffer = this.buffer.slice(nl + 1);
        this.onLine(line, (err) => settle(err));
      }
    });

    if (this.closing) {
      // the call ended while the container was being started (readSecrets can take a while): stop what was started, or it would sit
      // there with its stdin open until the next start of the orchestrator
      await this.teardown();
      throw new Error('closed');
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settle(new Error('the tool host was not ready in time'));
        void this.close();
      }, this.opts.readyTimeoutMs ?? 30_000);
      settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      if (this.failedReason) settle(new Error(`the tool host failed to start: ${this.failedReason}`));
      else if (this.exited) settle(new Error('the tool host exited before it was ready'));
      else if (this.ready) settle();
    });
  }

  private onLine(line: string, settle: (err?: Error) => void): void {
    if (line === READY || line.startsWith(READY)) {
      this.ready = true;
      settle();
      return;
    }
    if (line.startsWith(FAILED)) {
      const reason = line.slice(FAILED.length).trim().slice(0, 300) || 'unknown';
      this.failedReason = reason;
      settle(new Error(`the tool host failed to start: ${reason}`));
      void this.close();
      return;
    }
    if (!line.startsWith(ANSWER)) {
      if (line.trim()) this.log.debug({ container: this.containerName, line: line.slice(0, 300) }, 'voice tool host output');
      return;
    }
    let answer: { id?: unknown; ok?: unknown; text?: unknown; error?: unknown };
    try {
      answer = JSON.parse(line.slice(ANSWER.length).trim());
    } catch {
      this.log.warn({ container: this.containerName }, 'voice tool host: an answer that is not JSON');
      return;
    }
    const id = typeof answer.id === 'string' ? answer.id : typeof answer.id === 'number' ? String(answer.id) : '';
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const ok = answer.ok === true;
    const text = ok ? (typeof answer.text === 'string' ? answer.text : '') : typeof answer.error === 'string' ? answer.error : typeof answer.text === 'string' ? answer.text : 'failed';
    pending.resolve({ ok, text });
  }

  private send(message: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
    if (!this.alive || !this.proc?.stdin || this.proc.stdin.destroyed) return Promise.resolve({ ok: false, text: 'the tool host is not running' });
    const id = String(++this.seq);
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, text: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.proc!.stdin!.write(JSON.stringify({ id, ...message }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, text: `the tool host could not be reached (${(err as Error).message})` });
      }
    });
  }

  /**
   * A tool call. Without timeoutMs the container cuts the call at 60 s; with it, the line asks the container for that much (it caps the
   * request at 120 s) and the host waits five seconds longer, so the container's own "timeout" answer arrives before the host gives up.
   */
  call(tool: string, args: Record<string, unknown>, opts: { server?: string; timeoutMs?: number } = {}): Promise<ToolResult> {
    if (opts.timeoutMs !== undefined) {
      const asked = Math.min(Math.max(Math.floor(opts.timeoutMs), 1000), 120_000);
      return this.send({ server: opts.server || 'nanoclaw', tool, args, timeoutMs: asked }, asked + 5000);
    }
    return this.send({ server: opts.server || 'nanoclaw', tool, args }, this.opts.callTimeoutMs ?? 65_000);
  }

  builtin(name: 'web_fetch' | 'read_file', args: Record<string, unknown>): Promise<ToolResult> {
    return this.send({ builtin: name, args }, this.opts.callTimeoutMs ?? 65_000);
  }

  private failAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, text: reason });
      this.pending.delete(id);
    }
  }

  /**
   * Ends the tool host. With a container started, that is the teardown (once, however often it is asked for). With the container still
   * being started, the start sees `closing` when the spawn returns and tears down what it started itself.
   */
  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.failAll('closed');
    }
    if (this.proc) await this.teardown();
  }

  private teardown(): Promise<void> {
    if (!this.tearingDown) this.tearingDown = this.stop();
    return this.tearingDown;
  }

  /** stdin closed (the container exits within 5 s), a kill when it does not, and docker rm -f by name in any case. Never throws. */
  private async stop(): Promise<void> {
    const proc = this.proc;
    if (proc && !this.exited) {
      try {
        proc.stdin?.end();
      } catch {
        /* gone */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.exitWaitMs ?? 5000);
        this.exitWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!this.exited) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
    if (this.containerName) await (this.opts.remove ?? dockerRemove)(this.containerName).catch(() => undefined);
  }
}

/** A tool host for tests: answers from handlers ("server:tool", "tool" or "builtin:name"), records every call. */
export class FakeToolHost implements ToolHost {
  readonly calls: Array<{ server: string; tool: string; args: Record<string, unknown>; builtin: boolean; timeoutMs?: number }> = [];
  handlers: Record<string, (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>> = {};
  startError: Error | null = null;
  startDelayMs = 0;
  started = false;
  closed = false;
  /** How often refresh() was called (a host that is reused), and start() (a container started). */
  refreshed = 0;
  starts = 0;

  constructor(handlers: FakeToolHost['handlers'] = {}) {
    this.handlers = handlers;
  }

  get alive(): boolean {
    return this.started && !this.closed;
  }

  refresh(): void {
    this.refreshed++;
  }

  async start(): Promise<void> {
    this.starts++;
    if (this.startDelayMs) await new Promise((r) => setTimeout(r, this.startDelayMs));
    if (this.startError) throw this.startError;
    this.started = true;
  }

  async call(tool: string, args: Record<string, unknown>, opts: { server?: string; timeoutMs?: number } = {}): Promise<ToolResult> {
    const server = opts.server || 'nanoclaw';
    this.calls.push({ server, tool, args, builtin: false, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (!this.alive) return { ok: false, text: 'the tool host is not running' };
    const handler = this.handlers[`${server}:${tool}`] ?? this.handlers[tool];
    return handler ? handler(args) : { ok: true, text: `${tool} answered` };
  }

  async builtin(name: 'web_fetch' | 'read_file', args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ server: 'builtin', tool: name, args, builtin: true });
    if (!this.alive) return { ok: false, text: 'the tool host is not running' };
    const handler = this.handlers[`builtin:${name}`];
    return handler ? handler(args) : { ok: true, text: `${name} answered` };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
