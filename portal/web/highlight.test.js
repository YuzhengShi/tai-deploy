// The syntax colours of code blocks: what each language's scanner makes of snippets from this course, that the text of a block never changes
// (for every language, on odd and random text), that no text can make a scanner slow, the caps, the DOM that is built, and that every colour
// has the contrast the stylesheet promises in every theme it can be shown in (resolved from the real highlight.css and style.css).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KINDS, LANGUAGE_NAMES, LIMITS, canonicalLanguage, guessLanguage, highlight, scan, tokenize } from './highlight.js';
import { parse, toDOM } from './markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(here, file), 'utf-8');

// ---------------------------------------------------------------- helpers

const joined = (lines) => lines.map((runs) => runs.map((r) => r[1]).join('')).join('\n');
const has = (lines, kind, text) => lines.some((runs) => runs.some((r) => r[0] === kind && r[1] === text));
/** The coloured runs that say exactly `text`: empty when the word is only ever plain text. */
const colouredAs = (lines, text) => lines.flat().filter((r) => r[1] === text && r[0] !== 'plain').map((r) => r[0]);
const expectRuns = (lines, expected) => {
  for (const [kind, text] of expected) expect(has(lines, kind, text), `${kind} ${JSON.stringify(text)}`).toBe(true);
};
const expectPlain = (lines, words) => {
  for (const word of words) expect(colouredAs(lines, word), `${JSON.stringify(word)} stays plain`).toEqual([]);
};

// ---------------------------------------------------------------- snippets from the course (synthetic: no student's words)

const GO = [
  'package main',
  '',
  'import (',
  '\t"fmt"',
  '\t"sync"',
  ')',
  '',
  'type Job struct {',
  '\tID    int    `json:"id"`',
  '\tInput string `json:"input"`',
  '}',
  '',
  '// worker drains jobs until the channel is closed.',
  'func worker(id int, jobs <-chan Job, results chan<- string, wg *sync.WaitGroup) {',
  '\tdefer wg.Done()',
  '\tfor j := range jobs {',
  '\t\tresults <- fmt.Sprintf("worker %d: job %d", id, j.ID)',
  '\t}',
  '}',
  '',
  'func main() {',
  '\tjobs := make(chan Job, 100)',
  '\tvar wg sync.WaitGroup',
  '\tfor w := 1; w <= 3; w++ {',
  '\t\twg.Add(1)',
  '\t\tgo worker(w, jobs, make(chan string), &wg)',
  '\t}',
  '\t/* send the work,',
  '\t   then close */',
  '\tjobs <- Job{ID: 0xFF, Input: `raw',
  'string`}',
  '\tx := 1_000 + 3.14 + 2e10',
  "\tr := 'a'",
  '\tclose(jobs)',
  '\twg.Wait()',
  '}',
].join('\n');

const DOCKERFILE = [
  '# syntax=docker/dockerfile:1',
  'FROM golang:1.22 AS build',
  'WORKDIR /src',
  'ENV CGO_ENABLED=0 GOOS=linux',
  'ARG VERSION=1.0',
  'COPY go.mod go.sum ./',
  'RUN go mod download',
  'COPY . .',
  'RUN go build -o /out/server ./cmd/server && \\',
  '    echo "built $VERSION" && \\',
  '    apt-get install -y curl',
  '# the runtime image',
  'FROM gcr.io/distroless/static:nonroot',
  'COPY --from=build /out/server /server',
  'EXPOSE 8080',
  'USER nonroot',
  'HEALTHCHECK --interval=30s CMD ["/server", "--health"]',
  'ENTRYPOINT ["/server", "--port", "8080"]',
].join('\n');

const TERRAFORM = [
  'terraform {',
  '  required_providers {',
  '    aws = {',
  '      source  = "hashicorp/aws"',
  '      version = "~> 5.0"',
  '    }',
  '  }',
  '}',
  '',
  'variable "region" {',
  '  type    = string',
  '  default = "us-west-2"',
  '}',
  '',
  '# A web server',
  'resource "aws_instance" "web" {',
  '  ami           = data.aws_ami.al2.id',
  '  instance_type = "t3.micro"',
  '  count         = 2',
  '  user_data     = <<-EOF',
  '    #!/bin/bash',
  '    echo "hello ${var.region}"',
  '  EOF',
  '  tags = {',
  '    Name = "web-${count.index}"',
  '    Env  = "${join(",", var.names)}"',
  '  }',
  '  /* block',
  '     comment */',
  '  lifecycle {',
  '    create_before_destroy = true',
  '  }',
  '}',
  '',
  'output "ips" {',
  '  value = [for i in aws_instance.web : i.public_ip]',
  '}',
].join('\n');

const COMPOSE = [
  'version: "3.8"',
  'services:',
  '  web:',
  '    image: nginx:latest   # the proxy',
  '    ports:',
  '      - "8080:80"',
  '    environment:',
  '      - DB_HOST=db',
  '    command: ["sh", "-c", "echo hi"]',
  '    depends_on: [db]',
  '    debug: true',
  '    ratio: 0.5',
  '    port: 8080',
  '    nothing: null',
  '  db:',
  '    healthcheck:',
  '      test: |',
  '        pg_isready -U postgres',
  '        echo done',
  '      interval: 10s',
  '      retries: 5',
  'anchors: &default',
  '  restart: always',
  'other:',
  '  <<: *default',
  '  list: {a: 1, b: [x, "y"]}',
  'steps:',
  '  - name: Build',
  '    run: |',
  '      go build ./...',
  '  - uses: actions/checkout@v4',
  '---',
  'second: document',
].join('\n');

const SESSION = [
  '$ go run main.go',
  '2026/11/05 10:00:00 listening on :8080',
  '$ curl -s localhost:8080/health | jq .status',
  '"ok"',
  '$ for i in 1 2 3; do echo "run $i"; done   # loop',
  'run 1',
  'ada@laptop:~/proj$ docker build -t app . && \\',
  '    docker run --rm -p 8080:80 app',
  '$ export TOKEN=abc123',
  '$ cat <<EOF > notes.txt',
  'hello $USER',
  'EOF',
  '$ ls -la',
].join('\n');

const SCRIPT = [
  '#!/bin/bash',
  'set -euo pipefail',
  'NAME="world"',
  'if [ -z "$NAME" ]; then',
  '  echo "empty" >&2',
  '  exit 1',
  'fi',
  'for f in *.go; do',
  '  go vet "$f" || true',
  'done',
  'echo "${#arr[@]} items" # count',
  'count=$(wc -l < file.txt)',
  'sudo -u root docker run -d --name web nginx',
  "cat <<'EOF' | kubectl apply -f -",
  'apiVersion: v1',
  'EOF',
  'case "$1" in',
  '  start) echo go ;;',
  'esac',
  "echo 'single $quoted' a#b",
  'export PATH=$PATH:/usr/local/go/bin',
].join('\n');

const SQL = [
  '-- orders per customer',
  'SELECT c.name, COUNT(o.id) AS orders, SUM(o.total) AS spend',
  'FROM customers c',
  'JOIN orders o ON o.customer_id = c.id',
  "WHERE o.created_at >= '2026-01-01' AND c.name <> 'it''s'",
  'GROUP BY c.name',
  'HAVING COUNT(o.id) > 5',
  'ORDER BY spend DESC',
  'LIMIT 10;',
  '/* multi',
  '   line */',
  'create table users (id SERIAL PRIMARY KEY, email VARCHAR(255) not null, "Name" text);',
].join('\n');

const JSON_API = [
  '{',
  '  "name": "tai",',
  '  "version": 2,',
  '  "ratio": -1.5e-3,',
  '  "ok": true,',
  '  "tags": ["a", "b"],',
  '  "nested": { "x": null, "msg": "say \\"hi\\"" }',
  '}',
].join('\n');

const PYTHON = [
  'import os',
  'from dataclasses import dataclass',
  '',
  '@dataclass',
  'class Job:',
  '    id: int',
  '    name: str = "x"',
  '',
  'def worker(q: list[int]) -> None:',
  '    """Drain the queue.',
  '    Second line."""',
  '    for item in q:',
  '        print(f"item {item}")  # show it',
  '        if item > 0x10 and item is not None:',
  "            raise ValueError('bad')",
  '    s = r"raw\\d+" + b\'x\' + 1_000 + 3.14',
].join('\n');

const JS = [
  "const express = require('express');",
  "import { readFile } from 'fs/promises';",
  '/* middleware */',
  "app.get('/health', async (req, res) => {",
  '  const n = 10n + 0xff + Array.from([1, 2]).length;',
  '  res.json({ ok: true, msg: `hello ${req.query.name}`, from: 1 });',
  '});',
  'class Server extends Base {',
  '  static create() { return new Server(); }',
  '}',
  '// done',
].join('\n');

const TS = [
  'interface Job { id: number; name?: string }',
  'type Result = Promise<string>;',
  'enum Color { Red, Green }',
  'export async function run(job: Job): Result {',
  "  const type = 'x';",
  '  return { type, id: job.id } as unknown as string;',
  '}',
].join('\n');

const MAKEFILE = [
  '# build the server',
  'CC := gcc',
  'BIN ?= bin/server',
  '.PHONY: build test clean',
  '',
  'build: main.go $(SRC)',
  '    @echo "building $@"',
  '    go build -o $(BIN) ./cmd/server',
  '',
  'ifeq ($(OS),Windows_NT)',
  '  EXT = .exe',
  'endif',
].join('\n');

const DIFF = [
  'diff --git a/main.go b/main.go',
  'index 83db48f..bf2a9c1 100644',
  '--- a/main.go',
  '+++ b/main.go',
  '@@ -10,7 +10,7 @@ func main() {',
  ' \tjobs := make(chan Job, 100)',
  '-\twg.Add(3)',
  '+\twg.Add(len(workers))',
  ' \tclose(jobs)',
  '\\ No newline at end of file',
].join('\n');

const SNIPPETS = { go: GO, dockerfile: DOCKERFILE, hcl: TERRAFORM, yaml: COMPOSE, shell: SESSION, 'shell (script)': SCRIPT, sql: SQL, json: JSON_API, python: PYTHON, js: JS, ts: TS, make: MAKEFILE, diff: DIFF };

// ---------------------------------------------------------------- the languages, on those snippets

describe('Go', () => {
  const lines = tokenize('go', GO);

  it('colours keywords, predeclared and declared types, functions, strings, comments and numbers', () => {
    expectRuns(lines, [
      ['keyword', 'package'], ['keyword', 'import'], ['keyword', 'type'], ['keyword', 'struct'], ['keyword', 'func'], ['keyword', 'defer'],
      ['keyword', 'for'], ['keyword', 'range'], ['keyword', 'var'], ['keyword', 'go'], ['keyword', 'chan'],
      ['type', 'int'], ['type', 'string'], ['type', 'Job'],
      ['function', 'worker'], ['function', 'main'], ['function', 'Sprintf'], ['function', 'make'], ['function', 'Done'], ['function', 'Add'], ['function', 'close'],
      ['string', '"fmt"'], ['string', '`json:"id"`'], ['string', "'a'"],
      ['comment', '// worker drains jobs until the channel is closed.'],
      ['number', '100'], ['number', '0xFF'], ['number', '1_000'], ['number', '3.14'], ['number', '2e10'],
      ['operator', ':='], ['operator', '<-'],
    ]);
  });

  it('runs a raw string and a block comment over lines', () => {
    // the tab in front of the comment's opener is plain text; the next line is all comment, its tab included
    expectRuns(lines, [['string', '`raw'], ['string', 'string`'], ['comment', '/* send the work,'], ['comment', '\t   then close */']]);
  });

  it('colours nothing it cannot be sure of: a package member, a field, a variable', () => {
    expectPlain(lines, ['sync', 'WaitGroup', 'wg', 'jobs', 'results', 'ID', 'Input', 'fmt']);
  });

  it('keeps an unterminated string to its line, and an open block comment to the end', () => {
    const open = tokenize('go', 'x := "abc\ny := 2');
    expect(has(open, 'string', '"abc')).toBe(true);
    expect(has(open, 'number', '2')).toBe(true);
    const comment = tokenize('go', 'a /* never closed\nstill comment');
    expect(has(comment, 'comment', 'still comment')).toBe(true);
  });
});

describe('Dockerfile', () => {
  const lines = tokenize('dockerfile', DOCKERFILE);

  it('colours instructions, images, stages, arguments and the shell in RUN', () => {
    expectRuns(lines, [
      ['comment', '# syntax=docker/dockerfile:1'], ['keyword', 'FROM'], ['keyword', 'AS'], ['keyword', 'WORKDIR'], ['keyword', 'ENV'], ['keyword', 'ARG'],
      ['keyword', 'COPY'], ['keyword', 'RUN'], ['keyword', 'EXPOSE'], ['keyword', 'USER'], ['keyword', 'HEALTHCHECK'], ['keyword', 'ENTRYPOINT'], ['keyword', 'CMD'],
      ['type', 'golang:1.22'], ['type', 'gcr.io/distroless/static:nonroot'], ['variable', 'build'],
      ['variable', 'CGO_ENABLED'], ['variable', 'VERSION'], ['number', '0'], ['number', '8080'], ['number', '1.0'],
      ['function', 'go'], ['function', 'echo'], ['function', 'apt-get'],
      ['string', '"built '], ['variable', '$VERSION'], ['string', '"/server"'], ['string', '"--port"'], ['comment', '# the runtime image'],
    ]);
  });

  it('carries a line that ends in a backslash: the next line is the same command, and a command after && is a command', () => {
    expect(has(lines, 'operator', '\\')).toBe(true);
    expect(colouredAs(lines, '-y')).toEqual([]);
    expect(colouredAs(lines, 'install')).toEqual([]);
  });

  it('keeps the indentation of a continuation (the text must come back)', () => {
    expect(joined(lines)).toBe(DOCKERFILE);
  });

  it('is not fooled by a heredoc in RUN', () => {
    const text = 'RUN <<EOF\n# not an instruction\nFROM nothing\nEOF\nUSER app';
    const out = tokenize('dockerfile', text);
    expect(has(out, 'keyword', 'USER')).toBe(true);
    expect(colouredAs(out, 'FROM')).toEqual([]);
  });
});

describe('Terraform (HCL)', () => {
  const lines = tokenize('terraform', TERRAFORM);

  it('colours blocks, attributes, references, strings, interpolations, comments and heredocs', () => {
    expectRuns(lines, [
      ['keyword', 'terraform'], ['keyword', 'required_providers'], ['keyword', 'variable'], ['keyword', 'resource'], ['keyword', 'lifecycle'], ['keyword', 'output'],
      ['keyword', 'true'], ['keyword', 'for'], ['keyword', 'in'], ['keyword', 'data'],
      ['variable', 'source'], ['variable', 'version'], ['variable', 'ami'], ['variable', 'instance_type'], ['variable', 'count'], ['variable', 'Name'], ['variable', 'user_data'],
      ['string', '"hashicorp/aws"'], ['string', '"aws_instance"'], ['string', '"web"'], ['type', 'string'], ['number', '2'],
      ['comment', '# A web server'],
    ]);
  });

  it('picks an interpolation out of a string, quotes inside it and all', () => {
    expectRuns(lines, [['variable', '${count.index}'], ['variable', '${join(",", var.names)}']]);
    const envLine = lines.find((runs) => runs.some((r) => r[1].startsWith('Env')));
    expect(envLine.map((r) => r[1]).join('')).toBe('    Env  = "${join(",", var.names)}"');
  });

  it('runs a heredoc, with its closing word, as one string over lines; the next line is code again', () => {
    expectRuns(lines, [['operator', '<<-'], ['string', 'EOF'], ['string', '    #!/bin/bash'], ['string', '    echo "hello ${var.region}"'], ['string', '  EOF']]);
    expect(colouredAs(lines, 'tags')).toEqual(['variable']);
  });

  it('takes a block comment over lines, and == and => for something other than an attribute', () => {
    expectRuns(lines, [['comment', '/* block'], ['comment', '     comment */']]);
    const out = tokenize('hcl', 'a = b == c\nx = [for k, v in m : k => v]');
    expect(has(out, 'variable', 'a')).toBe(true);
    expect(colouredAs(out, 'b')).toEqual([]);
    expect(colouredAs(out, 'k')).toEqual([]);
  });
});

describe('YAML', () => {
  const lines = tokenize('yml', COMPOSE);

  it('colours keys, quoted strings, numbers, literals, comments, anchors and flow collections', () => {
    expectRuns(lines, [
      ['variable', 'version'], ['variable', 'services'], ['variable', 'web'], ['variable', 'image'], ['variable', 'environment'], ['variable', 'depends_on'],
      ['string', '"3.8"'], ['string', '"8080:80"'], ['string', '"sh"'], ['string', '"echo hi"'],
      ['number', '0.5'], ['number', '8080'], ['number', '5'], ['keyword', 'null'],
      ['comment', '# the proxy'], ['variable', '&default'], ['variable', '*default'], ['variable', 'a'], ['variable', 'b'],
      ['punctuation', '---'],
    ]);
    expect(has(lines, 'keyword', 'true')).toBe(true);
  });

  it('leaves unquoted words alone: nginx:latest, a list item that is a KEY=value, a value that is a word', () => {
    expectPlain(lines, ['nginx:latest', 'DB_HOST=db', 'always', 'Build', 'document']);
  });

  it('takes the lines indented under | as one string each, up to the line that is indented no further', () => {
    expectRuns(lines, [['operator', '|'], ['string', 'pg_isready -U postgres'], ['string', 'echo done'], ['string', 'go build ./...']]);
    expect(has(lines, 'variable', 'interval')).toBe(true);
    expect(has(lines, 'variable', 'uses')).toBe(true);
  });

  it('reads a ":" as a key only in front of a space or the end of the line', () => {
    const out = tokenize('yaml', 'url: http://example.com:8080/x\nkey:value\nempty:\n- a: 1\n- - nested');
    expect(has(out, 'variable', 'url')).toBe(true);
    expect(has(out, 'variable', 'empty')).toBe(true);
    expect(has(out, 'variable', 'a')).toBe(true);
    expect(colouredAs(out, 'key:value')).toEqual([]);
    expect(colouredAs(out, 'http://example.com:8080/x')).toEqual([]);
  });
});

describe('shell and terminal sessions', () => {
  const session = tokenize('console', SESSION);

  it('colours the commands after a prompt, and leaves what they printed alone', () => {
    expectRuns(session, [
      ['punctuation', '$'], ['punctuation', 'ada@laptop:~/proj$'], ['function', 'go'], ['function', 'curl'], ['function', 'jq'], ['function', 'docker'], ['function', 'cat'], ['function', 'ls'],
      ['keyword', 'for'], ['keyword', 'in'], ['keyword', 'do'], ['keyword', 'done'], ['keyword', 'export'], ['variable', 'TOKEN'], ['variable', '$i'],
      ['operator', '|'], ['operator', '&&'], ['comment', '# loop'], ['string', '"run '],
    ]);
    // output lines: not one run of colour, even the line that looks like a string
    for (const index of [1, 3, 5]) expect(session[index]).toEqual([['plain', SESSION.split('\n')[index]]]);
  });

  it('knows a heredoc inside a session, and a command that goes on to the next line', () => {
    expectRuns(session, [['operator', '<<'], ['string', 'EOF'], ['string', 'hello $USER']]);
    expect(has(session, 'function', 'docker')).toBe(true);
    expect(colouredAs(session, '--rm')).toEqual([]);
  });

  it('treats a bash block with a "$ " line as a session, and one without as a script', () => {
    const mixed = tokenize('bash', '$ echo hi\nhi there\n');
    expect(mixed[1]).toEqual([['plain', 'hi there']]);
    const script = tokenize('bash', 'echo hi\nhi there\n');
    expect(has(script, 'function', 'echo')).toBe(true);
    expect(has(script, 'function', 'hi')).toBe(true);
  });

  it('does not take "# " for a root prompt', () => {
    const out = tokenize('sh', '$ echo a\n# a comment\n');
    expect(out[1]).toEqual([['plain', '# a comment']]);
    expect(has(tokenize('sh', '# a comment\necho a'), 'comment', '# a comment')).toBe(true);
  });

  const script = tokenize('sh', SCRIPT);

  it('colours a script: comments, keywords, commands, strings with their variables, assignments, redirections', () => {
    expectRuns(script, [
      ['comment', '#!/bin/bash'], ['function', 'set'], ['variable', 'NAME'], ['string', '"world"'], ['keyword', 'if'], ['keyword', 'then'], ['keyword', 'fi'],
      ['keyword', 'for'], ['keyword', 'do'], ['keyword', 'done'], ['keyword', 'case'], ['keyword', 'esac'], ['function', 'echo'], ['function', 'exit'], ['function', 'go'],
      ['variable', '$NAME'], ['variable', '${#arr[@]}'], ['variable', '$f'], ['comment', '# count'], ['function', 'wc'], ['function', 'sudo'], ['function', 'kubectl'],
      ['string', "'single $quoted'"], ['variable', 'count'], ['variable', 'PATH'], ['variable', '$PATH'], ['operator', '||'],
    ]);
  });

  it('has a "#" start a comment only at the start of a word, and keeps a heredoc as text', () => {
    expect(colouredAs(script, 'a#b')).toEqual([]);
    expectRuns(script, [['string', 'apiVersion: v1'], ['string', 'EOF']]);
  });

  it('does not take a case pattern for a command, nor the word after an option for the command', () => {
    expect(colouredAs(script, 'start')).toEqual([]);
    expect(colouredAs(script, 'root')).toEqual([]);
    expect(has(script, 'function', 'echo')).toBe(true);
  });
});

describe('SQL', () => {
  const lines = tokenize('postgresql', SQL);

  it('colours keywords whatever their case, functions, types, strings, identifiers, numbers and comments', () => {
    expectRuns(lines, [
      ['keyword', 'SELECT'], ['keyword', 'FROM'], ['keyword', 'JOIN'], ['keyword', 'ON'], ['keyword', 'WHERE'], ['keyword', 'AND'], ['keyword', 'GROUP'], ['keyword', 'BY'],
      ['keyword', 'HAVING'], ['keyword', 'ORDER'], ['keyword', 'DESC'], ['keyword', 'LIMIT'], ['keyword', 'AS'], ['keyword', 'create'], ['keyword', 'table'], ['keyword', 'not'], ['keyword', 'null'],
      ['function', 'COUNT'], ['function', 'SUM'], ['type', 'SERIAL'], ['type', 'VARCHAR'], ['type', 'text'],
      ['string', "'2026-01-01'"], ['string', "'it''s'"], ['variable', '"Name"'], ['number', '5'], ['number', '10'], ['number', '255'],
      ['comment', '-- orders per customer'], ['comment', '/* multi'], ['comment', '   line */'], ['operator', '>='], ['operator', '<>'],
    ]);
    expectPlain(lines, ['customers', 'orders', 'spend', 'name', 'email']);
  });
});

describe('JSON', () => {
  const lines = tokenize('json', JSON_API);

  it('tells a key from a string value, and colours numbers and literals', () => {
    expectRuns(lines, [['variable', '"name"'], ['string', '"tai"'], ['number', '2'], ['number', '-1.5e-3'], ['keyword', 'true'], ['keyword', 'null'], ['string', '"a"'], ['variable', '"x"'], ['punctuation', '{']]);
    expect(has(lines, 'string', '"say \\"hi\\""')).toBe(true);
  });

  it('ends a string left open at the end of its line', () => {
    const out = tokenize('json', '{"a": "unclosed\n"b": 1}');
    expect(has(out, 'string', '"unclosed')).toBe(true);
    expect(has(out, 'variable', '"b"')).toBe(true);
  });
});

describe('Python', () => {
  const lines = tokenize('py', PYTHON);

  it('colours keywords, declared and builtin types, functions, decorators, strings of every kind, comments and numbers', () => {
    expectRuns(lines, [
      ['keyword', 'import'], ['keyword', 'from'], ['keyword', 'class'], ['keyword', 'def'], ['keyword', 'for'], ['keyword', 'in'], ['keyword', 'if'], ['keyword', 'and'],
      ['keyword', 'is'], ['keyword', 'not'], ['keyword', 'raise'], ['keyword', 'None'],
      ['type', 'Job'], ['type', 'int'], ['type', 'str'], ['type', 'list'], ['function', '@dataclass'], ['function', 'worker'], ['function', 'print'],
      ['string', '"x"'], ['string', 'f"item {item}"'], ['string', "'bad'"], ['string', 'r"raw\\d+"'], ['string', "b'x'"],
      ['number', '0x10'], ['number', '1_000'], ['number', '3.14'], ['comment', '# show it'],
    ]);
  });

  it('runs a triple-quoted string over lines', () => {
    expectRuns(lines, [['string', '"""Drain the queue.'], ['string', '    Second line."""']]);
  });

  it('does not take an @ in the middle of a line for a decorator', () => {
    const out = tokenize('python', 'x = a @ b');
    expect(colouredAs(out, '@')).toEqual(['operator']);
  });
});

describe('JavaScript and TypeScript', () => {
  const js = tokenize('js', JS);
  const ts = tokenize('ts', TS);

  it('colours JavaScript: keywords, functions, strings, template literals with their ${} parts, classes, comments, numbers', () => {
    expectRuns(js, [
      ['keyword', 'const'], ['keyword', 'import'], ['keyword', 'from'], ['keyword', 'async'], ['keyword', 'class'], ['keyword', 'extends'], ['keyword', 'static'], ['keyword', 'return'], ['keyword', 'new'],
      ['function', 'require'], ['function', 'get'], ['function', 'json'], ['function', 'create'], ['type', 'Server'], ['type', 'Base'], ['type', 'Array'],
      ['string', "'express'"], ['string', '`hello '], ['variable', '${req.query.name}'], ['number', '10n'], ['number', '0xff'], ['keyword', 'true'],
      ['comment', '/* middleware */'], ['comment', '// done'],
    ]);
  });

  it('takes "from" for a keyword only in front of a module, and a member for a member', () => {
    expect(colouredAs(js, 'length')).toEqual([]);
    // import ... from 'mod' (a keyword), Array.from( (a method), { from: 1 } (a word): in the order they are in the snippet
    expect(colouredAs(js, 'from')).toEqual(['keyword', 'function']);
    expect(colouredAs(tokenize('js', 'f(from, to)'), 'from')).toEqual([]);
  });

  it('colours TypeScript: interface, type alias, enum, the types, and a property called type is only a word', () => {
    expectRuns(ts, [
      ['keyword', 'interface'], ['keyword', 'type'], ['keyword', 'enum'], ['keyword', 'export'], ['keyword', 'async'], ['keyword', 'function'], ['keyword', 'as'],
      ['type', 'Job'], ['type', 'Result'], ['type', 'Promise'], ['type', 'number'], ['type', 'string'], ['type', 'unknown'], ['function', 'run'], ['string', "'x'"],
    ]);
    expect(ts[4].find((r) => r[1] === 'type')).toBeUndefined();
    expect(ts[5].find((r) => r[1] === 'type')).toBeUndefined();
  });

  it('keeps a division a division: no regular expression is guessed at', () => {
    const out = tokenize('js', 'const half = total / 2; const s = "x";');
    expect(has(out, 'number', '2')).toBe(true);
    expect(has(out, 'string', '"x"')).toBe(true);
    // the price of that: a quote inside a regular expression opens a string, up to the end of its line. Colour is wrong there, the text is not.
    const regex = 'const re = /"/g;\nconst n = 2;';
    expect(joined(tokenize('js', regex))).toBe(regex);
    expect(has(tokenize('js', regex), 'number', '2')).toBe(true);
  });
});

describe('Makefile and diff', () => {
  it('colours variables, targets, directives and recipes', () => {
    const lines = tokenize('makefile', MAKEFILE);
    expectRuns(lines, [
      ['comment', '# build the server'], ['variable', 'CC'], ['operator', ':='], ['variable', 'BIN'], ['operator', '?='], ['keyword', '.PHONY'], ['function', 'build'],
      ['variable', '$(SRC)'], ['operator', '@'], ['function', 'echo'], ['variable', '$@'], ['function', 'go'], ['variable', '$(BIN)'], ['keyword', 'ifeq'], ['keyword', 'endif'],
    ]);
  });

  it('colours the lines of a diff by their first character', () => {
    const lines = tokenize('patch', DIFF);
    expectRuns(lines, [
      ['comment', 'diff --git a/main.go b/main.go'], ['comment', '--- a/main.go'], ['comment', '+++ b/main.go'], ['type', '@@ -10,7 +10,7 @@'],
      ['variable', '-\twg.Add(3)'], ['string', '+\twg.Add(len(workers))'], ['comment', '\\ No newline at end of file'],
    ]);
    expect(lines[5]).toEqual([['plain', ' \tjobs := make(chan Job, 100)']]);
  });
});

// ---------------------------------------------------------------- the language of a fence

describe('canonicalLanguage', () => {
  it('knows the names and aliases of the course', () => {
    const table = {
      go: 'go', Go: 'go', golang: 'go', bash: 'shell', sh: 'shell', shell: 'shell', zsh: 'shell', console: 'console', terminal: 'console', 'shell-session': 'console',
      dockerfile: 'dockerfile', Dockerfile: 'dockerfile', docker: 'dockerfile', yaml: 'yaml', yml: 'yaml', json: 'json', jsonc: 'json', hcl: 'hcl', terraform: 'hcl', tf: 'hcl',
      python: 'python', py: 'python', javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', typescript: 'ts', ts: 'ts', tsx: 'ts', sql: 'sql', postgresql: 'sql', mysql: 'sql',
      makefile: 'make', Makefile: 'make', diff: 'diff', patch: 'diff',
    };
    for (const [label, name] of Object.entries(table)) expect(canonicalLanguage(label), label).toBe(name);
  });

  it('reads a file name, a language- prefix and surrounding space', () => {
    expect(canonicalLanguage('main.go')).toBe('go');
    expect(canonicalLanguage('docker-compose.yml')).toBe('yaml');
    expect(canonicalLanguage('main.tf')).toBe('hcl');
    expect(canonicalLanguage('Dockerfile.dev')).toBe('dockerfile');
    expect(canonicalLanguage('language-go')).toBe('go');
    expect(canonicalLanguage('  YAML ')).toBe('yaml');
  });

  it('says plain for the labels that name plain text, and nothing for what it does not know', () => {
    for (const label of ['text', 'txt', 'plain', 'plaintext', 'output', 'log', 'Output']) expect(canonicalLanguage(label), label).toBe('plain');
    for (const label of ['', 'rust', 'c++', 'unknown', undefined, null]) expect(canonicalLanguage(label), String(label)).toBe('');
  });

  it('cannot be fooled by the names of Object.prototype', () => {
    for (const label of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
      expect(canonicalLanguage(label), label).toBe('');
      expect(() => tokenize(label, 'x = 1')).not.toThrow();
    }
  });
});

describe('guessLanguage', () => {
  it('guesses what is rarely anything else', () => {
    expect(guessLanguage('package main\n\nfunc main() {}')).toBe('go');
    expect(guessLanguage('// helper\nfunc add(a, b int) int {\n\treturn a + b\n}')).toBe('go');
    expect(guessLanguage('FROM golang:1.22 AS build\nRUN go build ./...')).toBe('dockerfile');
    expect(guessLanguage('# syntax=docker/dockerfile:1\nFROM alpine')).toBe('dockerfile');
    expect(guessLanguage('resource "aws_instance" "web" {\n  ami = "x"\n}')).toBe('hcl');
    expect(guessLanguage('terraform {\n  required_version = ">= 1.5"\n}')).toBe('hcl');
    expect(guessLanguage('$ go run main.go\nlistening')).toBe('shell');
    expect(guessLanguage('#!/usr/bin/env bash\necho hi')).toBe('shell');
    expect(guessLanguage('{"a": [1, 2, {"b": null}]}')).toBe('json');
    expect(guessLanguage('[1, 2, 3]')).toBe('json');
    expect(guessLanguage('SELECT * FROM users WHERE id = 1;')).toBe('sql');
    expect(guessLanguage('def f(x):\n    return x')).toBe('python');
    expect(guessLanguage("const fs = require('fs');")).toBe('js');
    expect(guessLanguage('diff --git a/x b/x\n--- a/x\n+++ b/x')).toBe('diff');
  });

  it('does not guess from words: program output, prose, a bare number, a string, a log line', () => {
    for (const text of ['go run main.go', 'listening on :8080\nrequest 12 took 3ms', 'Here is how it works', '42', '"x"', 'true', '[INFO] server started', '{not json}', 'select * from users', '', '   \n']) {
      expect(guessLanguage(text), JSON.stringify(text)).toBe('');
    }
  });

  it('guesses nothing from text over the cap', () => {
    expect(guessLanguage('package main\n' + 'x'.repeat(LIMITS.maxChars))).toBe('');
  });

  it('is used when the label is missing or unknown, and never against a label that says plain', () => {
    expect(has(tokenize('', GO), 'keyword', 'func')).toBe(true);
    expect(has(tokenize('mermaid', GO), 'keyword', 'func')).toBe(true);
    expect(tokenize('text', GO).flat().every((r) => r[0] === 'plain')).toBe(true);
    expect(tokenize('output', '$ go run .\nok').flat().every((r) => r[0] === 'plain')).toBe(true);
    expect(tokenize('', 'just some words\nno code here').flat().every((r) => r[0] === 'plain')).toBe(true);
  });

  it('is overruled by a label: Go text under a yaml fence is read as yaml', () => {
    expect(has(tokenize('yaml', 'package main'), 'variable', 'package main')).toBe(false);
    expect(tokenize('python', GO).flat().some((r) => r[0] === 'keyword')).toBe(true);
  });
});

// ---------------------------------------------------------------- the text must come back

// a small seeded generator: the same 200 strings on every run
function generator(seed) {
  let state = seed;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const PIECES = [
  '"', "'", '`', '/', '*', '\\', '$', '{', '}', '(', ')', '[', ']', '#', '-', ':', '=', '<', '>', '|', '&', ';', '.', ',', '@', '%', '!', '?', ' ', ' ', '\t', '\r', '\n', '\n',
  'a', 'b', 'x', 'F', 'A', '0', '1', '9', 'e', 'E', '_', '+', '~', 'é', '中', '😀', '\ud83d', '\ude00', '\u0000',
  '<<', '${', '/*', '*/', '//', '"""', "'''", '<<EOF', 'EOF', '$(', '--', '---', '@@', '\n$ ', '\n# ', 'func ', 'type ', 'class ', 'FROM ', 'RUN ', 'if ', 'then ', 'in ', 'true', 'null', '0x', '1e5', '=>', '::',
];
function randomTexts(count, seed) {
  const next = generator(seed);
  return Array.from({ length: count }, () => {
    let text = '';
    const length = Math.floor(next() * 160);
    while (text.length < length) text += PIECES[Math.floor(next() * PIECES.length)];
    return text;
  });
}
const ODD = ['', '\n', '\n\n', 'a\n', '\na', '\r\n', 'a\r\nb\r\n', ' ', '\t', '\u0000', '\ud83d', 'x😀y', '"', "'", '`', '/*', '"""', '$', '${', '<<EOF', '\\', '\\\n', '---', '- ', '$ ', '$ \n', '#', '@', '0x', '1e'];

describe('the text of a block is never changed', () => {
  const everything = [...Object.values(SNIPPETS), ...ODD, ...randomTexts(200, 4242)];

  it.each(LANGUAGE_NAMES)('%s: the scanner alone gives back every snippet, odd text and 200 random strings, character for character', (name) => {
    for (const text of everything) {
      const lines = scan(name, text);
      expect(joined(lines), JSON.stringify(text)).toBe(text);
      expect(lines).toHaveLength(text.split('\n').length);
    }
  });

  it.each(LANGUAGE_NAMES)('%s: tokenize gives the same, for the label and for a guess', (name) => {
    for (const text of everything) expect(joined(tokenize(name, text)), JSON.stringify(text)).toBe(text);
  });

  it('gives back the text under any label, and under none', () => {
    for (const text of [...Object.values(SNIPPETS), ...randomTexts(50, 7)]) {
      for (const label of ['', 'go', 'text', 'whatever', 'sh']) expect(joined(tokenize(label, text))).toBe(text);
    }
  });

  it('makes an empty line an empty list of runs, and never an empty run', () => {
    expect(tokenize('go', '')).toEqual([[]]);
    expect(tokenize('go', '\n')).toEqual([[], []]);
    for (const text of Object.values(SNIPPETS)) for (const runs of tokenize('go', text)) for (const run of runs) expect(run[1]).not.toBe('');
  });

  it('never says a kind it does not have', () => {
    for (const [label, text] of Object.entries(SNIPPETS)) {
      for (const runs of tokenize(label.split(' ')[0], text)) for (const run of runs) expect(KINDS, `${label}: ${run}`).toContain(run[0]);
    }
  });

  it('is deterministic: the same text gives the same runs twice (no state is kept between calls)', () => {
    for (const [label, text] of Object.entries(SNIPPETS)) {
      const name = label.split(' ')[0];
      expect(tokenize(name, text)).toEqual(tokenize(name, text));
    }
  });

  it('survives anything it is given as the text', () => {
    for (const odd of [undefined, null, 42, {}, [], true]) expect(() => tokenize('go', odd)).not.toThrow();
    expect(tokenize('go', undefined)).toEqual([[]]);
  });
});

// ---------------------------------------------------------------- text built to be slow

/** One long line of each shape that makes a scanner look ahead, back up or start over: none may take longer than reading it. */
const SHAPES = {
  letters: (n) => 'a'.repeat(n), quotes: (n) => '"'.repeat(n), apostrophes: (n) => "'".repeat(n), backticks: (n) => '`'.repeat(n), 'open string': (n) => '"a'.repeat(n / 2),
  'block comment opens': (n) => '/*'.repeat(n / 2), 'block comment closes': (n) => '*/'.repeat(n / 2), backslashes: (n) => '\\'.repeat(n), 'escaped quotes': (n) => '"' + '\\"'.repeat(n / 2),
  'interpolation opens': (n) => '${'.repeat(n / 2), 'interpolation with a quote': (n) => '${"'.repeat(n / 3), 'string of interpolations': (n) => '"' + '${'.repeat(n / 2), dollars: (n) => '$'.repeat(n),
  'command substitutions': (n) => '$('.repeat(n / 2), 'braces without a close': (n) => '${a'.repeat(n / 3), hashes: (n) => '#'.repeat(n), 'hex digits': (n) => '0x' + 'f'.repeat(n),
  digits: (n) => '1'.repeat(n), exponents: (n) => '1e'.repeat(n / 2), 'dotted digits': (n) => '1.'.repeat(n / 2), spaces: (n) => ' '.repeat(n), shifts: (n) => '<<'.repeat(n / 2),
  'heredoc markers': (n) => '<<A'.repeat(n / 3), 'triple quotes': (n) => '"""'.repeat(n / 3), 'triple apostrophes': (n) => "'''".repeat(n / 3), parentheses: (n) => '('.repeat(n),
  braces: (n) => '{'.repeat(n), brackets: (n) => '['.repeat(n), dashes: (n) => '-'.repeat(n), 'list dashes': (n) => '- '.repeat(n / 2), keys: (n) => 'a: '.repeat(n / 3),
  colons: (n) => 'a:'.repeat(n / 2), 'spaced colons': (n) => ': '.repeat(n / 2), dots: (n) => '.'.repeat(n), pipes: (n) => '|'.repeat(n), ampersands: (n) => '&'.repeat(n),
  equals: (n) => 'a='.repeat(n / 2), 'comment dashes': (n) => '--'.repeat(n / 2), 'at signs': (n) => '@a'.repeat(n / 2), prefixes: (n) => 'f"'.repeat(n / 2),
  'many short lines': (n) => 'x\n'.repeat(n / 2), 'prompts': (n) => '$ x\n'.repeat(n / 4), 'continuations': (n) => 'a\\\n'.repeat(n / 3), 'declarations': (n) => 'type x\n'.repeat(n / 7),
  'json objects': (n) => '{"a":'.repeat(n / 5), 'heredoc lines': (n) => '<<EOF\n'.repeat(n / 6), 'instructions': (n) => 'FROM x\n'.repeat(n / 7), 'members': (n) => 'a.b.'.repeat(n / 4),
  'anchors': (n) => '*a '.repeat(n / 3), 'flow openers': (n) => '[a, '.repeat(n / 4), 'flow mappings': (n) => '{a: '.repeat(n / 4), random: (n) => randomTexts(1, n)[0].repeat(Math.ceil(n / 80)).slice(0, n),
};

describe('text built to be slow', () => {
  // generous bounds, for a machine that is running other things: what these catch is a scanner that is quadratic, which takes minutes here
  // (scan() has no caps, so these lines are read in full; tokenize() would leave them plain)

  // 60,000 characters: a linear scan takes 2 to 60 ms here, one that is quadratic (a few ns a step) several seconds. Each shape has its own bound,
  // 40 times what it takes, for a machine that is running other things.
  it.each(LANGUAGE_NAMES)('%s: a 60,000-character line of every shape is read in linear time, and comes back whole', (name) => {
    for (const [shape, make] of Object.entries(SHAPES)) {
      const text = make(60000);
      const started = performance.now();
      const lines = scan(name, text);
      const took = performance.now() - started;
      expect(joined(lines), `${name} ${shape}`).toBe(text);
      expect(took, `${name} ${shape}: ${took.toFixed(0)} ms`).toBeLessThan(2500);
    }
  }, 60000);

  it.each(LANGUAGE_NAMES)('%s: a line just under the cap, in every shape, is read at once (with the caps as they are)', (name) => {
    const started = performance.now();
    for (const [shape, make] of Object.entries(SHAPES)) {
      const text = make(LIMITS.maxChars - 200);
      expect(joined(tokenize(name, text)), `${name} ${shape}`).toBe(text);
    }
    expect(performance.now() - started).toBeLessThan(4000);
  }, 60000);

  it('leaves a 50,000-character line of one token plain, at once', () => {
    const started = performance.now();
    for (const token of ['a', '"', '/*', '$', '1', '(']) {
      const out = tokenize('go', token.repeat(50000));
      expect(out.flat().every((r) => r[0] === 'plain')).toBe(true);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------- the caps

describe('the caps', () => {
  const allPlain = (lines) => lines.flat().every((r) => r[0] === 'plain');
  const goLine = 'x := 1\n';

  it('leave a block of more than 20,000 characters plain', () => {
    const big = goLine.repeat(Math.ceil((LIMITS.maxChars + 1) / goLine.length));
    expect(big.length).toBeGreaterThan(LIMITS.maxChars);
    expect(allPlain(tokenize('go', big))).toBe(true);
    expect(joined(tokenize('go', big))).toBe(big);
    expect(highlight('go', big, fakeDocument())).toBeNull();
  });

  it('colour a block of exactly 20,000 characters', () => {
    const edge = 'a := 1'.padEnd(LIMITS.maxChars, ' ');
    expect(edge).toHaveLength(LIMITS.maxChars);
    expect(allPlain(tokenize('go', edge))).toBe(false);
    expect(joined(tokenize('go', edge))).toBe(edge);
  });

  it('leave a block of more than 600 lines plain, and colour one of 600', () => {
    const lines = (count) => Array.from({ length: count }, () => 'x := 1').join('\n');
    expect(allPlain(tokenize('go', lines(LIMITS.maxLines + 1)))).toBe(true);
    expect(joined(tokenize('go', lines(LIMITS.maxLines + 1)))).toBe(lines(LIMITS.maxLines + 1));
    expect(allPlain(tokenize('go', lines(LIMITS.maxLines)))).toBe(false);
  });

  it('leave a block that would need more than 5,000 spans plain', () => {
    const dense = Array.from({ length: 12 }, () => '1+'.repeat(250)).join('\n');      // 12 lines of 500 runs
    expect(dense.length).toBeLessThan(LIMITS.maxChars);
    expect(allPlain(tokenize('go', dense))).toBe(true);
    expect(joined(tokenize('go', dense))).toBe(dense);
  });

  it('take other limits when they are given', () => {
    expect(allPlain(tokenize('go', 'x := 1', { maxChars: 3, maxLines: 600, maxRuns: 5000 }))).toBe(true);
    expect(allPlain(tokenize('go', 'x := 1\ny := 2', { maxChars: 100, maxLines: 1, maxRuns: 5000 }))).toBe(true);
    expect(allPlain(tokenize('go', 'x := 1', { maxChars: 100, maxLines: 10, maxRuns: 1 }))).toBe(true);
    expect(allPlain(tokenize('go', 'x := 1', { maxChars: 100, maxLines: 10, maxRuns: 10 }))).toBe(false);
  });
});

// ---------------------------------------------------------------- the DOM

/** A document with what highlight() and toDOM() use and nothing else, and no innerHTML: if either tried it, it would throw. */
function fakeDocument() {
  class Node {
    constructor(tag) {
      this.tag = tag;
      this.attrs = {};
      this.children = [];
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

const textOf = (n) => (n.tag === '#text' ? n.text : (n._text || '') + (n.children || []).map(textOf).join(''));
function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

describe('highlight (the DOM)', () => {
  it('gives null when there is nothing to colour: plain text, an unknown language, a block over the caps', () => {
    const doc = fakeDocument();
    expect(highlight('text', 'x := 1', doc)).toBeNull();
    expect(highlight('', 'just words', doc)).toBeNull();
    expect(highlight('rust', 'fn main() {}', doc)).toBeNull();
    expect(highlight('go', '', doc)).toBeNull();
  });

  it('builds text nodes and spans with a class per kind, and the same text', () => {
    const doc = fakeDocument();
    const frag = highlight('go', GO, doc);
    expect(textOf(frag)).toBe(GO);
    let spans = 0;
    const classes = new Set();
    walk(frag, (n) => {
      if (n === frag) return;
      expect(['span', '#text']).toContain(n.tag);
      expect(Object.keys(n.attrs || {})).toEqual([]);
      if (n.tag === 'span') {
        spans++;
        classes.add(n.className);
        expect(n.children).toEqual([]);
        expect(n._text).not.toBe('');
      }
    });
    expect(spans).toBeGreaterThan(50);
    for (const name of classes) expect(KINDS.map((k) => `hl-${k}`)).toContain(name);
    expect([...classes]).toContain('hl-keyword');
    expect([...classes]).not.toContain('hl-plain');
  });

  it('keeps the lines apart with "\\n", for a blank line, a trailing newline and a block that is only newlines', () => {
    const doc = fakeDocument();
    for (const text of ['x := 1\n\n\ny := 2\n', '\n\nx := 1', 'x := 1\n', '\n\n\nx := 1\n\n\n']) {
      expect(textOf(highlight('go', text, doc))).toBe(text);
    }
    expect(highlight('go', '\n\n\n', doc)).toBeNull();
  });

  it('joins neighbouring plain text and newlines into one text node: fewer nodes for the browser', () => {
    const doc = fakeDocument();
    const frag = highlight('go', 'a\nb\nc := 1', doc);
    expect(frag.children.filter((n) => n.tag === '#text').length).toBeLessThanOrEqual(2);
  });

  it('puts what the source says about markup into text, never into elements', () => {
    const doc = fakeDocument();
    const hostile = 'x := "<img src=x onerror=alert(1)>" // <script>alert(1)</script>\nfunc f() { return `</code></pre><b>` }';
    const frag = highlight('go', hostile, doc);
    expect(textOf(frag)).toBe(hostile);
    walk(frag, (n) => expect(['#fragment', 'span', '#text']).toContain(n.tag));
  });
});

describe('a fenced block in a reply', () => {
  it('is spans in the code element, with its label and copy button as before, and the text exactly the source', () => {
    const doc = fakeDocument();
    const [block] = toDOM(parse('```go\n' + GO + '\n```'), doc).children;
    const [head, pre] = block.children;
    expect(block.className).toBe('code');
    expect(head.children[0]._text).toBe('go');
    expect(head.children[1].attrs.type).toBe('button');
    expect(textOf(pre)).toBe(GO.replace(/\t/g, '    '));      // the renderer turns tabs into four spaces before it looks at the text
    expect(pre.children[0].children.some((n) => n.tag === 'span' && n.className === 'hl-keyword')).toBe(true);
  });

  it('is a plain text node when the label says text, or the language is not known', () => {
    const doc = fakeDocument();
    for (const label of ['text', 'rust', '']) {
      const [block] = toDOM(parse('```' + label + '\nfn main() { println!("x"); }\n```'), doc).children;
      expect(block.children[1].children[0]._text).toBe('fn main() { println!("x"); }');
      expect(block.children[1].children[0].children).toEqual([]);
      expect(block.children[0].children[0]._text).toBe(label || 'code');
    }
  });

  it('colours a block with no label when what it holds is plainly Go', () => {
    const doc = fakeDocument();
    const [block] = toDOM(parse('```\npackage main\n\nfunc main() {}\n```'), doc).children;
    expect(block.children[1].children[0].children.some((n) => n.tag === 'span')).toBe(true);
    expect(block.children[0].children[0]._text).toBe('code');
  });
});

// ---------------------------------------------------------------- the colours

/** The rules of a stylesheet as { selectors, media, body, order }, with media blocks flattened (and their conditions kept). */
function parseCss(text) {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const block = (src, media) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === '"' || c === "'") {
          const end = src.indexOf(c, j + 1);
          j = end < 0 ? src.length : end;
        } else if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (/^@media\b/i.test(head)) block(body, [...media, head.replace(/^@media\s*/i, '')]);
      else if (!head.startsWith('@')) rules.push({ selectors: head.split(',').map((s) => s.trim()), media, body, order: rules.length });
      i = j;
    }
  };
  block(css, []);
  return rules;
}

/** :root is one level of specificity, :root[data-theme="x"] two; any other selector says nothing about the theme. */
function specificity(selector, env) {
  const m = /^:root(?:\[data-theme="(\w+)"\])?$/.exec(selector);
  if (!m) return 0;
  if (m[1] && m[1] !== env.theme) return 0;
  return m[1] ? 2 : 1;
}

function mediaHolds(query, env) {
  return query.split(/\s+and\s+/i).every((part) => {
    const m = /^\(\s*([\w-]+)\s*:\s*([\w-]+)\s*\)$/.exec(part.trim());
    if (!m) return false;
    if (m[1] === 'prefers-color-scheme') return m[2] === env.scheme;
    if (m[1] === 'prefers-contrast') return m[2] === env.contrast;
    return false;                                       // a width, a pointer: not part of this question
  });
}

/** The custom properties of :root as the cascade leaves them: by specificity, then by where they are in the file. */
function variablesFor(rules, env) {
  const hits = [];
  for (const rule of rules) {
    if (!rule.media.every((q) => mediaHolds(q, env))) continue;
    for (const selector of rule.selectors) {
      const spec = specificity(selector, env);
      if (spec) hits.push({ spec, order: rule.order, body: rule.body });
    }
  }
  hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const vars = {};
  for (const hit of hits) for (const m of hit.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

function luminance(hex) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const channel = (offset) => {
    const v = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('the colours', () => {
  const highlightRules = parseCss(read('highlight.css'));
  const styleRules = parseCss(read('style.css'));
  const COLOURED = KINDS.filter((k) => k !== 'plain');
  const ENVS = [];
  for (const theme of ['auto', 'light', 'dark']) for (const scheme of ['light', 'dark']) for (const contrastPref of ['no-preference', 'more']) ENVS.push({ theme, scheme, contrast: contrastPref });
  const isDark = (env) => env.theme === 'dark' || (env.theme === 'auto' && env.scheme === 'dark');
  const label = (env) => `data-theme=${env.theme}, system ${env.scheme}, contrast ${env.contrast}`;

  it('reads the background of a code block and the text colour from style.css, in every theme', () => {
    for (const env of ENVS) {
      const vars = variablesFor(styleRules, env);
      expect(vars['--code-bg'], label(env)).toMatch(/^#[0-9a-f]{6}$/i);
      expect(vars['--text'], label(env)).toMatch(/^#[0-9a-f]{6}$/i);
      // the page's own rule: a block is drawn on --code-bg, and what it holds is drawn in --text
      expect(luminance(vars['--code-bg']) < 0.3, label(env)).toBe(isDark(env));
    }
    expect(styleRules.some((r) => /\.md \.code\b/.test(r.selectors.join()) && /background:\s*var\(--code-bg\)/.test(r.body))).toBe(true);
  });

  it.each(ENVS.map((env) => [label(env), env]))('every colour reads on the block: %s', (_name, env) => {
    const background = variablesFor(styleRules, env)['--code-bg'];
    const vars = variablesFor(highlightRules, env);
    const needed = env.contrast === 'more' ? 7 : 4.5;
    for (const kind of COLOURED) {
      const colour = vars[`--hl-${kind}`];
      expect(colour, `--hl-${kind} is defined`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrast(colour, background), `--hl-${kind} ${colour} on ${background}`).toBeGreaterThanOrEqual(needed);
    }
    // what is not coloured is the page's text on the same background
    expect(contrast(variablesFor(styleRules, env)['--text'], background)).toBeGreaterThanOrEqual(needed === 7 ? 4.5 : needed);
  });

  it('gives the dark colours to a dark page and the light ones to a light page, whatever the settings say', () => {
    for (const env of ENVS) {
      const vars = variablesFor(highlightRules, env);
      for (const kind of COLOURED) expect(luminance(vars[`--hl-${kind}`]) > 0.2, `${label(env)} ${kind}`).toBe(isDark(env));
    }
  });

  it('keeps the seven colours that name something different from one another, in every theme', () => {
    for (const env of ENVS) {
      const vars = variablesFor(highlightRules, env);
      const named = ['keyword', 'type', 'string', 'comment', 'number', 'function', 'variable'].map((k) => vars[`--hl-${k}`].toLowerCase());
      expect(new Set(named).size, label(env)).toBe(named.length);
    }
  });

  it('has the same variables in every block (so no theme falls back to another one for a colour)', () => {
    const names = COLOURED.map((k) => `--hl-${k}`).sort();
    const blocks = highlightRules.filter((r) => r.selectors.some((s) => s.startsWith(':root')));
    expect(blocks.length).toBe(6);
    for (const rule of blocks) expect([...rule.body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort(), rule.selectors.join()).toEqual(names);
  });

  it('has a rule for every class the renderer can make, and only var() colours in it', () => {
    const css = read('highlight.css');
    for (const kind of COLOURED) {
      expect(css, kind).toMatch(new RegExp(`\\.code \\.hl-${kind} \\{ color: var\\(--hl-${kind}\\)`));
    }
    expect(css).not.toMatch(/!important/);
    const colourRules = css.split('\n').filter((line) => /^\.code \.hl-\w+ \{/.test(line));
    expect(colourRules).toHaveLength(COLOURED.length);
    for (const line of colourRules) expect(line).not.toMatch(/#[0-9a-f]{3,6}|rgb/i);
  });

  it('falls back to the page colour in forced colors mode, and keeps comments italic', () => {
    const css = read('highlight.css');
    const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css);
    expect(forced).not.toBeNull();
    for (const kind of COLOURED) expect(forced[1]).toContain(`.code .hl-${kind}`);
    expect(forced[1]).toMatch(/color: inherit;/);
    expect(css).toMatch(/\.code \.hl-comment \{[^}]*font-style: italic/);
    // the forced-colors rule comes after the rules it overrides (same specificity: the later one wins)
    expect(css.indexOf('@media (forced-colors: active)')).toBeGreaterThan(css.indexOf('.code .hl-variable'));
  });
});

// ---------------------------------------------------------------- the files that carry it to the page

describe('the page carries it', () => {
  const served = (file, anchor) => {
    const list = new RegExp(`${anchor}\\s*=\\s*\\[([^\\]]*)\\]`).exec(file);
    return list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  };

  it('serves highlight.js and highlight.css (the server and the dev server)', () => {
    const start = read('../../src/portal/start.ts');
    const dev = read('../qa/dev_server.mjs');
    for (const file of ['highlight.js', 'highlight.css']) {
      expect(served(start, 'export const PAGE_FILES'), `start.ts ${file}`).toContain(file);
      expect(served(dev, 'const PAGE_FILES'), `dev_server.mjs ${file}`).toContain(file);
    }
  });

  it('links highlight.css from index.html after style.css, and has markdown.js import highlight.js', () => {
    const html = read('index.html');
    expect(html.indexOf('href="highlight.css"')).toBeGreaterThan(html.indexOf('href="style.css"'));
    expect(read('markdown.js')).toMatch(/import \{ highlight \} from '\.\/highlight\.js';/);
  });
});
