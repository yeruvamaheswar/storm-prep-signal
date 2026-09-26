"""Battery telemetry for the simulated fleet (spec: docs/agents/telemetry-vpp.md).

Two views of every battery, never mixed:
- the simulator's Home objects hold the truth; HomeWorker and discharge change them;
- HomeState holds what each battery last reported; allocate and the rollups read only that.

Readings travel on the cycle's seeded Scheduler through their own lossy Channel, so a run
replays exactly from its seed. Metric names follow the OpenTelemetry hardware conventions
(hw.battery.charge, hw.power, hw.status); there is no exporter, only the shape.
"""
import copy
import random
from dataclasses import dataclass, field
from typing import Optional

from server.engine.channel import Channel
from server.engine.contracts import Home
from server.engine.fleet import floor_kwh, safe_kw

DEFAULTS = {
    "telemetry_every_s": 10.0,        # one reading per home per 10 virtual s (a demo rate)
    "stale_after_s": 180.0,           # Base says telemetry older than 180 s is stale
    "dead_after_s": 600.0,            # our assumption
    "suspect_kwh": 0.1,               # energy-check tolerance per tick (catches a lie of 1.2 kW+)
    "telemetry_outage_rate": 0.05,    # assumed (unsourced): AEMO VPP trials, 5-8% of fleet data missing
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


class TelemetryState:
    """The VPP's memory of every battery, kept across ticks, plus the seeded fault plan."""

    def __init__(self, homes, settings, seed):
        self.settings = settings
        self.every = knob(settings, "telemetry_every_s")
        self.tick_s = settings["tick_minutes"] * 60.0
        self.base_s = 0.0
        rng = random.Random(seed)
        ids = [h.home_id for h in homes]
        self.homes = {h.home_id: HomeState(h.home_id, h.capacity_kwh) for h in homes}
        self.phase = {i: rng.uniform(0.0, self.every) for i in ids}   # homes don't all report at once
        skew = knob(settings, "telemetry_skew_s")
        self.skew = {i: rng.uniform(-skew, skew) for i in ids}
        self.seq = dict.fromkeys(ids, 0)
        liars = knob(settings, "telemetry_liar_ids")
        self.liar_ids = tuple(liars) if liars is not None else (rng.choice(ids),)
        self.frozen = {h.home_id: h.soc_kwh for h in homes if h.home_id in self.liar_ids}
        outages = knob(settings, "telemetry_outages")
        if outages is None:
            count = round(knob(settings, "telemetry_outage_rate") * len(ids))
            outages = {}
            for i in rng.sample(ids, count):
                start = rng.uniform(0.0, 12 * self.tick_s)
                outages[i] = [(start, start + rng.uniform(200.0, 1500.0))]
        self.outages = outages
        self.power = dict.fromkeys(ids, 0.0)
        self.totals = new_stats()
        # Registration: every battery checks in once before the first tick, as a real device
        # does when it is installed, so tick 1 plans from a report instead of from nothing.
        for h in homes:
            ingest(self.homes[h.home_id], self.make_reading(h, -self.every), -self.every, self.totals)

    def offline(self, home_id, t_abs):
        return any(start <= t_abs < end for start, end in self.outages.get(home_id, ()))

    def make_reading(self, home, t_abs, power_kw=0.0):
        """One reading from the battery's side: its clock may be off, and a liar's charge is frozen."""
        self.seq[home.home_id] += 1
        seq = self.seq[home.home_id]
        charge_state = "DISCHARGING" if power_kw > 0 else "HOLDING"
        return {"command_id": f"telemetry:{home.home_id}:1:{seq}", "home_id": home.home_id,
                "boot_id": 1, "seq": seq, "device_ts": t_abs + self.skew[home.home_id],
                "soc_kwh": self.frozen.get(home.home_id, home.soc_kwh), "power_kw": power_kw,
                "charge_state": charge_state, "grid": "connected", "health": "ok"}

    def start_tick(self, sched, homes):
        """Snapshot what the plan saw, then schedule every home's readings on this tick's clock."""
        self.sched, self.stopped = sched, False
        self.sim = {h.home_id: h for h in homes}
        self.stats = new_stats()
        self.power = dict.fromkeys(self.homes, 0.0)
        for hs in self.homes.values():
            hs.pre_tick = hs.last
        s = self.settings
        # Readings get their own channel (same clock and seed) with the telemetry fault rates.
        self.channel = Channel(sched, drop_rate=0.0, dup_rate=knob(s, "telemetry_dup_rate"),
                               delay_s=tuple(knob(s, "telemetry_delay_s")),
                               late_rate=knob(s, "telemetry_late_rate"),
                               late_extra_s=knob(s, "telemetry_late_extra_s"))
        for h in homes:
            sched.schedule(self.phase[h.home_id], self._emit, h.home_id)

    def offline_now(self, home_id):
        return self.offline(home_id, self.base_s + self.sched.now)

    def record_execution(self, home_id, actual_kw):
        """Called by HomeWorker.run: from now on this battery reports that it is discharging."""
        self.power[home_id] += actual_kw

    def check_energy(self, confirmed_kw, unsure):
        """Flag a battery whose reported charge does not match the energy it confirmed giving.

        Checked once per tick: orders move a battery's charge all at once when they execute, so a
        per-reading check would blame honest homes. Homes we can't be sure about are skipped.
        """
        skew = knob(self.settings, "telemetry_skew_s")
        margin = max(5.0, skew + 1.0)
        # Keep checked readings after the books close even with clock skew. Default skew 2 s keeps
        # the old 5 s margin.
        close = self.settings.get("cycle_close_s", 120.0) + margin
        tick_h = self.settings["tick_minutes"] / 60
        flagged = []
        for home_id, hs in self.homes.items():
            pre, post = hs.pre_tick, hs.last
            if hs.suspect or home_id in unsure or pre is None or post is None or pre is post:
                continue
            if pre["device_ts"] < self.base_s - self.tick_s + close or post["device_ts"] < self.base_s + close:
                continue
            expected = pre["soc_kwh"] - confirmed_kw.get(home_id, 0.0) * tick_h
            if abs(post["soc_kwh"] - expected) > knob(self.settings, "suspect_kwh"):
                hs.suspect = True
                flagged.append(home_id)
        return flagged

    def stop(self):
        """End of tick: no new reading is scheduled, and one still in flight is discarded."""
        self.stopped = True

    def finish(self, result, homes, policy, confirmed_kw, unsure):
        """After the drain: fill the result's feed stats, then move our clock to the next tick."""
        result.feed = {**self.stats, "fault_basis": dict(FAULT_BASIS)}
        result.feed["newly_suspect"] = self.check_energy(confirmed_kw, unsure)
        result.events = [e for e in result.events
                         if not str(e.get("command_id", "")).startswith("telemetry:")]
        for key, value in self.stats.items():
            self.totals[key] += value
        result.plant, result.zones = self.rollups(homes, policy, result)
        self.base_s += self.tick_s

    def _emit(self, home_id):
        if self.stopped:
            return
        if self.offline_now(home_id):
            self.stats["dropped"] += 1
        else:
            reading = self.make_reading(self.sim[home_id], self.base_s + self.sched.now,
                                        self.power[home_id])
            self.channel.send(reading, self._deliver)
        self.sched.schedule(self.every, self._emit, home_id)

    def _deliver(self, reading):
        if self.stopped:
            self.stats["cut_at_tick_end"] += 1
            return
        ingest(self.homes[reading["home_id"]], reading, self.base_s + self.sched.now, self.stats)

    def rollups(self, homes, policy, result):
        """One ADER-like view per zone and one for the plant, from reports only (never the truth)."""
        now = self.base_s + self.tick_s
        zones = {}
        for h in homes:
            hs = self.homes[h.home_id]
            status = view_status(h.status, data_status(hs, now, self.settings))
            z = zones.setdefault(h.zone, self._empty_rollup())
            z["homes"]["total"] += 1
            z["homes"][status] += 1
            soc = hs.last["soc_kwh"] if hs.last else 0.0
            reported = Home(h.home_id, h.capacity_kwh, soc, h.max_kw, "live", h.zone)
            z["soc_mwh"] += soc / 1000
            z["floor_mwh"] += floor_kwh(reported, policy) / 1000
            if status == "live":
                z["available_mw"] += safe_kw(reported, policy, self.settings) / 1000
            z["max_data_age_s"] = max(z["max_data_age_s"], now - hs.last_seen)
        for name, z in zones.items():
            z["delivering_mw"] = result.zone_delivered_mw.get(name, 0.0)
            z["coverage"] = z["homes"]["live"] / z["homes"]["total"]
        plant = self._empty_rollup()
        for z in zones.values():
            for key in z["homes"]:
                plant["homes"][key] += z["homes"][key]
            for key in ("soc_mwh", "floor_mwh", "available_mw", "delivering_mw"):
                plant[key] += z[key]
            plant["max_data_age_s"] = max(plant["max_data_age_s"], z["max_data_age_s"])
            plant["grid_down"] = plant["grid_down"] or z["grid_down"]
        plant["coverage"] = plant["homes"]["live"] / plant["homes"]["total"] if plant["homes"]["total"] else 0.0
        plant["zones"] = copy.deepcopy(zones)
        return plant, zones

    @staticmethod
    def _empty_rollup():
        return {"homes": dict.fromkeys(("total", "live", "stale", "dead", "suspect"), 0),
                "soc_mwh": 0.0, "floor_mwh": 0.0, "available_mw": 0.0, "delivering_mw": 0.0,
                "grid_down": False, "coverage": 0.0, "max_data_age_s": 0.0, "data_label": "synthetic"}

    def reported_homes(self, homes):
        """New Home objects built from the reports, for allocate. Never the simulator's own."""
        copies = []
        for h in homes:
            if h.home_id not in self.homes:
                raise ValueError(f"{h.home_id} is not in this TelemetryState's fleet")
            hs = self.homes[h.home_id]
            soc = hs.last["soc_kwh"] if hs.last else 0.0
            status = plan_status(h.status, data_status(hs, self.base_s, self.settings))
            copies.append(Home(h.home_id, h.capacity_kwh, soc, h.max_kw, status, h.zone))
        return copies
