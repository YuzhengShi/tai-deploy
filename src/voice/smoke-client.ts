/**
 * A synthetic voice call against the live portal, from the host: proof that the whole chain (portal -> hub -> Deepgram -> relay ->
 * gateway -> back) works, without a browser or a microphone.
 *
 *   node dist/voice/smoke-client.js --socket <portal unix socket> --origin <https origin> --users <users.json>
 *        --secret <portal secret file> --email <allowlisted address> --wav <16 kHz mono PCM16 WAV> [--mode chat|interview|talk]
 *        [--timeout 60] [--url ws://127.0.0.1:<port>/api/voice instead of --socket]
 *
 * It signs a session cookie for the address the way the portal does (SessionCodec with the portal's own secret: it must run where that
 * file is readable), opens /api/voice over the unix socket, sends start, streams the WAV as 40 ms frames in real time followed by silence
 * (without trailing silence there is no end of turn and no answer), and ends the call once the agent has answered, or after the
 * timeout. It prints a compact report and exits 1 unless agent audio and transcripts arrived AND the agent answered after the student
 * spoke (the greeting alone is Deepgram's own and proves nothing about the relay); 2 for a usage error. It never prints the cookie. The
 * call is real: it costs Deepgram minutes and counts against that student's daily voice budget.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { WebSocket } from 'ws';

import { SessionCodec, loadSecret, parseUsers } from '../portal/auth.js';

export interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

/** The PCM of a WAV file; throws (with how to convert) unless it is 16 kHz mono 16-bit PCM. */
export function parseWav(buf: Buffer): Wav {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('the WAV has no fmt or no data chunk');
  if ((fmt.format !== 1 && fmt.format !== 0xfffe) || fmt.bits !== 16 || fmt.channels !== 1 || fmt.sampleRate !== 16000) {
    throw new Error(
      `the WAV is ${fmt.sampleRate} Hz, ${fmt.channels} channel(s), ${fmt.bits}-bit (format ${fmt.format}); it must be 16 kHz mono 16-bit PCM ` +
        '(ffmpeg -i in.wav -ac 1 -ar 16000 -sample_fmt s16 out.wav)',
    );
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, data: data.subarray(0, data.length - (data.length % 2)) };
}

export interface SmokeOptions {
  /** ws://host:port/api/voice, or ws+unix:<socket path>:/api/voice */
  url: string;
  origin: string;
  /** The tai_session cookie's value. Never printed. */
  cookie: string;
  /** 16 kHz mono PCM16 */
  pcm: Buffer;
  mode: 'chat' | 'interview' | 'talk';
  timeoutMs: number;
  frameMs?: number;
  /** How long to listen after the agent's answer finished before hanging up. */
  afterAnswerMs?: number;
  /** How long to wait for `closed` after `end`. */
  closeWaitMs?: number;
}

export interface SmokeReport {
  ready: { sessionId: string; mode: string; voice: string; maxSeconds: number; afterMs: number } | null;
  transcripts: Array<{ role: string; text: string }>;
  statuses: string[];
  modes: string[];
  notices: string[];
  errors: Array<{ code: string; message: string }>;
  agentAudioBytes: number;
  answered: boolean;
  closed: { reason: string; summary?: string } | null;
  elapsedMs: number;
  ok: boolean;
}

/** One synthetic call; resolves with what happened (never rejects for a call that went wrong: that is in the report). */
export function runSmoke(opts: SmokeOptions): Promise<SmokeReport> {
  const frameMs = opts.frameMs ?? 40;
  const frameBytes = Math.round((16000 * 2 * frameMs) / 1000);
  const started = Date.now();
  const report: SmokeReport = {
    ready: null,
    transcripts: [],
    statuses: [],
    modes: [],
    notices: [],
    errors: [],
    agentAudioBytes: 0,
    answered: false,
    closed: null,
    elapsedMs: 0,
    ok: false,
  };
  return new Promise<SmokeReport>((resolve) => {
    let finished = false;
    let streamTimer: NodeJS.Timeout | null = null;
    let offset = 0;
    let heardStudent = false;
    let audioAfterStudent = false;
    let textAfterStudent = false;
    let endSent = false;
    let hangupTimer: NodeJS.Timeout | null = null;
    const ws = new WebSocket(opts.url, { headers: { Origin: opts.origin, Cookie: `tai_session=${opts.cookie}` }, handshakeTimeout: 10_000, perMessageDeflate: false });

    const finish = () => {
      if (finished) return;
      finished = true;
      if (streamTimer) clearInterval(streamTimer);
      if (hangupTimer) clearTimeout(hangupTimer);
      clearTimeout(overall);
      report.elapsedMs = Date.now() - started;
      // the greeting alone (spoken by Deepgram without the model) proves nothing about the relay or the gateway: an answer to the
      // student must have come back
      report.ok = report.agentAudioBytes > 0 && report.transcripts.length > 0 && report.answered;
      try {
        ws.terminate();
      } catch {
        /* gone */
      }
      resolve(report);
    };
    const hangUp = () => {
      if (endSent) return;
      endSent = true;
      try {
        ws.send(JSON.stringify({ type: 'end' }));
      } catch {
        /* gone */
      }
      setTimeout(finish, opts.closeWaitMs ?? 20_000).unref?.();
    };
    const overall = setTimeout(() => {
      report.errors.push({ code: 'smoke-timeout', message: `no answer within ${Math.round(opts.timeoutMs / 1000)} s` });
      if (ws.readyState === WebSocket.OPEN) hangUp();
      else finish();
    }, opts.timeoutMs);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', mode: opts.mode })));
    ws.on('unexpected-response', (_req, res) => {
      report.errors.push({ code: `http-${res.statusCode}`, message: 'the portal refused the WebSocket (cookie, Origin, allowlist or voice off?)' });
      finish();
    });
    ws.on('error', (err) => {
      report.errors.push({ code: 'socket', message: err.message });
      finish();
    });
    ws.on('close', () => finish());
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const n = Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? data.reduce((s, b) => s + b.length, 0) : (data as ArrayBuffer).byteLength;
        report.agentAudioBytes += n;
        if (heardStudent) audioAfterStudent = true;
        return;
      }
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (ev.type) {
        case 'ready':
          report.ready = { sessionId: String(ev.sessionId), mode: String(ev.mode), voice: String(ev.voice), maxSeconds: Number(ev.maxSeconds), afterMs: Date.now() - started };
          if (!streamTimer) {
            // the recording in real time, then silence: the end of the student's turn is silence
            streamTimer = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN) return;
              let frame: Buffer;
              if (offset < opts.pcm.length) {
                frame = opts.pcm.subarray(offset, offset + frameBytes);
                offset += frameBytes;
                if (frame.length < frameBytes) frame = Buffer.concat([frame, Buffer.alloc(frameBytes - frame.length)]);
              } else {
                frame = Buffer.alloc(frameBytes);
              }
              ws.send(frame);
            }, frameMs);
          }
          return;
        case 'transcript':
          report.transcripts.push({ role: String(ev.role), text: String(ev.text) });
          if (ev.role === 'user') heardStudent = true;
          else if (heardStudent) textAfterStudent = true;
          return;
        case 'status':
          report.statuses.push(String(ev.state));
          if (ev.state === 'listening' && audioAfterStudent && textAfterStudent && !report.answered) {
            report.answered = true;
            hangupTimer = setTimeout(hangUp, opts.afterAnswerMs ?? 1500);
          }
          return;
        case 'mode':
          report.modes.push(`${ev.mode} (${ev.voice})`);
          return;
        case 'notice':
          report.notices.push(String(ev.text));
          return;
        case 'error':
          report.errors.push({ code: String(ev.code), message: String(ev.message) });
          return;
        case 'closed':
          report.closed = { reason: String(ev.reason), ...(typeof ev.summary === 'string' ? { summary: ev.summary } : {}) };
          finish();
          return;
        default:
          return;
      }
    });
  });
}

export function formatReport(r: SmokeReport): string {
  const out: string[] = [];
  out.push(
    r.ready
      ? `ready: session ${r.ready.sessionId.slice(0, 8)}, mode ${r.ready.mode}, voice ${r.ready.voice}, max ${r.ready.maxSeconds} s (after ${(r.ready.afterMs / 1000).toFixed(1)} s)`
      : 'ready: never',
  );
  for (const t of r.transcripts) out.push(`  ${t.role === 'user' ? 'student' : 'TAi    '}: ${t.text.slice(0, 200)}`);
  const statuses = r.statuses.filter((s, i) => s !== r.statuses[i - 1]);
  out.push(`status: ${statuses.join(' > ') || 'none'}`);
  if (r.modes.length) out.push(`mode changes: ${r.modes.join(', ')}`);
  out.push(`agent audio: ${r.agentAudioBytes} bytes (${(r.agentAudioBytes / 48000).toFixed(1)} s at 24 kHz), answered after the student: ${r.answered ? 'yes' : 'no'}`);
  for (const n of r.notices) out.push(`notice: ${n}`);
  out.push(`errors: ${r.errors.length ? r.errors.map((e) => `${e.code} (${e.message})`).join('; ') : 'none'}`);
  out.push(`closed: ${r.closed ? `${r.closed.reason}${r.closed.summary ? ` | ${r.closed.summary.replace(/\n/g, ' | ').slice(0, 300)}` : ''}` : 'no closed event'}`);
  out.push(`elapsed: ${(r.elapsedMs / 1000).toFixed(1)} s`);
  out.push(
    `result: ${
      r.ok
        ? 'OK'
        : !r.ready
          ? 'FAILED (the call never started)'
          : r.transcripts.some((t) => t.role === 'user')
            ? 'FAILED (the student was heard but TAi did not answer: the relay, the gateway, or the proxy for /tai/voice-llm/)'
            : 'FAILED (the student was not heard: the WAV, or speech-to-text)'
    }`,
  );
  return out.join('\n');
}

/** The session cookie the portal would set for this allowlisted address (SessionCodec with the portal's secret). */
export function mintCookie(usersFile: string, secretFile: string, email: string, ttlSeconds = 600): string {
  const users = parseUsers(fs.readFileSync(usersFile, 'utf-8'));
  const user = users.find((u) => u.email === email.trim().toLowerCase());
  if (!user) throw new Error(`${email} is not on the allowlist in ${usersFile}`);
  return new SessionCodec(loadSecret(secretFile), ttlSeconds).issue(user.email).value;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${a} needs a value`);
    out[a.slice(2)] = value;
    i++;
  }
  return out;
}

const USAGE =
  'usage: node dist/voice/smoke-client.js --socket <portal socket> --origin <https origin> --users <users.json> --secret <secret file> ' +
  '--email <address> --wav <16 kHz mono PCM16 WAV> [--mode chat|interview|talk] [--timeout 60] [--url ws://127.0.0.1:<port>/api/voice]';

export async function main(argv: string[]): Promise<number> {
  let args: Record<string, string>;
  let cookie: string;
  let pcm: Buffer;
  try {
    args = parseArgs(argv);
    for (const need of ['origin', 'users', 'secret', 'email', 'wav']) if (!args[need]) throw new Error(`--${need} is required`);
    if (!args.socket && !args.url) throw new Error('--socket (or --url) is required');
    if (args.mode && args.mode !== 'chat' && args.mode !== 'interview' && args.mode !== 'talk') throw new Error('--mode is chat, interview or talk');
    cookie = mintCookie(args.users, args.secret, args.email);
    pcm = parseWav(fs.readFileSync(args.wav)).data;
  } catch (err) {
    console.error(`voice smoke: ${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const url = args.url || `ws+unix:${path.resolve(args.socket)}:/api/voice`;
  const timeout = Math.min(Math.max(parseInt(args.timeout || '60', 10) || 60, 10), 600);
  console.log(`voice smoke: ${args.email}, ${(pcm.length / 32000).toFixed(1)} s of audio, mode ${args.mode || 'chat'}, via ${args.url ? 'tcp' : 'the portal socket'}`);
  const report = await runSmoke({ url, origin: args.origin, cookie, pcm, mode: (args.mode as 'chat' | 'interview' | 'talk') || 'chat', timeoutMs: timeout * 1000 });
  console.log(formatReport(report));
  return report.ok ? 0 : 1;
}

const direct = process.argv[1] != null && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (direct) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`voice smoke: ${(err as Error).message}`);
      process.exit(2);
    },
  );
}
