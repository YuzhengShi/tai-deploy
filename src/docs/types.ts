/**
 * The shared contract of the document viewer (docs/CHAT_OBJECTS.md, "Documents"): what a prepared document is, what the host keeps of it, and what the rest of the
 * orchestrator (the portal's routes, the voice functions, the IPC verb) may ask of it. Types and pure helpers only: the renderer, the store and the routes
 * are built against this file (src/docs/*.ts), and so are their fakes in the tests of the voice side.
 *
 * A prepared document is a directory of the student's own, `<store>/portal/docs/<folder>/<id>/`:
 *   meta.json            DocMeta
 *   p001.png ...         one image of each page (PNG or JPEG: sniffed, never trusted by name)
 *   w001.json ...        PageWords of each page (the words of the page with their boxes, in reading order)
 * Everything in it was made by the renderer container from an untrusted file and is checked again by the host before it is kept (src/docs/words.ts validateWords).
 */

/** The id of a prepared document: 32 hex digits. The only thing that ever becomes a path segment of a document. */
export const DOC_ID = /^[0-9a-f]{32}$/;

export const DOC_LIMITS = {
  /** The file that is rendered, in bytes (an upload is at most 5 MB, a Canvas file or a course deck at most this). */
  sourceBytes: 20 * 1024 * 1024,
  /** Pages kept of one document (the rest is not rendered; the meta says how many there were). */
  pages: 120,
  /** The longest side of a page image, in pixels. */
  imagePx: 1100,
  /** One page image, in bytes. */
  imageBytes: 900 * 1024,
  /** Words kept of one page. */
  wordsPerPage: 4000,
  /** A word, in characters. */
  wordChars: 40,
  /** What one student may hold: documents and bytes (the oldest go first). */
  perStudentDocs: 8,
  perStudentBytes: 60 * 1024 * 1024,
  /** Opens a student may ask for: in ten minutes and in a day. */
  opensPer10Min: 6,
  opensPerDay: 20,
  /** A title, in characters. */
  titleChars: 120,
  /** How long a prepared document is kept after it was last opened. */
  keepDays: 30,
} as const;

export type DocOrigin = 'upload' | 'canvas' | 'course';
export const DOC_ORIGINS: readonly DocOrigin[] = ['upload', 'canvas', 'course'];

export interface DocMeta {
  id: string;
  title: string;
  /** Pages that were rendered. */
  pages: number;
  /** Pages the file has, when more than were rendered. */
  pagesInFile?: number;
  origin: DocOrigin;
  /** Epoch ms. */
  createdAt: number;
  /** Bytes the prepared document takes on disk (images and words). */
  bytes: number;
  /** The first page's width divided by its height: the shape the viewer reserves before the image arrives (the page accepts 0.05 to 20). */
  aspect?: number;
}

/**
 * The words of one page, in reading order. Boxes are fractions of the page (0..1, four decimals): x to the right, y downwards, so they are the same at any zoom.
 * `lines` are index ranges into `words` (inclusive), in reading order; a page with no text layer (a scan) has no words and no lines.
 */
export interface PageWords {
  words: Array<[number, number, number, number, string]>;
  lines: Array<[number, number]>;
}

/** The course library (batch C1, docs/COURSE_DOCS.md): decks the operator added for every student, in `<store>/course-docs/`. */
export const LIBRARY_LIMITS = {
  /** Entries in the library (the operator's `course-docs add` refuses more). */
  entries: 100,
  /** What the library may take on disk, in bytes (images and words of all its entries). */
  bytes: 1536 * 1024 * 1024,
  /** The highest week number an entry may have. */
  maxWeek: 30,
  /** What a search returns: hits, and of those at most this many from one deck. */
  hits: 5,
  perDeck: 3,
  /** A snippet of a hit, in characters. */
  snippetChars: 160,
  /** A search query, in characters (what a model gives is cut to it). */
  queryChars: 200,
} as const;

/** One entry of the library: the same document as a student's (origin `course`) with what the index adds. */
export interface LibraryEntry extends DocMeta {
  /** The week of the course it belongs to (1 to LIBRARY_LIMITS.maxWeek), or null when the operator did not say. */
  week: number | null;
  /** The name of the file it was made from (one line). */
  sourceName: string;
  /** SHA-256 of that file: the same file is not added twice. */
  sha256: string;
}

/** One hit of a search of the library: the deck, the page, and a stretch of that page's own words around the first word that matched (never made up, at most `snippetChars`). */
export interface LibraryHit {
  id: string;
  title: string;
  week: number | null;
  page: number;
  /** How many pages the deck has (what the viewer will show). */
  pages: number;
  snippet: string;
}

/** What the viewer's describe/point code needs of the store: reads only. */
export interface DocReader {
  meta(folder: string, id: string): DocMeta | null;
  words(folder: string, id: string, page: number): PageWords | null;
  /** The page's text as one string, lines joined with newlines (what a model is given). */
  text(folder: string, id: string, page: number): string | null;
}

/** A file of the course's Canvas that a student may open (docs/COURSE_DOCS.md, "Canvas files"): what a model may name, never an address: the host holds the rest. */
export interface CanvasFileInfo {
  id: number;
  name: string;
  kind: 'pdf' | 'pptx' | 'docx' | 'xlsx';
  size: number;
}

export type CanvasFilesResult = { ok: true; files: CanvasFileInfo[] } | { ok: false; message: string };

/** What the host is asked to open. */
export type DocSource =
  /** A file the student attached or the agent saved in `groups/<folder>/uploads/` (read with the group folder as the root). */
  | { kind: 'upload'; name: string; title?: string }
  /** Bytes the host holds already (a Canvas file the tool host fetched, an operator-made course deck). */
  | { kind: 'bytes'; name: string; bytes: Buffer; origin: DocOrigin; title?: string }
  /** A prepared document that already exists (a course library entry, or one of the student's own by id). */
  | { kind: 'existing'; id: string };

export type DocOpenResult =
  | { ok: true; doc: DocMeta; page: number }
  | { ok: false; reason: 'off' | 'busy' | 'limit' | 'bad-file' | 'too-big' | 'failed' | 'not-found'; message: string };

/** What a found phrase is: the words' index range on the page, and the boxes to draw (one for each line it spans). */
export interface PointResult {
  from: number;
  to: number;
  exact: boolean;
  boxes: Array<[number, number, number, number]>;
  text: string;
}

/** What the voice side, the IPC verb and the portal's routes use. `src/docs/docs.ts` makes the real one; tests use a fake. */
export interface DocsApi extends DocReader {
  /** Prepares a document and keeps it (the renderer container, the quota, the rates). Never throws: a failure is `{ ok: false }` with a sentence for a model. */
  open(who: { folder: string }, source: DocSource): Promise<DocOpenResult>;
  /** Where a page's image is on disk, for the route that serves it; null when there is none. */
  pageFile(folder: string, id: string, page: number): { file: string; type: 'image/png' | 'image/jpeg' } | null;
  /** The student's prepared documents, newest first (title, pages): what `show_document` may name (with the library's: `library()`). */
  list(folder: string): DocMeta[];
  /** The course library's entries, by week and then title: the same for every student, read-only for them; what `show_document` may name for everyone. Empty when there is none. */
  library(): LibraryEntry[];
  /** Searches the library's titles and the words of its pages (src/docs/library-search.ts): up to `LIBRARY_LIMITS.hits` hits, best first. Never throws. */
  searchLibrary(query: string): LibraryHit[];
  /**
   * The files of the course's Canvas that a student may open, by name (the same for every student; kept for ten minutes): `{ ok: true, files: [] }` when Canvas is not set up here, `{ ok: false }` with a sentence for a model when
   * Canvas did not answer. Absent when the host has no Canvas source (src/docs/canvas-source.ts). Never throws.
   */
  canvasFiles?(): Promise<CanvasFilesResult>;
  /** Opens one of them (`id` from `canvasFiles`) as the student's own document, origin `canvas`: the host downloads it, then it is prepared as any file is. Never throws. */
  openCanvasFile?(who: { folder: string }, id: number): Promise<DocOpenResult>;
  /** Whether the renderer is there (its image is built). */
  ready(): Promise<boolean>;
  /** Removes what is past `keepDays` and what a quota says is too much; at startup and daily. Never throws. */
  reap(): Promise<number>;
}
