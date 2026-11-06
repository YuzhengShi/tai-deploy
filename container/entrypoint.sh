#!/bin/bash
# Agent container entrypoint. The initial input and follow-up messages arrive on stdin (NDJSON); exec replaces bash so node
# inherits stdin directly from Docker.
#
# TAI_HARNESS picks what runs the conversation: pi (default, dist/pi-runner.js) or claude (Claude Code through the Agent SDK,
# dist/index.js). Both speak the same container protocol (agent-runner/src/protocol.ts).
#
# TAI_MODE=tool-host runs no conversation at all: the container starts the MCP servers and answers the host's tool calls over the same
# stdin and stdout (dist/tool-host.js, docs/VOICE.md). It takes precedence over TAI_HARNESS.
set -e
case "${TAI_HARNESS:-pi}" in
  pi) ENTRY=pi-runner ;;
  claude) ENTRY=index ;;
  *) echo "unknown TAI_HARNESS=${TAI_HARNESS} (pi or claude)" >&2; exit 2 ;;
esac
case "${TAI_MODE:-}" in
  "") ;;
  tool-host) ENTRY=tool-host ;;
  *) echo "unknown TAI_MODE=${TAI_MODE} (unset or tool-host)" >&2; exit 2 ;;
esac
if [ "${TAI_COMPILE_ON_START:-}" = "1" ]; then
  # Development: compile the agent-runner source the host mounts at /app/src instead of running the dist built into the image.
  cd /app && npx tsc --outDir /tmp/dist 1>&2
  ln -s /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  exec node "/tmp/dist/${ENTRY}.js"
fi
exec node "/app/dist/${ENTRY}.js"
