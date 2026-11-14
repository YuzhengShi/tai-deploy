/**
 * `spokenText`: one sentence cleaned for LabGPU's speech engine (the Supertonic synthesizer behind :8805).
 *
 * WHY this exists: the engine has an index of the characters it can pronounce, and a character that is not in it makes the backend throw. The adapter then
 * answers the WHOLE sentence from ElevenLabs (header `X-TTS-Fallback`), so the sentence is in a stranger's voice and its text has left the private network.
 * Nora met this on 2026-09-13 with U+2032 (the prime sign in "5′ and 3′"). So the sentence is reduced to characters the engine is known to take:
 * letters (ASCII and the Latin-1 accents), digits and a short list of punctuation. Everything else is spelled out, folded to a plain letter, or dropped.
 *
 * The first block of rules is Nora's `_SYMBOL_RULES` (D:\course-world\agent\tts.py), same order, same meanings, kept as she wrote them, including her
 * "3 or 5 before a prime means DNA, not minutes" rule ("15′" therefore reads "15 prime": her choice, pinned by a test).
 * Pure: no I/O, no state.
 */

/** Nora's rules, in her order. A few more single-character cases follow, for characters that Unicode normalisation below would turn into something else. */
const SYMBOL_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/([35])\s*\u2032/g, '$1 prime'], // 5′ and 3′ (DNA ends) win over minutes: a wrong guess costs one word, an unindexed code point costs the voice
  [/(\d+)\s*\u2033/g, '$1 seconds'], // U+2033 DOUBLE PRIME
  [/(\d+)\s*\u2032/g, '$1 minutes'], // 30′ is half an hour at the bench
  [/\u2032/g, ' prime'],
  [/\u2033/g, ' double prime'],
  [/[\u2010-\u2015]/g, '-'], // hyphens and dashes of every width
  [/[\u2018\u2019\u201b]/g, "'"],
  [/[\u201c\u201d\u201e]/g, '"'],
  [/\u2026/g, '...'],
  [/[\u00a0\u2007\u202f\u2009\u200a]/g, ' '],
  [/[\u200b\u200c\u200d\ufeff]/g, ''], // zero-width characters vanish
  // not Nora's: an acute accent or a modifier apostrophe used as an apostrophe (normalisation would split the first into a space and a combining mark)
  [/[\u00b4\u02bc]/g, "'"],
  // not Nora's: the typographic minus sign of math answers
  [/\u2212/g, '-'],
  // not Nora's: every other invisible format character (soft hyphen, bidi marks, word joiner, tag characters) vanishes like the zero-width ones
  [/\p{Cf}/gu, ''],
];

/** Emoji and pictographs, their modifiers, flags, keycap marks and variation selectors: dropped, with a space so that words next to them do not join. */
const PICTOGRAPHS = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{E0020}-\u{E007F}\uFE0E\uFE0F\u20E3]/gu;

/** What the engine takes as it is: ASCII letters and digits, the Latin-1 accented letters (not × or ÷), a plain space, and the punctuation of an ordinary spoken sentence. */
const NOT_SPEAKABLE = /[^A-Za-z0-9\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF.,;:!?'"\-()/%&+=@#$ ]/gu;

const HAS_SOUND = /[A-Za-z0-9\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF]/;

/** Latin letters that have no decomposition into a base letter and a mark, folded by hand. */
const LATIN_EXTRA: Readonly<Record<string, string>> = {
  ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ħ: 'h', Ħ: 'H', ı: 'i', ŧ: 't', Ŧ: 'T', œ: 'oe', Œ: 'OE',
};

/**
 * A character outside the speakable set becomes a space, except a Latin letter beyond Latin-1 (Vietnamese, Polish, Turkish names: "Nguyễn", "Łukasz"),
 * which is folded to its plain letters, so a student's name is still said, in a recognisable way, instead of dropped.
 */
function replacement(ch: string): string {
  if (/^\p{Script=Latin}$/u.test(ch)) {
    const folded = LATIN_EXTRA[ch] ?? ch.normalize('NFKD').replace(/[^A-Za-z]/g, '');
    if (folded) return folded;
  }
  return ' ';
}

/**
 * The sentence as the speech engine should receive it, or '' when nothing speakable is left (only punctuation, an emoji, Chinese text): the caller skips such a sentence.
 * Idempotent: cleaning a clean sentence changes nothing.
 */
export function spokenText(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  let s = text;
  for (const [pattern, to] of SYMBOL_RULES) s = s.replace(pattern, to);
  // Compatibility normalisation AFTER Nora's rules (it would turn U+2033 into two U+2032 and break the seconds rule): fullwidth letters become ASCII, ligatures
  // ("ﬁ") become letters, and decomposed accents are joined, so the accents that follow are the ones the engine knows.
  s = s.normalize('NFKC').replace(/\u2044/g, '/'); // the fraction slash that normalisation leaves in "½" -> "1⁄2"
  s = s.replace(PICTOGRAPHS, ' ');
  s = s.replace(NOT_SPEAKABLE, replacement);
  s = s.replace(/\s+/g, ' ').trim();
  return HAS_SOUND.test(s) ? s : '';
}
