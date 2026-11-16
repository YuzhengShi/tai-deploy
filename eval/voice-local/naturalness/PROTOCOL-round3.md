# Round 3 of the blind listening test: is Kokoro, the one local engine already on this PC, as natural as the live voice? (written 2026-11-16, before the kit was built and before any Kokoro clip of this round existed; amended once, see the end, before any render)

Round 1 and round 2 (`docs/LOCAL_VOICE.md` 9.20, `PROTOCOL.md` E, `PROTOCOL-round2.md`) were taken by the owner on 2026-11-15: blind and level-matched, the deployed local voice (Supertonic F1, request speed 1.2,
5 steps) was rated 2.0 and 2.33 of 5 for naturalness against 4.0 for the live Flux voice, and no tested setting of it (pace 1.1 and 1.0, 24 synthesis steps) met the pre-written rule for "improved". Piper was
rated 2.0 and 1.0. The one local engine left on this PC that needs no download is **Kokoro** (int8 multi-lang v1.1 through sherpa-onnx 1.13.8, the files of A13, `docs/VOICE_SELFBUILT.md` 10.11 and 10.12). The
owner heard it once, before any blind or level-matched test: two single sentences per voice at two speeds, not level-matched, next to Piper and LabGPU's voice, and answered "Piper, Kokoro: neither will do".
A13's second stage had also measured it on the host's CPU as too slow: first audio of a sentence p50 2448 ms (three streams at once: 3004 ms), real-time factor 0.78 to 0.89 (0.93 to 1.15 with three at once),
"not met: dropped".

So this round answers one question only, by his ears and under the conditions of the first two rounds: **in passage context, blind and level-matched, is Kokoro natural?** If it is near the live voice, the
remaining problem is speed: the host's CPU cannot run it in real time as it is, and faster hardware or another build would be a separate decision. If it is not, the engines that need no download are used up.

## Design

The same page, the same two scales (naturalness, continuity), the same level (-16 dBFS speech level with the lab's soft limiter), the same blind random order, **three passages used in neither earlier round**
(p3 MapReduce failures, p6 load testing, p9 idempotent retries; the owner has not heard them). A local clip is the passage's sentences played back to back as the lab plays them to the local mouth: one request
per sentence.

**Conditions** (3 passages each):

| condition | what it is | made by |
|---|---|---|
| `kokoro-maple` | Kokoro int8 multi-lang v1.1, voice `af_maple`, US lexicon | sherpa-onnx on the PC |
| `kokoro-sol` | the same engine, voice `af_sol`, US lexicon | the same |
| `kokoro-vale-us` | the same engine, voice `bf_vale` (a British voice), US lexicon | the same |
| `kokoro-vale-gb` | the same engine, voice `bf_vale`, British lexicon | the same, its own engine instance |
| `local-control` | Supertonic F1, request speed 1.2, 5 steps: the deployed setting, the control of round 2 | the deployed container (the bank's first run) |

These are all the English voices the model has (speakers 0, 1 and 2 by sherpa-onnx's page for the model and its pull request 1942). **Why `bf_vale` twice:** every sherpa-onnx example for this model passes the US lexicon
(`lexicon-us-en.txt`) for every voice, and so did A13, but the model folder also ships `lexicon-gb-en.txt`, which the documentation never mentions, so which lexicon is right for a British voice is not documented
and a row that used the wrong one would be unfair to the voice. Before the kit, the engines' debug token sequences for the twelve sentences are compared under the two lexicons; if they are identical, the second
condition would be the same clip and is dropped.

**Context clips**, as in round 2, so that the listener's use of the scale is not set by a mix of almost only local clips: `flux-whole` (the live voice, whole turn, 3 passages: the reference) and `piper-anchor`
(the low anchor, 2 passages: p6, p9). Aura-2 is left out this round: no rule reads it and every clip costs him time.

**Kokoro's speed, decided now by a rule that does not use his ears.** The target is the live voice's mean speaking rate on the three passages (words per second from the first to the last voiced frame, pauses
inside the passage included: the measure of round 2), measured on the bank's Flux clips. For each Kokoro condition separately, and in this order, the join rule below is applied BEFORE the rate is measured, so that
padding the rule removes does not push the speed up: (1) render the three passages at request speed 1.0 and decide the join treatment; (2) render at 1.2 with the same treatment; (3) interpolate linearly between
the two rates to the target (rounded to 0.01, between 0.8 and 1.5); (4) render at that speed; if its mean rate is within 0.10 words per second of the target it is used; if not, one more interpolation step from the
two nearest points and that render is used whatever its rate (the rate is reported). No render of this procedure is listened to by anyone. In round 2 the rates 2.85 to 3.40 words per second moved the local voice's
naturalness by at most 0.67, inside the noise of one rating (about a point), so a rate-matched voice is the fair comparison and not a tuned one.

**Silence at the sentence edges** (two-sided, decided per condition at speed 1.0 and kept at every speed). The join silence of two consecutive sentence clips is the trailing silence of the first plus the leading
silence of the second (10 ms frames not voiced by the rule of `nat_lib.voiced_mask`); its median over the nine joins (three per passage) is compared with the control's, taken from the deployed container's clips
(by 9.20's descriptor the control's pause at a join is 220 ms and the live voice's 320 to 355 ms, so the control is not an extreme). Within 150 ms of the control's median: the clips are played as the engine makes
them. More than 150 ms away in either direction: every sentence clip of that condition gets a leading and a trailing silence of exactly half the control's median join (longer edges are cut, shorter ones padded
with digital silence), so that every join equals the control's median and an engine's padding is not read as its voice.

**Two repeats**: (a) one round-2 clip verbatim, byte for byte (`local-control` on p8, rated 2 and 3 in round 2): the measure of drift between the sessions; (b) one clip of this round heard twice (`kokoro-maple`,
p6; the identical samples), at least 6 positions apart in the order: test and retest.

12 Kokoro + 3 control + 3 Flux + 2 Piper + 2 repeats = 22 clips, about 7 minutes of audio. No predictor is used (9.20: the one tried does not track his ratings).

**Before the kit, without ears:** Parakeet-TDT-0.6B-v2 is run on every Kokoro render, so that a technical word that every Kokoro voice reads wrongly (MapReduce, idempotent, pings) is known before he rates and is
reported beside his ratings; the passages stay as fixed.

## Reading rules (fixed now). n = 3 passages and one listener, so no intervals: simple rules

**Naturalness is the primary scale, continuity the secondary.**

1. **Against the deployed voice**, per Kokoro condition: the mean over the three passages of (condition minus `local-control`) on naturalness. **Better**: at least +1.0 and no passage negative. **Worse**: at
   most -1.0 and no passage positive. **No detectable difference**: absolute value below 0.5. Anything else: **mixed**.
2. **Against the live voice**: the gap is the Flux mean minus the condition's mean. A gap of at most 0.5, **a negative gap (Kokoro above Flux) included**: **close**. Above 0.5 and at most 1.0: **partway** (round 1
   measured one request per sentence for Aura-2 at 1.0 below Flux and called it a real cost). More than 1.0: **far**.
3. **Kokoro as a whole** is the best of the Kokoro conditions by mean naturalness (ties by continuity), reported as such with the others beside it. A best-of-four is biased upward by chance: at the retest
   noise of rounds 1 and 2 (about half a point per rating, a third of a point per three-passage mean) by roughly a quarter to a third of a point. So any "close" or "better" stays **provisional until it
   repeats** (a second session on other passages, or a real call).
4. **Drift**: the round-2 clip heard again: if either rating differs from its round-2 rating (2 and 3) by more than 1.0, this round is read within itself only. **Retest**: a difference of more than 1 point
   between the two ratings of the repeated `kokoro-maple` p6 clip means his ratings are not stable enough to interpret. **Context**: the Flux and Piper clips should come out near round 2 (4.0 and 1.0): if not,
   say so. The repeats are left out of every condition mean.
5. Continuity is read with the same rules, separately.
6. A result decides nothing here: no deployment, no setting changed, no download. "Close" or "better" means the speed problem is worth a design; "far" means the engines that need no download are used up.

## Reported with the result (no ears)

Words per second of each condition and the speeds chosen; the join check and treatment of each condition; the word error rate of Parakeet on the clips (the normaliser of round 1) and the words misread;
Kokoro's synthesis speed on this PC (four threads) beside A13's host figures above, which a good result would still have to beat before any deployment.

## What it cannot say

One listener who is the developer and knows these voices; three passages; whether students agree; the int8 build only (the full-precision build was not run), the three English voices of release 1.1 only (other
releases and voices are downloads and need his word), sherpa-onnx's own text front end with the two lexicons it ships only; real conversation (latency, barge-in, the model's own pauses); speed on the host (A13
measured it; this round does not).

## Amendment 1 (2026-11-16, before any render of this round; found by the front-end check the protocol asks for)

The check (the engine's own debug output for one sentence of p3, decoded with the model's `tokens.txt`) found that **the lexicon files take no part in English in sherpa-onnx 1.13.8**: the token sequences
under `lexicon-us-en.txt` and under `lexicon-gb-en.txt` are identical, and they are espeak-ng's IPA for the sentence (the model's metadata: `has_espeak=1`, `voice=en-us`). The English front end is espeak-ng
with the voice the model names (en-us) or the one the config's `lang` option names. So the two `bf_vale` conditions are redefined, and nothing else changes:

* `kokoro-vale-us`: voice `bf_vale`, the default front end (espeak-ng voice `en-us`): what A13 and the documentation's examples run.
* `kokoro-vale-gb`: voice `bf_vale`, `lang='en'`: espeak-ng's own British English voice (in the data file shipped with the model: `name English (Great Britain)`, `language en-gb`). The name `en-gb` fails in
  this build ("Failed to set eSpeak-ng voice"); `en-GB-x-rp` (Received Pronunciation) works and was the other candidate. `en` is chosen because it is the voice espeak-ng itself calls en-gb, not by ear. The decoded
  phonemes differ from en-us (for example `bɪkˈɒz`, `ɹɪdjˈuːs` against `bɪkˈʌz`, `ɹᵻdˈuːs`), so the two are different clips; the same check on all twelve sentences is repeated after the render and reported.
* The paragraph "Why `bf_vale` twice" and the lexicon check in it are superseded by this. The lexicon is not a variable of this round.

What the check also shows, to be said with the result: the model is fed espeak-ng's IPA and not the Misaki phonemes it was trained with (a diphthong arrives as two symbols, `eɪ`, where Misaki writes one, `A`).
A front end that gives it Misaki's phonemes needs a download and his word and was not built; if a Kokoro condition comes out "partway" or "close", it is the first thing to try.
