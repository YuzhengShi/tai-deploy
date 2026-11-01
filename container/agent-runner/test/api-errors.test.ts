import { describe, expect, it } from 'vitest';

import { classifyApiError, friendlyMessage } from '../src/api-errors.js';

const kind = (text: string | null | undefined) => classifyApiError(text)?.kind ?? null;

describe('classifyApiError', () => {
  it('reads the failures eval/ measured', () => {
    expect(classifyApiError('Prompt is too long')).toEqual({ kind: 'overflow', status: 400 });
    expect(kind('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}')).toBe('overflow');
    expect(kind('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Tokens per minute limit exceeded"}}')).toBe('busy');
    expect(kind('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe('busy');
    expect(kind('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}')).toBe('busy'); // upstream: "memory too full"
  });

  it('reads what LiteLLM and Cerebras say', () => {
    expect(kind('API Error: 400 {"error":{"message":"litellm.ContextWindowExceededError: ... maximum context length is 131072 tokens"}}')).toBe('overflow');
    expect(kind('API Error: 500 {"error":{"message":"Please reduce the length of the messages or completion"}}')).toBe('overflow');
    expect(kind('API Error: 429 {"error":{"message":"queue_exceeded: too many requests"}}')).toBe('busy');
    expect(kind('API Error: 503 {"error":{"message":"Service Unavailable"}}')).toBe('busy');
  });

  it('separates what to retry from what to report', () => {
    expect(kind('API Error: 401 {"error":{"message":"Authentication Error, Invalid proxy server token"}}')).toBe('auth');
    expect(kind('API Error: 403 {"error":"forbidden"}')).toBe('auth');
    expect(kind('API Error: Request timed out.')).toBe('busy');
    expect(kind('API Error: Connection error.')).toBe('busy');
    expect(kind('API Error: 404 {"error":{"message":"model not found"}}')).toBe('other');
    expect(kind('API Error: 400 {"error":{"message":"tool_use ids must be unique"}}')).toBe('other');
    expect(kind('API Error: something odd')).toBe('other');
  });

  it('only recognises a failure the text opens with', () => {
    expect(classifyApiError(null)).toBeNull();
    expect(classifyApiError('')).toBeNull();
    expect(classifyApiError('hey! an API Error: 500 is a server error, by the way')).toBeNull();
    expect(classifyApiError('The prompt is too long to read in one go, so let me split it')).toBeNull();
    expect(classifyApiError('  API Error: 529 {}')?.status).toBe(529);
  });
});

describe('friendlyMessage', () => {
  it('only an overflow says the context was cleared', () => {
    expect(friendlyMessage('overflow')).toMatch(/cleared my context/);
    for (const k of ['busy', 'auth', 'other'] as const) {
      expect(friendlyMessage(k)).not.toMatch(/cleared|memory/);
      expect(friendlyMessage(k)).not.toMatch(/API Error|\d{3}/);
    }
  });
});
