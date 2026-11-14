import { describe, expect, it, vi } from 'vitest';

import { CANVAS_DOWN, CANVAS_DOWNLOAD_FAILED, CANVAS_FAIL_TTL_MS, CANVAS_LIST_TTL_MS, CANVAS_NO_FILE, createCanvasSource } from './canvas-source.js';
import type { CanvasSettings } from './canvas-source.js';

// The host's listing and downloading of the course's Canvas files for the viewer (docs/COURSE_DOCS.md, "Canvas files"), against a fake Canvas: what a student may be offered, how long the listing is kept,
// what is said when Canvas does not answer, and that the token goes only where Canvas is.

const BASE = 'https://canvas.example.edu/api/v1';
const TOKEN = 'canvas-token-1234567890-SECRET';
const PDF = Buffer.from('%PDF-1.4\nbody\n%%EOF\n');
const NOW = Date.parse('2026-11-07T12:00:00Z');
const SETTINGS: CanvasSettings = { base: BASE, token: TOKEN, course: '260797' };

interface Call {
  url: string;
  headers: Record<string, string>;
}
const item = (id: number, name: string, size = 1000, extra: Record<string, unknown> = {}) => ({
  id,
  display_name: name,
  filename: name,
  'content-type': 'application/pdf',
  size,
  url: `https://canvas.example.edu/files/${id}/download?download_frd=1&verifier=ONETIMEKEY${id}`,
  ...extra,
});
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function canvas(files: unknown[], download: (call: Call) => Response = () => new Response(PDF, { status: 200 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } };
    calls.push(call);
    if (call.url.includes('/modules')) return json([]);
    if (call.url.includes('/files?')) return json(files);
    if (call.url.includes('/download')) return download(call);
    return json({}, 404);
  }) as typeof fetch;
  const listings = () => calls.filter((c) => c.url.includes('/files?')).length;
  const downloads = () => calls.filter((c) => c.url.includes('/download'));
  return { fetchImpl, calls, listings, downloads };
}

const FILES = [
  item(2, 'b-slides.pdf'),
  item(1, 'A-notes.pdf'),
  item(3, 'hidden.pdf', 1000, { hidden: true }),
  item(4, 'locked.pdf', 1000, { locked: true }),
  item(5, 'locked-for-me.pdf', 1000, { locked_for_user: true }),
  item(6, 'later.pdf', 1000, { unlock_at: '2026-12-01T00:00:00Z' }),
  item(7, 'gone.pdf', 1000, { lock_at: '2026-10-01T00:00:00Z' }),
  item(8, 'huge.pdf', 30 * 1024 * 1024),
  item(9, 'clip.mp4', 1000, { 'content-type': 'video/mp4' }),
  item(10, 'deck.pptx', 5000, { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }),
  item(11, 'empty.pdf', 0),
];

describe('the files a student may be offered', () => {
  it('are the files a student could open in Canvas themselves, by name, with no address in them: what Canvas hides, locks, has not released, has withdrawn, or what is too big, empty or no document, is left out', async () => {
    const f = canvas(FILES);
    const source = createCanvasSource({ settings: () => SETTINGS, fetchImpl: f.fetchImpl, now: () => NOW });
    const r = await source.list();
    expect(r).toEqual({
      ok: true,
      files: [
        { id: 1, name: 'A-notes.pdf', kind: 'pdf', size: 1000 },
        { id: 2, name: 'b-slides.pdf', kind: 'pdf', size: 1000 },
        { id: 10, name: 'deck.pptx', kind: 'pptx', size: 5000 },
      ],
    });
    expect(JSON.stringify(r)).not.toMatch(/verifier|download|https?:/);
  });

  it('are nothing, and nothing is fetched, when Canvas is not set up on this host (and a settings function that fails is not set up)', async () => {
    const f = canvas(FILES);
    for (const settings of [() => null, () => { throw new Error('no env file'); }]) {
      const source = createCanvasSource({ settings, fetchImpl: f.fetchImpl, now: () => NOW });
      expect(await source.list()).toEqual({ ok: true, files: [] });
      expect(await source.download(1)).toEqual({ ok: false, message: CANVAS_NO_FILE });
    }
    expect(f.calls).toEqual([]);
  });

  it('are kept for ten minutes, asked again after, and asked once when asked for together', async () => {
    let clock = NOW;
    const f = canvas(FILES);
    const source = createCanvasSource({ settings: () => SETTINGS, fetchImpl: f.fetchImpl, now: () => clock });
    const [a, b] = await Promise.all([source.list(), source.list()]);
    expect(a).toEqual(b);
    expect(f.listings()).toBe(1);
    clock += CANVAS_LIST_TTL_MS - 1;
    await source.list();
    expect(f.listings()).toBe(1);
    clock += 2;
    await source.list();
    expect(f.listings()).toBe(2);
  });

  it('are asked again when the address or the course changed, not when only the token did', async () => {
    let settings = SETTINGS;
    const f = canvas(FILES);
    const source = createCanvasSource({ settings: () => settings, fetchImpl: f.fetchImpl, now: () => NOW });
    await source.list();
    settings = { ...settings, token: 'another-token-1234567890' };
    await source.list();
    expect(f.listings()).toBe(1);
    settings = { ...settings, course: '999' };
    await source.list();
    expect(f.listings()).toBe(2);
  });
});

describe('when Canvas does not answer', () => {
  it('says so in words that name no address, no token and nothing to store, keeps that for thirty seconds, and logs the reason for the operator', async () => {
    let clock = NOW;
    const warn = vi.fn();
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return json({}, 500);
    }) as typeof fetch;
    const source = createCanvasSource({ settings: () => SETTINGS, fetchImpl, now: () => clock, log: { warn } });
    const r = await source.list();
    expect(r).toEqual({ ok: false, message: CANVAS_DOWN });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(CANVAS_DOWN).not.toMatch(/tai_credentials|token|https?:/i);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0].why)).toMatch(/HTTP 500/);
    const asked = calls.length;
    await source.list();
    expect(calls).toHaveLength(asked); // not again at once
    clock += CANVAS_FAIL_TTL_MS + 1;
    await source.list();
    expect(calls.length).toBeGreaterThan(asked);
  });

  it('never throws: a connection that fails is "did not answer" too', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const source = createCanvasSource({ settings: () => SETTINGS, fetchImpl, now: () => NOW });
    expect(await source.list()).toEqual({ ok: false, message: CANVAS_DOWN });
    expect(await source.download(1)).toEqual({ ok: false, message: CANVAS_DOWN });
  });
});

describe('a download', () => {
  it('is a file of the listing by its id, with the token on the request to Canvas and on no other', async () => {
    const f = canvas(FILES);
    const source = createCanvasSource({ settings: () => SETTINGS, fetchImpl: f.fetchImpl, now: () => NOW });
    const got = await source.download(2);
    expect(got.ok && got.bytes.equals(PDF)).toBe(true);
    const asked = f.downloads();
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toContain('https://canvas.example.edu/files/2/');
    expect(asked[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // nothing that the listing did not hold: an id a model made up, a file Canvas hides, a file that is no document
    for (const id of [3, 6, 8, 9, 99999, -1, 2.5]) expect(await source.download(id), String(id)).toEqual({ ok: false, message: CANVAS_NO_FILE });
    expect(f.downloads()).toHaveLength(1);
  });

  it('says it did not get the file without an address or a token, and logs the reason for the operator', async () => {
    const warn = vi.fn();
    const f = canvas(FILES, () => new Response('nope', { status: 500 }));
    const source = createCanvasSource({ settings: () => SETTINGS, fetchImpl: f.fetchImpl, now: () => NOW, log: { warn } });
    const got = await source.download(1);
    expect(got).toEqual({ ok: false, message: CANVAS_DOWNLOAD_FAILED });
    expect(JSON.stringify(got)).not.toMatch(/verifier|ONETIMEKEY|SECRET/);
    expect(String(warn.mock.calls[0][0].why)).toMatch(/HTTP 500/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/verifier|ONETIMEKEY|SECRET/);
  });

  it('is not sent to a host that is not Canvas\' own: a redirect elsewhere is not followed, and no request goes there', async () => {
    const f = canvas(FILES, () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }));
    const source = createCanvasSource({ settings: () => SETTINGS, fetchImpl: f.fetchImpl, now: () => NOW });
    expect(await source.download(1)).toEqual({ ok: false, message: CANVAS_DOWNLOAD_FAILED });
    expect(f.calls.some((c) => c.url.includes('evil.example.com'))).toBe(false);
  });

  it('lists the new course first when the settings changed, and then downloads from it (a changed course is another listing)', async () => {
    let settings = SETTINGS;
    const f = canvas(FILES);
    const source = createCanvasSource({ settings: () => settings, fetchImpl: f.fetchImpl, now: () => NOW });
    await source.list();
    settings = { ...settings, course: '999' };
    const got = await source.download(1);
    expect(got.ok).toBe(true); // (the same fake answers for any course: the file is in the new listing too)
    expect(f.listings()).toBe(2); // and the listing it was found in is the new course's
  });
});
