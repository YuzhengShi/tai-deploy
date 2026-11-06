/**
 * The pictures and voice notes that reach the page: a diagram TAi drew, an illustration, an image the student attached, a recording the
 * student sent. They are kept as files under `<dir>/<student folder>/<id>.<ext>` and served by `GET /api/media/<id>` to the student they
 * belong to and nobody else.
 *
 * What is stored must really be what it says: the bytes are sniffed (the sender's word, the file's name and its extension count for
 * nothing). Only PNG, JPEG, GIF and WebP pass as pictures (SVG never does: it can carry script), only WebM, Ogg, MP4, MP3 and WAV pass as
 * audio, and what is served carries the type that was sniffed. `save` keeps pictures only (the web channel and the upload route use it and
 * must never be handed a recording); `saveAudio` is the voice note's own door, with a quota per student.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { isChatFolder } from './history.js';

export interface ImageType {
  mime: string;
  ext: string;
}

export const MEDIA_ID = /^[0-9a-f]{32}$/;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** What one student's voice notes may add up to on the host (a note is a few hundred KB at speech quality). */
export const AUDIO_FOLDER_MAX_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS = ['png', 'jpg', 'gif', 'webp'];
const AUDIO_EXTENSIONS = ['webm', 'ogg', 'm4a', 'mp3', 'wav'];

/** The request types a voice note may arrive as, and the type each one is stored and served under. */
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'] as const;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The picture type the bytes themselves say they are, or null. */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/** The audio type the bytes themselves say they are, or null: WebM (Chrome, Edge, Firefox), Ogg, MP4/M4A (Safari), MP3 and WAV. */
export function sniffAudio(buf: Buffer): ImageType | null {
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3 && buf.subarray(0, 64).includes('webm')) {
    return { mime: 'audio/webm', ext: 'webm' };              // an EBML header whose DocType is webm (a Matroska video is not a voice note)
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (buf.length >= 3 && buf.subarray(0, 3).toString('latin1') === 'ID3') return { mime: 'audio/mpeg', ext: 'mp3' };
  // an MPEG audio frame header: eleven bits of sync, then a version that is not reserved and a layer that is not zero
  if (buf.length >= 4 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && ((buf[1] >> 3) & 3) !== 1 && ((buf[1] >> 1) & 3) !== 0) return { mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

export type SavedAudio = { id: string; mime: string } | { error: 'unsupported' | 'quota' };
export type SavedImage = { id: string; mime: string } | { error: 'unsupported' | 'quota' };

/**
 * What one student's pictures (the ones they attach and the diagrams TAi drew for them) may add up to on the host. A picture is only sniffed by its first
 * bytes, so before this cap a student could fill the disk with 8 MB of anything that starts like a PNG, 30 uploads every ten minutes.
 */
export const IMAGE_FOLDER_MAX_BYTES = 200 * 1024 * 1024;

export class MediaStore {
  constructor(
    private readonly dir: string,
    private readonly audioQuota = AUDIO_FOLDER_MAX_BYTES,
    private readonly imageQuota = IMAGE_FOLDER_MAX_BYTES,
  ) {}

  /** Keeps a picture for this student; null when the folder is not a student's, the bytes are not a picture or are too many, or the student's pictures are at their cap. */
  save(folder: string, buf: Buffer): { id: string; mime: string } | null {
    const saved = this.saveImage(folder, buf);
    return 'error' in saved ? null : saved;
  }

  /** `save`, saying why not: `unsupported` (not a student's folder, empty, too many bytes, not a picture) or `quota` (the student's pictures already add up to the cap). */
  saveImage(folder: string, buf: Buffer): SavedImage {
    if (!isChatFolder(folder) || buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return { error: 'unsupported' };
    const type = sniffImage(buf);
    if (!type) return { error: 'unsupported' };
    if (this.imageBytes(folder) + buf.length > this.imageQuota) return { error: 'quota' };
    return this.write(folder, buf, type);
  }

  /** What this student's pictures take on the disk now. */
  imageBytes(folder: string): number {
    let total = 0;
    try {
      for (const name of fs.readdirSync(path.join(this.dir, folder))) {
        if (IMAGE_EXTENSIONS.includes(path.extname(name).slice(1))) total += fs.statSync(path.join(this.dir, folder, name)).size;
      }
    } catch {
      /* nothing kept yet */
    }
    return total;
  }

  /** Lets go of a picture of this student's that nothing refers to (an upload that was refused, taken back or never sent). Whether a file was removed. */
  remove(folder: string, id: string): boolean {
    if (!isChatFolder(folder) || !MEDIA_ID.test(id)) return false;
    let removed = false;
    for (const ext of IMAGE_EXTENSIONS) {
      try {
        fs.unlinkSync(path.join(this.dir, folder, `${id}.${ext}`));
        removed = true;
      } catch {
        /* not that type, or already gone */
      }
    }
    return removed;
  }

  /**
   * Keeps a voice note for this student. `unsupported`: the bytes are not audio of a kind the page can play (or are empty or too many for
   * `maxBytes`); `quota`: this student's recordings already add up to `AUDIO_FOLDER_MAX_BYTES`.
   */
  saveAudio(folder: string, buf: Buffer, maxBytes: number): SavedAudio {
    if (!isChatFolder(folder) || buf.length === 0 || buf.length > maxBytes) return { error: 'unsupported' };
    const type = sniffAudio(buf);
    if (!type) return { error: 'unsupported' };
    if (this.audioBytes(folder) + buf.length > this.audioQuota) return { error: 'quota' };
    return this.write(folder, buf, type);
  }

  private write(folder: string, buf: Buffer, type: ImageType): { id: string; mime: string } {
    const id = randomBytes(16).toString('hex');
    const dir = path.join(this.dir, folder);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${id}.${type.ext}`), buf, { mode: 0o600 });
    return { id, mime: type.mime };
  }

  /** What this student's voice notes take on the disk now. */
  audioBytes(folder: string): number {
    let total = 0;
    try {
      for (const name of fs.readdirSync(path.join(this.dir, folder))) {
        if (AUDIO_EXTENSIONS.includes(path.extname(name).slice(1))) total += fs.statSync(path.join(this.dir, folder, name)).size;
      }
    } catch {
      /* nothing kept yet */
    }
    return total;
  }

  /** A picture or voice note of this student's, or null: the id is checked before it goes near a path, and the folder comes from the session. */
  open(folder: string, id: string): { body: Buffer; mime: string } | null {
    if (!isChatFolder(folder) || !MEDIA_ID.test(id)) return null;
    for (const ext of [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS]) {
      let body: Buffer;
      try {
        body = fs.readFileSync(path.join(this.dir, folder, `${id}.${ext}`));
      } catch {
        continue;
      }
      const type = IMAGE_EXTENSIONS.includes(ext) ? sniffImage(body) : sniffAudio(body);
      return type ? { body, mime: type.mime } : null;
    }
    return null;
  }
}
