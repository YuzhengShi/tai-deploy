import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

import { createHarness, type Harness } from '../../testing/harness.js';
import { CallClient, ConnectError, sleep } from './client.js';
import { frameOfSample, silence } from './wav.js';

// ---------------------------------------------------------------- a loopback server that speaks just enough of the browser protocol

interface Loopback {
  url: string;
  headers: http.IncomingHttpHeaders[];
  sockets: ServerSocket[];
  /** the JSON messages the client sent */
  texts: Array<Record<string, unknown>>;
  /** the binary frames the client sent, with their arrival time on this process's clock */
  frames: Array<{ at: number; data: Buffer }>;
  send(event: Record<string, unknown>): void;
  sendAudio(bytes: number): void;
}

const closers: Array<() => Promise<void>> = [];
const clients: CallClient[] = [];
let hub: Harness | null = null;

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const close of closers.splice(0)) await close();
  await hub?.close();
  hub = null;
});

async function loopback(onText?: (msg: Record<string, unknown>, lb: Loopback) => void): Promise<Loopback> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const lb: Loopback = {
    url: `ws://127.0.0.1:${port}/api/voice`,
    headers: [],
    sockets: [],
    texts: [],
    frames: [],
    send: (event) => lb.sockets[0]?.send(JSON.stringify(event)),
    sendAudio: (bytes) => lb.sockets[0]?.send(Buffer.alloc(bytes, 1), { binary: true }),
  };
  wss.on('connection', (ws, req) => {
    lb.headers.push(req.headers);
    lb.sockets.push(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) lb.frames.push({ at: performance.now(), data: data as Buffer });
      else {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        lb.texts.push(msg);
        onText?.(msg, lb);
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
  return lb;
}

async function connect(lb: Loopback, cookie = 'cookie-value-123'): Promise<CallClient> {
  const client = await CallClient.connect({ url: lb.url, origin: 'https://lab.example', cookie });
  clients.push(client);
  return client;
}

/** a clip whose frame k (of `frames`) is filled with the byte k + base, so that the order of what arrives can be read from it */
const numbered = (frames: number, base = 1): Buffer => {
  const pcm = Buffer.alloc(frames * 1280);
  for (let k = 0; k < frames; k++) pcm.fill(k + base, k * 1280, (k + 1) * 1280);
  return pcm;
};
const isSilent = (buf: Buffer) => buf.every((b) => b === 0);

// ---------------------------------------------------------------- connecting

describe('CallClient: connecting', () => {
  it('opens with the Origin and the session cookie, sends start in the mode, and keeps one clock for everything it records', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    client.sendStart('interview');
    await client.waitFor(() => lb.texts.length > 0, 2000, 5); // the server's side of the wire: only a poll sees it
    expect(lb.headers[0].origin).toBe('https://lab.example');
    expect(lb.headers[0].cookie).toBe('tai_session=cookie-value-123');
    expect(lb.texts[0]).toEqual({ type: 'start', mode: 'interview' });
    expect(client.startSentAt).not.toBeNull();
    expect(client.openedAt).toBeGreaterThan(0);
    expect(client.openedAt).toBeLessThanOrEqual(client.startSentAt!);

    lb.send({ type: 'ready', sessionId: 'abcdefgh12345678', mode: 'interviewer', voice: 'v', maxSeconds: 600, resumed: false });
    lb.sendAudio(1920);
    lb.send({ type: 'status', state: 'speaking' });
    lb.sendAudio(960);
    await client.waitFor(() => client.events.length >= 2 && client.audio.length >= 2, 2000);
    expect(client.events.map((e) => e.ev.type)).toEqual(['ready', 'status']);
    expect(client.audio.map((a) => a.bytes)).toEqual([1920, 960]);
    // one arrival order across events and audio, and times that never go back
    const all = [...client.events, ...client.audio].sort((a, b) => a.seq - b.seq);
    expect(all.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < all.length; i++) expect(all[i].t).toBeGreaterThanOrEqual(all[i - 1].t);
    expect(all[0].t).toBeGreaterThan(client.startSentAt!);
    // the cookie is in the request header and nowhere on the client
    expect(JSON.stringify([...client.events, ...client.audio])).not.toContain('cookie-value-123');
    expect(Object.values(client)).not.toContain('cookie-value-123');
  });

  it('ignores a message that is not JSON and one that is not an object', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    lb.sockets[0].send('not json');
    lb.sockets[0].send('42');
    lb.send({ type: 'status', state: 'listening' });
    await client.waitFor(() => client.events.length > 0, 2000);
    expect(client.events.map((e) => e.ev.type)).toEqual(['status']);
  });

  it('refuses with a ConnectError that says what happened and never holds the cookie', async () => {
    const secret = 'super-secret-cookie-value';
    const refuser = http.createServer();
    refuser.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
    await new Promise<void>((resolve) => refuser.listen(0, '127.0.0.1', () => resolve()));
    closers.push(() => new Promise<void>((resolve) => refuser.close(() => resolve())));
    const url = `ws://127.0.0.1:${(refuser.address() as AddressInfo).port}/api/voice`;
    const refused = await CallClient.connect({ url, origin: 'https://x', cookie: secret }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as ConnectError).kind).toBe('http');
    expect((refused as ConnectError).status).toBe(403);
    expect(String((refused as ConnectError).message)).not.toContain(secret);

    // a port nobody listens on
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const nobody = await CallClient.connect({ url: `ws://127.0.0.1:${closedPort}/api/voice`, origin: 'https://x', cookie: secret }).catch((e: unknown) => e);
    expect((nobody as ConnectError).kind).toBe('socket');
    expect(String((nobody as ConnectError).message)).not.toContain(secret);
  });

  it('gives up on a host that accepts the connection and never answers the handshake', async () => {
    const mute = net.createServer(() => undefined);
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', () => resolve()));
    const sockets: net.Socket[] = [];
    mute.on('connection', (s) => sockets.push(s));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy();
          mute.close(() => resolve());
        }),
    );
    const err = await CallClient.connect({ url: `ws://127.0.0.1:${(mute.address() as AddressInfo).port}/api/voice`, origin: 'https://x', cookie: 'c', handshakeTimeoutMs: 150 }).catch((e: unknown) => e);
    expect((err as ConnectError).kind).toBe('timeout');
  });
});

// ---------------------------------------------------------------- the microphone

describe('CallClient: the microphone', () => {
  it('streams in real time: frame k is sent at start + k * 40 ms with no drift, and what the server receives is what the client says it sent', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    const handle = client.play(numbered(50)); // 2 s of audio, queued before the microphone starts
    expect(handle).toEqual({ firstFrame: 0, frames: 50 });
    client.startMic();
    await client.frameSent(54); // the 50 frames of the clip and five of silence
    await sleep(80); // let the server read them
    const n = 55;
    const mic = client.micStartAt!;
    const late = client.sentTimes.slice(0, n).map((t, i) => t - (mic + i * 40));
    // a frame is never early; it is as a rule on its slot (about a tenth of a millisecond on an idle machine), and none is far behind it
    // (the bands are wide enough for a machine that is busy with other work: the report warns when a real run was late)
    expect(Math.min(...late)).toBeGreaterThanOrEqual(0);
    const sorted = [...late].sort((a, b) => a - b);
    expect(sorted[Math.floor((n - 1) * 0.5)]).toBeLessThan(10);
    expect(sorted[Math.floor((n - 1) * 0.9)]).toBeLessThan(40);
    // no drift: the last frame is as close to its slot as the first (a chain of timeouts would add its lateness frame by frame: 54 frames at
    // 1 to 15 ms each is 50 to 800 ms)
    expect(Math.abs(late[n - 1] - late[0])).toBeLessThan(40);
    const span = client.sentTimes[n - 1] - client.sentTimes[0];
    expect(span).toBeGreaterThan(54 * 40 - 40);
    expect(span).toBeLessThan(54 * 40 + 40);
    // the server got the clip in order, then silence
    expect(lb.frames.length).toBeGreaterThanOrEqual(n);
    for (let k = 0; k < 50; k++) expect(lb.frames[k].data.equals(Buffer.alloc(1280, k + 1))).toBe(true);
    for (let k = 50; k < n; k++) expect(isSilent(lb.frames[k].data)).toBe(true);
    // and it got them when the client says it sent them: send time and arrival differ by a near-constant
    const offsets = lb.frames.slice(0, n).map((f, i) => f.at - client.sentTimes[i]);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(40);
  });

  it('sends nothing until the microphone starts, and silence when nothing is queued', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    await sleep(150);
    expect(lb.frames).toHaveLength(0);
    expect(client.sentTimes).toHaveLength(0);
    client.startMic();
    await client.frameSent(4);
    await sleep(40);
    expect(lb.frames.length).toBeGreaterThanOrEqual(5);
    expect(lb.frames.slice(0, 5).every((f) => f.data.length === 1280 && isSilent(f.data))).toBe(true);
    expect(client.nextFrame).toBeGreaterThanOrEqual(5);
  });

  it('names the frame that carries the last speech sample, also when it is the last sample of its frame, and records when it was sent', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    // 5 frames of silence, 2 frames of speech whose last sample is the last sample of frame 6, 2 frames of silence
    const speech = Buffer.alloc(2 * 1280, 0x11);
    const handle = client.play(Buffer.concat([silence(200), speech, silence(80)]));
    client.startMic();
    const lastSample = 5 * 640 + 2 * 640 - 1;
    const ueFrame = handle.firstFrame + frameOfSample(lastSample, client.frameSamples);
    expect(ueFrame).toBe(6);
    const sentAt = await client.frameSent(ueFrame);
    await client.frameSent(ueFrame + 1);
    await sleep(50);
    expect(sentAt).toBe(client.sentTimes[ueFrame]);
    expect(client.sentTimes[ueFrame - 1]).toBeLessThan(sentAt!);
    expect(client.sentTimes[ueFrame + 1] - sentAt!).toBeGreaterThan(30);
    expect(lb.frames[6].data.readInt16LE(1278)).not.toBe(0); // its last sample is speech
    expect(isSilent(lb.frames[7].data)).toBe(true); // the next frame carries none
    expect(lb.frames[5].data.readInt16LE(0)).not.toBe(0); // and the speech began in frame 5
    expect(isSilent(lb.frames[4].data)).toBe(true);
  });

  it('places an interruption at an absolute time in the one paced stream: silence before it, its frames in order, silence after', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    client.startMic();
    await sleep(300);
    const atT = client.now() + 400;
    const handle = client.injectAt(numbered(4, 0x21), atT);
    expect(handle.frames).toBe(4);
    expect(handle.firstFrame).toBe(Math.ceil((atT - client.micStartAt!) / 40 - 1e-9)); // the first frame due at or after the time asked for
    await client.frameSent(handle.firstFrame + 4); // and the silence after it
    await sleep(60);
    const first = client.sentTimes[handle.firstFrame];
    expect(first).toBeGreaterThanOrEqual(atT - 1);
    expect(first).toBeLessThan(atT + 40 + 60); // never early, and within a frame (plus what a busy machine adds)
    for (let i = 0; i < handle.firstFrame; i++) expect(isSilent(lb.frames[i].data)).toBe(true);
    for (let i = 0; i < 4; i++) expect(lb.frames[handle.firstFrame + i].data.equals(Buffer.alloc(1280, 0x21 + i))).toBe(true);
    expect(isSilent(lb.frames[handle.firstFrame + 4].data)).toBe(true);
    // still one stream: nothing was sent twice and nothing is missing
    expect(client.sentTimes.slice(0, handle.firstFrame + 5).every((t) => typeof t === 'number')).toBe(true);
    expect(lb.frames.length).toBeGreaterThanOrEqual(handle.firstFrame + 5);
  });

  it('puts a clip whose time has passed, or that meets a queue that is not empty, right after what is queued', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    const a = client.play(numbered(3, 1));
    const b = client.injectAt(numbered(2, 0x31), 0); // time 0 is long past
    expect(a).toEqual({ firstFrame: 0, frames: 3 });
    expect(b).toEqual({ firstFrame: 3, frames: 2 });
    client.startMic();
    await client.frameSent(5);
    await sleep(50);
    expect(lb.frames.slice(0, 5).map((f) => f.data[0])).toEqual([1, 2, 3, 0x31, 0x32]);
    // a time in the future leaves silence in between
    const c = client.injectAt(numbered(1, 0x41), client.now() + 200);
    expect(c.firstFrame).toBeGreaterThan(client.nextFrame);
  });

  it('pads the last frame of a clip with silence', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    const handle = client.play(Buffer.alloc(1280 + 400, 7));
    expect(handle.frames).toBe(2);
    client.startMic();
    await client.frameSent(2);
    await sleep(50);
    expect(lb.frames[1].data.subarray(0, 400).every((b) => b === 7)).toBe(true);
    expect(isSilent(lb.frames[1].data.subarray(400))).toBe(true);
    expect(lb.frames[1].data.length).toBe(1280);
  });

  it('stops sending when the socket closes', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    client.startMic();
    await sleep(150);
    lb.sockets[0].close();
    expect(await client.waitFor(() => client.closed, 2000)).toBe(true);
    const sent = client.sentTimes.length;
    await sleep(150);
    expect(client.sentTimes.length).toBe(sent);
    expect(await client.frameSent(sent + 5)).toBeNull(); // a frame that will never be sent
  });
});

// ---------------------------------------------------------------- waiting

describe('CallClient: waiting', () => {
  it('is true as soon as a message makes the predicate true, false on a timeout, and false when the socket closes first', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    setTimeout(() => lb.send({ type: 'status', state: 'speaking' }), 60);
    const began = performance.now();
    expect(await client.waitFor(() => client.events.some((e) => e.ev.state === 'speaking'), 3000)).toBe(true);
    expect(performance.now() - began).toBeLessThan(1000);
    expect(await client.waitFor(() => true, 0)).toBe(true); // already true
    const slow = performance.now();
    expect(await client.waitFor(() => false, 100)).toBe(false);
    expect(performance.now() - slow).toBeGreaterThanOrEqual(90);
    const pending = client.waitFor(() => false, 5000);
    lb.sockets[0].close();
    const closedAt = performance.now();
    expect(await pending).toBe(false);
    expect(performance.now() - closedAt).toBeLessThan(1000);
    expect(await client.waitFor(() => false, 5000)).toBe(false); // already closed: no wait
  });

  it('can watch the clock when the predicate depends on time (a poll), and not otherwise', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    const start = client.now();
    expect(await client.waitFor(() => client.now() - start > 120, 3000, 10)).toBe(true);
    const without = await client.waitFor(() => client.now() - start > 100_000, 150);
    expect(without).toBe(false);
  });

  it('finds the first event of a type that matches and came after a time, and the first agent frame after a time', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    lb.send({ type: 'status', state: 'thinking' });
    lb.sendAudio(100);
    await client.waitFor(() => client.events.length === 1 && client.audio.length === 1, 2000);
    await sleep(60);
    const mark = client.now();
    lb.send({ type: 'status', state: 'speaking' });
    lb.sendAudio(200);
    lb.send({ type: 'status', state: 'listening' });
    const speaking = await client.waitForEvent('status', { after: mark, match: (ev) => ev.state === 'speaking', timeoutMs: 2000 });
    expect(speaking!.ev.state).toBe('speaking');
    expect(speaking!.t).toBeGreaterThanOrEqual(mark);
    const frame = await client.waitForAudio(mark, 2000);
    expect(frame!.bytes).toBe(200);
    expect(await client.waitForEvent('transcript', { timeoutMs: 100 })).toBeNull();
    expect(await client.waitForAudio(client.now() + 10_000, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------- hanging up

describe('CallClient: hanging up', () => {
  it('sends end, waits for the server\'s closed, and drops the socket', async () => {
    const lb = await loopback((msg, server) => {
      if (msg.type === 'end') server.send({ type: 'closed', reason: 'user', summary: 'Voice session, 1 min.' });
    });
    const client = await connect(lb);
    const began = performance.now();
    await client.end(3000);
    expect(performance.now() - began).toBeLessThan(1500);
    expect(lb.texts.map((t) => t.type)).toContain('end');
    expect(client.sawClosed).toBe(true);
    expect(client.closed).toBe(true);
    expect(client.events.find((e) => e.ev.type === 'closed')!.ev.reason).toBe('user');
  });

  it('gives up waiting for closed after the time it was given', async () => {
    const lb = await loopback();
    const client = await connect(lb);
    const began = performance.now();
    await client.end(150);
    const took = performance.now() - began;
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1000);
    expect(client.sawClosed).toBe(false);
    expect(client.closed).toBe(true);
  });
});

// ---------------------------------------------------------------- the real hub

describe('CallClient: against the real hub (a fake Deepgram behind it)', () => {
  const tags = (client: CallClient) =>
    [...client.events.map((e) => ({ seq: e.seq, tag: e.ev.type === 'status' ? `status:${String(e.ev.state)}` : e.ev.type === 'transcript' ? `transcript:${String(e.ev.role)}` : String(e.ev.type) })), ...client.audio.map((a) => ({ seq: a.seq, tag: 'audio' }))]
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.tag);
  const inOrder = (all: string[], wanted: string[]) => {
    let at = 0;
    for (const w of wanted) {
      const found = all.indexOf(w, at);
      if (found < 0) return false;
      at = found + 1;
    }
    return true;
  };

  it('sees ready, the greeting end (a frame, then listening), and an agent_interrupted on EVERY user speech onset, also when the agent was silent', async () => {
    hub = await createHarness();
    const user = hub.user(1);
    const client = await CallClient.connect({ url: `ws://127.0.0.1:${hub.port}/api/voice`, origin: hub.origin, cookie: user.folder });
    clients.push(client);
    client.sendStart('chat');
    const conn = await hub.dg.connection(1, 5000);
    await conn.waitFor('Settings');
    conn.agentSays('hey, what is up?', 4800); // Deepgram's greeting: audio, its text, done
    const ready = await client.waitForEvent('ready', { timeoutMs: 3000 });
    expect(ready!.ev.mode).toBe('conversational');
    expect(typeof ready!.ev.maxSeconds).toBe('number');
    client.startMic();
    // the greeting ends: a frame, then `status listening` after it (the first listening is the one that comes with ready)
    expect(await client.waitFor(() => client.audio.length > 0, 3000)).toBe(true);
    const frame = client.audio[0];
    expect(await client.waitFor(() => client.events.some((e) => e.seq > frame.seq && e.ev.type === 'status' && e.ev.state === 'listening'), 3000)).toBe(true);

    // the student speaks; the agent was silent: the hub still sends agent_interrupted
    client.play(numbered(10, 5));
    await client.waitFor(() => conn.audioBytes >= 1280 * 5, 3000, 5);
    conn.send({ type: 'UserStartedSpeaking' });
    expect(await client.waitFor(() => client.events.some((e) => e.ev.type === 'agent_interrupted'), 3000)).toBe(true);
    conn.send({ type: 'ConversationText', role: 'user', content: 'what is raft' });
    conn.send({ type: 'AgentThinking', content: '' });
    conn.agentSays('Raft is a consensus algorithm.', 9600);
    expect(await client.waitFor(() => client.events.some((e) => e.ev.type === 'transcript' && e.ev.role === 'agent' && String(e.ev.text).startsWith('Raft')), 3000)).toBe(true);
    await client.waitFor(() => tags(client).lastIndexOf('status:listening') > tags(client).indexOf('transcript:user'), 3000);

    expect(
      inOrder(tags(client), ['ready', 'status:listening', 'status:speaking', 'audio', 'transcript:agent', 'status:listening', 'agent_interrupted', 'transcript:user', 'status:thinking', 'status:speaking', 'audio', 'transcript:agent', 'status:listening']),
    ).toBe(true);
    expect(conn.audioBytes).toBeGreaterThanOrEqual(1280 * 5); // the microphone reached Deepgram's side

    await client.end(5000);
    expect(client.events.find((e) => e.ev.type === 'closed')!.ev.reason).toBe('user');
  }, 15_000);
});
