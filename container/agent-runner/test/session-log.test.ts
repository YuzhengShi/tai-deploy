import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendInteraction, KEEP_INTERACTIONS, messageTexts, visibleText } from '../src/session-log.js';

describe('messageTexts', () => {
  it('takes the student words out of the host wrapper and unescapes them', () => {
    const prompt =
      '<messages>\n<message id="1" sender="Ann" time="1:00 PM">how do I use a &lt;chan&gt; &amp; a mutex? say &quot;hi&quot;</message>\n' +
      '<message id="2" sender="Ann" time="1:01 PM">and a WaitGroup?</message>\n</messages>';
    expect(messageTexts(prompt)).toEqual(['how do I use a <chan> & a mutex? say "hi"', 'and a WaitGroup?']);
  });

  it('keeps text that is not wrapped', () => {
    expect(messageTexts('  plain text  ')).toEqual(['plain text']);
    expect(messageTexts('')).toEqual([]);
  });
});

describe('visibleText', () => {
  it('drops the internal reasoning', () => {
    expect(visibleText('<internal>plan</internal>hello <internal>more</internal>there')).toBe('hello there');
    expect(visibleText('answer<internal>never closed')).toBe('answer');
    expect(visibleText('<internal>only this</internal>')).toBe('');
  });

  it('drops the reasoning qwen writes as emphasised text', () => {
    expect(visibleText('<i>internal: he wants the answer</i>\n\nI can\'t hand you that.')).toBe("I can't hand you that.");
    expect(visibleText('hello <i>internal: never closed')).toBe('hello');
    expect(visibleText('an <i>italic</i> word')).toBe('an <i>italic</i> word');
  });
});

describe('appendInteraction', () => {
  let dir: string;
  const file = () => path.join(dir, 'competency', 'interaction-summary.md');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-log-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates the file with a header and one line per exchange', () => {
    appendInteraction(dir, new Date('2026-11-01T14:05:09Z'), 'how do I debug a goroutine leak?', 'good question!\nwhat have you tried?');
    const text = fs.readFileSync(file(), 'utf-8');
    expect(text.startsWith('# Interaction summary\n')).toBe(true);
    expect(text).toContain('- 2026-11-01 14:05 UTC — student: "how do I debug a goroutine leak?" → TAi: "good question! what have you tried?"\n');
  });

  it('shortens long texts to one line', () => {
    appendInteraction(dir, new Date('2026-11-01T14:05:00Z'), 'x'.repeat(500), 'y '.repeat(500));
    const line = fs.readFileSync(file(), 'utf-8').split('\n').find((l) => l.startsWith('- '))!;
    expect(line.length).toBeLessThan(420);
    expect(line).toContain('…');
  });

  it('keeps the last 20 of its own lines and leaves what the model wrote', () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), '# Interaction summary\n\nNote from TAi: Ann prefers code examples.\n');
    for (let i = 0; i < KEEP_INTERACTIONS + 5; i++) {
      appendInteraction(dir, new Date(Date.UTC(2026, 10, 1, 10, i)), `question ${i}`, `answer ${i}`);
    }
    const lines = fs.readFileSync(file(), 'utf-8').split('\n');
    const ours = lines.filter((l) => l.startsWith('- '));
    expect(ours).toHaveLength(KEEP_INTERACTIONS);
    expect(ours[0]).toContain('question 5');
    expect(ours[KEEP_INTERACTIONS - 1]).toContain(`question ${KEEP_INTERACTIONS + 4}`);
    expect(lines).toContain('Note from TAi: Ann prefers code examples.');
    expect(fs.existsSync(file() + '.tmp')).toBe(false);
  });
});
