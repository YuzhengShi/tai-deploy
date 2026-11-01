#!/usr/bin/env bash
# Runs ON the box: the current outbound filter over the replies saved in ~/tai-eval/results (needs stack.sh rebuild to have compiled src/router.ts).
export PATH="$HOME/tai-eval/node/bin:$PATH"
node "$HOME/tai-eval/tai/eval/harness/replay_filter.mjs"
