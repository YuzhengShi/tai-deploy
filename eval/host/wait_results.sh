#!/usr/bin/env bash
# Wait on the box until N result files matching a pattern exist (silent until then), so that one terminal read can span a long run.
#   wait_results.sh 'scenarios-seq-2*.json' 2 [max-minutes]
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
PATTERN="$1"; WANT="${2:-1}"; MAX="${3:-90}"
rssh "for i in \$(seq 1 $((MAX * 6))); do n=\$(ls ~/tai-eval/results/$PATTERN 2>/dev/null | wc -l); [ \"\$n\" -ge $WANT ] && { echo \"found \$n file(s) for $PATTERN\"; ls ~/tai-eval/results/$PATTERN; exit 0; }; sleep 10; done; echo \"gave up after $MAX minutes\"; exit 1"
