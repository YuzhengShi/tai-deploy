### Levels and pace (per-sentence clips, as rendered)

| condition | clips | speech level dBFS | peak dBFS | words/s | seconds per clip |
|---|---|---|---|---|---|
| aura-mars | 80 | -19.5 | -2.9 | 4.09 | 4.2 |
| aura-thalia | 80 | -22.5 | -2.2 | 4.01 | 4.3 |
| flux-hannah | 80 | -16.0 | -1.5 | 3.87 | 4.7 |
| local-F1 | 80 | -26.0 | -6.9 | 3.70 | 4.7 |
| local-F1-speed1.0 | 40 | -26.1 | -6.6 | 3.10 | 5.6 |
| local-F1-steps16 | 40 | -26.0 | -7.4 | 3.69 | 4.7 |
| local-F1-steps24 | 40 | -25.9 | -7.8 | 3.70 | 4.7 |
| local-F1-steps5 | 40 | -25.9 | -5.7 | 3.69 | 4.7 |
| local-F2 | 40 | -24.7 | -5.4 | 4.24 | 4.2 |

### Word error rate of the local recognizer on each voice (per-sentence clips, level-matched)

| condition | words | errors | WER % [95 % interval over passages] | course terms heard |
|---|---|---|---|---|
| aura-mars | 1300 | 33 | 2.5 [1.5, 3.5] | 26 / 30 |
| aura-thalia | 1300 | 17 | 1.3 [0.5, 2.2] | 28 / 30 |
| flux-hannah | 1300 | 21 | 1.6 [0.5, 2.9] | 27 / 30 |
| local-F1 | 1300 | 36 | 2.8 [0.9, 5.6] | 28 / 30 |
| local-F1-speed1.0 | 650 | 14 | 2.2 [0.4, 4.9] | 14 / 15 |
| local-F1-steps16 | 650 | 15 | 2.3 [0.0, 5.4] | 14 / 15 |
| local-F1-steps24 | 650 | 18 | 2.8 [0.9, 5.1] | 14 / 15 |
| local-F1-steps5 | 650 | 18 | 2.8 [0.8, 5.9] | 14 / 15 |
| local-F2 | 650 | 13 | 2.0 [0.2, 4.9] | 13 / 15 |

### The sentence joins of the paragraph clips (descriptors, not a validated measure)

```
condition                  joins  loc. pause med [q1-q3] ms no pause   SD/clip reset med | |med| |p75|
aura-mars-persentence         60    60    100 [  88- 120]           5%      21ms   +6.7 |  6.7 |  8.7 st
aura-thalia-persentence       60    60    115 [ 100- 130]           0%      17ms   +8.0 |  8.0 |  9.6 st
aura-thalia-whole             60    58    290 [ 242- 380]           0%      74ms   +9.1 |  9.1 | 10.8 st
cf-lab                         6     6    305 [ 242- 360]           0%      20ms   +3.2 |  3.2 |  5.0 st
flux-hannah-persentence       60    60    320 [ 258- 382]           0%     114ms   +2.0 |  2.8 |  5.1 st
flux-hannah-whole             60    60    355 [ 298- 718]           0%     191ms   +2.1 |  2.1 |  4.5 st
live-agent                     6     6    260 [ 250- 292]           0%      29ms   +0.6 |  0.6 |  2.1 st
local-F1-persentence          60    60    220 [ 160- 270]           0%      45ms   +6.7 |  6.7 |  7.6 st
local-F1-whole                30    30    470 [ 420- 528]           0%      83ms   +5.5 |  5.5 |  6.9 st
```

### UTMOS22 strong

**B1, Flux hannah, run 1, 40 sentences**

* clean (level-matched): 3.69
* band-limited to 8 kHz sampling: 2.99
* white noise at 20 dB SNR: 2.64
* level -20 dB: 3.72
* level -10 dB: 3.72
* level as rendered: 3.69
* level +9 dB (limited): 3.10
* the check passes: yes

**B2, his earlier verdicts** (liked: LabGPU and Supertonic F1 to F4, M1 to M5; rejected: Kokoro and Piper): AUC 0.99 (tracks his ear); {"s3": {"liked": 10, "rejected": 8, "liked_mean": 4.428110000000001, "rejected_mean": 3.6107375}, "s6": {"liked": 10, "rejected": 8, "liked_mean": 4.41906, "rejected_mean": 3.5834124999999997}}

**Headline: per-sentence UTMOS, level-matched; unit = passage (n = 10); difference to Flux hannah with a 95 % bootstrap interval; margin +/-0.30**

| voice | UTMOS mean [95 % interval] | minus Flux hannah [95 % interval] | reading |
|---|---|---|---|
| flux-hannah | 3.73 [3.69, 3.78] | (reference) | |
| aura-thalia | 4.36 [4.33, 4.38] | +0.62 [+0.58, +0.67] | a clear difference |
| aura-mars | 4.33 [4.31, 4.35] | +0.60 [+0.56, +0.63] | a clear difference |
| local-F1 | 4.38 [4.34, 4.41] | +0.65 [+0.60, +0.70] | a clear difference |

**Sensitivity of the local voice: minus local F1 as deployed (F1, speed 1.2, 5 steps), same unit and interval; no margin and no reading (they say what moves the score)**

| variant | UTMOS mean [95 % interval] | minus local F1 deployed [95 % interval] |
|---|---|---|
| local-F2 | 4.31 [4.26, 4.36] | -0.07 [-0.13, -0.01] |
| local-F1-speed1.0 | 4.42 [4.40, 4.45] | +0.04 [+0.01, +0.08] |
| local-F1-steps16 | 4.39 [4.35, 4.42] | +0.01 [-0.04, +0.05] |
| local-F1-steps24 | 4.39 [4.34, 4.43] | +0.01 [-0.02, +0.05] |

**Level sensitivity (per-sentence, mean over all clips of the condition)**

| condition | as rendered | deployed (+9 dB, limited) | level-matched |
|---|---|---|---|
| flux-hannah | 3.73 | - | 3.73 |
| aura-thalia | 4.36 | - | 4.36 |
| aura-mars | 4.33 | - | 4.33 |
| local-F1 | 4.40 | 4.38 | 4.38 |

**Paragraph clips (exploratory, 15 to 21 s: outside the range the export was checked at), level-matched, mean over passages and runs**

* aura-thalia-whole: 4.43 (n = 20)
* flux-hannah-whole: 3.68 (n = 20)
* local-F1-whole: 4.45 (n = 10)
* A1-live-agent-run1.wav (p0 only): 3.38
* A2-live-agent-run2.wav (p0 only): 3.72
* A3-cf-lab-run1.wav (p0 only): 3.77
* A4-cf-lab-run2.wav (p0 only): 3.77

