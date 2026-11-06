"""The gateway's own log, one line per upstream call (event ok/fail/spill, model, tokens, status, error): the evidence of what the gateway did
to a request, whatever the client says.   python3 gwlog.py [N=30] [seconds_back]      (read-only)"""
import sys
import time

import tai

n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
back = float(sys.argv[2]) if len(sys.argv) > 2 else 3600
rows = tai.gateway_log(time.time() - back)[-n:]
for r in rows:
    print("%s %-5s %-16s in=%s cached=%s out=%s status=%s %s" % (
        time.strftime("%H:%M:%S", time.localtime(r.get("ts", 0))), r.get("event"), r.get("model"), r.get("in"), r.get("cached"), r.get("out"),
        r.get("status"), tai.mask(str(r.get("error") or ""))[:300]))
