"""Battery telemetry for the simulated fleet (spec: docs/agents/telemetry-vpp.md).

Two views of every battery, never mixed:
- the simulator's Home objects hold the truth; HomeWorker and discharge change them;
- HomeState holds what each battery last reported; allocate and the rollups read only that.

Readings travel on the cycle's seeded Scheduler through their own lossy Channel, so a run
replays exactly from its seed. Metric names follow the OpenTelemetry hardware conventions
(hw.battery.charge, hw.power, hw.status); there is no exporter, only the shape.
"""
from dataclasses import dataclass, field
from typing import Optional

DEFAULTS = {
    "telemetry_every_s": 10.0,        # one reading per home per 10 virtual s (a demo rate)
    "stale_after_s": 180.0,           # Base says telemetry older than 180 s is stale
    "dead_after_s": 600.0,            # our assumption
    "suspect_kwh": 0.1,               # energy-check tolerance per tick (catches a lie of 1.2 kW+)
    "telemetry_outage_rate": 0.05,    # sourced: AEMO VPP trials, 5-8% of fleet data missing
    "telemetry_dup_rate": 0.01,       # assumed
    "telemetry_late_rate": 0.02,      # assumed
    "telemetry_late_extra_s": 60.0,   # assumed
    "telemetry_delay_s": (0.2, 2.0),  # assumed network delay per reading
    "telemetry_skew_s": 2.0,          # assumed: each battery clock is off by up to +-2 s
    "telemetry_liar_ids": None,       # None: the seed plants one lying battery; () for none
    "telemetry_outages": None,        # None: the seed picks outages; {home_id: [(start, end)]}
}
FAULT_BASIS = {"outage": "sourced", "duplicate": "assumed", "late": "assumed",
               "skew": "assumed", "liar": "demo case"}


def knob(settings, key):
    return settings.get(key, DEFAULTS[key])


def new_stats():
    return dict.fromkeys(("received", "accepted", "duplicates", "late", "rejected",
                          "dropped", "cut_at_tick_end"), 0)


@dataclass
class HomeState:
    """What the VPP believes about one battery, built only from its accepted readings."""
    home_id: str
    capacity_kwh: float
    last: Optional[dict] = None          # latest accepted reading, plus "ingest_ts"
    last_seen: float = float("-inf")     # our clock when `last` arrived
    boot_id: Optional[int] = None
    last_seq: int = -1
    seen: set = field(default_factory=set)   # (boot_id, seq) already received
    suspect: bool = False                # sticky for the run once the energy check fails
    pre_tick: Optional[dict] = None      # the reading held when this tick's plan was made
    dups: int = 0
    late: int = 0
    rejected: int = 0


def ingest(hs, reading, now_s, stats):
    """Accept, skip or reject one reading. `now_s` is our clock on arrival, never the battery's."""
    stats["received"] += 1
    key = (reading["boot_id"], reading["seq"])
    if key in hs.seen:
        hs.dups += 1
        stats["duplicates"] += 1
        return "duplicate"
    hs.seen.add(key)
    if not 0.0 <= reading["soc_kwh"] <= hs.capacity_kwh:
        hs.rejected += 1
        stats["rejected"] += 1
        return "rejected"
    if reading["boot_id"] == hs.boot_id and reading["seq"] < hs.last_seq:
        # Older than what we hold: keep it out of the state, so a slow copy never rolls time back.
        hs.late += 1
        stats["late"] += 1
        return "late"
    hs.boot_id, hs.last_seq = reading["boot_id"], reading["seq"]
    hs.last = {**reading, "ingest_ts": now_s}
    hs.last_seen = now_s
    stats["accepted"] += 1
    return "accepted"


def to_otel(reading, home):
    """The same reading in the OpenTelemetry metrics layout: one resource, three gauges."""
    t = int(round(reading["device_ts"] * 1e9))
    return {
        "resource": {"hw.id": home.home_id, "ercot.load_zone": home.zone,
                     "hw.battery.capacity": f"{home.capacity_kwh} kWh", "hw.battery.chemistry": "LFP",
                     "hw.vendor": "synthetic", "data.label": "synthetic"},
        "metrics": [
            {"name": "hw.battery.charge", "type": "gauge", "unit": "1",
             "value": reading["soc_kwh"] / home.capacity_kwh, "time_unix_nano": t},
            {"name": "hw.power", "type": "gauge", "unit": "W",
             "value": reading["power_kw"] * 1000, "time_unix_nano": t},
            {"name": "hw.status", "type": "updowncounter", "unit": "1", "value": 1,
             "attributes": {"hw.state": reading["health"]}, "time_unix_nano": t},
        ],
    }


RANK = {"live": 0, "stale": 1, "dead": 2}


def data_status(hs, now_s, settings):
    """live, stale or dead from how old our newest accepted reading is; suspect overrides."""
    if hs.suspect:
        return "suspect"
    age = now_s - hs.last_seen
    if age > knob(settings, "dead_after_s"):
        return "dead"
    if age > knob(settings, "stale_after_s"):
        return "stale"
    return "live"


def view_status(tape_status, data_st):
    """What the operator sees: suspect is shown as itself, otherwise the worse of tape and data."""
    if data_st == "suspect":
        return "suspect"
    return max(tape_status, data_st, key=RANK.__getitem__)


def plan_status(tape_status, data_st):
    """What allocate sees. The contract has no suspect status, so a suspect home plans as stale."""
    mapped = "stale" if data_st == "suspect" else data_st
    return max(tape_status, mapped, key=RANK.__getitem__)
