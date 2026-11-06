// Syntax colours for the code blocks of TAi's answers, with no library: a small tokenizer per language (the course is Go, Dockerfiles,
// Terraform, YAML, shell, JSON and SQL, with some Python and JavaScript) and a renderer that turns its runs into <span class="hl-KIND">.
//
//   tokenize(lang, text)       lines of [kind, text] runs. Pure, deterministic, no DOM. The runs of all lines, joined with "\n", are the text
//                              character for character: the copy button, a selection and the browser's find read the text of the block, and
//                              colour must never be able to change it (tokenize checks this itself and falls back to plain, see below)
//   highlight(lang, text, doc) a DocumentFragment of text nodes and spans, or null when there is nothing to colour (the caller then sets the
//                              text itself, one node, the cheapest thing a browser can lay out)
//
// The colours are highlight.css's; the languages, the caps and how to add a language are docs/HIGHLIGHT.md's.

/** What a run can be. `plain` is drawn in the block's own colour, with no span. */
export const KINDS = ['keyword', 'type', 'string', 'comment', 'number', 'function', 'operator', 'punctuation', 'variable', 'plain'];

/**
 * A block over these caps is left plain. The page is read on phones, and colour costs a span per token (a node each, laid out inside one <pre>):
 * a reply whose code block is longer than this is not one anyone reads by its colours, and a long one is where a slow phone would stall
 * while the reply appears. The numbers are round ones, not measured limits: docs/HIGHLIGHT.md says what was measured, and on what.
 */
export const LIMITS = { maxChars: 20000, maxLines: 600, maxRuns: 5000 };

// ---------------------------------------------------------------- the pieces every scanner uses

const isDigit = (c) => c >= 48 && c <= 57;
const isAsciiLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
// letters, _, $ and anything outside ASCII (a letter of another script is part of a name; an emoji's halves stay together)
const isIdStart = (c) => isAsciiLetter(c) || c === 95 || c === 36 || c > 127;
const isIdPart = (c) => isIdStart(c) || isDigit(c);
const isWs = (c) => c === 32 || c === 9 || c === 13 || c === 12 || c === 11;
const PUNCT = '()[]{},;.';
const OPS = '+-*/%&|^~<>=!?:@#\\';

function wsEnd(line, i) {
  let j = i;
  while (j < line.length && isWs(line.charCodeAt(j))) j++;
  return j;
}

/** Collects the runs of one line at a time; a run next to one of its own kind joins it (so a row of operators is one span, not ten). */
class Out {
  constructor() {
    this.lines = [];
    this.cur = [];
  }

  push(kind, text) {
    if (!text) return;
    const last = this.cur[this.cur.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += text;
    else this.cur.push([kind, text]);
  }

  newline() {
    this.lines.push(this.cur);
    this.cur = [];
  }

  finish() {
    this.lines.push(this.cur);
    return this.lines;
  }
}

/** The end of a number that starts at i (a digit): 0x1F, 1_000, 3.14, 2e-5, with a suffix of letters (10n, 3i, 5u). */
function numberEnd(line, i) {
  const n = line.length;
  let j = i;
  const next = line.charCodeAt(i + 1);
  if (line.charCodeAt(i) === 48 && (next === 120 || next === 88 || next === 98 || next === 66 || next === 111 || next === 79)) {
    j = i + 2;                                          // 0x 0b 0o: digits, underscores and a suffix are all name characters
    while (j < n && isIdPart(line.charCodeAt(j))) j++;
    return j;
  }
  while (j < n && (isDigit(line.charCodeAt(j)) || line.charCodeAt(j) === 95)) j++;
  if (line.charCodeAt(j) === 46 && isDigit(line.charCodeAt(j + 1))) {
    j++;
    while (j < n && (isDigit(line.charCodeAt(j)) || line.charCodeAt(j) === 95)) j++;
  }
  const e = line.charCodeAt(j);
  if (e === 101 || e === 69) {
    const sign = line.charCodeAt(j + 1);
    const at = sign === 43 || sign === 45 ? j + 2 : j + 1;
    if (isDigit(line.charCodeAt(at))) {
      j = at + 1;
      while (j < n && isDigit(line.charCodeAt(j))) j++;
    }
  }
  while (j < n && isIdPart(line.charCodeAt(j))) j++;
  return j;
}

/** Parser, WaitGroup, Promise: an upper-case start with some lower case after it (not MAX_SIZE, not x). */
function isCamel(w) {
  const c = w.charCodeAt(0);
  if (c < 65 || c > 90) return false;
  for (let i = 1; i < w.length; i++) {
    const d = w.charCodeAt(i);
    if (d >= 97 && d <= 122) return true;
  }
  return false;
}

// A scanner that looks ahead for something and does not find it must not then try again from the next character: on one long line that
// is quadratic ("${${${..." with no "}" would read the rest of the line once for every "${"). So a look-ahead that could be retried from the next
// character stops at LOOKAHEAD; one that is not (a string's end, a YAML key's colon: each runs once over text the scanner then consumes) does not.
const LOOKAHEAD = 256;

/** The index after the "}" that closes the "{" at i (a quoted string inside does not count), or -1 within LOOKAHEAD characters. */
function bracesEnd(line, i) {
  const stop = Math.min(line.length, i + LOOKAHEAD);
  let depth = 0;
  for (let j = i; j < stop; j++) {
    const c = line.charCodeAt(j);
    if (c === 123) depth++;
    else if (c === 125) {
      if (--depth === 0) return j + 1;
    } else if (c === 34 || c === 39 || c === 96) {
      let k = j + 1;
      for (; k < stop; k++) {
        const d = line.charCodeAt(k);
        if (d === 92) k++;
        else if (d === c) break;
      }
      if (k >= stop) return -1;
      j = k;
    }
  }
  return -1;
}

/**
 * One string, from `from` (its opener on the first line, column 0 on a continuation) with the scan at `i`. Pushes the runs, returns the index
 * after it. With no closing quote on the line the rest of the line is the string (and the next line goes on with it when `multi`):
 * a string left open must cost one line of wrong colour at most, and never a second look at the same characters.
 */
function scanString(s, line, from, i, st, out, index) {
  const n = line.length;
  const q = s.q;
  const kind = s.kind || 'string';
  let piece = from;
  let j = i;
  while (j < n) {
    const ch = line[j];
    if (s.esc && ch === '\\') {
      j += 2;
      continue;
    }
    if (s.interp && s.interp.includes(ch) && line.charCodeAt(j + 1) === 123) {
      const e = bracesEnd(line, j + 1);
      if (e > 0) {
        out.push(kind, line.slice(piece, j));
        out.push('variable', line.slice(j, e));
        piece = j = e;
        continue;
      }
    }
    if (ch === q[0] && line.startsWith(q, j)) {
      if (s.dbl && line[j + q.length] === ch) {
        j += q.length + 1;
        continue;
      }
      out.push(kind, line.slice(piece, j + q.length));
      return j + q.length;
    }
    j++;
  }
  out.push(kind, line.slice(piece));
  if (s.multi) st.str = index;
  return n;
}

// ---------------------------------------------------------------- Go, JavaScript, TypeScript, Python, SQL, HCL: one engine, one table each

/**
 * The languages that are words, strings, comments and numbers. A table says what is a keyword, a type, what opens a comment and a string; two
 * hooks cover what only one language does (`word`: a word's kind from what is around it; `special`: something that is neither a word nor a
 * string). What every one of them shares, and what keeps their colours honest:
 *   - a word right after a "." is a member (time.Second, x.from()): never a keyword or a type, a function when it is called
 *   - the name after a declaring keyword (type, class, interface) is a type, and so is that name wherever else the block uses it (a second
 *     pass: the block is small, and a type used above its declaration is coloured as well)
 *   - a word followed at once by "(" is a function
 * Left out on purpose: a regular expression literal in JavaScript (a "/" is a division or a regex by what came before it, and guessing wrong
 * colours the rest of the line as a string), and any colour for a name that is only known by its position (a struct field, a parameter).
 * A colour that says something false is worse than none.
 */
function cLike(spec) {
  const keywords = new Set(spec.keywords.split(' '));
  const types = new Set(spec.types ? spec.types.split(' ') : []);
  const ci = !!spec.ci;
  const strings = spec.strings;
  const after = spec.after || {};
  const block = spec.block || null;
  const openers = new Set([...spec.line.map((s) => s[0]), ...strings.map((s) => s.q[0])]);
  if (block) openers.add(block[0][0]);
  const specials = new Set(spec.specials || '');

  return {
    twoPass: true,
    init(text, lines, known) {
      return { block: false, str: -1, here: null, names: new Set(), known: known || new Set() };
    },
    line(line, st, out) {
      const n = line.length;
      let i = 0;
      let prev = '';                                    // the last character of the last token on this line that was not white space
      let expect = '';                                  // the kind of the name that a declaring keyword has just announced
      if (st.here) {
        // the body of a heredoc (HCL): text up to a line that is only the closing word
        const t = st.here.strip ? line.trim() : line.trimEnd();
        if (t === st.here.tag) st.here = null;
        out.push('string', line);
        return;
      }
      if (st.block) {
        const e = line.indexOf(block[1]);
        if (e < 0) {
          out.push('comment', line);
          return;
        }
        out.push('comment', line.slice(0, e + block[1].length));
        i = e + block[1].length;
        st.block = false;
      } else if (st.str >= 0) {
        const k = st.str;
        st.str = -1;
        i = scanString(strings[k], line, 0, 0, st, out, k);
      }
      while (i < n) {
        const c = line.charCodeAt(i);
        if (isWs(c)) {
          const j = wsEnd(line, i);
          out.push('plain', line.slice(i, j));
          i = j;
          continue;
        }
        const pending = expect;
        expect = '';
        const ch = line[i];
        if (openers.has(ch)) {
          let handled = false;
          for (const o of spec.line) {
            if (line.startsWith(o, i)) {
              out.push('comment', line.slice(i));
              return;
            }
          }
          if (block && line.startsWith(block[0], i)) {
            const e = line.indexOf(block[1], i + block[0].length);
            if (e < 0) {
              out.push('comment', line.slice(i));
              st.block = true;
              return;
            }
            out.push('comment', line.slice(i, e + block[1].length));
            i = e + block[1].length;
            prev = ')';
            continue;
          }
          for (let k = 0; k < strings.length; k++) {
            if (line.startsWith(strings[k].q, i)) {
              i = scanString(strings[k], line, i, i + strings[k].q.length, st, out, k);
              prev = '"';
              handled = true;
              break;
            }
          }
          if (handled) continue;
        }
        if (specials.has(ch)) {
          const e = spec.special(line, i, prev, st, out);
          if (e > i) {
            i = e;
            prev = line[e - 1];
            continue;
          }
        }
        if (isDigit(c)) {
          const e = numberEnd(line, i);
          out.push('number', line.slice(i, e));
          prev = line[e - 1];
          i = e;
          continue;
        }
        if (isIdStart(c)) {
          let j = i + 1;
          while (j < n && isIdPart(line.charCodeAt(j))) j++;
          const w = line.slice(i, j);
          if (spec.prefixes && j - i <= 2 && (line[j] === '"' || line[j] === "'") && spec.prefixes.has(w.toLowerCase())) {
            // a string prefix (Python: r"..", b'..', f"..", rb"..")
            for (let k = 0; k < strings.length; k++) {
              if (line.startsWith(strings[k].q, j)) {
                i = scanString(strings[k], line, i, j + strings[k].q.length, st, out, k);
                break;
              }
            }
            prev = '"';
            continue;
          }
          const call = line.charCodeAt(j) === 40;
          const member = i > 0 && line.charCodeAt(i - 1) === 46 && !(i > 1 && line.charCodeAt(i - 2) === 46);
          let kind;
          if (member) {
            kind = call ? 'function' : spec.capType && isCamel(w) ? 'type' : 'plain';
          } else if (pending) {
            kind = pending;
            if (pending === 'type') st.names.add(w);
          } else {
            const key = ci ? w.toLowerCase() : w;
            kind = (spec.word && spec.word(w, key, line, j, prev)) ||
              (keywords.has(key) ? 'keyword' : types.has(key) ? 'type' : st.known.has(w) ? 'type' : call ? 'function' : spec.capType && isCamel(w) ? 'type' : 'plain');
            if (kind === 'keyword' && after[key]) expect = after[key];
          }
          out.push(kind, w);
          prev = line[j - 1];
          i = j;
          continue;
        }
        out.push(PUNCT.includes(ch) ? 'punctuation' : OPS.includes(ch) ? 'operator' : 'plain', ch);
        prev = ch;
        i++;
      }
    },
  };
}

const GO = cLike({
  keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota',
  types: 'any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr',
  line: ['//'],
  block: ['/*', '*/'],
  // a raw string runs over lines; a struct tag is one on a single line
  strings: [{ q: '"', esc: true }, { q: "'", esc: true }, { q: '`', multi: true }],
  after: { type: 'type', func: 'function' },
});

const JS_KEYWORDS = 'async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined NaN Infinity as';
const JS_STRINGS = [{ q: '"', esc: true }, { q: "'", esc: true }, { q: '`', esc: true, multi: true, interp: '$' }];

// `from` is a keyword only in front of a module name: it is also the name of a method (Array.from) and of a parameter
function jsWord(w, key, line, j) {
  if (key === 'from') return /^\s+['"]/.test(line.slice(j, j + 12)) ? 'keyword' : 'plain';
  // `type` is a keyword in TypeScript only where it declares an alias: `type Name =` or `type Name<T>`; `{ type: 'x' }` is a property
  if (key === 'type') return /^\s+[A-Za-z_$][\w$]*\s*[=<]/.test(line.slice(j, j + 80)) ? 'keyword' : 'plain';
  return '';
}

const JS = cLike({
  keywords: JS_KEYWORDS,
  line: ['//'],
  block: ['/*', '*/'],
  strings: JS_STRINGS,
  after: { function: 'function', class: 'type' },
  capType: true,
  word: (w, key, line, j) => (key === 'from' ? jsWord(w, key, line, j) : ''),
});

const TS = cLike({
  keywords: `${JS_KEYWORDS} type interface enum namespace declare abstract implements readonly keyof public private protected infer satisfies override`,
  types: 'string number boolean any unknown never object symbol bigint',
  line: ['//'],
  block: ['/*', '*/'],
  strings: JS_STRINGS,
  after: { function: 'function', class: 'type', interface: 'type', type: 'type', enum: 'type', namespace: 'type' },
  capType: true,
  word: jsWord,
});

// a decorator is the first thing on its line (a "@" in the middle of one is the matrix operator)
function pySpecial(line, i, prev, st, out) {
  if (prev !== '') return 0;
  let j = i + 1;
  while (j < line.length && (isIdPart(line.charCodeAt(j)) || line.charCodeAt(j) === 46)) j++;
  if (j === i + 1) return 0;
  out.push('function', line.slice(i, j));
  return j;
}

const PY = cLike({
  keywords: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  types: 'bool bytearray bytes complex dict float frozenset int list object set str tuple',
  line: ['#'],
  strings: [{ q: '"""', esc: true, multi: true }, { q: "'''", esc: true, multi: true }, { q: '"', esc: true }, { q: "'", esc: true }],
  prefixes: new Set(['r', 'b', 'f', 'u', 'rb', 'br', 'fr', 'rf']),
  after: { def: 'function', class: 'type' },
  capType: true,
  specials: '@',
  special: pySpecial,
});

const SQL = cLike({
  ci: true,
  keywords: 'select from where join inner left right full outer cross natural on using as and or not in is null like ilike between exists group by order having limit offset fetch union intersect except all any some distinct insert into values update set delete create alter drop truncate table index view schema database sequence trigger function procedure primary key foreign references default unique check constraint add column rename to if case when then else end begin commit rollback savepoint transaction start with recursive asc desc returning conflict do nothing over partition window rows range preceding following unbounded current row true false grant revoke cascade restrict explain analyze vacuum temporary temp replace materialized lateral for share',
  types: 'int integer bigint smallint tinyint serial bigserial smallserial text varchar char character boolean bool date time timestamp timestamptz interval numeric decimal float double real money json jsonb uuid bytea blob clob binary varbinary array enum',
  line: ['--'],
  block: ['/*', '*/'],
  // 'it''s' is one string; "Name" and `name` are identifiers
  strings: [{ q: "'", dbl: true }, { q: '"', dbl: true, kind: 'variable' }, { q: '`', kind: 'variable' }],
});

const HCL_ROOTS = new Set(['var', 'local', 'module', 'data', 'each', 'count', 'self', 'path', 'terraform']);

function hclWord(w, key, line, j, prev) {
  const k = wsEnd(line, j);
  const next = line[k];
  // name = value (not == and not =>): an attribute or a key
  if (next === '=' && line[k + 1] !== '=' && line[k + 1] !== '>') return 'variable';
  // resource "aws_instance" "web" {   terraform {   lifecycle {: the word that opens a block
  if ((prev === '' || prev === '{' || prev === '}' || prev === ',') && (next === '"' || next === '{')) return 'keyword';
  if (HCL_ROOTS.has(w) && line[j] === '.') return 'keyword';             // var.region, aws_instance.web.id's data.aws_ami...
  return '';
}

// <<EOF and <<-EOF at the end of a line open a heredoc; the lines after it are text until the closing word
function hclSpecial(line, i, prev, st, out) {
  if (line.charCodeAt(i + 1) !== 60) return 0;
  const m = /^<<(-?)([A-Za-z_][A-Za-z0-9_]{0,63})/.exec(line.slice(i, i + 70));
  if (!m) return 0;
  const k = wsEnd(line, i + m[0].length);
  if (k < line.length) return 0;
  out.push('operator', '<<' + m[1]);
  out.push('string', m[2]);
  out.push('plain', line.slice(i + m[0].length));
  st.here = { tag: m[2], strip: m[1] === '-' };
  return line.length;
}

const HCL = cLike({
  keywords: 'true false null for in if else endif endfor',
  types: 'string number bool any list set map object tuple',
  line: ['#', '//'],
  block: ['/*', '*/'],
  strings: [{ q: '"', esc: true, interp: '$%' }],
  specials: '<',
  special: hclSpecial,
  word: hclWord,
});

// ---------------------------------------------------------------- JSON

function jsonLine(line, st, out) {
  const n = line.length;
  let i = 0;
  if (st.block) {
    const e = line.indexOf('*/');
    if (e < 0) {
      out.push('comment', line);
      return;
    }
    out.push('comment', line.slice(0, e + 2));
    i = e + 2;
    st.block = false;
  }
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isWs(c)) {
      const j = wsEnd(line, i);
      out.push('plain', line.slice(i, j));
      i = j;
    } else if (c === 34) {
      let j = i + 1;
      while (j < n && line.charCodeAt(j) !== 34) j += line.charCodeAt(j) === 92 ? 2 : 1;
      const end = Math.min(j + 1, n);
      // a string followed by ":" is a key; the look-ahead is white space, which the loop reads again right after
      const colon = line.charCodeAt(wsEnd(line, end)) === 58;
      out.push(colon ? 'variable' : 'string', line.slice(i, end));
      i = end;
    } else if (c === 47 && line.charCodeAt(i + 1) === 47) {
      out.push('comment', line.slice(i));
      return;
    } else if (c === 47 && line.charCodeAt(i + 1) === 42) {
      const e = line.indexOf('*/', i + 2);
      if (e < 0) {
        out.push('comment', line.slice(i));
        st.block = true;
        return;
      }
      out.push('comment', line.slice(i, e + 2));
      i = e + 2;
    } else if (isDigit(c) || (c === 45 && isDigit(line.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n) {
        const d = line.charCodeAt(j);
        if (isDigit(d) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45) j++;
        else break;
      }
      out.push('number', line.slice(i, j));
      i = j;
    } else if (isAsciiLetter(c)) {
      let j = i + 1;
      while (j < n && isAsciiLetter(line.charCodeAt(j))) j++;
      const w = line.slice(i, j);
      out.push(w === 'true' || w === 'false' || w === 'null' ? 'keyword' : 'plain', w);
      i = j;
    } else {
      out.push('{}[],:'.includes(line[i]) ? 'punctuation' : 'plain', line[i]);
      i++;
    }
  }
}

// ---------------------------------------------------------------- YAML

const YAML_LITERALS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~']);
const YAML_NUMBER = /^[-+]?(?:0x[0-9a-fA-F]+|0o[0-7]+|(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|\.inf|\.nan)$/i;

/** The index of the ":" that ends a mapping key in the text that starts at i, or -1. A ":" counts only in front of a space or the line's end. */
function yamlKey(line, i) {
  const n = line.length;
  const c = line.charCodeAt(i);
  if (c === 34 || c === 39) {
    let j = i + 1;
    while (j < n && line.charCodeAt(j) !== c) j += c === 34 && line.charCodeAt(j) === 92 ? 2 : 1;
    if (j >= n) return -1;
    const k = wsEnd(line, j + 1);
    return line.charCodeAt(k) === 58 && (k + 1 === n || isWs(line.charCodeAt(k + 1))) ? k : -1;
  }
  if ('[]{},&*!|>%@`#'.includes(line[i])) return -1;               // something else starts here: a flow collection, an anchor, a tag, a comment
  for (let j = i; j < n; j++) {
    const d = line.charCodeAt(j);
    if (d === 58 && (j + 1 === n || isWs(line.charCodeAt(j + 1)))) return j;
    if (d === 35 && j > i && isWs(line.charCodeAt(j - 1))) return -1;
  }
  return -1;
}

/** The end of a block scalar's header ("|", ">-", "|2+") at i when only white space or a comment follows it on the line, else 0. */
function blockHeader(line, i) {
  let e = i + 1;
  while (e < line.length && (line.charCodeAt(e) === 45 || line.charCodeAt(e) === 43 || isDigit(line.charCodeAt(e)))) e++;
  const k = wsEnd(line, e);
  return k === line.length || (k > e && line.charCodeAt(k) === 35) ? e : 0;
}

/** The rest of a line after its key or dash: strings, numbers, literals, anchors, tags, flow collections, a comment, a block scalar's header. */
function yamlValue(line, i, st, out, parent) {
  const n = line.length;
  let flow = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isWs(c)) {
      const j = wsEnd(line, i);
      out.push('plain', line.slice(i, j));
      i = j;
    } else if (c === 35 && (i === 0 || isWs(line.charCodeAt(i - 1)))) {
      out.push('comment', line.slice(i));
      return;
    } else if (c === 34 || c === 39) {
      let j = i + 1;
      while (j < n && line.charCodeAt(j) !== c) j += c === 34 && line.charCodeAt(j) === 92 ? 2 : 1;
      const end = Math.min(j + 1, n);
      // in a flow mapping ({a: 1}) a quoted word in front of ":" is a key
      const key = flow > 0 && line.charCodeAt(wsEnd(line, end)) === 58;
      out.push(key ? 'variable' : 'string', line.slice(i, end));
      i = end;
    } else if ((c === 124 || c === 62) && flow === 0 && blockHeader(line, i) > 0) {
      // a block scalar: | or > (with - + or a digit), and the lines indented further than its key are its text
      const end = blockHeader(line, i);
      out.push('operator', line.slice(i, end));
      st.block = parent;
      yamlValue(line, end, st, out, parent);
      return;
    } else if (c === 38 || c === 42) {
      let j = i + 1;
      while (j < n && !isWs(line.charCodeAt(j)) && !',[]{}'.includes(line[j])) j++;
      out.push('variable', line.slice(i, j));
      i = j;
    } else if (c === 33) {
      let j = i + 1;
      while (j < n && !isWs(line.charCodeAt(j)) && !',[]{}'.includes(line[j])) j++;
      out.push('type', line.slice(i, j));
      i = j;
    } else if ('[]{},'.includes(line[i])) {
      if (c === 91 || c === 123) flow++;
      else if (c === 93 || c === 125) flow = Math.max(0, flow - 1);
      out.push('punctuation', line[i]);
      i++;
    } else if (c === 58 && flow > 0) {
      out.push('punctuation', ':');
      i++;
    } else {
      // a plain scalar runs to a comment, and in a flow collection to "," "]" "}" or the ":" of a key
      let j = i;
      while (j < n) {
        const d = line.charCodeAt(j);
        if (d === 35 && j > i && isWs(line.charCodeAt(j - 1))) break;
        if (flow > 0 && (d === 44 || d === 93 || d === 125)) break;
        if (flow > 0 && d === 58 && (j + 1 === n || isWs(line.charCodeAt(j + 1)) || ',]}'.includes(line[j + 1]))) break;
        j++;
      }
      if (j === i) j = i + 1;
      let e = j;
      while (e > i && isWs(line.charCodeAt(e - 1))) e--;
      const word = line.slice(i, e);
      const key = flow > 0 && line.charCodeAt(j) === 58;
      const kind = key ? 'variable' : YAML_LITERALS.has(word.toLowerCase()) ? 'keyword' : word.length <= 40 && YAML_NUMBER.test(word) ? 'number' : 'plain';
      out.push(kind, word);
      out.push('plain', line.slice(e, j));
      i = j;
    }
  }
}

function yamlLine(line, st, out) {
  const n = line.length;
  let i = wsEnd(line, 0);
  if (st.block >= 0) {
    if (i === n) {
      out.push('plain', line);
      return;
    }
    if (i > st.block) {
      out.push('plain', line.slice(0, i));
      out.push('string', line.slice(i));
      return;
    }
    st.block = -1;
  }
  out.push('plain', line.slice(0, i));
  if (i === n) return;
  if (line.charCodeAt(i) === 35) {
    out.push('comment', line.slice(i));
    return;
  }
  if (i === 0 && (line.startsWith('---') || line.startsWith('...')) && (n === 3 || isWs(line.charCodeAt(3)))) {
    out.push('punctuation', line.slice(0, 3));
    yamlValue(line, 3, st, out, 0);
    return;
  }
  let parent = i;
  while (i < n && line.charCodeAt(i) === 45 && (i + 1 === n || line.charCodeAt(i + 1) === 32)) {
    out.push('punctuation', '-');
    parent = i;                                         // the parent of the text of "- |" is the dash
    i++;
    const j = wsEnd(line, i);
    out.push('plain', line.slice(i, j));
    i = j;
  }
  const colon = yamlKey(line, i);
  if (colon >= 0) {
    out.push('variable', line.slice(i, colon));
    out.push('punctuation', ':');
    parent = i;                                         // the text of a block scalar is indented further than its key
    i = colon + 1;
  }
  yamlValue(line, i, st, out, parent);
}

// ---------------------------------------------------------------- shell, terminal sessions, Dockerfile, Makefile

const SH_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'select', 'time', 'coproc', 'export', 'local', 'readonly', 'declare', 'typeset']);
// after these the next word is a command again (or an assignment: export NAME=value)
const SH_THEN_COMMAND = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', 'time', 'function', 'coproc', 'export', 'local', 'readonly', 'declare', 'typeset']);
const SH_WRAPPERS = new Set(['sudo', 'env', 'nohup', 'exec', 'xargs', 'command', 'builtin', 'nice', 'timeout', 'watch', 'doas']);
// characters that end a word: white space, | & ; ( ) < > " ' $ ` and the backslash
const SH_END = new Uint8Array(128);
for (const ch of ' \t\r\f\v|&;()<>"\'$`\\') SH_END[ch.charCodeAt(0)] = 1;
const isShEnd = (c) => c < 128 && SH_END[c] === 1;
// a prompt: "$ " or "user@host:~/dir$ " (not "# ": in a block of commands that is a comment far more often than root's prompt)
const PROMPT = /^( *)((?:[\w.-]{1,40}@[\w.-]{1,60}(?::[^\s$#]{0,100})?)?\$)(?: |$)/;
const HEREDOC = /^<<(-?)\s*(?:'([^'\s]{1,64})'|"([^"\s]{1,64})"|([A-Za-z_][\w-]{0,63}))/;

/** The state of one shell scan. `args`: the words are arguments (a Dockerfile's COPY, ENV), never commands. `make`: the lines are a Makefile's recipe. */
function newShell(args, make) {
  return { q: '', here: null, cmd: true, cont: false, args: !!args, make: !!make, depth: 0 };
}

/**
 * The end of the expansion that starts at the "$" at i ($NAME, ${...}, $1, $?, "$(" as its two characters), or i when it is none.
 * In a Makefile "$(" opens a variable, not a command: the whole $(NAME) is the run, and $< $^ $% are variables too.
 */
function dollarEnd(line, i, make) {
  const c = line.charCodeAt(i + 1);
  if (c === 123) {
    const stop = Math.min(line.length, i + LOOKAHEAD);
    for (let j = i + 2; j < stop; j++) if (line.charCodeAt(j) === 125) return j + 1;
    return i;
  }
  if (c === 40) {
    if (!make) return i + 2;
    const stop = Math.min(line.length, i + LOOKAHEAD);
    let depth = 0;
    for (let j = i + 1; j < stop; j++) {
      const d = line.charCodeAt(j);
      if (d === 40) depth++;
      else if (d === 41 && --depth === 0) return j + 1;
    }
    return i + 2;
  }
  if (make && (c === 60 || c === 94 || c === 37)) return i + 2;
  if (isAsciiLetter(c) || c === 95) {
    let j = i + 2;
    while (j < line.length && (isAsciiLetter(line.charCodeAt(j)) || isDigit(line.charCodeAt(j)) || line.charCodeAt(j) === 95)) j++;
    return j;
  }
  if (isDigit(c) || c === 64 || c === 42 || c === 35 || c === 63 || c === 36 || c === 33 || c === 45) return i + 2;
  return i;
}

/** A double-quoted string, with its expansions picked out. i: where to look, from: where this run of the string starts. */
function shellDouble(line, from, i, st, out) {
  const n = line.length;
  let piece = from;
  let j = i;
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c === 92) {
      j += 2;
      continue;
    }
    if (c === 34) {
      out.push('string', line.slice(piece, j + 1));
      st.q = '';
      return j + 1;
    }
    if (c === 36) {
      const e = dollarEnd(line, j, st.make);
      if (e > j) {
        out.push('string', line.slice(piece, j));
        out.push('variable', line.slice(j, e));
        piece = j = e;
        continue;
      }
    }
    j++;
  }
  out.push('string', line.slice(piece));
  st.q = '"';
  return n;
}

function shellSingle(line, from, i, st, out) {
  const e = line.indexOf("'", i);
  if (e < 0) {
    out.push('string', line.slice(from));
    st.q = "'";
    return line.length;
  }
  out.push('string', line.slice(from, e + 1));
  st.q = '';
  return e + 1;
}

/** NAME or NAME+ in front of the "=" at eq: an assignment's name. */
function isAssignName(w, end) {
  if (end < 1 || !(isAsciiLetter(w.charCodeAt(0)) || w.charCodeAt(0) === 95)) return false;
  for (let k = 1; k < end; k++) {
    const c = w.charCodeAt(k);
    if (!(isAsciiLetter(c) || isDigit(c) || c === 95)) return false;
  }
  return true;
}

/** One line of shell from column `from`, on a state that remembers an open quote, a heredoc, a continued line and whether a command is due. */
function shellLine(line, st, out, from) {
  const n = line.length;
  let i = from;
  if (st.here) {
    // the body of a heredoc: text up to a line that is only the closing word
    const body = line.slice(from);
    const t = st.here.strip ? body.trim() : body.trimEnd();
    if (t === st.here.tag) {
      st.here = null;
      st.cmd = true;
    }
    out.push('string', body);
    return;
  }
  if (st.cont || st.q) {
    // a continuation of a line (a trailing backslash) or of a quoted string: the first word is not a new command
    st.cont = false;
    if (st.q === '"') i = shellDouble(line, i, i, st, out);
    else if (st.q === "'") i = shellSingle(line, i, i, st, out);
  } else {
    st.cmd = true;
  }
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isWs(c)) {
      const j = wsEnd(line, i);
      out.push('plain', line.slice(i, j));
      i = j;
      continue;
    }
    const ch = line[i];
    if (ch === '#' && (i === 0 || isWs(line.charCodeAt(i - 1)) || ';|&('.includes(line[i - 1]))) {
      out.push('comment', line.slice(i));
      return;
    }
    if (ch === '"') {
      i = shellDouble(line, i, i + 1, st, out);
      st.cmd = false;
      continue;
    }
    if (ch === "'") {
      i = shellSingle(line, i, i + 1, st, out);
      st.cmd = false;
      continue;
    }
    if (ch === '$') {
      const e = dollarEnd(line, i, st.make);
      if (e > i) {
        out.push('variable', line.slice(i, e));
        st.cmd = line[e - 1] === '(';                    // $( opens a command; any other expansion is an argument
        if (st.cmd) st.depth++;
        i = e;
      } else {
        out.push('plain', '$');
        i++;
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= n) {
        out.push('operator', '\\');
        st.cont = true;
        return;
      }
      out.push('plain', line.slice(i, i + 2));
      st.cmd = false;
      i += 2;
      continue;
    }
    if (ch === '|' || ch === '&' || ch === ';') {
      let j = i + 1;
      while (j < n && (line[j] === '|' || line[j] === '&' || line[j] === ';')) j++;
      out.push('operator', line.slice(i, j));
      st.cmd = true;
      i = j;
      continue;
    }
    if (ch === '<' || ch === '>') {
      if (ch === '<' && line.charCodeAt(i + 1) === 60 && line.charCodeAt(i + 2) !== 60) {
        const m = HEREDOC.exec(line.slice(i, i + 90));
        if (m) {
          out.push('operator', '<<' + m[1]);
          const raw = m[0].slice(2 + m[1].length);
          const tag = m[2] || m[3] || m[4];
          out.push('plain', raw.slice(0, raw.length - raw.trimStart().length));
          out.push('string', raw.trimStart());
          st.here = { tag, strip: m[1] === '-' };
          i += m[0].length;
          continue;
        }
      }
      let j = i + 1;
      while (j < n && (line[j] === '<' || line[j] === '>' || line[j] === '&' || line[j] === '|')) j++;
      out.push('operator', line.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '(') {
      out.push('punctuation', '(');
      st.cmd = true;
      st.depth++;
      i++;
      continue;
    }
    if (ch === ')' || ch === '`') {
      out.push('punctuation', ch);
      // a ")" that closes no "(" ends a case pattern (start) echo go ;;): a command follows
      if (ch === ')') {
        if (st.depth > 0) st.depth--;
        else st.cmd = true;
      }
      i++;
      continue;
    }
    // a word
    let j = i;
    while (j < n && !isShEnd(line.charCodeAt(j))) j++;
    if (j === i) j = i + 1;
    const w = line.slice(i, j);
    i = j;
    const eq = w.indexOf('=');
    const plus = eq > 0 && w.charCodeAt(eq - 1) === 43;
    if ((st.cmd || st.args) && eq > 0 && isAssignName(w, plus ? eq - 1 : eq)) {
      out.push('variable', w.slice(0, plus ? eq - 1 : eq));
      out.push('operator', plus ? '+=' : '=');
      const rest = w.slice(eq + 1);
      out.push(/^\d[\d.]*$/.test(rest) ? 'number' : 'plain', rest);
      continue;                                          // a command may follow the assignment: FOO=1 cmd
    }
    if (w === '[' || w === '[[' || w === ']' || w === ']]') {
      out.push('punctuation', w);
      if (!st.args) st.cmd = false;
      continue;
    }
    if (st.args) {
      out.push(/^\d+$/.test(w) ? 'number' : 'plain', w);
      continue;
    }
    if (st.cmd) {
      if (SH_KEYWORDS.has(w)) {
        out.push('keyword', w);
        st.cmd = SH_THEN_COMMAND.has(w);
      } else if (w === '!' || w === '{' || w === '}') {
        out.push(w === '!' ? 'operator' : 'punctuation', w);
        if (w === '}') st.cmd = false;
      } else if (w.charCodeAt(0) === 45) {
        // sudo -u root docker run: after an option nobody can tell which word is the command (-u takes one, -E does not): none is coloured as one
        out.push('plain', w);
        st.cmd = false;
      } else if (st.depth === 0 && line.charCodeAt(wsEnd(line, i)) === 41) {
        out.push('plain', w);                            // a case pattern: start) echo go ;;
      } else {
        out.push('function', w);
        st.cmd = SH_WRAPPERS.has(w);
      }
      continue;
    }
    if (w === 'in') out.push('keyword', w);
    else out.push(/^\d+$/.test(w) ? 'number' : 'plain', w);
  }
}

function shellLang(strict) {
  return {
    init(text, lines) {
      const st = newShell(false);
      // a block of commands with some "$ " lines is a terminal session: the lines without a prompt are what the commands printed
      st.session = strict || lines.some((l) => PROMPT.test(l));
      return st;
    },
    line(line, st, out) {
      if (st.session && !st.cont && !st.q && !st.here) {
        const m = PROMPT.exec(line);
        if (!m) {
          out.push('plain', line);
          return;
        }
        out.push('plain', m[1]);
        out.push('punctuation', m[2]);
        st.cmd = true;
        shellLine(line, st, out, m[1].length + m[2].length);
        return;
      }
      shellLine(line, st, out, 0);
    },
  };
}

const DOCKER_INSTRUCTIONS = new Set('from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell'.split(' '));
// the instructions whose arguments are a command line (ONBUILD takes another instruction: it is left as plain arguments)
const DOCKER_COMMAND = new Set(['run', 'cmd', 'entrypoint', 'healthcheck']);

/** HEALTHCHECK [--interval=30s ...] CMD command | NONE: the flags and CMD (or NONE) are Docker's, the command after them is the shell's. */
function dockerHealth(line, i, out) {
  const n = line.length;
  for (;;) {
    const j = wsEnd(line, i);
    out.push('plain', line.slice(i, j));
    i = j;
    if (!line.startsWith('--', i)) break;
    let e = i;
    while (e < n && !isWs(line.charCodeAt(e))) e++;
    out.push('plain', line.slice(i, e));
    i = e;
  }
  let e = i;
  while (e < n && isAsciiLetter(line.charCodeAt(e))) e++;
  if (/^(?:cmd|none)$/i.test(line.slice(i, e))) {
    out.push('keyword', line.slice(i, e));
    i = e;
  }
  return i;
}

function dockerFrom(line, i, out) {
  const n = line.length;
  let seen = false;
  let named = false;
  while (i < n) {
    const j = wsEnd(line, i);
    if (j > i) {
      out.push('plain', line.slice(i, j));
      i = j;
      continue;
    }
    let e = i;
    while (e < n && !isWs(line.charCodeAt(e))) e++;
    const w = line.slice(i, e);
    if (w.startsWith('--')) out.push('plain', w);
    else if (!seen) {
      out.push('type', w);
      seen = true;
    } else if (!named && w.toLowerCase() === 'as') {
      out.push('keyword', w);
      named = true;
    } else out.push(named ? 'variable' : 'plain', w);
    i = e;
  }
}

const dockerfile = {
  init: () => ({ cont: false, mode: '', sh: newShell(false) }),
  line(line, st, out) {
    const n = line.length;
    if (st.cont && st.sh.here) {
      // the body of a heredoc (RUN <<EOF): its lines are text, whatever they start with
      shellLine(line, st.sh, out, 0);
      st.cont = st.sh.cont || st.sh.here !== null;
      return;
    }
    const first = wsEnd(line, 0);
    if (first < n && line.charCodeAt(first) === 35) {
      // a comment is a whole line (inside a continued instruction too); a "#" further right is the shell's, or text
      out.push('plain', line.slice(0, first));
      out.push('comment', line.slice(first));
      return;
    }
    if (first === n) {
      out.push('plain', line);
      return;
    }
    let i = 0;                                          // where the scan starts: 0, so that a continuation's indentation is kept
    if (!st.cont) {
      let j = first;
      while (j < n && isAsciiLetter(line.charCodeAt(j))) j++;
      const word = line.slice(first, j).toLowerCase();
      if (j > first && DOCKER_INSTRUCTIONS.has(word) && (j === n || isWs(line.charCodeAt(j)))) {
        out.push('plain', line.slice(0, first));
        out.push('keyword', line.slice(first, j));
        st.mode = word === 'from' ? 'from' : DOCKER_COMMAND.has(word) ? 'shell' : 'args';
        st.sh = newShell(st.mode === 'args');
        i = word === 'healthcheck' ? dockerHealth(line, j, out) : j;
      } else {
        st.mode = 'args';
        st.sh = newShell(true);
      }
    }
    if (st.mode === 'from') {
      dockerFrom(line, i, out);
      st.cont = line.trimEnd().endsWith('\\');
    } else {
      shellLine(line, st.sh, out, i);
      st.cont = st.sh.cont || st.sh.here !== null;
    }
  },
};

const MAKE_DIRECTIVES = new Set('include -include sinclude ifeq ifneq ifdef ifndef else endif define endef export unexport override vpath'.split(' '));

/** $(VAR), ${VAR}, $@ $< $^ and comments, in the parts of a Makefile that are not commands. */
function makeText(line, i, out) {
  const n = line.length;
  let piece = i;
  const flush = (to) => {
    out.push('plain', line.slice(piece, to));
    piece = to;
  };
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 35 && (i === 0 || isWs(line.charCodeAt(i - 1)))) {
      flush(i);
      out.push('comment', line.slice(i));
      return;
    }
    if (c === 36) {
      const d = line.charCodeAt(i + 1);
      let e = i;
      if (d === 40 || d === 123) {
        const stop = Math.min(n, i + LOOKAHEAD);
        const close = d === 40 ? 41 : 125;
        for (let j = i + 2; j < stop; j++) {
          if (line.charCodeAt(j) === close) {
            e = j + 1;
            break;
          }
        }
      } else if (d === 64 || d === 60 || d === 94 || d === 63 || d === 42 || d === 37) e = i + 2;
      if (e > i) {
        flush(i);
        out.push('variable', line.slice(i, e));
        piece = i = e;
        continue;
      }
    }
    i++;
  }
  flush(n);
}

const makefile = {
  init: () => ({ recipe: false, sh: newShell(false, true) }),
  line(line, st, out) {
    const n = line.length;
    if (st.sh.here) {
      shellLine(line, st.sh, out, 0);                  // the body of a heredoc in a recipe: its lines are text, whatever they start with
      return;
    }
    const first = wsEnd(line, 0);
    if (first === n) {
      out.push('plain', line);
      return;
    }
    if (line.charCodeAt(first) === 35) {
      out.push('plain', line.slice(0, first));
      out.push('comment', line.slice(first));
      return;
    }
    if (first > 0 && (st.recipe || st.sh.cont)) {
      // a recipe line: the shell's, after the "@" "-" "+" that change how make runs it
      out.push('plain', line.slice(0, first));
      let i = first;
      while (i < n && '@-+'.includes(line[i])) i++;
      out.push('operator', line.slice(first, i));
      shellLine(line, st.sh, out, i);
      return;
    }
    st.recipe = false;
    out.push('plain', line.slice(0, first));
    let i = first;
    let e = i;
    while (e < n && !isWs(line.charCodeAt(e)) && line[e] !== ':' && line[e] !== '=' && line[e] !== '(' && line[e] !== '$') e++;
    const word = line.slice(i, e);
    if (MAKE_DIRECTIVES.has(word)) {
      out.push('keyword', word);
      makeText(line, e, out);
      return;
    }
    // NAME := value, NAME ?= value, NAME += value, NAME = value
    const k = wsEnd(line, e);
    const m = /^(?:::=|:=|\?=|\+=|!=|=)/.exec(line.slice(k, k + 3));
    if (word && m && !(m[0] === '=' && line[k + 1] === '=')) {
      out.push('variable', word);
      out.push('plain', line.slice(e, k));
      out.push('operator', m[0]);
      makeText(line, k + m[0].length, out);
      return;
    }
    // target ...: prerequisites
    let depth = 0;
    let colon = -1;
    for (let j = i; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c === 40 || c === 123) depth++;
      else if (c === 41 || c === 125) depth = Math.max(0, depth - 1);
      else if (c === 35 && isWs(line.charCodeAt(j - 1))) break;
      else if (c === 58 && depth === 0 && line.charCodeAt(j + 1) !== 61) {
        colon = j;
        break;
      }
    }
    if (colon > i) {
      const targets = line.slice(i, colon);
      const special = /^\.[A-Z_]+$/.test(targets.trim());
      out.push(special ? 'keyword' : 'function', targets);
      let after = colon;
      while (line.charCodeAt(after) === 58) after++;
      out.push('operator', line.slice(colon, after));
      makeText(line, after, out);
      st.recipe = true;
      return;
    }
    makeText(line, i, out);
  },
};

// ---------------------------------------------------------------- diff

const diff = {
  init: () => ({}),
  line(line, st, out) {
    const c = line[0];
    if (line.startsWith('@@')) {
      const end = line.indexOf('@@', 2);
      out.push('type', end < 0 ? line : line.slice(0, end + 2));
      if (end >= 0) out.push('plain', line.slice(end + 2));
    } else if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('\\ ')) {
      out.push('comment', line);
    } else if (c === '+') out.push('string', line);
    else if (c === '-') out.push('variable', line);
    else out.push('plain', line);
  },
};

// ---------------------------------------------------------------- languages: names, guessing

const LANGUAGES = {
  go: GO,
  js: JS,
  ts: TS,
  python: PY,
  sql: SQL,
  hcl: HCL,
  json: { init: () => ({ block: false }), line: jsonLine },
  yaml: { init: () => ({ block: -1 }), line: yamlLine },
  shell: shellLang(false),
  console: shellLang(true),
  dockerfile,
  make: makefile,
  diff,
};

/** The names the scanners go by, for the docs and the tests. */
export const LANGUAGE_NAMES = Object.keys(LANGUAGES);

const ALIASES = new Map(Object.entries({
  go: 'go', golang: 'go',
  bash: 'shell', sh: 'shell', shell: 'shell', zsh: 'shell', ksh: 'shell', dash: 'shell', shellscript: 'shell', 'shell-script': 'shell',
  console: 'console', terminal: 'console', shellsession: 'console', 'shell-session': 'console', 'sh-session': 'console', session: 'console',
  dockerfile: 'dockerfile', docker: 'dockerfile', containerfile: 'dockerfile',
  yaml: 'yaml', yml: 'yaml',
  json: 'json', jsonc: 'json', json5: 'json',
  hcl: 'hcl', terraform: 'hcl', tf: 'hcl', tfvars: 'hcl',
  python: 'python', py: 'python', python3: 'python', py3: 'python',
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', ts: 'ts', tsx: 'ts',
  sql: 'sql', postgres: 'sql', postgresql: 'sql', pgsql: 'sql', plpgsql: 'sql', mysql: 'sql', sqlite: 'sql',
  makefile: 'make', make: 'make', mk: 'make',
  diff: 'diff', patch: 'diff', udiff: 'diff',
  // said to be plain on purpose: program output pasted under one of these must never be guessed to be shell or JSON
  text: 'plain', txt: 'plain', plain: 'plain', plaintext: 'plain', output: 'plain', log: 'plain', logs: 'plain', stdout: 'plain', stderr: 'plain',
  result: 'plain', response: 'plain', none: 'plain', nohighlight: 'plain', raw: 'plain', ascii: 'plain', tree: 'plain',
}));

/**
 * The scanner a fence's label stands for: 'go', 'shell', 'yaml'... or 'plain' when the label says the block is plain text, or '' when it
 * is empty or not one we know (then the text is looked at). A file name works as well: main.go, docker-compose.yml, Dockerfile.dev.
 */
export function canonicalLanguage(label) {
  let s = String(label ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^(?:language|lang)-/, '');
  if (ALIASES.has(s)) return ALIASES.get(s);
  if (s.startsWith('dockerfile') || s.endsWith('.dockerfile')) return 'dockerfile';
  const dot = s.lastIndexOf('.');
  if (dot >= 0 && ALIASES.has(s.slice(dot + 1))) return ALIASES.get(s.slice(dot + 1));
  return '';
}

/**
 * A guess from the first lines, for a fence with no label (or one we do not know). Only things that are rarely anything else: a Go package or
 * func, FROM, a Terraform block, "$ " prompts, a shebang, JSON that parses; everything else is left plain. Shell is guessed from prompts and
 * shebangs only, never from words: the text under a bare fence is usually output, and output coloured as shell is a lie.
 */
export function guessLanguage(text) {
  const src = String(text ?? '');
  if (!src.trim() || src.length > LIMITS.maxChars) return '';
  const lines = [];
  for (const raw of src.split('\n', 60)) {
    if (raw.trim()) lines.push(raw.slice(0, 160));
    if (lines.length === 12) break;
  }
  const head = lines[0];
  if (/^#!.*\b(?:ba|z|k|da)?sh\b/.test(head)) return 'shell';
  if (/^#!.*\bpython/.test(head)) return 'python';
  if (/^#!.*\b(?:node|deno|bun)\b/.test(head)) return 'js';
  if (PROMPT.test(head)) return 'shell';
  if (/^diff --git /.test(head) || (/^--- \S/.test(head) && lines[1] !== undefined && /^\+\+\+ \S/.test(lines[1])) || /^@@ -\d/.test(head)) return 'diff';
  const code = lines.filter((l) => !/^\s*(?:#|\/\/)/.test(l) || /^#\s*syntax=docker/.test(l));
  if (/^#\s*syntax=docker/.test(head) || (code.length > 0 && /^FROM\s+\S/.test(code[0])) || (code.length > 1 && /^ARG\s/.test(code[0]) && code.some((l) => /^FROM\s+\S/.test(l)))) return 'dockerfile';
  if (lines.some((l) => /^(?:resource|data)\s+"[^"]+"\s+"[^"]+"\s*\{/.test(l) || /^(?:variable|output|module|provider)\s+"[^"]+"\s*\{/.test(l) || /^(?:terraform|locals)\s*\{/.test(l))) return 'hcl';
  if (lines.some((l) => /^package\s+[A-Za-z_]\w*\s*$/.test(l) || /^func\s+(?:\([^)]{0,60}\)\s*)?[A-Za-z_]\w*\s*[([]/.test(l))) return 'go';
  if (/^(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE (?:TABLE|INDEX|VIEW|DATABASE)|ALTER TABLE|DROP TABLE)\s/.test(head)) return 'sql';
  if (lines.some((l) => /^def\s+\w+\(.*\)\s*(?:->.*)?:\s*$/.test(l) || /^from\s+[\w.]+\s+import\s/.test(l) || /^class\s+\w+(?:\(.*\))?:\s*$/.test(l))) return 'python';
  if (lines.some((l) => /console\.log\(/.test(l) || /^function\s+\w+\(/.test(l) || /^(?:const|let|var)\s+\w+\s*=\s*require\(/.test(l) || /^import\s.*\sfrom\s+['"]/.test(l) || /^export\s+(?:default|const|function)\b/.test(l))) return 'js';
  const first = head.trimStart()[0];
  if (first === '{' || first === '[') {
    try {
      JSON.parse(src);                                   // 42, "x" and true parse as JSON as well: only an object or an array counts
      return 'json';
    } catch {
      return '';
    }
  }
  return '';
}

// ---------------------------------------------------------------- tokenize, scan, highlight

const plainOf = (lines) => lines.map((l) => (l ? [['plain', l]] : []));

function runLines(impl, lines, st) {
  const out = new Out();
  for (let k = 0; k < lines.length; k++) {
    if (k) out.newline();
    impl.line(lines[k], st, out);
  }
  return out.finish();
}

/**
 * The scanner alone, with no caps, no guess and no check: for the tests (which must see a scanner's own mistakes, not the fallback that
 * hides them) and for tools. `lang` is a canonical name from LANGUAGE_NAMES.
 */
export function scan(lang, text) {
  const impl = LANGUAGES[lang];
  const src = String(text ?? '');
  const lines = src.split('\n');
  const st = impl.init(src, lines, undefined);
  let result = runLines(impl, lines, st);
  if (impl.twoPass && st.names.size > 0) result = runLines(impl, lines, impl.init(src, lines, st.names));
  return result;
}

const joined = (lines) => lines.map((runs) => runs.map((r) => r[1]).join('')).join('\n');

/**
 * Lines of [kind, text] runs for a fence's label and text. The label picks the scanner (or says plain); without one the text is guessed
 * from; unknown and over the caps it is plain. Whatever happens the runs read back as the text exactly (checked here, once, because a
 * scanner's mistake must cost colour and never a character), an empty line is an empty list, and nothing throws.
 */
export function tokenize(lang, text, limits = LIMITS) {
  const src = String(text ?? '');
  if (src.length > limits.maxChars) return plainOf(src.split('\n'));
  const lines = src.split('\n');
  if (lines.length > limits.maxLines) return plainOf(lines);
  let name = canonicalLanguage(lang);
  if (name === '') name = guessLanguage(src);
  if (name === '' || name === 'plain' || !Object.hasOwn(LANGUAGES, name)) return plainOf(lines);
  let result;
  try {
    result = scan(name, src);
  } catch {
    return plainOf(lines);
  }
  if (joined(result) !== src) return plainOf(lines);
  let spans = 0;
  for (const runs of result) for (const run of runs) if (run[0] !== 'plain') spans++;
  return spans > limits.maxRuns ? plainOf(lines) : result;
}

/**
 * The code of a fenced block as DOM: text nodes and one span (class `hl-KIND`) per coloured run, the lines joined by "\n" in the text
 * (no wrapper per line, no line numbers: dragging a selection over the block must copy what the source says). null when nothing is coloured.
 * Nodes are made with createElement, createTextNode and className only; what the model wrote never goes near an HTML parser.
 */
export function highlight(lang, text, doc) {
  const src = String(text ?? '');
  if (src.length > LIMITS.maxChars) return null;
  const lines = tokenize(lang, src);
  if (!lines.some((runs) => runs.some((run) => run[0] !== 'plain'))) return null;
  const frag = doc.createDocumentFragment();
  let pending = '';
  const flush = () => {
    if (pending) frag.append(doc.createTextNode(pending));
    pending = '';
  };
  lines.forEach((runs, index) => {
    if (index) pending += '\n';
    for (const [kind, s] of runs) {
      if (kind === 'plain') {
        pending += s;
        continue;
      }
      flush();
      const span = doc.createElement('span');
      span.className = `hl-${kind}`;
      span.textContent = s;
      frag.append(span);
    }
  });
  flush();
  return frag;
}
