#!/usr/bin/env bash
# Build TAi's agent image (container/Dockerfile, unchanged: Chromium, ffmpeg, yt-dlp, the LeanRAG python venv, claude-code ...) on the box
# as tai-agent:eval. The build is long and a silent ssh stream can drop, so it runs detached:
#   30_build_image.sh start | clean | rebuild | look | inspect [tag] | versions [tag]
# `clean` builds tai-agent:clean from the repository's Dockerfile with --no-cache: the proof that the Dockerfile itself builds (the
# mcp[cli]<2 pin and the precompiled entrypoint were first tried as a thin layer on tai-agent:eval).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
MODE="${1:-start}"
rssh "bash -s -- $MODE ${2:-eval} ${3:-}" <<'REMOTE'
set -u
MODE="$1"
TAG="$2"
LOG=~/tai-eval/logs/build_image.log
LOGC=~/tai-eval/logs/build_image_clean.log
case "$MODE" in
start)
  if pgrep -f "docker build -t tai-agent:eval" >/dev/null; then echo "a build is already running"; exit 0; fi
  : > "$LOG"
  setsid nohup bash -c "date +%T; docker build -t tai-agent:eval ~/tai-eval/tai/container; echo EXIT=\$?; date +%T" > "$LOG" 2>&1 < /dev/null &
  sleep 2; echo "build started detached; log: $LOG" ;;
clean)
  if pgrep -f "docker build --no-cache -t tai-agent:clean" >/dev/null; then echo "a clean build is already running"; exit 0; fi
  : > "$LOGC"
  setsid nohup bash -c "date +%T; docker build --no-cache -t tai-agent:clean ~/tai-eval/tai/container; echo EXIT=\$?; date +%T" > "$LOGC" 2>&1 < /dev/null &
  sleep 2; echo "clean build (no cache) started detached; log: $LOGC" ;;
rebuild)
  # tai-agent:clean again WITH the cache: the heavy layers stay, only what follows a change to scripts/ or agent-runner/ is built
  if pgrep -f "docker build" >/dev/null; then echo "a docker build is running"; exit 0; fi
  : > "$LOGC"
  setsid nohup bash -c "date +%T; docker build -t tai-agent:clean ~/tai-eval/tai/container; echo EXIT=\$?; date +%T" > "$LOGC" 2>&1 < /dev/null &
  sleep 2; echo "cached rebuild of tai-agent:clean started detached; log: $LOGC" ;;
look)
  for L in "$LOG" "$LOGC"; do
    [ -s "$L" ] || continue
    echo "== $(basename "$L")"; tail -n 6 "$L" | cut -c1-200
  done
  pgrep -f "docker build" >/dev/null && echo "[a docker build is running]" || echo "[no docker build running]" ;;
inspect)
  # what the Dockerfile as it is put into the image: the compiled runner, the entrypoint, the pinned mcp
  docker run --rm --entrypoint sh tai-agent:$TAG -c 'echo "dist: $(ls /app/dist | tr "\n" " ")"; echo "entrypoint: $(grep -c TAI_COMPILE_ON_START /app/entrypoint.sh) mention(s) of TAI_COMPILE_ON_START; last line: $(tail -n 1 /app/entrypoint.sh)"; echo "mcp: $(/opt/leanrag/bin/pip list 2>/dev/null | grep -i "^mcp ")"; echo "user: $(id -un)"' 2>&1 | cut -c1-200 ;;
loadtime)
  # how long a fresh node takes to load pi (seconds from process start, as process.uptime() says), three times plain and three times with
  # node's compile cache (NODE_COMPILE_CACHE: the first run fills it, the next ones read it)
  docker run --rm --entrypoint sh tai-agent:$TAG -c 'cd /app && T="await import(\"@earendil-works/pi-coding-agent\"); console.log(process.uptime().toFixed(2))"; echo "plain: $(for i in 1 2 3; do node --input-type=module -e "$T"; done | tr "\n" " ")"; export NODE_COMPILE_CACHE=/tmp/cc; echo "compile cache: $(for i in 1 2 3; do node --input-type=module -e "$T"; done | tr "\n" " ")"; du -sh /tmp/cc 2>/dev/null | cut -f1; nproc' 2>&1 | cut -c1-200 ;;
startup)
  # seconds from `docker run` (with the flags the orchestrator uses) to the first line the runner logs, three times, for one harness:
  #   30_build_image.sh startup clean pi | claude
  H="${3:-pi}"
  mkdir -p ~/tai-eval/startup-group
  docker rm -f startup-probe >/dev/null 2>&1
  for i in 1 2 3; do
    s=$(date +%s.%N)
    echo '{"prompt":"x","groupFolder":"startup","chatJid":"startup@web","isMain":false}' | timeout 60 docker run -i --rm --name startup-probe --cpus 1.0 --memory 2g --pids-limit 256 \
      --security-opt no-new-privileges --cap-drop ALL --tmpfs /tmp:size=512m,noexec -e TZ=UTC -e TAI_HARNESS=$H --network nanoclaw-net \
      -v ~/tai-eval/startup-group:/workspace/group tai-agent:$TAG 2>&1 | while read -r line; do
        case "$line" in *"Received input"*) e=$(date +%s.%N); echo "$H: first runner line after $(awk "BEGIN{printf \"%.1f\", $e-$s}") s"; docker kill startup-probe >/dev/null 2>&1; break ;; esac
      done
    sleep 3
  done ;;
versions)
  docker image inspect tai-agent:$TAG --format 'image {{.Id}} {{.Size}} bytes, created {{.Created}}' 2>&1 | cut -c1-200
  docker run --rm --entrypoint sh tai-agent:$TAG -c 'cd /app && echo "node $(node --version)"; echo "pi $(node -p "require(\"./node_modules/@earendil-works/pi-coding-agent/package.json\").version") (needs node 22.19 or later); rg: $(rg --version 2>&1 | head -1); fd: $(fdfind --version 2>&1 | head -1); runners: $(ls dist | grep -E "^(index|pi-runner).js" | tr "\n" " ")"; echo "sdk $(node -p "require(\"./node_modules/@anthropic-ai/claude-agent-sdk/package.json\").version")"; ls node_modules/@anthropic-ai; (claude --version 2>&1 | head -1); echo "global claude-code: $(ls /usr/local/lib/node_modules/@anthropic-ai 2>/dev/null)"; echo "cli bundled in the sdk (the one the SDK runs): $(ls node_modules/@anthropic-ai/claude-agent-sdk | grep -E "^cli" | tr "\n" " ")"; node node_modules/@anthropic-ai/claude-agent-sdk/cli.js --version 2>&1 | head -1' 2>&1 | cut -c1-200 ;;
esac
REMOTE
