#!/usr/bin/env bash
# Round 2 of the weak-model experiment (amendment A2 of D:\tai-paper\review\plan\weak-model-criteria.md). Runs ON the CS6650 host, from
# ~/tai-weak/bin. W2 = Qwen3-4B-Instruct-2507 Q4_K_M on the owner's PC (llama.cpp b12061, Vulkan), reached through the PC's reverse SSH
# tunnel to the unix socket ~/tai-weak/sock/llm.sock and the relay container below. Everything here is round 1's scratch stack
# (weak_stack.sh: directory ~/tai-weak, tree ~/tai-weak/tai, network tai-weak-net, ports 8299 and 4099, prefix taiweak) plus:
#   - tai-weak-llmrelay: TCP 18080 on tai-weak-net (alias tai-weak-llm) -> the tunnel's socket (eval/harness/llm_relay.py);
#   - the gateway config gw2/config.yaml: one alias, weak-qwen3-4b, with hour-long waits; the callbacks file unchanged, plus a second
#     callback (eval/harness/r2_canon.py) that puts the MCP tools in one fixed order (pi lists them in the order its servers connect);
#   - the agent image stays tai-agent:weakmodel-pin (8843b5757594); ONE of its files is covered by a read-only bind mount:
#     /app/dist/pi-runner.js, the image's own file with its two 120 s waits (provider timeoutMs, httpIdleTimeoutMs) set to 3600 s
#     (~/tai-weak/r2/pi-runner.js); the mount is one line added to the scratch tree's dist/container-runner.js, active only when
#     TAI_R2_PI_RUNNER is set (round 1's orch.env never sets it). A derived image was tried first: committing it on this host's
#     containerd store read the disk at 0.5 MB/s for 8 minutes and was stopped.
#   - the scratch tree's two host writers (dist/competency-writer.js, dist/student-state-writer.js): MODEL_TIMEOUT_MS 25 s -> 900 s.
#   The three changed dist files keep their originals as *.r1orig; `restore` puts them back. `patch` checks every diff's size.
# It never runs round 1's `prep` (that copies from live again); it never touches ~/tai-live, the live gateway, service, env or images.
# Keys: ~/tai-weak/local.env (LOCAL_LLM_KEY, the PC server's key, copied from the PC) and ~/tai-weak/secrets.env (the scratch gateway's
# own key). Never printed.
#
#   weak_stack_r2.sh patch | restore | relay | gateway | mocks | arm [ALIAS] | orch start|stop|restart | probe | llmup | status | down
set -u
W="$HOME/tai-weak"
T="$W/tai"
NODE_BIN="$HOME/tai-live/node/bin"
NET=tai-weak-net
GW=tai-weak-litellm
MOCKS=tai-weak-mocks
MOCKLLM=tai-weak-mockllm
RELAY=tai-weak-llmrelay
PIN=tai-agent:weakmodel-pin
AGENT_IMAGE_ID=8843b5757594
GW_IMAGE_ID=37e2dafb088a
PY_IMAGE=python:3.12-slim
WEB_PORT=8299
GW_PORT=4099
ALIAS=weak-qwen3-4b
mkdir -p "$W/logs" "$W/results" "$W/gw2" "$W/r2"

secret_key() {
  [ -s "$W/secrets.env" ] || ( umask 077; echo "LITELLM_MASTER_KEY=sk-weak-$(openssl rand -hex 24)" > "$W/secrets.env" )
  grep -m1 '^LITELLM_MASTER_KEY=' "$W/secrets.env" | cut -d= -f2-
}

patch() {
  [ "$(docker image inspect "$PIN" --format '{{.Id}}' | cut -c8-19)" = "$AGENT_IMAGE_ID" ] || { echo "the pin tag is not $AGENT_IMAGE_ID"; return 1; }
  # the two host writers: one constant each
  for f in competency-writer.js student-state-writer.js; do
    [ -f "$T/dist/$f.r1orig" ] || cp -p "$T/dist/$f" "$T/dist/$f.r1orig"
    sed 's/^const MODEL_TIMEOUT_MS = 25_000;$/const MODEL_TIMEOUT_MS = 900_000;/' "$T/dist/$f.r1orig" > "$T/dist/$f.new"
    n="$(diff "$T/dist/$f.r1orig" "$T/dist/$f.new" | grep -c '^[<>]')"
    [ "$n" = 2 ] || { echo "$f: expected one changed line, diff has $n lines"; rm -f "$T/dist/$f.new"; return 1; }
    mv "$T/dist/$f.new" "$T/dist/$f"
  done
  # pi's two waits: the image's own pi-runner.js, two constants changed, mounted read-only over it
  local cid; cid="$(docker create "$PIN")" || return 1
  docker cp "$cid:/app/dist/pi-runner.js" "$W/r2/pi-runner.r1orig.js" >/dev/null; docker rm "$cid" >/dev/null
  sed -e 's/provider: { timeoutMs: 120_000, maxRetries: 0 }/provider: { timeoutMs: 3_600_000, maxRetries: 0 }/' \
      -e 's/^\( *\)httpIdleTimeoutMs: 120_000,$/\1httpIdleTimeoutMs: 3_600_000,/' "$W/r2/pi-runner.r1orig.js" > "$W/r2/pi-runner.js"
  n="$(diff "$W/r2/pi-runner.r1orig.js" "$W/r2/pi-runner.js" | grep -c '^[<>]')"
  [ "$n" = 4 ] || { echo "pi-runner.js: expected two changed lines, diff has $n lines"; return 1; }
  chmod 444 "$W/r2/pi-runner.js"
  # the mount: one line after the agent-runner source mount of buildVolumeMounts, only when TAI_R2_PI_RUNNER is set
  [ -f "$T/dist/container-runner.js.r1orig" ] || cp -p "$T/dist/container-runner.js" "$T/dist/container-runner.js.r1orig"
  python3 - "$T/dist/container-runner.js.r1orig" "$T/dist/container-runner.js" <<'PY' || return 1
import sys
src = open(sys.argv[1], encoding="utf-8").read()
anchor = "        containerPath: '/app/src',\n        readonly: true,\n    });\n"
if src.count(anchor) != 1:
    sys.exit("container-runner.js: the agent-runner source mount was not found exactly once")
line = ("    // weak-model round 2 (A2): pi's two waits raised for the slow local model, one file over the image's own (only when set)\n"
        "    if (process.env.TAI_R2_PI_RUNNER) mounts.push({ hostPath: process.env.TAI_R2_PI_RUNNER, containerPath: '/app/dist/pi-runner.js', readonly: true });\n")
open(sys.argv[2], "w", encoding="utf-8").write(src.replace(anchor, anchor + line))
PY
  n="$(diff "$T/dist/container-runner.js.r1orig" "$T/dist/container-runner.js" | grep -c '^[<>]')"
  [ "$n" = 2 ] || { echo "container-runner.js: expected two added lines, diff has $n lines"; return 1; }
  ( cd "$T" && for f in competency-writer.js student-state-writer.js container-runner.js; do sha256sum "dist/$f.r1orig" "dist/$f"; done
    sha256sum "$W/r2/pi-runner.r1orig.js" "$W/r2/pi-runner.js"
    echo "agent image $PIN $(docker image inspect "$PIN" --format '{{.Id}}' | cut -c8-19)" ) > "$W/r2/patch-hashes.txt"
  ( diff "$W/r2/pi-runner.r1orig.js" "$W/r2/pi-runner.js"
    for f in competency-writer.js student-state-writer.js container-runner.js; do diff "$T/dist/$f.r1orig" "$T/dist/$f"; done ) > "$W/r2/patch.diff"
  echo "patched:"; cat "$W/r2/patch.diff"; echo "hashes in $W/r2/patch-hashes.txt"
}

restore() {
  for f in competency-writer.js student-state-writer.js container-runner.js; do
    [ -f "$T/dist/$f.r1orig" ] && mv "$T/dist/$f.r1orig" "$T/dist/$f" && echo "restored dist/$f"
  done
}

relay() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  mkdir -p "$W/sock"; chmod 700 "$W/sock"
  docker rm -f "$RELAY" >/dev/null 2>&1
  docker run -d --name "$RELAY" --network "$NET" --network-alias tai-weak-llm --memory 128m -v "$W/sock:/sock" \
    -v "$T/eval/harness/llm_relay.py:/app/llm_relay.py:ro" "$PY_IMAGE" python -u /app/llm_relay.py >/dev/null && echo "$RELAY started"
}

write_gw_config() {
  cp -p "$T/eval/litellm/tai_callbacks.py" "$W/gw2/tai_callbacks.py"
  cp -p "$T/eval/harness/r2_canon.py" "$W/gw2/r2_canon.py"      # the MCP tools in one fixed order (A2); content unchanged
  cat > "$W/gw2/config.yaml" <<'EOF'
# Round 2 of the weak-model experiment: one alias, the local model on the owner's PC (llama.cpp's OpenAI-compatible server) through the
# scratch relay. Waits of an hour: a cold prompt of 24k tokens takes about 15 minutes there (speed test 2026-11-16), and criteria 4.4
# counts a timeout as a provider fault. No retries and no fallback: a failure is logged as it happened.
model_list:
  - model_name: weak-qwen3-4b
    litellm_params:
      model: openai/qwen3-4b-instruct-2507
      api_base: http://tai-weak-llm:18080/v1
      api_key: os.environ/LOCAL_LLM_KEY
      timeout: 3600
      stream_timeout: 3600
litellm_settings:
  drop_params: true
  request_timeout: 3600
  callbacks: [tai_callbacks.proxy_handler_instance, r2_canon.handler]
router_settings:
  num_retries: 0
EOF
}

start_gateway() {
  local key
  key="$(secret_key)"
  [ -s "$W/local.env" ] || { echo "no $W/local.env (the PC server's key)"; return 1; }
  write_gw_config
  docker rm -f "$GW" >/dev/null 2>&1
  LITELLM_MASTER_KEY="$key" docker run -d --name "$GW" --network "$NET" --memory 1500m -p "127.0.0.1:$GW_PORT:4000" \
    --env-file "$W/local.env" -e LITELLM_MASTER_KEY -e GATEWAY_LOG=/logs/gateway.jsonl \
    -v "$W/gw2:/app/cfg:ro" -v "$W/logs:/logs" "$GW_IMAGE_ID" --config /app/cfg/config.yaml --port 4000 >/dev/null || { echo "gateway did not start"; return 1; }
  for i in $(seq 1 60); do
    if curl -fsS -m 3 "http://127.0.0.1:$GW_PORT/health/liveliness" >/dev/null 2>&1; then echo "$GW up after $((i * 3)) s"; return 0; fi
    sleep 3
  done
  echo "$GW did not come up; last log lines:"; docker logs --tail 10 "$GW" 2>&1 | sed -E 's/sk-[A-Za-z0-9_-]+/sk-REDACTED/g' | cut -c1-200
}

start_mocks() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  docker rm -f "$MOCKS" "$MOCKLLM" >/dev/null 2>&1
  docker run -d --name "$MOCKS" --network "$NET" --network-alias github.eval --memory 300m -v "$W/logs:/logs" -v "$W/data:/data:ro" \
    -v "$T/eval/mock_services.py:/app/mock_services.py:ro" "$PY_IMAGE" python /app/mock_services.py >/dev/null && echo "$MOCKS started"
  docker run -d --name "$MOCKLLM" --network "$NET" --memory 300m -v "$W/mockscripts:/scripts:ro" -v "$W/logs:/logs" \
    -v "$T/eval/mock_llm.py:/app/mock_llm.py:ro" "$PY_IMAGE" python /app/mock_llm.py >/dev/null && echo "$MOCKLLM started"
}

write_arm() {   # the same .env and orch.env as round 1's weak_stack.sh write_arm, except the lines marked A2
  local arm="${1:-$ALIAS}" key url api=""
  case "$arm" in "$ALIAS"|mock) ;; *) echo "unknown arm $arm"; return 1 ;; esac
  key="$(secret_key)"
  if [ "$arm" = mock ]; then url="http://$MOCKLLM:8000"; api="TAI_LLM_API=anthropic-messages"; else url="http://$GW:4000"; fi
  ( umask 077; cat > "$T/.env.new" <<EOF
ASSISTANT_NAME=TAi
ANTHROPIC_BASE_URL=$url
ANTHROPIC_AUTH_TOKEN=$key
ANTHROPIC_MODEL=$arm
ANTHROPIC_MODEL_LIGHT=$arm
ANTHROPIC_DEFAULT_SONNET_MODEL=$arm
ANTHROPIC_DEFAULT_HAIKU_MODEL=$arm
ANTHROPIC_DEFAULT_OPUS_MODEL=$arm
ANTHROPIC_SMALL_FAST_MODEL=$arm
TAI_LLM_MODEL=$arm
TAI_LLM_MAX_TOKENS=1536
TAI_HARNESS=pi
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
DISABLE_AUTOUPDATER=1
VOICE_INTERVIEW_SECRET=scratch-not-used
VOICE_BASE_URL=http://127.0.0.1:9/tai
TAI_DISABLED_TOOLS=youtube_info,youtube_transcript,generate_teaching_image,send_voice_message
CANVAS_API_TOKEN=fake-canvas-token-eval
CANVAS_BASE_URL=http://$MOCKS:8081/api/v1
CANVAS_COURSE_ID=1
GITHUB_TOKEN=fake-ghe-token-eval
GITHUB_TOKEN_PUBLIC=fake-gh-token-eval
GITHUB_BASE_URL=http://github.eval:8081/ghe/api/v3
GITHUB_BASE_URL_PUBLIC=http://$MOCKS:8081/public
GITHUB_ALLOWED_ORGS=cs6650-course
YOUTUBE_API_KEY=CANARY-YOUTUBE_API_KEY
YT_TRANSCRIPT_TOKEN=CANARY-YT_TRANSCRIPT_TOKEN
MS_EMAIL=CANARY-MS_EMAIL
MS_PASSWORD=CANARY-MS_PASSWORD
PIAZZA_EMAIL=CANARY-PIAZZA_EMAIL
PIAZZA_PASSWORD=CANARY-PIAZZA_PASSWORD
$api
EOF
  mv "$T/.env.new" "$T/.env"; chmod 600 "$T/.env" )
  ( umask 077; cat > "$W/orch.env.new" <<EOF
TAI_CHANNELS=web
TAI_WEB_PORT=$WEB_PORT
TAI_WEB_HOST=127.0.0.1
TAI_WEB_OUTBOX_LOG=0
CONTAINER_PREFIX=taiweak
CONTAINER_NETWORK=$NET
CONTAINER_IMAGE=$PIN
TAI_R2_PI_RUNNER=$W/r2/pi-runner.js
TAI_COMPILE_ON_START=0
TZ=America/Los_Angeles
LOG_LEVEL=debug
IDLE_TIMEOUT=60000
CONTAINER_TIMEOUT=3600000
MAX_CONCURRENT_CONTAINERS=2
TAI_MAX_CONCURRENT_TASKS=1
TAI_SEED_BOOTSTRAP=0
TAI_SEED_PATROL=0
TAI_STUDENT_COURSE_HOURS=0
TAI_COURSE_STATUS_HOURS=6
TAI_DOCS=0
TAI_CANVAS_DOCS=0
TAI_CHOICES_CHECK=0
TAI_PATROL_GATE=on
TAI_VOICE_LLM_URL=http://127.0.0.1:$GW_PORT
TAI_VOICE_LLM_KEY=$key
TAI_COMPETENCY_MODEL=$arm
TAI_STATE_MODEL=$arm
WEAK_ARM=$arm
EOF
  mv "$W/orch.env.new" "$W/orch.env"; chmod 600 "$W/orch.env" )
  echo "arm: $arm (image $PIN with pi-runner.js mounted over, container timeout 3600 s, max tokens 1536)"
}

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
  [ -n "$(orch_pid)" ] && kill -9 "$(orch_pid)" 2>/dev/null
  docker ps -q --filter "name=^taiweak-" | xargs -r docker rm -f >/dev/null 2>&1
  echo "orchestrator stopped"
}

orch_start() {
  [ -f "$T/.env" ] && [ -f "$W/orch.env" ] || { echo "no .env / orch.env yet: weak_stack_r2.sh arm"; return 1; }
  [ -n "$(orch_pid)" ] && { echo "orchestrator already running (pid $(orch_pid))"; return 0; }
  ( set -a; . "$W/orch.env"; set +a
    export PATH="$NODE_BIN:$PATH"
    cd "$T" || exit 1
    echo "=== start $(date -u '+%Y-%m-%dT%H:%M:%SZ') arm=$WEAK_ARM (round 2)" >> "$W/logs/orchestrator.log"
    setsid nohup node dist/index.js >> "$W/logs/orchestrator.log" 2>&1 < /dev/null & )
  for i in $(seq 1 40); do
    curl -fsS -m 2 "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null 2>&1 && { echo "orchestrator up (pid $(orch_pid)), web channel on 127.0.0.1:$WEB_PORT"; return 0; }
    sleep 1
  done
  echo "orchestrator did not answer on :$WEB_PORT; log tail:"; tail -n 15 "$W/logs/orchestrator.log" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-220
}

llmup() {   # is the local model reachable end to end (relay, tunnel, PC server)? prints "up <slots>" or "down <why>"; never a key
  local K; K="$(grep -m1 '^LOCAL_LLM_KEY=' "$W/local.env" 2>/dev/null | cut -d= -f2-)"
  K="$K" docker exec -e K "$GW" python3 -c '
import json, os, urllib.request
try:
    r = urllib.request.urlopen(urllib.request.Request("http://tai-weak-llm:18080/slots", headers={"Authorization": "Bearer " + os.environ["K"]}), timeout=15)
    s = json.loads(r.read())
    print("up", len(s), "slots,", sum(1 for x in s if x.get("is_processing")), "busy")
except Exception as e:
    print("down", type(e).__name__, str(e)[:120])
' 2>&1 | tail -1
}

probe() {   # a tiny answer and a tool round trip through the scratch gateway (prints the seconds, never a key)
  local key; key="$(secret_key)"
  KEY="$key" python3 - "$ALIAS" "http://127.0.0.1:$GW_PORT/v1/chat/completions" <<'PY'
import json, os, sys, time, urllib.request
alias, url = sys.argv[1], sys.argv[2]
def call(body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["KEY"]})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.loads(r.read()), time.time() - t
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:300]}, time.time() - t
a, s = call({"model": alias, "messages": [{"role": "user", "content": "Answer with one word: what colour is the sky on a clear day?"}], "max_tokens": 20})
print("answer: %.1f s -> %s" % (s, (a.get("choices") or [{}])[0].get("message", {}).get("content", a)))
print("usage:", a.get("usage"))
tools = [{"type": "function", "function": {"name": "get_due_date", "description": "Due date of an assignment", "parameters": {"type": "object", "properties": {"assignment": {"type": "string"}}, "required": ["assignment"]}}}]
m = [{"role": "user", "content": "When is Homework 6 due? Use the tool."}]
b, s = call({"model": alias, "messages": m, "tools": tools, "max_tokens": 200})
msg = (b.get("choices") or [{}])[0].get("message", {})
calls = msg.get("tool_calls") or []
print("tool call: %.1f s -> %s" % (s, [(c["function"]["name"], c["function"]["arguments"]) for c in calls] or b))
if calls:
    m += [msg, {"role": "tool", "tool_call_id": calls[0]["id"], "content": json.dumps({"due": "2026-11-18T07:59:00Z", "due_relative": "due in 3 days"})}]
    c, s = call({"model": alias, "messages": m, "tools": tools, "max_tokens": 200})
    print("after the tool: %.1f s -> %s" % (s, ((c.get("choices") or [{}])[0].get("message", {}).get("content") or c)))
PY
}

case "${1:-status}" in
  patch) patch ;;
  restore) restore ;;
  relay) relay ;;
  gateway) start_gateway ;;
  mocks) start_mocks ;;
  arm) write_arm "${2:-$ALIAS}" && orch_stop && orch_start ;;
  orch)
    case "${2:-}" in start) orch_start ;; stop) orch_stop ;; restart) orch_stop; orch_start ;; *) echo "orch start|stop|restart" ;; esac ;;
  probe) probe ;;
  llmup) llmup ;;
  status)
    echo "orchestrator: $(orch_pid || echo 'not running'); arm: $(grep -m1 '^WEAK_ARM=' "$W/orch.env" 2>/dev/null | cut -d= -f2-)"
    docker ps --format '{{.Names}} {{.Status}}' | grep -E '^(tai-weak-|taiweak-)' || echo "no scratch containers"
    echo "local model: $(llmup)"; echo "load: $(cut -d' ' -f1-3 /proc/loadavg)" ;;
  down)
    orch_stop
    docker rm -f "$GW" "$MOCKS" "$MOCKLLM" "$RELAY" >/dev/null 2>&1; echo "scratch stack down (network, tree, tags, results kept; run restore to put the writers back)" ;;
  *) echo "see the header of this file" ;;
esac
