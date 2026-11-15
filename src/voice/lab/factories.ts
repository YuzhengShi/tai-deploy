/**
 * The real ears and mouths of the lab, built from its configuration (docs/VOICE_SELFBUILT.md section 5): LabGPU's recognizer and synthesizer, and Deepgram's Flux, nova-3 and Aura as the
 * controls and fallbacks. The only place that knows which class goes with which setting; the agent asks for a kind and gets a part.
 */
import type { VoiceLog } from '../types.js';
import type { LabAgentDeps } from './agent.js';
import type { LabConfig } from './config.js';
import { FluxEars } from './ears/flux.js';
import { V1Ears } from './ears/v1.js';
import { AuraMouth } from './mouth/aura.js';
import { LabGPUMouth } from './mouth/labgpu.js';
import { FluxTtsMouth } from './mouth/flux.js';
import type { LabClock } from './types.js';

/** What LabGPU's adapter takes (20 ms) and what Deepgram wants (80 ms). */
const LABGPU_FRAME_BYTES = 640;
const DEEPGRAM_FRAME_BYTES = 2560;

/** nova-3's address: the live Settings' keyterms, `endpointing` short (it is the control that finalises fast), no key in the address (it goes in a header). */
export function novaUrl(base: string, keyterms: string[]): string {
  const u = new URL(base);
  u.search = '';
  // (a space in a keyterm is %20, as Deepgram's examples and Nora's production URL have it; URLSearchParams would write +)
  const fixed = { model: 'nova-3', encoding: 'linear16', sample_rate: '16000', interim_results: 'true', endpointing: '300', utterance_end_ms: '1000', vad_events: 'true', mip_opt_out: 'true' };
  const parts = Object.entries(fixed).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  for (const k of keyterms.slice(0, 100)) parts.push(`keyterm=${encodeURIComponent(k)}`);
  u.search = parts.join('&');
  return u.toString();
}

export function defaultFactories(cfg: LabConfig, deepgramKey: () => string, log: VoiceLog, clock: LabClock): Pick<LabAgentDeps, 'makeEars' | 'makeMouth'> {
  return {
    makeEars: (kind, handlers, ctx) => {
      const c = { clock, log };
      if (kind === 'labgpu') return new V1Ears({ name: 'labgpu', url: cfg.earsUrl, frameBytes: LABGPU_FRAME_BYTES }, handlers, c);
      if (kind === 'nova') {
        return new V1Ears(
          { name: 'nova', url: () => novaUrl(cfg.novaUrl, ctx.keyterms), headers: () => ({ Authorization: `Token ${deepgramKey()}` }), frameBytes: DEEPGRAM_FRAME_BYTES, keepAliveMs: 4000 },
          handlers,
          c,
        );
      }
      return new FluxEars(
        { url: cfg.fluxUrl, apiKey: deepgramKey, keyterms: ctx.keyterms, eotThreshold: ctx.turn.eotThreshold, eotTimeoutMs: ctx.turn.eotTimeoutMs, ...(ctx.eagerEot ? { eagerEotThreshold: ctx.eagerEot } : {}) },
        handlers,
        c,
      );
    },
    makeMouth: (kind) => {
      if (kind === 'labgpu') return new LabGPUMouth({ baseUrl: cfg.ttsUrl, voices: [cfg.labgpuVoice] });
      if (kind === 'flux') return new FluxTtsMouth({ apiKey: deepgramKey, baseUrl: cfg.fluxTtsUrl, log });
      return new AuraMouth({ apiKey: deepgramKey, baseUrl: cfg.auraUrl });
    },
  };
}
