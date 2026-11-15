/**
 * The voice lab's measuring client, on the command line (runs on the host, next to the portal socket):
 *
 *   node dist/voice/lab/measure/cli.js run --socket <portal socket> | --url <ws://host:port> --origin <https origin> --users <users.json>
 *        --secret <portal secret file> --email <allowlisted address> --chain <label> --set <latency|pause|short|filler|bargein|interview|talk|tuning|tools>
 *        --audio <dir of make_audio.ps1> [--path <route>] [--testset <file>] [--runs 3] [--mode chat|interview|talk]
 *        [--out <dir>] [--voice-offset 0] [--gap-ms 4000]
 *   node dist/voice/lab/measure/cli.js interleave <the same connection flags> --a-chain <label> --b-chain <label> [--a-path <route>] [--b-path <route>]
 *        [--c-chain <label> --c-path <route>] [--d-chain <label> --d-path <route>] [--e-chain <label> --e-path <route>]
 *        (calls rotate A, B, C, D, E (as many as are given) within each round, in one process; the raw logs go to <out>/<label> of each chain)
 *   node dist/voice/lab/measure/cli.js analyze --a <dir of chain A's raw logs> --b <dir of chain B's> [--json] [--tuning]
 *
 * A <route> is `api/voice` (today's call; the default of run's --path and of --a-path) or `api/voice-lab` (the lab; the default of --b-path), optionally followed by `?chain=d|h|fd|c|cf`
 * (the lab's chain of that call, docs A10) and nothing else: any other query, a fragment or any other path is refused before a call is made.
 * The `tools` set exists only in a test set that has a `tools` list (eval/voice-lab/testset2.json).
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
import { AudioLibrary, FROZEN_TESTSET, isLabSet, LAB_SETS, loadTestSet, modeForSet, planSet, type CallMode, type LabSet } from './scenario.js';

/**
 * The chains a lab call can be asked for with `?chain=` (docs A10): the same five names as src/voice/lab/config.ts (a test pins that they agree). They are pinned here, not imported, so that
 * what this client will ask for does not move with the server's code.
 */
export const LAB_CHAINS = ['d', 'h', 'fd', 'c', 'cf'] as const;
/**
 * A route as the flags take it: the live route as it is, or the lab's with at most `?chain=<name>`. No other query, no fragment, nothing after it (anchored at both ends). The live route takes no
 * chain: the hub ignores a query there, so a chain asked for on it would be a live call under another chain's label.
 */
const ROUTE_PATTERN = new RegExp(`^(?:api/voice|api/voice-lab(?:\\?chain=(?:${LAB_CHAINS.join('|')}))?)$`);
/** The chains of `interleave`, in the order a round plays them: A and B are required (live and lab by default), C to E are optional. */
const SLOTS = ['a', 'b', 'c', 'd', 'e'] as const;
const DEFAULT_ROUTE = { a: 'api/voice', b: 'api/voice-lab' } as const;

export const USAGE = [
  'usage:',
  '  cli run --socket <portal socket> | --url <ws://host:port> --origin <https origin> --users <users.json> --secret <portal secret file> --email <address>',
  `          --chain <label> --set ${LAB_SETS.join('|')} --audio <dir> [--path <route>] [--testset <file>]`,
  '          [--runs 3] [--mode chat|interview|talk] [--out <dir>] [--voice-offset 0] [--gap-ms 4000]',
  '  cli interleave <the connection flags of run> --a-chain <label> --b-chain <label> [--a-path <route>] [--b-path <route>]',
  '          [--c-chain <label> --c-path <route>] [--d-chain <label> --d-path <route>] [--e-chain <label> --e-path <route>]',
  '          (calls rotate A, B, C, D, E (as many as are given) within each round; a chain from C on needs both its flags;',
  '          labels must differ; raw logs in <out>/<label> of each chain)',
  '  cli analyze --a <dir of chain A raw logs> --b <dir of chain B raw logs> [--json] [--tuning]',
  `  <route>: api/voice (default of run's --path and of --a-path) or api/voice-lab (default of --b-path), optionally followed by ?chain=${LAB_CHAINS.join('|')} and nothing else`,
  '  --set tools needs a test set that has a `tools` list (eval/voice-lab/testset2.json)',
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
  interleave: { values: [...COMMON_VALUES, ...SLOTS.flatMap((s) => [`${s}-chain`, `${s}-path`])], flags: [] },
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

/**
 * A route flag's value: `api/voice` or `api/voice-lab` (leading slashes dropped, as before), then at most `?chain=d|h|fd|c|cf`. Whatever else is in it (another query or an extra parameter, a fragment, a
 * path beyond the route, an unknown chain, a space or a line end) is refused, so that nothing a call is made on can be anything but the two routes with a documented chain.
 */
export function route(value: string, name: string): string {
  const clean = value.replace(/^\/+/, '');
  if (!ROUTE_PATTERN.test(clean)) throw new UsageError(`--${name} must be api/voice or api/voice-lab, optionally followed by ?chain=${LAB_CHAINS.join('|')} and nothing else`);
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
  if (!isLabSet(setName)) throw new UsageError(`--set must be one of ${LAB_SETS.join(', ')} (got ${setName})`);
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
  else {
    // a different test set (round 2's, say) is not an error: the run goes on, says so on both streams with the whole fingerprint (a driver may keep only one of them), and every raw log's header carries it
    out(`test set: ${conf.testset} is not the frozen round-1 set of docs/VOICE_SELFBUILT.md 9.7 (version ${testset.version}): sha256 ${fingerprint.sha256}, blob ${fingerprint.blob}`);
    err(
      `WARNING: the test set ${conf.testset} is NOT the frozen one (the frozen round-1 set is sha256 ${FROZEN_TESTSET.sha256.slice(0, 12)}, blob ${FROZEN_TESTSET.blob.slice(0, 12)}; this one is sha256 ${fingerprint.sha256}, blob ${fingerprint.blob}): its results are not round-1 results`,
    );
  }
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

interface InterleaveChain {
  /** a, b, c, d or e: the flags it was given by and its place in a round */
  slot: (typeof SLOTS)[number];
  label: string;
  route: string;
}

/**
 * The chains of an `interleave`, in the order of a round. A and B are required, with the live route and the lab route as their defaults; C, D and E are optional and a chain given needs both its flags
 * (`--c-chain` and `--c-path`), with no gap (D needs C: the order of a round is the order of the letters). The labels are folder names under `--out`, so two that differ only in case are one
 * folder on some systems: they must differ as written and as lower case.
 */
function interleaveChains(p: Parsed): InterleaveChain[] {
  const chains: InterleaveChain[] = [];
  let gap: (typeof SLOTS)[number] | null = null;
  for (const slot of SLOTS) {
    const label = p.values.get(`${slot}-chain`);
    const given = p.values.get(`${slot}-path`);
    if (slot === 'a' || slot === 'b') {
      chains.push({ slot, label: need(p, `${slot}-chain`), route: route(given ?? DEFAULT_ROUTE[slot], `${slot}-path`) });
      continue;
    }
    if (label === undefined && given === undefined) {
      if (gap === null) gap = slot;
      continue;
    }
    if (label === undefined) throw new UsageError(`--${slot}-path needs --${slot}-chain (a chain given needs both its flags)`);
    if (given === undefined) throw new UsageError(`--${slot}-chain needs --${slot}-path (a chain given needs both its flags)`);
    if (gap !== null) throw new UsageError(`--${slot}-chain is given without --${gap}-chain: the chains are A, B, C, D, E in that order, with no gap`);
    chains.push({ slot, label, route: route(given, `${slot}-path`) });
  }
  for (let i = 0; i < chains.length; i++) {
    for (let j = i + 1; j < chains.length; j++) {
      const x = chains[i];
      const y = chains[j];
      if (x.label.toLowerCase() === y.label.toLowerCase()) throw new UsageError(`--${x.slot}-chain and --${y.slot}-chain must differ${x.label === y.label ? '' : ' (the labels are folder names: they must not differ only in case)'}`);
    }
  }
  return chains;
}

/** "L (api/voice) and D (api/voice-lab)", or "A (x), B (y) and C (z)": the chains of an interleave as one phrase. */
function describeChains(chains: InterleaveChain[]): string {
  const parts = chains.map((c) => `${c.label} (${c.route})`);
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

async function cmdInterleave(p: Parsed, env: CliEnv, out: (t: string) => void, err: (t: string) => void): Promise<number> {
  const conf = common(p);
  const chains = interleaveChains(p);
  checkCookie(conf);
  const { plans, fingerprint } = loadScenarios(conf, out, err, env.leadMs);
  out(`interleave: ${describeChains(chains)}, set ${conf.set} (${plans.length} scenarios, mode ${conf.mode}), ${conf.runs} round(s), logs in ${conf.out}/<chain>`);
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
