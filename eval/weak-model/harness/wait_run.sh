#!/usr/bin/env bash
# Local waiter for a detached run on the host (Git Bash). Asks once a minute; the run itself never depends on this process.
# Exit codes: 0 done, 3 the run's process is gone without "done:", 5 three INVALID runs in a row (look now), 2 the host could not be reached
# 15 times in a row, 4 more than 9 hours.
#   bash wait_run.sh main
tag="${1:-main}"
H="${TAI_HOST:?set TAI_HOST to user@host}"
fails=0
for i in $(seq 1 540); do
  out=$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$H" "L=~/tai-weak/logs/run-$tag.log; P=~/tai-weak/run-$tag.pid;
    if grep -q '^done:' \$L 2>/dev/null; then echo DONE;
    elif ! kill -0 \$(cat \$P 2>/dev/null) 2>/dev/null; then echo DEAD;
    elif [ \$(grep -E ' run +[0-9]+ attempt' \$L | tail -n 3 | grep -c INVALID) -ge 3 ]; then echo TROUBLE;
    else echo RUNNING \$(grep -cE 'attempt [0-9]: ok' \$L); fi" 2>/dev/null)
  case "$out" in
    DONE) echo "done after $i min"; exit 0 ;;
    DEAD) echo "the run's process is gone without finishing"; exit 3 ;;
    TROUBLE) echo "three invalid runs in a row"; exit 5 ;;
    RUNNING*) fails=0 ;;
    *) fails=$((fails + 1)); [ "$fails" -ge 15 ] && { echo "host not reachable 15 times in a row"; exit 2; } ;;
  esac
  sleep 60
done
echo "still running after 9 hours"
exit 4
