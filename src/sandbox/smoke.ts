/**
 * The Go sandbox against the REAL image and real Docker (docs/GO_SANDBOX.md "Checks"): `node dist/sandbox/smoke.js` (on the host: `tai_live.sh sandbox smoke`). It builds a real
 * `createSandbox` over a temporary directory (and an in-memory rate store), runs the catalogue of ordinary and hostile programs and archives, prints PASS or FAIL with what was
 * expected for each, and exits 0 only when all passed. At the end nothing of the sandbox may be left: no container, no run directory, and a canary file beside them untouched.
 *
 *   node dist/sandbox/smoke.js [--dir DIR] [--only TEXT] [--keep] [--image NAME]
 *
 * The hostile cases run one after the other under their own limits (a core of CPU each); the queue case runs sleeping programs, not spinning ones. It takes several minutes: every
 * container start costs what Docker costs on the machine, and a program that loops is let to run to its wall clock.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDockerClient, CONTAINER_PREFIX, SANDBOX_IMAGE } from './docker.js';
import { createMemoryRates } from './rates.js';
import { createSandbox } from './runner.js';
import { tarGz } from './tar.js';
import type { TarEntry } from './tar.js';
import { SANDBOX_BUSY, SANDBOX_LIMITS, parseSandboxRequest } from './types.js';
import type { SandboxResult } from './types.js';

interface Verdict {
  pass: boolean;
  expected: string;
  got?: string;
}
interface Case {
  name: string;
  run: () => Promise<Verdict>;
}

const arg = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at !== -1 ? process.argv[at + 1] : undefined;
};
const dir = path.resolve(arg('--dir') ?? path.join(os.tmpdir(), `sbx-smoke-${randomBytes(4).toString('hex')}`));
const only = arg('--only');
const keep = process.argv.includes('--keep');
const image = arg('--image') ?? SANDBOX_IMAGE;
/** The warm list's web module (Gin and testify, as `go mod tidy` makes a project with only them): the go.mod of the Gin cases, so that they run at the versions the image's cache holds. */
const WARM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/cs6650/sandbox/warm');
const WARM_WEB = path.join(WARM_DIR, 'web', 'go.mod');

const SECRET = `smoke-secret-${randomBytes(6).toString('hex')}`;
process.env.SANDBOX_SMOKE_SECRET = SECRET; // in this process's environment: it must never be in a container's
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const CANARY = path.join(dir, 'canary.txt');
const CANARY_TEXT = `canary-${randomBytes(6).toString('hex')}`;
fs.writeFileSync(CANARY, CANARY_TEXT);

const docker = createDockerClient();
const rates = createMemoryRates();
const log = { info: () => undefined, warn: (f: Record<string, unknown>, m: string) => console.log(`  [warn] ${m} ${JSON.stringify(f).slice(0, 200)}`), debug: () => undefined };
const sandbox = createSandbox({ dir, uploadsDir: (folder) => path.join(dir, 'groups', folder, 'uploads'), rates, log, docker, image });

let counter = 0;
const nextFolder = (): string => `smoke${++counter}`;
const gomod = (extra = ''): string => `module smoke\n\ngo 1.21\n${extra}`;

function req(raw: Record<string, unknown>) {
  const parsed = parseSandboxRequest(raw);
  if (!parsed.ok) throw new Error(`the smoke's own request was refused: ${parsed.message}`);
  return parsed.value;
}
const goFiles = (main: string, extra: Record<string, string> = {}) => [{ path: 'main.go', content: main }, ...Object.entries(extra).map(([p, content]) => ({ path: p, content }))];
const runGo = (main: string, over: Record<string, unknown> = {}, extra: Record<string, string> = {}): Promise<SandboxResult> =>
  sandbox.run({ folder: nextFolder() }, req({ action: 'run', files: goFiles(main, extra), ...over }));
const testGo = (testSource: string, over: Record<string, unknown> = {}): Promise<SandboxResult> =>
  sandbox.run({ folder: nextFolder() }, req({ action: 'test', files: [{ path: 'a_test.go', content: testSource }], ...over }));
const show = (r: SandboxResult): string =>
  `ok=${r.ok} exit=${r.exitCode} timedOut=${r.timedOut} truncated=${r.outputTruncated} phase=${r.phase ?? '-'} ${r.message ? `message=${JSON.stringify(r.message.slice(0, 90))} ` : ''}output=${JSON.stringify(r.output.slice(0, 160))}`;
const seconds = (r: SandboxResult): number => Math.round(r.durationMs / 100) / 10;

/** An archive the student "attached": written to the uploads folder of a fresh student, and run. */
async function runArchive(entries: TarEntry[] | Buffer, action: 'run' | 'test' = 'run', pkg = '.'): Promise<{ r: SandboxResult; ms: number }> {
  const folder = nextFolder();
  const uploads = path.join(dir, 'groups', folder, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, 'project.tgz'), Buffer.isBuffer(entries) ? entries : tarGz(entries));
  const began = Date.now();
  const r = await sandbox.run({ folder }, req({ action, upload: 'project.tgz', pkg }));
  return { r, ms: Date.now() - began };
}
const helloModule = (text: string): TarEntry[] => [
  { name: 'proj/go.mod', data: gomod() },
  { name: 'proj/main.go', data: `package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("${text}") }\n` },
];
/** The go.mod of a Gin project at the warm list's versions (the warm web module's, renamed), or null when this tree does not have the warm list. */
function ginGoMod(name: string, warm = 'web'): string | null {
  try {
    return fs.readFileSync(path.join(WARM_DIR, warm, 'go.mod'), 'utf8').replace(/^module .*$/m, `module ${name}`);
  } catch {
    return null;
  }
}
/** The module cache of a smoke starts empty and a container start can cost 10 s or more: the first try of a project with dependencies may spend the minute (the download, the guard); the second finds what the first fetched. */
async function retryColdCache(attempt: () => Promise<SandboxResult>): Promise<SandboxResult> {
  const first = await attempt();
  return !first.ok && (first.phase === 'modules' || /too little of the minute|took too long to answer/.test(first.message ?? '')) ? attempt() : first;
}
const canaryIntact = (): boolean => fs.readFileSync(CANARY, 'utf8') === CANARY_TEXT;
const noStray = (...names: string[]): boolean => names.every((n) => !fs.existsSync(n));

const HELLO = 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hello from the sandbox") }\n';
const PASSING_TEST = 'package smoke\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if 1+1 != 2 { t.Fatal("no") } }\n';
const FAILING_TEST = 'package smoke\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if 1+1 != 3 { t.Fatal("one plus one is not three") } }\n';
const RACY_TEST = 'package smoke\n\nimport (\n\t"sync"\n\t"testing"\n)\n\nfunc TestRace(t *testing.T) {\n\tvar wg sync.WaitGroup\n\tn := 0\n\tfor i := 0; i < 20; i++ {\n\t\twg.Add(1)\n\t\tgo func() { defer wg.Done(); n++ }()\n\t}\n\twg.Wait()\n\tt.Log(n)\n}\n';

const cases: Case[] = [
  {
    name: 'hello world',
    run: async () => {
      const r = await runGo(HELLO);
      return { pass: r.ok && r.exitCode === 0 && r.output.includes('hello from the sandbox'), expected: 'ok, exit 0, prints the greeting', got: show(r) };
    },
  },
  {
    name: 'a test that passes',
    run: async () => {
      const r = await testGo(PASSING_TEST);
      return { pass: r.ok && r.exitCode === 0 && /^ok\s/m.test(r.output), expected: 'ok, exit 0, "ok  ..."', got: show(r) };
    },
  },
  {
    name: 'a test that fails',
    run: async () => {
      const r = await testGo(FAILING_TEST);
      return { pass: r.ok && r.exitCode === 1 && r.output.includes('FAIL') && r.output.includes('one plus one is not three'), expected: 'ok (it ran), exit 1, FAIL and the message', got: show(r) };
    },
  },
  {
    name: '-race finds a race',
    run: async () => {
      const r = await testGo(RACY_TEST, { race: true });
      return { pass: r.ok && r.exitCode !== 0 && r.output.includes('DATA RACE'), expected: 'ok, a failing exit, "DATA RACE" in the output', got: show(r) };
    },
  },
  {
    name: 'a loop that never ends is killed at the wall clock',
    run: async () => {
      const r = await runGo('package main\n\nfunc main() {\n\tfor {\n\t}\n}\n');
      return { pass: r.ok && r.timedOut && r.exitCode === null && r.durationMs >= 15_000 && r.durationMs < 45_000, expected: `ok, timed out, no exit code, after about ${SANDBOX_LIMITS.runWallMs / 1000} s`, got: `${show(r)} (${seconds(r)} s)` };
    },
  },
  {
    name: 'an allocation without end is OOM-killed and reported, and the host stays up',
    run: async () => {
      const r = await runGo('package main\n\nimport "fmt"\n\nfunc main() {\n\tvar keep [][]byte\n\tfor i := 0; ; i++ {\n\t\tb := make([]byte, 8<<20)\n\t\tfor j := range b {\n\t\t\tb[j] = 1\n\t\t}\n\t\tkeep = append(keep, b)\n\t\tfmt.Println("allocated", len(keep)*8, "MB")\n\t}\n}\n');
      return { pass: r.ok && !r.timedOut && /ran out of memory \(512 MB\)/.test(r.message ?? '') && /allocated \d+ MB/.test(r.output), expected: 'ok, not a timeout, the message "ran out of memory (512 MB)", the output so far', got: show(r) };
    },
  },
  {
    name: 'a fork bomb is stopped by the process limit',
    run: async () => {
      const r = await runGo(
        'package main\n\nimport (\n\t"fmt"\n\t"os"\n\t"os/exec"\n\t"time"\n)\n\nfunc main() {\n\tif os.Getenv("CHILD") == "1" {\n\t\ttime.Sleep(30 * time.Second)\n\t\treturn\n\t}\n\tn := 0\n\tfor i := 0; i < 2000; i++ {\n\t\tc := exec.Command(os.Args[0])\n\t\tc.Env = append(os.Environ(), "CHILD=1")\n\t\tif err := c.Start(); err != nil {\n\t\t\tfmt.Println("started", n, "then:", err)\n\t\t\treturn\n\t\t}\n\t\tn++\n\t}\n\tfmt.Println("started", n, "and was not stopped")\n}\n',
      );
      const m = /started (\d+) then: .*(temporarily unavailable|resource)/.exec(r.output);
      return { pass: r.ok && m !== null && Number(m[1]) <= SANDBOX_LIMITS.pids, expected: `ok, "started N then: ... resource temporarily unavailable" with N at most ${SANDBOX_LIMITS.pids}`, got: show(r) };
    },
  },
  {
    name: 'endless output is cut at the cap and the container is stopped early',
    run: async () => {
      const r = await runGo('package main\n\nimport (\n\t"fmt"\n\t"strings"\n)\n\nfunc main() {\n\tline := strings.Repeat("x", 99)\n\tfor {\n\t\tfmt.Println(line)\n\t}\n}\n');
      return {
        pass: r.ok && r.outputTruncated && !r.timedOut && Buffer.byteLength(r.output) <= SANDBOX_LIMITS.outputBytes + 100 && /far more than can be shown/.test(r.message ?? ''),
        expected: `ok, output cut (at most ${SANDBOX_LIMITS.outputBytes} bytes kept), not a timeout, stopped for printing too much`,
        got: `${show(r)} (${Buffer.byteLength(r.output)} bytes, ${seconds(r)} s)`,
      };
    },
  },
  {
    name: 'the program tries the network and finds no route',
    run: async () => {
      const r = await runGo(
        'package main\n\nimport (\n\t"fmt"\n\t"net"\n\t"net/http"\n\t"time"\n)\n\nfunc main() {\n\t_, err := net.DialTimeout("tcp", "1.1.1.1:53", 3*time.Second)\n\tfmt.Println("dial:", err)\n\tc := http.Client{Timeout: 4 * time.Second}\n\t_, err = c.Get("http://example.com/")\n\tfmt.Println("get:", err)\n}\n',
      );
      return { pass: r.ok && /dial: .*(unreachable|no route)/i.test(r.output) && /get: /.test(r.output) && !/get: <nil>/.test(r.output), expected: '"dial: ... network is unreachable" and a failed GET', got: show(r) };
    },
  },
  {
    name: '/proc/1/environ and /proc/self/environ hold nothing of the host',
    run: async () => {
      const r = await runGo(
        'package main\n\nimport (\n\t"fmt"\n\t"os"\n\t"strings"\n)\n\nfunc main() {\n\tfor _, f := range []string{"/proc/1/environ", "/proc/self/environ"} {\n\t\tb, err := os.ReadFile(f)\n\t\tfmt.Println(f, err, "::", strings.ReplaceAll(string(b), "\\x00", " | "))\n\t}\n}\n',
      );
      const host = [SECRET, process.env.HOME ?? '', process.env.USER ?? ''].filter((x) => x.length > 3);
      const leaked = host.filter((h) => r.output.includes(h));
      return { pass: r.ok && r.output.includes('GOPROXY=off') && leaked.length === 0 && !/AWS_|TOKEN|KEY=|PASSWORD/.test(r.output), expected: 'the fixed environment (GOPROXY=off ...) and nothing from this process: no secret, no HOME, no token', got: leaked.length ? `LEAKED ${leaked.length} host value(s): ${show(r)}` : show(r) };
    },
  },
  {
    name: 'listing / shows the image, not the host',
    run: async () => {
      const r = await runGo(
        'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfor _, d := range []string{"/", "/in", "/gomodcache"} {\n\t\tes, err := os.ReadDir(d)\n\t\tfmt.Print(d, " err=", err, ":")\n\t\tfor _, e := range es {\n\t\t\tfmt.Print(" ", e.Name())\n\t\t}\n\t\tfmt.Println()\n\t}\n\t_, err := os.Stat("/var/run/docker.sock")\n\tfmt.Println("docker.sock:", err)\n}\n',
      );
      const base = path.basename(dir);
      return { pass: r.ok && r.output.includes('docker.sock: stat /var/run/docker.sock: no such file or directory') && !r.output.includes(base) && !r.output.includes('tai-live') && !r.output.includes('canary'), expected: 'no docker socket, no name of a host directory, no canary', got: show(r) };
    },
  },
  {
    name: 'writing to / is refused (read-only root)',
    run: async () => {
      const r = await runGo('package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfmt.Println("write /x:", os.WriteFile("/x", []byte("x"), 0o644))\n\tfmt.Println("write /usr/local/bin/x:", os.WriteFile("/usr/local/bin/x", []byte("x"), 0o755))\n}\n');
      return { pass: r.ok && (r.output.match(/read-only file system|permission denied/g) ?? []).length === 2, expected: 'both writes fail (read-only file system)', got: show(r) };
    },
  },
  {
    name: 'writing more than the memory-backed disk holds fails with "no space left"',
    run: async () => {
      const r = await runGo(
        'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tbuf := make([]byte, 1<<20)\n\tfor f := 0; f < 12; f++ {\n\t\tfh, err := os.Create(fmt.Sprintf("/work/big%d", f))\n\t\tif err != nil {\n\t\t\tfmt.Println("create:", err)\n\t\t\treturn\n\t\t}\n\t\tfor i := 0; i < 40; i++ {\n\t\t\tif _, err := fh.Write(buf); err != nil {\n\t\t\t\tfmt.Println("write after", f*40+i, "MB:", err)\n\t\t\t\treturn\n\t\t\t}\n\t\t}\n\t\tfh.Close()\n\t}\n\tfmt.Println("wrote it all")\n}\n',
      );
      return { pass: r.ok && /no space left on device/.test(r.output) && !r.timedOut, expected: 'ok, "write after N MB: ... no space left on device"', got: show(r) };
    },
  },
  {
    name: 'an inline go.mod that needs a module (downloaded with network, then run without)',
    run: async () => {
      const r = await retryColdCache(() =>
        sandbox.run(
          { folder: nextFolder() },
          req({
            action: 'run',
            files: goFiles('package main\n\nimport (\n\t"fmt"\n\n\t"github.com/google/uuid"\n)\n\nfunc main() { fmt.Println("uuid length", len(uuid.New().String())) }\n', { 'go.mod': gomod('\nrequire github.com/google/uuid v1.6.0\n') }),
          }),
        ),
      );
      return { pass: r.ok && r.exitCode === 0 && r.output.includes('uuid length 36'), expected: 'ok, exit 0, "uuid length 36" (the run container has no network: the module came from the cache)', got: show(r) };
    },
  },
  {
    name: 'a Gin handler tested with httptest and testify, inside the limits (the image holds Gin compiled)',
    run: async () => {
      const mod = ginGoMod('ginsmoke');
      if (mod === null) return { pass: false, expected: 'the warm list in this tree', got: `${WARM_WEB} is not there` };
      const router = 'package ginsmoke\n\nimport "github.com/gin-gonic/gin"\n\nfunc Router() *gin.Engine {\n\tgin.SetMode(gin.TestMode)\n\tr := gin.New()\n\tr.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })\n\treturn r\n}\n';
      const test = 'package ginsmoke\n\nimport (\n\t"net/http"\n\t"net/http/httptest"\n\t"testing"\n\n\t"github.com/stretchr/testify/assert"\n)\n\nfunc TestPing(t *testing.T) {\n\tw := httptest.NewRecorder()\n\treq, _ := http.NewRequest("GET", "/ping", nil)\n\tRouter().ServeHTTP(w, req)\n\tassert.Equal(t, 200, w.Code)\n\tassert.Equal(t, "pong", w.Body.String())\n}\n';
      const r = await retryColdCache(() => sandbox.run({ folder: nextFolder() }, req({ action: 'test', files: [{ path: 'go.mod', content: mod }, { path: 'router.go', content: router }, { path: 'router_test.go', content: test }] })));
      return {
        pass: r.ok && r.exitCode === 0 && /^ok\s/m.test(r.output) && !r.timedOut && r.durationMs < SANDBOX_LIMITS.testWallMs && !/memory/.test(r.message ?? ''),
        expected: `ok, exit 0, "ok ..." within ${SANDBOX_LIMITS.testWallMs / 1000} s and ${SANDBOX_LIMITS.memoryMb} MB (cold, Gin and its dependencies need about 1.4 GB: they must come from the image)`,
        got: `${show(r)} (${seconds(r)} s)`,
      };
    },
  },
  {
    name: 'a Gin v1.11.0 project (its own dependency versions) tested with -race, inside the limits (the image holds that Gin compiled too)',
    run: async () => {
      const mod = ginGoMod('ginsmoke111', 'web-gin1110');
      if (mod === null) return { pass: false, expected: 'the warm list in this tree', got: 'warm/web-gin1110 is not there' };
      const router = 'package ginsmoke111\n\nimport "github.com/gin-gonic/gin"\n\nfunc Router() *gin.Engine {\n\tgin.SetMode(gin.TestMode)\n\tr := gin.New()\n\tr.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })\n\treturn r\n}\n';
      const test = 'package ginsmoke111\n\nimport (\n\t"net/http"\n\t"net/http/httptest"\n\t"testing"\n\n\t"github.com/stretchr/testify/assert"\n)\n\nfunc TestPing(t *testing.T) {\n\tw := httptest.NewRecorder()\n\treq, _ := http.NewRequest("GET", "/ping", nil)\n\tRouter().ServeHTTP(w, req)\n\tassert.Equal(t, 200, w.Code)\n\tassert.Equal(t, "pong", w.Body.String())\n}\n';
      const r = await retryColdCache(() => sandbox.run({ folder: nextFolder() }, req({ action: 'test', race: true, files: [{ path: 'go.mod', content: mod }, { path: 'router.go', content: router }, { path: 'router_test.go', content: test }] })));
      return {
        pass: r.ok && r.exitCode === 0 && /^ok\s/m.test(r.output) && !r.timedOut && r.durationMs < SANDBOX_LIMITS.testWallMs && !/memory/.test(r.message ?? ''),
        expected: `ok, exit 0, "ok ..." within ${SANDBOX_LIMITS.testWallMs / 1000} s and ${SANDBOX_LIMITS.memoryMb} MB (cold, Gin and its dependencies need about 1.4 GB: they must come from the image)`,
        got: `${show(r)} (${seconds(r)} s)`,
      };
    },
  },
  {
    name: 'a Gin app run with go run serves one request to itself and exits, inside the limits',
    run: async () => {
      const mod = ginGoMod('ginrun');
      if (mod === null) return { pass: false, expected: 'the warm list in this tree', got: `${WARM_WEB} is not there` };
      const main =
        'package main\n\nimport (\n\t"fmt"\n\t"io"\n\t"net/http"\n\t"net/http/httptest"\n\n\t"github.com/gin-gonic/gin"\n)\n\nfunc main() {\n\tgin.SetMode(gin.TestMode)\n\tr := gin.New()\n\tr.GET("/ping", func(c *gin.Context) { c.String(200, "pong") })\n\tsrv := httptest.NewServer(r)\n\tdefer srv.Close()\n\tres, err := http.Get(srv.URL + "/ping")\n\tif err != nil {\n\t\tfmt.Println("error:", err)\n\t\treturn\n\t}\n\tdefer res.Body.Close()\n\tbody, _ := io.ReadAll(res.Body)\n\tfmt.Println("status", res.StatusCode, "body", string(body))\n}\n';
      const r = await retryColdCache(() => sandbox.run({ folder: nextFolder() }, req({ action: 'run', files: [{ path: 'go.mod', content: mod }, { path: 'main.go', content: main }] })));
      return {
        pass: r.ok && r.exitCode === 0 && r.output.includes('status 200 body pong') && !r.timedOut && r.durationMs < SANDBOX_LIMITS.runWallMs && !/memory/.test(r.message ?? ''),
        expected: `ok, exit 0, "status 200 body pong" within ${SANDBOX_LIMITS.runWallMs / 1000} s and ${SANDBOX_LIMITS.memoryMb} MB`,
        got: `${show(r)} (${seconds(r)} s)`,
      };
    },
  },
  {
    name: 'an attached archive runs (the control for the hostile ones)',
    run: async () => {
      const { r } = await runArchive(helloModule('from an archive'));
      return { pass: r.ok && r.exitCode === 0 && r.output.includes('from an archive'), expected: 'ok, exit 0, "from an archive"', got: show(r) };
    },
  },
  {
    name: 'an archive with a ../ member is contained',
    run: async () => {
      const { r, ms } = await runArchive([...helloModule('x'), { name: '../escape.txt', data: 'out' }, { name: '../../../escape2.txt', data: 'out' }]);
      return { pass: ms < 45_000 && canaryIntact() && noStray(path.join(dir, 'escape.txt'), path.join(path.dirname(dir), 'escape.txt'), path.join(dir, 'escape2.txt')), expected: 'it ends within its limits and nothing is written outside (checked on the host)', got: `${ms} ms ${show(r)}` };
    },
  },
  {
    name: 'an archive with an absolute path is contained',
    run: async () => {
      const abs = `/tmp/smoke-abs-${randomBytes(4).toString('hex')}`;
      const { r, ms } = await runArchive([...helloModule('x'), { name: abs, data: 'out' }]);
      return { pass: ms < 45_000 && canaryIntact() && !fs.existsSync(abs), expected: `it ends within its limits and ${abs} does not exist on the host`, got: `${ms} ms ${show(r)}` };
    },
  },
  {
    name: 'an archive with a symlink pointing out is contained',
    run: async () => {
      const { r, ms } = await runArchive([...helloModule('x'), { name: 'proj/esc', type: 'symlink', linkname: dir }, { name: 'proj/esc/pwned.txt', data: 'through the link' }, { name: 'proj/esc2', type: 'symlink', linkname: '/' },
        // the links that matter: the modules container may write /gomodcache (a directory of the host), and unpacks the archive next to it
        { name: 'proj/cache-abs', type: 'symlink', linkname: '/gomodcache' },
        { name: 'proj/cache-abs/through-abs.txt', data: 'through the link' },
        { name: 'proj/cache-rel', type: 'symlink', linkname: '../../gomodcache' },
        { name: 'proj/cache-rel/through-rel.txt', data: 'through the link' },
      ]);
      const cache = path.join(dir, 'gomodcache');
      return { pass: ms < 45_000 && canaryIntact() && noStray(path.join(dir, 'pwned.txt'), path.join(cache, 'through-abs.txt'), path.join(cache, 'through-rel.txt')), expected: 'it ends within its limits and no file was written through a link, neither on the host nor into the module cache that the first container may write', got: `${ms} ms ${show(r)}` };
    },
  },
  {
    name: 'an archive with a hard link to a host file is contained',
    run: async () => {
      const { r, ms } = await runArchive([...helloModule('x'), { name: 'proj/hl', type: 'hardlink', linkname: CANARY }, { name: 'proj/hl2', type: 'hardlink', linkname: '../../canary.txt' }]);
      return { pass: ms < 45_000 && canaryIntact() && fs.statSync(CANARY).nlink === 1, expected: 'it ends within its limits and the canary is unchanged with one link', got: `${ms} ms ${show(r)}` };
    },
  },
  {
    name: 'an archive that is a bomb (300 MB of zeros in 300 KB) is stopped',
    run: async () => {
      const { r, ms } = await runArchive([...helloModule('x'), { name: 'proj/zeros.bin', data: Buffer.alloc(300 * 1024 * 1024) }]);
      return { pass: ms < 50_000 && canaryIntact() && (!r.ok || r.exitCode !== 0 || r.output.includes('could not be unpacked')), expected: 'it ends within its limits, refused or failed, the host unharmed', got: `${ms} ms ${show(r)}` };
    },
  },
  {
    name: 'an archive of too many files is refused in one line',
    run: async () => {
      const { r } = await runArchive([...helloModule('x'), ...Array.from({ length: 2100 }, (_, i) => ({ name: `proj/many/f${i}.txt`, data: 'x' }))]);
      return { pass: !r.ok && r.phase === 'stage' && /more than 2000 files/.test(r.message ?? ''), expected: 'not run, refused at staging: "the archive has more than 2000 files" (the first container that looks inside says so)', got: show(r) };
    },
  },
  {
    name: 'two runs at once, four waiting, and a seventh is told the sandbox is busy',
    run: async () => {
      const sleeper = 'package main\n\nimport "time"\n\nfunc main() { time.Sleep(2 * time.Second) }\n';
      const began = Date.now();
      const results: Array<Promise<SandboxResult>> = [];
      for (let i = 0; i < 6; i++) results.push(runGo(i < 2 ? sleeper : HELLO));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const seventhAt = Date.now();
      const seventh = await runGo(HELLO);
      const seventhMs = Date.now() - seventhAt;
      const all = await Promise.all(results);
      const odd = all.filter((r) => !r.ok && r.message !== SANDBOX_BUSY);
      const ran = all.filter((r) => r.ok).length;
      return {
        pass: !seventh.ok && seventh.phase === 'busy' && seventhMs < 2000 && ran >= 2 && odd.length === 0,
        expected: 'the seventh is busy at once; at least two ran; each of the others ran or was told busy after waiting up to 15 s (never an error; on a host where a container takes 10 s to start, the queued ones are busy)',
        got: `seventh: ${seventh.phase} after ${seventhMs} ms; ran ${ran} of 6, busy ${all.length - ran - odd.length}, errors ${odd.length}; ${Math.round((Date.now() - began) / 1000)} s`,
      };
    },
  },
];

async function main(): Promise<number> {
  console.log(`go sandbox smoke: image ${image}, directory ${dir}`);
  if (!(await sandbox.ready())) {
    console.log(`FAIL  the image ${image} is not there (tai_live.sh sandbox build)`);
    return 1;
  }
  let failed = 0;
  let ran = 0;
  for (const c of cases) {
    if (only && !c.name.toLowerCase().includes(only.toLowerCase())) continue;
    ran++;
    const began = Date.now();
    let verdict: Verdict;
    try {
      verdict = await c.run();
    } catch (err) {
      verdict = { pass: false, expected: 'no exception', got: (err as Error).message };
    }
    const took = Math.round((Date.now() - began) / 100) / 10;
    if (verdict.pass) console.log(`PASS  ${c.name}  [${took} s]\n      expected: ${verdict.expected}`);
    else {
      failed++;
      console.log(`FAIL  ${c.name}  [${took} s]\n      expected: ${verdict.expected}\n      got:      ${verdict.got ?? '-'}`);
    }
  }

  // nothing of the sandbox is left: no container, no run directory, the canary as it was
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await sandbox.reap();
  const leftovers = (await docker.list()).filter((c) => c.name.startsWith(CONTAINER_PREFIX));
  const dirs = fs.readdirSync(dir).filter((n) => n.startsWith('run-'));
  const clean = leftovers.length === 0 && dirs.length === 0 && canaryIntact();
  if (!only) {
    ran++;
    if (clean) console.log('PASS  nothing is left: no sandbox container, no run directory, the canary untouched\n      expected: no tai-sandbox container, no run-* directory, canary unchanged');
    else {
      failed++;
      console.log(`FAIL  nothing is left\n      expected: no tai-sandbox container, no run-* directory, canary unchanged\n      got:      containers ${JSON.stringify(leftovers.map((c) => c.name))}, directories ${JSON.stringify(dirs)}, canary intact ${canaryIntact()}`);
    }
  }
  console.log(`\n${ran - failed} of ${ran} passed${failed ? `, ${failed} FAILED` : ''}`);
  return failed ? 1 : 0;
}

main()
  .then((code) => {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(code);
  })
  .catch((err) => {
    console.error('the smoke itself failed:', err);
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(2);
  });
