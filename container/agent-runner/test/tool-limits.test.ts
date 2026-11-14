import { describe, expect, it } from 'vitest';

import { TOOL_LIMITS, ToolLimiter } from '../src/tool-limits.js';

describe('the per-conversation limits of the tools that cost something', () => {
  it('lets a tool be used as often as its limit says and refuses the next use, in words the model can pass on', () => {
    const limiter = new ToolLimiter({ canvas_query: 3 });
    expect([1, 2, 3].map(() => limiter.check('canvas_query'))).toEqual([null, null, null]);
    expect(limiter.check('canvas_query')).toBe('Rate limit exceeded for canvas_query: max 3 calls per session.');
    expect(limiter.check('canvas_query')).toMatch(/^Rate limit exceeded for canvas_query/);   // and it stays refused
  });

  it('counts each tool on its own, and leaves a tool that has no limit alone', () => {
    const limiter = new ToolLimiter({ canvas_query: 1, piazza_query: 1 });
    expect(limiter.check('canvas_query')).toBeNull();
    expect(limiter.check('piazza_query')).toBeNull();
    expect(limiter.check('canvas_query')).not.toBeNull();
    for (let i = 0; i < 500; i++) expect(limiter.check('query_knowledge')).toBeNull();
    expect(limiter.limited('query_knowledge')).toBe(false);
    expect(limiter.limited('piazza_query')).toBe(true);
  });

  it('starts every count again when a new call begins', () => {
    const limiter = new ToolLimiter({ canvas_query: 2 }, false, 'voice call');
    limiter.check('canvas_query');
    limiter.check('canvas_query');
    expect(limiter.check('canvas_query')).toBe('Rate limit exceeded for canvas_query: max 2 calls per voice call.');
    limiter.reset();
    expect(limiter.check('canvas_query')).toBeNull();
    expect(limiter.check('canvas_query')).toBeNull();
    expect(limiter.check('canvas_query')).not.toBeNull();
  });

  it('never limits the admin or a scheduled task', () => {
    const limiter = new ToolLimiter({ canvas_query: 1 }, true);
    for (let i = 0; i < 50; i++) expect(limiter.check('canvas_query')).toBeNull();
    expect(limiter.limited('canvas_query')).toBe(false);
  });

  it('does not take the name of an object\'s own property for a tool with a limit', () => {
    const limiter = new ToolLimiter({ canvas_query: 1 });
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) expect(limiter.check(name)).toBeNull();
  });

  it('keeps the numbers the deployment has always had', () => {
    expect(TOOL_LIMITS).toEqual({
      canvas_query: 30,
      github_query: 30,
      piazza_query: 20,
      generate_teaching_image: 5,
      send_voice_message: 10,
      render_diagram: 10,
      start_mock_interview: 3,
      weekly_brief: 3,
      read_image_text: 10,
      look_at_image: 5,
      run_go: 8,
      show_document: 6,
      show_chart: 6,
      show_trace: 6,
      ask_to_predict: 4,
      find_course_document: 8,
    });
  });
});
