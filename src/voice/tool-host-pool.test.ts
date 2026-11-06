import { describe, expect, it } from 'vitest';

import { FakeToolHost } from './tool-host.js';
import { ToolHostPool } from './tool-host-pool.js';

/** A pool whose hosts are recorded, with a keep time short enough to wait out. */
function poolOf(opts: { keepSec?: number; keepMax?: number } = {}) {
  const spawned: Array<{ folder: string; host: FakeToolHost }> = [];
  const pool = new ToolHostPool({
    spawn: (folder) => {
      const host = new FakeToolHost();
      spawned.push({ folder, host });
      return host;
    },
    keepSec: opts.keepSec ?? 60,
    keepMax: opts.keepMax ?? 3,
  });
  return { pool, spawned };
}

const flush = () => new Promise((r) => setTimeout(r, 15));

describe('the tool host pool', () => {
  it('is no pool at all with a keep time of 0: the call gets the plain host and closes it', async () => {
    const { pool, spawned } = poolOf({ keepSec: 0 });
    const th = pool.acquire('s_a', 'x');
    expect(th).toBe(spawned[0].host);
    await th.start();
    await th.close();
    expect(spawned[0].host.closed).toBe(true);
    expect(pool.idleCount).toBe(0);
  });

  it('keeps the host of a call that ended and hands it to the same student\'s next call, started once and refreshed', async () => {
    const { pool, spawned } = poolOf();
    const first = pool.acquire('s_a', 'canvas1|gh1');
    await first.start();
    expect(await first.call('canvas_query', { action: 'upcoming' })).toMatchObject({ ok: true });
    await first.close();
    expect(spawned[0].host.closed).toBe(false);
    expect(pool.idleCount).toBe(1);
    expect(first.alive).toBe(false); // the first call has let go of it
    expect(await first.call('canvas_query', {})).toEqual({ ok: false, text: 'closed' });

    const second = pool.acquire('s_a', 'canvas1|gh1');
    expect(spawned).toHaveLength(1); // no second container
    expect(spawned[0].host.refreshed).toBe(1); // what the database says now is written again
    expect(pool.idleCount).toBe(0);
    expect(second.alive).toBe(true); // up from the first moment: the first look-up of the call does not wait
    await second.start(); // already up: no second start of the container
    expect(spawned[0].host.starts).toBe(1);
    expect(await second.call('canvas_query', { action: 'upcoming' })).toMatchObject({ ok: true });
    expect(spawned[0].host.calls).toHaveLength(2);
  });

  it('never gives one student the host of another, nor the host of a binding the student no longer has', async () => {
    const { pool, spawned } = poolOf();
    const a = pool.acquire('s_a', 'c1|g1');
    await a.start();
    await a.close();
    const b = pool.acquire('s_b', 'c1|g1'); // the same binding text, another student
    await b.start();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].folder).toBe('s_b');
    await b.close();
    expect(pool.idleCount).toBe(2);

    // the student's GitHub was bound since: the host started without it is closed, a new one started with it
    const again = pool.acquire('s_a', 'c1|g2');
    await again.start();
    expect(spawned).toHaveLength(3);
    expect(spawned[0].host.closed).toBe(true);
    expect(spawned[1].host.closed).toBe(false); // s_b's is untouched
    expect(spawned[0].host.refreshed).toBe(0);
  });

  it('closes an idle host after its time, and the oldest when there is no room', async () => {
    const { pool, spawned } = poolOf({ keepSec: 0.06, keepMax: 2 });
    const a = pool.acquire('s_a', '');
    await a.start();
    await a.close();
    await new Promise((r) => setTimeout(r, 120));
    expect(spawned[0].host.closed).toBe(true);
    expect(pool.idleCount).toBe(0);

    const room = poolOf({ keepSec: 60, keepMax: 2 });
    for (const folder of ['s_1', 's_2', 's_3']) {
      const th = room.pool.acquire(folder, '');
      await th.start();
      await th.close();
      await flush();
    }
    expect(room.pool.idleCount).toBe(2);
    expect(room.spawned.map((s) => s.host.closed)).toEqual([true, false, false]);
    await room.pool.closeAll();
  });

  it('keeps one idle host per student', async () => {
    const { pool, spawned } = poolOf();
    // two calls of one student overlapped (the first still being saved when the second began): both give theirs back
    const a = pool.acquire('s_a', 'x');
    await a.start();
    const b = pool.acquire('s_a', 'x');
    await b.start();
    expect(spawned).toHaveLength(2);
    await a.close();
    await b.close();
    expect(pool.idleCount).toBe(1);
    expect(spawned.filter((s) => !s.host.closed)).toHaveLength(1);
    await pool.closeAll();
  });

  it('does not keep a host that had a call running in it, a host that has died, or one that never came up', async () => {
    const { pool, spawned } = poolOf();
    const busy = pool.acquire('s_a', '');
    await busy.start();
    spawned[0].host.handlers.slow = () => new Promise(() => undefined); // never answers
    void busy.call('slow', {});
    await busy.close();
    expect(spawned[0].host.closed).toBe(true);
    expect(pool.idleCount).toBe(0);

    const dying = pool.acquire('s_b', '');
    await dying.start();
    spawned[1].host.closed = true; // the container is gone
    await dying.close();
    expect(pool.idleCount).toBe(0);

    const never = pool.acquire('s_c', '');
    await never.close(); // start() was never called
    expect(spawned[2].host.closed).toBe(true);
    expect(pool.idleCount).toBe(0);
  });

  it('replaces a kept host that died while it waited', async () => {
    const { pool, spawned } = poolOf();
    const a = pool.acquire('s_a', '');
    await a.start();
    await a.close();
    spawned[0].host.closed = true; // it died while it was kept
    const b = pool.acquire('s_a', '');
    await b.start();
    expect(spawned).toHaveLength(2);
    expect(b.alive).toBe(true);
  });

  it('keeps a host that was still starting when its call ended, for the next call to adopt, and drops it when it does not come up', async () => {
    const { pool, spawned } = poolOf();
    const first = pool.acquire('s_a', '');
    spawned[0].host.startDelayMs = 80;
    const starting = first.start();
    await first.close(); // the call ended while the container was coming up
    expect(spawned[0].host.closed).toBe(false);
    const second = pool.acquire('s_a', ''); // the next call arrives before it is up
    expect(spawned).toHaveLength(1);
    expect(second.alive).toBe(false);
    await second.start();
    await starting;
    expect(second.alive).toBe(true);

    const failing = poolOf();
    const f1 = failing.pool.acquire('s_b', '');
    failing.spawned[0].host.startDelayMs = 40;
    failing.spawned[0].host.startError = new Error('no docker');
    const failed = f1.start().catch(() => 'failed');
    await f1.close();
    expect(failing.pool.idleCount).toBe(1);
    expect(await failed).toBe('failed');
    await flush();
    expect(failing.pool.idleCount).toBe(0);
    expect(failing.spawned[0].host.closed).toBe(true);
    await pool.closeAll();
  });

  it('closes every idle host when the service goes down, and keeps none after', async () => {
    const { pool, spawned } = poolOf();
    for (const folder of ['s_1', 's_2']) {
      const th = pool.acquire(folder, '');
      await th.start();
      await th.close();
    }
    const late = pool.acquire('s_3', '');
    await late.start();
    await pool.closeAll();
    expect(spawned.slice(0, 2).every((s) => s.host.closed)).toBe(true);
    await late.close(); // a call that ends after: its host goes with it
    expect(spawned[2].host.closed).toBe(true);
    expect(pool.idleCount).toBe(0);
    const afterwards = pool.acquire('s_4', '');
    expect(afterwards).toBe(spawned[3].host); // the plain host: no pool any more
  });

  describe('a host started before the call asks for it (warm)', () => {
    it('is started at once, parked under the key a call looks for, and taken over by that student\'s next call: one container, started once', async () => {
      const { pool, spawned } = poolOf();
      spawned.length = 0;
      expect(pool.warm('s_a', 'c1|g1')).toBe('warming');
      expect(spawned).toHaveLength(1);
      expect(spawned[0].host.starts).toBe(1); // the container is coming up now, not when the call asks
      expect(pool.idleCount).toBe(1);
      const call = pool.acquire('s_a', 'c1|g1');
      expect(spawned).toHaveLength(1); // no second container
      await call.start(); // the call's own start() is the one that is already going
      expect(spawned[0].host.starts).toBe(1);
      expect(call.alive).toBe(true);
      expect(pool.idleCount).toBe(0);
      expect(await call.call('canvas_query', { action: 'upcoming' })).toMatchObject({ ok: true });
      await pool.closeAll();
    });

    it('answers at once: it does not wait for the container, which takes seconds', async () => {
      const slow = new FakeToolHost();
      slow.startDelayMs = 5000;
      const pool = new ToolHostPool({ spawn: () => slow, keepSec: 60, keepMax: 3 });
      const began = Date.now();
      expect(pool.warm('s_a', '')).toBe('warming');
      expect(Date.now() - began).toBeLessThan(200);
      expect(slow.alive).toBe(false); // not up yet: the answer did not wait for it
      expect(slow.starts).toBe(1); // but it is on its way
      await pool.closeAll();
      expect(slow.closed).toBe(true);
    });

    it('starts nothing for a student who already has a host waiting, and says so', async () => {
      const { pool, spawned } = poolOf();
      const first = pool.acquire('s_a', 'x');
      await first.start();
      await first.close();
      spawned.length = 0;
      expect(pool.warm('s_a', 'x')).toBe('warm');
      expect(pool.warm('s_a', 'x')).toBe('warm');
      expect(spawned).toHaveLength(0);
      expect(pool.idleCount).toBe(1);
      await pool.closeAll();
    });

    it('never takes another student\'s place: with the pool full it refuses, and nobody\'s kept host is closed', async () => {
      const { pool, spawned } = poolOf({ keepMax: 2 });
      for (const folder of ['s_1', 's_2']) {
        const th = pool.acquire(folder, '');
        await th.start();
        await th.close();
      }
      expect(pool.idleCount).toBe(2);
      expect(pool.warm('s_3', '')).toBe('full');
      expect(spawned).toHaveLength(2); // nothing was even made for s_3
      expect(spawned.every((s) => !s.host.closed)).toBe(true);
      expect(pool.idleCount).toBe(2);
      // and the same student's host replaces nothing either: they have one
      expect(pool.warm('s_1', '')).toBe('warm');
      await pool.closeAll();
    });

    it('is off with a keep time of 0 (nothing would ever close it), and after the service has gone down', async () => {
      const none = poolOf({ keepSec: 0 });
      none.spawned.length = 0;
      expect(none.pool.warm('s_a', '')).toBe('off');
      expect(none.spawned).toHaveLength(0);
      const { pool, spawned } = poolOf();
      spawned.length = 0;
      expect(pool.warm('s_a', '')).toBe('warming');
      await pool.closeAll();
      expect(spawned[0].host.closed).toBe(true);
      expect(pool.warm('s_b', '')).toBe('off');
      expect(spawned).toHaveLength(1);
    });

    it('closes a host that nobody called for after the keep time, like any kept host', async () => {
      const { pool, spawned } = poolOf({ keepSec: 0.06 });
      spawned.length = 0;
      expect(pool.warm('s_a', '')).toBe('warming');
      await new Promise((r) => setTimeout(r, 140));
      expect(spawned[0].host.closed).toBe(true);
      expect(pool.idleCount).toBe(0);
    });

    it('drops a host that does not come up, and starts a new one over one that has died', async () => {
      const failing = poolOf();
      failing.spawned.length = 0;
      const host = new FakeToolHost();
      host.startError = new Error('no docker');
      const bad = new ToolHostPool({ spawn: () => { failing.spawned.push({ folder: 's_a', host }); return host; }, keepSec: 60, keepMax: 3 });
      expect(bad.warm('s_a', '')).toBe('warming');
      await flush();
      expect(bad.idleCount).toBe(0);
      expect(host.closed).toBe(true);

      const { pool, spawned } = poolOf();
      spawned.length = 0;
      expect(pool.warm('s_a', '')).toBe('warming');
      await flush();
      spawned[0].host.closed = true; // it died while it waited
      expect(pool.warm('s_a', '')).toBe('warming');
      expect(spawned).toHaveLength(2);
      expect(pool.idleCount).toBe(1);
      await pool.closeAll();
    });

    it('is bound to the student as they are now: a host started for another binding is closed, not handed on', async () => {
      const { pool, spawned } = poolOf();
      spawned.length = 0;
      expect(pool.warm('s_a', 'c1|g1')).toBe('warming');
      expect(pool.warm('s_a', 'c1|g2')).toBe('warming'); // their GitHub was bound since
      expect(spawned).toHaveLength(2);
      expect(spawned[0].host.closed).toBe(true);
      expect(spawned[1].host.closed).toBe(false);
      expect(pool.idleCount).toBe(1);
      await pool.closeAll();
    });

    it('answers "off" and keeps nothing when the host cannot even be made', () => {
      const pool = new ToolHostPool({ spawn: () => { throw new Error('no such group'); }, keepSec: 60, keepMax: 3 });
      expect(pool.warm('s_a', '')).toBe('off');
      expect(pool.idleCount).toBe(0);
    });
  });

  it('hands a host out even when its refresh fails', async () => {
    const { pool, spawned } = poolOf();
    const a = pool.acquire('s_a', '');
    await a.start();
    await a.close();
    spawned[0].host.refresh = () => {
      throw new Error('disk full');
    };
    const b = pool.acquire('s_a', '');
    await b.start();
    expect(spawned).toHaveLength(1);
    expect(b.alive).toBe(true);
  });
});
