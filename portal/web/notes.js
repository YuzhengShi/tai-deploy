// The voice note as the conversation shows it: a bubble with a play button, a waveform that is also a seek bar, the length, and the words
// (the transcript) as small text below with a Show/Hide toggle. Everything a recording's words say is put on the page as text, never as
// HTML. The recording itself is played by one <audio> element made when the student first presses play (a history full of notes loads none),
// and only one note plays at a time. voice.js records them; app.js decides what is in the history.

export const BARS = 36;                      // bars in a waveform
export const NOTE_PEAKS = 48;                // bars sent to the server with a recording (it keeps them with the entry)
const SHORT_NOTE_CHARS = 140;                // a transcript up to this long is shown at first; a longer one waits behind "Show text"
const STEP_SECONDS = 5;                      // what an arrow key moves the position by
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Seconds as "0:12". */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The loudness readings of a recording (0 to 1, a few a second) as `count` whole numbers from 0 to 100, loudest = 100: what the page draws as the waveform. */
export function peaksFromLevels(levels, count = NOTE_PEAKS) {
  if (!Array.isArray(levels) || !levels.length) return [];
  const bars = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    let top = 0;
    for (let k = from; k < Math.min(to, levels.length); k++) top = Math.max(top, Number(levels[k]) || 0);
    bars.push(top);
  }
  const loudest = Math.max(...bars, 0.05);          // a quiet recording is not drawn as a flat line
  return bars.map((v) => Math.max(0, Math.min(100, Math.round((v / loudest) * 100))));
}

/**
 * The bars to draw for a waveform: `peaks` (0-100) pooled to `count`, or, for a note that came without any, a fixed pattern worked out from
 * `seed` so that it looks the same every time the page is opened.
 */
export function barHeights(peaks, count = BARS, seed = 1) {
  if (Array.isArray(peaks) && peaks.length) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const from = Math.floor((i * peaks.length) / count);
      const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / count));
      let top = 0;
      for (let k = from; k < Math.min(to, peaks.length); k++) top = Math.max(top, Number(peaks[k]) || 0);
      out.push(Math.max(0.12, Math.min(1, top / 100)));
    }
    return out;
  }
  let x = (Math.abs(Math.floor(seed)) * 2654435761 + 12345) >>> 0;
  return Array.from({ length: count }, (_, i) => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const swell = 0.55 + 0.45 * Math.sin((i / count) * Math.PI);          // louder in the middle, as speech is
    return Math.max(0.14, Math.min(1, (0.25 + ((x >>> 8) % 1000) / 1400) * swell));
  });
}

/** How far along a bar a point is (0 to 1): `left` and `width` are the bar's own, `x` the pointer's. */
export function fractionAt(x, left, width) {
  return width > 0 ? Math.max(0, Math.min(1, (x - left) / width)) : 0;
}

/** Is this transcript short enough to show at first. */
export const isShortNote = (words) => words.length <= SHORT_NOTE_CHARS;

function svg(paths, fill = false) {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  if (fill) node.classList.add('solid');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    node.append(path);
  }
  return node;
}

const PLAY = ['M8 5.2v13.6a.9.9 0 0 0 1.4.7l10.6-6.8a.9.9 0 0 0 0-1.4L9.4 4.5A.9.9 0 0 0 8 5.2z'];
const PAUSE = ['M7.5 5h3v14h-3z', 'M13.5 5h3v14h-3z'];

let playing = null;                          // the note that is playing now (one at a time)

/** Stops whatever note is playing (a new one is starting, the conversation is being cleared). */
export function stopPlaying() {
  if (playing) playing.pause();
}

/**
 * One voice note's bubble. `src` is where its recording is (a local blob while it is being sent, api/media/<id> once it is kept),
 * `duration` its length in seconds as the page measured it (a recording from a browser's recorder carries none), `peaks` its bars.
 *   status   'ready', 'sending' (on its way: the words are not back yet) or 'failed' (not sent: a button tries again)
 */
export function createVoiceNote({ src, duration = 0, peaks = [], seed = 1, words = '', status = 'ready', title = '', onRetry = () => undefined, onProblem = () => undefined }) {
  let audio = null;
  let frame = 0;
  let want = -1;                             // a position asked for before the recording was loaded
  let shown = '';
  let wordsOpen = true;
  let wasPlaying = false;
  let problem = '';

  const bubble = document.createElement('div');
  bubble.className = 'bubble is-note';
  if (title) bubble.title = title;

  const head = document.createElement('div');
  head.className = 'note';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'note-play';
  const wave = document.createElement('div');
  wave.className = 'note-wave';
  wave.tabIndex = 0;
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', 'Voice note position');
  wave.setAttribute('aria-valuemin', '0');
  const base = document.createElement('span');
  base.className = 'bars';
  const lit = document.createElement('span');
  lit.className = 'bars lit';
  lit.setAttribute('aria-hidden', 'true');
  base.setAttribute('aria-hidden', 'true');
  for (const h of barHeights(peaks, BARS, seed)) {
    for (const group of [base, lit]) {
      const bar = document.createElement('i');
      bar.style.height = `${Math.round(h * 100)}%`;
      group.append(bar);
    }
  }
  wave.append(base, lit);
  const time = document.createElement('span');
  time.className = 'note-time';
  head.append(play, wave, time);

  const body = document.createElement('div');
  body.className = 'note-body';
  const text = document.createElement('p');
  text.className = 'note-text';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'note-toggle';
  const state = document.createElement('p');
  state.className = 'note-state';
  state.setAttribute('role', 'status');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'note-retry';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => onRetry());
  body.append(text, toggle, state, retry);
  bubble.append(head, body);

  const total = () => (duration > 0 ? duration : audio && Number.isFinite(audio.duration) ? audio.duration : 0);

  function paint() {
    const length = total();
    const at = audio ? Math.min(audio.currentTime || 0, length || Infinity) : 0;
    const fraction = length ? Math.min(1, at / length) : 0;
    bubble.style.setProperty('--p', fraction.toFixed(4));
    const label = audio && (!audio.paused || at > 0.05) ? clock(at) : clock(length);
    if (label !== shown) {
      shown = label;
      time.textContent = label;
    }
    wave.setAttribute('aria-valuemax', String(Math.floor(length)));
    wave.setAttribute('aria-valuenow', String(Math.floor(at)));
    wave.setAttribute('aria-valuetext', `${clock(at)} of ${clock(length)}`);
    const isPlaying = !!audio && !audio.paused && !audio.ended;
    if (isPlaying !== wasPlaying || !play.firstChild) {
      wasPlaying = isPlaying;
      play.replaceChildren(svg(isPlaying ? PAUSE : PLAY, true));
      bubble.classList.toggle('is-playing', isPlaying);
    }
    play.setAttribute('aria-label', isPlaying ? 'Pause voice note' : `Play voice note, ${clock(length)}`);
  }

  function tick() {
    paint();
    frame = audio && !audio.paused && !audio.ended ? requestAnimationFrame(tick) : 0;
  }

  function load() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('loadedmetadata', () => {
      if (want >= 0) audio.currentTime = want;
      want = -1;
      paint();
    });
    audio.addEventListener('play', () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
      paint();
    });
    for (const name of ['pause', 'timeupdate', 'durationchange', 'seeked']) audio.addEventListener(name, paint);
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      if (playing === api) playing = null;
      paint();
    });
    audio.addEventListener('error', () => {
      if (playing === api) playing = null;
      paint();
      onProblem();
    });
    audio.src = src;
    return audio;
  }

  function seek(seconds) {
    const length = total();
    const to = Math.max(0, Math.min(length || seconds, seconds));
    const a = load();
    if (a.readyState >= 1) a.currentTime = to;
    else want = to;
    paint();
  }

  function toggleWords() {
    wordsOpen = !wordsOpen;
    drawWords();
  }

  function drawWords() {
    const has = !!words;
    text.hidden = !has || !wordsOpen;
    text.textContent = has ? words : '';
    toggle.hidden = !has;
    toggle.textContent = wordsOpen ? 'Hide text' : 'Show text';
    toggle.setAttribute('aria-expanded', String(wordsOpen));
    // what is said when there are no words yet, or a problem: on its way, not sent, or nothing could be made out
    const message = status === 'failed' ? `Not sent.${problem ? ` ${problem}` : ''}` : has ? '' : status === 'sending' ? 'Sending…' : 'No words could be made out.';
    state.textContent = message;
    state.hidden = !message;
    retry.hidden = status !== 'failed';
    bubble.dataset.state = status;
  }

  play.addEventListener('click', () => {
    const a = load();
    if (a.paused || a.ended) {
      if (playing && playing !== api) playing.pause();
      playing = api;
      a.play().catch(() => {
        playing = null;
        onProblem();
      });
    } else {
      a.pause();
    }
    paint();
  });

  // the waveform is the seek bar: a click or a drag sets the position, the arrow keys move it by five seconds
  let dragging = false;
  const at = (event) => {
    const box = wave.getBoundingClientRect();
    seek(fractionAt(event.clientX, box.left, box.width) * total());
  };
  wave.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    dragging = true;
    try {
      wave.setPointerCapture(event.pointerId);
    } catch {
      /* a pointer that is already gone */
    }
    at(event);
  });
  wave.addEventListener('pointermove', (event) => dragging && at(event));
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) wave.addEventListener(name, () => (dragging = false));
  wave.addEventListener('keydown', (event) => {
    const now = audio ? audio.currentTime || 0 : Math.max(0, want);
    const moves = { ArrowRight: now + STEP_SECONDS, ArrowUp: now + STEP_SECONDS, ArrowLeft: now - STEP_SECONDS, ArrowDown: now - STEP_SECONDS, Home: 0, End: total() };
    if (!(event.key in moves)) return;
    event.preventDefault();
    seek(moves[event.key]);
  });
  toggle.addEventListener('click', toggleWords);

  const api = {
    bubble,
    pause() {
      if (audio && !audio.paused) audio.pause();
      if (playing === api) playing = null;
    },
    /** The words came back (or were there from the start): shown at once when they are short. */
    setWords(value) {
      words = String(value || '').trim();
      wordsOpen = isShortNote(words);
      drawWords();
    },
    /** 'ready', 'sending' or 'failed' (with the reason, in a sentence, which is shown under the bubble beside the button that tries again). */
    setStatus(value, reason = '') {
      status = value;
      problem = value === 'failed' ? String(reason || '') : '';
      drawWords();
    },
    /** Lets go of the audio element (the conversation is being cleared). */
    destroy() {
      this.pause();
      cancelAnimationFrame(frame);
      if (audio) {
        audio.removeAttribute('src');
        audio.load();
      }
      audio = null;
    },
  };
  wordsOpen = isShortNote(words);
  drawWords();
  paint();
  return api;
}
