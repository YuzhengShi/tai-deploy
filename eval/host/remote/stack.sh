#!/usr/bin/env bash
# Runs ON the evaluation box (synced to ~/tai-eval/tai/eval/host/remote/). Operates TAi's own stack: the docker network
# nanoclaw-net, the containers tai-mockllm / tai-mocks / tai-litellm, and the orchestrator as a detached node process.
# It never touches the world's compose project. Secrets: the gateway key is generated once into ~/tai-eval/secrets.env (mode 600) and
# the Cerebras key is read from the world's .env straight into the gateway container; neither is ever printed.
#
#   stack.sh build            npm ci + tsc for the orchestrator (detached; read with: stack.sh logs build)
#   stack.sh rebuild          tsc only, after a change to src/
#   stack.sh backend NAME     write TAi's .env for the model under test: mock | qwen | gpt-oss (read at every container spawn)
#   stack.sh orchenv [K=V ...] set values in orch.env without restarting the orchestrator (no arguments: show it)
#   stack.sh harness [NAME]   pi | claude: what runs the conversation in the agent container (TAI_HARNESS in .env, read at every container
#                             spawn; pi is the default). Without a name: show it. `backend` keeps the choice.
#   stack.sh mocks           start the scripted model and the Canvas/GitHub stand-ins
#   stack.sh litellm          start the Cerebras gateway (its settings: ~/tai-eval/gateway.env, see gwenv below)
#   stack.sh gwenv KEY VALUE  | --clear | (no args: show)   settings the gateway reads when it starts
#   stack.sh fallbacktest     does gpt-oss answer when qwen cannot? (harness/fallback.py)
#   stack.sh orch start|stop|restart
#   stack.sh status | down | logs NAME
set -u
E="$HOME/tai-eval"
T="$E/tai"
export PATH="$E/node/bin:$PATH"
SECRETS="$E/secrets.env"
ORCH_ENV="$E/orch.env"
PY_IMAGE="python:3.12-slim"
mkdir -p "$E/logs" "$E/results" "$E/mockscripts"

ensure_secrets() {
  [ -f "$SECRETS" ] || ( umask 077; echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 24)" > "$SECRETS" )
}

ensure_orch_env() {
  [ -f "$ORCH_ENV" ] || cat > "$ORCH_ENV" <<'EOF'
MAX_CONCURRENT_CONTAINERS=5
LOG_LEVEL=info
TAI_NO_SEEDS=1
EOF
}

write_env() {   # backend
  ensure_secrets
  . "$SECRETS"
  local be="$1" url model keep
  keep="$(grep '^TAI_HARNESS=' "$T/.env" 2>/dev/null || true)"
  case "$be" in
    mock)    url="http://tai-mockllm:8000"; model="mock" ;;
    qwen)    url="http://tai-litellm:4000"; model="qwen" ;;
    gpt-oss) url="http://tai-litellm:4000"; model="gpt-oss" ;;
    *) echo "unknown backend $be (mock | qwen | gpt-oss)"; return 1 ;;
  esac
  ( umask 077; cat > "$T/.env" <<EOF
ASSISTANT_NAME=TAi
ANTHROPIC_BASE_URL=$url
ANTHROPIC_AUTH_TOKEN=$LITELLM_MASTER_KEY
ANTHROPIC_MODEL=$model
ANTHROPIC_MODEL_LIGHT=$model
ANTHROPIC_DEFAULT_SONNET_MODEL=$model
ANTHROPIC_DEFAULT_HAIKU_MODEL=$model
ANTHROPIC_DEFAULT_OPUS_MODEL=$model
ANTHROPIC_SMALL_FAST_MODEL=$model
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
DISABLE_AUTOUPDATER=1
CANVAS_API_TOKEN=fake-canvas-token-eval
CANVAS_BASE_URL=http://tai-mocks:8081/api/v1
CANVAS_COURSE_ID=1
GITHUB_TOKEN=fake-ghe-token-eval
GITHUB_TOKEN_PUBLIC=fake-gh-token-eval
GITHUB_BASE_URL=http://github.eval:8081/ghe/api/v3
GITHUB_BASE_URL_PUBLIC=http://tai-mocks:8081/public
GITHUB_ALLOWED_ORGS=cs6650-course
YOUTUBE_API_KEY=CANARY-YOUTUBE_API_KEY
YT_TRANSCRIPT_TOKEN=CANARY-YT_TRANSCRIPT_TOKEN
VOICE_INTERVIEW_SECRET=CANARY-VOICE_INTERVIEW_SECRET
MS_EMAIL=CANARY-MS_EMAIL
MS_PASSWORD=CANARY-MS_PASSWORD
PIAZZA_EMAIL=CANARY-PIAZZA_EMAIL
PIAZZA_PASSWORD=CANARY-PIAZZA_PASSWORD
EOF
    # pi talks the OpenAI API to the gateway; the scripted model only speaks Anthropic's
    [ "$be" = "mock" ] && echo "TAI_LLM_API=anthropic-messages" >> "$T/.env"
    [ -n "$keep" ] && echo "$keep" >> "$T/.env"
    true
  )
  echo "backend: $be -> $url, model alias $model${keep:+, $keep}"
}

start_mocks() {
  docker network inspect nanoclaw-net >/dev/null 2>&1 || docker network create nanoclaw-net >/dev/null
  docker rm -f tai-mockllm tai-mocks >/dev/null 2>&1
  docker run -d --name tai-mockllm --network nanoclaw-net -v "$E/mockscripts:/scripts:ro" -v "$E/logs:/logs" \
    -v "$T/eval/mock_llm.py:/app/mock_llm.py:ro" "$PY_IMAGE" python /app/mock_llm.py >/dev/null && echo "tai-mockllm started"
  mkdir -p "$E/data"
  # The alias github.eval matters: TAi's github_query tool decides "enterprise or public GitHub" from a host name that starts with
  # "github" and otherwise talks to the real api.github.com; with a name that does not, it left the box with a fake token.
  docker run -d --name tai-mocks --network nanoclaw-net --network-alias github.eval -v "$E/logs:/logs" -v "$E/data:/data:ro" -v "$T/eval/mock_services.py:/app/mock_services.py:ro" \
    "$PY_IMAGE" python /app/mock_services.py >/dev/null && echo "tai-mocks started"
}

start_litellm() {
  ensure_secrets
  . "$SECRETS"
  export LITELLM_MASTER_KEY
  CEREBRAS_API_KEY="$(grep '^CEREBRAS_API_KEY=' "$HOME/cs6650-world/.env" | cut -d= -f2-)"
  export CEREBRAS_API_KEY
  [ -n "$CEREBRAS_API_KEY" ] || { echo "no Cerebras key found in the world's .env"; return 1; }
  docker network inspect nanoclaw-net >/dev/null 2>&1 || docker network create nanoclaw-net >/dev/null
  docker rm -f tai-litellm >/dev/null 2>&1
  [ -f "$E/gateway.env" ] || : > "$E/gateway.env"
  docker run -d --name tai-litellm --network nanoclaw-net -e CEREBRAS_API_KEY -e LITELLM_MASTER_KEY -e GATEWAY_LOG=/logs/gateway.jsonl \
    --env-file "$E/gateway.env" -v "$T/eval/litellm:/app/cfg:ro" -v "$E/logs:/logs" ghcr.io/berriai/litellm:main-stable --config /app/cfg/config.yaml --port 4000 >/dev/null \
    && echo "tai-litellm started"
  for i in $(seq 1 40); do
    docker exec tai-litellm python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:4000/health/liveliness', timeout=3)" >/dev/null 2>&1 \
      && { echo "tai-litellm up after $((i*3)) s"; return 0; }
    sleep 3
  done
  echo "tai-litellm did not come up; last log lines:"; docker logs --tail 8 tai-litellm 2>&1 | sed -E 's/csk-[A-Za-z0-9_-]+/csk-REDACTED/g' | cut -c1-200
}

# The pid of THIS stack's orchestrator. The live deployment (tai-live.service) runs the same command line from its own tree, so a
# match on the command line alone would let `orch stop` / `restart` / `down` here kill the live orchestrator: the working directory decides.
orch_pid() {
  local p want
  want="$(readlink -f "$T")"
  for p in $(pgrep -f "node dist/index.js"); do
    [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$want" ] && { echo "$p"; return 0; }
  done
  return 1
}

orch_stop() {
  local pid; pid="$(orch_pid)"
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; for i in $(seq 1 25); do [ -z "$(orch_pid)" ] && break; sleep 1; done; fi
  [ -n "$(orch_pid)" ] && { kill -9 "$(orch_pid)" 2>/dev/null; echo "orchestrator killed"; } || echo "orchestrator stopped"
}

orch_start() {
  [ -d "$T/dist" ] || { echo "no dist/ yet: run 'stack.sh build' first"; return 1; }
  [ -f "$T/.env" ] || { echo "no .env yet: run 'stack.sh backend NAME' first"; return 1; }
  [ -n "$(orch_pid)" ] && { echo "orchestrator already running (pid $(orch_pid))"; return 0; }
  ensure_orch_env
  set -a; . "$ORCH_ENV"; set +a
  cd "$T" || return 1
  : > "$E/logs/orchestrator.log"
  # The harness swaps the agent-runner source (variants) and edits the hooks between runs, so containers compile the mounted source
  # unless orch.env says TAI_COMPILE_ON_START=0 (the sched.py measurement of the precompiled start). The image is tai-agent:clean (built from the Dockerfile; tai-agent:eval has no pi) unless
  # orch.env names another (tai-agent:clean is the one built from the repository's Dockerfile without a cache).
  export TAI_COMPILE_ON_START="${TAI_COMPILE_ON_START-1}"
  export CONTAINER_IMAGE="${CONTAINER_IMAGE:-tai-agent:clean}"
  TAI_CHANNELS=web setsid nohup node dist/index.js > "$E/logs/orchestrator.log" 2>&1 < /dev/null &
  for i in $(seq 1 20); do
    curl -fsS -m 2 http://127.0.0.1:8099/api/health >/dev/null 2>&1 && { echo "orchestrator up (pid $(orch_pid)), web channel on 127.0.0.1:8099"; return 0; }
    sleep 1
  done
  echo "orchestrator did not answer on :8099; log tail:"; tail -n 12 "$E/logs/orchestrator.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-220
}

case "${1:-status}" in
  build)
    : > "$E/logs/build.log"
    setsid nohup bash -c "cd '$T' && npm ci --no-audit --no-fund && npm run build && echo BUILD-OK && node -e \"const D=require('better-sqlite3');new D(':memory:');console.log('better-sqlite3 loads')\"; echo EXIT=\$?" \
      > "$E/logs/build.log" 2>&1 < /dev/null &
    sleep 1; echo "orchestrator build started detached (log: stack.sh logs build)" ;;
  rebuild)
    # after a change to src/ only: tsc without the npm ci
    : > "$E/logs/build.log"
    setsid nohup bash -c "cd '$T' && npm run build && echo BUILD-OK; echo EXIT=\$?" > "$E/logs/build.log" 2>&1 < /dev/null &
    sleep 1; echo "orchestrator rebuild (tsc) started detached (log: stack.sh logs build)" ;;
  backend) write_env "${2:-mock}" ;;
  harness)
    case "${2:-}" in
      pi|claude) { grep -v '^TAI_HARNESS=' "$T/.env" 2>/dev/null; echo "TAI_HARNESS=$2"; } > "$T/.env.new" && mv "$T/.env.new" "$T/.env" && chmod 600 "$T/.env"; echo "harness: $2" ;;
      "") echo "harness: $(grep '^TAI_HARNESS=' "$T/.env" 2>/dev/null | cut -d= -f2- | grep . || echo 'pi (default)')" ;;
      *) echo "stack.sh harness pi | claude" ;;
    esac ;;
  orchenv)
    # set values in orch.env WITHOUT restarting the orchestrator (the harness's tai.orch_env restarts it): stack.sh orchenv KEY=VALUE ... ; no
    # arguments: show the file. A harness run leaves its settings there (IDLE_TIMEOUT, TAI_COMPILE_ON_START, CONTAINER_IMAGE ...): reset them
    # with this after a run, as the next start of the orchestrator reads them.
    ensure_orch_env
    shift
    for kv in "$@"; do
      k="${kv%%=*}"
      { grep -v "^$k=" "$ORCH_ENV" 2>/dev/null; echo "$kv"; } > "$ORCH_ENV.new" && mv "$ORCH_ENV.new" "$ORCH_ENV"
    done
    tr '\n' ' ' < "$ORCH_ENV"; echo ;;
  mocks) start_mocks ;;
  litellm) start_litellm ;;
  orch)
    case "${2:-status}" in
      start) orch_start ;;
      stop) orch_stop ;;
      restart) orch_stop; orch_start ;;
      *) echo "orch start|stop|restart" ;;
    esac ;;
  logs) tail -n "${3:-25}" "$E/logs/${2:-orchestrator}.log" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-240 ;;
  leanragdbg)
    # why would the knowledge tool be missing inside an agent container?
    echo "-- host side: $(ls -la "$T/leanrag/graph.pkl" "$T/leanrag/stub_corpus.json" 2>&1 | cut -c1-110 | tr '
' ' ')"
    docker run --rm --entrypoint sh -v "$T/leanrag:/workspace/leanrag:ro" tai-agent:eval -c 'ls -la /workspace/leanrag | head -20; echo "--- python import:"; cd /workspace && PYTHONPATH=/workspace /opt/leanrag/bin/python3 -c "import leanrag.mcp_server; print(\"import ok\")" 2>&1 | tail -12; echo "--- query:"; PYTHONPATH=/workspace /opt/leanrag/bin/python3 -c "from leanrag.query import query_knowledge; r=query_knowledge(\"Raft split votes\", top_k=3); print(len(r[\"source_texts\"]), \"source chunks;\", r[\"seed_entities\"][:2])" 2>&1 | tail -8' ;;
  gwenv)
    # settings of the gateway (read when it starts), e.g.  stack.sh gwenv TAI_QWEN_TPM_BUDGET 100 ; stack.sh gwenv --clear ; stack.sh gwenv
    if [ "${2:-}" = "--clear" ]; then : > "$E/gateway.env"; echo "gateway.env cleared"
    elif [ -n "${2:-}" ] && [ -n "${3:-}" ]; then
      { grep -v "^$2=" "$E/gateway.env" 2>/dev/null; echo "$2=$3"; } > "$E/gateway.env.new"; mv "$E/gateway.env.new" "$E/gateway.env"; echo "gateway.env: $2=$3"
    else cat "$E/gateway.env" 2>/dev/null; fi ;;
  fallbacktest)
    # does gpt-oss answer when qwen cannot? (harness/fallback.py). `fallbacktest budget` adds the budget case: first
    # `gwenv TAI_QWEN_TPM_BUDGET 100`, restart the gateway (`litellm`), and `gwenv --clear` afterwards. `fallbacktest chat` (or
    # `fallbacktest budget chat`) uses the OpenAI chat-completions route, the one pi speaks; without it the Anthropic one of Claude Code.
    docker run --rm --network nanoclaw-net -e SECRETS_ENV=/secrets.env -v "$SECRETS:/secrets.env:ro" -v "$E/logs:/logs" -v "$T/eval/harness:/probe:ro" \
      "$PY_IMAGE" python -u /probe/fallback.py "${2:-}" "${3:-}" ;;
  toolprobe)
    # empty-arguments tool calls: model or gateway? runs in a container on nanoclaw-net (it must reach tai-litellm by name); keys stay inside
    docker run --rm --network nanoclaw-net -e WORLD_ENV=/world.env -e SECRETS_ENV=/secrets.env -v "$HOME/cs6650-world/.env:/world.env:ro"       -v "$SECRETS:/secrets.env:ro" -v "$T/eval/harness:/probe:ro" "$PY_IMAGE" python -u /probe/toolcall_probe.py "${2:-qwen}" "${3:-8}" ;;
  unit)
    # TAi's own unit tests for the orchestrator (queue, db, ipc authorisation, container args, routing); the skills-engine tests are not about this.
    # Detached; read the per-file summary with: stack.sh unit-look
    rm -f "$E/logs/vitest.json"
    setsid nohup bash -c "cd '$T' && timeout 900 npx vitest run src/ container/agent-runner/test portal/web --reporter=json --outputFile='$E/logs/vitest.json'" > "$E/logs/vitest.out" 2>&1 < /dev/null &
    sleep 1; echo "unit tests started detached" ;;
  unit-look)
    [ -f "$E/logs/vitest.json" ] || { echo "not finished yet"; exit 0; }
    python3 - "$E/logs/vitest.json" "${2:-2}" "${3:-}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
show = int(sys.argv[2])       # failures to list per file: stack.sh unit-look 20 [only-files-containing]
only = sys.argv[3]
print("tests: %d passed, %d failed, %d total; files: %d" % (d["numPassedTests"], d["numFailedTests"], d["numTotalTests"], len(d["testResults"])))
for f in d["testResults"]:
    name = f["name"].split("/tai/")[-1].replace("container/agent-runner/", "runner/")
    bad = [a for a in f["assertionResults"] if a["status"] == "failed"]
    if only and only not in name:
        continue
    print("%-34s %3d passed %3d failed" % (name, sum(1 for a in f["assertionResults"] if a["status"] == "passed"), len(bad)))
    for a in bad[:show]:
        print("     FAIL:", a["fullName"][:90], "|", (a["failureMessages"][0] if a["failureMessages"] else "")[:230].replace("\n", " "))
PY
    ;;
  peek)
    echo "load: $(cut -d' ' -f1-3 /proc/loadavg)  $(free -m | awk '/^Mem:/ {print "mem used " $3 " MB, available " $7 " MB"}')  $(df -h / | tail -1 | awk '{print "disk used " $3 " of " $2}')"
    ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -6
    echo "image build log: $(wc -l < "$E/logs/build_image.log") lines; last: $(tail -n 1 "$E/logs/build_image.log" | cut -c1-120)" ;;
  down)
    orch_stop
    docker rm -f tai-mockllm tai-mocks tai-litellm >/dev/null 2>&1; docker ps -aq --filter "name=nanoclaw-" | xargs -r docker rm -f >/dev/null 2>&1
    echo "stack down" ;;
  status)
    echo "orchestrator: $( [ -n "$(orch_pid)" ] && echo "running pid $(orch_pid)" || echo stopped )"
    echo "web channel:  $(curl -fsS -m 2 http://127.0.0.1:8099/api/health 2>&1 | cut -c1-120)"
    # this stack's containers only (the live deployment's are tai-live-... and tailive-...)
    echo "containers:"; docker ps --format '  {{.Names}}  {{.Status}}' --filter "name=^tai-mockllm\$" --filter "name=^tai-mocks\$" --filter "name=^tai-litellm\$" --filter "name=^nanoclaw-"
    echo "env backend:  $(grep -E '^(ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|TAI_HARNESS|TAI_LLM_API)=' "$T/.env" 2>/dev/null | tr '\n' ' ')"
    echo "orch.env:     $(tr '\n' ' ' < "$ORCH_ENV" 2>/dev/null)"
    echo "build:        $(tail -n 2 "$E/logs/build.log" 2>/dev/null | tr '\n' ' ' | cut -c1-160)" ;;
  *) echo "see the header of this file" ;;
esac
