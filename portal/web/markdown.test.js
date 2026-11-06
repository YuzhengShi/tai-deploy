import { describe, expect, it } from 'vitest';

import { parse, toDOM } from './markdown.js';

const text = (v) => ({ t: 'text', v });

describe('parse: blocks', () => {
  it('splits paragraphs and keeps single line breaks inside one', () => {
    expect(parse('one\ntwo\n\nthree')).toEqual([
      { t: 'p', c: [text('one'), { t: 'br' }, text('two')] },
      { t: 'p', c: [text('three')] },
    ]);
  });

  it('reads headings, rules and quotes', () => {
    const tree = parse('# Title\n\n---\n\n> quoted\n> more');
    expect(tree[0]).toEqual({ t: 'h', level: 1, c: [text('Title')] });
    expect(tree[1]).toEqual({ t: 'hr' });
    expect(tree[2]).toEqual({ t: 'quote', c: [{ t: 'p', c: [text('quoted'), { t: 'br' }, text('more')] }] });
  });

  it('reads fenced code as it is, including markdown and HTML inside it, and one that never closes', () => {
    expect(parse('```go\nfunc main() { *x := <b>1</b> }\n```')).toEqual([{ t: 'code', lang: 'go', text: 'func main() { *x := <b>1</b> }' }]);
    expect(parse('```\nno end\nstill code')).toEqual([{ t: 'code', lang: '', text: 'no end\nstill code' }]);
    expect(parse('~~~py\nx = 1\n~~~\nafter')).toEqual([{ t: 'code', lang: 'py', text: 'x = 1' }, { t: 'p', c: [text('after')] }]);
  });

  it('nests lists by indentation and numbers ordered ones', () => {
    const [list] = parse('1. first\n2. second\n   - inner a\n   - inner b\n3. third');
    expect(list.t).toBe('ol');
    expect(list.start).toBe(1);
    expect(list.items).toHaveLength(3);
    expect(list.items[1][1].t).toBe('ul');
    expect(list.items[1][1].items).toHaveLength(2);
    expect(parse('3. three\n4. four')[0].start).toBe(3);
  });

  it('does not take a sentence that starts with a number and a dot in the middle of a paragraph for a list', () => {
    expect(parse('about 3.5 stars').map((n) => n.t)).toEqual(['p']);
  });

  it('reads a table with alignment', () => {
    const [table] = parse('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |');
    expect(table.t).toBe('table');
    expect(table.align).toEqual(['left', 'right']);
    expect(table.rows).toHaveLength(2);
    expect(table.head[0]).toEqual([text('a')]);
  });

  it('ends a list at the paragraph that follows it', () => {
    const tree = parse('- a\n- b\n\nafter the list');
    expect(tree.map((n) => n.t)).toEqual(['ul', 'p']);
  });
});

describe('parse: inline', () => {
  const only = (src) => parse(src)[0].c;

  it('reads code, bold, italic and strikethrough', () => {
    expect(only('use `go run` now')).toEqual([text('use '), { t: 'code', v: 'go run' }, text(' now')]);
    expect(only('a **bold** and *it* and ~~gone~~')).toEqual([
      text('a '), { t: 'strong', c: [text('bold')] }, text(' and '), { t: 'em', c: [text('it')] }, text(' and '), { t: 'del', c: [text('gone')] },
    ]);
  });

  it('leaves snake_case, a times b and an unclosed mark alone', () => {
    expect(only('call my_func_name now')).toEqual([text('call my_func_name now')]);
    expect(only('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
    expect(only('an **unclosed mark')).toEqual([text('an **unclosed mark')]);
    expect(only('a lone * star')).toEqual([text('a lone * star')]);
  });

  it('does not make bold of double underscores that sit inside words', () => {
    const src = 'window.__pwned = 1</script> and window.__pwned = 2';
    expect(only(src)).toEqual([text(src)]);
    expect(only('see foo__bar__baz now')).toEqual([text('see foo__bar__baz now')]);
    expect(only('a __bold__ word')).toEqual([text('a '), { t: 'strong', c: [text('bold')] }, text(' word')]);
  });

  it('does not look for marks inside code', () => {
    expect(only('`**not bold**` and **bold**')).toEqual([{ t: 'code', v: '**not bold**' }, text(' and '), { t: 'strong', c: [text('bold')] }]);
  });

  it('takes a backslash as an escape', () => {
    expect(only('\\*not italic\\*')).toEqual([text('*not italic*')]);
  });

  it('links only to http, https and mailto', () => {
    expect(only('[docs](https://example.com/a?b=1)')).toEqual([{ t: 'link', href: 'https://example.com/a?b=1', c: [text('docs')] }]);
    expect(only('[mail](mailto:ta@example.com)')[0].t).toBe('link');
    for (const bad of ['[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html,<script>alert(1)</script>)', '[x](//evil.example)', '[x](/relative)', '[x]( vbscript:foo )']) {
      expect(only(bad).some((n) => n.t === 'link'), bad).toBe(false);
    }
  });

  it('turns a bare address into a link without its trailing punctuation', () => {
    expect(only('see https://example.com/x.')).toEqual([text('see '), { t: 'link', href: 'https://example.com/x', c: [text('https://example.com/x')] }, text('.')]);
    expect(only('(https://example.com/a_(b))')[1].href).toBe('https://example.com/a_(b)');
  });

  it('keeps HTML as the words it is', () => {
    const tree = parse('<script>alert(1)</script> <img src=x onerror=alert(1)> <b>hi</b>');
    expect(JSON.stringify(tree)).not.toMatch(/"t":"(?!text|p)/);       // only text inside a paragraph
    expect(tree[0].c[0].v).toContain('<script>');
  });

  it('survives text built to be slow', () => {
    const started = Date.now();
    for (const src of ['*'.repeat(20000), '['.repeat(5000), '`'.repeat(5000), '**a'.repeat(3000), '_x'.repeat(8000), '> '.repeat(500) + 'deep', '- '.repeat(300) + 'x', ('(' + '['.repeat(50)).repeat(200)]) {
      parse(src);
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

// A DOM with only what toDOM uses, and no innerHTML: if the renderer ever tried to use it, it would throw.
function fakeDocument() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.attrs = {};
      this.children = [];
      this.style = {};
      this.className = '';
      this._text = '';
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n && n.isFragment) this.children.push(...n.children);
        else this.children.push(n);
      }
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    set textContent(v) {
      this._text = v;
    }
    set innerHTML(_v) {
      throw new Error('innerHTML must never be used');
    }
    set outerHTML(_v) {
      throw new Error('outerHTML must never be used');
    }
  }
  return {
    createElement: (tag) => new Node(tag),
    createTextNode: (v) => ({ tag: '#text', text: String(v) }),
    createDocumentFragment: () => Object.assign(new Node('#fragment'), { isFragment: true }),
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

describe('toDOM', () => {
  const ALLOWED_TAGS = new Set(['p', 'br', 'code', 'strong', 'em', 'del', 'a', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'div', 'span', 'button', 'pre', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', '#text', '#fragment']);
  const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'type', 'aria-label', 'start']);

  it('builds only known elements and attributes, whatever the text says', () => {
    const doc = fakeDocument();
    const hostile = [
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
      '[click](javascript:alert(1)) [ok](https://example.com) <a href="javascript:alert(1)">x</a>',
      '```html\n<script>alert(1)</script>\n```',
      '| <b>a</b> | b |\n|---|---|\n| <i>c</i> | `d` |',
      '# <h1 onclick=alert(1)>t</h1>\n> <iframe src=//evil></iframe>\n- <svg onload=alert(1)>',
    ].join('\n\n');
    const frag = toDOM(parse(hostile), doc);
    let links = 0;
    walk(frag, (n) => {
      expect(ALLOWED_TAGS.has(n.tag), n.tag).toBe(true);
      for (const attr of Object.keys(n.attrs || {})) expect(ALLOWED_ATTRS.has(attr), attr).toBe(true);
      if (n.tag === 'a') {
        links++;
        expect(n.attrs.href).toBe('https://example.com');
        expect(n.attrs.rel).toBe('noopener noreferrer nofollow');
        expect(n.attrs.target).toBe('_blank');
      }
    });
    expect(links).toBe(1);
  });

  // what a browser's textContent would say of a node: its own text, its text nodes, and its children's (code in a known language is spans)
  const textOf = (n) => (n.tag === '#text' ? n.text : (n._text || '') + (n.children || []).map(textOf).join(''));

  it('puts code in a block with a copy button, as text', () => {
    const doc = fakeDocument();
    const frag = toDOM(parse('```go\nfmt.Println("<b>")\n```'), doc);
    const [block] = frag.children;
    expect(block.className).toBe('code');
    const [head, pre] = block.children;
    expect(head.children[0]._text).toBe('go');
    expect(head.children[1].attrs.type).toBe('button');
    expect(textOf(pre.children[0])).toBe('fmt.Println("<b>")');
  });

  it('leaves a block of plain text as the one text node it was', () => {
    const doc = fakeDocument();
    const [block] = toDOM(parse('```text\nfmt.Println("<b>")\n```'), doc).children;
    expect(block.children[1].children[0]._text).toBe('fmt.Println("<b>")');
    expect(block.children[1].children[0].children).toEqual([]);
  });
});
