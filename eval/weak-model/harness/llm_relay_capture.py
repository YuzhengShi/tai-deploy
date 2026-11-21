"""Round 2, pilot only (never in a counted run): llm_relay.py that also keeps what the gateway sends upstream (the request bytes of
each connection, up to 4 MB) in /capture, to compare two students' prompts byte by byte. Synthetic students only; the files are
the scratch gateway's requests to the local model (persona, tool schemas, the synthetic student's messages). Responses are not kept.
"""
import asyncio
import os
import time

SOCK = os.environ.get("RELAY_SOCK", "/sock/llm.sock")
PORT = int(os.environ.get("RELAY_PORT", "18080"))
CAP = os.environ.get("RELAY_CAPTURE", "/capture")
N = [0]


def log(msg):
    print("%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg), flush=True)


async def pipe(reader, writer, keep=None):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            if keep is not None and keep.tell() < 4 << 20:
                keep.write(data)
                keep.flush()
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass


async def handle(client_r, client_w):
    try:
        up_r, up_w = await asyncio.open_unix_connection(SOCK)
    except OSError as exc:
        log("no tunnel: %s" % exc)
        client_w.close()
        return
    N[0] += 1
    keep = open(os.path.join(CAP, "%d-%04d.req" % (int(time.time()), N[0])), "wb")
    tasks = [asyncio.create_task(pipe(client_r, up_w, keep)), asyncio.create_task(pipe(up_r, client_w))]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    keep.close()
    for w in (client_w, up_w):
        try:
            w.close()
        except Exception:
            pass


async def main():
    os.makedirs(CAP, exist_ok=True)
    server = await asyncio.start_server(handle, "0.0.0.0", PORT)
    log("capturing relay on :%d -> %s, requests to %s" % (PORT, SOCK, CAP))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
