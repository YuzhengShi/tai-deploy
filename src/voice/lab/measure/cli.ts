/**
 * The voice lab's measuring client, on the command line (runs on the host, next to the portal socket):
 *
 *   node dist/voice/lab/measure/cli.js run --socket <portal socket> | --url <ws://host:port> --origin <https origin> --users <users.json>
 *        --secret <portal secret file> --email <allowlisted address> --chain <label> --set <latency|pause|short|filler|bargein|interview|talk|tuning>
 *        --audio <dir of make_audio.ps1> [--path api/voice|api/voice-lab] [--testset <file>] [--runs 3] [--mode chat|interview|talk]
 *        [--out <dir>] [--voice-offset 0] [--gap-ms 4000]
 *   node dist/voice/lab/measure/cli.js interleave <the same connection flags> --a-chain <label> --b-chain <label> [--a-path api/voice] [--b-path api/voice-lab]
 *        (calls alternate A, B, A, B ... in one process; the raw logs go to <out>/<a-chain> and <out>/<b-chain>)
 *   node dist/voice/lab/measure/cli.js analyze --a <dir of chain A's raw logs> --b <dir of chain B's> [--json] [--tuning]
 *
 * It signs a session cookie for the allowlisted address the way the portal does (a fresh one for each call) and plays calls as the owner would.
 * Every call is real: it costs the chain's minutes and counts against that account's daily voice budget. Exit codes: 0 done, 2 usage, 1 anything else.
 * The cookie is never printed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { mintCookie } from '../../smoke-client.js';
import { sleep } from './client.js';
import { analyzeDirs, renderReport } from './analyze.js';
import { runCall, type RunOptions, type RunResult, type RunTiming } from './run.js';
import { AudioLibrary, FROZEN_TESTSET, isLabSet, loadTestSet, modeForSet, planSet, type CallMode, type LabSet } from './scenario.js';

const ROUTES = ['api/voice', 'api/voice-lab'] as const;

export const USAGE = [
  'usage:',
  '  cli run --socket <portal socket> | --url <ws://host:port> --origin <https origin> --users <users.json> --secret <portal secret file> --email <address>',
  '          --chain <label> --set latency|pause|short|filler|bargein|interview|talk|tuning --audio <dir> [--path api/voice|api/voice-lab] [--testset <file>]',
  '          [--runs 3] [--mode chat|interview|talk] [--out <dir>] [--voice-offset 0] [--gap-ms 4000]',
  '  cli interleave <the connection flags of run> --a-chain <label> --b-chain <label> [--a-path api/voice] [--b-path api/voice-lab]',
  '          (A, B, A, B ... in one process; raw logs in <out>/<a-chain> and <out>/<b-chain>)',
  '  cli analyze --a <dir of chain A raw logs> --b <dir of chain B raw logs> [--json] [--tuning]',
  'exit codes: 0 done, 2 usage, 1 anything else',
].join('\n');

class UsageError extends Error {}

interface Parsed {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
}

const COMMON_VALUES = ['socket', 'url', 'origin', 'users', 'secret', 'email', 'audio', 'testset', 'set', 'runs', 'out', 'voice-offset', 'mode', 'gap-ms'];
const ALLOWED: Record<string, { values: string[]; flags: string[] }> = {
  run: { values: [...COMMON_VALUES, 'chain', 'path'], flags: [] },
  interleave: { values: [...COMMON_VALUES, 'a-chain', 'b-chain', 'a-path', 'b-path'], flags: [] },
  analyze: { values: ['a', 'b'], flags: ['json', 'tuning'] },
};

function parse(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const allowed = ALLOWED[command ?? ''];
  if (!allowed) throw new UsageError(command ? `unknown command ${command}` : 'no command');
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (allowed.flags.includes(name)) {
      flags.add(name);
      continue;
    }
    if (!allowed.values.includes(name)) throw new UsageError(`unknown option ${a} for ${command}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${a} needs a value`);
    values.set(name, value);
    i++;
  }
  return { command, values, flags };
}

function need(p: Parsed, name: string): string {
  const v = p.values.get(name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
}

function integer(p: Parsed, name: string, fallback: number, min: number, max: number): number {
  const raw = p.values.get(name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return n;
}

function route(value: string, name: string): string {
  const clean = value.replace(/^\/+/, '');
  if (!(ROUTES as readonly string[]).includes(clean)) throw new UsageError(`--${name} must be api/voice or api/voice-lab`);
  return clean;
}

export interface CliEnv {
  /** shortens the waits of a call (tests) */
  timing?: Partial<RunTiming>;
  /** the silence before the first clip of a scenario, ms (tests; the document says 600) */
  leadMs?: number;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

interface RunConfig {
  socket?: string;
  url?: string;
  origin: string;
  users: string;
  secret: string;
  email: string;
  set: LabSet;
  mode: CallMode;
  runs: number;
  voiceOffset: number;
  gapMs: number;
  audio: string;
  testset: string;
  out: string;
}

/** The testset shipped next to the compiled code: <repo>/eval/voice-lab/testset.json (the same depth from src/ and from dist/). */
function defaultTestset(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../eval/voice-lab/testset.json');
}

function common(p: Parsed): RunConfig {
  const socket = p.values.get('socket');
  const url = p.values.get('url');
  if (!socket && !url) throw new UsageError('--socket (or --url) is required');
  const setName = need(p, 'set');
  if (!isLabSet(setName)) throw new UsageError(`--set must be one of latency, pause, short, filler, bargein, interview, talk, tuning (got ${setName})`);
  const natural = modeForSet(setName);
  const asked = p.values.get('mode');
  if (asked !== undefined && asked !== 'chat' && asked !== 'interview' && asked !== 'talk') throw new UsageError('--mode is chat, interview or talk');
  if (asked !== undefined && asked !== natural) throw new UsageError(`--mode ${asked} contradicts --set ${setName}, which is played in ${natural} mode`);
  return {
    ...(socket ? { socket: path.resolve(socket) } : {}),
    ...(url ? { url } : {}),
    origin: need(p, 'origin'),
    users: need(p, 'users'),
    secret: need(p, 'secret'),
    email: need(p, 'email'),
    set: setName,
    mode: natural,
    runs: integer(p, 'runs', 3, 1, 50),
    voiceOffset: integer(p, 'voice-offset', 0, -1000, 1000),
    gapMs: integer(p, 'gap-ms', 4000, 0, 600_000),
    audio: need(p, 'audio'),
    testset: p.values.get('testset') ?? defaultTestset(),
    out: p.values.get('out') ?? 'lab-runs',
  };
}

const MAX_BUSY_TRIES = 6;

/**
 * One call with the document's repeat rule: a call whose client socket failed is repeated once; the hub's `busy` (this student's previous call is
 * still being saved, or the other chain's) is waited out and tried again, up to a few times. Every attempt's raw log is kept; a repeat names the attempt it
 * repeats (`retryOf`), and the analysis leaves the repeated attempt out. The last attempt is the call's result, whatever it was.
 */
async function callWithRepeat(conf: RunConfig, base: Omit<RunOptions, 'cookie' | 'attempt' | 'retryOf'>, env: CliEnv): Promise<RunResult> {
  let previous: RunResult | null = null;
  let socketRepeated = false;
  let busyTries = 0;
  for (let attempt = 1; ; attempt++) {
    const cookie = mintCookie(conf.users, conf.secret, conf.email, 900);
    const result: RunResult = await runCall({ ...base, cookie, attempt, ...(previous ? { retryOf: previous.callId } : {}) });
    if (result.busy && busyTries < MAX_BUSY_TRIES) {
      busyTries++;
      previous = result;
      await sleep(env.timing ? 200 : 5000);
      continue;
    }
    if (result.socketError && !socketRepeated) {
      socketRepeated = true;
      previous = result;
      await sleep(env.timing ? 200 : 3000);
      continue;
    }
    return result;
  }
}

/** The address must be on the allowlist and the files readable: found before the first call, as a usage error. */
function checkCookie(conf: RunConfig): void {
  try {
    mintCookie(conf.users, conf.secret, conf.email, 60);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function summaryLine(label: string, set: string, run: number, r: RunResult): string {
  const attempt = r.callId.match(/-a(\d+)-/)?.[1] ?? '1';
  const state = r.started ? `${r.played} scenario(s) played, ${r.answered} answered, ended ${r.reason}` : `did not start (${r.reason})`;
  return `[${label}] ${set} run ${run} attempt ${attempt}: ${state}${r.file ? `; log ${r.file}` : ''}`;
}

function loadScenarios(conf: RunConfig, out: (t: string) => void, err: (t: string) => void, leadMs?: number) {
  let loaded;
  try {
    loaded = loadTestSet(conf.testset);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { testset, fingerprint } = loaded;
  const frozen = fingerprint.sha256 === FROZEN_TESTSET.sha256 && fingerprint.blob === FROZEN_TESTSET.blob;
  if (frozen) out(`test set: the frozen one of docs/VOICE_SELFBUILT.md 9.7 (sha256 ${fingerprint.sha256.slice(0, 12)}, blob ${fingerprint.blob.slice(0, 12)})`);
  else err(`WARNING: the test set ${conf.testset} is NOT the frozen one (sha256 ${fingerprint.sha256.slice(0, 12)}, blob ${fingerprint.blob.slice(0, 12)}; frozen ${FROZEN_TESTSET.sha256.slice(0, 12)}, ${FROZEN_TESTSET.blob.slice(0, 12)}): the results are not criterion results`);
  let plans;
  try {
    plans = planSet(testset, conf.set, new AudioLibrary(conf.audio), conf.voiceOffset, leadMs);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return { plans, fingerprint };
}

async function cmdRun(p: Parsed, env: CliEnv, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const conf = common(p);
  const chain = need(p, 'chain');
  const route_ = route(p.values.get('path') ?? 'api/voice', 'path');
  checkCookie(conf);
  const { plans, fingerprint } = loadScenarios(conf, out, err, env.leadMs);
  out(`run: chain ${chain}, route ${route_}, set ${conf.set} (${plans.length} scenarios, mode ${conf.mode}), ${conf.runs} run(s), logs in ${conf.out}`);
  for (let run = 1; run <= conf.runs; run++) {
    const result = await callWithRepeat(conf, { chain, path: route_, mode: conf.mode, set: conf.set, scenarios: plans, run, target: { socket: conf.socket, url: conf.url }, origin: conf.origin, outDir: conf.out, testset: fingerprint, timing: env.timing }, env);
    out(summaryLine(chain, conf.set, run, result));
    if (run < conf.runs) await sleep(conf.gapMs);
  }
  return 0;
}

async function cmdInterleave(p: Parsed, env: CliEnv, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const conf = common(p);
  const chains = [
    { label: need(p, 'a-chain'), route: route(p.values.get('a-path') ?? 'api/voice', 'a-path') },
    { label: need(p, 'b-chain'), route: route(p.values.get('b-path') ?? 'api/voice-lab', 'b-path') },
  ];
  if (chains[0].label === chains[1].label) throw new UsageError('--a-chain and --b-chain must differ');
  checkCookie(conf);
  const { plans, fingerprint } = loadScenarios(conf, out, err, env.leadMs);
  out(`interleave: ${chains[0].label} (${chains[0].route}) and ${chains[1].label} (${chains[1].route}), set ${conf.set} (${plans.length} scenarios, mode ${conf.mode}), ${conf.runs} round(s), logs in ${conf.out}/<chain>`);
  for (let run = 1; run <= conf.runs; run++) {
    for (const chain of chains) {
      const result = await callWithRepeat(conf, { chain: chain.label, path: chain.route, mode: conf.mode, set: conf.set, scenarios: plans, run, target: { socket: conf.socket, url: conf.url }, origin: conf.origin, outDir: path.join(conf.out, chain.label), testset: fingerprint, timing: env.timing }, env);
      out(summaryLine(chain.label, conf.set, run, result));
      await sleep(conf.gapMs);
    }
  }
  return 0;
}

function cmdAnalyze(p: Parsed, out: (t: string) => void): number {
  const a = need(p, 'a');
  const b = need(p, 'b');
  for (const dir of [a, b]) if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`${dir} is not a directory`);
  const report = analyzeDirs(a, b, { tuning: p.flags.has('tuning') });
  out(p.flags.has('json') ? JSON.stringify(report, null, 2) : renderReport(report));
  return 0;
}

/** The CLI. Returns the exit code (0 done, 2 usage, 1 anything else); never throws. */
export async function main(argv: string[], env: CliEnv = {}): Promise<number> {
  const out = env.out ?? ((t: string) => console.log(t));
  const err = env.err ?? ((t: string) => console.error(t));
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    (argv.length === 0 ? err : out)(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  try {
    const parsed = parse(argv);
    if (parsed.command === 'run') return await cmdRun(parsed, env, out, err);
    if (parsed.command === 'interleave') return await cmdInterleave(parsed, env, out, err);
    return cmdAnalyze(parsed, out);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`lab measure: ${e.message}\n${USAGE}`);
      return 2;
    }
    err(`lab measure: ${(e as Error).message}`);
    return 1;
  }
}

const direct = process.argv[1] != null && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (direct) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`lab measure: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
