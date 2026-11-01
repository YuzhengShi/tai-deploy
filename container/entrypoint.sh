#!/bin/bash
# Agent container entrypoint. The initial input and follow-up messages arrive on stdin (NDJSON); exec replaces bash so node
# inherits stdin directly from Docker.
set -e
if [ "${TAI_COMPILE_ON_START:-}" = "1" ]; then
  # Development: compile the agent-runner source the host mounts at /app/src instead of running the dist built into the image.
  cd /app && npx tsc --outDir /tmp/dist 1>&2
  ln -s /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  exec node /tmp/dist/index.js
fi
exec node /app/dist/index.js
