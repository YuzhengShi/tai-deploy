/**
 * What voice has cost, per student and per day, and how many calls are on right now. Deepgram bills every minute a call is connected,
 * so both are hard limits (TAI_VOICE_DAILY_MIN, TAI_VOICE_MAX_CONCURRENT), not statistics.
 *
 * The daily minutes live in store/voice-usage.json so a restart of the orchestrator does not hand everybody a fresh budget. Seconds are
 * added while a call runs (every tick of the session), so a crash loses at most a few seconds of accounting. A day is the host's local
 * calendar day; a call that runs over midnight counts its later minutes to the new day. Only the last two weeks are kept.
 */
import fs from 'fs';
import path from 'path';

interface UsageFile {
  version: 1;
  /** day (YYYY-MM-DD) -> folder -> seconds */
  days: Record<string, Record<string, number>>;
}

const KEEP_DAYS = 14;
const FOLDER = /^[A-Za-z0-9_-]{1,64}$/;

export interface UsageOptions {
  now?: () => number;
  /** IANA zone for the calendar day (default: the process's own). */
  timeZone?: string;
  /** How long writes may be held back and batched (default 5 s; 0 writes every change at once). */
  flushDelayMs?: number;
  warn?: (message: string) => void;
}

export class VoiceUsage {
  private data: UsageFile = { version: 1, days: {} };
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly warn: (message: string) => void;
  private readonly dayFormat: Intl.DateTimeFormat;

  constructor(
    private readonly file: string,
    opts: UsageOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.flushDelayMs = opts.flushDelayMs ?? 5000;
    this.warn = opts.warn ?? (() => undefined);
    let zone = opts.timeZone;
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    } catch {
      zone = undefined;
    }
    this.dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    this.load();
  }

  /** YYYY-MM-DD of the host's calendar for a moment. */
  dayOf(ms: number): string {
    return this.dayFormat.format(new Date(ms));
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf-8');
    } catch {
      return; // nothing used yet
    }
    try {
      const parsed = JSON.parse(text) as Partial<UsageFile>;
      const days: UsageFile['days'] = {};
      if (parsed && typeof parsed.days === 'object' && parsed.days) {
        for (const [day, folders] of Object.entries(parsed.days)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !folders || typeof folders !== 'object') continue;
          const clean: Record<string, number> = {};
          for (const [folder, seconds] of Object.entries(folders)) {
            if (FOLDER.test(folder) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) clean[folder] = seconds;
          }
          days[day] = clean;
        }
      }
      this.data = { version: 1, days };
    } catch {
      // A file that does not parse must not wipe the budget silently and must not stop voice: keep it aside and start counting again.
      this.warn(`${this.file} does not parse: kept as ${path.basename(this.file)}.broken, counting from zero`);
      try {
        fs.renameSync(this.file, `${this.file}.broken`);
      } catch {
        /* nothing we can do */
      }
    }
  }

  /** Seconds this student has used today. */
  usedSeconds(folder: string): number {
    return this.data.days[this.dayOf(this.now())]?.[folder] ?? 0;
  }

  /** Counts seconds of a running call to today. */
  add(folder: string, seconds: number): void {
    if (!FOLDER.test(folder) || !Number.isFinite(seconds) || seconds <= 0) return;
    const day = this.dayOf(this.now());
    const bucket = (this.data.days[day] ??= {});
    bucket[folder] = Math.round(((bucket[folder] ?? 0) + seconds) * 1000) / 1000;
    this.dirty = true;
    if (this.flushDelayMs <= 0) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushDelayMs);
      this.timer.unref?.();
    }
  }

  /** Writes what changed (temp file and rename, so a crash mid-write leaves the old file). Never throws. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.warn(`could not write ${this.file}: ${(err as Error).message}`);
    }
  }

  private prune(): void {
    const days = Object.keys(this.data.days).sort();
    while (days.length > KEEP_DAYS) delete this.data.days[days.shift() as string];
  }
}

/**
 * The calls that are on: at most `max` on the host and one per student. A slot is taken synchronously, before anything is awaited, so two
 * starts racing each other cannot both get in; every way a call ends gives it back.
 */
export class CallSlots {
  private held = new Set<string>();

  constructor(private readonly max: number) {}

  /** 'ok', or why not: this student has a call already, or the host is full. */
  take(folder: string): 'ok' | 'student-busy' | 'host-full' {
    if (this.held.has(folder)) return 'student-busy';
    if (this.held.size >= this.max) return 'host-full';
    this.held.add(folder);
    return 'ok';
  }

  release(folder: string): void {
    this.held.delete(folder);
  }

  has(folder: string): boolean {
    return this.held.has(folder);
  }

  get count(): number {
    return this.held.size;
  }
}
