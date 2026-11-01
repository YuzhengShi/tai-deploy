# Settings added in this fork

TAi runs here off AWS: its own box, an Anthropic-compatible gateway (LiteLLM) in front of Cerebras, a web channel instead of
WhatsApp. These are the settings that came with that; the rest of TAi's configuration is unchanged. Orchestrator settings are
environment variables of the orchestrator process; the ones marked `.env` are read from TAi's `.env` at every container spawn and
reach the agent container as secrets.

| Setting | Where | Default | What it does |
| --- | --- | --- | --- |
| `TAI_CHANNELS` | orchestrator | `whatsapp` | Channels to start: `whatsapp`, `web`, or `whatsapp,web`. |
| `TAI_WEB_PORT` | orchestrator | `8099` | Port of the web channel (listens on 127.0.0.1 only; no authentication yet). |
| `TAI_NO_SEEDS` | orchestrator | unset | `1` skips the background seeding (competency bootstrap, teaching patrol, course sync, LeanRAG sync): each spawns containers on its own. |
| `IDLE_TIMEOUT` | orchestrator | `120000` (was 30 min) | How long a container stays warm after its last answer. The conversation is resumed by the next container. |
| `CONTAINER_TIMEOUT` | orchestrator | `900000` (was 30 min) | A container silent for this long is killed. |
| `MAX_CONCURRENT_CONTAINERS` | orchestrator | `5` | Containers at once. The binding limit is the model's tokens per minute, not this. |
| `TAI_COMPILE_ON_START` | orchestrator | unset | `1`: containers compile the mounted `container/agent-runner/src` at start (8-10 s) instead of running the dist built into the image. For development and the guard harness. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` | `.env` | | The gateway and the one model name every slot of Claude Code resolves to. |
| `CLAUDE_CODE_MAX_RETRIES` | `.env` | `3` (Claude Code: 10) | Retries of a failed model request before the student is told. 10 meant about 216 s of silence. |
| `API_TIMEOUT_MS` | `.env` | `120000` (Claude Code: 600000) | How long Claude Code waits for one model response. |
| `TAI_MAX_TURNS_PER_SESSION` | `.env` | `25` | After this many answers the runner retires the session; the next message starts a new one (the competency files carry the memory). |
| `TAI_MAX_CONTEXT_TOKENS` | `.env` | `90000` | Same, when the context at the last model call has grown to this size. |
| `GITHUB_BASE_URL_PUBLIC` | `.env` | `https://api.github.com` | Public-GitHub API base URL (a stand-in in tests). |
| `TAI_QWEN_TPM_BUDGET` | gateway (`gateway.env`) | `90000` | Tokens the `qwen` alias may use per minute through the gateway (prompt + completion of completed requests). Above it a new request is sent to `gpt-oss`; `0` = no limit. Leaves the rest of the shared Cerebras bucket to Nora. |

Failures of qwen itself (a 429 because the shared bucket is used up, a 5xx, a timeout) are answered by `gpt-oss` through the gateway's
`router_settings.fallbacks` (`eval/litellm/config.yaml`).

The agent container writes `competency/interaction-summary.md` itself after every answer (the last 20 exchanges, one line each):
the model did not keep it, which left the persona's "is this student new?" test saying yes for everyone.
