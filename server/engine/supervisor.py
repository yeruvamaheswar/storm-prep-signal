"""Zone ack rollup after allocate. There is no per-home device command API yet.

The other branch's runtime fans Command objects through a lossy Channel to a
HomeWorker per home, retries at 60 s, and closes at 120 s. Here the same
command_id and those two deadlines stay, but acks are rolled in-process: a
optional channel_drop_rate can drop both the send and the one retry. That is
a simulation of a messy channel, not hardware.
"""
import random
from dataclasses import dataclass

# Virtual seconds inside one 5-minute tick. Same numbers as orchestration.run_cycle.
CYCLE_CONFIRM_S = 60.0
CYCLE_CLOSE_S = 120.0

ACK_KEYS = ("acked", "held", "silent", "dead", "unconfirmed")


@dataclass
class Command:
    command_id: str  # "{home_id}:{tick}"; a retry reuses this id
    home_id: str
    kw: float


class HomeWorker:
    """Tracks command ids already received. A repeat never counts twice."""

    def __init__(self):
        self.seen = set()

    def accept(self, command_id):
        if command_id in self.seen:
            return False
        self.seen.add(command_id)
        return True


def command_id(home_id, tick):
    return f"{home_id}:{tick}"


def empty_counts():
    return {key: 0 for key in ACK_KEYS}


def _rng(settings, tick):
    seed = settings.get("seed", 1)
    return random.Random(int(seed) * 100_000 + int(tick))


class ZoneSupervisor:
    """One zone's commands. A stuck zone does not hold the others."""

    def __init__(self, zone, tick, rng, drop_rate):
        self.zone = zone
        self.tick = tick
        self.rng = rng
        self.drop_rate = drop_rate
        self.workers = {}
        self.confirmed = {}

    def add(self, home):
        self.workers[home.home_id] = HomeWorker()

    def send(self, home, kw):
        """Send at 0 s; if that drop, retry the same command_id at 60 s; close at 120 s."""
        cmd = Command(command_id(home.home_id, self.tick), home.home_id, kw)
        worker = self.workers[home.home_id]
        arrived = False
        for _attempt in (0, 1):
            if self.rng.random() < self.drop_rate:
                continue
            worker.accept(cmd.command_id)
            arrived = True
            break
        self.confirmed[home.home_id] = arrived
        return cmd


def simulate_zone_acks(homes, alloc, tick, settings=None):
    """Roll zone totals after allocate. Dead and stale homes are never commanded."""
    settings = settings or {}
    drop_rate = float(settings.get("channel_drop_rate", 0.0))
    rng = _rng(settings, tick)
    supervisors = {}
    for home in homes:
        zone = home.zone or "unassigned"
        if zone not in supervisors:
            supervisors[zone] = ZoneSupervisor(zone, tick, rng, drop_rate)
        supervisors[zone].add(home)
        kw = alloc.per_home_kw.get(home.home_id, 0.0)
        if home.status == "live" and kw > 0:
            supervisors[zone].send(home, kw)

    totals = {zone: empty_counts() for zone in supervisors}
    for home in homes:
        zone = home.zone or "unassigned"
        row = totals[zone]
        confirmed = supervisors[zone].confirmed
        if home.status == "dead":
            row["dead"] += 1
        elif home.status == "stale":
            row["silent"] += 1
        elif home.home_id in confirmed:
            row["acked" if confirmed[home.home_id] else "unconfirmed"] += 1
        else:
            row["held"] += 1
    return totals
