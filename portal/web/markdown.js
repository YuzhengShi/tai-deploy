// A small Markdown renderer for TAi's replies, safe by construction: parse() turns text into a tree of plain objects, and toDOM()
// builds elements from the tree with createElement / createTextNode / setAttribute only. Nothing a model or a student writes is ever
// handed to the HTML parser, so "<script>" and "<img onerror=...>" are just words on the screen.

import { highlight } from './highlight.js';

const FENCE =/^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const ESCAPABLE = '\\`*_{}[]()#+-.!~|>';
const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i;
const MAX_DEPTH = 6;
const MAX_INLINE_CHARS = 20000;

export function parse(text) {
  return blocks(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), 0);
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || isTableStart(line, next);
}

function isTableStart(line, next) {
  // a header row, then a rule row with as many cells (so a line with a pipe in it above a "---" is not a table)
  return typeof next === 'string' && line.includes('|') && TABLE_RULE.test(next) && splitCells(line).length >= 2 && splitCells(next).length === splitCells(line).length;
}

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += s[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function blocks(lines, depth) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = FENCE.exec(line);
    if (m) {
      const mark = m[1];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && lines[i].trim().replace(new RegExp('^\\' + mark[0] + '+'), '').trim() === '')) {
        body.push(lines[i]);
        i++;
      }
      i++; // the closing fence (a fence that never closes runs to the end of the text, as a reply cut short would)
      out.push({ t: 'code', lang: m[2] || '', text: body.join('\n') });
      continue;
    }
    m = HEADING.exec(line);
    if (m) {
      out.push({ t: 'h', level: m[1].length, c: inline(m[2], 0) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])[1]);
        i++;
      }
      out.push({ t: 'quote', c: depth < MAX_DEPTH ? blocks(inner, depth + 1) : [{ t: 'p', c: [{ t: 'text', v: inner.join('\n') }] }] });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const result = list(lines, i, depth);
      out.push(result.node);
      i = result.next;
      continue;
    }
    if (isTableStart(line, lines[i + 1])) {
      const head = splitCells(line).map((c) => inline(c, 0));
      const align = splitCells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitCells(lines[i]).map((c) => inline(c, 0)));
        i++;
      }
      out.push({ t: 'table', head, align, rows });
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      para.push(lines[i]);
      i++;
    }
    out.push({ t: 'p', c: inline(para.map((l) => l.trim()).join('\n'), 0) });
  }
  return out;
}

function list(lines, start, depth) {
  const first = LIST_ITEM.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  let current = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // a blank line ends the list unless the next non-blank line still belongs to it
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const next = lines[j];
      const nextItem = LIST_ITEM.exec(next);
      if (indentOf(next) > base || (nextItem && nextItem[1].length >= base)) {
        if (current) current.push('');
        i = j;
        continue;
      }
      break;
    }
    const item = LIST_ITEM.exec(line);
    if (item && item[1].length === base) {
      current = [item[3]];
      items.push(current);
      i++;
      continue;
    }
    if (indentOf(line) > base || (item && item[1].length > base)) {
      current.push(line.slice(Math.min(indentOf(line), base + 2)));
      i++;
      continue;
    }
    break;
  }
  return {
    next: i,
    node: {
      t: ordered ? 'ol' : 'ul',
      start: startNumber,
      items: items.map((itemLines) => (depth < MAX_DEPTH ? blocks(itemLines, depth + 1) : [{ t: 'p', c: [{ t: 'text', v: itemLines.join('\n') }] }])),
    },
  };
}

function findClose(src, mark, from) {
  let i = from;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1); // a closing mark inside a code span does not count
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (src.startsWith(mark, i)) return i;
    i++;
  }
  return -1;
}

function inline(src, depth) {
  if (src.length > MAX_INLINE_CHARS || depth > MAX_DEPTH) return [{ t: 'text', v: src }];
  const out = [];
  let buf = '';
  let i = 0;
  const push = (node) => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
    out.push(node);
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (src[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let end = src.indexOf(fence, i + n);
      while (end !== -1 && src[end + n] === '`') end = src.indexOf(fence, end + n + 1);
      if (end !== -1) {
        push({ t: 'code', v: src.slice(i + n, end).replace(/^ (.*) $/s, '$1') });
        i = end + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }
    if (src.startsWith('**', i) || src.startsWith('__', i) || src.startsWith('~~', i)) {
      const mark = src.slice(i, i + 2);
      // double underscores, like single ones, do not open inside a word or close in front of one (window.__x, __init__ in a path)
      const wordy = (c) => /[A-Za-z0-9]/.test(c);
      if (!(mark === '__' && i > 0 && wordy(src[i - 1])) && !/\s/.test(src[i + 2] || ' ')) {
        let end = findClose(src, mark, i + 2);
        while (end !== -1 && (end === i + 2 || /\s/.test(src[end - 1]) || (mark === '__' && wordy(src[end + 2] || ' ')))) end = findClose(src, mark, end + 2);
        if (end > i + 2) {
          push({ t: mark === '~~' ? 'del' : 'strong', c: inline(src.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      }
    }
    if (ch === '*' || ch === '_') {
      const before = i === 0 ? ' ' : src[i - 1];
      const opens = !/\s/.test(src[i + 1] || ' ') && (ch === '*' || !/[A-Za-z0-9]/.test(before));
      if (opens) {
        let end = findClose(src, ch, i + 1);
        while (end !== -1 && (/\s/.test(src[end - 1]) || (ch === '_' && /[A-Za-z0-9]/.test(src[end + 1] || ' ')) || src[end + 1] === ch)) {
          end = src[end + 1] === ch ? findClose(src, ch, end + 2) : findClose(src, ch, end + 1);
        }
        if (end > i + 1) {
          push({ t: 'em', c: inline(src.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === '[') {
      const close = findClose(src, ']', i + 1);
      if (close !== -1 && src[close + 1] === '(') {
        let j = close + 2;
        let level = 1;
        while (j < src.length && level > 0) {
          if (src[j] === '(') level++;
          else if (src[j] === ')') level--;
          j++;
        }
        if (level === 0) {
          const target = src.slice(close + 2, j - 1).trim().split(/\s+/)[0];
          if (SAFE_LINK.test(target)) {
            push({ t: 'link', href: target, c: inline(src.slice(i + 1, close), depth + 1) });
            i = j;
            continue;
          }
        }
      }
    }
    if (ch === 'h' && (i === 0 || !/\w/.test(src[i - 1])) && /^https?:\/\//i.test(src.slice(i, i + 8))) {
      const m = /^https?:\/\/[^\s<>"']+/i.exec(src.slice(i));
      let url = m[0];
      while (/[.,;:!?'"\]]$/.test(url) || (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) url = url.slice(0, -1);
      if (SAFE_LINK.test(url) && url.length > 8) {
        push({ t: 'link', href: url, c: [{ t: 'text', v: url }] });
        i += url.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  if (buf) out.push({ t: 'text', v: buf });
  return out;
}

// ---------------------------------------------------------------- the tree as elements

function el(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function inlineDOM(nodes, doc) {
  const frag = doc.createDocumentFragment();
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        frag.append(doc.createTextNode(n.v));
        break;
      case 'br':
        frag.append(el(doc, 'br'));
        break;
      case 'code': {
        const node = el(doc, 'code');
        node.textContent = n.v;
        frag.append(node);
        break;
      }
      case 'strong':
      case 'em':
      case 'del': {
        const node = el(doc, n.t);
        node.append(inlineDOM(n.c, doc));
        frag.append(node);
        break;
      }
      case 'link': {
        if (!SAFE_LINK.test(n.href)) {
          frag.append(doc.createTextNode(n.href));
          break;
        }
        const node = el(doc, 'a');
        node.setAttribute('href', n.href);
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow');
        node.append(inlineDOM(n.c, doc));
        frag.append(node);
        break;
      }
      default:
        break;
    }
  }
  return frag;
}

function blockDOM(node, doc) {
  switch (node.t) {
    case 'p': {
      const p = el(doc, 'p');
      p.append(inlineDOM(node.c, doc));
      return p;
    }
    case 'h': {
      const h = el(doc, 'h' + Math.min(node.level + 2, 6));
      h.append(inlineDOM(node.c, doc));
      return h;
    }
    case 'hr':
      return el(doc, 'hr');
    case 'quote': {
      const q = el(doc, 'blockquote');
      for (const child of node.c) q.append(blockDOM(child, doc));
      return q;
    }
    case 'code': {
      const wrap = el(doc, 'div', 'code');
      const head = el(doc, 'div', 'code-head');
      const lang = el(doc, 'span', 'code-lang');
      lang.textContent = node.lang || 'code';
      const copy = el(doc, 'button', 'code-copy');
      copy.setAttribute('type', 'button');
      copy.setAttribute('aria-label', 'Copy this code');
      copy.textContent = 'Copy';
      head.append(lang, copy);
      const pre = el(doc, 'pre');
      const code = el(doc, 'code');
      // spans per coloured run for a language we know (highlight.js: the text stays exactly the text); otherwise the text, one node
      const coloured = highlight(node.lang, node.text, doc);
      if (coloured) code.append(coloured);
      else code.textContent = node.text;
      pre.append(code);
      wrap.append(head, pre);
      return wrap;
    }
    case 'ul':
    case 'ol': {
      const list = el(doc, node.t);
      if (node.t === 'ol' && node.start !== 1) list.setAttribute('start', String(node.start));
      for (const item of node.items) {
        const li = el(doc, 'li');
        if (item.length === 1 && item[0].t === 'p') li.append(inlineDOM(item[0].c, doc));
        else for (const child of item) li.append(blockDOM(child, doc));
        list.append(li);
      }
      return list;
    }
    case 'table': {
      const wrap = el(doc, 'div', 'table-wrap');
      const table = el(doc, 'table');
      const thead = el(doc, 'thead');
      const headRow = el(doc, 'tr');
      node.head.forEach((cell, index) => {
        const th = el(doc, 'th');
        if (node.align[index]) th.style.textAlign = node.align[index];
        th.append(inlineDOM(cell, doc));
        headRow.append(th);
      });
      thead.append(headRow);
      const tbody = el(doc, 'tbody');
      for (const row of node.rows) {
        const tr = el(doc, 'tr');
        node.head.forEach((_, index) => {
          const td = el(doc, 'td');
          if (node.align[index]) td.style.textAlign = node.align[index];
          td.append(inlineDOM(row[index] || [], doc));
          tr.append(td);
        });
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      return wrap;
    }
    default:
      return doc.createDocumentFragment();
  }
}

export function toDOM(tree, doc = document) {
  const frag = doc.createDocumentFragment();
  for (const node of tree) frag.append(blockDOM(node, doc));
  return frag;
}

export function renderMarkdown(text, doc = document) {
  return toDOM(parse(text), doc);
}
