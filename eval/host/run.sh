#!/usr/bin/env bash
# Sync this fork to the box, then run one remote script from eval/host/remote/ with its arguments, e.g.:
#   run.sh stack.sh status        run.sh stack.sh backend mock        run.sh scenario.py --help
# A .py script runs with the box's python3, a .sh with bash.
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
bash "$(dirname "${BASH_SOURCE[0]}")/20_sync.sh" > /dev/null || { echo "sync failed"; exit 1; }
SCRIPT="$1"; shift
case "$SCRIPT" in
  harness/*.py) rssh "cd ~/tai-eval/tai/eval/harness && python3 -u ${SCRIPT#harness/} $*" ;;
  *.py)         rssh "python3 -u ~/tai-eval/tai/eval/host/remote/$SCRIPT $*" ;;
  *)            rssh "bash ~/tai-eval/tai/eval/host/remote/$SCRIPT $*" ;;
esac
