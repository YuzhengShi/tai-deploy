import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Solver } from '../choices-check.js';
import { OutboxEntry, WebChannel } from './web.js';

const QUIZ = `Which of these is true of a Raft term?
<choices>
<option>Every heartbeat starts a new term</option>
<option correct>A term has at most one leader</option>
<option>The term number can go down after a failure</option>
<why>Terms only go up.</why>
</choices>`;

describe('what the web channel hands on of TAi\'s words', () => {
  const kept = { log: process.env.TAI_WEB_OUTBOX_LOG, choices: process.env.TAI_CHOICES };

  beforeEach(() => {
    process.env.TAI_WEB_OUTBOX_LOG = '0';                 // no copy of the test's messages in the real store
    delete process.env.TAI_CHOICES;
    vi.spyOn(Math, 'random').mockReturnValue(0.999);      // the shuffle of a quick check's options leaves the order as it was (unless a test says otherwise)
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [name, value] of [['TAI_WEB_OUTBOX_LOG', kept.log], ['TAI_CHOICES', kept.choices]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** `solvers`: the independent models that check a quick check's answer; none unless a test gives some (no call goes to a gateway from here). */
  function channel(solvers: Solver[] = []) {
    const web = new WebChannel({ onMessage: () => undefined, onChatMetadata: () => undefined, registeredGroups: () => ({}), registerGroup: () => undefined, solvers });
    const seen: OutboxEntry[] = [];
    web.onOutbound((entry) => seen.push(entry));
    return { web, seen };
  }

  it('takes the options out of a student\'s message: the words, the options, whether it is a quick check, and the host\'s answer', async () => {
    const { web, seen } = channel();
    await web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: 'text',
      jid: 'web:s_0123456789abcdef0123',
      text: 'Which of these is true of a Raft term?',
      quiz: true,
      secret: { key: 1, why: 'Terms only go up.' },
    });
    expect(seen[0].choices?.map((c) => `${c.label}: ${c.text}`)).toEqual([
      'A: Every heartbeat starts a new term',
      'B: A term has at most one leader',
      'C: The term number can go down after a failure',
    ]);
  });

  it('puts the options of a quick check in a random order, and the answer still points at the words TAi marked', async () => {
    vi.mocked(Math.random).mockRestore();
    const { web, seen } = channel();
    const places = new Set<number>();
    for (let i = 0; i < 60; i++) await web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    for (const entry of seen) {
      expect(entry.choices!.map((c) => c.label)).toEqual(['A', 'B', 'C']);
      expect(entry.choices![entry.secret!.key!].text).toBe('A term has at most one leader');
      places.add(entry.secret!.key!);
    }
    expect([...places].sort()).toEqual([0, 1, 2]);
  });

  it('keeps the answer when the independent solvers back it, and tells them the options in the order the student sees', async () => {
    const asked: string[] = [];
    const agree: Solver = async (_q, options) => {
      asked.push(options.map((o) => o.text).join('|'));
      return 'B';                                          // the order is unshuffled here: B is the marked option
    };
    const { web, seen } = channel([agree, agree]);
    await web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    expect(seen[0].secret).toEqual({ key: 1, why: 'Terms only go up.' });
    expect(seen[0].quiz).toBe(true);
    expect(asked).toEqual(['Every heartbeat starts a new term|A term has at most one leader|The term number can go down after a failure', asked[0]]);
  });

  it('drops the answer, and says why, when a solver does not agree with it: the options stay and the page gets no verdict to show', async () => {
    const { web, seen } = channel([async () => 'B', async () => 'C']);
    await web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    expect(seen[0].choices).toHaveLength(3);
    expect(seen[0].quiz).toBe(true);
    expect(seen[0].secret).toEqual({ why: 'Terms only go up.', doubt: true });
    expect(seen[0].secret).not.toHaveProperty('key');
  });

  it('drops it too when a solver finds no option right, or more than one', async () => {
    const { web, seen } = channel([async () => 'NONE']);
    await web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    expect(seen[0].secret).toMatchObject({ doubt: true });
  });

  it('keeps the answer as TAi wrote it when no solver can say', async () => {
    const { web, seen } = channel([async () => null]);
    await web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    expect(seen[0].secret).toEqual({ key: 1, why: 'Terms only go up.' });
    const none = channel([]);
    await none.web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    expect(none.seen[0].secret).toEqual({ key: 1, why: 'Terms only go up.' });
  });

  it('asks no solver about a question with no answer marked, or a message with no options', async () => {
    const solver = vi.fn(async () => 'A');
    const { web } = channel([solver]);
    await web.sendMessage('web:s_0123456789abcdef0123', 'Which part?\n<choices><option>x</option><option>y</option></choices>');
    await web.sendMessage('web:s_0123456789abcdef0123', 'Just words.');
    expect(solver).not.toHaveBeenCalled();
  });

  it('is only a question with options when TAi marked no answer', async () => {
    const { web, seen } = channel();
    await web.sendMessage('web:s_0123456789abcdef0123', 'Which part is confusing?\n<choices><option>the election</option><option>the log</option></choices>');
    expect(seen[0].choices).toHaveLength(2);
    expect(seen[0].quiz).toBeUndefined();
    expect(seen[0].secret).toBeUndefined();
    await web.sendMessage('web:s_0123456789abcdef0123', 'Which?\n<choices quiz><option>a</option><option>b</option><why>only a note</why></choices>');
    expect(seen[1]).toMatchObject({ quiz: true, secret: { why: 'only a note' } });
    expect(seen[1].secret).not.toHaveProperty('key');
  });

  it('leaves a message with no options exactly as it is', async () => {
    const { web, seen } = channel();
    await web.sendMessage('web:s_0123456789abcdef0123', '  Raft has terms.\n\n- one\n- two ');
    expect(seen[0].text).toBe('  Raft has terms.\n\n- one\n- two ');
    expect(seen[0].choices).toBeUndefined();
    expect(seen[0]).not.toHaveProperty('secret');
  });

  it('gives the instructor\'s admin chat TAi\'s text as it is', async () => {
    const { web, seen } = channel();
    await web.sendMessage('web:main', QUIZ);
    expect(seen[0].text).toBe(QUIZ);
    expect(seen[0].choices).toBeUndefined();
  });

  it('is switched off by TAI_CHOICES=0: the options are a plain list and nothing is hidden for the host', async () => {
    process.env.TAI_CHOICES = '0';
    const { web, seen } = channel();
    await web.sendMessage('web:s_0123456789abcdef0123', QUIZ);
    expect(seen[0].choices).toBeUndefined();
    expect(seen[0]).not.toHaveProperty('secret');
    expect(seen[0].text).toBe('Which of these is true of a Raft term?\n\nA. Every heartbeat starts a new term\nB. A term has at most one leader\nC. The term number can go down after a failure');
  });
});
