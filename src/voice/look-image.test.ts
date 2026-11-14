import { describe, expect, it, vi } from 'vitest';

import { CompetencyGuard } from './competency.js';
import type { FunctionEnv } from './functions.js';
import { LOOK_IMAGE_DEF, LOOK_IMAGE_NOT_AVAILABLE, LOOK_IMAGE_QUESTION_CHARS, PICTURE_NAME, lookAtImage } from './look-image.js';
import type { ToolHost, ToolResult } from './tool-host.js';
import type { VoiceLog } from './types.js';

// look_at_image in a call: the name is checked like the other upload names, the path is the host's own, it is off unless the host's switch is on, each picture is looked at once in a call, and the
// answer is the container tool's, passed on. (The function lists, the tool host's set and the speech governor's names are the lead's wiring: see the batch A report.)

const logs: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
const log: VoiceLog = {
  debug: (obj, msg) => logs.push({ level: 'debug', obj, msg }),
  info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
  warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
  error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
};
const SAW = 'What a vision model says it sees, quoted as data:\n<<<PICTURE abc\nA line chart of p99 latency against users: flat to 200 users, then a knee.\nPICTURE abc>>>';

function fakeHost(answer: ToolResult | ((tool: string, args: Record<string, unknown>) => Promise<ToolResult>) = { ok: true, text: SAW }) {
  const call = vi.fn(async (tool: string, args: Record<string, unknown>) => (typeof answer === 'function' ? answer(tool, args) : answer));
  const host = { start: async () => undefined, call, builtin: async () => ({ ok: false, text: 'no' }), close: async () => undefined, alive: true } as unknown as ToolHost;
  return { host, call };
}
const env = (host: ToolHost | null, over: Partial<FunctionEnv> = {}): FunctionEnv => ({
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
  ...over,
});
const on = () => true;
const off = () => false;
const text = async (args: Record<string, unknown>, e: FunctionEnv, vision = on): Promise<string> => lookAtImage(args, e, vision);
const failed = async (args: Record<string, unknown>, e: FunctionEnv, vision = on): Promise<string> => (JSON.parse(await text(args, e, vision)) as { error: string }).error;

describe('the function definition', () => {
  it('has the arguments the contract fixes, the training sections of the other functions, and says what it is for and where the picture goes', () => {
    expect(LOOK_IMAGE_DEF.name).toBe('look_at_image');
    expect(LOOK_IMAGE_DEF.parameters.type).toBe('object');
    expect(Object.keys(LOOK_IMAGE_DEF.parameters.properties).sort()).toEqual(['name', 'question']);
    expect(LOOK_IMAGE_DEF.parameters.required).toEqual(['name']);
    for (const part of ['WHEN TO CALL:', 'CORRECT PATTERN:', 'WRONG PATTERN:']) expect(LOOK_IMAGE_DEF.description).toContain(part);
    expect(LOOK_IMAGE_DEF.description).toMatch(/ONLY for a picture they attached here/);
    expect(LOOK_IMAGE_DEF.description).toMatch(/ONCE for each picture/);
    expect(LOOK_IMAGE_DEF.description).toMatch(/goes to an outside vision service/);
    expect(LOOK_IMAGE_DEF.defer_until_eot).toBe(true);                  // the picture leaves TAi's systems: an unconfirmed turn must not send it
  });

  it('is plain JSON a function list may carry', () => {
    expect(JSON.parse(JSON.stringify(LOOK_IMAGE_DEF))).toEqual(LOOK_IMAGE_DEF);
  });
});

describe('the host\'s switch', () => {
  it('says the function is not available, and touches no tool host, when TAI_VISION is not on', async () => {
    const { host, call } = fakeHost();
    const toolHost = vi.fn(async () => host);
    expect(await failed({ name: 'chart.png' }, env(host, { toolHost }), off)).toBe(LOOK_IMAGE_NOT_AVAILABLE);
    expect(toolHost).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(LOOK_IMAGE_NOT_AVAILABLE).toMatch(/not available in a call/);
    expect(LOOK_IMAGE_NOT_AVAILABLE).toMatch(/do not guess what it shows/);
  });

  it('asks the switch at each call, and by default the orchestrator\'s environment (exactly "1")', async () => {
    const { host } = fakeHost();
    let flag = false;
    const e = env(host);
    expect(await failed({ name: 'chart.png' }, e, () => flag)).toBe(LOOK_IMAGE_NOT_AVAILABLE);
    flag = true;
    expect(await text({ name: 'chart.png' }, e, () => flag)).toBe(SAW);
    const saved = process.env.TAI_VISION;
    try {
      delete process.env.TAI_VISION;
      expect(JSON.parse(await lookAtImage({ name: 'chart.png' }, env(host)))).toEqual({ error: LOOK_IMAGE_NOT_AVAILABLE });
      for (const value of ['true', '0', ' 1']) {
        process.env.TAI_VISION = value;
        expect(JSON.parse(await lookAtImage({ name: 'chart.png' }, env(host)))).toEqual({ error: LOOK_IMAGE_NOT_AVAILABLE });
      }
      process.env.TAI_VISION = '1';
      expect(await lookAtImage({ name: 'chart.png' }, env(host))).toBe(SAW);
    } finally {
      if (saved === undefined) delete process.env.TAI_VISION;
      else process.env.TAI_VISION = saved;
    }
  });
});

describe('what is asked of the tool host', () => {
  it('is the host\'s own path in the student\'s uploads and the student\'s question, on the default server, and the tool\'s answer comes back as it is', async () => {
    const { host, call } = fakeHost();
    expect(await text({ name: 'pasted-picture.png', question: 'what happens to p99 after 200 users?' }, env(host))).toBe(SAW);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]).toEqual(['look_at_image', { path: '/workspace/group/uploads/pasted-picture.png', question: 'what happens to p99 after 200 users?' }]);
  });

  it('leaves the question out when there is none, cuts a long one, and takes control characters out of it', async () => {
    const { host, call } = fakeHost();
    const e = env(host);
    await text({ name: 'a.png' }, e);
    expect(call.mock.calls[0][1]).toEqual({ path: '/workspace/group/uploads/a.png' });
    await text({ name: 'b.png', question: '  \n\t  ' }, e);
    expect(call.mock.calls[1][1]).toEqual({ path: '/workspace/group/uploads/b.png' });
    await text({ name: 'c.png', question: `why\n\u0000is it${' flat'.repeat(200)}` }, e);
    const question = (call.mock.calls[2][1] as { question: string }).question;
    expect(question.length).toBeLessThanOrEqual(LOOK_IMAGE_QUESTION_CHARS);
    expect(question.startsWith('why is it flat')).toBe(true);
    expect(question).not.toMatch(/[\p{Cc}]/u);
    await text({ name: 'd.png', question: 42 }, e);
    expect(call.mock.calls[3][1]).toEqual({ path: '/workspace/group/uploads/d.png' });
  });

  it('takes the file name the chat message gave, with or without the folder it lives in, and never builds a path from anything else of what the model wrote', async () => {
    const { host, call } = fakeHost();
    for (const given of ['chart.png', '/workspace/group/uploads/chart.png', 'uploads/chart.png', '../../etc/chart.png', 'C:\\Users\\me\\chart.png']) {
      await text({ name: given }, env(host));
    }
    for (const c of call.mock.calls) expect(c[1]).toEqual({ path: '/workspace/group/uploads/chart.png' });
    expect(call).toHaveBeenCalledTimes(5);
  });
});

describe('the name', () => {
  const accepted = ['chart.png', 'My_Chart-2.JPG', 'shot.jpeg', 'a.gif', 'diagram.webp', 'pasted-picture-2.png', `${'x'.repeat(95)}.png`];
  const refused = ['', ' ', 'x', 'x.go', 'x.svg', 'x.pdf', 'x.png.exe', 'a b.png', 'a;b.png', 'a$(b).png', '.hidden.png', '-x.png', '_x.png', 'x.png/', `${'x'.repeat(100)}.png`, 'a\nb.png'];

  it('is a picture\'s file name like the other uploads\': letters, digits and ._-, at most a hundred characters, with the extension of a picture', async () => {
    for (const name of accepted) {
      const { host, call } = fakeHost();
      expect(await text({ name }, env(host)), name).toBe(SAW);
      expect(call, name).toHaveBeenCalledTimes(1);
    }
  });

  it('is refused with a sentence, and nothing is asked of the tool host, when it is anything else', async () => {
    for (const name of refused) {
      const { host, call } = fakeHost();
      expect(await failed({ name }, env(host)), JSON.stringify(name)).toMatch(/give the picture's file name/);
      expect(call, JSON.stringify(name)).not.toHaveBeenCalled();
    }
    for (const bad of [undefined, null, 42, {}, [], true]) {
      const { host, call } = fakeHost();
      expect(await failed({ name: bad }, env(host)), JSON.stringify(bad)).toMatch(/give the picture's file name/);
      expect(call).not.toHaveBeenCalled();
    }
    const { host, call } = fakeHost();
    expect(await failed({}, env(host))).toMatch(/give the picture's file name/);
    expect(await failed(undefined as unknown as Record<string, unknown>, env(host))).toMatch(/give the picture's file name|did not work/);
    expect(call).not.toHaveBeenCalled();
  });

  it('is the same shape as the sandbox\'s and read_file\'s upload names', () => {
    expect(PICTURE_NAME.source).toBe('^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$');
  });
});

describe('once for each picture in a call', () => {
  it('keeps the first description and hands it back for the same picture, without sending the picture again, and looks at another picture', async () => {
    const { host, call } = fakeHost();
    const e = env(host);
    expect(await text({ name: 'a.png', question: 'first' }, e)).toBe(SAW);
    const again = await text({ name: 'a.png', question: 'a different question' }, e);
    expect(again).toContain('You looked at this picture earlier in this call');
    expect(again).toContain('It is not sent again');
    expect(again.endsWith(SAW)).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(await text({ name: 'b.png' }, e)).toBe(SAW);
    expect(call).toHaveBeenCalledTimes(2);
    // a file name is case sensitive where the uploads live: another file is another picture
    expect(await text({ name: 'A.png' }, e)).toBe(SAW);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('does not keep a look that failed, so that a second try can work', async () => {
    let n = 0;
    const { host, call } = fakeHost(async () => (++n === 1 ? { ok: false, text: 'Rate limit exceeded' } : { ok: true, text: SAW }));
    const e = env(host);
    expect(await failed({ name: 'a.png' }, e)).toMatch(/Rate limit exceeded/);
    expect(await text({ name: 'a.png' }, e)).toBe(SAW);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('is as often as the tool host allows when the call has no cache to keep it in', async () => {
    const { host, call } = fakeHost();
    const e = env(host, { cache: undefined });
    await text({ name: 'a.png' }, e);
    await text({ name: 'a.png' }, e);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('shares the cache with the course look-ups without taking a key of theirs', async () => {
    const { host } = fakeHost();
    const cache = new Map<string, { at: number; r: ToolResult }>([['files', { at: 1, r: { ok: true, text: 'the course files' } }]]);
    await text({ name: 'a.png' }, env(host, { cache }));
    expect(cache.get('files')?.r.text).toBe('the course files');
    expect([...cache.keys()].sort()).toEqual(['files', 'look_at_image:a.png']);
  });
});

describe('when it does not work', () => {
  it('says what the model can say for a tool host that is not up, that throws, that times out, that does not have the tool, and that failed', async () => {
    expect(await failed({ name: 'a.png' }, env(null))).toMatch(/not available right now/);
    expect(
      await failed(
        { name: 'a.png' },
        env(null, {
          toolHost: async () => {
            throw new Error('docker is gone');
          },
        }),
      ),
    ).toMatch(/not available right now/);
    expect(await failed({ name: 'a.png' }, env(fakeHost({ ok: false, text: 'timeout' }).host))).toMatch(/took too long/);
    for (const missing of ['MCP error -32601: Method not found', 'Tool look_at_image not found', 'unknown tool look_at_image']) {
      expect(await failed({ name: 'a.png' }, env(fakeHost({ ok: false, text: missing }).host)), missing).toBe(LOOK_IMAGE_NOT_AVAILABLE);
    }
    expect(await failed({ name: 'a.png' }, env(fakeHost({ ok: false, text: 'A picture over 4 MB is refused: ask the student for a smaller screenshot.' }).host))).toMatch(/4 MB is refused/);
    expect((await failed({ name: 'a.png' }, env(fakeHost({ ok: false, text: 'x'.repeat(2000) }).host))).length).toBe(300);
    expect(await failed({ name: 'a.png' }, env(fakeHost({ ok: false, text: '' }).host))).toBe('the tool failed');
  });

  it('never throws: a call that throws is a sentence, and the log is told without the name or the question', async () => {
    logs.length = 0;
    const { host } = fakeHost(async () => {
      throw new Error('socket closed');
    });
    expect(await failed({ name: 'secret-name.png', question: 'secret question' }, env(host))).toMatch(/did not work/);
    expect(logs.some((l) => l.level === 'warn' && l.msg === 'voice: look_at_image failed')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('secret-name');
    expect(JSON.stringify(logs)).not.toContain('secret question');
  });

  it('passes on an empty answer as a word and keeps nothing for it to be handed back', async () => {
    const { host } = fakeHost({ ok: true, text: '' });
    const e = env(host);
    expect(await text({ name: 'a.png' }, e)).toBe('(no result)');
  });
});
