/**
 * How fast TAi speaks to THIS student. The Settings dialog of the page stores `voiceSpeed` (0.8 to 1.4) in the student's preferences file,
 * `<store>/portal/<folder>.prefs.json`, and a call reads it when it starts: the pace goes into the Settings message and into every UpdateSpeak
 * of the call (settings.ts speakConfig), where it is clamped to what the call's voice accepts. Without a usable value the pace is the
 * deployment's (TAI_VOICE_SPEED, 1.2 by default: the owner found the voice's own pace slow).
 *
 * This file only reads. The dialog's route writes the preferences, and a file or a value that is missing, unreadable or not a number in range is
 * not an error: it means "the default", because a call must never fail to start over a preference.
 */
import fs from 'fs';
import path from 'path';

/** What the Settings dialog may store. A value outside it is a broken or hand-edited file and counts as none. */
export const PREF_SPEED_MIN = 0.8;
export const PREF_SPEED_MAX = 1.4;

const FOLDER = /^[A-Za-z0-9_-]{1,64}$/;
/** A preferences file is a few lines; one this big is not one. */
const MAX_PREFS_BYTES = 64 * 1024;

/** The student's preferences file (the Settings dialog's route writes it). */
export function prefsFile(storeDir: string, folder: string): string {
  return path.join(storeDir, 'portal', `${folder}.prefs.json`);
}

/** The text of a file, or null when it is not there, too big or unreadable. */
function readSmall(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_PREFS_BYTES) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The `voiceSpeed` of a preferences file's text, in the steps Deepgram's Flux voices take (0.05), or undefined: no file, text that is not a JSON
 * object, no such key, a value that is not a number (a numeric string counts: it is what a form hands over) or that is outside 0.8 to 1.4.
 */
export function speedFromPrefs(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  let prefs: unknown;
  try {
    prefs = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return undefined;
  const raw = (prefs as Record<string, unknown>).voiceSpeed;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d(?:\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < PREF_SPEED_MIN - 1e-9 || value > PREF_SPEED_MAX + 1e-9) return undefined;
  return Math.round(value * 20) / 20;
}

/**
 * The pace for this student's call: their chosen one when the file has one, else `defaults` (the deployment's TAI_VOICE_SPEED; undefined is the
 * voice's own pace). A student who chose 1.0 gets 1, the voice's own pace, even where the deployment's default is faster: they said so.
 * `io.read` is for tests; it answers the text of the file or null.
 */
export function speedFor(folder: string, defaults: number | undefined, io: { storeDir: string; read?: (file: string) => string | null }): number | undefined {
  if (!FOLDER.test(folder)) return defaults;
  let text: string | null = null;
  try {
    text = (io.read ?? readSmall)(prefsFile(io.storeDir, folder));
  } catch {
    /* a file that cannot be read is no file */
  }
  return speedFromPrefs(text) ?? defaults;
}
