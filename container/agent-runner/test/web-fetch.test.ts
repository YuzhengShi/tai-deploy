import { describe, expect, it } from 'vitest';

import { fetchPage, htmlToText } from '../src/web-fetch.js';

const publicName = async () => ['93.184.216.34'];

/** A fetch that serves a table of URLs and records what was asked for. */
function fakeFetch(table: Record<string, () => Response>) {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const make = table[url];
    if (!make) throw new Error(`unexpected fetch of ${url}`);
    return make();
  }) as typeof fetch;
  return { impl, asked };
}

const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

describe('htmlToText', () => {
  it('keeps what a reader sees', () => {
    const text = htmlToText('<html><head><title>T</title><style>p{color:red}</style></head><body><h1>Hello</h1><p>one &amp; two</p><script>alert(1)</script><ul><li>a</li><li>b</li></ul></body></html>');
    expect(text).toBe('Hello\none & two\na\nb');
  });

  it('drops comments, decodes numeric entities and keeps unknown ones', () => {
    expect(htmlToText('a<!-- hidden -->b &#65;&#x42; &unknown; &nbsp;c')).toBe('a b AB &unknown; c');
  });

  it('turns an absurd code point into a space instead of throwing', () => {
    expect(htmlToText('x&#99999999999;y')).toBe('x y');
  });
});

describe('fetchPage', () => {
  it('returns the text of a page', async () => {
    const f = fakeFetch({ 'http://example.test/': html('<p>hi <b>there</b></p>') });
    const page = await fetchPage('http://example.test/', { restricted: true, fetchImpl: f.impl, resolve: publicName });
    expect(page).toMatchObject({ url: 'http://example.test/', status: 200, contentType: 'text/html', text: 'hi there', truncated: false });
  });

  it('cuts a long page and says so', async () => {
    const f = fakeFetch({ 'http://example.test/': () => new Response('x'.repeat(5000), { headers: { 'content-type': 'text/plain' } }) });
    const page = await fetchPage('http://example.test/', { restricted: true, fetchImpl: f.impl, resolve: publicName, maxChars: 1000 });
    expect(page.truncated).toBe(true);
    expect(page.text.startsWith('x'.repeat(1000))).toBe(true);
    expect(page.text).toMatch(/4000 more characters/);
  });

  it('does not read a binary file as text', async () => {
    const f = fakeFetch({ 'http://example.test/a.pdf': () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf', 'content-length': '8' } }) });
    const page = await fetchPage('http://example.test/a.pdf', { restricted: true, fetchImpl: f.impl, resolve: publicName });
    expect(page.text).toBe('[application/pdf content, not shown as text]');
  });

  it('follows redirects between public pages', async () => {
    const f = fakeFetch({ 'http://example.test/a': redirect('/b'), 'http://example.test/b': html('<p>arrived</p>') });
    const page = await fetchPage('http://example.test/a', { restricted: true, fetchImpl: f.impl, resolve: publicName });
    expect(page.url).toBe('http://example.test/b');
    expect(page.text).toBe('arrived');
  });

  it('refuses a redirect into the container\'s own network, whichever way it is written', async () => {
    for (const target of ['http://127.0.0.1:8099/', 'http://169.254.169.254/latest/meta-data/', 'http://tai-litellm:4000/', 'http://[::1]/', 'http://10.1.2.3/x']) {
      const f = fakeFetch({ 'http://example.test/go': redirect(target) });
      await expect(fetchPage('http://example.test/go', { restricted: true, fetchImpl: f.impl, resolve: publicName }), target).rejects.toThrow(/internal\/private/);
      expect(f.asked).toEqual(['http://example.test/go']); // the second hop was never requested
    }
  });

  it('the admin chat is not restricted', async () => {
    const f = fakeFetch({ 'http://127.0.0.1:8099/': html('<p>local</p>') });
    const page = await fetchPage('http://127.0.0.1:8099/', { restricted: false, fetchImpl: f.impl });
    expect(page.text).toBe('local');
  });

  it('refuses a private address at the first hop, without asking', async () => {
    const f = fakeFetch({});
    await expect(fetchPage('http://localhost:3000/', { restricted: true, fetchImpl: f.impl })).rejects.toThrow(/internal\/private/);
    await expect(fetchPage('file:///etc/passwd', { restricted: true, fetchImpl: f.impl })).rejects.toThrow(/only http/);
    expect(f.asked).toEqual([]);
  });

  it('gives up on redirect loops', async () => {
    const f = fakeFetch({ 'http://example.test/loop': redirect('/loop') });
    await expect(fetchPage('http://example.test/loop', { restricted: true, fetchImpl: f.impl, resolve: publicName })).rejects.toThrow(/Too many redirects/);
  });

  it('reports an error status instead of its page', async () => {
    const f = fakeFetch({ 'http://example.test/missing': html('<p>nope</p>', 404) });
    await expect(fetchPage('http://example.test/missing', { restricted: true, fetchImpl: f.impl, resolve: publicName })).rejects.toThrow(/answered 404/);
  });
});
