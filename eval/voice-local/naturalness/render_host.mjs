// Renders the naturalness test's clips (eval/voice-local/naturalness/PROTOCOL.md) ON THE HOST, where the Deepgram key and the local voice service are: the live voices (Flux TTS hannah, Aura-2 thalia and
// mars) from Deepgram, the local voice (Supertonic) from the deployed container's /tts. Generic sentences only (passages.json: nothing from a student). Run:
//   PATH=$HOME/tai-live/node/bin:$PATH node render_host.mjs passages.json /tmp/nat-bank [lane ...]      lanes: flux aura-thalia aura-mars local (default: all, in parallel)
// The key is read from the host's .env and never printed; stdout has counts, durations and failures, never text. Clips are 24 kHz mono 16-bit WAV in
//   <out>/sent/<voice>/r<run>/<passage>-s<k>.wav     one clip per sentence
//   <out>/para/<cond>/r<run>/<passage>.wav           one clip per passage
// and <out>/manifest-<lane>.json lists every clip with its duration, character count and any failure. The local voice's clips are RAW (no gain): the lab's +9 dB gain and every other level step is applied on the PC.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const [, , passagesPath, OUT, ...lanesArg] = process.argv;
if (!passagesPath || !OUT) { console.log('usage: node render_host.mjs passages.json OUTDIR [lane ...]'); process.exit(2); }
const { default: WebSocket } = await import('/home/ubuntu/tai-live/tai/node_modules/ws/wrapper.mjs');
const env = fs.readFileSync(`${process.env.HOME}/tai-live/tai/.env`, 'utf8');
const key = ((env.match(/^(?:export\s+)?DEEPGRAM_API_KEY=(.*)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
const orch = fs.readFileSync(`${process.env.HOME}/tai-live/orch.env`, 'utf8');
const ttsUrl = ((orch.match(/^TAI_VOICE_LAB_TTS_URL=(.*)$/m) || [])[1] || '').trim();
if (!key) { console.log('no key'); process.exit(2); }
const passages = JSON.parse(fs.readFileSync(passagesPath, 'utf8')).passages;
const PACE = 1.2;
const RATE = 24000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// JOBS_ONLY=local-F1:2,flux-hannah:1 renders only those (condition:run) jobs, and writes the manifest of such a partial run under its own name
const ONLY = process.env.JOBS_ONLY ? new Set(process.env.JOBS_ONLY.split(',')) : null;

function wav(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const unwrap = (buf) => (buf.length > 44 && buf.subarray(0, 4).toString() === 'RIFF' ? buf.subarray(44) : buf);

// ---------------------------------------------------------------- engines: each takes a list of sentences and returns raw PCM (s16le, 24 kHz)
function fluxSpeak(sentences) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams({ model: 'flux-hannah-en', encoding: 'linear16', sample_rate: String(RATE), mip_opt_out: 'true', speed: String(PACE) });
    const ws = new WebSocket(`wss://api.deepgram.com/v2/speak?${q}`, { headers: { Authorization: `Token ${key}` } });
    const parts = []; let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch {} reject(new Error('timeout')); } }, 60000);
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { ws.send(JSON.stringify({ type: 'Close' })); ws.close(); } catch {} resolve(Buffer.concat(parts)); };
    ws.on('open', () => { for (const s of sentences) ws.send(JSON.stringify({ type: 'Speak', text: `${s} ` })); ws.send(JSON.stringify({ type: 'Flush' })); });
    ws.on('message', (d, bin) => {
      if (bin) { parts.push(Buffer.from(d)); return; }
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'SpeechMetadata') setTimeout(finish, 200);      // the audio frames come before it: it is the end of the turn
      if (m.type === 'Error' && !done) { done = true; clearTimeout(timer); reject(new Error('Error ' + (m.code || ''))); }
    });
    ws.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(new Error('ws ' + (e.code || e.message))); } });
    ws.on('close', () => { if (!done) { if (parts.length) finish(); else { done = true; clearTimeout(timer); reject(new Error('closed with no audio')); } } });
  });
}
const auraSpeak = (model) => async (sentences) => {
  const r = await fetch(`https://api.deepgram.com/v1/speak?model=${model}&encoding=linear16&sample_rate=${RATE}&container=none&mip_opt_out=true&speed=${PACE}`, {
    method: 'POST', headers: { Authorization: `Token ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: sentences.join(' ') }),
  });
  if (!r.ok) throw new Error(`Aura HTTP ${r.status}`);
  return unwrap(Buffer.from(await r.arrayBuffer()));
};
const localSpeak = (voice, speed) => async (sentences) => {
  const r = await fetch(`${ttsUrl}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: sentences.join(' '), voice, speed }) });
  if (!r.ok) throw new Error(`local HTTP ${r.status}`);
  if (r.headers.get('x-tts-fallback')) throw new Error('local service fell back to another voice');   // never mix voices
  return unwrap(Buffer.from(await r.arrayBuffer()));
};

// ---------------------------------------------------------------- jobs
// a job: { lane, voice, mode: 'sent' | 'para', cond, run, speak }
const JOBS = {
  flux: [1, 2].flatMap((run) => [
    { voice: 'flux-hannah', mode: 'sent', cond: 'flux-hannah', run, speak: fluxSpeak },
    { voice: 'flux-hannah', mode: 'para', cond: 'flux-hannah-whole', run, speak: fluxSpeak },
  ]),
  'aura-thalia': [1, 2].flatMap((run) => [
    { voice: 'aura-thalia', mode: 'sent', cond: 'aura-thalia', run, speak: auraSpeak('aura-2-thalia-en') },
    { voice: 'aura-thalia', mode: 'para', cond: 'aura-thalia-whole', run, speak: auraSpeak('aura-2-thalia-en') },
  ]),
  'aura-mars': [1, 2].map((run) => ({ voice: 'aura-mars', mode: 'sent', cond: 'aura-mars', run, speak: auraSpeak('aura-2-mars-en') })),
  local: [
    { voice: 'local-F1', mode: 'sent', cond: 'local-F1', run: 1, speak: localSpeak('F1', PACE) },
    { voice: 'local-F1', mode: 'para', cond: 'local-F1-whole', run: 1, speak: localSpeak('F1', PACE) },
    { voice: 'local-F1', mode: 'sent', cond: 'local-F1', run: 2, speak: localSpeak('F1', PACE) },   // the lengths repeat exactly, the waveform does not (fresh noise at each synthesis): a second run, as for the cloud voices
    { voice: 'local-F2', mode: 'sent', cond: 'local-F2', run: 1, speak: localSpeak('F2', PACE) },
    { voice: 'local-F1-natural', mode: 'sent', cond: 'local-F1-speed1.0', run: 1, speak: localSpeak('F1', 1.0) },
  ],
};

async function withRetry(fn) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fn(); } catch (e) { last = e; await sleep(1500 * (attempt + 1)); }
  }
  throw last;
}

async function runLane(lane) {
  const manifest = [];
  let chars = 0;
  const t0 = performance.now();
  for (const job of JOBS[lane]) {
    if (ONLY && !ONLY.has(`${job.cond}:${job.run}`)) continue;
    const dir = `${OUT}/${job.mode}/${job.cond}/r${job.run}`;
    fs.mkdirSync(dir, { recursive: true });
    for (const p of passages) {
      if (job.only && !job.only.includes(p.id)) continue;
      const units = job.mode === 'sent' ? p.sentences.map((s) => [s]) : [p.sentences];
      for (let k = 0; k < units.length; k++) {
        const text = units[k];
        const file = job.mode === 'sent' ? `${p.id}-s${k + 1}.wav` : `${p.id}.wav`;
        const row = { lane, voice: job.voice, mode: job.mode, cond: job.cond, run: job.run, passage: p.id, sentence: job.mode === 'sent' ? k + 1 : null, chars: text.join(' ').length, file: `${job.mode}/${job.cond}/r${job.run}/${file}` };
        try {
          const pcm = await withRetry(() => job.speak(text));
          if (pcm.length < RATE * 2 * 0.3) throw new Error('almost no audio');
          fs.writeFileSync(`${OUT}/${row.file}`, wav(pcm));
          row.seconds = Math.round((pcm.length / (RATE * 2)) * 1000) / 1000;
          chars += row.chars;
        } catch (e) { row.failed = String(e.message).slice(0, 80); }
        manifest.push(row);
      }
    }
    const done = manifest.filter((r) => r.cond === job.cond && r.run === job.run);
    console.log(JSON.stringify({ lane, cond: job.cond, run: job.run, clips: done.length, failed: done.filter((r) => r.failed).length, seconds: Math.round(done.reduce((a, r) => a + (r.seconds || 0), 0)) }));
  }
  fs.writeFileSync(`${OUT}/manifest-${lane}${ONLY ? '-partial-' + [...ONLY].join('_').replace(/:/g, '-r').replace(/[^A-Za-z0-9_.-]/g, '') : ''}.json`, JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ lane, chars, elapsedS: Math.round((performance.now() - t0) / 1000) }));
}

const lanes = lanesArg.length ? lanesArg : Object.keys(JOBS);
fs.mkdirSync(OUT, { recursive: true });
await Promise.all(lanes.map(runLane));
process.exit(0);
