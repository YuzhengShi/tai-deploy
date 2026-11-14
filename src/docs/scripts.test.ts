import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// every run of the script starts bash and a handful of processes, which takes seconds on a Windows PC
vi.setConfig({ testTimeout: 120_000 });

/**
 * The renderer's entry script (deploy/cs6650/doc-render/doc-render), under bash with fake poppler tools that write down how they were called and make the files poppler makes (including its way of
 * numbering them, which depends on the number of pages of the file). What is checked is what the script decides: what it refuses, how it names and keeps the pages, the order and flags of the commands,
 * the way a page that is too big is drawn again, how a turned page reaches the words script (the real render-words.py runs here), and that it stops within its budget. The real poppler is
 * the smoke's (src/docs/smoke.ts, on the host).
 */
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../deploy/cs6650/doc-render');
const isWin = process.platform === 'win32';
const BASH = isWin ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe', 'D:/Program Files (x86)/Git/bin/bash.exe'].find((p) => fs.existsSync(p)) : 'bash';
const posix = (p: string): string => (isWin ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}` : p);

/** The Python this machine has: the script's own `python3`, which is `python` on a Windows PC. */
function findPython(): string | null {
  for (const name of isWin ? ['python', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(name, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
const PYTHON = findPython();
const canRun = Boolean(BASH && PYTHON);

const FAKE_PDFINFO = `#!/bin/bash
echo "pdfinfo $*" >> "$FAKE_LOG"
[ -z "\${FAKE_PDFINFO_SLEEP:-}" ] || exec sleep "$FAKE_PDFINFO_SLEEP"   # (exec: a child left behind by a killed script would hold the pipe of the caller open, which a real poppler tool, one process, does not)
case "\${FAKE_PDFINFO:-ok}" in
  password) echo "Command Line Error: Incorrect password"; exit 1 ;;
  damaged) echo "Syntax Error: Couldn't read xref table"; exit 1 ;;
esac
echo "Pages:           \${FAKE_PAGES:-3}"
echo "Encrypted:       no"
for i in $(seq 1 "\${FAKE_PAGES:-3}"); do
  echo "Page $(printf '%4d' "$i") size:  \${FAKE_SIZE:-612 x 792} pts"
  rot=0; [ "$i" = "\${FAKE_TURNED_PAGE:-0}" ] && rot=90
  [ "$i" != 1 ] || [ -z "\${FAKE_FIRST_ROT:-}" ] || rot=$FAKE_FIRST_ROT
  echo "Page $(printf '%4d' "$i") rot:   $rot"
done
`;

const FAKE_PDFTOPPM = `#!/bin/bash
echo "pdftoppm $*" >> "$FAKE_LOG"
[ -z "\${FAKE_PDFTOPPM_SLEEP:-}" ] || exec sleep "$FAKE_PDFTOPPM_SLEEP"
fmt=png; first=1; last=1; single=0; quality=0; prefix=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    -png) fmt=png ;;
    -jpeg) fmt=jpg ;;
    -jpegopt) quality=\${args[i+1]#quality=} ;;
    -f) first=\${args[i+1]} ;;
    -l) last=\${args[i+1]} ;;
    -singlefile) single=1 ;;
  esac
done
prefix=\${args[\${#args[@]}-1]}
total=\${FAKE_PAGES:-3}
width=\${#total}
make() { # make FILE SIZE
  head -c "$2" /dev/zero > "$1"
}
for ((p = first; p <= last; p++)); do
  if [ "$single" = 1 ]; then file="$prefix.$fmt"; else file="$prefix-$(printf "%0\${width}d" "$p").$fmt"; fi
  size=\${FAKE_PNG_SIZE:-300}
  case " \${FAKE_BIG_PAGES:-} " in *" $p "*) size=\${FAKE_BIG_SIZE:-5000} ;; esac
  [ "$fmt" = png ] || { size=300; case " \${FAKE_BIG_JPEG_Q:-} " in *" $quality "*) size=\${FAKE_BIG_SIZE:-5000} ;; esac; case " \${FAKE_NEVER_FITS:-} " in *" $p "*) size=\${FAKE_BIG_SIZE:-5000} ;; esac; }
  make "$file" "$size"
done
[ -z "\${FAKE_STRAY:-}" ] || { make "$(dirname "$prefix")/pg-abc.png" 10; make "$(dirname "$prefix")/pg-999.png" 10; }
exit 0
`;

const BBOX_PAGE = (n: number): string => `  <page width="612.000000" height="792.000000">
    <flow>
      <block xMin="72" yMin="74" xMax="276" yMax="96">
        <line xMin="72" yMin="74" xMax="276" yMax="96">
          <word xMin="72.000000" yMin="74.768000" xMax="133.368000" yMax="96.968000">Page${n}</word>
          <word xMin="140.040000" yMin="74.768000" xMax="189.408000" yMax="96.968000">words</word>
        </line>
      </block>
    </flow>
  </page>
`;
const FAKE_PDFTOTEXT = `#!/bin/bash
echo "pdftotext $*" >> "$FAKE_LOG"
last=1
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do [ "\${args[i]}" = -l ] && last=\${args[i+1]}; done
echo '<!DOCTYPE html><html><head></head><body><doc>'
for ((p = 1; p <= last; p++)); do
  echo '  <page width="612.000000" height="792.000000"><flow><block><line>'
  echo "    <word xMin=\\"72.000000\\" yMin=\\"74.768000\\" xMax=\\"133.368000\\" yMax=\\"96.968000\\">Page$p</word>"
  [ "$p" != "\${FAKE_TURNED_PAGE:-0}" ] || echo '    <word xMin="695.032000" yMin="72.000000" xMax="717.232000" yMax="156.048000">Turned</word>'
  echo '  </line></block></flow></page>'
done
echo '</doc></body></html>'
[ "\${FAKE_PDFTOTEXT_FAIL:-0}" = 0 ] || exit 1
exit 0
`;
void BBOX_PAGE;

/** A LibreOffice that writes down how it was called and what the profile it was given holds, and makes a PDF of the file the way soffice names it (<name>.pdf in --outdir). */
const FAKE_SOFFICE = `#!/bin/bash
echo "soffice $*" >> "$FAKE_LOG"
[ -z "\${FAKE_SOFFICE_SLEEP:-}" ] || exec sleep "$FAKE_SOFFICE_SLEEP"
args=("$@"); profile=""; outdir=""
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in -env:UserInstallation=file://*) profile=\${args[i]#-env:UserInstallation=file://} ;; esac
  [ "\${args[i]}" = --outdir ] && outdir=\${args[i+1]}
done
input=\${args[\${#args[@]}-1]}
[ -z "\${FAKE_PROFILE_LOG:-}" ] || cat "$profile/user/registrymodifications.xcu" >> "$FAKE_PROFILE_LOG"
[ -z "\${FAKE_INPUT_LOG:-}" ] || { [ -L "$input" ] && echo link >> "$FAKE_INPUT_LOG"; [ -f "$input" ] && echo file >> "$FAKE_INPUT_LOG"; }
case "\${FAKE_SOFFICE:-ok}" in
  fail) exit 1 ;;
  none) exit 0 ;;
esac
base=$(basename "$input"); base=\${base%.*}
echo "%PDF-1.4" > "$outdir/$base.pdf"
exit 0
`;

/** A zip with these entries, made by the Python this machine has (the script's own office-kind.py reads it: that part is real here). */
function makeZip(file: string, entries: Record<string, string>): void {
  const code = "import sys, json, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n    for n, d in json.load(sys.stdin).items(): z.writestr(n, d)\n";
  // (the entries go in on stdin: a command line of a Windows PC is far too short for thousands of them)
  const r = spawnSync(PYTHON as string, ['-c', code, file], { encoding: 'utf8', input: JSON.stringify(entries) });
  if (r.status !== 0) throw new Error(`could not make a zip: ${r.stderr}`);
}
const TYPES = '<?xml version="1.0"?><Types/>';
const DECK = { '[Content_Types].xml': TYPES, 'ppt/presentation.xml': '<p/>', 'ppt/slides/slide1.xml': '<s/>' };

let tmp: string;
let inDir: string;
let outDir: string;
let bin: string;
let logFile: string;
let workDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-script-'));
  inDir = path.join(tmp, 'in');
  outDir = path.join(tmp, 'out');
  bin = path.join(tmp, 'bin');
  logFile = path.join(tmp, 'calls.log');
  workDir = path.join(tmp, 'work');
  for (const d of [inDir, outDir, bin, workDir]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(inDir, 'source.pdf'), '%PDF-1.4\n');
  if (canRun) {
    for (const [name, text] of [['fake-pdfinfo', FAKE_PDFINFO], ['fake-pdftoppm', FAKE_PDFTOPPM], ['fake-pdftotext', FAKE_PDFTOTEXT], ['fake-python3', `#!/bin/bash\nexec "${posix(PYTHON as string)}" "$@"\n`], ['fake-soffice', FAKE_SOFFICE]]) {
      fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
    }
  }
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function render(args: string[] = ['pdf', '120', '1100'], env: Record<string, string> = {}, timeoutMs = 60_000) {
  const r = spawnSync(BASH as string, [posix(path.join(DIR, 'doc-render')), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      PATH: `${posix(bin)}:${process.env.PATH}`,
      DOC_IN: posix(inDir),
      DOC_OUT: posix(outDir),
      DOC_WORDS_SCRIPT: posix(path.join(DIR, 'render-words.py')),
      DOC_IMAGE_BYTES: '1000',
      DOC_PDFINFO: posix(path.join(bin, 'fake-pdfinfo')),
      DOC_PDFTOPPM: posix(path.join(bin, 'fake-pdftoppm')),
      DOC_PDFTOTEXT: posix(path.join(bin, 'fake-pdftotext')),
      DOC_PYTHON: posix(path.join(bin, 'fake-python3')),
      DOC_SOFFICE: posix(path.join(bin, 'fake-soffice')),
      DOC_OFFICE_KIND_SCRIPT: posix(path.join(DIR, 'office-kind.py')),
      DOC_TMP: posix(workDir),
      FAKE_LOG: posix(logFile),
      PYTHONIOENCODING: 'utf-8',
      ...env,
    },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}
const calls = (tool: string): string[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith(`${tool} `)) : []);
const files = (): string[] => fs.readdirSync(outDir).sort();
const meta = () => JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
const words = (n: number) => JSON.parse(fs.readFileSync(path.join(outDir, `w${String(n).padStart(3, '0')}.json`), 'utf8'));

describe.skipIf(!canRun)('what the script refuses', () => {
  it('says one line and exits 2 for a kind it does not read, and for limits that are not numbers', () => {
    for (const args of [['video', '120', '1100'], ['Office', '120', '1100'], [], ['office'], ['office', 'many', '1100'], ['office', '120', 'big'], ['pdf'], ['pdf', 'many', '1100'], ['pdf', '120', 'big'], ['pdf', '0', '1100'], ['pdf', '501', '1100'], ['pdf', '12', '199'], ['pdf', '12', '4001'], ['pdf', '1; rm -rf /', '1100'], ['pdf', '12', '1100; id']]) {
      const r = render(args);
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect(r.stdout.trim().split('\n').filter((l) => l.startsWith('doc: '))).toHaveLength(1);
    }
    expect(calls('pdfinfo')).toEqual([]); // not a tool was started for any of them
  });

  it('refuses a missing source, a source that is a link, and an output directory that is not there', () => {
    fs.rmSync(path.join(inDir, 'source.pdf'));
    expect(render().stdout).toContain('doc: there is no file to read.');
    fs.writeFileSync(path.join(tmp, 'elsewhere.pdf'), '%PDF-1.4');
    try {
      fs.symlinkSync(path.join(tmp, 'elsewhere.pdf'), path.join(inDir, 'source.pdf'));
      expect(render().stdout).toContain('doc: there is no file to read.');
    } catch {
      /* a platform that does not let this user make links */
    }
    fs.rmSync(path.join(inDir, 'source.pdf'), { force: true });
    fs.writeFileSync(path.join(inDir, 'source.pdf'), '%PDF-1.4');
    fs.rmSync(outDir, { recursive: true });
    const r = render();
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('doc: there is nowhere to put the pages.');
  });

  it('says what pdfinfo says of a file in the few sentences it has: a password, a file that is not a PDF, no pages', () => {
    expect(render(undefined, { FAKE_PDFINFO: 'password' })).toMatchObject({ code: 2 });
    expect(render(undefined, { FAKE_PDFINFO: 'password' }).stdout).toContain('doc: the file is protected with a password.');
    expect(render(undefined, { FAKE_PDFINFO: 'damaged' }).stdout).toContain('doc: the file could not be read as a PDF.');
    expect(render(undefined, { FAKE_PAGES: '0' }).stdout).toContain('doc: the file has no pages.');
    expect(calls('pdftoppm')).toEqual([]);
    expect(files()).toEqual([]);
  });

  it('says no page could be drawn when pdftoppm made none, and keeps nothing', () => {
    fs.writeFileSync(path.join(bin, 'fake-pdftoppm'), '#!/bin/bash\necho "pdftoppm $*" >> "$FAKE_LOG"\nexit 1\n', { mode: 0o755 });
    const r = render();
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('doc: no page of the file could be drawn.');
    expect(files()).toEqual([]);
  });
});

describe.skipIf(!canRun)('the pages of a file', () => {
  it('makes p001.png ... w001.json ... and meta.json, with poppler\'s own numbering made ours (two digits for a file of ten pages, three for a hundred and fifty)', () => {
    for (const pages of ['3', '12', '150']) {
      fs.rmSync(outDir, { recursive: true });
      fs.mkdirSync(outDir);
      const r = render(['pdf', '20', '1100'], { FAKE_PAGES: pages }); // (a limit of 20 pages: every file in this loop is a few seconds of processes on a Windows PC)
      expect(r.code, r.out).toBe(0);
      const n = Math.min(Number(pages), 20);
      const names = files();
      expect(names.filter((f) => f.startsWith('p')).length).toBe(n);
      expect(names).toContain('p001.png');
      expect(names).toContain(`p${String(n).padStart(3, '0')}.png`);
      expect(names.filter((f) => f.startsWith('pg'))).toEqual([]); // no file under poppler's name is left
      expect(names.filter((f) => f.startsWith('w')).length).toBe(n);
      expect(meta()).toEqual({ pages: n, pagesInFile: Number(pages), aspect: 0.7727 });
    }
  });

  it('asks poppler for the pages up to the limit only, in the size it was given, with the same box for the image and the words', () => {
    const r = render(['pdf', '7', '900'], { FAKE_PAGES: '20' });
    expect(r.code, r.out).toBe(0);
    const toppm = calls('pdftoppm')[0];
    expect(toppm).toMatch(/-png/);
    expect(toppm).toMatch(/-cropbox/);
    expect(toppm).toMatch(/-scale-to 900/);
    expect(toppm).toMatch(/-f 1 -l 7 /);
    expect(calls('pdftotext')[0]).toMatch(/-bbox-layout -cropbox -enc UTF-8 -f 1 -l 7 /);
    expect(calls('pdftotext')[0]).toMatch(/ -$/); // to stdout: no file of tens of MB
    expect(meta()).toEqual({ pages: 7, pagesInFile: 20, aspect: 0.7727 });
    expect(calls('pdfinfo')).toEqual([expect.stringMatching(/^pdfinfo -f 1 -l 7 /)]);
  });

  it('removes files poppler made that are not a page of the run (a name that is not a number, a number past the limit)', () => {
    const r = render(['pdf', '3', '1100'], { FAKE_PAGES: '3', FAKE_STRAY: '1' });
    expect(r.code).toBe(0);
    expect(files().filter((f) => f.startsWith('pg'))).toEqual([]);
    expect(files().filter((f) => f.startsWith('p') && f.endsWith('.png'))).toEqual(['p001.png', 'p002.png', 'p003.png']);
  });

  it('writes the shape of page 1 as it is shown: wider than high for a slide, and a page turned a quarter the other way round', () => {
    expect(render(undefined, { FAKE_SIZE: '1920 x 1080' }).code).toBe(0);
    expect(meta().aspect).toBe(1.7778);
    fs.rmSync(outDir, { recursive: true });
    fs.mkdirSync(outDir);
    expect(render(undefined, { FAKE_SIZE: '1920 x 1080', FAKE_FIRST_ROT: '90' }).code).toBe(0);
    expect(meta().aspect).toBe(0.5625);
    fs.rmSync(outDir, { recursive: true });
    fs.mkdirSync(outDir);
    expect(render(undefined, { FAKE_SIZE: '1920 x 1080', FAKE_FIRST_ROT: '180' }).code).toBe(0);
    expect(meta().aspect).toBe(1.7778);
  });

  it('gives the words script the pages that are turned, so that their boxes are measured in the turned frame', () => {
    const r = render(undefined, { FAKE_PAGES: '3', FAKE_TURNED_PAGE: '2' });
    expect(r.code).toBe(0);
    expect(words(1).words[0]).toEqual([0.1176, 0.0944, 0.2179, 0.1224, 'Page1']);
    expect(words(2).words[1][4]).toBe('Turned');
    expect(words(2).words[1][2]).toBeLessThan(1); // 717 of 792, not 717 of 612
    expect(words(2).words[1][0]).toBeCloseTo(695.032 / 792, 3);
  });

  it('goes on without words when pdftotext fails, and a page then has none; the pages and meta.json are still made', () => {
    fs.writeFileSync(path.join(bin, 'fake-pdftotext'), '#!/bin/bash\necho "pdftotext $*" >> "$FAKE_LOG"\nexit 1\n', { mode: 0o755 });
    const r = render();
    expect(r.code).toBe(0);
    expect(files().filter((f) => f.startsWith('w'))).toEqual([]);
    expect(meta().pages).toBe(3);
  });
});

describe.skipIf(!canRun)('a page whose PNG is over the size cap', () => {
  it('is drawn again as a JPEG that fits (quality 70 first), and the PNG goes', () => {
    const r = render(undefined, { FAKE_PAGES: '4', FAKE_BIG_PAGES: '2' });
    expect(r.code).toBe(0);
    expect(files().filter((f) => /^p00[1-4]\./.test(f))).toEqual(['p001.png', 'p002.jpg', 'p003.png', 'p004.png']);
    const again = calls('pdftoppm')[1];
    expect(again).toMatch(/-jpeg -jpegopt quality=70/);
    expect(again).toMatch(/-f 2 -l 2/);
    expect(again).toMatch(/-singlefile/);
    expect(meta().pages).toBe(4);
  });

  it('tries rougher and smaller before giving up on the page', () => {
    const r = render(undefined, { FAKE_PAGES: '3', FAKE_BIG_PAGES: '2', FAKE_BIG_JPEG_Q: '70 50' });
    expect(r.code).toBe(0);
    expect(files()).toContain('p002.jpg');
    const jpegCalls = calls('pdftoppm').filter((c) => c.includes('-jpeg'));
    expect(jpegCalls).toHaveLength(3);
    expect(jpegCalls[1]).toMatch(/quality=50.*-scale-to 935/);
    expect(jpegCalls[2]).toMatch(/quality=35.*-scale-to 770/);
  });

  it('is left out, with every page after it, when nothing fits: the pages are the run from page 1', () => {
    const r = render(undefined, { FAKE_PAGES: '5', FAKE_BIG_PAGES: '3', FAKE_NEVER_FITS: '3' });
    expect(r.code).toBe(0);
    expect(files().filter((f) => /^p\d{3}\./.test(f))).toEqual(['p001.png', 'p002.png', 'p004.png', 'p005.png']); // (the host keeps the first two)
    expect(meta()).toEqual({ pages: 2, pagesInFile: 5, aspect: 0.7727 });
  });

  it('draws all the pages as JPEG in one pass when most of them are pictures, instead of one process for each page', () => {
    const r = render(undefined, { FAKE_PAGES: '10', FAKE_BIG_PAGES: '1 2 3 4 5 6 7 8' });
    expect(r.code).toBe(0);
    const names = files().filter((f) => /^p\d{3}\./.test(f));
    expect(names).toEqual(['p001.jpg', 'p002.jpg', 'p003.jpg', 'p004.jpg', 'p005.jpg', 'p006.jpg', 'p007.jpg', 'p008.jpg', 'p009.jpg', 'p010.jpg']);
    const jpegCalls = calls('pdftoppm').filter((c) => c.includes('-jpeg'));
    expect(jpegCalls).toHaveLength(1);
    expect(jpegCalls[0]).toMatch(/quality=70.*-f 1 -l 10 /);
    expect(files().filter((f) => f.startsWith('pj'))).toEqual([]);
    expect(meta().pages).toBe(10);
  });
});

describe.skipIf(!canRun)('its time', () => {
  it('stops a step that takes too long and answers within its budget: a pdftoppm that never ends is no page', () => {
    const began = Date.now();
    const r = render(undefined, { DOC_BUDGET: '4', FAKE_PDFTOPPM_SLEEP: '40' }, 40_000);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('doc: no page of the file could be drawn.');
    expect(Date.now() - began).toBeLessThan(25_000);
  });

  it('stops a pdfinfo that never ends, and says it could not read the file', () => {
    const r = render(undefined, { DOC_BUDGET: '3', FAKE_PDFINFO_SLEEP: '40' }, 40_000);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('doc: the file could not be read as a PDF.');
  });
});

describe.skipIf(!canRun)('what it prints', () => {
  it('prints nothing of its own when it works but the memory line, which comes last and is a number', () => {
    const r = render();
    expect(r.code).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines.every((l) => /^doc-mem \d{1,13}$/.test(l))).toBe(true);
    if (lines.length > 0) expect(lines).toHaveLength(1);
  });

  it('prints its refusal before the memory line', () => {
    const r = render(['pdf', '120', 'big']);
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('doc: the size limit is not a number.');
    for (const extra of lines.slice(1)) expect(extra).toMatch(/^doc-mem \d+$/);
  });
});

describe.skipIf(!canRun)('an Office file', () => {
  const office = (entries: Record<string, string> = DECK): void => makeZip(path.join(inDir, 'source.bin'), entries);
  const ofOffice = (env: Record<string, string> = {}, args: string[] = ['office', '120', '1100'], timeoutMs = 60_000) => render(args, env, timeoutMs);
  const left = (): string[] => fs.readdirSync(workDir);

  it('is made a PDF by soffice (headless, a profile of its own, the file under the name its kind has), and then goes the way a PDF goes: the same files come out', () => {
    office();
    const r = ofOffice({ FAKE_PAGES: '3' });
    expect(r.code, r.out).toBe(0);
    expect(files()).toEqual(['meta.json', 'p001.png', 'p002.png', 'p003.png', 'w001.json', 'w002.json', 'w003.json']);
    expect(meta()).toEqual({ pages: 3, pagesInFile: 3, aspect: 0.7727 });
    const soffice = calls('soffice');
    expect(soffice).toHaveLength(1);
    expect(soffice[0]).toMatch(/--headless --norestore --nolockcheck --nodefault --nofirststartwizard --nologo -env:UserInstallation=file:\/\/\S+\/office\.[A-Za-z0-9]+\/profile --convert-to pdf:impress_pdf_Export:\{.*\} --outdir \S+\/office\.[A-Za-z0-9]+\/out \S+\/deck\.pptx$/);
    // poppler reads the converted PDF and never the staged file
    for (const tool of ['pdfinfo', 'pdftoppm', 'pdftotext']) expect(calls(tool)[0], tool).toMatch(/office\.[A-Za-z0-9]+\/out\/deck\.pdf/);
    expect(calls('pdfinfo')[0]).not.toContain('source.bin');
  });

  it('gives each kind its own export filter and the file its own extension: a deck is Impress, a document Writer, a workbook Calc (the pages of a sheet are limited to the ones kept)', () => {
    office({ '[Content_Types].xml': TYPES, 'word/document.xml': '<w/>' });
    expect(ofOffice().code).toBe(0);
    office({ '[Content_Types].xml': TYPES, 'xl/workbook.xml': '<x/>' });
    expect(ofOffice({}, ['office', '9', '1100']).code).toBe(0);
    const [docx, xlsx] = calls('soffice');
    expect(docx).toMatch(/--convert-to pdf:writer_pdf_Export:\{.*\} --outdir .*\/deck\.docx$/);
    expect(docx).not.toContain('PageRange');
    expect(xlsx).toMatch(/--convert-to pdf:calc_pdf_Export:\{.*"PageRange":\{"type":"string","value":"1-9"\}\} .*\/deck\.xlsx$/);
    for (const call of [docx, xlsx]) expect(call).toContain('"ReduceImageResolution":{"type":"boolean","value":"true"}');
  });

  it('puts the file under that name as a link to the staged file (nothing is copied), and switches macros off in the profile it converts with', () => {
    office();
    const profileLog = path.join(tmp, 'profile.log');
    const inputLog = path.join(tmp, 'input.log');
    expect(ofOffice({ FAKE_PROFILE_LOG: posix(profileLog), FAKE_INPUT_LOG: posix(inputLog) }).code).toBe(0);
    const profile = fs.readFileSync(profileLog, 'utf8');
    expect(profile).toContain('<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>');
    expect(profile).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>');
    expect(profile).toContain('org.openoffice.Office.Calc/Content/Update');
    const input = fs.readFileSync(inputLog, 'utf8').split('\n').filter(Boolean);
    if (!isWin) expect(input).toEqual(['link', 'file']); // (a link that resolves to a regular file; a Windows checkout may have made a copy)
  });

  it('refuses what is not an Office file in one line each, before soffice is started', () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['a plain archive', { 'readme.txt': 'hello' }, 'doc: the file is not a PowerPoint, Word or Excel file.'],
      ['an OpenDocument file', { mimetype: 'x', 'content.xml': '<c/>' }, 'doc: the file is not a PowerPoint, Word or Excel file.'],
      ['a package with macros', { '[Content_Types].xml': TYPES, 'word/document.xml': '<w/>', 'word/vbaProject.bin': 'x' }, 'doc: the file contains macros.'],
      ['a deck with no presentation part', { '[Content_Types].xml': TYPES, 'ppt/slides/slide1.xml': '<s/>' }, 'doc: the file could not be read as an Office file.'],
      [
        'too many parts',
        Object.fromEntries([['[Content_Types].xml', TYPES], ['ppt/presentation.xml', '<p/>'], ...Array.from({ length: 3200 }, (_, i) => [`ppt/media/m${i}.xml`, 'x'])]),
        'doc: the file has too many parts or is too big when unpacked.',
      ],
    ];
    for (const [what, entries, line] of cases) {
      office(entries);
      const r = ofOffice();
      expect(r.code, what).toBe(2);
      expect(r.stdout.split('\n').filter((l) => l.startsWith('doc: ')), what).toEqual([line]);
    }
    fs.writeFileSync(path.join(inDir, 'source.bin'), 'This is plain text under a neutral name. '.repeat(30));
    expect(ofOffice().stdout).toContain('doc: the file could not be read as an Office file.');
    fs.writeFileSync(path.join(inDir, 'source.bin'), '');
    expect(ofOffice().stdout).toContain('doc: the file could not be read as an Office file.');
    expect(calls('soffice')).toEqual([]);
    expect(files()).toEqual([]);
    expect(left()).toEqual([]);
  });

  it('refuses a source that is missing or a link, as it does for a PDF', () => {
    expect(ofOffice().stdout).toContain('doc: there is no file to read.');
    fs.writeFileSync(path.join(tmp, 'elsewhere.bin'), 'x');
    try {
      fs.symlinkSync(path.join(tmp, 'elsewhere.bin'), path.join(inDir, 'source.bin'));
      expect(ofOffice().stdout).toContain('doc: there is no file to read.');
    } catch {
      /* a platform that does not let this user make links */
    }
  });

  it('says it could not be converted when soffice fails or makes no PDF, and a PDF poppler cannot read is a file that was not converted (not "not a real PDF")', () => {
    office();
    const failures: Array<Record<string, string>> = [{ FAKE_SOFFICE: 'fail' }, { FAKE_SOFFICE: 'none' }, { FAKE_PDFINFO: 'damaged' }];
    for (const env of failures) {
      const r = ofOffice(env);
      expect(r.code, JSON.stringify(env)).toBe(2);
      expect(r.stdout.split('\n').filter((l) => l.startsWith('doc: ')), JSON.stringify(env)).toEqual(['doc: the file could not be converted.']);
    }
    expect(files()).toEqual([]);
    expect(left()).toEqual([]); // the profile and the PDF are gone
  });

  it('stops a conversion that takes too long, and says so', () => {
    office();
    const began = Date.now();
    const r = ofOffice({ DOC_CONVERT_SECONDS: '2', FAKE_SOFFICE_SLEEP: '40' }, ['office', '120', '1100'], 40_000);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('doc: converting the file took too long.');
    expect(Date.now() - began).toBeLessThan(25_000);
    expect(left()).toEqual([]);
  });

  it('reports how long the conversion took on a line of its own, before the memory line, and leaves nothing of its own behind', () => {
    office();
    const r = ofOffice({ FAKE_PAGES: '2' });
    const lines = r.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/^doc-conv \d{1,9}$/);
    for (const extra of lines.slice(1)) expect(extra).toMatch(/^doc-mem \d+$/);
    expect(left()).toEqual([]);
    expect(files().filter((f) => !/^(p\d{3}\.png|w\d{3}\.json|meta\.json)$/.test(f))).toEqual([]);
  });

  it('is held to a budget of its own, 130 seconds, and a PDF to 70 (the one that is passed in wins for both)', () => {
    office();
    const r = ofOffice({ DOC_BUDGET: '3', FAKE_PDFINFO_SLEEP: '40', FAKE_PAGES: '2' }, ['office', '120', '1100'], 40_000);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('doc: the file could not be converted.');
    const source = fs.readFileSync(path.join(DIR, 'doc-render'), 'utf8');
    expect(source).toMatch(/pdf\)[\s\S]*BUDGET=\$\{DOC_BUDGET:-70\}/);
    expect(source).toMatch(/office\)[\s\S]*BUDGET=\$\{DOC_BUDGET:-130\}/);
  });
});
