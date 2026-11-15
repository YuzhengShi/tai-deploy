# Is the local voice as natural as the live voices? Protocol (written 2026-11-15, before any clip of this test was rendered)

Asked for by the thesis session on the owner's word of 2026-11-15 ("if you can test the naturalness of the local synthesis, do it in the self-built voice chain session"). Until now the only evidence was his
verdict (`docs/LOCAL_VOICE.md` 9.7, "unnatural and not fluent"), given before the 10 dB level gap (9.13) and its fix were known. This file fixes the design and the reading rules BEFORE a score is seen, so that
the numbers cannot choose the rule. The results are in `docs/LOCAL_VOICE.md` 9.20.

## What this can and cannot say

* A predictor of listener ratings (MOS) judges ONE utterance in isolation. It was trained on ratings of read-aloud synthetic speech. It says nothing about how sentences join in a conversation, and that was
  the owner's main complaint ("every sentence sounds like a new sentence"). So its numbers speak to the voice quality of single sentences, not to conversational flow.
* Flow is therefore covered by (D) a descriptor of the joins, which is not validated against listeners, and (E) a blind listening test, which is the only measure here that can answer for flow.
* Nothing here changes a live setting or deploys anything.

## Voices, all at the Settings' nominal pace 1.2 (the owner's own saved pace is 1.0; the live call and the lab both follow it)

| id | what it is | how it is made |
|---|---|---|
| `flux-hannah` | the live call's conversation voice | Deepgram Flux TTS `flux-hannah-en`, `speed=1.2`, one socket per sentence (per-sentence clips) and all four sentences as four `Speak` plus one `Flush` (whole turn, how chain `cf` speaks) |
| `aura-thalia` | chain `c`'s voice | Aura-2 `aura-2-thalia-en`, `speed=1.2`, one request per sentence, and one request for the whole passage |
| `aura-mars` | the live interviewer's voice | Aura-2 `aura-2-mars-en`, `speed=1.2`, one request per sentence |
| `local-F1` | the deployed local voice | the running container's `/tts`, `voice=F1`, `speed=1.2` (engine speed 1.05 x 1.2), 5 steps; per-sentence clips are played back to back as the lab plays them; also one request for the whole passage; the lab's fixed +9 dB gain with its soft limiter is applied afterwards (the arithmetic of `src/voice/lab/mouth/level.ts`) |

Sensitivity rows for the local voice: no gain; 16 and 24 steps (rendered on the PC by the same `localvoice.tts` code, after checking that it gives the container's clip lengths exactly and its speech level at
5 steps: `render_local_pc.py`); style F2; the engine's natural speed (1.0).

## Texts

`passages.json`: ten passages of four sentences (40 sentences, about 650 words): generic tutoring talk about course topics, nothing from a student. `p0` is the passage of every earlier sample.

## Controls

1. Same text and the same nominal pace for every voice; the words per second that each voice actually speaks at are reported.
2. Level. Every clip is set to the same speech level (RMS of the voiced frames, -16.0 dBFS, the live voice's level of 9.13) with the lab's soft limiter before it is scored: the headline numbers. The as-heard levels
   (Flux and Aura as rendered, the local voice with +9 dB and with no gain) are scored too, as sensitivity rows, so that the predictor's response to level is itself reported.
3. One resampler to 16 kHz (`localvoice.tts.resample`) and leading/trailing silence trimmed to 100 ms for every clip.
4. Every voice varies from run to run: Flux and Aura in pace and prosody (about 2 s per passage, 9.12), the local voice in its waveform (found while rendering: its clip lengths repeat exactly, but the vocoder
   starts from fresh noise, and two renders of one sentence are uncorrelated). So two runs of each, and a sentence's score is the mean of its runs. The local voice's two runs are both the container's; the PC's
   5-step render is a third, used only to check that the PC makes the container's voice.
5. The unit of analysis is the passage (n = 10), not the sentence: sentences of one passage are not independent.

## Measures

* **A. UTMOS22 strong** (`utmos22_strong.onnx`, an ONNX export of the UTokyo-SaruLab system of VoiceMOS 2022, run offline in onnxruntime), on the per-sentence clips (2 to 10 s, the range the export was checked at).
  Paragraph clips are scored too, as an exploratory row (15 to 21 s, outside that range). Needs the owner's OK to download the file; until then these rows stay empty.
* **B. Checks of the predictor, read BEFORE any voice's score:**
  B1. Degradations of Flux clips: a copy band-limited to 8 kHz and a copy with white noise at 20 dB SNR must both score below the clean clip; and a level sweep (-20, -10, 0 dB, +9 dB with the limiter) is
  reported (a flat line means the predictor is blind to level, a slope means a 10 dB handicap would have been counted against the quiet voices).
  B2. The owner's earlier verdicts: the samples `*-s3.wav` and `*-s6.wav` (two sentences in many voices; he rejected Piper and Kokoro and liked LabGPU's voice and Supertonic's F1 to F4 and M1 to M5; F5 he did not
  name, so it is in neither group). The predictor "tracks his ear" if the area under the ROC curve (liked clip scored above rejected clip, pairs formed within one sentence) is at least 0.90; "weakly" from
  0.70 to 0.90; "does not" below 0.70. (Amended before any score existed: the first version of this line said F1 to F5.)
  If B1 fails or B2 gives "does not", the voice scores are still reported but labelled "not credible for this question".
* **C. Intelligibility**: word error rate of the local recognizer (Parakeet-TDT-0.6B-v2 int8, no key-term layer) on the per-sentence clips against the text, numbers and a few compound terms normalized
  (`waitgroup`, `mapreduce`, `dockerfile`). Corpus WER per voice with a bootstrap interval over passages. It also shows which course terms a voice mispronounces. Descriptive; no margin.
* **D. Descriptors of the joins** in the paragraph clips (three joins per passage): the pause at the join, the pitch reset (F0 of the voiced frames just after minus just before, in semitones; numpy YIN), and the
  spread of the pauses inside a clip. Per-sentence clips played back to back have known joins; whole-turn clips are located with the recognizer's token times. A description of what the joins look like, not a
  validated measure of perceived continuity.
* **E. Blind listening test** (a local HTML page and a local server on the PC, no audio leaves it): 3 passages x 5 ways of speaking them (Flux whole turn; Aura per sentence; Aura whole; local per sentence as built;
  local whole) + 2 clips of Piper, the voice he rejected, as a low anchor + 1 repeated clip, in random order with the names hidden, all at the same level. Two 1 to 5 scales per clip: naturalness ("does it sound like
  a real person talking?") and continuity ("does it sound like one continuous speech, or separate sentences put one after another?"). About 5 minutes of audio. The key is kept outside the served folder.

## Reading rule (fixed now)

* **Headline**: UTMOS of `local-F1` (as deployed, level-matched) minus UTMOS of `flux-hannah`, passage by passage (a passage's score is the mean over its four sentences and over the runs); the mean difference with its 95 %
  bootstrap percentile interval (10,000 resamples of the ten passages, `numpy.random.default_rng(1)`). The margin for "comparable" is +/-0.30 UTMOS: a design choice made before any score was seen, not a validated
  just-noticeable difference. The reading: interval inside (-0.30, +0.30) and containing 0 = "no detectable difference"; inside the margin but excluding 0 = "a small difference"; reaching beyond the margin on one side
  or both = "inconclusive at n = 10"; entirely beyond the margin = "a clear difference".
* The same comparison for `aura-thalia` and `aura-mars` against `flux-hannah`; the local sensitivity rows against `local-F1` (no margin; they say what moves the score).
* E: the paired difference per passage (condition minus Flux whole turn) for each scale, mean and bootstrap interval over the 3 passages (very wide: say so), the repeated clip's two ratings (a difference of more than
  1 point means his ratings are not stable enough to interpret), and the anchor's rating (a Piper clip rated as high as the others means the scale was not used as intended).

## Stated limits

1. UTMOS was trained on ratings of read-aloud synthetic and converted speech, mostly of older systems; modern voices tend to bunch near the top of its range.
2. It hears 16 kHz audio: nothing above 8 kHz. The voices are 24 kHz.
3. One clip at a time, no context: the join between sentences and the pace of a conversation are invisible to it.
4. The ONNX file is a third-party export; its author's own check against the original (the `torch.hub` model) is the only evidence of fidelity, unless it is repeated here.
5. Ten passages in one register (a tutor's spoken explanation); one listener unless others take E; a pace of 1.2 where the owner's saved pace is 1.0.
6. The live reference is the Flux service reached directly. 9.12 measured that the live agent's own audio has the same distribution; the live agent's recordings of `p0` (`A1`, `A2` of the earlier samples) are
   scored as a check on that one passage.

## Privacy and cost

No audio leaves the PC: scoring, recognition and the listening test all run locally. What goes to Deepgram is the 40 generic sentences as text, to make the live voices, as the live call does anyway
(`mip_opt_out=true`). The cost of the renders is reported from list prices and the characters sent.

## Amendments made before any score existed

1. B2's "liked" group is F1 to F4 and M1 to M5 (the first version said F1 to F5; he did not name F5).
2. The local voice is not deterministic in its waveform (control 4 above), found when the first renders were compared; the first version said "deterministic: one run".
