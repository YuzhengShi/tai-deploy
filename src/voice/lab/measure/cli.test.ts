import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { fileURLToPath } from 'url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { parseRawLog, readRawLogs, analyzeLogs, type Report } from './analyze.js';
import { main, USAGE, type CliEnv } from './cli.js';
import { LAB_SETS } from './scenario.js';

// ---------------------------------------------------------------- fixtures: users, secret, a mini test set and its audio

function wavOf(pcm: Buffer): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(pcm.length, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + head.length + pcm.length, 4);
  riff.write('WAVE', 8, 'ascii');
  return Buffer.concat([riff, fmt, head, pcm]);
}

const MINI = {
  version: 1,
  voices: ['Voice A', 'Voice B'],
  recognition: [],
  latency: [{ id: 'l01', text: 'hello there' }],
  turntaking: { tuning: [], eval: [] },
  bargein: { ask: 'tell me', afterFirstAudioMs: 200, tuning: [], eval: [] },
  modes: { interview: { eval: [{ id: 'i-p1', class: 'pause', segments: [{ text: 'explain it' }] }] }, talk: { eval: [] } },
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-lab-cli-'));
const files = { users: path.join(root, 'users.json'), secret: path.join(root, 'secret'), testset: path.join(root, 'testset.json'), audio: path.join(root, 'audio'), emptyAudio: path.join(root, 'empty-audio') };

beforeAll(() => {
  fs.writeFileSync(files.users, JSON.stringify({ users: [{ email: 'owner@example.edu', name: 'Owner' }] }));
  fs.writeFileSync(files.secret, crypto.randomBytes(32).toString('hex'));
  fs.writeFileSync(files.testset, JSON.stringify(MINI));
  fs.mkdirSync(files.audio);
  const manifest: Record<string, string> = {};
  let n = 0;
  for (const voice of MINI.voices) {
    for (const text of ['hello there', 'explain it']) {
      const pcm = Buffer.alloc((1000 + 640 + 1000) * 2);
      for (let i = 0; i < 640; i++) pcm.writeInt16LE(Math.floor(i / 8) % 2 === 0 ? 4000 : -4000, (1000 + i) * 2);
      const name = `c${n++}.wav`;
      fs.writeFileSync(path.join(files.audio, name), wavOf(pcm));
      manifest[`${voice}|${text}`] = name;
    }
  }
  fs.writeFileSync(path.join(files.audio, 'manifest.json'), '﻿' + JSON.stringify(manifest), 'utf8');
  fs.mkdirSync(files.emptyAudio);
  fs.writeFileSync(path.join(files.emptyAudio, 'manifest.json'), '{}');
});

const closers: Array<() => Promise<void>> = [];
const outDirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const d of outDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The CLI with its output collected; the waits of a call and the retry pauses are short. */
async function cli(argv: string[], over: CliEnv = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { timing: { readyTimeoutMs: 1500, greetingWaitMs: 400, greetingEndMs: 1000, answerCapMs: 2000, settleMs: 50, quietCapMs: 1000, closeWaitMs: 600 }, leadMs: 120, ...over, out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// ---------------------------------------------------------------- a small scripted server (see run.test.ts for the long one)

interface Mini {
  url: string;
  paths: string[];
  cookies: string[];
  origins: string[];
  starts: Array<Record<string, unknown>>;
}

/** Hears the microphone and answers on a short fixed rhythm. `behaviors[n]` says what connection n+1 does on `start`: ok, busy (an error event), or drop (the socket is torn down). */
async function miniServer(behaviors: Array<'ok' | 'busy' | 'drop'> = []): Promise<Mini> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const out: Mini = { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, paths: [], cookies: [], origins: [], starts: [] };
  let connections = 0;
  wss.on('connection', (ws: ServerSocket, req) => {
    const behavior = behaviors[connections] ?? 'ok';
    connections++;
    out.paths.push(String(req.url));
    out.cookies.push(String(req.headers.cookie ?? ''));
    out.origins.push(String(req.headers.origin ?? ''));
    const send = (o: Record<string, unknown>) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
    let speakingTimer: NodeJS.Timeout | null = null;
    let studentSpeaking = false;
    let silent = 0;
    const timers: NodeJS.Timeout[] = [];
    const speak = (ms: number) => {
      send({ type: 'status', state: 'speaking' });
      let sent = 0;
      const tick = () => {
        if (sent * 40 >= ms) {
          if (speakingTimer) clearInterval(speakingTimer);
          speakingTimer = null;
          send({ type: 'transcript', role: 'agent', text: 'an answer', mode: 'conversational' });
          send({ type: 'status', state: 'listening' });
          return;
        }
        if (ws.readyState === ws.OPEN) ws.send(Buffer.alloc(1920, 1), { binary: true });
        sent++;
      };
      tick();
      speakingTimer = setInterval(tick, 40);
    };
    ws.on('close', () => {
      if (speakingTimer) clearInterval(speakingTimer);
      timers.forEach(clearTimeout);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'start') {
          out.starts.push(msg);
          if (behavior === 'busy') {
            send({ type: 'error', code: 'busy', message: 'a call of this student is still being saved' });
            timers.push(setTimeout(() => ws.close(), 20));
          } else if (behavior === 'drop') ws.terminate();
          else
            timers.push(
              setTimeout(() => {
                send({ type: 'ready', sessionId: 'abcdefgh12345678', mode: msg.mode === 'interview' ? 'interviewer' : msg.mode === 'talk' ? 'listener' : 'conversational', voice: 'v', maxSeconds: 600, resumed: false });
                send({ type: 'status', state: 'listening' });
                speak(40);
              }, 20),
            );
        } else if (msg.type === 'end') {
          send({ type: 'closed', reason: 'user' });
          timers.push(setTimeout(() => ws.close(), 10));
        }
        return;
      }
      const samples = new Int16Array((data as Buffer).buffer, (data as Buffer).byteOffset, Math.floor((data as Buffer).length / 2));
      let sum = 0;
      for (const s of samples) sum += s * s;
      if (Math.sqrt(sum / Math.max(1, samples.length)) > 300) {
        silent = 0;
        if (!studentSpeaking) {
          studentSpeaking = true;
          send({ type: 'agent_interrupted' });
        }
      } else if (studentSpeaking && ++silent >= 3) {
        studentSpeaking = false;
        silent = 0;
        send({ type: 'transcript', role: 'user', text: 'what the student said', mode: 'conversational' });
        send({ type: 'status', state: 'thinking' });
        timers.push(setTimeout(() => speak(80), 60));
      }
    });
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  );
  return out;
}

const connection = (url: string, extra: string[] = []): string[] => ['--url', url, '--origin', 'https://lab.example', '--users', files.users, '--secret', files.secret, '--email', 'owner@example.edu', '--audio', files.audio, '--testset', files.testset, '--gap-ms', '0', ...extra];
const outDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-lab-out-'));
  outDirs.push(dir);
  return dir;
};
const logsIn = (dir: string): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();

// ---------------------------------------------------------------- usage

describe('the command line: usage', () => {
  it('prints the usage and exits 2 with no arguments, and 0 for --help', async () => {
    const none = await cli([]);
    expect(none.code).toBe(2);
    expect(none.err).toBe(USAGE);
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toBe(USAGE);
    expect(USAGE).toMatch(/run .*interleave .*analyze/s);
    expect(USAGE).toContain('latency|pause|short|filler|bargein|interview|talk|tuning');
    expect(USAGE).toContain('exit codes: 0 done, 2 usage');
  });

  it('exits 2 for an unknown command, an unknown option, an option with no value and a stray word, each saying which', async () => {
    expect((await cli(['frobnicate'])).err).toMatch(/unknown command frobnicate/);
    expect((await cli(['run', '--nope', 'x'])).err).toMatch(/unknown option --nope for run/);
    expect((await cli(['run', '--chain'])).err).toMatch(/--chain needs a value/);
    expect((await cli(['run', '--chain', '--set', 'latency'])).err).toMatch(/--chain needs a value/);
    expect((await cli(['run', 'latency'])).err).toMatch(/unexpected argument latency/);
    expect((await cli(['analyze', '--chain', 'x'])).err).toMatch(/unknown option --chain for analyze/); // an option of another command
    for (const argv of [['frobnicate'], ['run', '--nope', 'x'], ['run', '--chain'], ['run', 'latency'], ['analyze', '--chain', 'x']]) expect((await cli(argv)).code).toBe(2);
  });

  it('refuses every --set value that is not one of the eight documented ones, and accepts those', async () => {
    const base = ['run', '--socket', '/run/portal.sock', '--origin', 'https://x', '--users', files.users, '--secret', files.secret, '--email', 'owner@example.edu', '--chain', 'T', '--audio', path.join(root, 'no-such-audio')];
    for (const bad of ['all', 'Latency', 'latency,pause', 'eval', 'tuning2', 'bargein ', 'recognition']) {
      const r = await cli([...base, '--set', bad]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--set must be one of latency, pause, short, filler, bargein, interview, talk, tuning/);
    }
    expect((await cli(base)).err).toMatch(/--set is required/);
    for (const good of LAB_SETS) {
      const r = await cli([...base, '--set', good]);
      expect(r.code).toBe(2); // it goes on to the audio, which is not there
      expect(r.err).not.toMatch(/--set must be/);
      expect(r.err).toMatch(/manifest\.json.*make_audio\.ps1/s);
    }
  });

  it('derives the mode from the set and refuses a --mode that contradicts it', async () => {
    const base = ['run', '--socket', '/run/portal.sock', '--origin', 'https://x', '--users', files.users, '--secret', files.secret, '--email', 'owner@example.edu', '--chain', 'T', '--audio', path.join(root, 'no-such-audio')];
    for (const [set, mode] of [
      ['interview', 'chat'],
      ['interview', 'talk'],
      ['talk', 'chat'],
      ['talk', 'interview'],
      ['pause', 'interview'],
      ['latency', 'talk'],
      ['tuning', 'interview'],
    ]) {
      const r = await cli([...base, '--set', set, '--mode', mode]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(new RegExp(`--mode ${mode} contradicts --set ${set}`));
    }
    for (const [set, mode] of [
      ['interview', 'interview'],
      ['talk', 'talk'],
      ['pause', 'chat'],
    ]) {
      const r = await cli([...base, '--set', set, '--mode', mode]);
      expect(r.err).not.toMatch(/contradicts/);
    }
    expect((await cli([...base, '--set', 'pause', '--mode', 'chatty'])).err).toMatch(/--mode is chat, interview or talk/);
  });

  it('checks numbers, routes, chains, the target and the allowlist before any call', async () => {
    const ok = ['--origin', 'https://x', '--users', files.users, '--secret', files.secret, '--email', 'owner@example.edu', '--set', 'latency', '--audio', files.audio, '--testset', files.testset];
    const run = (...extra: string[]) => cli(['run', '--chain', 'T', ...extra]);
    expect((await run(...ok)).err).toMatch(/--socket \(or --url\) is required/);
    expect((await run('--socket', '/s', ...ok, '--runs', '0')).err).toMatch(/--runs must be between 1 and 50/);
    expect((await run('--socket', '/s', ...ok, '--runs', 'three')).err).toMatch(/--runs must be a whole number/);
    expect((await run('--socket', '/s', ...ok, '--voice-offset', '1.5')).err).toMatch(/--voice-offset must be a whole number/);
    expect((await run('--socket', '/s', ...ok, '--path', 'api/voice-x')).err).toMatch(/--path must be api\/voice or api\/voice-lab/);
    expect((await cli(['run', '--socket', '/s', ...ok])).err).toMatch(/--chain is required/);
    const stranger = ok.map((v) => (v === 'owner@example.edu' ? 'mallory@example.edu' : v));
    const refused = await run('--socket', '/s', ...stranger);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/not on the allowlist/);
    const missingUsers = await run('--socket', '/s', ...ok.map((v) => (v === files.users ? path.join(root, 'nope.json') : v)));
    expect(missingUsers.code).toBe(2);
    const inter = (...extra: string[]) => cli(['interleave', '--socket', '/s', ...ok, ...extra]);
    expect((await inter('--a-chain', 'L')).err).toMatch(/--b-chain is required/);
    expect((await inter('--a-chain', 'L', '--b-chain', 'L')).err).toMatch(/--a-chain and --b-chain must differ/);
    expect((await inter('--a-chain', 'L', '--b-chain', 'D', '--b-path', 'api/other')).err).toMatch(/--b-path must be api\/voice or api\/voice-lab/);
    expect((await cli(['analyze', '--b', root])).err).toMatch(/--a is required/);
    expect((await cli(['analyze', '--a', root, '--b', path.join(root, 'nope')])).err).toMatch(/is not a directory/);
  });

  it('says whether the test set is the frozen one, and fails as a usage error when the audio is missing', async () => {
    const frozenSet = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../eval/voice-lab/testset.json');
    const real = await cli(['run', '--socket', '/s', '--origin', 'https://x', '--users', files.users, '--secret', files.secret, '--email', 'owner@example.edu', '--chain', 'T', '--set', 'latency', '--audio', files.audio, '--testset', frozenSet]);
    expect(real.out).toMatch(/test set: the frozen one of docs\/VOICE_SELFBUILT\.md 9\.7 \(sha256 89b4b8d2a105, blob 5066b76d5863\)/);
    expect(real.code).toBe(2); // the mini audio has none of the real sentences
    expect(real.err).toMatch(/no audio for/);
    // an audio directory with nothing in it, so that nothing is dialled
    const mini = await cli(['run', '--socket', '/s', '--origin', 'https://x', '--users', files.users, '--secret', files.secret, '--email', 'owner@example.edu', '--chain', 'T', '--set', 'latency', '--audio', files.emptyAudio, '--testset', files.testset]);
    expect(mini.code).toBe(2);
    expect(mini.err).toMatch(/WARNING: the test set .* is NOT the frozen one/);
    expect((await cli(['run', '--socket', '/s', '--origin', 'https://x', '--users', files.users, '--secret', files.secret, '--email', 'owner@example.edu', '--chain', 'T', '--set', 'latency', '--audio', files.audio, '--testset', path.join(root, 'missing.json')])).code).toBe(2);
  });
});

// ---------------------------------------------------------------- run, interleave and analyze against a loopback server

describe('the command line: calls', () => {
  it('run: waits out a busy hub and repeats the call, keeps both raw logs, names the repeat, and never prints the cookie', async () => {
    const server = await miniServer(['busy', 'ok']);
    const out = outDir();
    const r = await cli(['run', ...connection(server.url), '--chain', 'T', '--set', 'interview', '--runs', '1', '--out', out]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/run: chain T, route api\/voice, set interview \(1 scenarios, mode interview\), 1 run\(s\)/);
    expect(r.out).toMatch(/\[T\] interview run 1 attempt 2: 1 scenario\(s\) played, 1 answered, ended done; log /);
    expect(server.starts.map((s) => s.mode)).toEqual(['interview', 'interview']); // the mode comes from the set
    expect(server.paths).toEqual(['/api/voice', '/api/voice']);
    expect(server.origins[0]).toBe('https://lab.example');
    const files_ = logsIn(out);
    expect(files_).toHaveLength(2);
    const calls = files_.map((f) => parseRawLog(fs.readFileSync(path.join(out, f), 'utf8'), f)).sort((a, b) => a.header.attempt - b.header.attempt);
    expect(calls[0].header).toMatchObject({ attempt: 1, chain: 'T', set: 'interview', mode: 'interview', path: 'api/voice' });
    expect(calls[0].end).toMatchObject({ reason: 'start-failed', error: { code: 'busy' } });
    expect(calls[1].header.attempt).toBe(2);
    expect(calls[1].header.retryOf).toBe(calls[0].header.callId);
    expect(calls[1].end!.reason).toBe('done');
    expect(calls[1].header.testset!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the cookie went to the server in a header and is nowhere else
    const cookie = server.cookies[0].replace('tai_session=', '');
    expect(cookie.length).toBeGreaterThan(20);
    for (const text of [r.out, r.err, ...files_.map((f) => fs.readFileSync(path.join(out, f), 'utf8'))]) expect(text).not.toContain(cookie);
    // the analysis leaves the busy attempt out and says so
    const report = analyzeLogs(readRawLogs(out), []);
    expect(report.excluded.superseded).toEqual([calls[0].header.callId]);
    expect(report.a.calls).toBe(1);
  }, 12_000);

  it('run: repeats a call whose socket went away before ready once, and no more', async () => {
    const server = await miniServer(['drop', 'drop', 'ok']);
    const out = outDir();
    const r = await cli(['run', ...connection(server.url), '--chain', 'T', '--set', 'latency', '--runs', '1', '--out', out]);
    expect(r.code).toBe(0);
    expect(server.paths).toHaveLength(2); // the first attempt and one repeat; the third connection never came
    expect(r.out).toMatch(/\[T\] latency run 1 attempt 2: did not start \(start-failed\)/);
    const calls = logsIn(out).map((f) => parseRawLog(fs.readFileSync(path.join(out, f), 'utf8'), f));
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.end!.error!.code)).toEqual(['closed-before-ready', 'closed-before-ready']);
    // the last attempt stands: it counts as a call that failed to start (here as the lab's, chain B), the first is left out
    const report = analyzeLogs([], readRawLogs(out));
    expect(report.b.calls).toBe(1);
    expect(report.criteria[0].checks.find((c) => c.id === 'C0.starts')).toMatchObject({ nB: 1, b: 1, verdict: 'FAIL' });
  }, 12_000);

  it('interleave: alternates the two chains call by call, each on its own route and into its own folder, and analyze reads the two folders', async () => {
    const server = await miniServer();
    const out = outDir();
    const r = await cli(['interleave', ...connection(server.url), '--a-chain', 'L', '--b-chain', 'D', '--set', 'latency', '--runs', '2', '--out', out]);
    expect(r.code).toBe(0);
    expect(server.paths).toEqual(['/api/voice', '/api/voice-lab', '/api/voice', '/api/voice-lab']); // A, B, A, B
    expect(r.out).toMatch(/interleave: L \(api\/voice\) and D \(api\/voice-lab\), set latency \(1 scenarios, mode chat\), 2 round\(s\)/);
    const summaries = r.out.split('\n').filter((l) => l.startsWith('['));
    expect(summaries.map((l) => l.slice(0, 22))).toEqual(['[L] latency run 1 atte', '[D] latency run 1 atte', '[L] latency run 2 atte', '[D] latency run 2 atte']);
    expect(logsIn(path.join(out, 'L'))).toHaveLength(2);
    expect(logsIn(path.join(out, 'D'))).toHaveLength(2);
    const a = readRawLogs(path.join(out, 'L'));
    const b = readRawLogs(path.join(out, 'D'));
    expect(a.every((c) => c.header.chain === 'L' && c.header.path === 'api/voice')).toBe(true);
    expect(b.every((c) => c.header.chain === 'D' && c.header.path === 'api/voice-lab')).toBe(true);
    expect(a.map((c) => c.header.run).sort()).toEqual([1, 2]);
    // wall-clock order is A, B, A, B
    const timeline = [...a.map((c) => ({ w: c.header.wall, chain: 'L' })), ...b.map((c) => ({ w: c.header.wall, chain: 'D' }))].sort((x, y) => x.w.localeCompare(y.w)).map((e) => e.chain);
    expect(timeline).toEqual(['L', 'D', 'L', 'D']);

    // analyze: the Markdown report, and the same numbers as JSON
    const md = await cli(['analyze', '--a', path.join(out, 'L'), '--b', path.join(out, 'D')]);
    expect(md.code).toBe(0);
    expect(md.out).toMatch(/^# Voice lab: measurement report/);
    expect(md.out).toMatch(/Chain L: 2 call\(s\)/);
    expect(md.out).toMatch(/Chain D: 2 call\(s\)/);
    expect(md.out).toContain('## C0: Call start');
    expect(md.out).toMatch(/NOT MET/); // 2 calls are far from the 20 the document asks for
    expect(md.out).toContain('NOT the frozen one'); // the mini test set
    const json = await cli(['analyze', '--a', path.join(out, 'L'), '--b', path.join(out, 'D'), '--json']);
    expect(json.code).toBe(0);
    const report = JSON.parse(json.out) as Report;
    expect(report.a.label).toBe('L');
    expect(report.b.label).toBe('D');
    expect(report.a.calls).toBe(2);
    expect(report.criteria.map((c) => c.id)).toEqual(['C0', 'C1', 'C2', 'C3', 'C10']);
    expect(report.testset.frozen).toBe(false);
    expect(report.interleaving).toMatchObject({ calls: 4, longestRun: 1, alternations: 3 });
    const c0 = report.criteria[0].checks.find((c) => c.id === 'C0.ready.p50')!;
    expect(c0.nA).toBe(2);
    expect(c0.verdict).toBe('INSUFFICIENT'); // never a pass on a thin sample
    // the tuning flag looks at the other kind of set only: there is none here
    const tuning = JSON.parse((await cli(['analyze', '--a', path.join(out, 'L'), '--b', path.join(out, 'D'), '--json', '--tuning'])).out) as Report;
    expect(tuning.tuningOnly).toBe(true);
    expect(tuning.a.calls).toBe(0);
    expect(tuning.excluded.otherSets).toBe(4);
  }, 15_000);
});
