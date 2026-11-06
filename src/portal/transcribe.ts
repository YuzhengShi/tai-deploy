/**
 * A voice note, turned into text: one recording from the page's microphone button, sent to Deepgram's pre-recorded endpoint. This file
 * only turns it into words and keeps nothing; the recording itself is kept by the page's media store (src/portal/media.ts) so the student
 * can play it back in the conversation. Deepgram is asked not to keep it for model improvement (`mip_opt_out`), which matters because this
 * is a student's voice.
 */
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export type Transcriber = (audio: Buffer, mime: string) => Promise<string>;

const ENDPOINT = 'https://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true&mip_opt_out=true';

/** A transcriber that reads the key when it is used (so a key typed after the start counts), or null when voice is switched off. */
export function deepgramTranscriber(env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Transcriber | null {
  if (env.TAI_VOICE_NOTES === '0') return null;
  return async (audio, mime) => {
    const key = readEnvFile(['DEEPGRAM_API_KEY']).DEEPGRAM_API_KEY || env.DEEPGRAM_API_KEY;
    if (!key) throw Object.assign(new Error('no key'), { status: 503 });
    const type = /^audio\/[a-z0-9.+-]+/i.exec(mime)?.[0] || 'audio/webm';
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': type },
      body: audio,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'voice note: Deepgram refused');
      throw Object.assign(new Error('transcription failed'), { status: 502 });
    }
    const data = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
    return (data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
  };
}
