#!/usr/bin/env bash
# Build TAi's agent image (container/Dockerfile, unchanged: Chromium, ffmpeg, yt-dlp, the LeanRAG python venv, claude-code ...) on the box
# as tai-agent:eval. The build is long and a silent ssh stream can drop, so it runs detached:
#   30_build_image.sh start | look | versions
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
MODE="${1:-start}"
rssh "bash -s -- $MODE" <<'REMOTE'
set -u
MODE="$1"
LOG=~/tai-eval/logs/build_image.log
case "$MODE" in
start)
  if pgrep -f "docker build -t tai-agent:eval" >/dev/null; then echo "a build is already running"; exit 0; fi
  : > "$LOG"
  setsid nohup bash -c "date +%T; docker build -t tai-agent:eval ~/tai-eval/tai/container; echo EXIT=\$?; date +%T" > "$LOG" 2>&1 < /dev/null &
  sleep 2; echo "build started detached; log: $LOG" ;;
look)
  if pgrep -f "docker build -t tai-agent:eval" >/dev/null; then echo "[still building]"; else echo "[not running]"; fi
  tail -n 12 "$LOG" | cut -c1-200 ;;
versions)
  docker image inspect tai-agent:eval --format 'image {{.Id}} {{.Size}} bytes, created {{.Created}}' 2>&1 | cut -c1-200
  docker run --rm --entrypoint sh tai-agent:eval -c 'cd /app && echo "node $(node --version)"; echo "sdk $(node -p "require(\"./node_modules/@anthropic-ai/claude-agent-sdk/package.json\").version")"; ls node_modules/@anthropic-ai; (claude --version 2>&1 | head -1); echo "global claude-code: $(ls /usr/local/lib/node_modules/@anthropic-ai 2>/dev/null)"; echo "cli bundled in the sdk (the one the SDK runs): $(ls node_modules/@anthropic-ai/claude-agent-sdk | grep -E "^cli" | tr "\n" " ")"; node node_modules/@anthropic-ai/claude-agent-sdk/cli.js --version 2>&1 | head -1' 2>&1 | cut -c1-200 ;;
esac
REMOTE
