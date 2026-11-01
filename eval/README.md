# eval/: verifying TAi off AWS, on Cerebras

Everything here exists to answer three questions about running TAi (this fork of `YuzhengShi/tai-deploy`) on its own box with
Cerebras models behind a LiteLLM gateway instead of Bedrock:

1. How do `qwen-3.8-27b` and `gpt-oss-120b` do on TAi's own flow (the six-step teaching loop, the Canvas and GitHub tools, long
   conversations)?
2. Does a conversation survive across turns, containers and restarts (`resume`), and do TAi's guard hooks guard?
3. Does TAi's own scheduling (one agent container per active student, a cap, a warm period) behave as designed?

Nothing here touches real students: the students are synthetic (Ann 1001 / `ann-eval`, Bob 1002, Cy 1003), Canvas and GitHub are
stand-ins, and no real token or repository is used. The course material the knowledge tool answers from is exported on the box
(`host/remote/export_corpus.sh`) and is not in git (`leanrag/stub_corpus.json` is git-ignored).

## Pieces

| File | What it is |
| --- | --- |
| `mock_llm.py` | A scripted Anthropic Messages API. A directive `MOCK:<name>` in a student's message picks a JSON script of fixed tool calls, sleeps, errors and answers, so a guard/resume/scheduling test has a ground truth that does not depend on a model's mood. It also reports what it was shown (message count, markers from earlier turns). |
| `mock_services.py` | Canvas (`/api/v1`) and GitHub (`/ghe/api/v3`) stand-ins with canaries in Bob's and Cy's data; every request is logged. |
| `litellm/` | The gateway config (aliases `qwen` = reasoning off, `gpt-oss` = reasoning low) and a callback that strips replayed thinking blocks and logs the upstream status of every call. |
| `harness/tai.py` | The client the tests share: register a chat, send, long-poll the web channel's outbox, read transcripts/logs/SQLite/`docker ps`. |
| `harness/smoke.py` | One scripted message through the real orchestrator and an agent container, end to end. |
| `harness/guards.py` | Item 2a, hooks and access control, with `--variant as-shipped` (the upstream runner, see `variants/`) / `current` (the repository's source as synced). |
| `harness/resume.py` | Item 2b, resume across turns, containers, restarts, the "10-query cap", and what the student sees when the model API fails. |
| `harness/sched.py` | Item 3, scheduling. |
| `harness/scenarios.py` | Item 1, `qwen` against `gpt-oss`: scripted student turns, automatable checks taken from the persona, a 30-turn session. |
| `variants/` | `index.ts.as-shipped`: the agent runner exactly as upstream has it (the before of every guard measurement). The "after" is the repository's own `container/agent-runner/src/`, never a copy. |
| `host/` | Scripts that run from Git Bash and drive the box over ssh (`run.sh` syncs this tree and runs one script from `host/remote/`). |

## Running it (from Git Bash, in `eval/host`)

    ./10_prep.sh                      # directories, Node 22 in the user's home, the docker network
    ./run.sh stack.sh build           # npm ci + tsc for the orchestrator (detached)
    ./30_build_image.sh start         # the agent image, tai-agent:eval (detached, about an hour the first time)
    ./run.sh export_corpus.sh         # the stand-in course material, on the box only
    ./run.sh stack.sh backend mock    # TAi's .env for the scripted model; `qwen` / `gpt-oss` for the real ones
    ./run.sh stack.sh mocks           # the scripted model and the Canvas/GitHub stand-ins
    ./run.sh stack.sh litellm         # the Cerebras gateway (reads the key from the world's .env on the box, never prints it)
    ./run.sh stack.sh orch start
    ./run.sh harness/smoke.py
    ./run.sh harness/guards.py --variant as-shipped ; ./run.sh harness/guards.py --variant current
    ./run.sh harness/resume.py ; ./run.sh harness/sched.py
    ./run.sh harness/scenarios.py qwen --runs 3 ; ./run.sh harness/scenarios.py gpt-oss --runs 3
    ./run.sh harness/scenarios.py qwen --long

A gateway trap found on the way (`harness/toolcall_probe.py`): through LiteLLM's streaming `/v1/messages` route, several parallel
tool calls from the model are merged into ONE `tool_use` block whose arguments are the call arguments concatenated (invalid JSON), so
Claude Code reports an empty-arguments call and the tool answers "Input validation error". Straight to Cerebras the same request
gives correct arguments every time (24 of 24 calls). `litellm/config.yaml` therefore sets `parallel_tool_calls: false` for both aliases
(one call per turn), and the model comparison was run that way (`--tag seq`); a first qwen run through the unfixed gateway is kept
(`scenarios-2026...json`, no tag) to show what the bug costs.

The two Cerebras models have separate token-per-minute buckets (qwen 150,000, gpt-oss 500,000 on the account these were measured
on), and a qwen bucket is shared with anything else on the same account, so the scenario runs go one at a time.

## Changes to TAi itself that the evaluation needed

* `src/channels/web.ts`, `TAI_CHANNELS`, `TAI_NO_SEEDS`: a web channel (127.0.0.1, no authentication yet) to drive the real orchestrator.
* `src/container-runner.ts`: the gateway variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, the model-slot names) are passed
  into the container like the other secrets.
* `container/agent-runner/src/index.ts`: `ANTHROPIC_AUTH_TOKEN` joins the Bash unset list, and the blocking hooks return the shape the
  SDK reads (`permissionDecision: 'deny'`); as shipped they returned `decision: 'block'` inside `hookSpecificOutput`, which the SDK
  (0.2.34) ignores, so no guard ever stopped a tool.
* `container/scripts/github_api.py`: the public-GitHub base URL can be set (`GITHUB_BASE_URL_PUBLIC`).
* `leanrag/query.py` + `leanrag/stub_query.py`: BM25 over a JSON corpus behind the same tool, when `leanrag/stub_corpus.json` exists.
