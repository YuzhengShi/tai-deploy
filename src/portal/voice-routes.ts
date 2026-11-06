/**
 * The page's one voice route besides the call itself (the WebSocket at /api/voice): a head start for the call's tool host.
 *
 *   POST /api/voice/warm   {}  ->  { ok, state }
 *
 * The call's tool host is a container that takes ten seconds or more to come up (docs/VOICE.md), and a call starts it the moment it begins.
 * The browser, meanwhile, spends a second or three on the microphone's permission prompt, which is free time: the page sends this when the
 * call button (or the chevron beside it) is pressed, BEFORE it asks for the microphone, and the hub starts the student's host then. The
 * answer comes at once and says only whether a host was started (`warming`), is waiting already (`warm`) or why not (`active`, `recent`, `budget`,
 * `busy`, `full`, `off`: src/voice/hub.ts VoiceWarmResult); the page ignores it and a failure is silent, because a call that was not warmed
 * works exactly as it did. It is for the signed-in student's own host only: the folder comes from the session, never from the request.
 *
 * The server does the checks of its own routes before this handler (a POST must be JSON with the page's header and origin, the cookie, the
 * per-student read limit), and the hub adds its own: voice on, no call open, a room in the pool, at most one start a minute per student.
 */
import type { PortalRoute, PortalVoice } from './server.js';

export interface VoiceRoutesDeps {
  /** The voice side, or null when voice calls are off (the route then answers `off`: there is nothing to start). */
  voice: PortalVoice | null;
}

export function voiceRoutes(deps: VoiceRoutesDeps): PortalRoute[] {
  return [
    {
      path: '/api/voice/warm',
      method: 'POST',
      access: 'student',
      async handler(ctx) {
        // the body is {} and says nothing; it is read so that a request that is not JSON is the server's 400 and nothing is left unread on the connection
        await ctx.readJson();
        const voice = deps.voice;
        if (!voice || typeof voice.warm !== 'function') return ctx.json(200, { ok: false, state: 'off' });
        let result: { ok: boolean; state: string };
        try {
          result = voice.warm(ctx.user);
        } catch {
          result = { ok: false, state: 'off' };
        }
        ctx.json(200, { ok: result.ok === true, state: typeof result.state === 'string' ? result.state.slice(0, 24) : 'off' });
      },
    },
  ];
}
