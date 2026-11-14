#!/usr/bin/env python3
"""The local-voice service: LabGPU's recognizer (`/v1/listen`) and synthesizer (`POST /tts`) on one loopback port, backed by models on our own CPU. See README.md and docs/LOCAL_VOICE.md.

    python server.py            # settings from the environment (LOCAL_VOICE_*), listens on 127.0.0.1:18800

It loads and warms both models first and opens the port only then, so a health check that answers means a call can be served.
"""
import asyncio
import logging
import os
import signal
import sys

from localvoice import SERVICE, VERSION
from localvoice.asr import ModelError
from localvoice.config import Config, ConfigError
from localvoice.httpd import App
from localvoice.logutil import LOG, describe, silence_libraries
from localvoice.services import build_services

LOOPBACK = ('127.0.0.1', 'localhost', '::1')


async def serve(cfg: Config, services, stop: asyncio.Event | None = None, on_listen=None) -> None:
    """Runs until SIGTERM or SIGINT (or until `stop` is set: for tests). `on_listen(port)` is called once the port is open."""
    app = App(cfg, services)
    server = await app.start()
    host, port = server.sockets[0].getsockname()[:2]
    LOG.info('%s %s listening on %s:%d (pid %d, recognizer %s, synthesizer %s)', SERVICE, VERSION, host, port, os.getpid(), services.recognizer.name, services.tts.name)
    if cfg.host not in LOOPBACK:
        LOG.warning('bound to %s, not to loopback: this service has no authentication; publish its port on 127.0.0.1 only', cfg.host)
    if on_listen is not None:
        on_listen(port)
    stop = stop or asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass                        # Windows: Ctrl+C reaches asyncio.run as a KeyboardInterrupt instead
    await stop.wait()
    LOG.info('stopping')
    server.close()
    app.abort_all()
    try:
        await asyncio.wait_for(server.wait_closed(), 5)
    except asyncio.TimeoutError:
        pass


def main() -> int:
    try:
        cfg = Config.from_env(os.environ)
    except ConfigError as exc:
        print('local-voice: %s' % exc, file=sys.stderr)
        return 2
    logging.basicConfig(level=cfg.log_level, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stderr)
    try:
        services = build_services(cfg)
    except (ModelError, FileNotFoundError, RuntimeError, ValueError, ImportError) as exc:
        # at start-up only: these messages name paths from our own configuration, never request data
        LOG.error('cannot start: %s: %s', type(exc).__name__, exc)
        return 1
    silence_libraries()
    try:
        asyncio.run(serve(cfg, services))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        LOG.error('stopped: %s', describe(exc))
        return 1
    finally:
        services.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
