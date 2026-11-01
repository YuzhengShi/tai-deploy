#!/usr/bin/env bash
# Read-only looks at what the stack did, for when a harness run does not behave. Runs ON the box.
#   diag.sh errors [N]       the last N warning/error lines of the orchestrator log (default 40), colours stripped
#   diag.sh events [N]       the last N lines about containers starting, answering, exiting (default 60)
#   diag.sh around PATTERN   the orchestrator log lines around the first match of PATTERN (30 before, 30 after)
#   diag.sh load             load, memory, docker containers and the biggest processes
#   diag.sh runner FOLDER    the last lines the agent runner logged for a group
set -u
E="$HOME/tai-eval"
LOG="$E/logs/orchestrator.log"
strip() { sed 's/\x1b\[[0-9;]*m//g' | cut -c1-260; }
case "${1:-errors}" in
  errors) strip < "$LOG" | grep -iE "\bwarn|\berror|fail|timed out|timeout|exited with|code [1-9]|killed" | tail -n "${2:-40}" ;;
  events) strip < "$LOG" | grep -E "Spawning container|Agent output|Container (completed|exited|timed)|Starting container|Session initialized|closing container|Processing messages|piping|Piping" | tail -n "${2:-60}" ;;
  around)
    n=$(strip < "$LOG" | grep -n -m1 -E "${2:?pattern}" | cut -d: -f1)
    [ -n "$n" ] || { echo "no match"; exit 0; }
    strip < "$LOG" | sed -n "$((n > 30 ? n - 30 : 1)),$((n + 30))p" ;;
  load)
    echo "load: $(cut -d' ' -f1-3 /proc/loadavg)  $(free -m | awk '/^Mem:/ {print "mem used " $3 " MB, available " $7 " MB"}')"
    docker ps --format '{{.Names}}  {{.Status}}' | head -20
    ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -8
    echo "vmstat (b = blocked on io, wa = io wait %):"; vmstat 1 4 | tail -5 ;;
  runner)
    f=$(ls -t "$HOME/tai-eval/tai/groups/${2:?folder}/logs/"container-*.log 2>/dev/null | head -1)
    [ -n "$f" ] && { echo "$f"; tail -n 40 "$f" | cut -c1-240; } || echo "no container log for $2" ;;
  *) sed -n 2,9p "$0" ;;
esac
