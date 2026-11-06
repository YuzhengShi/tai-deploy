import { describe, expect, it } from 'vitest';

import { friendlyMessage, type ApiFailureKind } from '../src/api-errors.js';
import { failureOutput, idleOutput } from '../src/protocol.js';

const wire = (output: unknown) => JSON.parse(JSON.stringify(output)) as Record<string, unknown>;     // what the host reads between the output markers

describe('what the runner tells the host when a model request failed', () => {
  it('is still a success with the apology as the result (a chat shows it), and says why it is an apology', () => {
    expect(wire(failureOutput('busy', 'sess-1'))).toEqual({ status: 'success', result: friendlyMessage('busy'), apiFailure: 'busy', newSessionId: 'sess-1' });
    expect(wire(failureOutput('other', undefined))).toEqual({ status: 'success', result: friendlyMessage('other'), apiFailure: 'other' });   // no session yet: no id
    expect(wire(failureOutput('auth', 'sess-1'))).toMatchObject({ apiFailure: 'auth', newSessionId: 'sess-1' });
  });

  it('retires the session, and keeps no id for it, only when the context overflowed', () => {
    expect(wire(failureOutput('overflow', 'sess-1'))).toEqual({ status: 'success', result: friendlyMessage('overflow'), apiFailure: 'overflow', resetSession: true });
    for (const kind of ['busy', 'auth', 'other'] as ApiFailureKind[]) expect(wire(failureOutput(kind, 'sess-1')).resetSession, kind).toBeUndefined();
  });

  it('names every kind of failure, with an apology that is not empty', () => {
    for (const kind of ['overflow', 'busy', 'auth', 'other'] as ApiFailureKind[]) {
      const out = failureOutput(kind, 's');
      expect(out.status).toBe('success');
      expect(out.apiFailure).toBe(kind);
      expect(String(out.result).length).toBeGreaterThan(20);
    }
  });
});

describe('what the runner tells the host when it is idle', () => {
  it('says so with no text, and carries the session id along', () => {
    expect(wire(idleOutput('sess-1'))).toEqual({ status: 'success', result: null, newSessionId: 'sess-1', idle: true });
    expect(wire(idleOutput())).toEqual({ status: 'success', result: null, idle: true });
  });

  it('says how many follow-up messages it has received when it can count them (zero is a count), and leaves the field out when it cannot', () => {
    expect(wire(idleOutput('sess-1', 2))).toEqual({ status: 'success', result: null, newSessionId: 'sess-1', idle: true, received: 2 });
    expect(wire(idleOutput('sess-1', 0)).received).toBe(0);
    expect('received' in wire(idleOutput('sess-1'))).toBe(false);
  });

  it('is not an answer, and not a failure: only the idle flag tells the host the runner is done', () => {
    const out = idleOutput('s');
    expect(out.result).toBeNull();
    expect(out.apiFailure).toBeUndefined();
    expect(failureOutput('other', 's').idle).toBeUndefined();
  });
});
