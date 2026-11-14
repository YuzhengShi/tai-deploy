"""What may be written to a log, and what may not.

The rule of this service: no transcript, no text of a synthesis request and no audio is ever written to a log, an error message or a file; the log carries counts, durations and connection events. Two
things make that more than a promise:

* an exception is described by its CLASS NAME and the place it was raised (`describe`), never by `str(exc)` or a traceback: the message of an exception raised while handling a request can hold the very
  text being handled (the speech engine's "unsupported character" error lists the characters of the request);
* the libraries we embed get a logger that is switched off (`SILENT`): the websocket library formats frame payloads (our transcripts and our audio) at DEBUG and exception text at ERROR.
"""
import logging
import os

LOG = logging.getLogger('localvoice')

# A logger that never emits. `isEnabledFor` answers False for a disabled logger, so the library does not even build its debug strings. It is not registered with the logging manager on purpose:
# `logging.getLogger(...)` would hand back a shared object that some other code could re-enable.
SILENT = logging.Logger('localvoice.silent')
SILENT.disabled = True


def describe(exc: BaseException) -> str:
    """`ClassName at file.py:123` for the innermost frame: where it happened, never what it carried."""
    tb = exc.__traceback__
    where = '?'
    while tb is not None:
        where = '%s:%d' % (os.path.basename(tb.tb_frame.f_code.co_filename), tb.tb_lineno)
        tb = tb.tb_next
    return '%s at %s' % (type(exc).__name__, where)


def loop_exception_handler(loop, context) -> None:
    """asyncio's default handler logs the traceback of an exception nobody caught, message and all; this one logs what asyncio says it was and the class and place of the exception. A peer that went
    away (a reset or aborted connection: on Windows asyncio reports it from inside its own callbacks) is not a fault of ours and is logged at DEBUG."""
    exc = context.get('exception')
    detail = ' (%s)' % describe(exc) if isinstance(exc, BaseException) else ''
    level = logging.DEBUG if isinstance(exc, ConnectionError) else logging.WARNING
    LOG.log(level, 'asyncio: %s%s', context.get('message', 'an error'), detail)


def silence_libraries() -> None:
    """Called once the models are loaded: from then on nothing a library formats can reach our handlers (the speech package logs at INFO while it loads and builds strings from its inputs when it fails)."""
    for name in ('supertonic', 'websockets'):
        logging.getLogger(name).setLevel(logging.CRITICAL + 10)
