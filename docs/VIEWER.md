# The document viewer (the page's side)

What the student sees of a prepared document (docs/CHAT_OBJECTS.md, "Documents" and "The view"): a card in the conversation, a pane that shows its pages, words they can pick out, a spot they can point at, boxes TAi draws, and the
report of all of it to the shared view state (`portal/web/view-state.js`). The page builds everything from text and from the images the server made; it parses no document and draws nothing a model wrote.

Files: `portal/web/viewer.js` and `viewer.css` (the pane, and the pure functions under it), `portal/web/doccard.js` (the card), `portal/web/voice.js` (`call.sendView`, `onScreen`), tests `viewer.test.js` and `doccard.test.js`,
the QA fakes in `portal/qa/dev_server.mjs` and `fake_voice.mjs`, and the flow `document_viewer` of `portal/qa/portal_e2e.py`.

## What the student sees

* **A card** (`doccard.js`, a `doc` chat object): a page-shaped tile (the first page's picture when it loads, the icon when it does not; the tile has its size before the picture arrives), the title, "4 pages" (and "opens at page 3", and
  where the file came from), and a button. The button reads **Open** while the viewer is closed or has another document, **Showing** while the viewer is on the card's page, **Open page** while it has the document at another page.
  It follows the viewer through the view state (`h.view.onChange`), and returns `destroy` to stop listening (app.js does not call `destroy` for cards today: a card lives as long as the page). A card is no reply: no emoji, no copy,
  no unread count. With `features.viewer` off it is a description with no button and no picture request.
* **The viewer** (`#viewer`): on a window at least 1000 px wide a **pane** beside the conversation (`clamp(380px, 42vw, 760px)`; the conversation narrows, nothing else about its layout changes: the page puts `with-viewer` on `.app`,
  which gets a third grid column). Under 1000 px a **sheet**: full height down to the top of the message box (viewer.js measures the box, so the call's orb, mute and end buttons, the file tray and the message box stay in reach, and the
  orb is smaller while a document is open), with a **Back to the chat** button where the pane has a close button. While a sheet is open, the topbar and the conversation under it are `inert` (not reachable by keyboard or screen reader).
* **The header**: the title, **Page N of M** with previous and next, the tabs **Page** and **Text**, and the zoom **Fit**, **100%**, **150%** (100% is the picture's own width; a page wider than the pane scrolls, opening in the middle). **Fit** is "fit to the width"; a page that is shorter than the pane (a slide in a tall pane) sits in the middle of the room it has, with the same space above and below (2026-11-08: it used to hang from the top with a great empty space under it; `viewer.css`, `margin: auto` on a flex item), and a page that is taller than the pane starts at the top and scrolls as before.
  A pane that has nothing to show yet (a document being opened or prepared, one that is gone) says so in plain words and has a Close button.
* **The page**: an `<img>` of `GET api/doc/page?d=<id>&p=<n>` (a page not shown before is asked for after it has stayed a quarter of a second, with its words and the pictures beside it: the server's read allowance, 240 a minute for a student,
  is shared with the chat's own polling, so turning quickly through a document must not spend it on pages that were only passed). Its box has the page's shape before the picture arrives (`meta.aspect` for the first page, the picture's own shape once a page has loaded; the next and previous
  pages are fetched ahead, so a turned page does not jump), a picture that fails says "This page could not be loaded." with **Try again**. Alt text: "Page 2 of 5. The text of the page is in the Text tab."
* **Words**: a **drag** with a mouse or pen picks the words from the one under where it began to the one under where it ended, in reading order, as a text selection does (whole lines in between; a drag that ends in the white space
  beyond the text counts for the word at the other end; at most 600 words, the word where the drag began always stays). One box for each line shows what is picked. **Ask TAi about this** (in the bar at the foot, with the count of
  words and a clear button) puts the words in the message box as a quotation and does not send. A **click** (a **tap** on a touch screen) is a spot: a marker, and its fractions go in the view. A finger that moves scrolls the page; on a
  touch screen words are picked in the Text tab (long press), where the browser's own selection works.
* **TAi's boxes**: a `point` message draws its boxes in purple for 8 seconds, until the page changes or the next `point` arrives, and a screen reader is told what is under them ("TAi is pointing at: ...", from the page's words).
  A `point` never opens a document or turns a page: boxes for the page that is on screen are drawn at once; boxes that come while a `show` for their page is on its way (the host sends `show` and `point` a few milliseconds apart) are kept
  and drawn when that page is displayed, for what is left of the 8 seconds (dropped if the student has gone to another page meanwhile); boxes for any other page or document, or while the viewer is closed, are ignored.
  A `show` message opens the document at a page without taking the keyboard focus; `doc_state` shows "Preparing ..." (the pane opens with that line if nothing is open) or the failure's words (in the header of an open document; a pane
  that was only waiting closes and the words go to the toast).
* **The Text tab**: the page's words as real text, a line to a line, one `<span>` for each word. A selection made there is reported as the same words (the first and the last word it touches); if the words cannot be told it is not
  reported, and a selection reported before is taken back. The words of the current selection carry a mark in the tab too, whichever tab made the selection.

## The keyboard

With the focus in the pane (it moves to the page when the student opens a document): **Left** and **Page Up** the previous page, **Right** and **Page Down** the next, **+** and **-** the zoom, **Escape** closes and gives the focus
back to the button that opened it (the message box on a window with a mouse; nothing on a phone, whose keyboard would cover the conversation). Keys are handled on the pane only, never on the document: the arrows and +/- in the message box
are the message box's. A key that is held down turns one page (its repeats do nothing). Shift with an arrow is left to the browser (extending a selection). Buttons that cannot act are `aria-disabled`, not `disabled`, so the focus is never lost to a button that turned itself off. A page change and
the first page announce "Page N of M" politely; reduced motion stops every animation (style.css); colours are the page's tokens, and the page image is white in both themes, so the selection (blue), the spot (blue) and TAi's boxes
(purple) have colours of their own that read on white (forced colours: the system's).

## What it reports (the parts of the view it owns: `doc`, `sel`, `point`)

| when | `view.set(...)` |
|---|---|
| a page is shown | `{ doc: { id, page }, sel: null, point: null }` |
| a drag or a selection in the Text tab | `{ sel: { doc, page, from, to }, point: null }` (indexes into that page's words, inclusive, at most 600) |
| a click or a tap | `{ point: { doc, page, x, y }, sel: null }` (fractions 0..1) |
| the viewer closes (or the student signs out) | `{ doc: null, sel: null, point: null }` |

`msg` and `obj` are never touched. Sending is the view state's: during a call `call.sendView(view)` puts `{ type: 'view', view }` on the call's socket (true when it was sent: only once the server has said `ready`; app.js posts
`api/view` otherwise). The page never sends text a model reads.

## Opening

* the card's button, and the Open button on the chip of a PDF, a presentation or a document (a file of kind document that ends .pdf, .pptx, .docx or .xlsx: `isOpenable`; `offerOpen(chip, { n, index, name, kind })`: `POST api/doc/open { n, index }`; `n` may be a number or a function and is read when the button is pressed, by default from the
  chip's row; 200 `ready` opens, 202 `preparing` polls `GET api/doc/job?j=` every 1.5 s for up to 190 s (an Office file's render may take that long) while the button says "Preparing..."; an error is a toast in plain words, never a code);
* the call's `show { doc, page, title, pages }`, `point { doc, page, boxes }` (it draws on the page that is on screen or on its way: it never opens or turns) and `doc_state { state: 'preparing' | 'failed', title?, message? }` (`onScreen`, which ignores anything it
  cannot read);
* a **reload**: the last document and page are kept in `localStorage` (`tai.viewer`, in a try/catch; the zoom in `tai.viewer.zoom`) and opened again when the page signs in and `features.viewer` is on. A document that is gone is
  forgotten without a word; signing out forgets it.

## What the page expects of the server

Where docs/CHAT_OBJECTS.md leaves a body open, these are the shapes the page reads (it accepts the bare object or the same inside a key named for it, and checks every field):

* `GET api/doc/meta?d=` 200: a `DocMeta` (`id`, `title`, `pages` at least 1, optional `aspect` = width / height of the first page, 0.05 to 20, `origin`); 404 when the document is not the student's or has expired ("This document is no longer available.").
* `GET api/doc/page?d=&p=`: the image. `GET api/doc/words?d=&p=` 200: `{ words: [[x0, y0, x1, y1, text], ...], lines: [[a, b], ...] }` (a `PageWords`; the page keeps the lines only if they tile the words, and makes its own from the boxes
  otherwise). A page with no text (a scan) is a words file with no words; any other answer is a failure ("The text of this page could not be loaded.") and is asked for again the next time the page is shown.
* `POST api/doc/open` as in the contract. An error body is `{ error, message }` with the HTTP status the server likes; the page shows `message` when there is one, else its own words for `error`.
* `GET api/doc/job?j=`: as src/portal/doc-routes.ts answers it: 200 `{ ok: true, state: 'preparing' }` while it works; when it is done the same answer `open` gives (200 `{ ok: true, state: 'ready', doc, page }`, or the reason
  as `error`, a sentence as `message` and a status of its own: 502 it did not work, 503 busy or off, 413 too big ...), which is its last word; 404 when the job is unknown ("TAi lost track of that file."). A dropped connection, a 5xx with
  no reason and the server's own 429 `rate-limited` are waited out until the 190 s are up.

## The QA fakes (`portal/qa`)

`node portal/qa/dev_server.mjs` serves three generated documents (Homework 5 spec.pdf: four letter pages with a title, paragraphs, a diagram and code; Raft slides.pdf: three 16:9 slides; Scanned handout.pdf: one page with no text), each page
numbered, with words files that pass the server's own `validateWords` and boxes that match the ink; a document whose pictures and words answer 404; and one id that does not exist (an expired document). The student
**`dev:viewer@example.com`** starts with a history that has a message with PDF chips, a document card, a run card (a failing `go test -race ./...`, forty lines), a card of an expired document and a card of the deck at page 2;
`POST /objects/seed?who=NAME` on the control port does the same for any student, and `POST /attach?who=&names=a.pdf,b.pdf` adds a message with files (what opening each does is decided by its name: `slides`, `raft`, `scan`, `broken`, `slow`,
`fail`, `big`, `busy`). `POST /api/view` runs the real `parseViewState` and keeps the last view; `GET /api/qa/view` (signed in) and the control port's `GET /view?who=` return it with `via: 'post'` or `'socket'`. The fake call takes
`POST /voice/show?doc=&page=&title=&pages=`, `/voice/point?doc=&page=&phrase=` (or `&boxes=x0,y0,x1,y1;...`), `/voice/show-point?doc=&page=&title=&pages=&phrase=` (both, back to back, as the host sends them when TAi points at a phrase
on a page that is not open) and `/voice/doc-state?state=&title=&message=`, and records the page's `view` messages (`views` of `GET /voice`).

Checks: `npx vitest run portal/web/viewer.test.js portal/web/doccard.test.js` (the geometry and the words against `src/docs/words.ts`, what each action reports, the stored document, the three messages, opening and polling, the card);
`uv run --no-project --python 3.11 --with playwright python portal/qa/portal_e2e.py --only document_viewer` (a real browser: the cards, the pane, a drag, a click, the keyboard, the Text tab, Escape, a reload, a call that shows, points and
fails over a real socket with the view going back over it, a PDF chip's Open in each of its outcomes, a phone's sheet above the call's buttons).

## What the page's wiring gives it (app.js, index.html, style.css)

`initViewer({ root: #viewer, view, api, el, icon, toast, quote, inCall, features })` once; `createCall({ ..., onScreen })` and `call.sendView(view)` for the call's socket; `offerOpen(chip, { n, index, name, kind })` where a file chip of a
message is drawn (pass `n` as a function that reads the row's number, and the index in the message's own `files`). viewer.js also looks for three things the page has: the `.dock` (to stop a sheet above the message box), `.topbar` and
`.scroller` (made `inert` under a sheet), and `#input` (where the focus goes back to when nothing else is there). A page without them still works; a sheet then covers the message box and nothing is made inert.

## Not done, on purpose

Selecting words on a touch screen by dragging over the picture (a finger scrolls; the Text tab is the way), pinch zoom of our own (the browser's works), thumbnails of every page, search in a document, annotations that are kept.
