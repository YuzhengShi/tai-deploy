"""Print saved results compactly: python3 show.py guards [--bad] [--tag GROUPPREFIX]

For `guards`, every saved run is merged (the newest result for a group+case wins) so a run per group reads as one table."""
import glob
import json
import sys

import tai

kind = sys.argv[1] if len(sys.argv) > 1 else "guards"
only_bad = "--bad" in sys.argv
prefix = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else ""
rows = {}
for path in sorted(glob.glob("%s/%s-2*.json" % (tai.RESULTS, kind))):
    for r in json.load(open(path)):
        rows[(r.get("group", ""), r.get("case", ""))] = r
shown = 0
for (g, c), r in sorted(rows.items()):
    if prefix and not g.startswith(prefix):
        continue
    if only_bad and r["verdict"] == "OK":
        continue
    shown += 1
    print("%-26s %-30s %-14s %s -> %s" % (g[:26], c[:30], r["verdict"][:14], r["expected"][:44], r["observed"][:120]))
print("%d rows shown of %d (%d not OK)" % (shown, len(rows), sum(1 for r in rows.values() if r["verdict"] != "OK")))
