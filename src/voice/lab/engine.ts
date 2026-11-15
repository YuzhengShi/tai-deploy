/**
 * The voice lab's listeners (docs/VOICE_SELFBUILT.md sections 3 and 4): the stand-in for Deepgram's agent endpoint that `VoiceSession` connects to, and the loopback door to the hub's own
 * relay. Both are bound to 127.0.0.1 on ephemeral ports; the first answers only the token the hub gave the session (compared in constant time), and the second does nothing but hand the
 * request to `hub.relay`, so the think step of a lab call is exactly a live call's, without leaving the machine. Nothing is started unless `TAI_VOICE_LAB=1` (the hub decides).
 */
import { timingSafeEqual } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

import { WebSocketServer, type WebSocket } from 'ws';

import type { VoiceLog } from '../types.js';
import { LabAgent, newToken, type LabAgentDeps } from './agent.js';
import { forChain, isChainName, type LabConfig } from './config.js';
import { defaultFactories } from './factories.js';
import { PcmCache } from './mouth/cache.js';
import { fileSink, nullSink } from './trace.js';
import type { LabClock, TurnFields, TurnProfile } from './types.js';

export interface LabEngineDeps {
  config: LabConfig;
  /** The turn-taking fields the session sends in each mode (the hub's VoiceConfig), so that a Settings can be told which mode it is for. */
  profiles: Record<TurnProfile, TurnFields>;
  /** The hub's relay (src/voice/relay.ts through `Hub.relay`): the loopback listener calls it. */
  relay: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** The Deepgram key, read when a part needs it (Flux, nova, Aura): never logged, never sent to the stand-in's own socket. */
  deepgramKey: () => string;
  log: VoiceLog;
  /** Where the per-turn trace goes ('' = nowhere). */
  traceFile: string;
  clock?: LabClock;
  wallNow?: () => number;
  fetchImpl?: typeof fetch;
  /** Tests: other ears and mouths than the real ones. */
  factories?: Pick<LabAgentDeps, 'makeEars' | 'makeMouth'>;
}

/** The chain a call asked for: `?chain=h` on the stand-in's address (the hub puts it there from the owner's request); anything else is none. */
function chainOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://stand-in.invalid').searchParams.get('chain');
  } catch {
    return null;
  }
}

const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class LabEngine {
  /** ws://127.0.0.1:<port>/v1/agent/converse: what a lab session's `deepgramUrl` is. */
  readonly agentUrl: string;
  /** The same for a call that asked for a chain (`?chain=d|h|fd|c|cf|lf`, docs A10); any other value is the plain address. */
  agentUrlFor(chain: string | null | undefined): string {
    return isChainName(chain) ? `${this.agentUrl}?chain=${chain}` : this.agentUrl;
  }
  /** http://127.0.0.1:<port>/voice-llm/v1/chat/completions: what a lab session's relay URL is (the Settings carry it, and the stand-in refuses any other). */
  readonly relayUrl: string;
  /** What the session sends as its "Deepgram key" (`Authorization: Token <token>`): per process, random, never the real key. */
  readonly token: string;
  private readonly agents = new Set<LabAgent>();
  private closed = false;

  private constructor(
    private readonly deps: LabEngineDeps,
    private readonly agentServer: http.Server,
    private readonly relayServer: http.Server,
    private readonly wss: WebSocketServer,
    token: string,
    agentPort: number,
    relayPort: number,
  ) {
    this.token = token;
    this.agentUrl = `ws://127.0.0.1:${agentPort}/v1/agent/converse`;
    this.relayUrl = `http://127.0.0.1:${relayPort}/voice-llm/v1/chat/completions`;
  }

  static async start(deps: LabEngineDeps): Promise<LabEngine> {
    const token = newToken();
    const cache = new PcmCache();
    const trace = deps.traceFile ? fileSink(deps.traceFile, deps.log) : nullSink;
    const factories = deps.factories ?? defaultFactories(deps.config, deps.deepgramKey, deps.log, deps.clock ?? (() => performance.now()));
    const agentServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server: agentServer, perMessageDeflate: false, maxPayload: 1024 * 1024 });
    const relayServer = http.createServer((req, res) => {
      void deps.relay(req, res).catch(() => {
        try {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        } catch {
          /* gone */
        }
      });
    });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        agentServer.once('error', reject);
        agentServer.listen(0, '127.0.0.1', () => resolve());
      }),
      new Promise<void>((resolve, reject) => {
        relayServer.once('error', reject);
        relayServer.listen(0, '127.0.0.1', () => resolve());
      }),
    ]);
    const engine = new LabEngine(deps, agentServer, relayServer, wss, token, (agentServer.address() as AddressInfo).port, (relayServer.address() as AddressInfo).port);
    wss.on('error', (err) => deps.log.warn({ err: err.message }, 'voice lab: websocket server error'));
    wss.on('connection', (ws: WebSocket, req) => {
      const auth = String(req.headers.authorization ?? '');
      if (engine.closed || !eq(auth, `Token ${token}`)) {
        ws.close(1008, 'unauthorized');
        return;
      }
      const agent = new LabAgent({
        ws,
        config: forChain(deps.config, chainOf(req.url)),
        clock: deps.clock ?? (() => performance.now()),
        wallNow: deps.wallNow,
        log: deps.log,
        relayUrl: engine.relayUrl,
        profiles: deps.profiles,
        makeEars: factories.makeEars,
        makeMouth: factories.makeMouth,
        haveDeepgramKey: () => {
          try {
            return !!deps.deepgramKey();
          } catch {
            return false;
          }
        },
        cache,
        trace,
        fetchImpl: deps.fetchImpl,
      });
      engine.agents.add(agent);
      ws.on('close', () => engine.agents.delete(agent));
    });
    deps.log.info({ ears: deps.config.ears, mouth: deps.config.mouth, fallback: deps.config.earsFallback }, 'voice lab: the stand-in is listening on loopback');
    return engine;
  }

  /** Calls connected to the stand-in now (for the hub's checks and the tests). */
  get calls(): number {
    return this.agents.size;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const a of [...this.agents]) a.close();
    this.agents.clear();
    try {
      this.wss.close();
    } catch {
      /* closed */
    }
    for (const server of [this.agentServer, this.relayServer]) {
      (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
