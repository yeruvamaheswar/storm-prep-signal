"""A seeded, unreliable message channel (PRD O2).

Models the network between the controller and the homes: a message can be dropped,
delayed, duplicated or arrive late. Reordering is not a separate fault; it falls out
of each message getting its own random delay. All randomness comes from the
scheduler's rng, so the same seed gives the same faults in the same order.
"""


def _check_rate(name, value):
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1, got {value}")


class Channel:
    def __init__(self, scheduler, drop_rate=0.0, dup_rate=0.0, delay_s=(1.0, 20.0),
                 late_rate=0.0, late_extra_s=100.0):
        _check_rate("drop_rate", drop_rate)
        _check_rate("dup_rate", dup_rate)
        _check_rate("late_rate", late_rate)
        low, high = delay_s
        if low < 0 or high < low:
            raise ValueError(f"delay_s must be (low, high) with 0 <= low <= high, got {delay_s}")
        if late_extra_s < 0:
            raise ValueError(f"late_extra_s must be >= 0, got {late_extra_s}")
        self.scheduler = scheduler
        self.drop_rate = drop_rate
        self.dup_rate = dup_rate
        self.delay_s = (low, high)
        self.late_rate = late_rate
        self.late_extra_s = late_extra_s

    def send(self, msg, deliver):
        """Send msg; the channel later calls deliver(msg) zero, one or two times."""
        if "command_id" not in msg:
            # Every message must be traceable in the log and de-duplicable by the receiver.
            raise ValueError("msg must carry a command_id")
        sched, rng = self.scheduler, self.scheduler.rng
        command_id = msg["command_id"]
        sched.log("sent", command_id=command_id)

        # The rng is drawn in a fixed order (drop, delay, late, dup) so replays match.
        if rng.random() < self.drop_rate:
            sched.log("dropped", command_id=command_id)
            return

        delay = rng.uniform(*self.delay_s)
        if rng.random() < self.late_rate:
            delay += self.late_extra_s
            sched.log("late", command_id=command_id, delay_s=delay)
        sched.schedule(delay, self._arrive, msg, deliver)

        if rng.random() < self.dup_rate:
            # The copy is the same dict object with the same command_id, so the receiver
            # can recognise it and refuse to run the command twice.
            dup_delay = rng.uniform(*self.delay_s)
            sched.log("duplicated", command_id=command_id, delay_s=dup_delay)
            sched.schedule(dup_delay, self._arrive, msg, deliver)

    def _arrive(self, msg, deliver):
        # Log first so the event log shows the arrival even if the receiver fails.
        self.scheduler.log("delivered", command_id=msg["command_id"])
        deliver(msg)
