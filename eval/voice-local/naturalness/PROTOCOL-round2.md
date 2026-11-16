# Round 2 of the blind listening test: does any setting of the local voice come close? (written 2026-11-16, before the kit was built and before any new clip existed; amended once the same hour after a review, still before any clip)

Round 1 (`docs/LOCAL_VOICE.md` 9.20, `PROTOCOL.md` E) was taken by the owner on 2026-11-15: blind and level-matched, the deployed local voice (Supertonic F1, request speed 1.2, 5 steps) was rated 2.0 of 5 for
naturalness and 2.67 for continuity against 4.0 and 4.33 for the live Flux voice, as low as the Piper clip he had rejected; one request for the whole passage instead of one per sentence changed nothing; the
predictor (UTMOS22) did not track his ratings and is not used here. He asked for another round on the settings of the local voice. Why it matters: Flux TTS is the largest line of the cost of `cf` and `lf`
($1.80 of $2.32 and of $1.93 per call hour, 9.15), and a local voice would also keep the answers' text on the host.

## Design

The same page, the same two scales (naturalness, continuity), the same level (-16 dBFS speech level with the lab's soft limiter), the same blind random order, **three passages not used in round 1** (p2 CAP and
partitions, p5 Kafka, p8 Terraform state). The local clips are the sentences played back to back as the lab plays them (round 1 found no difference to one request for the passage). All at the Settings'
nominal pace 1.2 unless the condition says otherwise.

**Local conditions** (3 passages each):

| condition | what it is | made by |
|---|---|---|
| `local-control` | F1, request speed 1.2, 5 steps: the deployed setting (round 1's local voice) | the deployed container |
| `local-pace1.1` | F1, request speed 1.1, 5 steps | the service's own code on the PC |
| `local-pace1.0` | F1, request speed 1.0 (the engine's natural pace), 5 steps | the deployed container |
| `local-steps24` | F1, request speed 1.2, 24 synthesis steps | the service's own code on the PC |

Style F2 was considered and dropped to keep the session short: it is the least promising lever (all styles share one prosody model) and can be a round 3.

**Context clips** (so that the listener's use of the 1 to 5 scale is not set by a mix of almost only local clips, which would lift the better variants by context alone): `flux-whole` (the live voice, whole turn,
3 passages: the reference), `aura-whole` (Aura-2 thalia, the whole passage in one request, 3 passages), `piper-anchor` (the low anchor of round 1, 2 passages: p2 and p8).

**Two repeats**: (a) one round-1 clip verbatim, byte for byte (the local voice, one request per sentence, on p4: rated 2 and 2 in round 1): the clean measure of drift between the two sessions; (b) one clip of
this round heard twice (`local-control`, p5), at least 6 positions apart in the order: test and retest.

12 local + 3 + 3 + 2 context + 2 repeats = 22 clips, about 6.5 minutes of audio. The PC's renders give the container's clip lengths and speech level (9.20: 40 of 40 sentences, within 0.11 dB at 5, 16 and 24
steps); their waveforms differ run to run, as the container's own do. Words per second of each condition are reported with the result (pace 1.0 is a slower product). No predictor is used.

## Reading rules (fixed now). n = 3 passages and one listener, so no intervals: simple rules

**Naturalness is the primary scale, continuity the secondary** (3 variants x 2 scales, and round 1 showed a retest noise of a full point, so one spurious result is plausible).

* **Improved**: the mean over the three passages of (variant minus `local-control`) is at least +1.0 on naturalness AND no passage is negative. **No detectable change**: the mean's absolute value is below 0.5.
  Anything else: **mixed** (said as such). **Any "improved" stays provisional until it repeats**, on round 1's passages (p1, p4, p7, where the control already has ratings) or in a real call.
* **Close to the live voice**: the variant's mean naturalness is within 0.5 of the Flux reference's mean. From 0.5 to 1.0 below it: **partway** (round 1 measured one request per sentence for Aura-2 at exactly 1.0 below
  Flux and called it a real cost). More than 1.0 below: **far**.
* **Drift**: the round-1 clip heard again: if either rating differs from its round-1 rating (2 and 2) by more than 1.0, round 2 is read within itself only. The control's mean against round 1's local voice
  (2.0 and 2.67) is reported too, but it is on other passages.
* **Retest**: a difference of more than 1 point between the two ratings of the repeated `local-control` p5 clip means his ratings are not stable enough to interpret (it was exactly 1 in round 1).
* **Context**: the Flux, Aura and Piper clips should come out near round 1 (4.0, 4.33, 2.0); if not, say so.
* Continuity is read with the same rules, separately, as the secondary. What would be decided by a result is not decided here: no deployment, no setting changed.

## What it cannot say

One listener who is the developer and knows these voices; three passages; whether students agree; other styles than F1, other engines (Kokoro and Piper were rejected at sentence level and Piper was rated 2.0 at
passage level in round 1); real conversation (latency, barge-in, the model's own pauses). A setting that is "close" here would still need a call to be judged in use.
