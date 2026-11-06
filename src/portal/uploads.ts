/**
 * Files a student attaches in the page. A file goes through three steps: `POST /api/upload` puts it in the student's own workspace
 * (`groups/<folder>/uploads/`, which the student's agent container sees as /workspace/group/uploads/), answers with an id, and
 * `POST /api/send` names the ids that belong to the message. Nothing else of a request decides what is written where: the folder comes
 * from the session, the name is reduced to a safe one, the kind comes from the extension AND the bytes, and the sizes are capped.
 *
 * Text and code are also shown to the agent inside the message (their start), so the common case needs no tool call. PDF and Office files
 * are named and the agent reads them with its tools. A picture is kept for the page (a thumbnail) and, while the folder has room, in the
 * workspace too: the agent reads the TEXT in it with `read_image_text` (docs/OCR.md). It cannot see the picture, and says so, unless TAI_VISION is on
 * (src/vision-env.ts, docs/VISION.md): then it is told it can LOOK at it too, with `look_at_image`, and the picture goes to z.ai.
 * A recording is not an attachment: voice notes have their own call (`POST /api/voicenote`, in server.ts), and a recording sent here is refused.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import { createFileExclusive, readTextSafe, realDirInside, unlinkSafe } from '../safe-fs.js';
import { visionOn } from '../vision-env.js';
import type { EntryFile } from './history.js';
import { STUDENT_FOLDER } from './history.js';

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const FOLDER_MAX_BYTES = 50 * 1024 * 1024;
export const FOLDER_MAX_FILES = 100;
/** Pictures stop being kept in the workspace at this share of the folder's limits: a student's screenshots must not use up the room their code files need. */
export const PICTURE_SHARE = 0.8;
export const MAX_PENDING = 10;
const PENDING_TTL_MS = 30 * 60_000;
export const EXCERPT_CHARS = 6000;

export type UploadKind = EntryFile['kind'];

const TEXT_EXTENSIONS = new Set(
  ('txt md markdown rst csv tsv json jsonl ndjson yaml yml toml ini cfg conf xml html htm css scss js mjs cjs ts tsx jsx go mod sum py ipynb ' +
    'java kt scala c h cc cpp hpp cs rs rb php swift sh bash zsh sql tf tfvars hcl proto gradle properties log diff patch tex bib')
    .split(' '),
);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'procfile', 'gemfile', 'jenkinsfile']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const AUDIO_EXTENSIONS = new Set(['webm', 'ogg', 'oga', 'mp3', 'wav', 'm4a', 'mp4']);

/** Every extension the page's file picker offers (the server decides again, from the same lists). */
export const ACCEPTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS].sort();

/** A file name reduced to what is safe on the host and readable for the agent: no directories, letters, digits and . _ - only. */
export function safeUploadName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() || '';
  let clean = base.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  if (clean.length > 80) {
    const ext = path.extname(clean).slice(0, 12);
    clean = clean.slice(0, 80 - ext.length) + ext;
  }
  return clean || 'file';
}

export function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** What kind of file this is, by name and by the bytes; null when it is none of the kinds that are accepted. */
export function classifyUpload(name: string, body: Buffer): UploadKind | null {
  if (body.length === 0) return null;
  const ext = extensionOf(name);
  const stem = path.basename(name).toLowerCase();
  const head = body.subarray(0, 8192);
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    const pdf = body.subarray(0, 5).toString('latin1') === '%PDF-';
    const zip = body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04;
    return (ext === 'pdf' ? pdf : zip) ? 'document' : null;
  }
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';             // the media store sniffs it again before it keeps it
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext) || (ext === '' && TEXT_NAMES.has(stem))) {
    return head.includes(0) ? null : 'text';                // a "text" file with NUL bytes is something else in disguise
  }
  return null;
}

export interface PendingUpload {
  id: string;
  folder: string;
  /** The name it was kept under (inside uploads/); for a picture that was not kept there (`stored` is not set), the name it was sent with. */
  name: string;
  size: number;
  kind: UploadKind;
  media?: string;
  /** A picture only: a copy of it is in the student's uploads/ under `name`, where the agent's container can read its text. */
  stored?: boolean;
  at: number;
}

/** The text of a text file for the agent: its start, cut at a line where it can be. */
export function excerptOf(text: string, max = EXCERPT_CHARS): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const nl = head.lastIndexOf('\n');
  return { text: nl > max * 0.6 ? head.slice(0, nl) : head, cut: true };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class UploadStore {
  private pending = new Map<string, PendingUpload>();
  /**
   * Told of every pending upload that is let go without being sent (its student took it back, or its time ran out): the media store's copy of a picture
   * goes with it (the page's server connects the two). Not told of one a message took.
   */
  onDrop?: (up: PendingUpload) => void;

  constructor(
    private readonly groupsDir: string,
    private readonly now: () => number = Date.now,
    /** Whether TAi may look at a picture (TAI_VISION): asked at each message, so the words and the container's tool follow the same setting (src/vision-env.ts). */
    private readonly vision: () => boolean = () => visionOn(),
  ) {}

  /** A pending upload nobody sent: forgotten, its file taken out of the student's workspace and its other copy let go. */
  private drop(up: PendingUpload): void {
    this.pending.delete(up.id);
    if (up.kind === 'text' || up.kind === 'document' || (up.kind === 'image' && up.stored)) unlinkSafe(path.join(this.dirOf(up.folder), up.name), this.folderOf(up.folder));
    try {
      this.onDrop?.(up);
    } catch {
      /* the other copy is a courtesy to the disk */
    }
  }

  private sweep(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const up of [...this.pending.values()]) if (up.at < cutoff) this.drop(up);
  }

  /** Whether this student may have one more upload waiting (checked before anything is copied, so a refusal leaves no copy behind). */
  hasRoom(folder: string): boolean {
    this.sweep();
    return [...this.pending.values()].filter((u) => u.folder === folder).length < MAX_PENDING;
  }

  private folderOf(folder: string): string {
    return path.join(this.groupsDir, folder);
  }

  private dirOf(folder: string): string {
    return path.join(this.groupsDir, folder, 'uploads');
  }

  /** What the student's uploads folder holds already, for the quota. A folder that is a link leading out of the student's own is full: nothing more is kept there. */
  private usage(folder: string): { files: number; bytes: number } {
    const dir = this.dirOf(folder);
    try {
      fs.lstatSync(dir);
    } catch {
      return { files: 0, bytes: 0 };                         // no uploads yet
    }
    if (realDirInside(dir, this.folderOf(folder)) === null) return { files: Infinity, bytes: Infinity };
    let files = 0;
    let bytes = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;                       // (a link is not a file here: it is not counted, and never followed)
        files++;
        bytes += fs.lstatSync(path.join(dir, entry.name)).size;
      }
    } catch {
      /* unreadable: counted as far as it went */
    }
    return { files, bytes };
  }

  /**
   * Writes a file into the student's uploads folder under a name that is free (a second `main.go` is `main-2.go`); null when the folder has no room
   * for it: `share` is how much of the folder's limits this file may use (all of them, for a file a student attaches). The file is created exclusively and
   * only in a directory that stays inside the student's folder: the student's container can plant a link where a free name looks free (a link to a
   * path that does not exist yet passes `existsSync`), and a write through it would create a file anywhere the orchestrator can write (src/safe-fs.ts).
   */
  private store(folder: string, name: string, body: Buffer, share = 1): string | null {
    const used = this.usage(folder);
    if (used.files >= FOLDER_MAX_FILES * share || used.bytes + body.length > FOLDER_MAX_BYTES * share) return null;
    const dir = this.dirOf(folder);
    const safe = safeUploadName(name);
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? safe : `${stem}-${i}${ext}`;
      try {
        createFileExclusive(path.join(dir, candidate), body, this.folderOf(folder));
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;      // taken, a link that dangles included: the next name
        return null;                                                          // a directory that leads out of the folder, a full disk
      }
    }
    return null;
  }

  /** Keeps a text or document file in the student's workspace and remembers it as waiting for a message. */
  keepFile(folder: string, name: string, kind: 'text' | 'document', body: Buffer): PendingUpload | { error: 'quota' | 'too-many-pending' } {
    if (!STUDENT_FOLDER.test(folder)) throw new Error('not a student folder');
    this.sweep();
    if ([...this.pending.values()].filter((u) => u.folder === folder).length >= MAX_PENDING) return { error: 'too-many-pending' };
    const stored = this.store(folder, name, body);
    if (stored === null) return { error: 'quota' };
    return this.remember({ id: randomBytes(12).toString('hex'), folder, name: stored, size: body.length, kind, at: this.now() });
  }

  /**
   * A picture the page keeps itself (the media store has the bytes). Given its bytes, it is also kept in the student's workspace (uploads/), where
   * the agent's container can read the text in it (read_image_text); without them, with no room left for it there (a share of the folder's limits,
   * PICTURE_SHARE), in a folder that is not a student's, or on a disk that will not take it, the agent is only told that it exists. The page has its
   * picture either way: a picture is never refused here for the room the workspace has.
   */
  keepPicture(folder: string, name: string, size: number, media: string, body?: Buffer): PendingUpload | { error: 'too-many-pending' } {
    this.sweep();
    if ([...this.pending.values()].filter((u) => u.folder === folder).length >= MAX_PENDING) return { error: 'too-many-pending' };
    let stored: string | null = null;
    if (body && body.length > 0 && STUDENT_FOLDER.test(folder)) {
      try {
        stored = this.store(folder, name, body, PICTURE_SHARE);
      } catch {
        stored = null;
      }
    }
    return this.remember({ id: randomBytes(12).toString('hex'), folder, name: stored ?? safeUploadName(name), size, kind: 'image', media, ...(stored ? { stored: true } : {}), at: this.now() });
  }

  private remember(up: PendingUpload): PendingUpload {
    this.pending.set(up.id, up);
    return up;
  }

  /** A waiting upload its student took back (they removed its chip): forgotten, and the file it made is removed from their workspace. */
  release(folder: string, id: string): boolean {
    const up = this.pending.get(id);
    if (!up || up.folder !== folder) return false;
    this.drop(up);                                                       // the name is one safe file name inside their own uploads/
    return true;
  }

  /** The uploads a message names, if they are this student's and still waiting; they are used up by being taken. */
  take(folder: string, ids: readonly string[]): PendingUpload[] | null {
    this.sweep();
    const taken: PendingUpload[] = [];
    for (const id of ids) {
      const up = this.pending.get(id);
      if (!up || up.folder !== folder) return null;
      taken.push(up);
    }
    for (const up of taken) this.pending.delete(up.id);
    return taken;
  }

  /**
   * The message as TAi gets it: what the student wrote, then what they attached. Text files carry their start (so the common case needs
   * no tool call); documents are named, to be read with the tools; a picture that is in the workspace is named with its path and the tool that
   * reads its TEXT (and with the fact that its looks are out of reach). With TAI_VISION on it is also told it can LOOK at the picture (look_at_image: charts,
   * diagrams, interfaces, screenshots) and must say so honestly when one is not clear. A picture that is not in the workspace, and every picture for a voice
   * call (`audience` "call": the call's model has no tool that reads one), is named with the fact that TAi cannot see it, in the words it always
   * had, switch or no switch: session.ts looks for "(a picture, " in that line to put a notice on the page.
   */
  messageFor(text: string, files: readonly PendingUpload[], audience: 'agent' | 'call' = 'agent'): string {
    if (files.length === 0) return text;
    const lines: string[] = [text.trim() || 'I attached a file.', '', '[The student attached, saved in your workspace:]'];
    const bodies: string[] = [];
    for (const f of files) {
      if (f.kind === 'image' && f.stored && audience === 'agent' && this.vision()) {
        lines.push(
          `- /workspace/group/uploads/${f.name} (a picture, ${humanSize(f.size)}): you can look at it with look_at_image (charts, diagrams, interfaces, screenshots: give it this path and the student's question) ` +
            'and read its exact text with read_image_text, giving it this path; if a picture is not clear to you, say so honestly, ask the student to describe it, and never guess what it shows',
        );
      } else if (f.kind === 'image' && f.stored && audience === 'agent') {
        lines.push(
          `- /workspace/group/uploads/${f.name} (a picture, ${humanSize(f.size)}): read the text in it with read_image_text, giving it this path; ` +
            'you cannot see charts, diagrams or what a screen looks like, so say so if the question is about that',
        );
      } else if (f.kind === 'image') {
        lines.push(`- ${f.name} (a picture, ${humanSize(f.size)}): you cannot see pictures; ask the student to paste the text or describe it`);
      } else {
        lines.push(`- /workspace/group/uploads/${f.name} (${f.kind === 'document' ? 'document' : 'text'}, ${humanSize(f.size)})`);
        if (f.kind === 'text') {
          // (a regular file of their own folder only: the container could have put a link there since the upload, and the text goes into the agent's prompt)
          const raw = readTextSafe(path.join(this.dirOf(f.folder), f.name), UPLOAD_MAX_BYTES, this.folderOf(f.folder));
          if (raw !== null) {
            const ex = excerptOf(raw);
            bodies.push(`--- ${f.name}${ex.cut ? ` (first ${ex.text.length} characters; the whole file is in your workspace)` : ''} ---\n${ex.text}\n---`);
          }                                                              // else gone since it was saved, or not a file of theirs: the line above still names it
        }
      }
    }
    return [...lines, ...bodies.flatMap((b) => ['', b])].join('\n');
  }
}

/** What the page shows of an upload that is part of a message. */
export function entryFile(up: PendingUpload): EntryFile {
  return { name: up.name, size: up.size, kind: up.kind, ...(up.media ? { media: up.media } : {}) };
}
