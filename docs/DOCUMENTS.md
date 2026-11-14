# The document viewer's host side (batch B1a of docs/CHAT_OBJECTS.md, 2026-11-07)

A student attaches a PDF (lecture slides exported to PDF, a paper, the assignment, their report), and TAi and the student look at it together: the pages are shown beside the chat, TAi can point at a phrase, and
the student can ask about "this page". This file is the host's half: how a PDF becomes page images and the words of each page, where they are kept, what may ask for them, and what was measured. The page's
viewer (`portal/web/viewer.js`), the view state and the voice functions (`show_document`, `point_at`, `look_at_screen`) are other batches (docs/CHAT_OBJECTS.md sections 3 to 5).

## What it is, what it is not

* It turns a PDF the student attached into one image of each page (at most 120 pages) and the words of each page with their boxes, keeps them for the student, and answers the routes and tools below.
* It does not read a document for TAi: the model is told that a card is in the chat and what the document is called, never its text. What TAi learns of a page is what the VIEW says (the page the student is on, the words
  they selected: `src/chat-objects/view.ts`, built from the words this service keeps).
* A PDF, a PowerPoint, a Word or an Excel file (batch C1: docs/COURSE_DOCS.md). A file is a PDF when its bytes begin `%PDF-` and a zip (`PK\3\4`) is sent to the container as an Office file, whatever the name says: the container's script reads the
  zip's entry names and decides whether it is a deck, a document or a workbook, or none of them. Anything else is refused in words (an older `.ppt`, `.doc` or `.xls`, which is not a zip, has a sentence of its own).
* It never parses a file in the orchestrator's process. A PDF is read by poppler inside a disposable container (below) and nowhere else.

## Where things are kept

```
<store>/portal/docs/<folder>/<id>/        a student's own; <folder> is their chat folder (isChatFolder), <id> is 32 random hex digits (the only thing that becomes a path segment)
  meta.json                               DocMeta (id, title, pages, pagesInFile?, origin, createdAt, bytes, aspect?)
  p001.png | p001.jpg ...                 one image of each page; the type is sniffed from the bytes whenever a page is served, never taken from a name
  w001.json ...                           PageWords of each page: { words: [[x0, y0, x1, y1, text]], lines: [[first, last]] }, boxes as fractions of the page
  source.json                             { sha256, name }: so that the same file is the same document (never in DocMeta)
  (the renderer's own copy of the source is `in/source.pdf`, or `in/source.bin` for an Office file: a neutral name, see below)
  opened                                  an empty file whose modification time is the last open: the clock of the 30 days
<store>/course-docs/<id>/                 the course library (the operator's `course-docs add` fills it, docs/COURSE_DOCS.md): the same layout, read-only for students, looked at after the student's own; ids are unique across both
<store>/course-docs/index.json            the library's index: id, title, week, source name, pages and the SHA-256 of each deck's source file
<data>/docs/run-<16 hex>/                 the renderer's working directories: in/source.pdf and out/; removed when a render ends
```

`<store>` is the orchestrator's `STORE_DIR` and `<data>` its `DATA_DIR` (`src/index.ts`). Everything is written by the host from bytes it checked: a document is made in `<folder>/.tmp-<id>/` and appears with ONE rename.
`tai_live.sh backup` leaves `store/portal/docs` and `store/course-docs` out: the images are made again from `groups/<folder>/uploads`, and are big.

### Limits (`DOC_LIMITS` in `src/docs/types.ts`; each is a constant with a test)

| what | limit |
|---|---|
| source file | 20 MB (an upload is at most 5 MB through the page; a larger file is a Canvas file or a course deck) |
| pages kept of one document | 120 (the meta says how many the file has: `pagesInFile`) |
| a page image | longest side 1,100 px, 900 KB; a PNG over 900 KB is drawn again as a JPEG (below) |
| words of a page | 4,000 (the lines are cut to match), a word at most 40 characters |
| what one student keeps | 8 documents and 60 MB: a new one that does not fit makes the one **opened longest ago** go first; one bigger than the whole room is cut to the pages that fit (`pagesInFile` says so) |
| new renders | 6 in ten minutes and 20 a day for a student (the admin chat is exempt); in memory, the store's quota is the real bound. **Only renders count**: opening a document that is kept (a card, an id, the same file again) is free |
| at once on the host | 2 renders, 4 waiting for at most 15 s, one at a time for a student |
| kept | 30 days after the last open (opening it, or serving one of its pages, marks it) |
| one render | 90 s of the host's clock for the container (the script holds its own steps to 70), 1 GB, 1 CPU, 64 processes, 64 MB of memory-backed /tmp |
| one render of an Office file | 150 s (the script holds its steps to 130) and 1.5 GB; everything else is the same (docs/COURSE_DOCS.md) |

## The renderer

`deploy/cs6650/doc-render/`: a Dockerfile (`tai-doc:live`: `python:3.12-slim` the host already has, plus `poppler-utils`, `fontconfig`, `fonts-liberation` and `fonts-dejavu-core` from the Debian mirrors, so the build needs no
registry pull; `--base` names another copy of the python image), the entry script `doc-render` (bash) and `render-words.py` (python3, regular expressions and `html.unescape`, no XML parser). Built by the operator
(`tai_live.sh doc build`), never by a deploy; the scripts are the last layer, so a change to them rebuilds in under a minute.

`doc-render pdf <maxPages> <maxPx>` runs inside the container on `/in/source.pdf` (read-only) and writes `/out` (`doc-render office <maxPages> <maxPx>` does the same on `/in/source.bin` after making a PDF of it with LibreOffice: docs/COURSE_DOCS.md):

1. `pdfinfo -f 1 -l <maxPages>`: the page count, the first page's size, and which pages are turned (`rot: 90`). A password or a file that is not a PDF is `doc: <reason>` and exit 2.
2. `pdftoppm -png -cropbox -scale-to <maxPx>` for pages 1 to N in one process. Poppler pads the page number in the file name as it likes, so the script takes the number out of each name and writes `p001.png`.
   The crop box is used for the image and for the words, so that they agree on what the page is.
3. A page whose PNG is over 900 KB is drawn again as `p001.jpg` at quality 70, then rougher and smaller (50 at 85%, 35 at 70%); when more than six pages need it, one pass draws them all as JPEG. A page that fits no
   rung ends the run of pages there.
4. `pdftotext -bbox-layout -cropbox -enc UTF-8` for all pages, piped into `render-words.py`, which writes `w001.json` for each page as it reads (one page in memory at a time), with boxes as fractions of the page as it is
   SHOWN. **A page turned a quarter is a trap**: poppler prints the page's size from before the turn but the words in the turned frame (x up to 717 on a "612 wide" page), so the script is given the rotations
   from `pdfinfo` and swaps width and height for those pages (the smoke checks the box against the ink on the turned page). A page with no text layer (a scan) has an empty list.
5. `meta.json`: `{ pages, pagesInFile, aspect }` (aspect from `pdfinfo`'s size of page 1, turned if need be).
6. The last line printed is `doc-mem <bytes>`, the container's peak memory from the cgroup (`/sys/fs/cgroup/memory.peak`): for the log and the smoke only.

Every step runs under `timeout -s KILL`, and together the steps are held to 70 seconds, because the host kills the container at 90. What the script prints is data the host does not believe: the refusals it can say are
matched against four fixed lines (`password`, `not a PDF`, `no pages`, `no page could be drawn`), and only the host's own sentence for the match is passed on.

### The container's flags (`src/docs/render.ts renderContainerSpec`, tested flag by flag)

`--name tai-doc-<12 hex>` and `--label tai-doc=1 --label tai-doc-started=<ms>` (the reaper only ever touches names that match `/^tai-doc-[0-9a-f]{12}$/`), `--pull never`, `--init`, `--log-driver none`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, `--read-only`, `--network none`, `--pids-limit 64`, `--memory 1024m --memory-swap 1024m`, `--cpus 1`, `--user <the host's uid:gid>`, `--ulimit nofile=256:256 fsize=64MB core=0`,
`--hostname doc`, `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m`, `--workdir /tmp`, `-v <run>/in:/in:ro`, `-v <run>/out:/out:rw` (the one other writable place), and a fixed environment
(`HOME=/tmp LC_ALL=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 TZ=UTC XDG_CACHE_HOME=/tmp`: nothing is inherited). Arguments go to `docker` as an array (no shell); the only things of the request on the command line are two integers
the host chose. Not `--rm`: the runner asks Docker how the container ended (the kernel's OOM flag, its own clock) and removes it itself in a `finally`.

### What the host takes back (`src/docs/readback.ts`)

The output directory is the host's own directory in which a container wrote, from a file nobody trusts. After the container is gone (`docker rm -f` has returned):

* the directory is walked with `opendir` and a cap of 2 x pages + 8 entries (more means the render failed); only names that match `p<3 digits>.png|jpg`, `w<3 digits>.json` and `meta.json` are ever opened;
* each is read with `readBytesSafe` (lstat, opened with no-follow and no-block, a regular file, size checked on the descriptor): a link, a FIFO, a directory or a file over its cap is "no file";
* a page image must begin as a PNG (signature and a 13 byte IHDR) or a JPEG (baseline, extended or progressive frame header) and say a size of at most 1,104 pixels on each side (a small file can say it is 50,000
  pixels wide, and the student's browser would decode it); the **aspect is taken from page 1's own header**, and `pages` is counted from the images, never from the container's count;
* every words file goes through `validateWords` (src/docs/words.ts); one that does not pass is no words, and counted in the log;
* only `pagesInFile` is taken from `meta.json`, and only as a whole number above the pages kept;
* the pages are the run from page 1 to the first one that is missing, bad or ambiguous (a PNG and a JPEG for one page), and stop when the room one student has (60 MB) is used.

The host then WRITES ITS OWN FILES from those bytes; nothing the container made is moved or linked into the store.

## The service (`src/docs/docs.ts`, `createDocs(deps): DocsApi`)

`open(who, source)` answers a `DocOpenResult` and never throws: a document, or a sentence a model can say for every refusal.

1. the source is read: an `upload` by `readBytesSafe(<groups>/<folder>/uploads/<name>, 20 MB, <groups>/<folder>)` after the name passes the upload store's own rule (one segment of letters, digits and `._-`, not starting with a dot);
   `bytes` as given; `existing` is an id the student has (another student's, or one that does not exist, is `not-found`, and so is a folder that is not a chat folder);
2. the KIND is decided from the first bytes (`%PDF-` is a PDF, a zip is an Office file for the container to decide on); an older Office file (the signature of the old container, `.ppt`, `.doc`, `.xls`, or a protected `.docx`) and anything else are refused in words; an empty file or one over 20 MB is refused before any container;
3. the same file prepared before is the same document (SHA-256 against the student's `source.json` files): no render, no count, the document's thirty days start again;
4. the image is there (`off` when it is not), one render at a time for the student (`busy`), the student's renders (`limit`; when both the ten minutes and the day are used, the day is the one said), the host-wide gate (`busy`);
5. the render, the store (quota, eviction, atomic write), and the answer `{ ok: true, doc: DocMeta, page: 1 }`. A title is the given one or the file's name without its extension, underscores as spaces, one line, 120 characters,
   `Document` when nothing is left (`cleanDoc` drops a card with no title).

`src/docs/resolve.ts` is the ONE place that turns a model's name into a document: `resolveDocName(name, { titles, uploads })` (a file name exactly, a title exactly, a title that contains the words, a file name that contains them;
several matches are "none" with a hint that lists them, never a guess) over names the HOST listed itself (`DocsApi.list`, `listUploadPdfs`). It strips `/workspace/group/uploads/` and `uploads/` (where the agent sees the files)
and never joins the model's string to a path. The voice side's `show_document` can use it as it is.

`reap()` (at startup and every minute): removes renderer containers older than two minutes that carry the label and the name pattern, run directories older than two minutes that are not in progress, directories left
half made, and, at most every ten minutes, documents nobody opened for 30 days. It never throws.

## The routes (`src/portal/doc-routes.ts`; all `access: 'student'`; registered by `startPortal` when `deps.docs` is given, which also sets `features.viewer: true`)

| route | answer |
|---|---|
| `GET /api/doc/meta?d=<id>` | the `DocMeta` itself (200), 404 `{ error: 'not-found' }` for another student's document exactly as for one that does not exist |
| `GET /api/doc/words?d=<id>&p=<n>` | the `PageWords` itself; `private, max-age=3600` |
| `GET /api/doc/page?d=<id>&p=<n>` | the image bytes, `content-type` sniffed from them, `nosniff`, `private, max-age=3600`, `content-security-policy: default-src 'none'; sandbox` |
| `POST /api/doc/open` | `{ n, index }` (the file `index` of the student's OWN history line `n`: the stored name is found in `History`, never taken from the browser; the line must be the student's, `index` 0 to 9) or `{ doc: id }`; both or neither is 400 |
| `GET /api/doc/job?j=<job>` | while a document is prepared in the background |

`open` answers 200 `{ ok: true, state: 'ready', doc: <id>, page, meta: <DocMeta> }`, or, when the render takes longer than about three seconds, 202 `{ ok: true, state: 'preparing', job }`. The render goes on; the job (in memory,
the student's own, ten minutes) later says `ready` (the same body as above) or the error; **and a document prepared that way leaves a `doc` card in the student's chat and wakes their page**. A document that opens at once
leaves no card. Errors are `{ error, message }`: `off` 503, `busy` 503, `limit` 429, `bad-file` 415, `too-big` 413, `failed` 502, `not-found` 404; a request that does not make sense is 400 `{ error: 'bad-request' }`.
(The contract listed no `failed` and no statuses: these were chosen here.) Malformed ids and pages are 400 before the service is asked anything. The page and words routes have a limit of their own, 600 a minute for a student (the viewer prefetches: four to six requests for each page turn), marked `ownLimit: true` on the
route; every route also counts against the server's shared per-student read limit (240 a minute, which holds the page's poll) UNTIL `src/portal/server.ts` skips that limit for a route that says `ownLimit`: in `PortalRoute` add
`ownLimit?: boolean;` and in `extraRoute` make the line `if (!route.ownLimit && !this.readLimit.allow(user.folder)) return this.json(res, 429, { error: 'rate-limited' });`.

## Wiring (`src/index.ts`, `src/portal/server.ts`: the lead's files)

```ts
import { createDocs } from './docs/index.js';
// after initDatabase(), beside the sandbox:
const docs = process.env.TAI_DOCS === '0' ? undefined : createDocs({ dir: path.join(DATA_DIR, 'docs'), storeDir: STORE_DIR, uploadsDir: (folder) => path.join(GROUPS_DIR, folder, 'uploads'), log: logger });
let docsReaper: ReturnType<typeof setInterval> | undefined;
if (docs) { void docs.reap(); docsReaper = setInterval(() => void docs.reap(), 60_000); docsReaper.unref(); }   // and in shutdown: if (docsReaper) clearInterval(docsReaper);
// startPortal(web, { registeredGroups, registerGroup, docs, createVoice: ... })     the routes, features.viewer and VoiceContext.docs follow from it
// startIpcWatcher({ runSandbox, docs, postObject: (folder, obj) => portal?.postObject(folder, obj), ... })
```

`startIpcWatcher` has no `postObject` yet (the `run` cards need it too); it needs a method on `Portal` (`src/portal/server.ts`, beside `wakeStudent`):
`postObject(folder: string, obj: unknown): void { if (this.opts.history.forFolder(folder).appendObject(obj)) this.wake(folder); }`.

## The text agent's tool

`show_document({ name, page? })` (`container/agent-runner/src/show-document.ts`, registered in `ipc-mcp-stdio.ts`, limit 6 a conversation, refused in a scheduled task) writes the IPC request
`{ type: 'doc_open', requestId, request: { name, page? } }`; the host's verb (`src/docs/ipc-verb.ts`, case `doc_open` of `src/ipc.ts`) resolves the name for the folder of the IPC directory, opens the document, leaves the card
(`IpcDeps.postObject`, which throws when the chat does not take it: the answer then says the document was prepared and the card was not, never "it is in the chat") and writes ONE answer file (`results/<id>.json`, up to 2,000 characters: a list of titles needs more than the task tools' 600). The work is started and not waited for (the watcher is awaited once for
every file of every group); one request at a time for a folder; after 22 seconds the tool is answered "being prepared, a card will appear" and the work goes on; a hard timer lets the folder go after 150 s whatever happens.
The sentence the model reads quotes the title as data and says it cannot see the student's screen. The audit log has the kind of source and how it ended, never a name or a title.

## Operator commands (`deploy/cs6650/tai_live.sh`)

* `doc build [--base IMAGE]`: ships `deploy/cs6650/doc-render/` to `~/tai-live/doc-build` and builds `tai-doc:live` with at most 2 CPUs and 3 GB (5 minutes 35 seconds the first time on this host, whose disk is slow; 253 MB; a change to the
  scripts alone rebuilds in 40 seconds).
* `doc status`: the image, the prepared documents kept (counts and sizes only, never a name), the course library, renderer containers running or left (the service's and the operator's own), run directories left.
* `course-docs add|list|remove|canvas`: the course library (docs/COURSE_DOCS.md).
* `doc smoke [--only TEXT]`: `node dist/docs/smoke.js` from the live tree against the real image (below). Not in class hours, not during a voice call.
* `backup` leaves the prepared documents out.

## Checks

Unit tests (`npx vitest run src/docs src/portal/doc-routes.test.ts container/agent-runner/test/show-document.test.ts`; `src/ipc-docs.test.ts` needs the database and runs on the host): the container's flags flag by flag, the
docker client's own labels and name pattern, the renderer with a fake Docker (staging, the order of removal and reading, refusals, the clocks, the guard, the reaper), the read-back (headers, sizes, links, caps, room), the
store (layout, atomic write, quota, eviction by last open, the 30 days, the library, ids), the service (kinds from bytes, names, links, rates, the gate, dedupe), the name resolver with hostile names, the verb (one answer,
one at a time, the early answer, the hard timer), the routes (whose document, which file, shapes and statuses, jobs), the container tool with the real verb, the entry script under bash with fake poppler tools (the numbering,
the ladder of JPEGs, the clocks) and `render-words.py` on real output of poppler. `deploy/cs6650/test_tai_live.py` covers `doc build|status|smoke` and the backup.

The real thing: `tai_live.sh doc smoke` (`src/docs/smoke.ts`, 20 cases, about 8 minutes) builds a real `createDocs`, makes its own PDFs with a tiny writer (`src/docs/testing/tiny-pdf.ts`) and opens them as a student's attached files:
text at known places (the boxes are checked with `nearestWord` AND against the ink in the page image, decoded by `src/docs/testing/png-decode.ts`: a flipped y axis or swapped axes would put the box where there is no ink), a page turned a
quarter and a crop box, 10 pages, 150 pages (stops at 120), a scan, a photograph (JPEG under the cap), a page 14,400 points square, 5,200 words (4,000 kept), a file named `.pdf` that is text, a zip named `.pdf`, one over 20 MB,
a corrupt file, one cut in the middle, a decompression bomb (a gigabyte of spaces in one page), a page tree that contains itself, the same file twice, small documents three times, two renders at once with a third waiting, and one at a
time for a student; at the end no container, no run directory, no half made document, and a canary beside them untouched. 20 of 20 passed on 2026-11-07, run from a scratch copy of the tree (`host_smoke_case.sh`'s way) and from the live tree's dist by `doc smoke`.

### Measured (the CS6650 host, 2026-11-07; 1 CPU and 1 GB for the render; the host was otherwise quiet in the second run)

| a new document | in all | container start (Docker's StartedAt) | the script | peak memory |
|---|---|---|---|---|
| one page of text | 17.3 s | 8.1 s | 1.7 s | 14 MB |
| ten pages | 9.9 s | 4.1 s | 1.8 s | 15 MB |
| a 150 page file (120 kept) | 18.1 s | 6.0 s | 5.8 s | 19 MB |
| a scan, a photograph (3.8 MB PDF, a JPEG of 265 KB) | 16.6 s, 14.7 s | 7.2 s, 6.6 s | 1.8 s, 1.4 s | 14 MB, 15 MB |
| 5,200 words on a page | 15.4 s | 7.3 s | 1.4 s | 27 MB |
| the bomb (a gigabyte of spaces, a 1 MB file) | 34.2 s | 6.7 s | 13.4 s | 17 MB |
| three small documents in a row | 19.0 s, 22.2 s, 21.5 s | 9.5 s, 7.5 s, 8.4 s | 1.4 s, 3.2 s, 1.7 s | 15 MB |
| a file that is not a PDF, a zip, one over 20 MB | under 50 ms | none starts | | |
| the same file again, or a kept document | under 50 ms | none starts | | |

With other jobs on the host (the first run of the smoke) the container start was 10 to 18 s and a one page document took 23 to 41 s. Docker's own costs here, measured apart from the renderer: `docker run` of `true` 7.5 to 13.4 s, `docker inspect`
0.9 to 1.8 s, `docker rm -f` 0.9 to 2.5 s. So a new document costs about 15 to 25 s whatever its size (up to 120 pages adds 5 to 10 s of script): the script is 1 to 2 s, the container's start 6 to 12 s, and the three Docker calls after it 3 to 7 s.
**What the voice side may promise: a document that has to be prepared is never ready in 8 seconds on this host, so "preparing" is the normal answer for a new one; one that is kept, or the same file again, opens at once.**
The synchronous parts of the host (reading back 120 pages of 420 KB, writing them, removing the run directory) took 39 ms, 20 ms and 6 ms with a worst event-loop lag of 60 ms: nothing to move off the event loop.

The gate: with two renders going the third used to be told `busy` when its 15 seconds ended (a render takes 15 to 30 s on this host). The lead made `DOC_GATE.waitMs` 30 seconds: the route and the tool have answered "preparing" long before, and the verb's own timer (150 s) still covers 30 + 90 + 25.
the verb's hard timer (150 s) still covers 30 + 90 + 25.

## Threat model (the file is untrusted: a student, a mistake, or a document a model was talked into opening)

| threat | what stops it |
|---|---|
| a PDF that attacks the parser (poppler is a large C++ program) | it runs only in the disposable container: no network, no capabilities, read-only root, the host's unprivileged user, no secrets (a fixed environment), nothing of the host mounted but the source (read-only) and an output directory; a kernel bug could still break out: the same residual risk as the Go sandbox (docs/GO_SANDBOX.md), gVisor is the answer if the owner wants one |
| memory, CPU, time, disk | 1 GB with the same swap, one CPU, 64 processes, `fsize` 64 MB, a memory-backed /tmp of 64 MB, the script's own `timeout`s, the host's kill at 90 s and a guard 25 s later; the output directory is a host directory, so a compromised renderer could write there for up to 90 s (a file at most 64 MB each): it is on the host's disk, removed at once, and nothing else is in it |
| what comes back is hostile | only three kinds of name are opened, as regular files with no link followed, within size caps; images checked by their headers (type, size); words through `validateWords`; the host writes its own files; the model is told titles as quoted data |
| a name or path from a model or a browser | the browser sends a message number and a file index and the host finds the stored name in the student's own history; a model's name is only compared with names the host listed; an upload name must be one segment of the upload store's alphabet, read with the group folder as the root |
| another student's document | the folder is the session's (routes) or the IPC directory's (verb), never the request's; a document of another student is "not found" like one that does not exist; ids are 128 random bits |
| a flood | 6 renders in ten minutes and 20 a day for a student, one at a time for a student, 2 at once on the host with a short queue, the store's quota (8 documents, 60 MB) and 30 days |
| leaving things behind | containers named `tai-doc-<12 hex>` with a label, removed by the runner in a `finally`, by the reaper every minute (older than two minutes, never one in progress); run directories likewise; half made documents after ten minutes |
| a card that lies | the card is made by the host from the document it prepared (`cleanDoc`), never from what a model said |

## Not in this version

A password for a protected PDF or Office file, OCR of a scan (a scan has an image and no words), text search across a student's own documents (the course library has one: docs/COURSE_DOCS.md), pages beyond 120, a document of
more than 60 MB of images for one student, a student's own Canvas submissions (the course's Canvas files are opened by name: docs/COURSE_DOCS.md, "Canvas files"). Office files, the course library and its search are batch C1 (docs/COURSE_DOCS.md).
