/**
 * FluxEars against a loopback fake of Deepgram's /v2/listen only. No test connects a FluxEars without an explicit loopback `url`: the default
 * endpoint is checked by building its URL, never by opening it.
 */
import net from 'net';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { earsHarness, sleep, until } from '../testing/fake-asr.js';
import { FakeListen, type FakeListenOptions } from '../testing/fake-listen.js';
import type { EarsHandlers } from '../types.js';
import { buildFluxUrl, FLUX_FRAME_BYTES, FLUX_URL, FluxEars, type FluxOptions } from './flux.js';

const KEY = 'dg-flux-key-7d3e91b0c4a5';
const KEYTERMS = ['TAi', 'Paxos', 'CAP theorem', 'consistent hashing', 'R&D'];

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  // newest first: an ears client is closed before the server it was talking to
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startListen(opts?: FakeListenOptions): Promise<FakeListen> {
  const fake = await FakeListen.start(opts);
  cleanups.push(() => fake.close());
  return fake;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Harness = ReturnType<typeof earsHarness>;

function options(url: string, over: Partial<FluxOptions> = {}): FluxOptions {
  return { url, apiKey: () => KEY, keyterms: KEYTERMS, eotThreshold: 0.75, eotTimeoutMs: 5000, ...over };
}

function makeEars(opts: FluxOptions, h: Harness = earsHarness()) {
  const ears = new FluxEars(opts, h.handlers, h.ctx);
  cleanups.push(() => ears.close());
  return { ears, h };
}

async function connected(over: Partial<FluxOptions> = {}, handlers: Partial<EarsHandlers> = {}) {
  const listen = await startListen();
  const made = makeEars(options(listen.v2Url, over), earsHarness(handlers));
  await made.ears.connect(2000);
  const conn = await listen.connection();
  return { listen, conn, ...made };
}

function pattern(length: number, start = 0): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = (start + i) % 251;
  return buf;
}

// ---------------------------------------------------------------- the URL and the key

describe('FluxEars URL and key', () => {
  it('opens /v2/listen with model, encoding, rate, thresholds, one keyterm parameter per term and mip_opt_out, and not the key', async () => {
    const { conn } = await connected();
    expect(conn.path).toBe('/v2/listen');
    const pairs = conn.rawQuery.split('&');
    for (const wanted of ['model=flux-general-en', 'encoding=linear16', 'sample_rate=16000', 'eot_threshold=0.75', 'eot_timeout_ms=5000', 'mip_opt_out=true']) {
      expect(pairs).toContain(wanted);
    }
    expect(pairs.some((p) => p.startsWith('eager_eot_threshold'))).toBe(false);
    // one parameter per term, in order, each encoded on its own (a space is %20, an ampersand does not split the term)
    expect(pairs.filter((p) => p.startsWith('keyterm='))).toEqual(['keyterm=TAi', 'keyterm=Paxos', 'keyterm=CAP%20theorem', 'keyterm=consistent%20hashing', 'keyterm=R%26D']);
    expect(new URLSearchParams(conn.rawQuery).getAll('keyterm')).toEqual(KEYTERMS);
    expect(conn.rawQuery).not.toContain(KEY);
    expect(conn.req.url).not.toContain(KEY);
    expect(conn.rawQuery).not.toMatch(/token|apikey|api_key|key=/i);
  });

  it('puts the eager threshold in the URL when asked, never above the threshold that confirms the turn', async () => {
    const a = await connected({ eagerEotThreshold: 0.6 });
    expect(a.conn.rawQuery.split('&')).toContain('eager_eot_threshold=0.6');
    const b = await connected({ eagerEotThreshold: 0.9 });
    expect(b.conn.rawQuery.split('&')).toContain('eager_eot_threshold=0.75');
  });

  it('brings values outside what Deepgram accepts into range, and says so in the log', async () => {
    const { conn, h } = await connected({ eotThreshold: 0.2, eotTimeoutMs: 100 });
    const pairs = conn.rawQuery.split('&');
    expect(pairs).toContain('eot_threshold=0.5');
    expect(pairs).toContain('eot_timeout_ms=500');
    const warn = h.rec.at('warn').find((l) => l.msg.includes('adjusted'));
    expect(warn?.obj.adjusted).toEqual(['eot_threshold', 'eot_timeout_ms']);
  });

  it('builds the default endpoint without opening it', () => {
    const { url, adjusted } = buildFluxUrl({ keyterms: ['Paxos'] }, { eotThreshold: 0.9, eotTimeoutMs: 10_000 });
    expect(FLUX_URL).toBe('wss://api.deepgram.com/v2/listen');
    expect(url).toBe('wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.9&eot_timeout_ms=10000&keyterm=Paxos&mip_opt_out=true');
    expect(adjusted).toEqual([]);
  });

  it('builds the URL from the host and path alone: a given query, fragment or user name is not carried over, blank and repeated terms are dropped', () => {
    const { url } = buildFluxUrl({ url: 'ws://user:pw@127.0.0.1:9/v2/listen?old=1#frag', keyterms: [' Raft ', '', '  ', 'Raft', 'Paxos'] }, { eotThreshold: 0.8, eotTimeoutMs: 8000 });
    expect(url).toBe('ws://127.0.0.1:9/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000&eot_threshold=0.8&eot_timeout_ms=8000&keyterm=Raft&keyterm=Paxos&mip_opt_out=true');
  });

  it('leaves out a threshold that is not a number rather than send nonsense', () => {
    const { url, adjusted } = buildFluxUrl({ keyterms: [] }, { eotThreshold: Number.NaN, eotTimeoutMs: Number.POSITIVE_INFINITY });
    expect(url).not.toContain('eot_threshold');
    expect(url).not.toContain('eot_timeout_ms');
    expect(adjusted).toEqual(['eot_threshold (left out)', 'eot_timeout_ms (left out)']);
  });

  it('sends the key as the Authorization header, reads it when the socket opens (once per connect), and not before', async () => {
    const listen = await startListen();
    let reads = 0;
    const { ears } = makeEars(
      options(listen.v2Url, {
        apiKey: () => {
          reads++;
          return KEY;
        },
      }),
    );
    expect(reads).toBe(0);
    await ears.connect(2000);
    expect(reads).toBe(1);
    const conn = await listen.connection();
    expect(conn.authorization).toBe(`Token ${KEY}`);
  });

  it('does not connect without a key, and says so without a key to show', async () => {
    const listen = await startListen();
    const empty = makeEars(options(listen.v2Url, { apiKey: () => '   ' }));
    await expect(empty.ears.connect(1000)).rejects.toThrow(/no Deepgram key/);
    const broken = makeEars(
      options(listen.v2Url, {
        apiKey: () => {
          throw new Error(`vault says ${KEY}`);
        },
      }),
    );
    const err = (await broken.ears.connect(1000).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/could not be read/);
    expect(err.message).not.toContain(KEY);
    await sleep(30);
    expect(listen.connections).toHaveLength(0);
  });

  it('shows the key nowhere: not in errors, down reasons or logs, even when the server echoes it', async () => {
    const shown: string[] = [];
    const listen = await startListen();
    const h = earsHarness();

    const good = makeEars(options(listen.v2Url), h);
    await good.ears.connect(2000);
    const conn = await listen.connection();
    conn.sendWarning('W1', `the key ${KEY} is about to expire`);
    conn.sendConfigureFailure('BAD', `could not apply for ${KEY}`);
    conn.sendError('INVALID_AUTH', `token ${KEY} refused`);
    await until(() => h.of('down').length === 1);
    shown.push(h.of('down')[0].reason ?? '');
    expect(h.of('down')[0].reason).toContain('INVALID_AUTH');

    listen.handshake.refuseUpgrade = 401;
    shown.push(((await makeEars(options(listen.v2Url), h).ears.connect(1000).catch((e: unknown) => e)) as Error).message);
    const port = await closedPort();
    shown.push(((await makeEars(options(`ws://127.0.0.1:${port}/v2/listen`), h).ears.connect(1000).catch((e: unknown) => e)) as Error).message);
    listen.handshake.refuseUpgrade = undefined;
    listen.handshake.delayHandshakeMs = Infinity;
    shown.push(((await makeEars(options(listen.v2Url), h).ears.connect(150).catch((e: unknown) => e)) as Error).message);

    expect(shown.filter(Boolean)).toHaveLength(4);
    for (const text of shown) expect(text).not.toContain(KEY);
    expect(h.rec.dump()).not.toContain(KEY);
    expect(h.rec.dump()).not.toContain('7d3e91b0c4a5');
    // the warnings were logged, with the key taken out
    expect(h.rec.at('warn').some((l) => String(l.obj.description).includes('[redacted]'))).toBe(true);
  });
});

// ---------------------------------------------------------------- connect and the life of the socket

describe('FluxEars connect', () => {
  it('is the ears that decides the turn, named flux, and connected once the socket is open', async () => {
    const listen = await startListen();
    const { ears } = makeEars(options(listen.v2Url));
    expect(ears.name).toBe('flux');
    expect(ears.decidesTurn).toBe(true);
    expect(ears.connected).toBe(false);
    await ears.connect(2000);
    expect(ears.connected).toBe(true);
  });

  it('rejects with a plain Error when the port is closed, never calling down', async () => {
    const port = await closedPort();
    const { ears, h } = makeEars(options(`ws://127.0.0.1:${port}/v2/listen`));
    const err = (await ears.connect(3000).catch((e: unknown) => e)) as Error;
    expect(err.constructor).toBe(Error);
    expect(err.message).toMatch(/refused/);
    await sleep(50);
    expect(h.of('down')).toHaveLength(0);
  });

  it('rejects when the handshake never completes, and when it is not a 101', async () => {
    const listen = await startListen({ delayHandshakeMs: Infinity });
    const slow = makeEars(options(listen.v2Url));
    const started = Date.now();
    await expect(slow.ears.connect(250)).rejects.toThrow(/no handshake within 250 ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    listen.handshake.delayHandshakeMs = undefined;
    listen.handshake.refuseUpgrade = 401;
    const refused = makeEars(options(listen.v2Url));
    await expect(refused.ears.connect(2000)).rejects.toThrow(/refused the handshake \(HTTP 401\)/);
    expect(slow.h.of('down')).toHaveLength(0);
    expect(refused.h.of('down')).toHaveLength(0);
  });

  it('rejects a close() made while connect is pending', async () => {
    const listen = await startListen({ delayHandshakeMs: Infinity });
    const { ears, h } = makeEars(options(listen.v2Url));
    const pending = ears.connect(10_000);
    ears.close();
    await expect(pending).rejects.toThrow(/closed before it was connected/);
    await sleep(40);
    expect(h.of('down')).toHaveLength(0);
  });

  it('calls down exactly once when the server closes, and drops audio afterwards', async () => {
    const { listen, conn, ears, h } = await connected();
    listen.latest.close(1011, 'going away');
    await until(() => h.of('down').length === 1);
    await sleep(100);
    expect(h.of('down')).toHaveLength(1);
    expect(h.of('down')[0].reason).toContain('1011');
    expect(ears.connected).toBe(false);
    ears.sendAudio(pattern(FLUX_FRAME_BYTES));
    ears.setTurnFields({ eotThreshold: 0.9, eotTimeoutMs: 10_000 });
    ears.forceEndTurn();
    await sleep(40);
    expect(conn.frames).toHaveLength(0);
    expect(conn.texts).toHaveLength(0);
  });

  it('calls down once for a fatal Error message, with its code and description, and not again when the socket then closes', async () => {
    const { listen, ears, h } = await connected();
    listen.latest.sendError('INVALID_AUDIO_FORMAT', 'the audio is not linear16');
    await until(() => h.of('down').length === 1);
    await sleep(120);
    expect(h.of('down')).toHaveLength(1);
    expect(h.of('down')[0].reason).toBe('Deepgram error INVALID_AUDIO_FORMAT: the audio is not linear16');
    expect(ears.connected).toBe(false);
  });

  it('close() is idempotent, sends CloseStream and then closes normally, and is silent from the first call', async () => {
    const { listen, conn, ears, h } = await connected();
    ears.close();
    // an event already on the wire when we hung up must not reach the engine
    conn.sendTurnInfo('EndOfTurn', { transcript: 'too late', confidence: 0.9, trigger: 'model' });
    ears.close();
    ears.close();
    await until(() => conn.closed);
    expect(conn.closeCode).toBe(1000);
    expect(conn.textsOfType('CloseStream')).toHaveLength(1);
    expect(conn.texts[0].raw).toBe('{"type":"CloseStream"}');
    await sleep(80);
    expect(h.events).toHaveLength(0);
    expect(listen.connections).toHaveLength(1);
  });

  it('drops audio and does nothing at all while it was never connected', async () => {
    const listen = await startListen();
    const { ears, h } = makeEars(options(listen.v2Url));
    ears.sendAudio(pattern(FLUX_FRAME_BYTES));
    ears.setTurnFields({ eotThreshold: 0.9, eotTimeoutMs: 10_000 });
    ears.forceEndTurn();
    ears.close();
    ears.close();
    expect(h.events).toHaveLength(0);
    expect(listen.connections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- what Flux tells the engine

describe('FluxEars events', () => {
  it('StartOfTurn tells the engine the turn began (with its words) and is also a partial, stamped alike', async () => {
    const { conn, h } = await connected();
    conn.sendTurnInfo('StartOfTurn', { transcript: 'what' });
    await until(() => h.events.length === 2);
    expect(h.texts()).toEqual(['start:what', 'partial:what']);
    expect(h.events[0].at).toBe(h.events[1].at);
    expect(h.ticks).toContain(h.events[0].at);
  });

  it('Update is a partial, and an Update without words is nothing', async () => {
    const { conn, h } = await connected();
    conn.sendTurnInfo('Update', { transcript: 'what is' });
    conn.sendTurnInfo('Update', { transcript: '' });
    conn.sendTurnInfo('Update', { transcript: '   ' });
    conn.sendTurnInfo('Update', { transcript: 'what is paxos' });
    await until(() => h.events.length === 2);
    await sleep(30);
    expect(h.texts()).toEqual(['partial:what is', 'partial:what is paxos']);
  });

  it('EndOfTurn is the final, with its trigger and confidence, trimmed; an EndOfTurn without words is skipped', async () => {
    const { conn, h } = await connected();
    conn.sendTurnInfo('EndOfTurn', { transcript: '  What is Paxos?  ', confidence: 0.93, trigger: 'model' });
    conn.sendTurnInfo('EndOfTurn', { transcript: '', confidence: 0.9, trigger: 'timeout' });
    conn.sendTurnInfo('EndOfTurn', { transcript: 'and then', trigger: 'timeout', confidence: 0.4 });
    await until(() => h.of('final').length === 2);
    await sleep(30);
    expect(h.of('final')).toHaveLength(2);
    expect(h.of('final')[0]).toMatchObject({ text: 'What is Paxos?', info: { trigger: 'model', confidence: 0.93 } });
    expect(h.of('final')[1]).toMatchObject({ text: 'and then', info: { trigger: 'timeout', confidence: 0.4 } });
    expect(h.ticks).toContain(h.of('final')[0].at);
  });

  it('an EndOfTurn with neither trigger nor confidence is a final with no information', async () => {
    const { conn, h } = await connected();
    conn.sendJson({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'plain' });
    await until(() => h.of('final').length === 1);
    expect(h.of('final')[0].info).toEqual({});
  });

  it('reads numbers that arrive as strings', async () => {
    const { conn, h } = await connected();
    conn.sendTurnInfo('EndOfTurn', { transcript: 'as strings', confidence: 0.91, turnIndex: 3, trigger: 'manual', asStrings: true });
    conn.sendJson({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'not a number', end_of_turn_confidence: 'high', turn_index: 'x' });
    await until(() => h.of('final').length === 2);
    expect(h.of('final')[0].info).toEqual({ trigger: 'manual', confidence: 0.91 });
    expect(h.of('final')[1].info).toEqual({});
  });

  it('passes EagerEndOfTurn and TurnResumed on as such (the engine asks the model early on the first and drops that on the second), never as a final', async () => {
    const { conn, h } = await connected({ eagerEotThreshold: 0.45 });
    conn.sendTurnInfo('EagerEndOfTurn', { transcript: 'what is paxos', confidence: 0.6 });
    conn.sendTurnInfo('TurnResumed', { transcript: 'what is paxos and' });
    conn.sendTurnInfo('EagerEndOfTurn', { transcript: 'what is paxos and raft' });
    conn.sendTurnInfo('EndOfTurn', { transcript: 'what is paxos and raft', end_of_turn_confidence: 0.8 });
    await until(() => h.events.length === 4);
    expect(h.texts()).toEqual(['eager:what is paxos', 'resumed:', 'eager:what is paxos and raft', 'final:what is paxos and raft']);
    expect(h.of('eager').map((e) => typeof e.at)).toEqual(['number', 'number']);
  });

  it('an EagerEndOfTurn without words is not an end of turn, and a handler that does not take eager events is not told (a recognizer that was not asked for them never sends any)', async () => {
    const { conn, h } = await connected({}, { eagerEndOfTurn: undefined, turnResumed: undefined });
    conn.sendTurnInfo('EagerEndOfTurn', { transcript: '' });
    conn.sendTurnInfo('EagerEndOfTurn', { transcript: 'what is paxos' });
    conn.sendTurnInfo('TurnResumed', { transcript: 'what is paxos and' });
    conn.sendTurnInfo('Update', { transcript: 'sentinel' });
    await until(() => h.events.length === 1);
    expect(h.texts()).toEqual(['partial:sentinel']);
  });

  it('a handler that throws on an eager event does not stop the stream', async () => {
    const { conn, h } = await connected({}, { eagerEndOfTurn: () => { throw new Error('boom'); } });
    conn.sendTurnInfo('EagerEndOfTurn', { transcript: 'what is paxos' });
    conn.sendTurnInfo('Update', { transcript: 'sentinel' });
    await until(() => h.events.length === 1);
    expect(h.texts()).toEqual(['partial:sentinel']);
    expect(h.rec.at('warn').some((l) => l.obj.handler === 'eagerEndOfTurn')).toBe(true);
  });

  it('a StartOfTurn without words is not taken for speech', async () => {
    const { conn, h } = await connected();
    conn.sendTurnInfo('StartOfTurn', { transcript: '' });
    conn.sendTurnInfo('Update', { transcript: 'sentinel' });
    await until(() => h.events.length === 1);
    expect(h.texts()).toEqual(['partial:sentinel']);
  });

  it('ignores Connected, ConfigureSuccess, unknown messages and unknown events, and bad JSON', async () => {
    const { conn, h } = await connected();
    conn.sendConnected();
    conn.sendConfigureSuccess();
    conn.sendJson({ type: 'SomethingNew', x: 1 });
    conn.sendTurnInfo('SomeNewEvent', { transcript: 'words' });
    conn.sendRaw('not json');
    conn.sendRaw(Buffer.from([9, 9]), true);
    conn.sendTurnInfo('Update', { transcript: 'sentinel' });
    await until(() => h.events.length === 1);
    await sleep(30);
    expect(h.texts()).toEqual(['partial:sentinel']);
    expect(h.rec.at('warn')).toHaveLength(0);
  });

  it('a Warning is logged at warn level and the connection stays open', async () => {
    const { conn, ears, h } = await connected();
    conn.sendWarning('AUDIO_LATE', 'audio arrived late');
    conn.sendTurnInfo('Update', { transcript: 'still here' });
    await until(() => h.events.length === 1);
    expect(ears.connected).toBe(true);
    expect(h.of('down')).toHaveLength(0);
    const warn = h.rec.at('warn').find((l) => l.msg.includes('warning'));
    expect(warn?.obj).toMatchObject({ code: 'AUDIO_LATE', description: 'audio arrived late' });
  });

  it('a ConfigureFailure is logged at warn level and nothing else happens', async () => {
    const { conn, ears, h } = await connected();
    conn.sendConfigureFailure('INVALID_CONFIGURE', 'unknown field');
    conn.sendTurnInfo('Update', { transcript: 'still here' });
    await until(() => h.events.length === 1);
    expect(ears.connected).toBe(true);
    const warn = h.rec.at('warn').find((l) => l.msg.includes('refused a Configure'));
    expect(warn?.obj).toMatchObject({ code: 'INVALID_CONFIGURE', description: 'unknown field' });
  });

  it('a handler that throws does not stop the events after it', async () => {
    let calls = 0;
    const { conn, ears, h } = await connected(
      {},
      {
        startOfTurn: () => {
          calls++;
          throw new Error('barge-in handler failed');
        },
      },
    );
    conn.sendTurnInfo('StartOfTurn', { transcript: 'hey' });
    conn.sendTurnInfo('EndOfTurn', { transcript: 'hey there', confidence: 0.9, trigger: 'model' });
    await until(() => h.of('final').length === 1);
    expect(calls).toBe(1);
    // the partial that goes with the StartOfTurn was still delivered
    expect(h.texts()).toEqual(['partial:hey', 'final:hey there']);
    expect(ears.connected).toBe(true);
    expect(h.rec.at('warn').some((l) => l.msg.includes('handler threw'))).toBe(true);
  });
});

// ---------------------------------------------------------------- what the engine tells Flux

describe('FluxEars messages to Flux', () => {
  it('setTurnFields sends a Configure message with numbers', async () => {
    const { conn, ears } = await connected();
    ears.setTurnFields({ eotThreshold: 0.88, eotTimeoutMs: 8000 });
    await until(() => conn.textsOfType('Configure').length === 1);
    expect(conn.textsOfType('Configure')[0].raw).toBe('{"type":"Configure","thresholds":{"eot_threshold":0.88,"eot_timeout_ms":8000}}');
    expect(conn.textsOfType('Configure')[0].json).toEqual({ type: 'Configure', thresholds: { eot_threshold: 0.88, eot_timeout_ms: 8000 } });
  });

  it('setTurnFields keeps its numbers within what Deepgram accepts', async () => {
    const { conn, ears } = await connected();
    ears.setTurnFields({ eotThreshold: 0.2, eotTimeoutMs: 100 });
    await until(() => conn.textsOfType('Configure').length === 1);
    expect(conn.textsOfType('Configure')[0].json).toEqual({ type: 'Configure', thresholds: { eot_threshold: 0.5, eot_timeout_ms: 500 } });
  });

  it('turn fields given before the socket opens are in its URL, and no Configure follows', async () => {
    const listen = await startListen();
    const { ears } = makeEars(options(listen.v2Url));
    ears.setTurnFields({ eotThreshold: 0.9, eotTimeoutMs: 10_000 });
    await ears.connect(2000);
    const conn = await listen.connection();
    const pairs = conn.rawQuery.split('&');
    expect(pairs).toContain('eot_threshold=0.9');
    expect(pairs).toContain('eot_timeout_ms=10000');
    await sleep(40);
    expect(conn.texts).toHaveLength(0);
  });

  it('turn fields set while the handshake is still going are sent as a Configure the moment the socket opens', async () => {
    const listen = await startListen({ delayHandshakeMs: 150 });
    const { ears } = makeEars(options(listen.v2Url));
    const pending = ears.connect(3000);
    // the URL was made when connect() was called; this arrives after that and before the socket is open
    ears.setTurnFields({ eotThreshold: 0.9, eotTimeoutMs: 10_000 });
    await pending;
    const conn = await listen.connection();
    expect(conn.rawQuery.split('&')).toContain('eot_threshold=0.75');
    expect(conn.rawQuery.split('&')).toContain('eot_timeout_ms=5000');
    await until(() => conn.textsOfType('Configure').length === 1);
    await sleep(40);
    expect(conn.textsOfType('Configure')).toHaveLength(1);
    expect(conn.textsOfType('Configure')[0].json).toEqual({ type: 'Configure', thresholds: { eot_threshold: 0.9, eot_timeout_ms: 10_000 } });
  });

  it('forceEndTurn sends the audio still waiting, padded to a whole frame, and then ForceEndTurn', async () => {
    const { conn, ears } = await connected();
    ears.sendAudio(pattern(1000));
    await sleep(30);
    expect(conn.frameSizes).toEqual([]);
    ears.forceEndTurn();
    await until(() => conn.textsOfType('ForceEndTurn').length === 1);
    expect(conn.frameSizes).toEqual([FLUX_FRAME_BYTES]);
    expect(conn.frames[0].subarray(0, 1000).equals(pattern(1000))).toBe(true);
    expect(conn.frames[0].subarray(1000).every((b) => b === 0)).toBe(true);
    expect(conn.frameTimes[0]).toBeLessThanOrEqual(conn.textsOfType('ForceEndTurn')[0].at);
    expect(conn.textsOfType('ForceEndTurn')[0].raw).toBe('{"type":"ForceEndTurn"}');
  });

  it('forceEndTurn with nothing waiting sends no frame', async () => {
    const { conn, ears } = await connected();
    ears.sendAudio(pattern(FLUX_FRAME_BYTES));
    await conn.waitForFrames(1);
    ears.forceEndTurn();
    await until(() => conn.textsOfType('ForceEndTurn').length === 1);
    expect(conn.frameSizes).toEqual([FLUX_FRAME_BYTES]);
  });

  it('regroups audio of any piece size into 80 ms frames, in order, with no byte lost', async () => {
    const { conn, ears } = await connected();
    const sent = pattern(10_000);
    let offset = 0;
    for (const size of [1280, 640, 1, 2559, 3000, 17, 2503]) {
      ears.sendAudio(sent.subarray(offset, offset + size));
      offset += size;
    }
    expect(offset).toBe(10_000);
    // 10000 = 3 x 2560 + 2320
    await conn.waitForFrames(3);
    await sleep(60);
    expect(conn.frameSizes).toEqual([2560, 2560, 2560]);
    expect(conn.received().equals(sent.subarray(0, 7680))).toBe(true);
    ears.sendAudio(pattern(240, 10_000));
    await conn.waitForFrames(4);
    expect(conn.received().equals(Buffer.concat([sent, pattern(240, 10_000)]))).toBe(true);
  });

  it('sends no KeepAlive: its audio never stops while a call is up', async () => {
    const { conn } = await connected();
    await sleep(300);
    expect(conn.texts).toHaveLength(0);
  });
});
