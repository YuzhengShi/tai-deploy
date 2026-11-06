// A pretend voice side for the dev server (what src/voice/hub.ts is to the live page): it speaks the browser protocol of docs/VOICE.md,
// "Browser protocol (WebSocket /api/voice)", over a real WebSocket, so the page's call client can be driven end to end without Deepgram.
//
// It answers "start" with "ready", status changes and a spoken greeting (a real 24 kHz PCM16 sine tone, in chunks of uneven and sometimes
// odd sizes), echoes what is typed in the chat during a call, and does on demand what a real call does now and then: talk at length and
// be interrupted, switch to the interviewer, drop the connection, end. It measures what the browser sends: the binary frames' sizes and
// rate, their loudness, and their pitch (the zero crossings of the 16 kHz stream, which show whether the page resampled at the right ratio).
//
// What is said in the call reaches the page the way the real hub does it (docs/PORTAL.md, "Voice calls"): as lines of kind `speech` in the
// student's history (the words of a turn, role user for the student and assistant for TAi, with the id of the call; and markers with an
// `event`: `start` with the kind of call, `mode` when it switches, `end` with its length in seconds), through the history and the poll.
// The socket still sends its transcripts, which the page does not draw. The call's summary card follows the end marker a little later.
import { WebSocketServer } from 'ws';

const OUT_RATE = 24000;
const IN_RATE = 16000;
const RESUME_MS = 30000;
const CARD_DELAY_MS = 1200;         // how long after the end marker the call's card in the activity list is written

/** PCM16 little-endian mono at 24 kHz: a sine tone with 10 ms fades at both ends. */
export function tone(ms, freq = 330, amp = 0.3) {
  const n = Math.round((OUT_RATE * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  const fade = OUT_RATE * 0.01;
  for (let i = 0; i < n; i++) {
    const envelope = Math.min(1, i / fade, (n - 1 - i) / fade);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / OUT_RATE) * amp * envelope * 32767), i * 2);
  }
  return buf;
}

export class FakeVoice {
  /** history: the page's HistoryStore (a call's summary goes there); wake(folder): tells the page's pollers to look. */
  constructor({ history, wake }) {
    this.history = history;
    this.wake = wake;
    this.wss = new WebSocketServer({ noServer: true });
    this.sessions = new Map();          // folder -> the live call (kept 30 s after a drop, to be resumed)
    this.nextError = '';                // the next "start" is refused with this code
    this.resumeDelay = 0;               // how long a "start" with resume waits before "ready" (to see the page reconnecting)
    this.reset();
  }

  reset() {
    this.stats = { connections: 0, starts: [], mutes: [], ends: 0, pings: 0, injected: [], frames: 0, sizes: {}, times: [], samples: 0, sumSq: 0, crossings: 0, sign: 0, warms: [], order: [] };
  }

  /**
   * POST /api/voice/warm (src/portal/voice-routes.ts): the page says a call is about to start, before it asks for the microphone. Recorded, with the order
   * of warm-ups and starts (`order`), so that a test can see the warm-up came first; the answer is the hub's own words (`warming`, then `warm`, `active`).
   */
  warm(user) {
    const state = this.sessions.has(user.folder) ? 'active' : this.stats.warms.some((w) => w.folder === user.folder) ? 'warm' : 'warming';
    this.stats.warms.push({ folder: user.folder, state });
    this.stats.order.push('warm');
    return { ok: state !== 'active', state };
  }

  // ---- the PortalVoice interface (src/portal/server.ts)

  upgrade(req, socket, head, user) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connection(ws, user));
  }

  async relay(_req, res) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"the dev server has no thinking relay"}}');
  }

  isActive(folder) {
    return this.sessions.has(folder);
  }

  /** A line of a call in the student's history, as the real hub appends one (kind speech); the page's pollers are told. */
  line(folder, role, text, extra = {}) {
    const entry = this.history.forFolder(folder).append(role, text, new Date(), { kind: 'speech', ...extra });
    this.wake(folder);
    return entry;
  }

  spoken(s, role, text) {
    return this.line(s.folder, role, text, { call: s.id });
  }

  marker(s, event, extra = {}) {
    return this.line(s.folder, 'assistant', '', { call: s.id, event, ...extra });
  }

  inject(folder, text) {
    const s = this.sessions.get(folder);
    if (!s || !s.ws) return false;
    this.stats.injected.push(text);
    // typed words are in the chat as typed words (the server put them there): the call hears them, and answers by voice; no line of speech for them
    this.send(s, { type: 'status', state: 'thinking' });
    this.later(s, () => this.say(s, `You wrote "${text.slice(0, 60)}". Let's talk that through: what do you think happens first?`, 900), 500);
    return true;
  }

  // ---- one socket

  connection(ws, user) {
    this.stats.connections++;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.measure(data);
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const s = this.sessions.get(user.folder);
      const mine = s && s.ws === ws;
      if (msg.type === 'start') this.start(ws, user, msg);
      else if (msg.type === 'mute') this.stats.mutes.push(!!msg.muted);
      else if (msg.type === 'ping') this.stats.pings++;
      else if (msg.type === 'end') {
        this.stats.ends++;
        if (mine) this.close(s, 'user');
      }
    });
    ws.on('close', () => {
      const s = this.sessions.get(user.folder);
      if (!s || s.ws !== ws) return;
      // the browser went without saying goodbye: the call stays for 30 s, to be taken up again
      s.ws = null;
      this.silence(s);
      s.expire = setTimeout(() => this.forget(s), RESUME_MS);
    });
  }

  start(ws, user, msg) {
    this.stats.order.push('start');
    this.stats.starts.push({ mode: msg.mode, resume: msg.resume === true, token: typeof msg.token === 'string' ? msg.token : undefined, topic: typeof msg.topic === 'string' ? msg.topic : undefined });
    const refuse = (code, message) => {
      ws.send(JSON.stringify({ type: 'error', code, message }));
      ws.close(1000);
    };
    if (this.nextError) {
      const code = this.nextError;
      this.nextError = '';
      return refuse(code, 'refused by the dev server');
    }
    const existing = this.sessions.get(user.folder);
    if (msg.resume === true && existing && !existing.ws) {
      if (this.resumeDelay > 0) {
        // the network is still bad: this attempt goes nowhere, the next one gets through
        const wait = this.resumeDelay;
        this.resumeDelay = 0;
        setTimeout(() => ws.terminate(), wait);
        return;
      }
      clearTimeout(existing.expire);
      existing.ws = ws;
      ws.send(JSON.stringify({ type: 'ready', sessionId: existing.id, mode: existing.mode, voice: existing.voice, maxSeconds: existing.maxSeconds, resumed: true }));
      this.send(existing, { type: 'status', state: 'listening' });
      return;
    }
    if (existing && existing.ws) return refuse('busy', 'a call is already on');
    if (existing) this.forget(existing);
    if (msg.mode === 'interview' && (!msg.token || /expired|bad/.test(msg.token))) return refuse('bad-token', 'that interview link is not valid any more');
    const interview = msg.mode === 'interview';
    const listener = msg.mode === 'talk';                 // "Talk it through": TAi listens while the student explains something
    const s = {
      id: Math.random().toString(16).slice(2), folder: user.folder, ws, started: Date.now(), timers: new Set(), expire: 0,
      mode: interview ? 'interviewer' : listener ? 'listener' : 'conversational',
      voice: interview ? 'aura-2-mars-en' : listener ? 'aura-2-luna-en' : 'aura-2-thalia-en',
      maxSeconds: interview || listener ? 900 : 1800,
    };
    this.sessions.set(user.folder, s);
    this.send(s, { type: 'ready', sessionId: s.id, mode: s.mode, voice: s.voice, maxSeconds: s.maxSeconds, resumed: false });
    this.send(s, { type: 'status', state: 'listening' });
    this.marker(s, 'start', { mode: s.mode });
    this.timer(s);
    s.clock = setInterval(() => this.timer(s), 5000);
    const first = (user.name || '').split(/\s+/)[0] || 'there';
    const greeting = interview
      ? "Let's begin. Tell me about a distributed system you have built, and how it failed."
      : listener
        ? `Go ahead, ${first}. Explain it in your own words, and I will listen.`
        : `Hi ${first}! What would you like to talk through?`;
    this.later(s, () => this.say(s, greeting, 1200), 400);
  }

  // ---- what the pretend agent does

  send(s, message) {
    if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(message));
  }

  later(s, fn, ms) {
    const t = setTimeout(() => {
      s.timers.delete(t);
      fn();
    }, ms);
    s.timers.add(t);
  }

  silence(s) {
    for (const t of s.timers) clearTimeout(t);
    s.timers.clear();
  }

  timer(s) {
    const elapsed = Math.round((Date.now() - s.started) / 1000);
    const msg = { type: 'timer', elapsedSec: elapsed, remainingSec: Math.max(0, s.maxSeconds - elapsed) };
    if (s.mode === 'interviewer') msg.interviewRemainingSec = Math.max(0, 900 - elapsed);
    this.send(s, msg);
  }

  /** TAi speaks: "speaking", the caption, the audio (paced at twice real time, or all at once), then "listening" again. */
  say(s, text, ms, { paced = true } = {}) {
    if (!s.ws) return;
    this.send(s, { type: 'status', state: 'speaking' });
    this.send(s, { type: 'transcript', role: 'agent', text, mode: s.mode });
    this.spoken(s, 'assistant', text);
    const pcm = tone(ms, s.mode === 'interviewer' ? 220 : 330);
    // uneven chunk sizes, two of them odd: a sample can be split between two frames, and the page must join it again
    const sizes = [4800, 2401, 2399, 3600, 1200];
    const chunks = [];
    for (let at = 0, k = 0; at < pcm.length; k++) {
      const size = sizes[k % sizes.length];
      chunks.push(pcm.subarray(at, at + size));
      at += size;
    }
    let when = 0;
    for (const chunk of chunks) {
      if (paced) {
        this.later(s, () => s.ws && s.ws.send(chunk), when);
        when += ((chunk.length / 2 / OUT_RATE) * 1000) / 2;
      } else if (s.ws) {
        s.ws.send(chunk);
      }
    }
    this.later(s, () => this.send(s, { type: 'status', state: 'listening' }), paced ? when + ms / 2 + 100 : ms + 100);
  }

  /** TAi talks at length (four seconds, sent at once, as Deepgram may), and the student talks over it. */
  interrupt(s, afterMs = 700) {
    this.silence(s);
    this.say(s, 'Raft elects a leader with randomized timeouts; each node waits a little while, and the first to time out asks the others for their votes, and', 4000, { paced: false });
    this.silence(s);                    // no "listening" from say(): the barge-in below says what comes next
    this.later(s, () => {
      this.send(s, { type: 'agent_interrupted' });
      this.send(s, { type: 'status', state: 'listening' });
    }, afterMs);
  }

  toInterviewer(s) {
    s.mode = 'interviewer';
    s.voice = 'aura-2-mars-en';
    this.send(s, { type: 'mode', mode: 'interviewer', voice: s.voice });
    this.marker(s, 'mode', { mode: 'interviewer' });
    this.timer(s);
    this.later(s, () => this.say(s, 'This is now a mock interview. First question: how does Raft keep a log consistent across a leader change?', 900), 300);
  }

  /** TAi switches the call to "Talk it through" in the middle of it (the student asked to explain something out loud). */
  toListener(s) {
    s.mode = 'listener';
    s.voice = 'aura-2-luna-en';
    this.send(s, { type: 'mode', mode: 'listener', voice: s.voice });
    this.marker(s, 'mode', { mode: 'listener' });
    this.timer(s);
    this.later(s, () => this.say(s, 'Go ahead. Explain it in your own words, and I will listen.', 900), 300);
  }

  /**
   * The call ends: "closed" with a summary, and the call in the student's activity list (a line of kind `activity`, as the real hub appends it: a
   * title, one line, and the longer account as its detail; `legacy`: the long summary of the older kind, `voice`, that older histories hold),
   * then the socket closes.
   */
  close(s, reason = 'agent', { legacy = false } = {}) {
    const minutes = Math.max(1, Math.round((Date.now() - s.started) / 60000));
    const summary = `Voice session, ${minutes} min: we talked through Raft leader election and what happens when two candidates split the vote. Next time: log replication.`;
    this.marker(s, 'end', { seconds: Math.round((Date.now() - s.started) / 1000) });
    this.send(s, { type: 'closed', reason, summary });
    // the call's account in the activity list comes a little after the end of the call, as the real hub's does (it is written once the call is saved)
    const folder = s.folder;
    const mode = s.mode;
    setTimeout(() => {
      const log = this.history.forFolder(folder);
      if (legacy) {
        log.append('assistant', summary, new Date(), { kind: 'voice' });
      } else {
        const type = mode === 'interviewer' ? 'interview' : mode === 'listener' ? 'talk' : 'voice';
        const title = { voice: 'Voice call', interview: 'Mock interview', talk: 'Talk it through' }[type];
        const gist = {
          voice: 'Talked through Raft leader election and split votes',
          interview: 'Mock interview on Raft: clear on elections, thin on log replication',
          talk: 'You talked Raft leader election through, out loud',
        }[type];
        const detail = ['We talked through Raft leader election and what happens when two candidates split the vote.', 'In the chat: 1 diagram.', 'Progress: Raft elections, just started to getting there.', 'Next time: log replication.'].join('\n');
        log.append('assistant', gist, new Date(), { kind: 'activity', type, title: `${title} · ${minutes} min`, detail });
      }
      this.wake(folder);
    }, CARD_DELAY_MS);
    const ws = s.ws;
    this.forget(s);
    if (ws) setTimeout(() => ws.readyState === 1 && ws.close(1000), 50);
  }

  /**
   * The student speaks: the server hears them begin (`agent_interrupted`, as the real hub sends it for every start of speech), and `afterMs` later
   * the words of the turn are final: a line of their speech in the history, the transcript on the socket, "thinking". `reply`: TAi answers by voice.
   */
  userSays(s, text, afterMs = 300, reply = false) {
    this.userSpeaking(s);
    this.later(s, () => {
      this.spoken(s, 'user', text);
      this.send(s, { type: 'transcript', role: 'user', text, mode: s.mode });
      this.send(s, { type: 'status', state: 'thinking' });
      if (reply) this.later(s, () => this.say(s, `I heard you say "${text.slice(0, 60)}". Tell me more about it.`, 900), 500);
    }, afterMs);
  }

  /** The student begins to speak (and nothing final follows yet). */
  userSpeaking(s) {
    this.send(s, { type: 'agent_interrupted' });
    this.send(s, { type: 'status', state: 'listening' });
  }

  /** The network goes: the socket is cut without a close frame. */
  drop(s) {
    if (s.ws) s.ws.terminate();
  }

  forget(s) {
    this.silence(s);
    clearInterval(s.clock);
    clearTimeout(s.expire);
    if (this.sessions.get(s.folder) === s) this.sessions.delete(s.folder);
  }

  // ---- what the browser sends

  measure(buf) {
    const st = this.stats;
    st.frames++;
    st.sizes[buf.length] = (st.sizes[buf.length] || 0) + 1;
    st.times.push(Date.now());
    if (st.times.length > 500) st.times.shift();
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const v = buf.readInt16LE(i);
      st.samples++;
      st.sumSq += (v / 32768) ** 2;
      // zero crossings with a little hysteresis, so noise around zero does not count
      if (v > 400 && st.sign !== 1) {
        if (st.sign === -1) st.crossings++;
        st.sign = 1;
      } else if (v < -400 && st.sign !== -1) {
        if (st.sign === 1) st.crossings++;
        st.sign = -1;
      }
    }
  }

  report() {
    const st = this.stats;
    const span = st.times.length > 1 ? (st.times[st.times.length - 1] - st.times[0]) / 1000 : 0;
    const seconds = st.samples / IN_RATE;
    return {
      connections: st.connections, starts: st.starts, mutes: st.mutes, ends: st.ends, pings: st.pings, injected: st.injected,
      frames: st.frames, sizes: st.sizes, fps: span > 0 ? (st.times.length - 1) / span : 0, seconds,
      rms: st.samples ? Math.sqrt(st.sumSq / st.samples) : 0, pitch: seconds > 0 ? st.crossings / 2 / seconds : 0,
      live: [...this.sessions.values()].map((s) => ({ mode: s.mode, connected: !!s.ws })),
      warms: st.warms, order: st.order,
    };
  }

  /** What the dev server's control port can ask of the call of `folder`. */
  command(folder, name, params) {
    if (name === 'next-error') {
      this.nextError = params.get('code') || 'busy';
      return true;
    }
    // lines of a call in the history, with no call on: a long one that was made before, a marker, one line with the words the test gives it
    if (name === 'lines') {
      const count = Math.max(1, Math.min(2000, parseInt(params.get('count') || '10', 10)));
      const call = params.get('call') || 'earlier';
      for (let i = 0; i < count; i++) this.line(folder, i % 2 ? 'assistant' : 'user', `Spoken line ${i + 1}: a few words about Raft terms and who leads them.`, { call });
      return true;
    }
    if (name === 'line') {
      this.line(folder, params.get('role') === 'user' ? 'user' : 'assistant', params.get('text') || 'Something said aloud.', { call: params.get('call') || 'earlier' });
      return true;
    }
    if (name === 'marker') {
      const seconds = params.get('seconds');
      this.line(folder, 'assistant', '', { call: params.get('call') || 'earlier', event: params.get('event') || 'start', ...(params.get('mode') ? { mode: params.get('mode') } : {}), ...(seconds ? { seconds: parseInt(seconds, 10) } : {}) });
      return true;
    }
    const s = this.sessions.get(folder);
    if (!s) return false;
    switch (name) {
      case 'user-says':
        this.userSays(s, params.get('text') || 'my leader keeps changing', parseInt(params.get('after') || '300', 10), params.get('reply') === '1');
        return true;
      case 'user-speaking':
        this.userSpeaking(s);
        return true;
      case 'speak':
        this.say(s, params.get('text') || 'Here is a thought about consensus.', parseInt(params.get('ms') || '1200', 10), { paced: params.get('paced') !== '0' });
        return true;
      case 'interrupt':
        this.interrupt(s, parseInt(params.get('after') || '700', 10));
        return true;
      case 'interviewer':
        this.toInterviewer(s);
        return true;
      case 'listener':
        this.toListener(s);
        return true;
      case 'status':
        this.send(s, { type: 'status', state: params.get('state') || 'thinking' });
        return true;
      case 'notice':
        this.send(s, { type: 'notice', text: params.get('text') || 'Dropped image: I cannot see images' });
        return true;
      case 'error':
        this.send(s, { type: 'error', code: params.get('code') || 'mic', message: params.get('message') || '' });
        return true;
      case 'timer':
        this.timer(s);
        return true;
      case 'drop':
        this.drop(s);
        return true;
      case 'close':
        this.close(s, params.get('reason') || 'agent', { legacy: params.get('legacy') === '1' });
        return true;
      default:
        return false;
    }
  }
}
