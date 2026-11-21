"""Round 2 of the weak-model experiment: the scratch relay between the scratch gateway and the PC's local model server.

Runs in its own container (tai-weak-llmrelay, image python:3.12-slim, network tai-weak-net, alias tai-weak-llm). It accepts TCP on
port 18080 inside tai-weak-net and pipes each connection to the unix socket that the PC's reverse SSH tunnel keeps in the host's
scratch area (~/tai-weak/sock/llm.sock, mounted at /sock). It reads and changes nothing: bytes in, bytes out. When either side closes,
both are closed (HTTP never half-closes, so the other direction has nothing left to say).
"""
import asyncio
import os
import sys
import time

SOCK = os.environ.get("RELAY_SOCK", "/sock/llm.sock")
PORT = int(os.environ.get("RELAY_PORT", "18080"))


def log(msg):
    print("%s %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg), flush=True)


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
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
    tasks = [asyncio.create_task(pipe(client_r, up_w)), asyncio.create_task(pipe(up_r, client_w))]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for w in (client_w, up_w):
        try:
            w.close()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle, "0.0.0.0", PORT)
    log("relay on :%d -> %s" % (PORT, SOCK))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
