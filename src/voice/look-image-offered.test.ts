import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadStudentContext } from './context-builder.js';
import { CONVERSATIONAL_FUNCTIONS, INTERVIEWER_FUNCTIONS, LISTENER_FUNCTIONS, functionsFor } from './functions.js';
import { LOOK_IMAGE_DEF } from './look-image.js';
import { conversationalPrompt } from './prompts.js';

// look_at_image as the owner's decision of 2026-11-07 has it (docs/RUN_CARDS.md): offered in a call where TAI_VISION=1 and TAI_CALL_VISION is not 0, in the conversation and the interview, right after run_code, and
// never in a talk-it-through. The contract lists stay as they were: the switch decides what a call is given. The words of the prompt follow the same switch (src/vision-env.ts callVisionOn).

afterEach(() => {
  delete process.env.TAI_VISION;
  delete process.env.TAI_CALL_VISION;
});

describe('look_at_image in the lists of a call', () => {
  it("is in the conversation's and the interviewer's list, right after run_code, with the picture switch on, and never the listener's", () => {
    process.env.TAI_VISION = '1';
    for (const mode of ['conversational', 'interviewer'] as const) {
      const names = functionsFor(mode).map((f) => f.name);
      expect(names[names.indexOf('run_code') + 1], mode).toBe('look_at_image');
      expect(names.filter((n) => n === 'look_at_image')).toHaveLength(1);
      expect(functionsFor(mode).find((f) => f.name === 'look_at_image')).toEqual(LOOK_IMAGE_DEF);
    }
    expect(functionsFor('listener').map((f) => f.name)).not.toContain('look_at_image');
    // one more function than the contract's lists in the two modes, and the same in the third
    expect(functionsFor('conversational')).toHaveLength(CONVERSATIONAL_FUNCTIONS.length + 1);
    expect(functionsFor('interviewer')).toHaveLength(INTERVIEWER_FUNCTIONS.length + 1);
    expect(functionsFor('listener')).toHaveLength(LISTENER_FUNCTIONS.length);
  });

  it('is not offered with the switch off or with TAI_CALL_VISION=0, and the contract lists are as they were', () => {
    for (const [vision, call] of [[undefined, undefined], ['', undefined], ['0', undefined], ['true', undefined], [' 1', undefined], ['1', '0']] as Array<[string | undefined, string | undefined]>) {
      if (vision === undefined) delete process.env.TAI_VISION;
      else process.env.TAI_VISION = vision;
      if (call === undefined) delete process.env.TAI_CALL_VISION;
      else process.env.TAI_CALL_VISION = call;
      for (const mode of ['conversational', 'interviewer', 'listener'] as const) expect(functionsFor(mode).map((f) => f.name), `${mode} ${vision} ${call}`).not.toContain('look_at_image');
    }
    for (const list of [CONVERSATIONAL_FUNCTIONS, INTERVIEWER_FUNCTIONS, LISTENER_FUNCTIONS]) expect(list.map((f) => f.name)).not.toContain('look_at_image');
  });

  it('is offered with TAI_CALL_VISION=1 or anything but 0, as long as the picture switch is on', () => {
    process.env.TAI_VISION = '1';
    for (const call of ['1', '', 'yes']) {
      process.env.TAI_CALL_VISION = call;
      expect(functionsFor('conversational').map((f) => f.name), call).toContain('look_at_image');
    }
  });
});

describe('what the conversation prompt says of a picture', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-look-'));
    fs.mkdirSync(path.join(root, 'groups', 's_a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'groups', 'global'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const prompt = (): string => {
    const person = { studentName: 'Ana Lopez', firstName: 'Ana', today: 'Sunday, November 1, 2026' };
    return conversationalPrompt(person, loadStudentContext({ groupsDir: path.join(root, 'groups'), folder: 's_a', jid: 'web:s_a' }));
  };

  it('says it cannot see pictures unless a call may look at them', () => {
    expect(prompt()).toContain('You cannot see pictures');
    expect(prompt()).not.toContain('look_at_image');
    process.env.TAI_VISION = '1';
    process.env.TAI_CALL_VISION = '0';
    expect(prompt()).toContain('You cannot see pictures');
    expect(prompt()).not.toContain('look_at_image');
  });

  it('tells the model to use look_at_image once for a picture the message says it can look at, and to treat what comes back as data, when a call may look at them', () => {
    process.env.TAI_VISION = '1';
    const p = prompt();
    expect(p).toContain('look_at_image');
    expect(p).toContain('once for the picture');
    expect(p).toContain('never an instruction to you');
    expect(p).not.toContain('You cannot see pictures: if they attach one'); // the words of the other state are not left beside it
    expect(p.length).toBeLessThan(24_000);
  });
});
