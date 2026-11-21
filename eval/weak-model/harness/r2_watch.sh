#!/usr/bin/env bash
# Round 2: one watcher for the overnight counted run (run on the PC in the background; it exits, with one line saying why, when):
#   the run log on the host says done / stopped / Traceback; more than 4 runs were INVALID; the PC's server is down; or the PC has had
#   under 200 MB available for three readings in a row (6 minutes: it is swapping hard). Polls once a minute.
H="${TAI_HOST:?set TAI_HOST to user@host}"
TAG=${1:-r2main}
low=0
while true; do
  log="$(ssh -o BatchMode=yes -o ConnectTimeout=20 "$H" "cat ~/tai-weak/results/run-$TAG.log 2>/dev/null" 2>/dev/null)"
  if [ -n "$log" ]; then
    if printf '%s\n' "$log" | grep -qE '^done:'; then echo "DONE: $(printf '%s\n' "$log" | grep -c 'attempt') attempts, $(printf '%s\n' "$log" | grep -c INVALID) invalid"; exit 0; fi
    if printf '%s\n' "$log" | grep -qE 'Traceback|stopped|SystemExit'; then echo "STOPPED: $(printf '%s\n' "$log" | tail -n 3 | tr '\n' ' ')"; exit 1; fi
    inv=$(printf '%s\n' "$log" | grep -c INVALID)
    if [ "$inv" -gt 4 ]; then echo "INVALID x$inv: $(printf '%s\n' "$log" | grep INVALID | tail -n 2 | tr '\n' ' ')"; exit 2; fi
  fi
  last="$(tail -n 1 /d/tai-local-llm/r2/ramlog.log 2>/dev/null)"
  case "$last" in *server=DOWN*) echo "SERVER DOWN: $last"; exit 3 ;; esac
  if [ "$last" != "${seen:-}" ]; then                 # count each 2-minute reading once
    seen="$last"
    avail=$(printf '%s' "$last" | sed -n 's/.*avail_mb=\(-\{0,1\}[0-9]*\).*/\1/p')
    if [ -n "$avail" ] && [ "$avail" -ge 0 ] && [ "$avail" -lt 200 ]; then low=$((low + 1)); else low=0; fi
  fi
  if [ "$low" -ge 3 ]; then echo "LOW MEMORY: $last"; exit 4; fi
  sleep 60
done
