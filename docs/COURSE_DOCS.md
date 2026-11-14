# Office files, the course library and finding a slide (batch C1 of docs/CHAT_OBJECTS.md, 2026-11-07)

Three things on top of the document viewer (docs/DOCUMENTS.md): a student can open a PowerPoint, Word or Excel file the way they open a PDF; the professor's own decks live in a **course library** that every student can open;
and TAi can **find a slide by what it says** and put it in front of the student. This file is how they work, what the operator does, what was measured on the CS6650 host, and what is not built.

## What it is, what it is not

* A PPTX, DOCX or XLSX becomes a PDF inside the renderer container (LibreOffice, headless) and then goes through the same steps as a PDF: one image of each page and the words of each page. What the host keeps, serves and
  describes is the same for a PDF and for an Office file.
* The course library is a directory of the same kind of prepared documents (`<store>/course-docs/<id>/`) plus an index. The operator fills it; students can only read it. It is **course material the student may already open in
  Canvas**: nothing in it is a solution to a graded assignment unless the operator put it there, and nothing here looks at what a deck says (the operator command's help says so).
* The search finds a page by the words on it (and a deck by its title) and answers with a stretch of the page's OWN words. It does not read a slide for the model, describe a picture, or understand a diagram.
* The host never parses an Office file or a zip: the orchestrator stages the bytes under a neutral name, and the container reads the zip's entry names (never an entry's content), decides, converts and renders.

## Office files in the renderer

`deploy/cs6650/doc-render/` (the image `tai-doc:live`, built by `tai_live.sh doc build`; 941 MB, up from 253 MB; **11 min 45 s at 2 CPUs the first time** on this host, and a change to the scripts alone rebuilds in under a minute).

| piece | what it does |
|---|---|
| `Dockerfile` | adds `libreoffice-writer libreoffice-impress libreoffice-calc` (`--no-install-recommends`: no Java, no desktop integration; Debian 13, LibreOffice 25.2) and the fonts that make slides readable: `fonts-liberation`, `fonts-dejavu-core`, `fonts-noto-core` (42 MB), and `fonts-crosextra-carlito` and `fonts-crosextra-caladea`, which take the places of Calibri and Cambria (the Office defaults) with the same metrics, so that a slide's lines break where its author's did |
| `doc-render office <maxPages> <maxPx>` | the same entry point as `pdf`, on `/in/source.bin`. Steps: `office-kind.py` decides what the file is; `soffice` converts it; the PDF it makes goes through the unchanged PDF steps, so `/out` is the same (`p001.png`, `w001.json`, `meta.json`). It prints one more line, `doc-conv <ms>` (the conversion's time), before `doc-mem` |
| `office-kind.py` | python3 `zipfile`, **names only**: the end-of-central-directory record is read first (3,000 entries or more, or a directory far larger than that many entries need, is refused before the `zipfile` module reads it), then the names and the sizes the entries *declare*. It says `pptx` (has `ppt/presentation.xml`), `docx` (`word/document.xml`) or `xlsx` (`xl/workbook.xml`), and refuses with an exit code that `doc-render` turns into one fixed sentence (table below). Nothing is extracted or written; the content of an entry is never read |
| the conversion | `soffice --headless --norestore --nolockcheck --nodefault --nofirststartwizard --nologo -env:UserInstallation=file:///tmp/office.XXXXXX/profile --convert-to pdf:<filter>:<options>`, under `timeout -s KILL` (95 s at most, and what is left of the budget). The file gets the extension its parts say it has, as a link to the staged file (nothing is copied). Filters: `impress_pdf_Export`, `writer_pdf_Export`, `calc_pdf_Export`; images are reduced to 150 dpi (a 1,100 px page image cannot show more); a workbook is limited to `PageRange 1-<maxPages>` (a sheet can be thousands of pages; a deck or a document is not limited, so that `pagesInFile` is true) |
| macros | never run, in two ways: the private profile the conversion runs with is written by the script with `MacroSecurityLevel` 3 (very high) and `DisableMacrosExecution` true (checked on the host: LibreOffice keeps both keys when it rewrites the profile), and links are not updated on opening; and a package that has a VBA project (`vbaProject.bin`) or an Excel 4 macro sheet is refused before LibreOffice starts. (Not exercised with a real self-running macro: the refusal comes first.) |
| budget | the script holds an Office file to 130 s in all (a PDF to 70 s); the host kills the container at 150 s (a PDF's: 90 s). `DOC_BUDGET`, `DOC_CONVERT_SECONDS` and the tool names are test seams that nothing sets in a container |

What the container prints when it refuses (`doc: <reason>`, exit 2; the host believes only these lines and says its own sentence for each, `src/docs/render.ts REFUSALS`):

| line | when | host's reason |
|---|---|---|
| `the file is not a PowerPoint, Word or Excel file.` | a zip with no `[Content_Types].xml`, with the parts of none of the three kinds (an OpenDocument file, an archive), or of two kinds | `bad-file` |
| `the file could not be read as an Office file.` | no bytes, not a zip, a file cut off, a package whose main part is missing | `bad-file` |
| `the file has too many parts or is too big when unpacked.` | 3,000 entries or more; an entry that declares more than 200 MB, or all together more than 400 MB | `bad-file` |
| `the file contains macros.` | a VBA project or a macro sheet | `bad-file` |
| `the file is protected with a password.` | an entry marked encrypted (also the PDF line) | `bad-file` |
| `the file could not be converted.` | LibreOffice failed or made no PDF, or poppler could not read what it made | `bad-file` |
| `converting the file took too long.` | the conversion hit its clock | `failed` |
| `there is nowhere to convert the file.` | no room for the profile | `failed` |

A password-protected `.docx` or `.pptx` is not a zip (it is the old container), so it, an older `.ppt`/`.doc`/`.xls` and any other file are refused by the HOST from the first bytes, with sentences of their own (`DOCS_OLD_OFFICE`, `DOCS_NOT_A_PDF`): no container starts.

### The container's flags

The same as a PDF's (docs/DOCUMENTS.md: `--network none`, `--cap-drop ALL`, `no-new-privileges`, read-only root, 64 processes, one CPU, the ulimits, 64 MB of memory-backed `/tmp`, the host's own user, the source read-only,
a fixed environment) with **two** differences: `--memory 1536m` (and the same as swap: none) and a wall clock of 150 s (`OFFICE_RENDER_LIMITS` in `src/docs/render.ts`; tested flag by flag: the Office spec equals the PDF spec once the memory and the kind are swapped).
What the measurements allowed (below): LibreOffice used at most **18 threads** and the `/tmp` held **3.6 MB** at its fullest (the profile is 0.3 MB; the PDF of forty photographs, 3 MB), so the process limit and the size of `/tmp` did not need raising.
The operator's own renders (`course-docs add`) are labelled `tai-doc-operator` and run in `data/docs-operator/`: the running service's reaper lists only `tai-doc` containers and `data/docs/` directories, so it never takes a long conversion of the operator's for a leftover.

### What the host does (`src/docs/docs.ts`, `render.ts`)

`kindOfBytes` says `office` for a zip's first bytes (`PK\3\4`) and `render(bytes, { kind })` stages it as `source.bin`; `docs.open` otherwise works as before: the same file is the same document, the same quotas (an Office render is a render), the same gate.
`resolve.ts` lists a student's uploads that end `.pdf`, `.pptx`, `.docx` or `.xlsx` (`listUploadDocuments`), and the hint says "Files they attached". `DOC_HARD_MS` of the text agent's verb is 210 s (30 s of queue, 150 s of clock, 25 s of guard).
On the page the Open button of a file chip appears for those four endings (`isOpenable` in `portal/web/viewer.js`; the page's job poll gives up after 190 s, which covers an Office render's 30 s of queue and 150 s of clock; if it still gives up, the card arrives by itself when the render is ready).
`show_document`'s descriptions (the MCP tool and the voice function) say that a PDF, a presentation or a document can be opened.

## The course library

```
<store>/course-docs/index.json      { v: 1, entries: [ { id, title, week, sourceName, sha256, pages, pagesInFile?, bytes, createdAt } ] }, written through a temporary file and a rename
<store>/course-docs/<id>/           meta.json, pNNN.png|jpg, wNNN.json, source.json: the layout of a student's document, origin `course`
<store>/course-docs/.lock/          held by the operator's command while it changes the index (taken over after five minutes)
```

* **Limits** (`LIBRARY_LIMITS`): 100 entries, 1.5 GB, at most 120 pages a deck (a deck is cut like any document), weeks 1 to 30. Titles are unique (letters and digits only, any case): `show_document` names a deck by its title, so two decks cannot share one.
  The same source file (its SHA-256) is not added twice, whatever it is called.
* **Readers.** Every reader of the store looks in the student's own directory first and the library's second (`DocStore.locate`): `meta`, `words`, `text`, `pageFile`, the routes (`GET api/doc/meta|page|words`, `POST api/doc/open { doc }`),
  `describeView`'s resolver, `point_at` and `show_document` find a library entry for any student; a student's own `list()` never holds one; it is never counted against them, touched or swept. `DocsApi.library()` lists the entries by week (none last), then title.
  It reads `index.json` only when the file changed (inode, size and modification time) and hands out the SAME array until then. A row whose directory or meta is missing, damaged or a link is left out; a row that does not pass its checks
  (id, title, week, hash, pages, numbers) is dropped; the index is read through `readBytesSafe` (no link followed) and is at most 256 KB.
* **Naming.** `show_document` (voice) and `doc_open` (text agent) resolve over `nameableDocs(docs, folder)`: the student's own prepared documents, then the library's, then (by file name) what they attached. `resolveDocName`'s rule is the same for
  all: a file name exactly, a title exactly, a title that contains the words, a file name that contains them; when two fit the same way it does not guess, its sentence lists them and the model asks.
* **A student's room is not touched**: opening a library entry is free (no render, no count), exactly like opening a document that is kept.

## Finding a slide by what it says

`src/docs/library-search.ts`: `buildIndex` and `searchLibrary` are pure; `LibrarySearcher` keeps the index in memory (built from the library's words files, a few thousand pages at most) and builds it again when `library()` hands out another array,
that is, when the operator changed the library, with no restart. `DocsApi.searchLibrary(query)` is what everything else calls.

* **How a query is read.** Case, accents and punctuation do not matter (letters and digits only; a soft hyphen is no break). Words that say nothing about a topic are dropped (`the`, `how`, `slides`, `lecture` ...), the rest are compared as
  stems (a plural, -ing, -ed, -ion and a final e come off both sides: `replicate`, `replicated` and `replication` meet), at most eight.
* **How a hit is scored.** A deck whose **title** has a word of the query ranks above every deck that has the words only in its pages (a title-only match gives the deck's first page, with the start of that page as its snippet). Among pages,
  rarer words count more, the words in a row count more, and a page needs at least half of the query's words to be a hit (one word of a five word query is no hit). At most 5 hits, at most 3 from one deck; ties go to the earlier week, then the title, then the page.
* **The snippet** is a stretch of the page's own words, whitespace made single, starting a little before the first word that matched and at most 160 characters with "..." where it was cut, never in the middle of a word (a test checks, over random pages, that
  every word of every snippet is a word of the page, in its order). A page with no text has no snippet. Nothing is paraphrased.
* **Speed.** A library of the largest size (100 decks of 120 pages, 12,000 pages) builds in about 0.2 s and a search takes milliseconds (a test pins a generous bound).

### What the model is given

One composer for both channels (`src/docs/library-answer.ts`; a call's search says "Add its page only when they named a subject in their request ... when all they asked for was the slides, leave the page out and offer the listed page" instead of "and the page": `OPEN_IT_VOICE`, docs/VIEWER_VOICE.md section 10): a sentence from the host (`Found 3 slides in the course decks. To put one on their screen call show_document with the title exactly as listed and the page. Say only what the quoted
words show of a slide ...`), and ONE block of the hits (`1. "Week 5 - Raft" (week 5), page 7 of 32: "<snippet>"`) between `<<<SLIDES <12 hex>` and `SLIDES <12 hex>>>`, called data. The marker is random for each answer and is taken out of the text, a snippet is quoted on one line.
No hits, or an empty library, have sentences of their own and list nothing ("never say a slide says something that it was not shown to say").

* **Voice**: `find_course_document({ query })`, a host function in the conversation only (`src/voice/library-fn.ts`; the interview and the talk-through have none), 12 searches a call, no tool host, no container. Its description is 375 characters.
  **Growth of what rides every turn**: the function's JSON is 597 characters; the conversation's function list went from 24,854 to 25,476 characters (23 functions to 24: +598 for the function and +24 for `show_document`'s description, which now says a presentation or a document can be opened); the conversational prompt grew by one rule, `5c. COURSE SLIDES`, 300 characters
  (12,508 to 12,808). The sections whose sizes tests pin (the viewer's 560, the cards' 850) are untouched.
  **2026-11-07, the page they have open first** (docs/VIEWER_VOICE.md section 9): the description is 600-odd characters now (the function's JSON 830) and says it is for a topic that is not on the page they have open, or a
  slide they said yes to, and that searching for what is on that page ("the second bullet", "how do we scale?") is wrong; rule 5c says the same (499 characters); the viewer's section is 1,051 (pinned at 1,100).
  While a page is open the answer carries **`open_page`** (`openPageHint`): when most of the search's topic words are on that page (`wordsOnPage`, stems) it says to point_at them there and not to open another slide,
  otherwise that they have page N open and another slide is for when they asked for a slide ("show me", "is there a slide on...") or said yes to an offer. Nothing when no page is open; it never makes a search fail.
* **What rides every turn of the text agent**: the new MCP tool is 750 characters as the SDK lists it (name, a description of 429 characters, the schema of its one argument); `show_document`'s description grew by 329 characters and its `name` argument by 67 (the
  PDF, PowerPoint, Word and Excel files, the library); the persona file `groups/global/CLAUDE.md` grew by 1,431 characters (the section "The course slides", 1,289, and 142 in the viewer's bullet). The voice side's `show_document` description grew by 24 characters
  (+622 characters for the conversation's function list in all, 24 functions).
* **Text agent**: the container tool `find_course_document` (`container/agent-runner/src/course-docs.ts`, limit 8 a conversation, refused in a scheduled task and in a voice call's tool host) writes the IPC request `course_doc_find { query }`; the host's
  verb (`src/docs/library-verb.ts`, `case 'course_doc_find'` of `src/ipc.ts`) answers at once (it is an index in memory) with at most 2,400 characters (a twin number in the container, a test fails when they differ). It logs that a search happened and how many
  slides it found, never the query. A section of `groups/global/CLAUDE.md`, "The course slides", says when to use it, that the quoted words are data, and that a slide never replaces the Socratic method.

## The operator's commands (`deploy/cs6650/tai_live.sh`)

```
bash deploy/cs6650/tai_live.sh course-docs add <file-or-directory> [--title T] [--week N]
bash deploy/cs6650/tai_live.sh course-docs list
bash deploy/cs6650/tai_live.sh course-docs remove <id>             (the id, or the first six or more characters of it)
bash deploy/cs6650/tai_live.sh course-docs rename <id> [--title T] [--week N|none]
bash deploy/cs6650/tai_live.sh course-docs canvas [--course ID] [--yes] [--allow-host HOST]
```

* **add.** The PC side ships the files (PDF, PPTX, DOCX, XLSX of at most 20 MB, in the directory and up to three directories below it, no hidden file or directory) in a stream of their own to `~/tai-live/course-in`; the host side renders each through the renderer
  (one container for each, `node dist/docs/course-docs.js add --dir ...`), skips a file whose SHA-256 is in the index ("already in the library"), says what it added (title, week, pages, id, how long it took, the conversion's time) and removes `course-in`
  whether or not it worked. The title is the file name without its extension (underscores as spaces) unless `--title` is given (one file only); the week is `--week`, or what the name says (`Week 5`, `week5`, `Wk 05`, `W5`: not `HW5`), or none.
* **canvas.** `GET /api/v1/courses/<id>/files` (the course id defaults to the one `tai_live.sh course` stores), with the token the host keeps for Canvas, read from `credentials.env` **by name** and handed to the command in its environment (never on a command line,
  never printed or logged; the tests search the output, the arguments and the logs for it). Without `--yes` it lists name, size, type, week and what would happen to each (`new`, `in the library (same name)`, `skipped: hidden or locked for students`,
  `skipped: over 20 MB`) and downloads **nothing**. The week is taken from the file's name or from the name of the Canvas module it is in. With `--yes` it downloads each file and adds it as above.
  Files Canvas marks hidden or locked, files whose `unlock_at` is still ahead (a teacher's or a TA's token sees the solutions of an assignment before its deadline) and files whose `lock_at` has passed are listed with the reason and not taken: a library entry
  is shown to every student, so what a student could not open in Canvas is not added. When Canvas refuses the listing (HTTP 401 or 403) the account is asked who it is first (`/users/self`): a token Canvas does not know is "refused the token"; a token it
  knows with a role that may not list the course's files (a hidden Files tab) gets the files of the course's modules instead (each `File` item, fetched by its id), and says so.
* **The token goes to Canvas' own host and nowhere else** (the rule of `src/sandbox/fetch.ts`, adapted to a file that Canvas keeps somewhere else; `src/docs/canvas-files.ts`). Every listing request goes to the API's host (https, a host name, no port or user name) and the next page of a
  listing is followed only on that host. A file's own address must be on the same host; the request for it is the ONLY one that carries the token. Redirects are never followed by `fetch` (`manual`); a place Canvas sends the download to is asked for with
  **no credentials at all**, and only if it is https on the default port with no user name and a host that is Canvas' own (the API's, one of the hosts of the listing's addresses, or `*.instructure.com`, `*.inscloudgate.net`, `*.canvas-user-content.com`,
  `*.instructuremedia.com`) or one the operator named with `--allow-host` (the refusal names the host so that the operator can decide). At most three hops; a file must be at most 20 MB, by what Canvas says and by what it sends, and begin as a PDF or a zip.
  What is printed holds no address (each has a one-time key in it), only names, sizes, types and host names.
* **list / remove.** `list` prints the short id, week, pages, title and source name and a total; `remove` takes the row out of the index first and then the directory, and never removes a directory that is not a row (a student's document, anything put there by hand).
* **rename.** `rename <id> [--title T] [--week N|none]` changes what a deck is called and which week it is in, by the id or the first six or more characters of it (at least one of the two). The title is what students and TAi call a deck by (`show_document` names a deck by its title),
  so it must not be another deck's (letters and digits only, any case: the rule of `add`); it is written to the deck's own `meta.json` and to its row of the index, under the same lock as the other changes, and the meta is put back if the index cannot be written. The week is a number from
  1 to 30 or `none`. Nothing else of the deck changes, a card that is already in a student's chat keeps the title it had, and it starts no container. `canvas --yes` names a deck after the file (underscores as spaces) and takes the week from the name or the Canvas module: `rename` is how to give it the name you want.
* `doc status` counts the library by its decks (32-hex directories) and the operator's own containers.

## What was measured (the CS6650 host, 2026-11-07, 1 CPU and 1.5 GB for each render, the host otherwise quiet)

Real files made inside the agent image (`src/docs/testing/make_office_samples.py`: python-pptx, python-docx, openpyxl) and rendered through the real image by `src/docs/smoke.ts`.

| a new document | in all | container start (Docker's StartedAt) | the script | of which LibreOffice | peak memory |
|---|---|---|---|---|---|
| 12 slide deck (title, bullets, a table, shapes with words, a picture) | 11.5 to 16.7 s | 5.3 to 6.7 s | 3.3 to 5.0 s | 1.2 s | 158 MB |
| 6 page document (headings, a table) | 9.7 to 18.1 s | 3.6 to 7.0 s | 2.7 to 4.7 s | 1.0 s | 158 MB |
| workbook, 2 sheets | 9.2 to 15.1 s | 5.2 to 5.8 s | 1.6 to 2.7 s | 0.9 s | 158 MB |
| heavy deck: 40 slides that are photographs, 11.7 MB | 20.4 to 24.7 s | 6.3 to 9.3 s | 8.2 to 9.9 s | 1.6 s | 159 MB |
| a document of 150 pages (120 kept) | 16.3 to 18.7 s | 5.2 to 7.0 s | 6.8 to 8.3 s | 1.1 s | 159 MB |
| refused by the container (an archive, a deck cut in half, macros, 3,500 parts, a gigabyte declared, one marked encrypted) | 10 to 19 s | 3 to 9 s | 1 to 2 s | none | 13 MB |
| not a deck inside (LibreOffice refuses it) | 12.6 to 15.6 s | 7.1 s | 2.9 s | 0.9 s | 166 MB |
| empty file, older Office file, a kept document, a library deck, the same file again | under 50 ms | none starts | | | |
| `course-docs add` of the 12 slide deck through the operator's own renderer (the whole render and keep) | 9.8 to 18.3 s | | | 1.2 s | |
| `course-docs add` from the PC of three files (a deck, a document, a workbook), shipped and rendered one after the other | 43.6 s in all (13.5, 13.5 and 14.2 s each) | | | 1.0 to 1.2 s | |

* **LibreOffice is not the cost**: a cold profile in a fresh container converted a deck in about a second. What a new document costs is Docker's start of a container (3.6 to 9 s here) plus the pages (poppler: 2 to 10 s) plus the three Docker calls after the run. **What the voice may promise: an Office file that has to be
  prepared is never ready in 8 seconds on this host, so "preparing" is the normal answer for a new one (as for a PDF); expect it in 10 to 25 s, and a kept document, a library deck or the same file again opens at once.**
* The heavy deck (a photograph on each of forty slides) came out as forty JPEGs of at most 192 KB (the PNGs were over the cap), 7 MB kept; the 150 page document stopped at page 120 with `pagesInFile` 150.
* Peak threads of the container 11 to 18, `/tmp` at its fullest 3.6 MB (a profile is 296 KB), memory 158 to 166 MB (the cgroup's peak counts the mapped libraries): the 1.5 GB is a ceiling for a big deck, not what a normal one uses.
* **How the words come out.** The boxes agree with the pictures: on a 4:3 slide the title is in the top fifth, a table's cells are on one row in order, the words of three shapes are in the order the shapes are in, and the picture slide's only words are its title with the picture's ink where the picture is. A spreadsheet clips a cell's text at its
  neighbour (`Observatio|Detail`): what is not on the page is not in the words.
* The image build took 11 min 45 s at 2 CPUs and 3 GB; the live service was not touched. The previous image is kept as `tai-doc:pre-office` (`docker tag tai-doc:pre-office tai-doc:live` is the way back; it reads PDFs as before).

## Checks

Unit tests (`npx vitest run src/docs src/voice container portal/web src/portal/doc-routes.test.ts`; the tests that need the database run on the host): `src/docs/scripts.test.ts` (the entry script under bash with a fake `soffice`: the filters, the macro profile in the call, the refusals, the clocks, nothing left behind),
`deploy/cs6650/doc-render/test_office_kind.py` (real zips: the kinds, every refusal, the limits), `render.test.ts` (flags and limits by kind, staging, refusals, the operator's label), `docs.test.ts` (Office through the service, the library through the service), `library-search.test.ts`, `library-store.test.ts`
(index, cache, lock, hostile rows and links), `library.test.ts`, `canvas-files.test.ts` (the redirect rule, the token, pagination, limits), `course-docs-cli.test.ts`, `library-verb.test.ts`, `src/voice/library-fn.test.ts`, `container/agent-runner/test/course-docs.test.ts`,
`viewer.test.js`, and `deploy/cs6650/test_tai_live.py` (the PC side shipping the files through a stand-in ssh, the host side, the token in the environment only). The real thing: `tai_live.sh doc smoke` (`src/docs/smoke.ts`: the 20 PDF cases and the Office and library cases above, which make their
samples in the agent image; without that image they are SKIPPED in words and not counted as passed).

Results on 2026-11-07: `npx vitest run src/docs src/voice container portal/web src/portal/doc-routes.test.ts` on the PC, 121 files, 2,565 tests passed (10 skipped, as before); the whole suite on the host (`host_vitest.sh`), 4,514 passed and the one old upstream failure
(skills-engine customize), which is not ours (the baseline was 4,343 passed); `tsc --noEmit` clean on the host and for the container; `test_tai_live.py` 65 tests (12 of them the course-docs commands), `test_office_kind.py` 12, `test_render_words.py` 11;
the real smoke, run three times from a scratch copy of the tree against the real image (the last time after every change): **28 of 28 passed** each time (the 19 PDF cases of before, the 8 Office and library cases, and "nothing is left": no container of the service's or the operator's, no run directory, no half made document).
The operator commands were also run for real from this PC against a scratch tree and store on the host (the real script, the real command, the real image and the real Canvas token, nothing live): `course-docs add` of a directory of three decks and a text file and a hidden file
(the three were added, the others skipped, weeks 5 and 6 from the names), `add` of the same file again ("already"), `list`, `remove` by the start of an id, and `canvas` without `--yes` (a listing of the course: no download).

## Deploying it (the lead's steps)

1. The image is built already: `bash deploy/cs6650/tai_live.sh doc build` was run on the host on 2026-11-07 (about 12 minutes, the service untouched) and `tai-doc:live` is the new one (the running service reads PDFs through it as before); the previous one is `tai-doc:pre-office`.
   Run `doc build` again only after a change to `deploy/cs6650/doc-render/` (not in class hours).
2. Wiring: nothing new in `src/index.ts` beyond what `createDocs` already needs (`createDocs(...)` now also answers `library()` and `searchLibrary()`, and `startIpcWatcher({ docs })` already gives the new verb the service); the new IPC verb is in `src/ipc.ts`.
   Optional, one line after `createDocs(...)`: `void docs.searchLibrary('warm up');` builds the search index (it reads the words files of every library page once: a fraction of a second for a few hundred pages) at startup instead of during the first student's turn.
3. A deploy that has `dist/docs/course-docs.js`, then `tai_live.sh course-docs add <directory of decks>` or `course-docs canvas` (a listing, then `--yes`), and `doc smoke` for the real checks. The agent image must be rebuilt (the container tool): a deploy does it when `container/` changed.

## Canvas files in the viewer (2026-11-07, the owner's go-ahead after batch C1)

A student can ask for a file of the course's Canvas that is not in the library ("open the homework 5 spec", "show me the Day 4 slides"), in the chat and in a call. `show_document` (the text agent's tool and the voice function) looks for the name among the student's own
documents, the library's decks and the files they attached FIRST; only when nothing matches at all (not when several do: then the model is told which and asks) it looks at the course's Canvas files (`chooseDoc` in `src/docs/resolve.ts`; a Canvas file that is one of the library's decks is
that deck, by its bytes: no second render).

* **The host does it, a container never does.** `src/docs/canvas-source.ts` lists the course's files and downloads the one asked for, with the operator's token from the host's `.env` (read at each use, never in a container, never logged, to Canvas' own host only: the rules of
  `src/docs/canvas-files.ts`, which `course-docs canvas` uses too). A model gives only a NAME: the host compares it with its own listing, and the id, the address and the bytes are the host's. (The first plan, a container tool that saves the file into `uploads/`, would have put the token in a container.)
* **What a student can be offered** is what they could open in Canvas themselves: PDF, PowerPoint, Word and Excel files that Canvas does not hide or lock, that are released and not withdrawn (`unlock_at`, `lock_at`), at most 20 MB. The listing is the same for every student and is kept for ten minutes
  (a failure for thirty seconds); a changed address or course is a new listing.
* **What happens.** The file is downloaded and prepared like any other: the student's OWN document with the origin `canvas` (its card says "from Canvas"), under their quota (8 documents, 60 MB) and their render limits (6 in ten minutes, 20 a day). A student also has a limit of their own for downloads from Canvas, the same
  numbers (only a download that happened counts: a failed one does not, and a file they opened already opens again at once, with no download and no render). Several things can say no, each in words for the model: Canvas did not answer, the file is not there any more, too many fetched, one render going already.
* **Names.** The order is a file name exactly, a title exactly, a title that contains the words, a file name that contains them (the student's own and the library's first), then a Canvas file exactly (the newest of two with the same name), then one that contains the words (several: ask). A hint for a
  name that matches nothing lists a few Canvas names. Listing and download are asked for only when the name is a miss, so a student who names their own document costs no request.
* **Logs** say that a Canvas file was opened and how it ended (counts and reasons), never a name or a title; what went wrong at Canvas is in the host's log for the operator, never in what a model is told (it hears "Canvas did not answer just now").
* **Off:** `TAI_CANVAS_DOCS=0` (orchestrator environment, restart): the Canvas methods of the documents service are not there and a name that is not the student's own is simply not found, as before.
* **Not covered:** a file only a student's submission has, files that are not PDF or Office files, and a file in a Canvas folder that is hidden while the file itself is not flagged (the same limit as `course-docs canvas`, and now the container's Canvas tool's: Canvas says it of a file, not of its folder).
* **The container's own Canvas tool: `files` and `file_content` follow the same rules now (2026-11-07), and no other action can be made to ask for a file's metadata any more; the other actions apply the student's rule too, but that part is the next bullet and was deployed 2026-11-08.** `canvas_query` `files` and `file_content` (`container/scripts/canvas_api.py`) used to read a course file with the instructor's token WITHOUT them, so a student's TAi could read the TEXT of a file Canvas hides from students; and other actions could reach a hidden file's metadata and its download address because a model's id with a `..` or a `?` in it changed which Canvas endpoint they asked. A model's id or page slug is now checked before it goes into a request path (digits, or a plain slug; anything else is refused in one sentence and nothing is asked: `docs/SECURITY.md`), and `api_get` checks the finished path again. **Not closed yet in the DEPLOYED image:** the other actions answer there with what the instructor's token sees (`modules` names a hidden file's item, pages and assignments that are not published are listed); the student's rule for them is the next bullet (built, deployed 2026-11-08). This part (the files rule and the path check): built and tested 2026-11-07, DEPLOYED 2026-11-08 03:35 UTC (the agent image carries the script; checked against the real Canvas afterwards).
  Outside the admin chat (`NANOCLAW_IS_MAIN` is not exactly `1`: a student's chat, a task, a voice call's tool host, and a call with no such variable, the course-status container among them) `files` leaves out a file that is hidden, locked, not released or withdrawn (no name, no count), and
  `file_content` refuses it in one sentence and reads nothing more of it. The rule is written twice (`whySkipped` here, `why_not_for_students` there) and both were run on the same table, `container/scripts/canvas_file_visibility_cases.json`; the viewer's own limits (20 MB, PDF and Office files) are not copied. Who is held to
  it, the tests, the path check, and what stays open next to it (the student's rule for the other actions, built and deployed 2026-11-08, and what it does not cover): `docs/SECURITY.md`, "Opening documents, the view and the course library".
* **The container's other Canvas actions apply the student's rule too (2026-11-07, built and tested, DEPLOYED 2026-11-08; the real Canvas was asked nothing).** Outside the admin chat (`NANOCLAW_IS_MAIN` not exactly `1`, as above) `assignments`, `upcoming`, `my_grades`, `week_status`, `pages`, `discussions`, `announcements` and `modules` leave out what a student could not see in Canvas, with no name and no count (not published; an announcement or discussion whose posting is delayed or that is for some sections only; an assignment for some students only; a module that is unpublished or locked by a date; a module item that is not published or is a file a student could not open, by the rule of `files`, from one listing of the course's files), and `assignment_detail`, `page_detail`, `discussion_detail`, `discussion_entries` and `module_items` answer one sentence for such a thing asked by id (the same sentence when Canvas does not know the id). An assignment that has not opened yet stays in the lists and its words are withheld, by the owner's decision of 2026-11-08 (a student's TAi sees neither an unpublished assignment nor the description of a published one before its unlock date): `assignment_detail` gives its facts and a note, never an error, and `week_status` no requirements, so that the weekly brief and `start_mock_interview` go on quietly without the spec. **Still open, first:** content that sits in a module Canvas locks for a student (a date, prerequisites) is still served, because its own flags say nothing; grades that are not posted yet; the sections and overrides a student is in. All of it, the tests, and what was not tried: `docs/SECURITY.md`, "Opening documents, the view and the course library".
* **Checked against the real Canvas, from a scratch copy of the tree on the host, before any deploy (2026-11-07):** the course listed in 0.9 s (15 files a student may open, all PDF; the four that Canvas hides or locks were not among them), the second listing cached, a name resolved to a Canvas file, a name that matches nothing
  listed what there is, the smallest file (53 KB) downloaded with the operator's token and prepared by the real renderer in 18.7 s (6 pages, a picture and words for the first, the origin `canvas`), the same file again at once with no download and no render, an id the listing does not have not found,
  nothing left behind (no container, the scratch store removed). The live store, the live service and every student's chat were not touched. Deployed 2026-11-07 17:45 UTC, and the same probe was run again against the DEPLOYED build (15 files in 0.7 s, the smallest file prepared in 18.2 s, every check ok). Not checked: a real student's chat or call that names a Canvas file.
* Tests: `src/docs/canvas-source.test.ts` (what is offered, the cache, a failure, the token), `resolve-canvas.test.ts` (the order, the hints, the two steps), `docs-canvas.test.ts` (the download, the same file again, the library's deck, the limits, one at a time, the log), `ipc-verb-canvas.test.ts` (the text agent), `src/voice/screen-canvas.test.ts` (the call); the container's tool: `container/scripts/test_canvas_api_student_files.py` (the student's rule for files), `test_canvas_api_paths.py` (a model's ids and slugs never change a request's path) and `test_canvas_api_student_view.py` (the student's rule for the other actions).

## Not built

* Per-page descriptions of a page's pictures with a vision model (a slide that is a diagram has its title and labels as words, and nothing about the drawing), speaker notes, hidden slides, animations, embedded video, comments and tracked changes beyond what LibreOffice draws by default, a sheet as one page.
* Older `.doc`, `.ppt` and `.xls` files, and password-protected files (they are refused in words with a way out: save as `.pptx`, `.docx` or `.xlsx` without a password, or export a PDF).
* Fonts beyond the ones installed (a deck that uses a font LibreOffice has no stand-in for is drawn in the nearest one).
* A page of a library deck cannot be marked "not for students until ..." (a deck is shown to every student from the moment it is added; the operator removes it with `course-docs remove`).
* Searching the pictures, and searching a student's own documents (only the library is searched).
* A student's own Canvas files (their submissions): only the course's files are opened (above), and not by saving them into `uploads/` (the contract's first plan: a container would have needed the token).
* A backup of the library: `tai_live.sh backup` leaves `store/course-docs` out (it is big and its images are made from files), and a deck's source file is not kept. After a restore, or on a new host, the library is rebuilt from the operator's own files (`course-docs add <directory>`) or from
  `course-docs canvas --yes`.
