# Code highlighting

TAi's replies are full of code (Go, Dockerfiles, Terraform, YAML, shell), and a block in one colour is slow to read. The page colours the code of a fenced block
with no library: `portal/web/highlight.js` (a tokenizer per language and the builder of the spans), `portal/web/highlight.css` (the colours),
`portal/web/highlight.test.js`. `markdown.js` calls it in three lines (an import and one call in the code block's builder); the file is in `PAGE_FILES` of
`src/portal/start.ts` and of `portal/qa/dev_server.mjs`, and `index.html` links the stylesheet after `style.css`.

## What it does

* The fence's label picks the scanner; a file name works too (`main.go`, `docker-compose.yml`, `Dockerfile.dev`):

  | Scanner | Labels |
  | --- | --- |
  | `go` | go, golang |
  | `shell` | bash, sh, shell, zsh, ksh, dash |
  | `console` (a terminal session) | console, terminal, shell-session, session |
  | `dockerfile` | dockerfile, docker, containerfile |
  | `yaml` | yaml, yml |
  | `json` | json, jsonc, json5 |
  | `hcl` | hcl, terraform, tf, tfvars |
  | `python` | python, py, python3 |
  | `js` | javascript, js, jsx, mjs, cjs, node |
  | `ts` | typescript, ts, tsx |
  | `sql` | sql, postgres, postgresql, pgsql, mysql, sqlite |
  | `make` | makefile, make, mk |
  | `diff` | diff, patch |

* **Plain on purpose**: `text`, `txt`, `plain`, `output`, `log`, `logs`, `stdout`, `stderr`, `result`, `response`, `none`, `raw`, `ascii`, `tree`. Program output pasted under one
  of them is never guessed to be shell or JSON.
* **No label, or one we do not know** (`mermaid`, `rust`): a guess from the first twelve non-blank lines, only for what is rarely anything else: a Go `package` or `func`,
  `FROM` (or `ARG` then `FROM`, or `# syntax=docker/`), a Terraform `resource "a" "b" {` / `terraform {` / `variable "x" {`, a `$ ` prompt or a shebang (shell, python, node), a
  diff, an upper-case `SELECT` / `CREATE TABLE`, a Python `def f():` / `from x import y`, JavaScript's `require(` / `console.log(`, JSON that parses and starts with `{` or `[`
  (`42`, `"x"` and `true` parse too and are not JSON here). Shell is never guessed from words. Everything else stays plain.
* **The text never changes.** `tokenize(lang, text)` returns lines of `[kind, text]` runs (kinds: keyword, type, string, comment, number, function, operator, punctuation,
  variable, plain); the runs of all lines joined with `\n` are the text, character for character, and `tokenize` checks that itself and falls back to plain if a scanner ever
  broke it. `highlight(lang, text, doc)` builds text nodes and `<span class="hl-KIND">` (`createElement`, `createTextNode`, `className`; no `innerHTML`, no attribute but the
  class), the lines joined by `\n` inside the one `<code>`, no wrapper per line and no line numbers: **Copy**, a selection and the browser's find read what TAi wrote. The
  block's label and copy button are as they were.
* **Where colour is deliberately absent** (a colour that says something false is worse than none): a Go package member (`sync.WaitGroup`), a struct field, a parameter; a
  JavaScript regular expression literal (a `/` is a division or a regex by what came before it; a quote inside one opens a string up to the end of its line, the text is intact);
  the word after `sudo -u` (no way to tell which word is the command); a `# ` in a terminal session (a comment far more often than root's prompt: the lines without a `$ ` prompt there
  are output, and plain); a YAML quoted scalar or flow collection that runs over lines; an SQL string over lines; a heredoc marker that does not end its line.

## The caps, and why

A block of more than **20,000 characters**, **600 lines** or **5,000 coloured runs** is left plain (`LIMITS`, and `tokenize` takes other limits as a third argument). The page is read
on phones and colour costs a node per token; a block that long is not read by its colours. Measured here (Node 26 on a PC, tokenizing only, median of 40): 560 lines of Go,
9.5k characters, 1,820 coloured runs, 2.5 ms; 533 lines of Terraform, 0.7 ms; 476 lines of Dockerfile, 0.9 ms. Ordinary code reaches the 600-line cap long before the character cap.
The numbers are round ones, not measured limits: the DOM cost of a few thousand spans on a phone was not measured.

No text makes a scanner slow, because no look-ahead is retried from the next character. The ones that could be (`${`, `$(`, an interpolation) stop at `LOOKAHEAD`, 256 characters, so
`${${${...` reads 256 characters per `${` and not the rest of the line; an unterminated string takes the rest of its line; the others (the colon of a YAML key, the end of a JSON string) run
once over text the scanner then consumes. The only recursion is `yamlValue` calling itself once for what follows a `|` or `>`. `highlight.test.js` reads a line of 60,000 characters of each of
61 shapes (quotes, `/*`, `${`, `$(`, backslashes, `<<`, `"""`, `- `, `a: `, digits, spaces ...) with every scanner, with no caps, and bounds each at 2.5 s (a linear scan takes 2 to 60 ms, a
quadratic one several seconds); and the same shapes just under the cap through `tokenize`. A quadratic scan built on `indexOf` would be quicker than that and could get past: the shapes catch
the loops that step a character at a time.

## Colours and contrast

`highlight.css` defines `--hl-keyword`, `-type`, `-string`, `-comment`, `-number`, `-function`, `-operator`, `-punctuation`, `-variable` in the same three places `style.css` defines its own:
`:root` (light), `@media (prefers-color-scheme: dark) { :root[data-theme="auto"] }`, and `:root[data-theme="dark"]`; then the same three again under `prefers-contrast: more`, in the same
order, with a set of at least 7:1. The rule: **each colour is at least 4.5:1 on `--code-bg` (the block's background) in light and dark, and 7:1 under `prefers-contrast: more`.** In forced
colors mode the colours fall back to `inherit` (the system's), and comments stay italic. Plain text is `--text`, as before.

`highlight.test.js` enforces it from the real files: it parses `highlight.css` and `style.css`, resolves the custom properties the way the cascade does (specificity, then file order, media
conditions) for all twelve ways a page can be in (`data-theme` auto, light or dark; the system's scheme; contrast), and checks the ratio of all nine colours against that theme's `--code-bg`, the
dark palette on dark and the light one on light (including a light theme on a dark system and the reverse), that the seven colours that name different things differ, that the six blocks define
the same variables, and that every class the renderer makes has a rule. Change a colour or `--code-bg` and the test says whether the rule still holds.

## Adding a language

1. A scanner is `{ init(text, lines), line(line, state, out) }`: `line` pushes `out.push(kind, text)` for **every** character of the line, in order (the tests fail otherwise). Words, strings, comments and
   numbers need only a table: call `cLike({ keywords, types, line: ['//'], block: ['/*', '*/'], strings: [...], after: { type: 'type' } })`. Carry state between lines (an open block comment, a raw string, a
   heredoc) in `state`.
2. Register it in `LANGUAGES` and its labels in `ALIASES` (a guess in `guessLanguage` only if it is rarely anything else).
3. Add a snippet to `SNIPPETS` in `highlight.test.js` and a `describe` with what it colours (and what it must not). The round-trip, the odd-text, the 200 random strings and the slow-text tests run over
   `LANGUAGE_NAMES`, so they cover it with no more code. Any look-ahead you write must be bounded.

## Verified, and not

Ran: `npx vitest run portal/web src/portal` (23 files, 571 passed, 2 skipped); `highlight.test.js` has 135 tests. Scratch fuzzing, not kept: 13 scanners x 3,000 random texts x 3 seeds and 23,400 scans of mutated
snippets, every round trip exact; 61 shapes at 200,000 characters per scanner, time proportional to length. In the browser (the in-app one, against the dev server): 16 blocks (every language, an unlabelled Go block,
a `text` block, one line of 2,985 characters) each with `textContent` identical to its source and no attribute but `class` on a span; the computed colours for every pairing of `data-theme` and system scheme; a
desktop screenshot in dark and a 390 px one in light; no sideways scroll of the page at 390 px (a block scrolls inside itself).

**Not verified**: `forced-colors` and `prefers-contrast: more` in a browser (the pane cannot emulate them; the unit test covers the stylesheet's cascade for contrast, not the browser's behaviour); Firefox and
Safari; a phone (so the caps are round numbers); a screen reader; `portal/qa/portal_e2e.py`'s three new checks after "the code reached the clipboard" (spans exist, the clipboard has exactly the block's text, a keyword has
a colour of its own: written, not run, Playwright is not on this PC).
