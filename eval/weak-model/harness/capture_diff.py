"""Round 2, pilot only: compare the requests the capturing relay kept (llm_relay_capture.py). Prints, per request: time, size, number of
messages, tools; and for consecutive chat requests (with tools), where their system text and their tool list first differ.
  python3 capture_diff.py DIR
"""
import glob
import json
import os
import sys


def requests_in(path):
    data = open(path, "rb").read()
    out = []
    while data:
        head, sep, rest = data.partition(b"\r\n\r\n")
        if not sep:
            break
        lines = head.decode("latin-1").split("\r\n")
        length = 0
        for l in lines[1:]:
            k, _, v = l.partition(":")
            if k.strip().lower() == "content-length":
                length = int(v.strip())
        body, data = rest[:length], rest[length:]
        try:
            out.append((lines[0], json.loads(body)))
        except ValueError:
            out.append((lines[0], None))
    return out


def first_diff(a, b):
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return i
    return None if len(a) == len(b) else min(len(a), len(b))


def main():
    reqs = []
    for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.req"))):
        for line, body in requests_in(p):
            if body and body.get("tools"):
                reqs.append((os.path.basename(p), body))
    print(len(reqs), "requests with tools")
    prev = None
    for name, body in reqs:
        msgs = body.get("messages") or []
        system = msgs[0].get("content") if msgs and msgs[0].get("role") == "system" else ""
        if isinstance(system, list):
            system = "".join(x.get("text", "") for x in system)
        tools = body.get("tools") or []
        names = [t.get("function", {}).get("name") for t in tools]
        user = msgs[1].get("content") if len(msgs) > 1 else ""
        if isinstance(user, list):
            user = "".join(x.get("text", "") for x in user)
        print("\n%s: %d messages, %d tools, system %d chars, first user %d chars, temperature %s, max_tokens %s" % (
            name, len(msgs), len(tools), len(system), len(user), body.get("temperature"), body.get("max_tokens") or body.get("max_completion_tokens")))
        if prev:
            ps, pt = prev
            d = first_diff(ps, system)
            print("  system vs previous: %s" % ("same" if d is None else "differs at char %d: %r / %r" % (d, ps[max(0, d - 60):d + 80], system[max(0, d - 60):d + 80])))
            pn = [t.get("function", {}).get("name") for t in pt]
            if pn != names:
                print("  tool ORDER/SET differs: first at index %s: %s vs %s" % (first_diff(pn, names), pn[first_diff(pn, names) or 0:][:4], names[first_diff(pn, names) or 0:][:4]))
            else:
                for i, (x, y) in enumerate(zip(pt, tools)):
                    if x != y:
                        sx, sy = json.dumps(x, ensure_ascii=False), json.dumps(y, ensure_ascii=False)
                        j = first_diff(sx, sy)
                        print("  tool %d (%s) differs at char %d: %r / %r" % (i, names[i], j, sx[max(0, j - 80):j + 80], sy[max(0, j - 80):j + 80]))
                        break
                else:
                    print("  tools: same")
        prev = (system, tools)


if __name__ == "__main__":
    main()
