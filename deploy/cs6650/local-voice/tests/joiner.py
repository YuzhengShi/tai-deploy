"""A Python port of the part of the lab's recognizer client that turns server messages into events: `readResults`, `addPiece` and `UtteranceJoiner` of src/voice/lab/ears/v1.ts (lines 443 to 517 and
501 to 517 of the version of 2026-11-14). The protocol tests feed the service's real messages to it and assert on the events it makes, because the TypeScript client cannot be run from this folder (the
checkout has no node_modules, so the `ws` package it imports is missing). The port is checked against the behaviours the TypeScript tests pin (test_joiner_port in test_protocol.py); if v1.ts changes,
this file must change with it.
"""
import re

_NOT_WORD = re.compile(r'[\W_]+', re.UNICODE)


def words_of(text):
    """Letters and digits of a text, lower case, one space between words."""
    return _NOT_WORD.sub(' ', text.lower()).strip()


def add_piece(pieces, text):
    have = words_of(' '.join(pieces))
    incoming = words_of(text)
    if have and (incoming == have or incoming.startswith(have + ' ')):
        return [text]
    return [*pieces, text]


def flag(value):
    return value is True or value == 'true'


def read_results(msg):
    channel = msg.get('channel')
    alternatives = channel.get('alternatives') if isinstance(channel, dict) else None
    first = alternatives[0] if isinstance(alternatives, list) and alternatives else None
    transcript = first.get('transcript') if isinstance(first, dict) else None
    return {
        'text': transcript if isinstance(transcript, str) else '',
        'is_final': flag(msg.get('is_final')),
        'speech_final': flag(msg.get('speech_final')),
        'from_finalize': flag(msg.get('from_finalize')),
    }


class UtteranceJoiner:
    def __init__(self):
        self.pieces = []

    @property
    def pending(self):
        return len(self.pieces) > 0

    def feed(self, result):
        text = result['text'].strip()
        if result['speech_final'] or result['from_finalize']:
            if text:
                self.pieces = add_piece(self.pieces, text)
            return self._release()
        if result['is_final']:
            if not text:
                return []
            self.pieces = add_piece(self.pieces, text)
            return [('partial', ' '.join(self.pieces))]
        return [('partial', ' '.join(add_piece(self.pieces, text)))] if text else []

    def flush(self):
        return self._release()

    def _release(self):
        text = ' '.join(self.pieces).strip()
        self.pieces = []
        return [('final', text)] if text else []


def events_of(messages):
    """What V1Ears.onText delivers to the engine for these messages: [('partial'|'final', text), ...]."""
    joiner = UtteranceJoiner()
    out = []
    for msg in messages:
        kind = msg.get('type')
        if kind == 'Results':
            out += joiner.feed(read_results(msg))
        elif kind == 'UtteranceEnd':
            out += joiner.flush()
    return out
