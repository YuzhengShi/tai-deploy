"""Every message of a group's conversation in order, from the session files of either harness (tai.session_rows): who said what, which tools
were called, what they returned. For a question like "was the answer the student got the whole answer?" (text the model wrote in a message
that also held tool calls is not the last message's text).
   python3 transcript.py FOLDER [max_chars=300]      python3 transcript.py latest PREFIX      (the newest group folder starting with PREFIX)"""
import os
import sys

import tai

folder = sys.argv[1]
if folder == "latest":
    prefix = sys.argv[2]
    folder = tai.sh("ls -td %s/groups/%s* 2>/dev/null | head -1 | xargs -r basename" % (tai.T, prefix))
    sys.argv = [sys.argv[0], folder] + sys.argv[3:]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 300
print("folder:", folder)
for i, row in enumerate(tai.session_rows(folder)):
    msg = row.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        content = [{"type": "text", "text": str(content)}]
    role = msg.get("role")
    for b in content:
        if b.get("type") == "text":
            print("[%2d] %-9s text: %s" % (i, role, b.get("text", "")[:limit].replace("\n", " / ")))
        elif b.get("type") == "tool_use":
            print("[%2d] %-9s CALL %s %s" % (i, role, b.get("name"), str(b.get("input"))[:limit].replace("\n", " / ")))
        elif b.get("type") == "tool_result":
            print("[%2d] %-9s RESULT%s %s" % (i, role, " (error)" if b.get("is_error") else "", str(b.get("content"))[:limit].replace("\n", " / ")))
