/** Small text cleaners the chat objects share: what a line of the chat may hold, whatever a caller hands over. Never throw. */

const NOISE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line: control and direction characters gone, white space made single, cut at `max` characters with an ellipsis; '' for anything that is not a string. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/** Text with its line breaks and tabs (and nothing else that is not printable), at most `max` characters; '' for anything that is not a string. */
export function block(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => (ch === '\n' || ch === '\t' ? ch : ' '))
    .replace(/\n{4,}/g, '\n\n\n')
    .trimEnd();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** An integer in [min, max], or null. */
export function int(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
