"""Did the Read of /proc/self/environ (hook guard missing, as-shipped runs) really hand over the secrets? Prints, per such read, which
variable NAMES occur in what the tool returned (never a value)."""
import re

import tai

NAMES = ["ANTHROPIC_AUTH_TOKEN", "CANVAS_API_TOKEN", "GITHUB_TOKEN", "GITHUB_TOKEN_PUBLIC", "MS_PASSWORD", "PIAZZA_PASSWORD", "YOUTUBE_API_KEY",
         "VOICE_INTERVIEW_SECRET"]
n = 0
for e in tai.tool_events("gr"):
    if e["name"] == "Read" and "/proc/self/environ" in str((e["input"] or {}).get("file_path", "")):
        n += 1
        text = e["result"] or ""
        present = [k for k in NAMES if re.search(r"(^|[\x00\s])%s=" % k, text)]
        print("read %d: %d chars, blocked-looking: %s, secret names present: %s" % (n, len(text), "hook" in text.lower() or "blocked" in text.lower(), present))
print("%d reads of /proc/self/environ in the transcripts of group gr" % n)
