# Weak-model experiment

**The question.** In TAi, three decisions belong to host code: the timing of writes to the student record, whether a given patrol involves the model, and the limits on what each student can look up. Talking with the student and judging answers are left to the model. This experiment asked how much of TAi still works when **a much weaker model sits behind every model call**. In particular, do the functions that host code carries still reach the student?

**The answer, by the rules.** There were two rounds, both in November 2026, judged by rules fixed before any counted run. **Neither round produced a verdict**: by those rules both were inconclusive, because the weaker model never trailed far enough on the model-dependent checks. The thesis discusses the experiment in Section 5.1.

**The records.** The three records below are the experiment's original documents. They are written in Chinese and published unchanged. This README summarizes them in English; where the two disagree, trust the records.

| Record | Contents |
|---|---|
| [`weak-model-criteria.md`](weak-model-criteria.md) | The pre-registered criteria; amendments A1 and A2 are in its section 10 |
| [`weak-model-results.md`](weak-model-results.md) | Results of round 1 (amendment A1), written on 2026-11-16 |
| [`weak-model-results-r2.md`](weak-model-results-r2.md) | Results of round 2 (amendment A2), written on 2026-11-17 |

## The claim and the design

The planning notes label the claim under test C2: most of what TAi does as a teaching assistant is done by code outside the model. A plain comparison of overall pass rates cannot test that. Deterministic code passes with any model, so such a comparison would come out in favor of the claim no matter what. The criteria therefore judge only two things:

1. **Manipulation check.** Did swapping in the other model actually make the model-dependent checks worse?
2. **Five system-carried functions.** For each one, scored end to end: did it still get to the student?

| | System-carried function |
|---|---|
| F1 | The student is told what is due and when |
| F2 | The student is told their own grade |
| F3 | After the container restarts, TAi still recalls where the student was stuck |
| F4 | The record writer updates the student record from the exchange |
| F5 | The student's program is run and its real output reported |

**Setup.**

- **System.** A copy of the code then running live, unchanged for round 1. See [Code version](#code-version).
- **Model calls.** Every call got the substitute model: conversation, patrol, record writer and state writer.
- **Students.** Synthetic, sending scripted messages.
- **Course systems.** Canvas and GitHub were replaced by stand-ins.
- **Not covered.** Voice, image viewing, quiz-option clicks and the student page.

## Rules fixed in advance

**Freezing.** The criteria were complete before any counted run; they were frozen on 2026-11-15 at 22:00 UTC. The file's sha256 was noted at each stage:

| Stage | sha256 |
|---|---|
| Frozen | `d6dfa56e…` |
| After A1 | `4a4b3cbf…` |
| After A2 (the file published here) | `6e47136f…` |

**Amendments.** After the freeze, changes could only be appended to section 10, and only before a round's first counted run. Neither A1 (for round 1) nor A2 (for round 2) touched round 1's categories, thresholds or regular expressions.

**Kinds of check.** Before any run, every check was put into one of four kinds:

| Kind | Covers | Role in the decision |
|---|---|---|
| Model checks | Anything the model produces: wording, length, refusals, its judgments of answers, whether it calls a particular tool | Pooled for the manipulation check |
| Code checks | Things code settles regardless of the model's output: outbound filtering, refusing unauthorized calls, the patrol gate | Matter only if the weak group fails them, which would reveal a hidden reliance on the model |
| System-carried functions | F1 to F5; a delivery needs the call, a correct result, and the student actually being told | Judged in the second step |
| Legacy checks | Three checks of the model maintaining its own records, which is now the host's job | Reported only |

**Decision.**

1. **Manipulation check.** Pool every instance of the model checks in each group. The weak group must trail the strong group by 15 percentage points or more; if it does not, the verdict is "inconclusive".
2. **Functions.** Only if that check passes are each function's deliveries over 10 runs compared: `b` for the strong group, `w` for the weak one.
   - The function counts as *held* when `w ≥ b − 2`, and as *broken* when `w ≤ b/2`.
   - Functions with `b < 6` are left out.
   - If fewer than 3 functions remain, the verdict is "inconclusive".
3. **Verdict.**
   - "Supported" needs most of the remaining functions held, and no code check showing a hidden reliance on the model.
   - "Not supported" means most of them broke.
   - Anything else is "partially supported".
4. **Invalid runs.** A run is discarded and rerun if it met a provider or gateway failure (5xx, 429, a timeout) or a broken scratch environment. A group whose invalid share stayed above 10% after reruns was labeled "not run cleanly", and no verdict was given for it.

## Round 1 (amendment A1): DeepSeek v4-pro versus flash

**Models.**

- **Strong group:** `deepseek-v4-pro` ("pro").
- **Weak group:** `deepseek-flash` ("flash"), which was TAi's live model at the time.
- **Thinking:** switched off for both.

The only usable key was DeepSeek's, and DeepSeek offered just these two models. The expectation written before the runs was that flash would be only slightly weaker.

**Timeline.**

- Counted runs: 2026-11-15 23:22:22 to 2026-11-16 02:15:53 UTC, 178 runs in all (88 counted runs per group, plus one long session each).
- The DeepSeek account ran out of credit on 2026-11-16, at 01:42:59 UTC. Every later call came back with HTTP 402 ("Insufficient Balance").
- The runs that were hit (the last patrol scenarios, P2 and P3, and the long sessions) were not repeated.

| Calculation | pro | flash | Gap, pro − flash (points) |
|---|---|---|---|
| Every run counted as valid | 314/358 = 87.7% | 307/350 = 87.7% | 0.0 |
| 402-hit runs treated as invalid (main calculation) | 310/342 = 90.6% | 307/330 = 93.0% | −2.4 |
| Rerun bound most favorable to "flash is weaker" | 338/370 = 91.4% | 307/370 = 83.0% | 8.4 |
| Rerun bound least favorable to "flash is weaker" | 310/370 = 83.8% | 347/370 = 93.8% | −10.0 |

**Outcome.**

- **With the 402-hit runs treated as invalid**, the frozen analysis script reported "not run cleanly". 11 of flash's 89 runs (12.4%) were invalid, above the 10% limit; pro had 8 of 89 (9.0%).
- **With every run counted**, the verdict is "inconclusive".
- **Rerunning could not have changed either outcome.** Even the most favorable bound leaves a gap of 8.4 points, below 15.
- **How the runs were marked.** The marking was done afterwards by `harness/mark_provider_faults.py`. It treats a 402, which the criteria do not mention, like any other provider failure.

The functions are description only, because the manipulation check failed:

| Function | pro | flash | Note |
|---|---|---|---|
| F1 deadline | 10/10 | 10/10 | |
| F2 grade | 10/10 | 9/10 | One reply said "24 of 30". The regular expression rejected that wording although the transcript shows the grade was given; the count stays 9/10 |
| F3 recall after a restart | 10/10 | 10/10 | |
| F4 record | 9/10 | 10/10 | In one pro run the model changed the record file on its own, so that run cannot tell which side wrote the change |
| F5 running code | 3/10 | 2/10 | Under 6 even for pro, so F5 was excluded. In almost every run without a call, TAi first asked the student to predict the output, as its persona requires |

## Round 2 (amendment A2): pro versus a local Qwen3-4B (W2)

**Models.**

- **Strong group:** the existing pro runs from round 1 (`results/weak-main.marked.jsonl`), not repeated. DeepSeek was no longer callable.
- **Weak group (W2):** Qwen3-4B-Instruct-2507, quantized to Q4_K_M. It was served by llama.cpp b12061 (Vulkan) on the author's laptop (Ryzen 5 6600H, integrated graphics), under the alias `weak-qwen3-4b`.
- **Model calls:** W2 answered every call: conversation, patrol and both host writers.

**What else A2 changed.**

- Longer waits.
- A 1536-token output limit.
- A fixed tool order in the gateway.
- The code-running scenario as two messages (s9b, description only).
- A manipulation check restricted to scenarios that both rounds ran. Per scenario, pro contributes as many valid runs (its first ones) as W2 has valid runs there.

**Timeline.**

- Counted runs: 2026-11-17 00:12:13 to 04:52:54 UTC.
- 76 runs, every one valid: 5 each for s1–s3 and s5–s8, 10 for s4, 10 each for m1 and m2, 3 each for P1 and P2, and 5 for s9b.
- Closing the laptop's lid put it to sleep for 1 h 51 min. The run that was under way was declared invalid and repeated.

| Calculation | Strong group | W2 | Gap (points) |
|---|---|---|---|
| Main calculation: pro, on the scenarios both rounds share | 303/322 = 94.1% | 262/316 = 82.9% | 11.2 |
| Sensitivity row fixed beforehand: flash instead of pro | 300/310 = 96.8% | 262/316 = 82.9% | 13.9 |
| The same without W2's P2 (added afterwards, description only) | 300/310 = 96.8% | 262/310 = 84.5% | 12.3 |

**Outcome.** The frozen script reported **"inconclusive"**: a gap of 11.2 points, where 15 were needed.

| Function | pro | W2 | Script's status |
|---|---|---|---|
| F1 deadline | 10/10 | 0/10 | broke |
| F2 grade | 10/10 | 0/10 | broke |
| F3 recall after a restart | 10/10 | 10/10 | held |
| F4 record | 9/10 | 10/10 | held |
| F5 running code (s9b) | no data | 0/5 | excluded by A2 |

Had the manipulation check passed, two held and two broken functions would have meant "partially supported".

**W2 called no tool at all in its 76 runs.** In the scenarios that both rounds share, there were 104 tool calls across pro's 71 runs and none across W2's 71. Grouping the model checks after the fact (description only) shows why the pooled gap stayed small:

| Model checks, grouped after the results | pro | W2 |
|---|---|---|
| Need the conversation model to call a tool | 26/41 = 63.4% | 0/41 = 0% |
| Judgments by the host's writers | 20/20 | 10/20 |
| Look only at the reply text | 257/261 = 98.5% | 252/255 = 98.8% |

The three groups sum to the main calculation. Four of the text checks are passed automatically whenever no tool is called; dropping them leaves 232/236 for pro and 227/230 for W2.

**A probe run after the counted runs** (`harness/toolcall_check.py`, output in `results/toolcall-check-r2.txt`) sent requests to the laptop's server directly, skipping the gateway and the harness:

- **A toy request** with a single tool: W2 made the call, with and without streaming.
- **TAi's real request**, carrying the system prompt and all 32 tools, plus a student asking about due dates and grades: W2 answered in plain text 4 times out of 4, and each time made up both the deadline and the grade.

**Inside the counted runs.**

- **Deadlines and grades.** Across the 10 runs about them, W2 always answered along the lines of "HW3 is due Monday at 9am" and never named HW6, the assignment that was actually coming due. 7 of those runs also gave an invented score.
- **Running code.** In s9b, W2 claimed 5 times out of 5 that it could not run code, though TAi has a Go sandbox. When the student then guessed the program's behavior wrongly, W2 agreed with the guess all 5 times.

## What it shows and what it does not

- **Still an open question.** The manipulation check failed both times, so the experiment does not settle whether the model or the host carries more of TAi's work.
- **A pattern noticed afterwards in round 2.** Two functions did not depend on the conversation model calling a tool, and both still worked. The two that needed a call to Canvas never worked, and the model filled the gap with invented answers.
- **Weak evidence from the code checks.** No hidden reliance on the model turned up in them, in either round. But no model ever tried an unauthorized call, leaving the refusal check with nothing to judge. The sandbox ran 5 times in round 1 and never in round 2.
- **Narrow scope.**
  - One 4B model at 4 bits, one laptop, one server setting.
  - Four functions, text conversation only, stand-in course systems.
  - In round 2 the groups also differed in timing and settings, not only in the model.

## Code version

Both rounds ran on a copy of the release then live on the course's host, which the records call `47c1206`. That is the release's internal commit id, and it does not exist in this repository.

- **What the release contains.** Commit `7953823` (the voice-lab line) with the tool-host fix `c61a1ed`, minus the rebuilt LeanRAG graph. At the tag, that graph code is present behind a switch that defaults to off.
- **Line citations.** The records cite code as `file:line` in that release. Every cited file is byte-for-byte the same at the tag `thesis-2026-12`, except `src/container-runner.ts`: the LeanRAG switch adds five lines there, so the records' lines 553–554 are lines 558–559 at the tag.
- **Older commit ids.** Other commit ids in the records and documents belong to the history before it was rewritten for publication. [`docs/COMMIT_MAP.md`](../../docs/COMMIT_MAP.md) gives their published equivalents.

## Files

| Path | Contents |
|---|---|
| `harness/weak_stack.sh`, `weak_stack_r2.sh` | Set up and run the scratch environment on the host (round 1, round 2) |
| `harness/weak_scenarios.py`, `weak_scenarios_r2.py` | Scenarios and checks |
| `harness/weak_analyze.py`, `weak_analyze_r2.py` | The frozen analysis scripts |
| `harness/weak_read.py` | The frozen transcript reader (fixed seed) |
| `harness/mark_provider_faults.py` | Marks runs hit by provider failures, written after round 1's counted runs |
| `harness/toolcall_check.py` | Round 2's direct tool-call probe |
| `harness/llm_relay.py`, `llm_relay_capture.py`, `r2_canon.py` | Round 2's relay to the laptop and its tool-order hook |
| `harness/capture_*.py`, `weak_plumb.py` | Pipeline checks (not counted) |
| `harness/setup_keys.sh`, `r2_watch.sh`, `wait_run.sh` | Key prompt and run watchers (redacted, see below) |
| `results/weak-main.jsonl`, `weak-main.marked.jsonl` | Round 1's counted runs, as recorded and with the 402-hit runs marked |
| `results/weak-r2main.jsonl` | Round 2's counted runs |
| `results/analysis-*.json`, `analysis-*.txt` | What the frozen analysis scripts printed |
| `results/reading-main.txt`, `reading-r2main.txt`, `read-r2-input.jsonl` | The transcript reader's output and input |
| `results/gateway.jsonl`, `gateway-r2.jsonl` | One line per call through the scratch gateway: model, tokens, status |
| `results/toolcall-check-r2.txt`, `r2-canon.jsonl`, `ramlog-r2.log` | Round 2's tool-call probe, tool-order log and memory readings |
| `results/run-*.log`, `per-check-table.md` | Run logs, and round 1's table of every check |
| `results/weak-pilot.jsonl`, `weak-plumb.jsonl`, `weak-r2pilot.jsonl` | Pilot and pipeline runs (not counted) |

**Changes made for publication, and what is not here.**

- **Redacted:** `harness/setup_keys.sh`, `r2_watch.sh` and `wait_run.sh` named the course host's SSH target, which is now `$TAI_HOST`. The records give no checksum for these three files. `setup_keys.sh` never contained a key: it prompts for keys and saves them to a file on the host.
- **Left out:** `results/server-r2.log`, the llama.cpp server log from the laptop. No calculation uses it.
- **Not here:**
  - the shared freeze note (`weak-model-freeze.md`), whose checksums the records repeat;
  - files that never left the host or the laptop, some of which the records checksum: the scratch gateway's configuration, the files patched for round 2's scratch environment, and the laptop's server and tunnel scripts.
- **Unchanged:** everything else is exactly as recorded, Windows line endings included (`.gitattributes` stops git from rewriting them). These match the sha256 values given in the records:
  - the criteria file;
  - `weak-main.jsonl`, `weak-main.marked.jsonl`, `weak-r2main.jsonl`, `gateway.jsonl` and `toolcall-check-r2.txt` (full values);
  - round 2's analysis outputs, `reading-r2main.txt`, `read-r2-input.jsonl` and `gateway-r2.jsonl` (recorded prefixes);
  - the eleven harness scripts the records list.

## Reproducing the analysis

The analysis needs nothing but Python 3 and these files. Run it from this folder:

```bash
# Round 1: mark provider failures, then the frozen analysis
python3 harness/mark_provider_faults.py results/weak-main.jsonl results/gateway.jsonl results/weak-main.marked.jsonl
python3 harness/weak_analyze.py results/weak-main.marked.jsonl --base deepseek-pro --weak deepseek

# Round 2: the main calculation, the sensitivity row and the transcript reading
python3 harness/weak_analyze_r2.py results/weak-main.marked.jsonl results/weak-r2main.jsonl --json results/analysis-r2main.json
python3 harness/weak_analyze_r2.py results/weak-main.marked.jsonl results/weak-r2main.jsonl --b deepseek --json results/analysis-r2main.flash.json
python3 harness/weak_read.py results/read-r2-input.jsonl --base deepseek-v4-pro --weak weak-qwen3-4b --seed 20261115
```

Running the experiment again would need the course's host, a working TAi and provider keys. The shell scripts use Windows line endings; convert them (for example with `dos2unix`) before running them on Linux.
