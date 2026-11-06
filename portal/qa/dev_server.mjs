#!/usr/bin/env node
// The real student page (src/portal) in front of a pretend TAi, for looking at the page and for portal_e2e.py. Nothing here talks to a
// model, Canvas, Google or Deepgram: the pretend TAi answers a moment after a message (with markdown, code, a table, hostile markup, a
// diagram, an emoji, or what it sees of an attached file, by what the message asks for), voice notes are "transcribed" into a sentence
// the control port sets, a voice call is answered by fake_voice.mjs, and "sign in" accepts the credential `dev:<address>`.
//
//   node portal/qa/dev_server.mjs [--port=8787] [--out=DIR]      then open http://127.0.0.1:8787/
//
// Three listeners, all on loopback:
//   port      the page with every feature on (pictures, files, voice notes, voice calls)
//   port + 1  the control port, for the tests only (never reachable from the page: its content policy allows its own origin only):
//             POST /image /react /say /transcript /transcript-fail /typing /partial /activity/add /react-reply /choices /unreachable /team/class,
//             POST /voice/<command>, GET /voice /notes /seen /png
//   port + 2  the page with every feature off: exactly the text chat
// --port=0 picks three free ports. The last line printed is READY {"base":..., "control":..., "off":...}.
//
// It compiles the portal modules with the repository's TypeScript into DIR first (a dev machine may lack the orchestrator's other
// dependencies, so the logger is replaced by a silent one). Users: ada@example.com (owner), bob@, carol@, dave@, erin@, frank@, gina@, hana@,
// ivan@, june@, kai@, lena@, mike@, nina@, olga@, quinn@, rosa@, sam@, tara@, uma@, vera@, wade@, xena@, yara@, zane@, abel@, bella@ and cleo@example.com
// (the browser suite gives each flow a student of its own, so every conversation starts empty).
//
// (/activity/add also takes `items=N|hostile|long`: the questions of a mock interview, for the card's review list; POST /api/voice/warm on the page is the
// real route, answered by the fake call, and GET /voice reports `warms` and the `order` of warm and start.)
// The control port's /activity/add appends a line of the student's activity list (`type`, `title`, `text`, the body as `detail`; `count` of
// them, `ageMin` minutes old; `legacy=1`: the long call summary of the older kind), and /react-reply?ms=N sets how long the server waits
// before it answers a student's emoji (0, the default here: it does not). The fake call (fake_voice.mjs) adds the call's own activity line.
// /choices makes TAi ask with options to tap (a JSON body: { text, options: [words], quiz, key, why, doubt }; `key` is the index of the right option,
// kept by the server as the host's secret and never served; `doubt` is a key the host dropped), and /unreachable?on=1|0 makes TAi "unreachable" for a
// student (a tap or a message is refused).
// The page with every feature off (port + 2) has no options to tap (choices: false).
// The fake call (fake_voice.mjs) writes what a real call leaves in the history: lines of kind `speech` (what is said aloud, and markers of its
// start, a switch and its end), through /voice/user-says (the student speaks: the server hears them begin, then the line), /voice/user-speaking
// (they begin and say nothing final), /voice/speak (TAi speaks), and, with no call on, /voice/lines?count=N, /voice/line?role=&text= and
// /voice/marker?event=&mode=&seconds= (a long call that was made before, one line, one marker).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FakeVoice } from './fake_voice.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const port = parseInt(args.port ?? '8787', 10);
const out = args.out || path.join(os.tmpdir(), 'tai-portal-dev-build');
// the page's files, as src/portal/start.ts serves them (PAGE_FILES)
// (one name to a line, so that a feature that adds a file never touches another's line; keep it the same as PAGE_FILES in src/portal/start.ts)
const PAGE_FILES = [
  'index.html',
  'app.js',
  'markdown.js',
  'highlight.js',
  'notes.js',
  'activity.js',
  'choices.js',
  'speech.js',
  'voice.js',
  'voice-worklet.js',
  'review.js',
  'review.css',
  'team.html',
  'team.js',
  'team-data.js',
  'team.css',
  'style.css',
  'highlight.css',
  'settings.js',
  'settings.css',
  'status.js',
  'sources.js',
  'status.css',
  'sw.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'mark.svg',
];

function build() {
  fs.rmSync(out, { recursive: true, force: true });
  const sources = ['auth', 'history', 'media', 'uploads', 'transcribe', 'feedback', 'server', 'team-routes', 'testing/team-fixture', 'voice-routes','../notify/start', '../notify/vapid'].map((name) => path.join(root, 'src/portal', `${name}.ts`));
  try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--outDir', out, '--rootDir', path.join(root, 'src'), '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--esModuleInterop', ...sources], { stdio: 'pipe' });
  } catch {
    /* src/logger.ts wants pino, which this machine may not have: tsc still writes every file, and the logger is replaced below */
  }
  fs.writeFileSync(path.join(out, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(out, 'logger.js'), 'export const logger = { info() {}, warn() {}, error() {}, debug() {} };\n');
  // The teaching view calls src/patrol-gate.ts, which imports cron-parser: a package a build directory outside the repository cannot find. The view
  // never needs a cron here (the fixture has no patrol schedule), and patrol-gate's own try/catch turns a parse that throws into "no next patrol", so a
  // stand-in that throws when it is used is all the import needs (and says so, if anything ever does use it).
  const cron = path.join(out, 'node_modules', 'cron-parser');
  fs.mkdirSync(cron, { recursive: true });
  fs.writeFileSync(path.join(cron, 'package.json'), '{"name":"cron-parser","type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(cron, 'index.js'), "export const CronExpressionParser = { parse() { throw new Error('cron-parser is not part of the dev build'); } };\n");
}

build();
const load = (name) => import(pathToFileURL(path.join(out, 'portal', `${name}.js`)).href);
const { Portal, loadStaticFiles } = await load('server');
const { AuthError, NonceStore, SessionCodec, UserDirectory } = await load('auth');
const { HistoryStore, clipActivity } = await load('history');
const { MediaStore } = await load('media');
const { UploadStore } = await load('uploads');
const { TeamView } = await load('team');
const { teamRoutes } = await load('team-routes');
const { voiceRoutes } = await load('voice-routes');
const { writeTeamFixture } = await load('testing/team-fixture');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-portal-dev-'));
const usersFile = path.join(work, 'users.json');
fs.writeFileSync(usersFile, JSON.stringify({
  users: [
    { email: 'ada@example.com', name: 'Ada Lovelace', canvasUserId: '1001', githubUsername: 'ada-eval', role: 'owner' },
    { email: 'bob@example.com', name: 'Bob Barker', canvasUserId: '1002' },
    { email: 'carol@example.com', name: 'Carol Shaw', canvasUserId: '1003' },
    { email: 'dave@example.com', name: 'Dave Cutler', canvasUserId: '1004' },
    { email: 'erin@example.com', name: 'Erin Brockovich', canvasUserId: '1005' },
    { email: 'frank@example.com', name: 'Frank Lloyd', canvasUserId: '1006' },
    { email: 'gina@example.com', name: 'Gina Torres', canvasUserId: '1007' },
    { email: 'hana@example.com', name: 'Hana Kimura', canvasUserId: '1008' },
    { email: 'ivan@example.com', name: 'Ivan Petrov', canvasUserId: '1009' },
    { email: 'june@example.com', name: 'June Park', canvasUserId: '1010' },
    { email: 'kai@example.com', name: 'Kai Tanaka', canvasUserId: '1011' },
    { email: 'lena@example.com', name: 'Lena Fischer', canvasUserId: '1012' },
    { email: 'mike@example.com', name: 'Mike Okafor', canvasUserId: '1013' },
    { email: 'nina@example.com', name: 'Nina Rossi', canvasUserId: '1014' },
    { email: 'olga@example.com', name: 'Olga Smirnova', canvasUserId: '1015' },
    { email: 'quinn@example.com', name: 'Quinn Morgan', canvasUserId: '1016' },
    { email: 'rosa@example.com', name: 'Rosa Parks', canvasUserId: '1017' },
    { email: 'sam@example.com', name: 'Sam Altman', canvasUserId: '1018' },
    { email: 'tara@example.com', name: 'Tara Westover', canvasUserId: '1019' },
    { email: 'uma@example.com', name: 'Uma Thurman', canvasUserId: '1020' },
    { email: 'vera@example.com', name: 'Vera Rubin', canvasUserId: '1021' },
    { email: 'wade@example.com', name: 'Wade Wilson', canvasUserId: '1022' },
    { email: 'xena@example.com', name: 'Xena Warrior', canvasUserId: '1023' },
    { email: 'yara@example.com', name: 'Yara Shahidi', canvasUserId: '1024' },
    { email: 'zane@example.com', name: 'Zane Grey', canvasUserId: '1025' },
    { email: 'abel@example.com', name: 'Abel Tasman', canvasUserId: '1026' },
    { email: 'bella@example.com', name: 'Bella Swan', canvasUserId: '1027' },
    { email: 'cleo@example.com', name: 'Cleo Patra', canvasUserId: '1028' },
  ],
}));
const users = new UserDirectory(usersFile);

// ---- a small PNG, drawn here: a Raft election (a candidate, two followers that voted for it)

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, pixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * stride + 1 + x * 3);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;                     // 8 bits per channel, RGB, no interlace
  head[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', head), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
function segment(x, y, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = clamp01(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}
const NODES = [
  { x: 280, y: 96, r: 46, color: [59, 130, 246] },
  { x: 116, y: 250, r: 40, color: [34, 197, 94] },
  { x: 444, y: 250, r: 40, color: [34, 197, 94] },
  { x: 280, y: 292, r: 30, color: [156, 163, 175] },
];
const DIAGRAM = png(560, 340, (x, y) => {
  let c = x % 28 === 0 || y % 28 === 0 ? [242, 244, 248] : [255, 255, 255];
  for (const [a, b] of [[0, 1], [0, 2], [0, 3]]) c = mix(c, b === 3 ? [203, 213, 225] : [124, 92, 246], clamp01(3.2 - segment(x, y, NODES[a], NODES[b])));
  for (const n of NODES) {
    c = mix(c, n.color, clamp01(n.r - Math.hypot(x - n.x, y - n.y) + 0.5));
    c = mix(c, [255, 255, 255], 0.3 * clamp01(n.r * 0.32 - Math.hypot(x - n.x + n.r * 0.32, y - n.y + n.r * 0.32)));
  }
  return c;
});

// ---- the pretend TAi

const listeners = new Set();
const typing = new Set();
const statuses = new Map();                // jid -> { state, label?, ahead? }: what the pretend TAi is "doing" (the control port's /status)
const lastMessage = new Map();             // jid -> the id of the student's newest message (what an emoji names)
const seen = [];                           // what the pretend TAi was handed, for the tests
const emit = (entry) => listeners.forEach((listener) => listener(entry));
const say = (jid, text) => emit({ kind: 'text', jid, text });
const setTyping = (jid, on) => {
  if (on) typing.add(jid); else typing.delete(jid);
  emit({ kind: 'typing', jid, typing: on });
};
const media = new MediaStore(path.join(work, 'media'));
const MISSING_PICTURE = '0123456789abcdef0123456789abcdef';     // the form of a picture's id, and no picture behind it

function sendPicture(jid, caption, missing = false) {
  const kept = missing ? { id: MISSING_PICTURE } : media.save(jid.slice(4), DIAGRAM);
  emit({ kind: 'image', jid, caption, media: kept.id });
}

function answer(text) {
  // nothing but the notes of a student's emoji (the server's answer to an emoji, a few seconds after it): a few words back
  if (!text.trim()) return 'Glad that one landed. Shall we keep going?';
  // a tap on one of TAi's options ("B. A term has at most one leader"): the letter and the option, as the page's server records it
  if (/^[A-F]\. /.test(text)) return 'Thanks for answering. Shall we go on?';
  // a voice note: the words are what the page's server heard (or it could not make them out)
  const note = /^\[Voice note(?:, \d+:\d\d)?\] ([\s\S]*)$/.exec(text);
  if (note) return `I heard you say: "${note[1].slice(0, 80)}". Let's work through it: what do you already know?`;
  if (text.startsWith('[The student sent a voice note')) return "I could not make out your voice note. Could you type it?";
  // an attached file first: the message TAi gets carries the file's start, which could hold any of the words below
  if (text.includes('[The student attached')) {
    const names = [...text.matchAll(/^- (?:\/workspace\/group\/uploads\/)?(\S+) \(/gm)].map((m) => `\`${m[1]}\``);
    const excerpt = /^--- \S+.*---\n([^\n]*)/m.exec(text);
    // a picture: the real TAi is told to read its text with read_image_text (the server kept a copy in the workspace) or, where it has no copy, that it cannot see it; both say "can't see pictures".
    // With TAI_VISION=1 in this server's environment (docs/VISION.md) the message also says it can look at the picture with look_at_image, and the pretend TAi says it can look too
    const picture = text.includes('look_at_image') ? " I can look at a picture with look_at_image and read the text in a picture with read_image_text." : text.includes('read_image_text') ? " I can read the text in a picture with read_image_text, but I can't see pictures: charts, diagrams and layout are out of reach." : text.includes('cannot see pictures') ? " I can't see pictures, though: paste the text or describe what it shows." : '';
    return `I can see what you attached: ${names.join(', ')}.${excerpt ? ` It starts with \`${excerpt[1].slice(0, 60)}\`.` : ''}${picture}`;
  }
  const t = text.toLowerCase();
  if (t.includes('table')) return 'Here is how the three compare:\n\n| Protocol | Leader | Fault model |\n|:--|:-:|--:|\n| Raft | strong | crash |\n| Paxos | weak | crash |\n| PBFT | rotating | Byzantine |\n\nWhich row surprises you?';
  if (t.includes('code')) return 'A worker pool, in the shape you described:\n\n```go\nfunc worker(id int, jobs <-chan int, results chan<- int) {\n\tfor j := range jobs {\n\t\tresults <- j * 2\n\t}\n}\n```\n\nWhat closes `jobs`, and who waits for the workers?';
  if (t.includes('list')) return 'Three things to check:\n\n1. Does every goroutine have a way out?\n2. Who closes the channel?\n   - the sender, never the receiver\n   - and only once\n3. Is `WaitGroup.Add` called before `go`?\n\nStart with the first. What do you see?';
  if (t.includes('html')) return '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2"> and [a bad link](javascript:window.__pwned=3) and **bold** and https://example.com/safe.';
  if (t.includes('long')) return Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. ` + 'Consensus is about agreeing on one value even when machines fail and messages are late. '.repeat(3)).join('\n\n');
  return `Good place to dig. What do you already know about "${text.slice(0, 60)}"?`;
}

const unreachable = new Set();             // the jids of students for whom TAi "cannot be reached": what they send is refused (the page says so)
const DEFAULT_OPTIONS = ['Every heartbeat starts a new term', 'A term has at most one leader', 'The term number can go down after a failure'];

const core = {
  ensureStudent: (user) => user.jid,
  submit: (jid, raw, _name, id) => {
    if (unreachable.has(jid)) return { ok: false, status: 503, error: 'unavailable' };
    seen.push({ jid, text: raw });                    // as it came: the tests look for the page's own lines in it
    if (id) lastMessage.set(jid, id);
    // the lines the page puts ahead of a message for TAi alone ("[The student reacted 👍 to your earlier message: ...]", "[The student answered
    // your multiple-choice question ...]") are not what the student asked: the pretend TAi decides what to say from the message itself
    const text = raw.replace(/^(?:\[The student (?:reacted|said|liked|gave|answered|picked) [^\n]*\]\n)+/, '');
    const t = text.toLowerCase();
    const attached = text.includes('[The student attached');
    setTimeout(() => setTyping(jid, true), 200);
    if (!attached && /\bthank/.test(t)) {
      // an emoji is the whole answer
      setTimeout(() => { emit({ kind: 'reaction', jid, messageId: id, emoji: '👍' }); setTyping(jid, false); }, 900);
    } else if (!attached && /\bdraw\b/.test(t)) {
      setTimeout(() => { sendPicture(jid, 'Here is a Raft election: the candidate asks the others for their votes. **What happens when two candidates tie?**'); setTyping(jid, false); }, 1200);
    } else {
      setTimeout(() => { say(jid, answer(text)); setTyping(jid, false); }, t.includes('slow') ? 9000 : 1500);
    }
    return { ok: true };
  },
  onOutbound: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  isTyping: (jid) => typing.has(jid),
  // what the control port's /status says TAi is doing (the page shows it only while it is typing, as the real channel does)
  status: (jid) => (typing.has(jid) ? statuses.get(jid) : undefined),
};

// ---- voice notes: a pretend transcriber that says what the control port set

const notes = { count: 0, last: null, next: 'How does Raft pick a new leader when the old one fails?', fail: false, delay: 0 };
const transcribe = async (audio, mime) => {
  notes.count++;
  notes.last = { size: audio.length, mime };
  if (notes.delay) await new Promise((resolve) => setTimeout(resolve, notes.delay));
  if (notes.fail) throw Object.assign(new Error('the pretend transcriber is down'), { status: 502 });
  return notes.next;
};

// ---- the two pages

const verifier = { verify: async (credential) => { if (!credential.startsWith('dev:')) throw new AuthError('signature'); return { email: credential.slice(4), subject: 'dev' }; } };
const staticFiles = loadStaticFiles(path.join(root, 'portal/web'), PAGE_FILES, '/');
const history = new HistoryStore(path.join(work, 'history'));
const portalRef = { current: null };
const voice = new FakeVoice({ history, wake: (folder) => portalRef.current?.wakeStudent(folder) });
// the teaching view (owner only: sign in as dev:ada@example.com, then "Teaching view" in the account menu): the real team module reading twelve synthetic
// students written as real files (src/portal/testing/team-fixture.ts: Bob strong, Carol with a verbal gap, Erin quiet with a confirmed misconception, Ivan who
// never opened the page, Lena with a file nobody can read...). The control port's /team/class?mode=empty|full swaps in an empty class and back.
const teamFixture = writeTeamFixture(path.join(work, 'team'), {
  now: Date.now(),
  template: fs.readFileSync(path.join(root, 'groups/global/COMPETENCY_TEMPLATE.md'), 'utf-8'),
  folderOf: (key) => users.find(`${key}@example.com`).folder,
});
const teamClass = { empty: false };
const teamView = new TeamView({ ...teamFixture.deps, now: undefined, roster: () => (teamClass.empty ? [] : teamFixture.roster) });
// Settings and notifications: the real notify module (src/notify) with a stand-in for the push services, so nothing here ever reaches Google's or
// Mozilla's. `pushLog` is what it was asked to send (hashes and sizes only; the control port's /push). Quiet hours are off and a reply is pushed
// after 5 s, so a flow does not depend on the time of day; a throw-away VAPID key is made at start.
const { startNotify } = await import(pathToFileURL(path.join(out, 'notify', 'start.js')).href);
const { generateVapidKeys } = await import(pathToFileURL(path.join(out, 'notify', 'vapid.js')).href);
const pushLog = [];
const mailLog = [];                              // what the stand-in mail server was asked to send (the control port's /mail)
const notify = startNotify({
  env: { TAI_NOTIFY: '1', VAPID_PRIVATE_KEY: generateVapidKeys().privateKey, TAI_PUSH_SUBJECT: 'https://dev.example/tai', TAI_PUSH_QUIET_START: '00:00', TAI_PUSH_QUIET_END: '00:00', TAI_PUSH_REPLY_AFTER_SECONDS: '5', TAI_NOTIFY_EMAIL: '1', TAI_SMTP_HOST: 'smtp.dev.example', TAI_NOTIFY_FROM: 'tai@dev.example', TAI_EMAIL_AFTER_MINUTES: '1' },
  web: { onOutbound: (listener) => core.onOutbound(listener), bootId: 'dev' },
  storeDir: work,
  origin: 'https://dev.example',
  basePath: '/tai',
  // e-mail: on, with a recording stand-in for the mail server (nothing is ever sent); the address is the student's own, from the list of users
  recipientOf: (folder) => users.list().find((u) => u.folder === folder)?.email,
  mailer: { send: async (mail) => (mailLog.push({ ...mail, at: Date.now() }), { ok: true }) },
  sender: {
    send: async (sub, payload, options) => {
      const folder = fs.readdirSync(path.join(work, 'portal')).map((name) => /^(.+)\.prefs\.json$/.exec(name)).filter(Boolean).map((m) => m[1]).find((f) => fs.readFileSync(path.join(work, 'portal', `${f}.prefs.json`), 'utf-8').includes(sub.endpoint));
      pushLog.push({ folder, ttl: options.ttl, urgency: options.urgency, payload: JSON.parse(payload.toString()), at: Date.now() });
      return { outcome: 'sent', status: 201 };
    },
  },
});
const handOver = core.submit;                    // a message handed to the pretend TAi starts the clock of its reply, as in src/portal/start.ts
core.submit = (...request) => notify.noteSubmit(request[0], handOver(...request));
const portal = new Portal({
  core,
  users,
  verifier,
  googleClientId: 'dev-client.apps.googleusercontent.com',
  sessions: new SessionCodec(crypto.randomBytes(32), 12 * 3600),
  nonces: new NonceStore(),
  history,
  media,
  uploads: new UploadStore(path.join(work, 'groups')),
  transcribe,
  voice,
  staticFiles,
  basePath: '/',
  routes: [...teamRoutes(teamView), ...notify.routes, ...voiceRoutes({ voice })],       // (POST /api/voice/warm: the real route, answered by the fake call's warm())
  features: (user) => ({ team: user.role === 'owner', ...notify.features(user) }),
  presence: notify.presence,
  sourceHosts: new Set(['canvas.example.edu', 'github.com']),         // the hosts a "looked at" chip may link to (src/sources.ts)
  reactReplyDelayMs: 0,                   // a student's emoji starts no reply here, so the flows that only react see what they always saw; the control port turns it on
});
portalRef.current = portal;
// for the tests: an upload can be held a while before the page's server reads it, so the page's "still going up" state can be seen
// (it wraps the server's own upload handler; if that is ever renamed, uploads simply are not held, and the network throttle still shows it)
const uploadDelay = { ms: 0 };
if (typeof portal.upload === 'function') {
  const realUpload = portal.upload.bind(portal);
  portal.upload = async (...request) => {
    if (uploadDelay.ms) await new Promise((resolve) => setTimeout(resolve, uploadDelay.ms));
    return realUpload(...request);
  };
}
await portal.listen({ host: '127.0.0.1', port });

// everything off: no media, uploads, transcriber or voice; its own history (both pages hear the same pretend TAi)
const plain = new Portal({
  core,
  users: new UserDirectory(usersFile),
  verifier,
  googleClientId: 'dev-client.apps.googleusercontent.com',
  sessions: new SessionCodec(crypto.randomBytes(32), 12 * 3600),
  nonces: new NonceStore(),
  history: new HistoryStore(path.join(work, 'history-plain')),
  staticFiles,
  basePath: '/',
  choices: false,                          // no options to tap: the question is only its words
});
await plain.listen({ host: '127.0.0.1', port: port ? port + 2 : 0 });

// ---- the control port (tests only)

// What a mock interview's card lists (src/voice/review.ts makes the real ones when a call ends): the question, a paraphrase of what the student said, how it went in a
// WORD, one sentence on a stronger answer, the topic. /activity/add?type=interview&items=5 puts the first five on a card; items=hostile and items=long are the two
// that must not break the page (markup in every field; every field at its longest).
const REVIEW_ITEMS = [
  { question: 'Why does the leader need a majority?', said: 'They said a majority means two leaders cannot both commit.', band: 'getting there', better: 'Add that any two majorities share a node, so a second leader would have to hear the first.', topic: 'Raft leader election' },
  { question: 'What happens if two requests reach the same line at once?', said: 'They said it would probably be fine.', band: 'just started', better: 'Say that without a lock the check and the insert can interleave, so both requests may pass the check.', topic: 'Concurrency' },
  { question: 'Why is the lock taken inside Create and not in the handler?', said: 'They said it keeps the lock close to the map.', band: 'solid', better: 'You could add that a lock in the handler would be held while the body is decoded, and slow every request.', topic: 'Concurrency' },
  { question: 'What if the call to the store fails halfway?', said: 'They had no answer yet.', band: 'not started', better: 'Say what state the map is left in, and how the handler tells the caller.', topic: 'Failure modes' },
  { question: 'How would you load test this service?', said: 'They would use Locust with a ramp-up.', band: 'getting there', better: 'Name what you would measure: tail latency and error rate as the arrival rate grows.', topic: 'Load testing' },
];
function cannedItems(spec) {
  if (spec === 'hostile') {
    const markup = '<img src=x onerror="window.__pwned=1"> **not bold** <script>window.__pwned=2</script>';
    return [{ question: markup, said: markup, band: 'getting there', better: markup, topic: markup }];
  }
  if (spec === 'long') {
    const words = 'consensus '.repeat(40);
    return [{ question: words, said: words, band: 'solid', better: words, topic: words }];
  }
  return REVIEW_ITEMS.slice(0, Math.max(1, Math.min(8, parseInt(spec, 10) || 1)));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

const control = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://control');
  const q = url.searchParams;
  const user = users.find(`${q.get('who') || 'bob'}@example.com`);
  const reply = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    if (!user) return reply(404, { error: 'no such user' });
    const post = req.method === 'POST';
    const jid = user.jid;
    if (url.pathname === '/png') return reply(200, DIAGRAM, 'image/png');
    if (url.pathname === '/image' && post) {
      sendPicture(jid, q.get('caption') ?? 'Here is a Raft election: the candidate asks the others for their votes. **Who wins a tie?**', q.get('missing') === '1');
      return reply(200, { ok: true });
    }
    if (url.pathname === '/react' && post) {
      emit({ kind: 'reaction', jid, messageId: q.get('id') || lastMessage.get(jid) || 'unknown', emoji: q.get('emoji') || '👍' });
      return reply(200, { ok: true });
    }
    if (url.pathname === '/typing' && post) {
      setTyping(jid, q.get('on') !== '0');
      return reply(200, { ok: true });
    }
    if (url.pathname === '/status' && post) {
      // what TAi is "doing" for this student, as the web channel reports it while it types (turn the dots on with /typing first):
      // ?state=working&label=Checking%20Canvas, ?state=queued&ahead=2, ?clear=1. The page's poll is woken as the real server wakes it.
      if (q.get('clear') === '1') statuses.delete(jid);
      else statuses.set(jid, { state: q.get('state') || 'working', ...(q.get('label') ? { label: q.get('label') } : {}), ...(q.get('ahead') !== null ? { ahead: Number(q.get('ahead')) } : {}) });
      emit({ kind: 'status', jid });
      return reply(200, { ok: true, status: statuses.get(jid) ?? null });
    }
    if (url.pathname === '/partial' && post) {
      // a reply TAi is "writing" (TAI_PORTAL_STREAM, docs/STREAMING.md): ?text= is the status's `partial`, as the real channel puts it there (filtered and cut at a
      // sentence); ?clear=1 takes it away. Turn the dots on with /typing first; the label stays what /status set (Thinking when nothing was).
      const current = statuses.get(jid) ?? { state: 'working', label: 'Thinking' };
      if (q.get('clear') === '1') {
        const { partial: _gone, ...rest } = current;
        statuses.set(jid, rest);
      } else {
        statuses.set(jid, { ...current, partial: q.get('text') ?? '' });
      }
      emit({ kind: 'status', jid });
      return reply(200, { ok: true, status: statuses.get(jid) });
    }
    if (url.pathname === '/sources' && post) {
      // TAi answers with what it "looked at": the JSON body is [{ kind, label, url? }] (the server clips them to its hosts: canvas.example.edu and
      // github.com here), ?text= the words of the answer
      const body = JSON.parse((await readBody(req)) || '[]');
      emit({ kind: 'text', jid, text: q.get('text') || 'Homework 6 is due Friday. Start with the worker pool, then the load test.', sources: body });
      return reply(200, { ok: true });
    }
    if (url.pathname === '/choices' && post) {
      // TAi asks with options (src/choices.ts: the web channel has taken the block out of its words): the JSON body is { text, options: [words],
      // quiz, key, why, doubt }; `key` (the index of the right option) and `why` ride as the host's secret, which the server keeps and never serves;
      // `doubt` is the host having dropped a key it doubted (a quick check whose taps have no right or wrong)
      const body = JSON.parse((await readBody(req)) || '{}');
      const words = Array.isArray(body.options) && body.options.length ? body.options : DEFAULT_OPTIONS;
      const choices = words.map((text, i) => ({ label: 'ABCDEF'[i], text: String(text) }));
      const why = body.why ? { why: String(body.why) } : {};
      emit({
        kind: 'text', jid, text: body.text || 'Which of these is true of a Raft term?', choices,
        ...(body.quiz ? { quiz: true } : {}),
        ...(Number.isInteger(body.key) ? { secret: { key: body.key, ...why } } : body.doubt ? { secret: { ...why, doubt: true } } : {}),
      });
      return reply(200, { ok: true });
    }
    if (url.pathname === '/team/class' && post) {
      // the teaching view's class: ?mode=empty (nobody on the allowlist) or ?mode=full (the twelve students again); either way the view forgets what it cached
      teamClass.empty = q.get('mode') === 'empty';
      teamView.clear();
      return reply(200, { ok: true, empty: teamClass.empty });
    }
    if (url.pathname === '/unreachable' && post) {
      // "TAi cannot be reached" for this student: what they send, and a tap on an option, is refused until it is switched off (?on=0)
      if (q.get('on') === '0') unreachable.delete(user.jid); else unreachable.add(user.jid);
      return reply(200, { ok: true, unreachable: unreachable.has(user.jid) });
    }
    if (url.pathname === '/say' && post) {
      say(jid, q.get('text') || 'A short answer.');
      return reply(200, { ok: true });
    }
    if (url.pathname === '/transcript' && post) {
      notes.next = await readBody(req);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/transcript-fail' && post) {
      notes.fail = q.get('on') !== '0';
      notes.delay = parseInt(q.get('delay') || '0', 10);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/activity/add' && post) {
      // a line of the student's activity list, as the orchestrator writes one: `count` of them (numbered "#1", "#2"...), `ageMin` minutes ago
      // (so a day can be older), the body as the detail; legacy=1 writes the long call summary of the older kind instead
      const detail = (await readBody(req)).trim();
      const count = Math.max(1, Math.min(60, parseInt(q.get('count') || '1', 10)));
      const base = Date.now() - parseInt(q.get('ageMin') || '0', 10) * 60000;
      const log = history.forFolder(user.folder);
      let last;
      for (let i = 0; i < count; i++) {
        const when = new Date(base + i * 1000);
        if (q.get('legacy') === '1') {
          last = log.append('assistant', q.get('text') || 'Voice session, 4 min: we talked through Raft elections.', when, { kind: 'voice' });
        } else {
          const title = `${q.get('title') || 'Voice call · 3 min'}${count > 1 ? ` #${i + 1}` : ''}`;
          // `items=N` (1 to 8), `hostile` or `long`: the questions of a mock interview for the card to list (review.js), cleaned as the orchestrator's line is (history.ts)
          const items = q.get('items') ? clipActivity({ type: q.get('type') || 'interview', title, text: 'x', items: cannedItems(q.get('items')) })?.extra.items : undefined;
          last = log.append('assistant', q.get('text') || 'Talked through Raft leader election', when, { kind: 'activity', type: q.get('type') || 'voice', title, ...(detail ? { detail } : {}), ...(items ? { items } : {}) });
        }
      }
      portalRef.current?.wakeStudent(user.folder);
      return reply(200, { ok: true, n: last.n });
    }
    if (url.pathname === '/react-reply' && post) {
      // how long after a student's emoji on TAi's message TAi answers it, unless they type first (0: it does not). The server reads its own
      // field of that name each time an emoji comes, so it can be changed while it runs; if the field is ever renamed, this says so
      if (typeof portal.reactReplyDelayMs !== 'number') return reply(409, { error: 'the portal has no reactReplyDelayMs field to set' });
      portal.reactReplyDelayMs = Math.max(0, parseInt(q.get('ms') || '0', 10) || 0);
      return reply(200, { ok: true, ms: portal.reactReplyDelayMs });
    }
    if (url.pathname === '/upload-delay' && post) {
      uploadDelay.ms = parseInt(q.get('ms') || '0', 10);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/voice/resume-delay' && post) {
      voice.resumeDelay = parseInt(q.get('ms') || '0', 10);
      return reply(200, { ok: true });
    }
    // what the stand-in push service was asked to send this student (GET /push), and a clean slate (POST /push/reset): the notifications' flows
    if (url.pathname === '/push') return reply(200, pushLog.filter((p) => p.folder === user.folder));
    if (url.pathname === '/push/reset' && post) {
      pushLog.length = 0;
      return reply(200, { ok: true });
    }
    if (url.pathname === '/mail') return reply(200, mailLog.filter((m) => m.to === user.email));
    if (url.pathname === '/mail/reset' && post) {
      mailLog.length = 0;
      return reply(200, { ok: true });
    }
    if (url.pathname === '/notes') return reply(200, notes);
    if (url.pathname === '/seen') return reply(200, seen.filter((s) => s.jid === jid).map((s) => s.text));
    if (url.pathname === '/voice') return reply(200, voice.report());
    if (url.pathname === '/voice/reset' && post) {
      voice.reset();
      return reply(200, { ok: true });
    }
    if (url.pathname.startsWith('/voice/') && post) {
      const done = voice.command(user.folder, url.pathname.slice('/voice/'.length), q);
      return reply(done ? 200 : 409, { ok: done });
    }
    reply(404, { error: 'not found' });
  } catch (err) {
    reply(500, { error: String(err && err.message) });
  }
});
await new Promise((resolve) => control.listen(port ? port + 1 : 0, '127.0.0.1', resolve));

const at = (p) => `http://127.0.0.1:${p}/`;
const ready = { base: at(portal.address().port), control: at(control.address().port), off: at(plain.address().port) };
console.log(`pretend TAi behind the real page: ${ready.base}  (sign in as dev:ada@example.com; the E2E script does it through a fake Google button)`);
console.log(`the same page with every feature off: ${ready.off}; the tests' control port: ${ready.control}`);
console.log(`READY ${JSON.stringify(ready)}`);
