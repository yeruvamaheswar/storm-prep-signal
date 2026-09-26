"""A seeded virtual clock and event queue (PRD O1).

Everything in the orchestration runtime (central node, zone supervisors, home workers,
channel) is an event on this one clock. There are no threads and no real time, so a run
is fully replayable from its seed: same seed, same events, same order.
"""
import heapq
import random


class Scheduler:
    def __init__(self, seed):
        self.now = 0.0                    # virtual seconds since the cycle started
        self.rng = random.Random(seed)    # the ONLY source of randomness for the whole run
        self.events = []                  # the event log, filled by log(...)
        self._queue = []                  # heap of (time, seq, fn, args)
        self._seq = 0                     # insertion counter: breaks ties between equal times

    def schedule(self, delay_s, fn, *args):
        """Run fn(*args) delay_s virtual seconds from now."""
        if delay_s < 0:
            # An event in the past would break the promise that time only moves forward.
            raise ValueError(f"delay_s must be >= 0, got {delay_s}")
        # seq goes before fn in the tuple, so heapq never has to compare two functions,
        # and two events at the same time run in the order they were scheduled.
        heapq.heappush(self._queue, (self.now + delay_s, self._seq, fn, args))
        self._seq += 1

    def run_until(self, t_end):
        """Run every event with time <= t_end in order, then leave the clock at t_end."""
        # Events scheduled while running are pushed onto the same heap, so they run
        # in this call too if they fall inside the bound.
        while self._queue and self._queue[0][0] <= t_end:
            t, _seq, fn, args = heapq.heappop(self._queue)
            self.now = t
            fn(*args)
        # Land exactly on the bound (a deadline), but never move the clock backwards.
        self.now = max(self.now, t_end)

    def log(self, kind, **data):
        """Append one event stamped with the current virtual time."""
        if "t" in data:
            # The time stamp must always be the clock's, or replays could disagree.
            raise ValueError("log() sets 't' itself; do not pass it")
        self.events.append({"t": self.now, "kind": kind, **data})
