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
| `mock_llm.py` | A scripted Anthropic Messages API. A directive `MOCK:<name>` in a student's message picks a JSON script of fixed tool calls, sleeps, errors and answers, so a guard/resume/scheduling test has a ground truth that does not depend on a model's mood. It also reports what it was shown (message count, markers from earlier turns, `PLANTED-` markers in the system prompt or tools). A script names Claude Code's tools; when the client is pi the call is translated to pi's (`bash`, `read` with `path` ...). |
| `mock_services.py` | Canvas (`/api/v1`) and GitHub (`/ghe/api/v3`) stand-ins with canaries in Bob's and Cy's data; every request is logged. |
| `litellm/` | The gateway config (aliases `qwen` = reasoning off, `gpt-oss` = reasoning low; qwen falls back to gpt-oss) and a callback that strips replayed thinking blocks, logs the upstream status of every call and keeps qwen inside TAi's share of the tokens per minute (`test_budget.py` checks its arithmetic). |
| `harness/tai.py` | The client the tests share: register a chat, send, long-poll the web channel's outbox, read transcripts/logs/SQLite/`docker ps`. Reads the session files of both harnesses: pi's are turned into Claude Code's row shape (`pi_rows`), so every check sees the same tool names and inputs. |
| `harness/smoke.py` | One scripted message through the real orchestrator and an agent container, end to end. |
| `harness/guards.py` | Item 2a, hooks and access control, with `--variant as-shipped` (the upstream runner, see `variants/`; Claude harness only) / `current` (the repository's source as synced). Runs on whichever harness `stack.sh harness` says. |
| `harness/pi_isolation.py` | pi's working directory is a folder the model writes in: plants extensions, skills, prompt templates, settings, an MCP server meant to replace the real one, `AGENTS.md`, `SYSTEM.md` there and checks nothing is loaded or run (the scripted model reports `PLANTED-` markers it was shown). |
| `harness/cache_probe.py`, `cache_probe_tools.py`, `cache_new_sessions.py`, `rate_probe.py`, `cache_share.py`, `prompt_anatomy.py`, `use_image.py` | Where the tokens go (RESULTS.md, "Where the tokens go" and "Switching the harness to pi"): what a changing line does to Cerebras's prefix cache (alone, with tools in the request, and for the first call of new sessions on the real stack), what cached tokens cost the tokens-per-minute bucket, the weight of a first request by part; `use_image.py` points the stack at the image the harness runs on. |
| `harness/resume.py` | Item 2b, resume across turns, containers, restarts, the session cap (RS3, with `TAI_MAX_TURNS_PER_SESSION=4`), and what the student sees when the model API fails (RS5). |
| `harness/sched.py` | Item 3, scheduling; `--precompiled` runs it on `tai-agent:clean`, the image built from the Dockerfile without a cache, with no tsc at container start. |
| `harness/fallback.py` | Does gpt-oss answer when qwen cannot (a failing deployment, plain and streaming) and does the qwen budget spill to gpt-oss, on the `/v1/messages` route Claude Code uses and, with `chat`, on the `/v1/chat/completions` route pi uses; read off the gateway's log. `stack.sh fallbacktest [budget] [chat]`. The chat route found a real bug: Cerebras refuses a replayed gpt-oss turn that carries `reasoning_content` (HTTP 400), which `tai_callbacks.py` now strips. |
| `harness/transcript.py`, `harness/gwlog.py` | What the check counts hide: every message of a conversation in order from either harness's session files (the lost-reply finding came from here), and the gateway's own one-line-per-call log (the 400 above came from here). |
| `harness/leak_samples.py`, `harness/peek.py` | The student-visible text of the turns that leaked reasoning or tool markup (the samples `src/router.ts` is written against); a group's last tool calls. |
| `harness/scenarios.py` | Item 1, `qwen` against `gpt-oss`: scripted student turns, automatable checks taken from the persona, a 30-turn session. |
| `variants/` | `index.ts.as-shipped`: the agent runner exactly as upstream has it (the before of every guard measurement). The "after" is the repository's own `container/agent-runner/src/`, never a copy. |
| `host/` | Scripts that run from Git Bash and drive the box over ssh (`run.sh` syncs this tree and runs one script from `host/remote/`; `rund.sh` runs a harness script detached and `rund.sh look NAME` reads it; `remote/diag.sh` is read-only: orchestrator errors and events, load, a group's runner log, the image build log). |

## Running it (from Git Bash, in `eval/host`)

    ./10_prep.sh                      # directories, Node 22 in the user's home, the docker network
    ./run.sh stack.sh build           # npm ci + tsc for the orchestrator (detached)
    ./30_build_image.sh start         # the agent image, tai-agent:eval (detached, about an hour the first time)
    ./run.sh export_corpus.sh         # the stand-in course material, on the box only
    ./run.sh stack.sh backend mock    # TAi's .env for the scripted model; `qwen` / `gpt-oss` for the real ones
    ./run.sh stack.sh mocks           # the scripted model and the Canvas/GitHub stand-ins
    ./run.sh stack.sh litellm         # the Cerebras gateway (reads the key from the world's .env on the box, never prints it)
    ./run.sh stack.sh orch start
    ./run.sh stack.sh harness pi      # or claude: what runs the conversation in the agent container (pi is the default)
    ./run.sh harness/use_image.py     # the orchestrator on tai-agent:clean, the image built from the Dockerfile (the old tai-agent:eval has no pi)
    ./run.sh harness/smoke.py
    ./run.sh harness/guards.py --variant as-shipped ; ./run.sh harness/guards.py --variant current
    ./run.sh harness/resume.py ; ./run.sh harness/sched.py ; ./run.sh harness/pi_isolation.py
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

## Fixes made for what the tests found (see RESULTS.md, "After the fixes")

* `container/agent-runner/src/guards.ts`, `github-access.ts`: the tool guards, importable and unit tested (`container/agent-runner/test/`).
  Every guard of a tool is one hook, so the model is told the reason for a refusal.
* `container/agent-runner/src/api-errors.ts`, `session-log.ts`, `index.ts`: plain-words answers to a failed model request, bounded retries
  and timeouts, a session cap that fires (and is cleared on the host: `ContainerOutput.resetSession`), the runner's own
  `competency/interaction-summary.md`.
* `src/router.ts`, `src/index.ts`: a normal reply goes through `formatOutbound` too, and `stripInternalTags` removes the reasoning and
  tool-call text gpt-oss writes into its answers.
* `container/entrypoint.sh`, `Dockerfile`: the dist built into the image runs; `TAI_COMPILE_ON_START=1` compiles the mounted source.
* `litellm/config.yaml`, `tai_callbacks.py`: qwen falls back to gpt-oss, and stays inside `TAI_QWEN_TPM_BUDGET`.
* `src/config.ts`: `IDLE_TIMEOUT` 2 min, `CONTAINER_TIMEOUT` 15 min.

## pi as the agent harness

* `container/agent-runner/src/pi-runner.ts` (+ `pi-support.ts`, `pi-guards.ts`, `web-fetch.ts`, `prompt.ts`, `protocol.ts`, `mcp-servers.ts`): the same container
  protocol as `index.ts`, the conversation run by pi (`@earendil-works/pi-coding-agent`) over the OpenAI API of the gateway. `TAI_HARNESS=pi|claude` (in `.env`,
  read at every spawn; `src/container-runner.ts` passes it on and `container/entrypoint.sh` picks the runner) selects it; pi is the default.
* `prompt.ts`: the persona first, what varies per student and per minute after it (Claude harness: at the end of the system prompt; pi: in front of the first
  message of a run, so the system prompt is the same bytes for every student).
* `Dockerfile`: ripgrep and fd (pi's `grep` and `find`).

The settings are in `docs/SETTINGS.md`, the guards in `docs/SECURITY.md`.
