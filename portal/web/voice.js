// The microphone side of the page: the voice call's client (docs/VOICE.md, "Browser protocol (WebSocket /api/voice)") and the voice-note
// recorder. app.js draws the buttons (only when the server offers the feature) and hands over a toast and what to do with a recording.
//
// A call: the microphone goes through an AudioWorklet (voice-worklet.js) that resamples it to 16 kHz mono PCM16 and hands over 40 ms frames
// (1280 bytes), which go to the WebSocket as binary once the server says "ready". TAi's speech comes back as 24 kHz PCM16 binary frames:
// they are resampled here to the AudioContext's rate (one resampler for the whole stream, so the chunks join without a seam) and scheduled
// back to back after a small jitter buffer; "agent_interrupted" (the student talked over TAi) stops everything queued at once. A connection
// that drops in the middle of a call is taken up again for 30 s ({"type":"start","resume":true}). The microphone, the AudioContext and the
// socket are let go when the call ends, is closed by the server, or the page goes away.
//
// What a call looks like: an orb above the message box (its state, how loud the student and TAi are, the time, the kind of call), and, in the
// message box, the call's two buttons (mute and end). The words of the call are not drawn here: the history carries them as lines of kind
// `speech` and app.js draws those in the conversation (speech.js); the transcripts the socket sends only tell app.js that the student is
// speaking, for the "..." that stands for words that have not come back as a line yet (`onSpeaking`).
//
// A voice note: the same microphone, recorded by a MediaRecorder (Opus in WebM, MP4 on Safari) while a bar shows the time and the level; send
// hands the recording to app.js, which shows it as the student's own message and uploads it (notes.js draws it, the server turns it into words).

import { NOTE_PEAKS, clock, peaksFromLevels } from './notes.js';

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
const IN_RATE = 16000;              // what the server takes
const FRAME_SAMPLES = 640;          // 40 ms at 16 kHz: 1280 bytes
const OUT_RATE = 24000;             // what the server sends
const JITTER_S = 0.08;              // how far ahead the first chunk of a burst is scheduled
const RESUME_WINDOW_MS = 30000;
const PING_MS = 15000;
const MAX_BUFFERED_BYTES = 128 * 1024;
const NOTE_SECONDS = 180;           // the longest a voice note may be (the server says the same in GET api/me: features.voiceNoteSeconds)
const NOTE_BITS_PER_SECOND = 32000; // speech needs no more: three minutes are well under a megabyte
const MIN_NOTE_SECONDS = 0.6;       // a press of the microphone button that was not meant is not sent
const LEVEL_BARS = 72;              // bars of the live level (more than fit on a phone: the oldest are cut off at the left)
const LEVEL_EVERY_MS = 80;
const STATES = new Set(['listening', 'thinking', 'speaking', 'working']);
// the errors after which the call cannot go on (any error before "ready" also ends it: the call never started)
const FATAL = new Set(['not-configured', 'busy', 'budget', 'deepgram']);
// what the page asks for (chat, interview, talk) and the mode the server runs the call in; the interviewer and the listener have a badge
const SERVER_MODES = new Map([['chat', 'conversational'], ['interview', 'interviewer'], ['talk', 'listener']]);
const BADGES = new Map([['interviewer', 'Mock interview'], ['listener', 'Talk it through']]);
const TOPIC_CHARS = 200;            // the longest topic a "talk it through" call is started with
const VOICE_LEVEL = 0.15;           // a reading of the microphone (0 to 1) above which the student is audibly speaking
const VOICE_EVERY_MS = 400;         // how often that is passed on
const WARM_EVERY_MS = 30000;        // the page tells the server a call is coming at most this often (the server allows one a minute)
const OUT_METER_MS = 50;            // how often TAi's playback level is read for the orb
const OUT_RELEASE = 0.84;           // how much of the last reading is left a reading later: the orb falls slower than it rises

const $ = (selector) => document.querySelector(selector);

/** The loudness of a stretch of samples (-1 to 1): their root mean square. */
export function rmsOf(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

/** The level an orb shows from one reading to the next: up at once, down at a pace, never outside 0 to 1. */
export const followLevel = (previous, reading) => Math.max(0, Math.min(1, Math.max(Number(reading) || 0, previous * OUT_RELEASE)));

/** What TAi does to the student's screen in a call (docs/CHAT_OBJECTS.md, "Documents"): the server's `show`, `point` and `doc_state` messages, which the page's viewer takes (`onScreen`). */
export const SCREEN_TYPES = new Set(['show', 'point', 'doc_state']);

/**
 * The page's view (docs/CHAT_OBJECTS.md, "The view") over a call's socket, as `{ type: 'view', view }`. True when it was sent; false when the socket is not open (the caller then
 * posts the view instead) or it could not be sent. Never throws.
 */
export function sendViewOver(ws, view) {
  try {
    if (!ws || ws.readyState !== 1) return false;        // 1 is WebSocket.OPEN
    ws.send(JSON.stringify({ type: 'view', view }));
    return true;
  } catch {
    return false;
  }
}

function stopTracks(stream) {
  if (stream) for (const track of stream.getTracks()) track.stop();
}

/** Why the microphone could not be had, and what to do about it. */
function micProblem(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'The microphone is blocked for this page. Allow it (the lock or microphone icon next to the address; on a phone, the site settings), then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one, then try again.';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'The microphone is in use by another app. Close it there, then try again.';
  return 'The microphone could not be started. Try again.';
}

// ---------------------------------------------------------------- a voice note: a recording that is sent as it is, like a voice message

/** The recorder's format: Opus in WebM where the browser can (Chrome, Edge, Firefox), Opus in Ogg or MP4 where it cannot (Safari). All three are types the server takes. */
function noteFormat() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return { type: 'audio/webm;codecs=opus', name: 'note.webm' };
  if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return { type: 'audio/ogg;codecs=opus', name: 'note.ogg' };
  if (MediaRecorder.isTypeSupported('audio/mp4')) return { type: 'audio/mp4', name: 'note.m4a' };
  return null;
}

/**
 * The recorder that takes the message box's place while it records: a trash button, a pulsing dot, the time, a live level, and send. Send
 * hands the recording to `onSend({ blob, type, duration, peaks })` and the box comes back at once: the page shows the note as the student's
 * own message and uploads it. The microphone, the level meter's audio context and the timers are let go when the note is sent, cancelled
 * (the trash button, Escape, a hidden page), or stopped at its limit (which waits for send or trash: nothing is sent that was not asked for).
 */
export function createNoteRecorder({ toast, onSend, onChange }) {
  const bar = $('#recbar');
  const label = $('#rec-label');
  const time = $('#rec-time');
  const limitText = $('#rec-limit');
  const sendButton = $('#rec-send');
  const cancelButton = $('#rec-cancel');
  const level = $('#rec-level');
  const bars = Array.from({ length: LEVEL_BARS }, () => level.appendChild(document.createElement('i')));
  let note = null;

  function show(phase, text) {
    bar.dataset.phase = phase;
    label.textContent = text;
    label.classList.toggle('sr-only', phase === 'recording');      // while it records the dot, the time and the level say so; the other phases say it in words
    sendButton.disabled = phase !== 'recording' && phase !== 'full';
    if (bar.hidden) {
      time.textContent = '0:00';
      paintLevel([]);
      bar.hidden = false;
      onChange(true);
      cancelButton.focus();
    }
  }

  function hide() {
    if (bar.hidden) return;
    bar.hidden = true;
    onChange(false);
  }

  function paintLevel(levels) {
    const from = levels.length - bars.length;
    bars.forEach((item, i) => {
      item.style.height = `${Math.round(12 + 88 * (levels[from + i] || 0))}%`;
    });
  }

  /** Lets go of everything a recording holds (the timers, the level meter) but not the stream: that goes when the recorder has said it stopped. */
  function clear(current) {
    clearInterval(current.timer);
    clearInterval(current.meter);
    document.removeEventListener('keydown', current.onKey);
    if (current.ctx && current.ctx.state !== 'closed') current.ctx.close().catch(() => undefined);
    current.ctx = null;
  }

  /** The level of the voice in a short while, as a reading from 0 to 1 every so often: it moves the bars and, kept, becomes the waveform. */
  function startMeter(current) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      current.ctx = new Ctx();
      current.ctx.resume().catch(() => undefined);
      const analyser = current.ctx.createAnalyser();
      analyser.fftSize = 1024;
      current.ctx.createMediaStreamSource(current.stream).connect(analyser);       // not to the speakers: nothing is heard
      const samples = new Float32Array(analyser.fftSize);
      current.meter = setInterval(() => {
        if (typeof analyser.getFloatTimeDomainData !== 'function') return;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += v * v;
        const reading = Math.min(1, Math.sqrt(sum / samples.length) * 5);
        current.levels.push(reading);
        paintLevel(current.levels);
      }, LEVEL_EVERY_MS);
    } catch {
      /* no meter: the recording goes on without one */
    }
  }

  async function start(seconds = NOTE_SECONDS) {
    if (note) return;
    const format = noteFormat();
    if (!format || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('This browser cannot record a voice note. Type your message instead.');
      return;
    }
    const current = (note = { ...format, limit: Math.max(5, seconds) * 1000, chunks: [], phase: 'asking', stream: null, recorder: null, started: 0, duration: 0, timer: 0, meter: 0, ctx: null, levels: [], blob: null, onKey: null });
    limitText.textContent = ` / ${clock(seconds)}`;
    show('asking', 'Waiting for the microphone…');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    } catch (err) {
      if (note === current) {
        note = null;
        hide();
        toast(micProblem(err));
      }
      return;
    }
    if (note !== current) return stopTracks(stream);       // cancelled while the browser asked
    current.stream = stream;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: format.type, audioBitsPerSecond: NOTE_BITS_PER_SECOND });
    } catch {
      note = null;
      stopTracks(stream);
      hide();
      toast('This browser cannot record a voice note. Type your message instead.');
      return;
    }
    current.recorder = recorder;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size) current.chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => finished(current));
    recorder.start(250);
    current.phase = 'recording';
    current.started = performance.now();
    // Escape anywhere cancels it (the focus is on send, but a click elsewhere may have moved it)
    current.onKey = (event) => {
      if (event.key === 'Escape' && note === current) {
        event.preventDefault();
        cancel();
      }
    };
    document.addEventListener('keydown', current.onKey);
    startMeter(current);
    show('recording', 'Recording');
    sendButton.focus();
    current.timer = setInterval(() => {
      const ms = performance.now() - current.started;
      time.textContent = clock(Math.min(ms, current.limit) / 1000);
      if (ms >= current.limit) reachLimit(current);
    }, 250);
  }

  /** The longest a note may be: recording stops, and the student decides whether it goes. */
  function reachLimit(current) {
    if (note !== current || current.phase !== 'recording') return;
    current.phase = 'full';
    current.duration = current.limit / 1000;
    clear(current);
    time.textContent = clock(current.duration);
    show('full', 'Longest note reached. Send it, or delete it.');
    current.recorder.stop();
    sendButton.focus();
  }

  function send() {
    const current = note;
    if (!current) return;
    if (current.phase === 'recording') {
      current.phase = 'sending';
      current.duration = Math.min(current.limit, performance.now() - current.started) / 1000;
      clear(current);
      time.textContent = clock(current.duration);
      show('sending', 'Sending…');
      current.recorder.stop();                              // its last data, then "stop": finished() below
    } else if (current.phase === 'full') {
      current.phase = 'sending';
      show('sending', 'Sending…');
      if (current.blob) deliver(current);
    }
  }

  function finished(current) {
    stopTracks(current.stream);                              // the microphone goes at once, however the recording ends
    if (note !== current) return;                           // cancelled
    current.blob = new Blob(current.chunks, { type: current.recorder.mimeType || current.type });
    if (current.phase === 'sending') deliver(current);
  }

  function deliver(current) {
    note = null;
    hide();
    if (!current.blob.size || current.duration < MIN_NOTE_SECONDS) {
      toast("That was too short to hear. Hold on a little longer, then send it.");
      return;
    }
    onSend({ blob: current.blob, type: current.blob.type || current.type, duration: current.duration, peaks: peaksFromLevels(current.levels, NOTE_PEAKS) });
  }

  function cancel() {
    const current = note;
    if (!current) return;
    note = null;
    clear(current);
    if (current.recorder && current.recorder.state !== 'inactive') {
      try {
        current.recorder.stop();
      } catch {
        /* already stopping */
      }
    }
    stopTracks(current.stream);
    hide();
  }

  sendButton.addEventListener('click', send);
  cancelButton.addEventListener('click', cancel);
  window.addEventListener('pagehide', cancel);
  return { start, cancel, active: () => !!note };
}

// ---------------------------------------------------------------- the voice call

/** One resampler for a whole stream (linear, the position carried from chunk to chunk): `step` is input samples per output sample. */
export function resample(rs, input, step) {
  if (step === 1) return input;
  const last = input.length - 1;
  const out = new Float32Array(Math.max(0, Math.ceil((last - rs.pos) / step)) + 1);
  let k = 0;
  let t = rs.pos;
  while (t < last && k < out.length) {
    const i = Math.floor(t);
    const f = t - i;
    const a = i < 0 ? rs.prev : input[i];
    out[k++] = a + (input[i + 1] - a) * f;
    t += step;
  }
  rs.pos = t - input.length;
  rs.prev = input[last];
  return out.subarray(0, k);
}

/**
 * The first message of a call (docs/VOICE.md, "Browser protocol"): what kind it is, the interview link's token or the topic of a "talk it
 * through" call, and `resume` for a dropped connection that is taken up again (which says nothing but that: the call already has its kind).
 */
/**
 * The path of the call's socket under the page's base: `api/voice`, or `api/voice-lab` when the page's address has `?voice=lab` (the owner's hidden way to a call on the self-built
 * chain: docs/VOICE_SELFBUILT.md; the server answers 404 where there is no lab and 403 to anyone but the owner, so the parameter does nothing for a student). `&chain=d|h|fd|c` asks the lab
 * for one of its chains (docs amendment A10); any other value is left out, and the server ignores what it does not know.
 */
export function voiceSocketPath(search = '') {
  try {
    const params = new URLSearchParams(search);
    if (params.get('voice') !== 'lab') return 'api/voice';
    const chain = params.get('chain');
    return chain === 'd' || chain === 'h' || chain === 'fd' || chain === 'c' || chain === 'cf' ? `api/voice-lab?chain=${chain}` : 'api/voice-lab';
  } catch {
    return 'api/voice';
  }
}

export function startMessage({ mode, token = '', topic = '' }, resume = false) {
  const hello = { type: 'start', mode };
  if (resume) hello.resume = true;
  else if (mode === 'interview' && token) hello.token = token;
  else if (mode === 'talk' && String(topic).trim()) hello.topic = String(topic).trim().slice(0, TOPIC_CHARS);
  return hello;
}

/**
 * The request that tells the server a call is about to start (docs/VOICE.md, "Warming up"): POST api/voice/warm with the page's header and an empty
 * JSON body. The call's tool host is a container that takes ten seconds or more to come up, and the microphone's permission prompt, which comes next,
 * is a second or three the container can use.
 */
export function warmRequest(base) {
  return {
    url: new URL('api/voice/warm', base).href,
    init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-tai': '1' }, body: '{}', credentials: 'same-origin', cache: 'no-store', keepalive: true },
  };
}

/**
 * `warm()`: tells the server, once in `every` ms at most (the server allows one a minute for a student and answers `warming`, `warm` or why not),
 * and never waits for it or cares how it went: a failure of any kind is silent, because a call that was not warmed works as it always did. Called in the
 * click that begins a call, before the microphone is asked for, so it must never throw into that click.
 */
export function createWarmer({ fetchImpl, base, now = Date.now, every = WARM_EVERY_MS }) {
  let last = -Infinity;
  return function warm() {
    try {
      if (typeof fetchImpl !== 'function' || now() - last < every) return;
      last = now();
      const { url, init } = warmRequest(base());
      Promise.resolve(fetchImpl(url, init)).catch(() => undefined);
    } catch {
      /* nothing here may get in the way of a call */
    }
  };
}

/**
 * The call's client. `onChange(live)`: a call began or ended (app.js lays the message box out for it); `onSpeaking(kind)`: `started` (the
 * server heard the student begin to speak), `voice` (their microphone is audibly in use), `heard` (the call has the words of a turn of
 * theirs) or `stop` (they muted), for the "..." of words that have not come back as a line yet. `onScreen(message)`: what TAi does to the student's screen, the server's `show`,
 * `point` and `doc_state` messages as they came (the viewer checks them); `sendView(view)` (on what is returned) puts the page's view on the socket.
 */
export function createCall({ toast, onChange, onSpeaking = () => undefined, onScreen = () => undefined }) {
  const panel = $('#call');
  const stateText = $('#call-state');
  const badge = $('#call-badge');
  const timerText = $('#call-timer');
  const actions = $('#call-actions');
  const muteButton = $('#call-mute');
  const endButton = $('#call-end');
  const closeButton = $('#call-close');
  let call = null;
  let hideTimer = 0;
  // the server starts the call's tool host while the microphone's permission prompt is on screen (fire and forget, silent when it fails)
  const warm = createWarmer({ fetchImpl: (url, init) => fetch(url, init), base: () => document.baseURI });

  const live = () => !!call && call.phase !== 'over';

  function newCall(mode, token, topic) {
    return {
      mode, token, topic, phase: 'connecting', state: 'connecting', ctx: null, stream: null, capture: null, out: null, ws: null,
      ready: false, everReady: false, muted: false, sources: new Set(), nextTime: 0, rs: { pos: 0, prev: 0 }, carry: -1,
      framesSent: 0, dropAt: 0, attempts: 0, retry: 0, giveUp: 0, ping: 0, tick: 0, endTimer: 0, timer: null, meter: 0, level: 0, lastVoice: 0,
      serverMode: SERVER_MODES.get(mode),
    };
  }

  // ---- the panel

  function openPanel(c) {
    clearTimeout(hideTimer);
    timerText.textContent = '';
    panel.dataset.queued = '0';
    panel.dataset.frames = '0';
    panel.style.setProperty('--mic', '0');
    panel.style.setProperty('--out', '0');
    panel.classList.remove('muted');
    setMode(c, c.serverMode);
    actions.hidden = false;                   // mute and end are in the message box: the orb is what the panel is
    closeButton.hidden = true;
    muteButton.setAttribute('aria-pressed', 'false');
    muteButton.setAttribute('aria-label', 'Mute your microphone');
    muteButton.title = 'Mute';
    setState(c, 'connecting');
    panel.hidden = false;
    muteButton.focus();                       // the call button that was clicked is not drawn while a call is on
  }

  function closePanel() {
    clearTimeout(hideTimer);
    if (live()) return;
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = true;
    if (hadFocus) $('#input').focus();
  }

  function setState(c, name) {
    c.state = name;
    panel.dataset.state = name;
    label(c);
  }

  function label(c) {
    const text = { connecting: 'Connecting…', listening: 'Listening', thinking: 'Thinking…', speaking: 'TAi is speaking', working: 'Looking that up…', reconnecting: 'Reconnecting…' }[c.state] || '';
    stateText.textContent = c.muted && c.state === 'listening' ? 'You are muted' : text;
  }

  function setMode(c, mode) {
    c.serverMode = BADGES.has(mode) ? mode : 'conversational';
    panel.dataset.mode = c.serverMode;
    badge.hidden = !BADGES.has(c.serverMode);
    if (!badge.hidden) badge.textContent = BADGES.get(c.serverMode);
  }

  function setTimer(c, msg) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    c.timer = { at: performance.now(), elapsed: num(msg.elapsedSec) ?? 0, remaining: num(msg.remainingSec) ?? (c.timer ? c.timer.remaining : undefined), interview: num(msg.interviewRemainingSec) };
    renderTimer(c);
    if (!c.tick) c.tick = setInterval(() => renderTimer(c), 1000);
  }

  function renderTimer(c) {
    const t = c.timer;
    if (!t) return;
    const dt = (performance.now() - t.at) / 1000;
    const parts = [clock(t.elapsed + dt)];
    if (t.interview !== undefined) parts.push(`interview ${clock(t.interview - dt)} left`);
    else if (t.remaining !== undefined) parts.push(`${clock(t.remaining - dt)} left`);
    timerText.textContent = parts.join(' · ');
  }

  // ---- starting

  function start({ mode = 'chat', token = '', topic = '' } = {}) {
    if (live()) return;
    warm();                                   // before anything asks for the microphone: the container has that second or three to come up in
    const kind = SERVER_MODES.has(mode) ? mode : 'chat';
    const c = (call = newCall(kind, kind === 'interview' ? token : '', kind === 'talk' ? topic : ''));
    openPanel(c);
    onChange(true);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || typeof AudioWorkletNode === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof WebSocket === 'undefined') {
      finish(c, 'This browser cannot make voice calls. Try a recent Chrome, Edge, Firefox or Safari.', true);
      return;
    }
    // made here, inside the click: iOS Safari lets sound start only from a gesture, and a context made later would stay silent
    try {
      c.ctx = newContext(c, Ctx, {});
    } catch {
      finish(c, 'The voice call could not start in this browser.', true);
      return;
    }
    setup(c);
  }

  function newContext(c, Ctx, extra) {
    const ctx = new Ctx({ latencyHint: 'interactive', ...extra });
    ctx.resume().catch(() => undefined);
    // a phone call or another app can suspend the audio: take it up again while the call is on
    ctx.addEventListener('statechange', () => {
      if (c.phase !== 'over' && c.phase !== 'ending' && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => undefined);
    });
    return ctx;
  }

  async function setup(c) {
    try {
      c.stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    } catch (err) {
      finish(c, micProblem(err), true);
      return;
    }
    if (c.phase === 'over') return release(c);
    try {
      const source = await microphone(c);
      c.capture = new AudioWorkletNode(c.ctx, 'tai-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { rate: IN_RATE, frame: FRAME_SAMPLES },
      });
      // the worklet must be pulled by the graph to run in every browser, so it reaches the speakers through a gain of zero: nothing is heard
      const silent = c.ctx.createGain();
      silent.gain.value = 0;
      source.connect(c.capture);
      c.capture.connect(silent);
      silent.connect(c.ctx.destination);
      c.capture.port.onmessage = (event) => onFrame(c, event.data);
      c.out = c.ctx.createGain();
      c.out.connect(c.ctx.destination);
      startOutMeter(c);
      c.ctx.resume().catch(() => undefined);              // iOS suspends it again when the microphone opens
    } catch {
      finish(c, 'The voice call could not start in this browser.', true);
      return;
    }
    if (c.phase === 'over') return release(c);
    connect(c, false);
  }

  async function microphone(c) {
    await c.ctx.audioWorklet.addModule('voice-worklet.js');
    try {
      return c.ctx.createMediaStreamSource(c.stream);
    } catch (err) {
      // some browsers cannot join a microphone running at another rate to the context: make the context at the microphone's rate
      const track = c.stream.getAudioTracks()[0];
      const rate = track && track.getSettings ? track.getSettings().sampleRate : 0;
      if (!rate || rate === c.ctx.sampleRate) throw err;
      await c.ctx.close();
      c.ctx = newContext(c, window.AudioContext || window.webkitAudioContext, { sampleRate: rate });
      await c.ctx.audioWorklet.addModule('voice-worklet.js');
      return c.ctx.createMediaStreamSource(c.stream);
    }
  }

  // ---- the socket

  function send(c, message) {
    if (c.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(message));
  }

  /** The page's view, over the socket of the call that is going: true when it was sent, false when it was not (app.js then posts it). Only once the server has said "ready". */
  function sendView(view) {
    const c = call;
    return !!c && c.phase === 'live' && c.ready && sendViewOver(c.ws, view);
  }

  /** What TAi does to the student's screen goes to the page's viewer, which checks it; nothing the viewer does may take the call down. */
  function deliverScreen(message) {
    try {
      onScreen(message);
    } catch {
      /* the call goes on */
    }
  }

  function connect(c, resume) {
    const url = new URL(voiceSocketPath(typeof location === 'undefined' ? '' : location.search), document.baseURI);   // wss://host/tai/api/voice behind the proxy: the page's own origin and base path
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(url.href);
    } catch {
      closed(c);
      return;
    }
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    c.ready = false;
    ws.addEventListener('open', () => {
      if (c.ws !== ws) return;
      // the interview link's token travels in this message (never in the address, where logs keep it)
      ws.send(JSON.stringify(startMessage(c, resume)));
    });
    ws.addEventListener('message', (event) => {
      if (c.ws !== ws || c.phase === 'over') return;
      if (typeof event.data === 'string') onEvent(c, event.data);
      else play(c, event.data);
    });
    ws.addEventListener('close', () => {
      if (c.ws !== ws) return;
      c.ws = null;
      closed(c);
    });
  }

  function onEvent(c, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        return onReady(c, msg);
      case 'status':
        if (STATES.has(msg.state) && c.phase === 'live') setState(c, msg.state);
        return;
      case 'transcript':
        // not drawn: the words come back as lines of the history (speech.js). A turn of the student's keeps their "..." up until its line arrives
        if (msg.role === 'user') onSpeaking('heard');
        return;
      case 'agent_interrupted':
        flush(c);
        onSpeaking('started');                                  // the server sends it for every time the student begins to speak
        return;
      case 'mode':
        return setMode(c, msg.mode);
      case 'timer':
        return setTimer(c, msg);
      case 'notice':
        if (typeof msg.text === 'string' && msg.text.trim()) toast(msg.text.trim().slice(0, 300));
        return;
      case 'error':
        return onError(c, msg);
      case 'closed':
        return onClosed(c, msg);
      default:
        if (SCREEN_TYPES.has(msg.type)) deliverScreen(msg);   // `show`, `point`, `doc_state`: the viewer's
        return;                                             // anything else is something newer than this page
    }
  }

  function onReady(c, msg) {
    const again = c.everReady;
    c.ready = true;
    c.everReady = true;
    c.token = '';
    c.dropAt = 0;
    c.attempts = 0;
    clearTimeout(c.giveUp);
    if (c.phase !== 'ending') c.phase = 'live';
    if (typeof msg.mode === 'string') setMode(c, msg.mode);
    const max = Number(msg.maxSeconds);
    if (!again || !msg.resumed || !c.timer) setTimer(c, { elapsedSec: 0, remainingSec: max > 0 ? max : undefined });
    setState(c, 'listening');
    if (c.muted) send(c, { type: 'mute', muted: true });
    clearInterval(c.ping);
    c.ping = setInterval(() => send(c, { type: 'ping' }), PING_MS);
    if (again) toast(msg.resumed ? 'Back on the call.' : 'Back on, in a new call.');
  }

  function errorText(c, code, message) {
    const known = {
      'not-configured': 'Voice calls are not set up on this page yet.',
      busy: 'You already have a call open, in another tab or on another device. End that one first.',
      budget: "You have used today's voice time. You can keep typing; voice is back tomorrow.",
      deepgram: "TAi's voice service is not answering right now. Try again in a few minutes.",
      mic: 'TAi is not hearing anything from your microphone. Check that the right one is picked.',
      'rate-limited': 'Too many calls in a short time. Wait a few minutes, then try again.',
    };
    if (known[code]) return known[code];
    // the server names no code for an interview link it does not accept: anything else before the interview started is that
    if (c.mode === 'interview' && !c.everReady) return 'This link has expired. Ask TAi for a new one.';
    return typeof message === 'string' && message.trim() && message.length <= 200 ? message.trim() : 'The call ran into a problem.';
  }

  function onError(c, msg) {
    const code = typeof msg.code === 'string' ? msg.code : '';
    const text = errorText(c, code, msg.message);
    if (!c.everReady || c.phase === 'reconnecting' || FATAL.has(code)) finish(c, text, true);
    else toast(text);
  }

  function onClosed(c, msg) {
    const reason = msg.reason;
    const text = {
      user: 'Call ended.',
      timeout: 'The call ended: its time was up, or it was quiet for too long.',
      agent: 'TAi ended the call.',
      error: 'The call ended because something went wrong on TAi’s side.',
      budget: "The call ended: you have used today's voice time.",
    }[reason] || 'The call ended.';
    const summary = typeof msg.summary === 'string' && msg.summary.trim();
    finish(c, summary ? `${text} A summary is in the chat.` : text, reason !== 'user' && reason !== 'agent');
  }

  /** The socket went: the end of a call that was ending, a call that never started, or a drop to recover from. */
  function closed(c) {
    c.ready = false;
    if (c.phase === 'over') return;
    if (c.phase === 'ending') return finish(c, 'Call ended.');
    if (!c.everReady) return finish(c, 'The call could not be started. Try again in a moment.', true);
    lost(c);
  }

  function lost(c) {
    if (!c.dropAt) {
      c.dropAt = Date.now();
      clearTimeout(c.giveUp);
      c.giveUp = setTimeout(() => c.phase === 'reconnecting' && finish(c, 'The connection dropped and did not come back. Start a new call when you are online again.', true), RESUME_WINDOW_MS);
    }
    c.phase = 'reconnecting';
    setState(c, 'reconnecting');
    const left = RESUME_WINDOW_MS - (Date.now() - c.dropAt);
    if (left <= 0) return finish(c, 'The connection dropped and did not come back. Start a new call when you are online again.', true);
    const delay = [300, 1000, 2000, 3000, 5000][Math.min(c.attempts, 4)];
    c.attempts++;
    clearTimeout(c.retry);
    c.retry = setTimeout(() => c.phase === 'reconnecting' && connect(c, true), Math.min(delay, left));
  }

  // ---- the microphone out, TAi's voice in

  /** How loud TAi's voice is where it is being played, not where it arrives: the orb follows it (`--out`, 0 to 1). */
  function startOutMeter(c) {
    try {
      const analyser = c.ctx.createAnalyser();
      analyser.fftSize = 1024;
      c.out.connect(analyser);                                // a side branch: nothing more is heard
      const samples = new Float32Array(analyser.fftSize);
      c.meter = setInterval(() => {
        if (typeof analyser.getFloatTimeDomainData !== 'function') return;
        analyser.getFloatTimeDomainData(samples);
        c.level = followLevel(c.level, rmsOf(samples) * 4);
        panel.style.setProperty('--out', c.level.toFixed(3));
      }, OUT_METER_MS);
    } catch {
      /* no meter: the orb still shows the state */
    }
  }

  function onFrame(c, data) {
    if (!data || !(data.pcm instanceof ArrayBuffer)) return;
    const reading = Math.min(1, (Number(data.level) || 0) * 5);
    panel.style.setProperty('--mic', reading.toFixed(3));
    if (reading > VOICE_LEVEL && !c.muted && c.phase === 'live') {
      const at = performance.now();
      if (at - c.lastVoice > VOICE_EVERY_MS) {
        c.lastVoice = at;
        onSpeaking('voice');                                  // the student is audibly talking: their "..." (if there is one) stays up
      }
    }
    if (!c.ready || c.muted || c.phase !== 'live' || !c.ws || c.ws.readyState !== WebSocket.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) return;   // the network is stuck: drop the microphone rather than pile up delay
    c.ws.send(data.pcm);
    c.framesSent++;
    if (c.framesSent % 5 === 0) panel.dataset.frames = String(c.framesSent);
  }

  function play(c, data) {
    if (!c.ctx || !c.out || c.phase === 'ending' || c.phase === 'over' || c.ctx.state === 'closed') return;
    let bytes = new Uint8Array(data);
    if (c.carry >= 0) {
      // the frame before ended in the middle of a sample: its odd byte is this sample's first half
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = c.carry;
      joined.set(bytes, 1);
      bytes = joined;
      c.carry = -1;
    }
    if (bytes.length % 2) {
      c.carry = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const count = bytes.length / 2;
    if (!count) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const input = new Float32Array(count);
    for (let i = 0; i < count; i++) input[i] = view.getInt16(i * 2, true) / 32768;
    const samples = resample(c.rs, input, OUT_RATE / c.ctx.sampleRate);
    if (!samples.length) return;
    const buffer = c.ctx.createBuffer(1, samples.length, c.ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = c.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(c.out);
    const now = c.ctx.currentTime;
    if (c.nextTime <= now) c.nextTime = now + JITTER_S;     // the start of a burst, or the network fell behind: a little room first
    source.start(c.nextTime);
    c.nextTime += samples.length / c.ctx.sampleRate;
    c.sources.add(source);
    source.addEventListener('ended', () => {
      c.sources.delete(source);
      queued(c);
    });
    queued(c);
  }

  /** How much of TAi's voice is waiting to be heard (data-queued, in ms: the tests read it). */
  function queued(c) {
    const ms = c.sources.size && c.ctx ? Math.max(0, Math.round((c.nextTime - c.ctx.currentTime) * 1000)) : 0;
    panel.dataset.queued = String(ms);
  }

  /** The student talked over TAi: everything queued goes at once, after a few milliseconds of fade (a cut in mid-sound would click). */
  function flush(c) {
    if (c.ctx && c.out && c.ctx.state !== 'closed') {
      const now = c.ctx.currentTime;
      const gain = c.out.gain;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(0, now + 0.015);
      for (const source of c.sources) {
        try {
          source.stop(now + 0.016);
        } catch {
          /* not started */
        }
      }
      gain.setValueAtTime(1, now + 0.03);
    }
    c.sources.clear();
    c.nextTime = 0;
    c.rs.pos = 0;
    c.rs.prev = 0;
    c.carry = -1;
    queued(c);
  }

  function toggleMute() {
    const c = call;
    if (!c || c.phase === 'over' || c.phase === 'ending') return;
    c.muted = !c.muted;
    if (c.stream) for (const track of c.stream.getAudioTracks()) track.enabled = !c.muted;
    muteButton.setAttribute('aria-pressed', String(c.muted));
    muteButton.setAttribute('aria-label', c.muted ? 'Unmute your microphone' : 'Mute your microphone');
    muteButton.title = c.muted ? 'Unmute' : 'Mute';
    panel.classList.toggle('muted', c.muted);
    send(c, { type: 'mute', muted: c.muted });
    label(c);
    if (c.muted) onSpeaking('stop');                          // nothing is heard from here: a "..." that was waiting for words goes
  }

  // ---- ending

  function clearTimers(c) {
    clearTimeout(c.retry);
    clearTimeout(c.giveUp);
    clearTimeout(c.endTimer);
    clearInterval(c.ping);
    clearInterval(c.tick);
    clearInterval(c.meter);
  }

  /** Lets go of the microphone and the speaker (and may be called again: a microphone that arrives after the end is let go too). */
  function release(c) {
    clearInterval(c.meter);
    stopTracks(c.stream);
    if (c.capture) {
      c.capture.port.onmessage = null;
      try {
        c.capture.disconnect();
      } catch {
        /* already */
      }
    }
    for (const source of c.sources) {
      try {
        source.stop();
      } catch {
        /* not started */
      }
    }
    c.sources.clear();
    if (c.ctx && c.ctx.state !== 'closed') c.ctx.close().catch(() => undefined);
    panel.dataset.queued = '0';
    panel.style.setProperty('--mic', '0');
    panel.style.setProperty('--out', '0');
  }

  function finish(c, text, stay) {
    if (c.phase === 'over') return;
    c.phase = 'over';
    clearTimers(c);
    const ws = c.ws;
    c.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000);
      } catch {
        /* going anyway */
      }
    }
    release(c);
    if (call !== c) return;
    const focusWasHere = panel.contains(document.activeElement) || actions.contains(document.activeElement) || document.activeElement === document.body;
    panel.dataset.state = 'ended';
    stateText.textContent = text;
    // how long the call lasted, and no more time "left"
    timerText.textContent = c.timer && c.everReady ? clock(c.timer.elapsed + (performance.now() - c.timer.at) / 1000) : '';
    actions.hidden = true;                    // the message box is its own again; the panel is what is left of the call: what it said, and a way to close it
    closeButton.hidden = false;
    onChange(false);
    if (focusWasHere && !panel.hidden) closeButton.focus();
    clearTimeout(hideTimer);
    // an ordinary end goes away on its own after a moment; a problem stays until it has been read and closed
    if (!stay) hideTimer = setTimeout(() => call === c && closePanel(), 6000);
  }

  /**
   * The student hangs up: the server is told, the microphone and the speaker stop now, the socket waits a moment for the goodbye.
   * `now` (signing out): no waiting, and the panel goes too.
   */
  function end(now = false) {
    const c = call;
    if (!c || c.phase === 'over') {
      if (now) closePanel();
      return;
    }
    if (now || c.phase !== 'live' || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
      send(c, { type: 'end' });
      finish(c, 'Call ended.');
      if (now) closePanel();
      return;
    }
    send(c, { type: 'end' });
    c.phase = 'ending';
    release(c);
    panel.dataset.state = 'ending';
    stateText.textContent = 'Ending the call…';
    c.endTimer = setTimeout(() => finish(c, 'Call ended.'), 3000);
  }

  muteButton.addEventListener('click', toggleMute);
  endButton.addEventListener('click', () => end());
  closeButton.addEventListener('click', closePanel);
  // a click on the panel is a gesture: iOS may need one to start the sound again after an interruption
  panel.addEventListener('click', () => {
    if (call && call.ctx && call.ctx.state === 'suspended' && call.phase !== 'over') call.ctx.resume().catch(() => undefined);
  });
  // leaving the page ends the call (a hidden tab does not: a student may look something up while talking)
  window.addEventListener('pagehide', () => {
    const c = call;
    if (!c || c.phase === 'over') return;
    send(c, { type: 'end' });
    finish(c, 'Call ended.');
  });

  return { start, end, active: live, warm, sendView };
}
