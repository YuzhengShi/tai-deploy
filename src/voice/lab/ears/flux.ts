/**
 * The ears for Deepgram Flux (`/v2/listen`, docs/VOICE_SELFBUILT.md 5.1): the control that tells our own orchestration from the models. Flux decides where
 * a turn ends, so its `EndOfTurn` is the engine's cue to commit (`decidesTurn` is true), and its `StartOfTurn` is the barge-in signal that the live Voice
 * Agent uses. The socket handling is `WsEars`'s (v1.ts).
 *
 * The API key is read through `apiKey()` when the socket is opened, goes out only as the `Authorization` header, and appears in no URL, log line or error.
 */
import type { EarsContext, EarsHandlers, TurnFields } from '../types.js';
import { EarsSetupError, WsEars } from './v1.js';

export const FLUX_URL = 'wss://api.deepgram.com/v2/listen';
export const FLUX_MODEL = 'flux-general-en';
/** 80 ms of 16 kHz mono PCM16: the frame size Deepgram recommends for Flux. */
export const FLUX_FRAME_BYTES = 2560;

const FORCE_END_TURN = JSON.stringify({ type: 'ForceEndTurn' });

export interface FluxOptions {
  /** The websocket endpoint without a query (default `wss://api.deepgram.com/v2/listen`); the query is built here. Tests point it at a loopback fake. */
  url?: string;
  /** The key, read each time the socket is opened (never kept in this object). */
  apiKey: () => string;
  /** Course words the recognizer should expect, plain terms: one `keyterm` parameter each. */
  keyterms: string[];
  /** The confidence at which a turn ends (Deepgram takes 0.5 to 1.0). */
  eotThreshold: number;
  /** Optional: EagerEndOfTurn / TurnResumed events (0.3 to 0.9; never above `eotThreshold`), passed on to the handlers as `eagerEndOfTurn` / `turnResumed` (the engine asks the model early on them and keeps the answer back). Keep it at or below every mode's `eotThreshold`. */
  eagerEotThreshold?: number;
  /** The silence after which a turn ends whatever the confidence (Deepgram takes 500 to 60000). */
  eotTimeoutMs: number;
}

/** A number within what Deepgram accepts, or undefined for something that is not a number at all (the parameter is then left out and Deepgram's default stands). */
function within(value: number, low: number, high: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(high, Math.max(low, value));
}

/** Numbers that may arrive as strings ("0.91"). */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * The URL of a Flux stream. Every value is URL-encoded (a keyterm with a space is `%20`, not `+`), and the thresholds are brought into the ranges Deepgram
 * documents: a value outside them would make the handshake fail for the whole call. `adjusted` names what was changed, so the caller can say so.
 */
export function buildFluxUrl(opts: Pick<FluxOptions, 'url' | 'keyterms' | 'eagerEotThreshold'>, fields: TurnFields): { url: string; adjusted: string[] } {
  const adjusted: string[] = [];
  const params: Array<[string, string]> = [
    ['model', FLUX_MODEL],
    ['encoding', 'linear16'],
    ['sample_rate', '16000'],
  ];
  const eot = within(fields.eotThreshold, 0.5, 1);
  if (eot !== undefined) {
    params.push(['eot_threshold', String(eot)]);
    if (eot !== fields.eotThreshold) adjusted.push('eot_threshold');
  } else adjusted.push('eot_threshold (left out)');
  if (opts.eagerEotThreshold !== undefined) {
    // Deepgram refuses an eager threshold above the one that confirms the turn
    const eager = within(opts.eagerEotThreshold, 0.3, eot === undefined ? 0.9 : Math.min(0.9, eot));
    if (eager !== undefined) {
      params.push(['eager_eot_threshold', String(eager)]);
      if (eager !== opts.eagerEotThreshold) adjusted.push('eager_eot_threshold');
    } else adjusted.push('eager_eot_threshold (left out)');
  }
  const timeout = within(fields.eotTimeoutMs, 500, 60_000);
  if (timeout !== undefined) {
    params.push(['eot_timeout_ms', String(Math.round(timeout))]);
    if (Math.round(timeout) !== fields.eotTimeoutMs) adjusted.push('eot_timeout_ms');
  } else adjusted.push('eot_timeout_ms (left out)');
  const seen = new Set<string>();
  for (const raw of opts.keyterms) {
    const term = typeof raw === 'string' ? raw.trim() : '';
    if (term && !seen.has(term)) {
      seen.add(term);
      params.push(['keyterm', term]);
    }
  }
  // the live Voice Agent never lets Deepgram keep a student's voice; the lab does not either
  params.push(['mip_opt_out', 'true']);
  const base = new URL(opts.url ?? FLUX_URL);
  const query = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return { url: `${base.protocol}//${base.host}${base.pathname}?${query}`, adjusted };
}

export class FluxEars extends WsEars {
  readonly decidesTurn = true;
  /** The turn-taking fields as they stand: those of the options, then those of the latest `setTurnFields`. */
  private fields: TurnFields;
  /** The fields the URL of this socket was built with (when `connect()` was called). Fields set after that, while the handshake is still going, are sent as a Configure once it is open. */
  private urlFields: TurnFields | null = null;

  constructor(
    private readonly opts: FluxOptions,
    handlers: EarsHandlers,
    ctx: EarsContext,
  ) {
    super({ name: 'flux', frameBytes: FLUX_FRAME_BYTES }, handlers, ctx);
    this.fields = { eotThreshold: opts.eotThreshold, eotTimeoutMs: opts.eotTimeoutMs };
  }

  /**
   * The turn-taking fields of a new mode. On an open stream they go as a `Configure` message (the service has not been probed for this yet: a refusal is only
   * logged). Before `connect()` they are in the URL; while the handshake is going they follow as a Configure the moment the socket opens (`onOpen`).
   */
  setTurnFields(fields: TurnFields): void {
    this.fields = { eotThreshold: fields.eotThreshold, eotTimeoutMs: fields.eotTimeoutMs };
    if (this.connected) this.sendConfigure(this.fields);
  }

  protected override onOpen(): void {
    const built = this.urlFields;
    if (built && (built.eotThreshold !== this.fields.eotThreshold || built.eotTimeoutMs !== this.fields.eotTimeoutMs)) this.sendConfigure(this.fields);
  }

  private sendConfigure(fields: TurnFields): void {
    const thresholds: Record<string, number> = {};
    const eot = within(fields.eotThreshold, 0.5, 1);
    if (eot !== undefined) thresholds.eot_threshold = eot;
    const timeout = within(fields.eotTimeoutMs, 500, 60_000);
    if (timeout !== undefined) thresholds.eot_timeout_ms = Math.round(timeout);
    if (Object.keys(thresholds).length === 0) return;
    this.sendText(JSON.stringify({ type: 'Configure', thresholds }));
  }

  /** Ends the turn now. The audio still waiting in the frame goes first, so that the last syllable is in the transcript the turn ends with. */
  forceEndTurn(): void {
    this.flushTail();
    this.sendText(FORCE_END_TURN);
  }

  protected connectUrl(): string {
    const fields = { ...this.fields };
    this.urlFields = fields;
    const { url, adjusted } = buildFluxUrl(this.opts, fields);
    if (adjusted.length > 0) this.log.warn({ ears: this.name, adjusted }, 'ears: turn-taking values outside what Deepgram accepts were adjusted');
    return url;
  }

  protected connectHeaders(): Record<string, string> {
    let key = '';
    try {
      key = this.opts.apiKey();
    } catch {
      throw new EarsSetupError('flux: the Deepgram key could not be read');
    }
    if (typeof key !== 'string' || key.trim() === '') throw new EarsSetupError('flux: no Deepgram key is set');
    return { Authorization: `Token ${key.trim()}` };
  }

  protected onText(msg: Record<string, unknown>, at: number): void {
    switch (msg.type) {
      case 'TurnInfo':
        this.turnInfo(msg, at);
        return;
      case 'Connected':
        this.log.debug({ ears: this.name, requestId: typeof msg.request_id === 'string' ? msg.request_id : undefined }, 'ears: Flux connected');
        return;
      case 'ConfigureSuccess':
        this.log.debug({ ears: this.name }, 'ears: Flux applied a Configure');
        return;
      case 'ConfigureFailure':
        this.log.warn({ ears: this.name, code: this.field(msg.code), description: this.field(msg.description) }, 'ears: Flux refused a Configure');
        return;
      case 'Warning':
        // the connection stays open
        this.log.warn({ ears: this.name, code: this.field(msg.code), description: this.field(msg.description) }, 'ears: Flux warning');
        return;
      case 'Error':
        this.goDown(`Deepgram error ${this.field(msg.code)}: ${this.field(msg.description)}`);
        return;
      default:
        this.log.debug({ ears: this.name, type: typeof msg.type === 'string' ? msg.type.slice(0, 40) : undefined }, 'ears: an unknown Flux message was ignored');
    }
  }

  private turnInfo(msg: Record<string, unknown>, at: number): void {
    const text = typeof msg.transcript === 'string' ? msg.transcript.trim() : '';
    switch (msg.event) {
      case 'StartOfTurn':
        // Flux's own onset, with words in it: the reliable barge-in signal. One without words is not what the documentation promises, and taking it
        // for speech would cut the agent off for a noise
        if (!text) return;
        this.safely('startOfTurn', () => this.handlers.startOfTurn?.(at, text));
        this.safely('partial', () => this.handlers.partial(text, at));
        return;
      case 'Update':
        if (text) this.safely('partial', () => this.handlers.partial(text, at));
        return;
      case 'EndOfTurn': {
        if (!text) {
          this.log.debug({ ears: this.name }, 'ears: an EndOfTurn without words was skipped');
          return;
        }
        const info: { trigger?: string; confidence?: number } = {};
        if (typeof msg.trigger === 'string' && msg.trigger) info.trigger = msg.trigger;
        const confidence = numeric(msg.end_of_turn_confidence);
        if (confidence !== undefined) info.confidence = confidence;
        this.safely('final', () => this.handlers.final(text, at, info));
        return;
      }
      case 'EagerEndOfTurn':
        // only a stream opened with an eager threshold gets these; the turn is still committed at EndOfTurn: this is the engine's cue to ask the model early (a guess, never acted on)
        if (text) this.safely('eagerEndOfTurn', () => this.handlers.eagerEndOfTurn?.(text, at));
        return;
      case 'TurnResumed':
        this.safely('turnResumed', () => this.handlers.turnResumed?.(at));
        return;
      default:
        this.log.debug({ ears: this.name, event: typeof msg.event === 'string' ? msg.event.slice(0, 40) : undefined }, 'ears: an unknown TurnInfo event was ignored');
    }
  }

  /** A server-supplied code or description, as text that is safe in a log line. */
  private field(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? this.scrub(String(value)) : '';
  }
}
