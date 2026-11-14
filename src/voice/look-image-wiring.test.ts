import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompetencyGuard } from './competency.js';
import { FunctionEnv, LONG_WAIT_FUNCTIONS, PROMOTABLE_FUNCTIONS, TOOL_HOST_FUNCTIONS, runFunction } from './functions.js';
import type { ToolHost } from './tool-host.js';
import type { VoiceLog } from './types.js';

// look_at_image among a call's functions (docs/RUN_CARDS.md): a tool host function whose dispatch reaches lookAtImage, with the "taking a look" lines; it is in the lists a call is given where a call may look at
// pictures (TAI_VISION on and TAI_CALL_VISION not 0: look-image-offered.test.ts).

const log: VoiceLog = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const SAW = 'What a vision model says it sees, quoted as data: a flat line, then a knee.';
const env = (host: ToolHost | null): FunctionEnv => ({
  folder: 's_x',
  jid: 'web:s_x',
  groupDir: '/nowhere/groups/s_x',
  ipcDir: '/nowhere/data/ipc/s_x',
  today: '2026-11-01',
  now: () => 1_000,
  toolHost: async () => host,
  cache: new Map(),
  guard: new CompetencyGuard(),
  log,
});

afterEach(() => {
  delete process.env.TAI_VISION;
});

describe("look_at_image among the call's functions", () => {
  it('is a function of the tool host that gets the "taking a look" lines, and one that is not promoted to a note later', () => {
    expect(TOOL_HOST_FUNCTIONS.has('look_at_image')).toBe(true);
    expect(LONG_WAIT_FUNCTIONS.has('look_at_image')).toBe(true);
    expect(PROMOTABLE_FUNCTIONS.has('look_at_image')).toBe(false);          // the picture goes out once: a look that went on is not delivered later
  });
});

describe('the dispatch', () => {
  it('asks the tool host for the picture in the student\'s uploads, with the switch on', async () => {
    process.env.TAI_VISION = '1';
    const call = vi.fn(async () => ({ ok: true, text: SAW }));
    const host = { start: async () => undefined, call, builtin: async () => ({ ok: false, text: 'no' }), close: async () => undefined, alive: true } as unknown as ToolHost;
    expect(await runFunction('look_at_image', { name: 'chart.png', question: 'what happens after 200 users?' }, env(host))).toBe(SAW);
    expect(call).toHaveBeenCalledWith('look_at_image', { path: '/workspace/group/uploads/chart.png', question: 'what happens after 200 users?' });
  });

  it('says it is not available with the switch off, and asks nothing', async () => {
    delete process.env.TAI_VISION;
    const call = vi.fn();
    const host = { call } as unknown as ToolHost;
    const answer = JSON.parse(await runFunction('look_at_image', { name: 'chart.png' }, env(host)));
    expect(answer.error).toMatch(/not available in a call/);
    expect(call).not.toHaveBeenCalled();
  });
});
