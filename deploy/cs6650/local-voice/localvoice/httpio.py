"""Just enough HTTP/1.1 for one loopback service whose two interfaces share a port: read a request head, answer with a fixed body, or hand the connection to the websocket code.

Why it is written here and not with a library: the recognizer is a websocket (`/v1/listen`) and the synthesizer is a plain `POST /tts` with a JSON body and a chunked answer, on the SAME port. The websocket
library's server (`websockets.asyncio`) parses the request head itself and does not read a request body, so a POST cannot go through it; the websocket handshake and framing are still its sans-I/O
`ServerProtocol` (wsconn.py), fed with the very bytes this module has read. Everything here is deliberately small and strict: a head is at most `MAX_HEAD` bytes, names are tokens, no folded lines, no
duplicated Content-Length, no chunked request bodies, one request per connection (`Connection: close` on every answer).

An error response is a fixed sentence: nothing the client sent is ever put into one.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from email.utils import formatdate
from urllib.parse import parse_qs, urlsplit

MAX_HEAD = 16 * 1024
_NAME = re.compile(r"^[!#$%&'*+\-.^_`|~0-9a-z]+$")

REASONS = {
    100: 'Continue', 200: 'OK', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 411: 'Length Required', 413: 'Payload Too Large',
    415: 'Unsupported Media Type', 426: 'Upgrade Required', 431: 'Request Header Fields Too Large', 500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
    505: 'HTTP Version Not Supported',
}


class HttpError(Exception):
    """A request that is answered with an error and a fixed message (never the client's own words)."""

    def __init__(self, status: int, message: str, headers: tuple = ()):
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers


@dataclass(frozen=True)
class Request:
    method: str
    target: str
    #: the path without its query: the only part of the address that is ever logged (a query can carry course terms)
    path: str
    query: dict
    version: str
    #: lower-case names
    headers: dict
    #: the exact bytes of the head, for the websocket library
    head: bytes


def parse_head(head: bytes) -> Request:
    """`head` ends with the blank line. Raises HttpError."""
    try:
        text = head[:-4].decode('latin-1')
    except Exception:
        raise HttpError(400, 'bad request') from None
    lines = text.split('\r\n')
    parts = lines[0].split(' ')
    if len(parts) != 3 or not parts[0].isalpha() or not parts[1]:
        raise HttpError(400, 'bad request line')
    method, target, version = parts
    if not version.startswith('HTTP/1.'):
        raise HttpError(505, 'only HTTP/1.x is spoken here')
    headers: dict = {}
    for line in lines[1:]:
        if not line or line[0] in ' \t' or ':' not in line:
            raise HttpError(400, 'bad header line')
        name, _, value = line.partition(':')
        name = name.lower()
        if not _NAME.match(name):
            raise HttpError(400, 'bad header name')
        value = value.strip()
        if name in headers:
            if name in ('content-length', 'host', 'content-type', 'transfer-encoding', 'upgrade', 'expect'):
                raise HttpError(400, 'a header that must appear once appears twice')
            headers[name] += ', ' + value
        else:
            headers[name] = value
    try:
        split = urlsplit(target)
        query = parse_qs(split.query, keep_blank_values=False, max_num_fields=200)
    except ValueError:
        raise HttpError(400, 'bad request target') from None
    return Request(method=method.upper(), target=target, path=split.path or '/', query=query, version=version, headers=headers, head=head)


async def read_request(reader: asyncio.StreamReader) -> Request | None:
    """The next request head, or None when the peer closed without sending anything. The reader's limit must be `MAX_HEAD`."""
    try:
        head = await reader.readuntil(b'\r\n\r\n')
    except asyncio.IncompleteReadError as exc:
        if not exc.partial:
            return None
        raise HttpError(400, 'the request ended early') from None
    except asyncio.LimitOverrunError:
        raise HttpError(431, 'the request header is too large') from None
    return parse_head(head)


def response_head(status: int, headers) -> bytes:
    lines = ['HTTP/1.1 %d %s' % (status, REASONS.get(status, 'Status')), 'Date: ' + formatdate(usegmt=True)]
    lines += ['%s: %s' % (k, v) for k, v in headers]
    lines += ['Connection: close', '', '']
    return '\r\n'.join(lines).encode('latin-1')


async def send_json(writer: asyncio.StreamWriter, status: int, body: dict, headers=()) -> None:
    data = json.dumps(body, separators=(',', ':')).encode('utf-8')
    writer.write(response_head(status, [('Content-Type', 'application/json'), ('Content-Length', str(len(data))), ('Cache-Control', 'no-store'), *headers]) + data)
    await writer.drain()


async def send_error(writer: asyncio.StreamWriter, status: int, message: str, headers=()) -> None:
    await send_json(writer, status, {'error': message}, headers)


async def close_quietly(writer: asyncio.StreamWriter, wait_s: float = 2.0) -> None:
    try:
        writer.close()
        await asyncio.wait_for(writer.wait_closed(), wait_s)
    except Exception:
        pass
