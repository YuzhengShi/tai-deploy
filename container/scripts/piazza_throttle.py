"""Pacing and retry for Piazza's unofficial API (piazza_query.py).

Piazza answers a request that comes too soon after another not with data but with {"error": "Sorry, too fast -- please wait a second and try again."}.
The library turns that into "Could not get post 882". On 2026-11-04 a voice call got seventeen of them in two minutes, the model asked for the same post
twelve times, and the student heard "Piazza is rate-limiting me". So:

  * requests are kept a small gap apart, across the processes of one container too (every tool call is a process of its own, and it logs in before it asks);
  * a "too fast" is waited out and the request sent again, up to three times, and after one the gap stays wide for two minutes;
  * a lookup that has used its time (24 s: the tool gives up on a script at 30 s) stops, and says what it has, instead of being killed with nothing.

No Piazza library is imported here, so it can be tested without one: the caller hands in what to send.
"""
import json
import os
import time

STATE_FILE = os.environ.get('PIAZZA_THROTTLE_STATE', '/tmp/.piazza_throttle.json')


def is_too_fast(value):
    """Whether a reply, an error or its text says Piazza wants fewer requests."""
    return 'too fast' in str(value).lower()


def reply_too_fast(reply):
    return isinstance(reply, dict) and is_too_fast(reply.get('error'))


class OutOfTime(Exception):
    """The time for this lookup is used up: Piazza kept asking us to slow down, or there was a lot to fetch."""


class Throttle:
    def __init__(self, gap=0.12, slow_gap=1.1, slow_for=120.0, retries=3, wait=1.3, budget=24.0, state_file=None, clock=time.time, sleep=time.sleep):
        self.gap = gap                    # seconds between two requests, when Piazza has not complained lately
        self.slow_gap = slow_gap          # ... and for `slow_for` seconds after it has
        self.slow_for = slow_for
        self.retries = retries            # how often a "too fast" is waited out and the request sent again
        self.wait = wait                  # the first wait; the next ones are twice and three times as long
        self.budget = budget              # seconds this process may spend before a lookup stops with what it has
        self.state_file = state_file or STATE_FILE
        self.clock = clock
        self.sleep = sleep
        self.started = clock()
        self.waited_out = 0               # how many "too fast" this process has waited out

    # --- what the processes of a container share: when the last request was made, and until when the gap is wide
    def _read(self):
        try:
            with open(self.state_file) as handle:
                state = json.load(handle)
            return state if isinstance(state, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, **changes):
        state = self._read()
        state.update(changes)
        try:
            with open(self.state_file, 'w') as handle:
                json.dump(state, handle)
        except OSError:
            pass                          # best effort: with no file there is no shared pacing, and nothing else is lost

    # --- the time of this lookup
    def elapsed(self):
        return self.clock() - self.started

    def out_of_time(self):
        return self.elapsed() >= self.budget

    def _pause(self, seconds):
        if seconds <= 0:
            return
        if self.elapsed() + seconds > self.budget:
            raise OutOfTime('Piazza asked us to slow down, and the time for this lookup ran out')
        self.sleep(seconds)

    def pace(self):
        """Waits until the gap since the last request, by this process or an earlier one, has gone by."""
        state = self._read()
        now = self.clock()
        slow = now < float(state.get('slow_until') or 0)
        self._pause(float(state.get('last') or 0) + (self.slow_gap if slow else self.gap) - now)

    def request(self, send):
        """What send() returns, once the gap allows it. A "too fast" (as the reply, or as the text of an error) is waited out and sent again;
        the last one is returned, or raised, as it came. Any other error goes up at once."""
        for attempt in range(self.retries + 1):
            self.pace()
            try:
                reply = send()
            except Exception as err:
                self._write(last=self.clock())
                if not is_too_fast(err) or attempt == self.retries:
                    raise
            else:
                self._write(last=self.clock())
                if not reply_too_fast(reply) or attempt == self.retries:
                    return reply
            self._write(slow_until=self.clock() + self.slow_for)
            self.waited_out += 1
            self._pause(self.wait * (attempt + 1))
        raise RuntimeError('unreachable')


def install(throttle, network):
    """Puts the throttle in front of every request the library's network makes (they all go through its rpc's `request`). Returns whether it could."""
    rpc = getattr(network, '_rpc', None)
    send = getattr(rpc, 'request', None)
    if not callable(send):
        return False
    rpc.request = lambda *args, **kwargs: throttle.request(lambda: send(*args, **kwargs))
    return True
