# Commit map

Before this version was published in November 2026, the history from 2026-04-02 on was prepared for publication:

- **Replaced throughout.** A person's name, internal host details and one e-mail address were replaced in every file and message. For example, the voice lab's GPU machine is called LabGPU here.
- **Removed.** Files that should not have been public were removed from every commit, together with a compiled Python cache file.
- **Unified.** Commit e-mail addresses were changed to the author's GitHub no-reply address.

**What stayed the same.** Author dates, committer dates, messages (apart from the replacements) and the number of commits are unchanged. In particular, the commits that froze test sets and protocols before their measurements keep their original dates.

**Old ids in documents.** Commit ids written in documents before this (in `docs/`, `eval/` and the weak-model records) refer to the old history. The table below gives the published id for:

- every commit that had never been published before;
- the one older commit that the documents cite (`eval/RESULTS.md` names it as the base of the fall evaluation).

The commit that merges the tool-host fix into the voice-lab line was made for this release and has no old id.

**Note for operators.** A few names in code and settings differ from the ones on the course's host. For example, the voice lab's settings for the GPU machine use `LABGPU` here. The live system is therefore not deployed from this history.

| Old id | Published id | Date | Subject |
|---|---|---|---|
| `02dd2d5` | `fe6e7f0` | 2026-05-27 | docs: update TAi-Capabilities.md with current state |
| `f6e7740` | `3bab145` | 2026-11-01 | feat: web channel, env-selected channels, gateway settings for the agent container |
| `0d52b11` | `784aba1` | 2026-11-01 | fix: PreToolUse hooks deny through permissionDecision |
| `f477103` | `80e69ec` | 2026-11-01 | fix: pin mcp[cli]<2 in the agent image |
| `e57ecd8` | `bb841cf` | 2026-11-01 | feat: GitHub public base URL setting and a BM25 stand-in for the LeanRAG index |
| `ae3c882` | `f93bb8f` | 2026-11-01 | test: eval harness for qwen vs gpt-oss, hooks, resume and scheduling |
| `4014747` | `d6ccead` | 2026-11-01 | test: guard runs compare upstream with the repository's current source |
| `6f2f4b2` | `98f30a9` | 2026-11-01 | feat: run the precompiled agent runner, TAI_COMPILE_ON_START for development |
| `14583a5` | `c09cc50` | 2026-11-01 | fix: harden the agent's tool guards, with unit tests |
| `3db55fa` | `8476a79` | 2026-11-01 | fix: normal replies go through the same outbound filter as send_message |
| `8accab5` | `6358518` | 2026-11-01 | fix: the agent runner tells students what went wrong, retires sessions, keeps the interaction summary |
| `40841fb` | `c3579f4` | 2026-11-01 | fix: shorter default idle and hard timeouts |
| `73dfb7b` | `bfafb1c` | 2026-11-01 | test: harness measures the fixes (session cap, API failures, precompiled start) and survives a busy box |
| `2ad2cb1` | `de8c657` | 2026-11-01 | test: repair the 42 unit tests that no longer matched the code |
| `8d55c60` | `e1863f1` | 2026-11-01 | feat: the gateway backs qwen up with gpt-oss and keeps TAi inside its share of the qwen bucket |
| `4e4ee9a` | `d5cfb47` | 2026-11-01 | fix: the interaction summary records each answer against the message it answers |
| `746255b` | `1c5a292` | 2026-11-01 | docs: the settings this fork added and the tool guards |
| `a10263b` | `6a2c638` | 2026-11-01 | test: harness waits for the orchestrator, resets the container timeout, can stop a run |
| `d829646` | `35e28fa` | 2026-11-01 | test: results after the fixes; image rebuild, inspect and fresh folders for resume.py |
| `3bd25be` | `2b76153` | 2026-11-01 | test: replay the outbound filter over real replies, one real-model pass, diag latest |
| `6bea244` | `96cf5a7` | 2026-11-06 | feat: student portal, voice and mock interview from the week's evidence, access rules |
| `eda516c` | `c3418ca` | 2026-11-06 | feat: operator tooling for the live host, the gateway aliases and the evaluation harness |
| `d298037` | `0514070` | 2026-11-06 | docs: portal, voice, vision, weekly brief, access rules and patrol, as deployed |
| `7a417b4` | `ecc1ee4` | 2026-11-06 | fix: tighten a student's task limits to a 6-hour gap, 6 open tasks and 12 a day |
| `a5ee859` | `acea7b6` | 2026-11-13 | snapshot: the working tree of D:\tai-deploy as of 2026-11-13 (the live system, uncommitted until now) |
| `2e979d6` | `134a39e` | 2026-11-13 | docs: the voice lab's design and pass/fail criteria, written before any lab measurement |
| `24778c7` | `4633a3b` | 2026-11-13 | feat: the voice lab's stand-in for Deepgram's agent protocol, its parts and tests (behind TAI_VOICE_LAB, of... |
| `8c2712a` | `8b118c5` | 2026-11-13 | fix: the lab's first sentence of an answer goes out as soon as it is complete (a short opener no longer wai... |
| `bae53ae` | `e876ec4` | 2026-11-13 | docs: the lab's own ears and mouth classes against the real services (probe numbers, section 10.2) |
| `751b5b7` | `49265f5` | 2026-11-13 | docs: what C6's result does to the verdict, a name correction (A2) and the exploratory accent question Q1,... |
| `b4f39c1` | `8cc83de` | 2026-11-13 | feat: the voice lab's measuring client (run, interleave, analyze) with its tests; A3 and A4 of the criteria... |
| `77d4a8e` | `bcca3cb` | 2026-11-13 | docs: build status and the deploy plan of the voice lab (release tree without the LeanRAG work, measurement... |
| `2db7c33` | `6e98c5b` | 2026-11-13 | feat: the lab's trace records every model request of a turn and the engine's part of the function round tri... |
| `712920c` | `6a69a76` | 2026-11-13 | fix: the lab's trace sink writes in the order of the turns (synchronous append) and the lab test waits for... |
| `6edfb32` | `1f23655` | 2026-11-13 | test: generous waits and a 30 s test limit for the lab's real-time tests (a busy machine made two of them f... |
| `a3f128e` | `dd500e5` | 2026-11-13 | test: the two long barge-in tests may take a minute on a busy machine |
| `2d8f695` | `bb6b5bf` | 2026-11-14 | docs: final test counts, the flakes found under load, and the release check at the last head |
| `6cebb89` | `1de6d7f` | 2026-11-14 | docs: the deploy log of the voice lab (deployed 2026-11-14 07:10 UTC from the release tree, lab on, measure... |
| `17d3588` | `4b21817` | 2026-11-14 | docs: deploy log, the daily minutes put back to 45 |
| `b4a69e7` | `3bdf5de` | 2026-11-14 | fix: a filler said while a function runs no longer comes between the call and its reply (the lab's first ca... |
| `e1ddaf0` | `b745964` | 2026-11-14 | docs: the first calls on the lab (the owner's, the test identity's), A7 |
| `6b12687` | `f16131e` | 2026-11-14 | test: the measuring client's pacing check allows float rounding (-2e-13 failed it twice) |
| `3ba6c90` | `85de1bf` | 2026-11-14 | docs: deploy log, the test identity, the second deploy, the slow tool host spawn |
| `919b725` | `265e848` | 2026-11-14 | fix: 'so' and 'not' after think, guess, hope... end a finished answer ('I think so.' was held 1.8 s); A7 ex... |
| `23b26da` | `16f094e` | 2026-11-14 | docs: third deploy, the evaluation configuration frozen, the sessions begin |
| `e08fda6` | `456f722` | 2026-11-14 | docs: the evaluation's results (C0, C1, C2, C3, C10, C5 from the trace), why C1 and C3 miss, the provisiona... |
| `5b19234` | `8b6f8b1` | 2026-11-14 | docs: deploy log, the sessions' end, the daily minutes restored, what is left on the host |
| `8a16904` | `82761a5` | 2026-11-14 | feat: the eager end of turn asks the model early (chains d, h, fd, c), a windowed barge-in rule on the engi... |
| `882691a` | `9b34c0a` | 2026-11-14 | docs: round 2 written down before any number: the re-examination of 9.6 (A8), the correction of why C1 fail... |
| `7070db2` | `1e25d89` | 2026-11-14 | feat: C4 report (the client's raw logs and the lab's trace); tool prompts that read no student-written cont... |
| `f298452` | `69201a1` | 2026-11-14 | test: the fake's field is called confidence |
| `1821226` | `f0611fb` | 2026-11-14 | docs: A9 wording |
| `7c4e5bd` | `c3c9d1b` | 2026-11-14 | docs: A12a, FD in the turn-taking regression, where the minutes come from, the order of C6b and the window |
| `f8dad48` | `c1ae6ad` | 2026-11-14 | docs: the chain parameter and the eager request in the security notes and the voice settings table |
| `0a3cfc5` | `7e9bf5c` | 2026-11-14 | docs: escape the pipes in the table cells |
| `ed5d92d` | `3e202d0` | 2026-11-14 | feat: the measuring client plays the tools set, interleaves up to five chains, and takes ?chain= on the lab... |
| `21fc131` | `fd92118` | 2026-11-14 | feat: the second recognition set (64 sentences, 136 key-term instances per voice pass) and its runner and c... |
| `0f916e9` | `f66b5a1` | 2026-11-14 | docs: 10.8, what round 2 built and checked before any call, the probes, and the key that was printed |
| `b3f4214` | `dc9a63f` | 2026-11-14 | docs: C6b results (LabGPU's recognizer is worse than Flux's on the larger set: recall -12.9 points, WER +2.... |
| `4834a95` | `2f12561` | 2026-11-14 | docs: two statements of the C6b text made exact |
| `0c1a31f` | `bb06f0a` | 2026-11-14 | docs: A12b, the owner chose the short measurement: the turn-taking regression is dropped, what that costs,... |
| `7ab15a0` | `30b7057` | 2026-11-14 | docs: A12c (the owner's stated reason: free and data inside; how the window is read; the Nora overlap sampl... |
| `9b2f99f` | `515762f` | 2026-11-14 | docs: A12d, a fourth latency round by a rule (L ended three rounds with 29 plain turns against the minimum... |
| `8122495` | `fd54d64` | 2026-11-14 | docs: A12e, the owner's answer (data staying inside is only a preference, FD is the candidate, D an option,... |
| `65d2f3e` | `0fc3a70` | 2026-11-14 | docs: A13, the trial of local ears and mouth on our own CPU (candidates, the two stages, the criteria, writ... |
| `d21eed5` | `5bc51dc` | 2026-11-14 | feat: stage 1 of the local ears trial (recognizer runner in the C6b results format, spoken forms of the liv... |
| `e382871` | `f479045` | 2026-11-14 | docs: A13b (hotword score 3 chosen on set 1 by the rule of A13a; the bpe vocabulary fix), before any set-2 run |
| `db94e68` | `e3d1bd9` | 2026-11-14 | docs: 10.10 (round 2 window results: C1, C3, C4, C12, incidents, the verdict by component) and 10.11 (local... |
| `0486425` | `7917fcc` | 2026-11-14 | feat: the third recognition set (80 sentences, 137 key-term instances per voice pass), written before any r... |
| `7c47e50` | `880c3b7` | 2026-11-14 | docs: 10.12 (local trial stage 2: set 3 confirms the layered Parakeet against Flux's clause and beats LabGP... |
| `7181895` | `2e3a3a3` | 2026-11-14 | docs: 10.13 (Supertonic, the engine behind LabGPU's mouth, on our own CPU: files, which style is LabGPU's,... |
| `241d304` | `e6aedd5` | 2026-11-14 | feat: the local voice service (LabGPU's /v1/listen and POST /tts on one loopback port, Parakeet ears + Supe... |
| `8d0f2ce` | `8f3bcf6` | 2026-11-14 | docs: A14 (what the host check of the local service measures and which instant counts, written before any h... |
| `cd3de61` | `7c3e99d` | 2026-11-14 | feat: the local voice service on the host (A14 results, 10.14), onnxruntime's telemetry switched off and cu... |
| `c3aa542` | `1918cad` | 2026-11-14 | docs: the deployment plan builds from the branch head (never the scratch tag), the URL settings are global... |
| `9ee2c20` | `c46d721` | 2026-11-14 | docs: the local voice service deployed on the owner's 部署 (9.6: rollback material, models, image from c3aa54... |
| `10acbac` | `a774445` | 2026-11-14 | docs: 9.7 the owner's first calls on the local chain (his verdict: not natural, not fluent, slow), fallback... |
| `794dd18` | `c36b90f` | 2026-11-14 | docs: the post-midnight synthetic call was refused by the budget (the voice day is Pacific, not UTC); the o... |
| `581c973` | `6b56180` | 2026-11-14 | docs: the live call's voice is Flux TTS (flux-hannah-en, streamed as one turn), the lab's control chain c s... |
| `b0b48aa` | `230220d` | 2026-11-14 | voice lab: a Flux TTS mouth that speaks an answer as one continuous speech (chain cf), and a recognizer wat... |
| `8765a76` | `79ed1d2` | 2026-11-14 | agent container: switch ONNX Runtime's telemetry off (ORT_DISABLE_TELEMETRY=1) |
| `d86356f` | `624aa23` | 2026-11-14 | voice lab: the recognizer watchdog needs wall time AND speech (a review of the first rework found it blind... |
| `44161ec` | `0517615` | 2026-11-14 | docs: the Flux mouth, the watchdog rework and the container telemetry line are deployed (docs/LOCAL_VOICE.m... |
| `2642c1a` | `63a5c37` | 2026-11-14 | voice lab: the local voice at the engine's own speed (no time-stretch) and no fixed-line warm-up for it; th... |
| `4b16af3` | `01bc60c` | 2026-11-14 | voice lab: a test of chain cf through the whole hub (Flux ears decide, the answer goes through the Flux mou... |
| `98ef832` | `aecb3bb` | 2026-11-14 | voice lab: a fixed gain with a soft limiter for the local voice (it is 10 dB below the live level), and whe... |
| `5d5e286` | `b79150b` | 2026-11-14 | voice lab: chain lf, the live call's voice with the student's audio kept on the host (docs 9.14, A19) |
| `b2f9a69` | `62b7433` | 2026-11-14 | docs: the level finding checked against the page, the samples made with the shipped processing, the latency... |
| `b934bfd` | `74dc397` | 2026-11-14 | voice lab: Flux TTS follows the Settings' expressivity (the live call's second knob, in the socket's addres... |
| `a732946` | `3752bb0` | 2026-11-14 | docs: cf against lf put against cf (lf saves only the listening line), and his verdict of 11-14 was on lf's... |
| `f1ae46d` | `1ff6446` | 2026-11-14 | docs: the lf deploy of 2026-11-15 05:03 UTC on the owner's word, what was checked before and after, and whe... |
| `c030b8d` | `e331365` | 2026-11-14 | voice lab: the Flux mouth's watchdog no longer fails a speech opened after an idle socket, and a pace saved... |
| `ca3fc52` | `8825f60` | 2026-11-14 | voice lab: the interviewer's pace test looks at the three answers only (the mouth's fixed lines are in its... |
| `a6f3ddf` | `f8e3704` | 2026-11-14 | docs: his lf call, the pace that counts from the next call, the false stall of the Flux mouth and the live... |
| `5a9fa3d` | `c961760` | 2026-11-15 | voice lab: the local recognizer's segment decode no longer waits for an interim decode, and a clause that e... |
| `8287246` | `dedbd75` | 2026-11-15 | docs: his third lf call, the CPU quota that throttled the local recognizer, the turn rule and the interim d... |
| `2057900` | `7953823` | 2026-11-15 | docs: correct the cut-in reading of his third lf call (turns after a cut waited as long as the others; thre... |
| `a90123a` | `863f780` | 2026-11-15 | docs: the container and the turn rule deployed on the owner's word (9.19, A22 addendum) |
| `64644be` | `c61a1ed` | 2026-11-15 | fix: a tool host gets 60 s to say ready, and says what a slow start printed |
| `e500eec` | `b75240e` | 2026-11-15 | eval: protocol and texts of the local voice's naturalness test, written before any clip is rendered |
| `c34d829` | `752ea8a` | 2026-11-15 | eval: scripts of the local voice's naturalness test; protocol amended before any score existed |
| `91c84e1` | `08350c7` | 2026-11-15 | docs: is the local voice as natural as the live voices? the measured comparison (9.20), with its scripts an... |
| `2680a66` | `867ec70` | 2026-11-15 | docs: 9.20 says what its predictor check does not cover, and reads the sensitivity rows as the protocol fix... |
| `e618397` | `a6bd64b` | 2026-11-15 | docs: the owner's blind listening test (9.20): the local voice 2.0 of 5 against 4.0 for the live voice, and... |
| `80c7b14` | `f327fc7` | 2026-11-15 | eval: protocol of round 2 of the blind listening test (settings of the local voice), written before the kit... |
| `28f95bd` | `9c1b1dd` | 2026-11-15 | eval: round 2 of the blind listening test: kit builder, the analysis of the pre-registered rules, a repeate... |
| `08bb3f7` | `f16a889` | 2026-11-15 | docs: round 2 of the blind listening test (9.20): none of three settings of the local voice closes the gap |
| `625de83` | `775fa73` | 2026-11-15 | eval: protocol of round 3 of the blind listening test (Kokoro), written before the kit and before any Kokor... |
| `599c375` | `48852d8` | 2026-11-15 | eval: round 3, amendment 1: sherpa-onnx's English front end is espeak-ng, the lexicon files take no part, s... |
| `51c1a15` | `adadc9d` | 2026-11-15 | eval: round 3, amendment 2: the engine drops the unstressed -er phoneme and compresses every silence to a f... |
| `6856f8b` | `aaf2e1c` | 2026-11-15 | eval: round 3: the direct Kokoro runner's calibration (speeds, joins), the recognizer's check, the kit buil... |
| `9df62da` | `24f1a1a` | 2026-11-15 | docs: 9.21 (rating-independent half): sherpa-onnx's Kokoro path drops the unstressed -er phoneme and compre... |
| `45f02aa` | `8de1cbe` | 2026-11-15 | eval + docs: round 3 result: blind, level-matched, rate-matched Kokoro (all three English voices, engine de... |
| `0e4eb72` | `c9f5af1` | 2026-11-15 | docs: 9.21 wording after review: the verdict rests on the repaired conditions, not on the context clip; "2.... |
