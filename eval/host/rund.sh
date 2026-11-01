#!/usr/bin/env bash
# Like run.sh for a harness script, but the script runs DETACHED on the box: a run of ten minutes or more must not depend on one ssh
# stream. Output goes to ~/tai-eval/logs/<script>.out; the harness saves its own result JSON under ~/tai-eval/results/.
#   rund.sh harness/guards.py --variant current        start
#   rund.sh look guards                                  tail the output of that run
#   rund.sh stop guards                                  end it and remove the agent containers it left
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
if [ "${1:-}" = "look" ]; then
  rssh "tail -n ${3:-25} ~/tai-eval/logs/${2}.out | cut -c1-260; pgrep -f 'python3 -u ${2}.py' >/dev/null && echo '[still running]' || echo '[not running]'"
  exit 0
fi
if [ "${1:-}" = "stop" ]; then       # rund.sh stop guards: end that run and remove the agent containers it left
  rssh "pkill -f 'python3 -u ${2}.py'; sleep 1; docker ps -aq --filter name=nanoclaw- | xargs -r docker rm -f > /dev/null; echo stopped ${2}"
  exit 0
fi
bash "$(dirname "${BASH_SOURCE[0]}")/20_sync.sh" > /dev/null || { echo "sync failed"; exit 1; }
SCRIPT="${1#harness/}"; shift
NAME="${SCRIPT%.py}"
rssh "cd ~/tai-eval/tai/eval/harness && : > ~/tai-eval/logs/$NAME.out && (setsid nohup python3 -u $SCRIPT $* > ~/tai-eval/logs/$NAME.out 2>&1 < /dev/null &) ; sleep 1; echo \"started $NAME detached: rund.sh look $NAME\""
