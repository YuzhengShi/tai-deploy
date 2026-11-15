/**
 * `applyGain`: a fixed gain on 16-bit little-endian mono PCM, with a soft limiter, for a mouth whose own level is far below the live voice's.
 *
 * WHY: measured on the same four sentences (2026-11-15, docs/LOCAL_VOICE.md 9.13), the speech of the live agent and of Flux TTS (which normalizes its volume) sits at about -16 dBFS RMS with
 * peaks at -1.5 dBFS; Aura-2 at -21 to -22 dBFS (5 to 6 dB lower), the local Supertonic voice at -26 dBFS with peaks at -8 dBFS (10 dB lower). A quieter voice sounds thinner and less present,
 * and in any comparison by ear the louder one wins: the voices of chains c and the local one were being judged against the live voice at a disadvantage that has nothing to do with how they say things.
 *
 * A FIXED gain (not a level measured sentence by sentence, which would make a short quiet "Okay." as loud as a long sentence): it is the same for every chunk, so it works on the stream as it arrives. Above
 * 75 % of full scale the signal is compressed by a tanh knee towards a ceiling of 89 % (-1 dBFS), so the few peaks of a boosted voice are rounded, never clipped. Pure: no I/O, no state. A gain of 0 returns the
 * buffer itself.
 */
const KNEE = 0.75 * 32768;
const CEILING = Math.floor(0.89 * 32768); // 29163: a whole number, so that the rounded output never exceeds it
const ROOM = CEILING - KNEE;

export function applyGain(pcm: Buffer, db: number): Buffer {
  if (!Number.isFinite(db) || db === 0 || pcm.length < 2) return pcm;
  const gain = 10 ** (db / 20);
  const out = Buffer.allocUnsafe(pcm.length);
  const whole = pcm.length & ~1;
  for (let i = 0; i < whole; i += 2) {
    let y = pcm.readInt16LE(i) * gain;
    const a = Math.abs(y);
    if (a > KNEE) y = Math.sign(y) * (KNEE + ROOM * Math.tanh((a - KNEE) / ROOM));
    out.writeInt16LE(Math.round(y), i);
  }
  if (whole < pcm.length) out[whole] = pcm[whole]; // an odd last byte is not a sample: passed through (the mouths hand over whole samples)
  return out;
}
