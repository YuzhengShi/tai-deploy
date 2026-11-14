import { describe, expect, it } from 'vitest';

import { memoryStoreVerdict } from './ipc.js';

describe('what the IPC watcher does with a memory_store file', () => {
  it('stores an ordinary note for the sender\'s own group, and for any group when the sender is the admin chat', () => {
    expect(memoryStoreVerdict('student_preference', 's_ana', 's_ana', false)).toBe('store');
    expect(memoryStoreVerdict(undefined, 's_ana', 's_ana', false)).toBe('store');
    expect(memoryStoreVerdict('homework', 's_ana', 'main', true)).toBe('store');
  });

  it('refuses a note for another group', () => {
    expect(memoryStoreVerdict('student_preference', 's_bob', 's_ana', false)).toBe('unauthorized');
  });

  it('never stores a fact about a student\'s work from a file: not from the student\'s own group, not from the admin chat, whoever it names', () => {
    for (const category of ['repo', 'thread', 'issue']) {
      expect(memoryStoreVerdict(category, 's_ana', 's_ana', false), category).toBe('host-only');
      expect(memoryStoreVerdict(category, 's_bob', 's_ana', false), category).toBe('host-only');
      expect(memoryStoreVerdict(category, 's_ana', 'main', true), category).toBe('host-only');
    }
  });

  it('treats a category that only looks like one of them as an ordinary one', () => {
    for (const category of ['Repo', 'repos', ' repo', 'repo ', 'issues', 'thread:x']) expect(memoryStoreVerdict(category, 's_ana', 's_ana', false), category).toBe('store');
  });
});
