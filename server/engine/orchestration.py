"""The orchestration runtime (PRD O3, O4): one tick's commands, fanned out and closed on a deadline.

A central node plans with `allocate`, hands each zone's commands to a `ZoneSupervisor`, and
the supervisors send them through the lossy `Channel` to one `HomeWorker` per home. Everything
runs as events on one seeded `Scheduler`, so a run is replayable from its seed.

In-tick timeline (virtual seconds):
    0    commands go out
    60   unconfirmed commands are timed_out: one retry (same id), one reassignment (new id)
    120  the books close; anything that arrives later is logged as late and never counted

orchestrate_tick writes no files. The runner at the bottom plays a tape and writes var/orchestration/.
"""
import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from server.engine.cli import read_settings
from server.engine.channel import Channel
from server.engine.contracts import Allocation, Policy, TapeFrame
from server.engine.controller import allocate, grid_down_zones, round_down
from server.engine.fleet import apply_events, fleet_rollups, floor_kwh, new_fleet, room_kw, safe_kw, set_status
from server.engine.policy import reserve_policy
from server.engine.scheduler import Scheduler
from server.engine.telemetry import TelemetryState

OUT_DIR = Path("var") / "orchestration"
COUNTERS = ("breaches", "timed_out", "retried", "reassigned", "duplicates_ignored", "late",
            "short_delivery", "over_delivery", "charge_mismatch")
# Per-zone home counts the wall reads from TickResult.zone_acks (same keys as supervisor.ACK_KEYS).
ACK_KEYS = ("acked", "held", "silent", "dead", "unconfirmed")
# A report whose kWh differs from the home's real charge drop by more than this is a mismatch.
CHARGE_TOLERANCE_KWH = 1e-6


@dataclass
class Command:
    command_id: str                          # "home_id:tick", or "home_id:tick:r" for a reassignment
    home_id: str
    kw: float
    parent_command_id: Optional[str] = None  # the timed-out command a reassignment replaces


@dataclass
class CycleResult:
    allocation: Allocation        # the plan's per-home kW, with delivered_mw = credited_mw
    breaches: int
    command_states: dict          # command_id to "confirmed" or "unconfirmed" at the close
    zone_planned_mw: dict
    zone_delivered_mw: dict       # confirmed (and credited) MW per zone
    zone_unconfirmed_mw: dict
    confirmed_mw: float
    credited_mw: float
    unconfirmed_mw: float
    missed_mw: float
    timed_out: int
    retried: int
    reassigned: int
    duplicates_ignored: int
    late: int
    # Energy homes really gave beyond their booked shares (a slow original and its reassignment
    # both ran). Never credited, never hidden: confirmed + over_delivery = everything heard.
    over_delivery_mw: float = 0.0
    events: list = field(default_factory=list)
    # home_id to the kW booked for it (only homes with some). Sums to confirmed_mw.
    home_confirmed_kw: dict = field(default_factory=dict)
    # Charge is booked apart from delivery: confirmed kW absorbed, never credited to the target.
    charging_mw: float = 0.0
    zone_charging_mw: dict = field(default_factory=dict)
    home_charged_kw: dict = field(default_factory=dict)   # home_id to kW absorbed (positive)
    # Filled only when orchestrate_tick gets a TelemetryState (docs/agents/telemetry-vpp.md R7).
    plant: dict = field(default_factory=dict)
    zones: dict = field(default_factory=dict)
    feed: dict = field(default_factory=dict)


class Runtime:
    """What every job in one cycle shares: the clock, the channel, the knobs and the counters."""

    def __init__(self, settings, policy, tick, seed):
        self.sched = Scheduler(seed)
        self.channel = Channel(
            self.sched,
            drop_rate=settings.get("channel_drop_rate", 0.0),
            dup_rate=settings.get("channel_dup_rate", 0.0),
            delay_s=tuple(settings.get("channel_delay_s", (1.0, 20.0))),
            late_rate=settings.get("channel_late_rate", 0.0),
            late_extra_s=settings.get("channel_late_extra_s", 100.0),
        )
        self.settings, self.policy, self.tick = settings, policy, tick
        self.worker_delay_s = tuple(settings.get("worker_delay_s", (1.0, 30.0)))
        # Test hook: these homes' workers raise, to prove the worker boundary contains it.
        self.fail_ids = set(settings.get("_fail_home_ids", ()))
        # Test hook: home_id to a factor these workers multiply their reported kW by (a lie).
        self.misreport = dict(settings.get("_misreport", {}))
        self.dropped = {}          # command_id to kWh the home's charge really fell for it
        self.ran_kw = {}           # command_id to the exact kW the home really gave for it
        self.counts = dict.fromkeys(COUNTERS, 0)
        self.workers = {}          # home_id to HomeWorker
        self.planned_kw = {}       # home_id to kW from the plan (used to find spare headroom)
        self.suspect = set()       # homes that timed out: kept live, but given no new work
        self.reassigned_to = set() # homes already holding a ":r" command (keeps ids unique)
        self.closed = False
        self.feed = None           # the TelemetryState for this tick, or None with no feed
        self.plan_view = {}        # reported Home copies used by this tick's planner
        self.grid_down = set()     # zones whose batteries only back up their homes this tick

    def log(self, kind, **data):
        self.sched.log(kind, **data)


class HomeWorker:
    """One home's own job: receive, wait, execute under the floor guard, report back."""

    def __init__(self, home, rt, supervisor, fraction):
        self.home, self.rt, self.supervisor = home, rt, supervisor
        self.fraction = fraction   # share of the order this home really delivers (1.0 = all)
        self.seen = set()          # command ids already received: a repeat never runs twice
        self.reports = {}          # command_id to the report sent, to answer a retry again

    def receive(self, msg):
        cmd, rt = msg["command"], self.rt
        if self.home.status == "dead":
            rt.log("home_down", command_id=cmd.command_id, home_id=self.home.home_id)
            return
        if rt.feed is not None and rt.feed.offline_now(self.home.home_id):
            # The battery has lost its link: the order never reaches it.
            rt.log("home_offline", command_id=cmd.command_id, home_id=self.home.home_id)
            return
        if cmd.command_id in self.seen:
            rt.counts["duplicates_ignored"] += 1
            rt.log("duplicate_ignored", command_id=cmd.command_id, home_id=self.home.home_id)
            # A retry usually means our report was lost, so answer again without running again.
            if cmd.command_id in self.reports:
                self.send_report(self.reports[cmd.command_id])
            return
        self.seen.add(cmd.command_id)
        rt.sched.schedule(rt.sched.rng.uniform(*rt.worker_delay_s), self.execute, cmd)

    def execute(self, cmd):
        rt = self.rt
        # After the close the tick's books are final, so an order that ran now could never be
        # credited; the command has expired and the battery keeps its charge.
        if rt.closed or self.home.status != "live":
            rt.log("expired" if rt.closed else "home_down",
                   command_id=cmd.command_id, home_id=self.home.home_id)
            return
        # The worker boundary: whatever goes wrong inside one home stays in that home.
        try:
            report = self.run(cmd)
        except Exception as exc:
            set_status(self.home, "dead")
            rt.log("worker_error", command_id=cmd.command_id, home_id=self.home.home_id,
                   error=f"{type(exc).__name__}: {exc}")
            return
        self.reports[cmd.command_id] = report
        self.send_report(report)

    def run(self, cmd):
        """Run one command. Discharge is clamped to the floor (the second guard; the first is
        allocate). Charge (negative kW) is clamped to room, so it never fills past capacity.
        A home whose zone's grid is down runs 0 either way: it backs up its own home."""
        rt, home = self.rt, self.home
        if home.home_id in rt.fail_ids:
            raise RuntimeError("injected worker fault")
        if home.zone in rt.grid_down:
            kw = 0.0
            rt.log("grid_down", command_id=cmd.command_id, home_id=home.home_id, kw=cmd.kw, zone=home.zone)
        elif cmd.kw < 0:
            room = room_kw(home, rt.settings)
            kw = -min(-cmd.kw, room)
            if kw > cmd.kw:
                rt.log("clamped", command_id=cmd.command_id, home_id=home.home_id, kw=cmd.kw, room_kw=room)
        else:
            safe = safe_kw(home, rt.policy, rt.settings)
            kw = min(cmd.kw, safe)
            if kw < cmd.kw:
                rt.log("clamped", command_id=cmd.command_id, home_id=home.home_id, kw=cmd.kw, safe_kw=safe)
        actual_kw = kw * self.fraction
        if self.fraction < 1.0:
            rt.counts["short_delivery"] += 1
        soc_before = home.soc_kwh
        home.soc_kwh -= actual_kw * rt.settings["tick_minutes"] / 60
        rt.dropped[cmd.command_id] = soc_before - home.soc_kwh
        rt.ran_kw[cmd.command_id] = actual_kw
        if rt.feed is not None:
            rt.feed.record_execution(home.home_id, actual_kw)
        # A charging home may still sit under its floor; only a discharge can breach it.
        if actual_kw > 0 and home.soc_kwh < floor_kwh(home, rt.policy) - 1e-9:
            rt.counts["breaches"] += 1   # only possible if the clamp above is removed
        rt.log("executed", command_id=cmd.command_id, home_id=home.home_id, actual_kw=actual_kw)
        reported_kw = actual_kw * rt.misreport.get(home.home_id, 1.0)
        return {"command_id": cmd.command_id, "home_id": home.home_id, "actual_kw": reported_kw}

    def send_report(self, report):
        self.rt.channel.send(report, self.supervisor.on_report)


class ZoneSupervisor:
    """Owns one zone's commands and deadlines, so a stuck zone never holds up the others."""

    def __init__(self, zone, rt):
        self.zone, self.rt = zone, rt
        self.shares = []       # the planned commands, in send order
        self.messages = {}     # command_id to the message sent (a retry resends this same one)
        self.children = {}     # parent command_id to its reassignment Command
        self.actual = {}       # command_id to actual_kw from its first report before the close
        self.states = {}       # command_id to "sent", "timed_out", "confirmed", "unconfirmed"
        self.booked = {}       # home_id to the kW booked for it at the close
        self.charged = {}      # home_id to the kW it confirmed absorbing (charge), at the close

    def send(self, cmd):
        msg = {"command_id": cmd.command_id, "command": cmd}
        self.messages[cmd.command_id] = msg
        self.states[cmd.command_id] = "sent"
        self.rt.channel.send(msg, self.rt.workers[cmd.home_id].receive)

    def on_report(self, msg):
        rt, command_id = self.rt, msg["command_id"]
        if rt.closed:
            rt.counts["late"] += 1
            rt.log("late_report", command_id=command_id, home_id=msg["home_id"], actual_kw=msg["actual_kw"])
            return
        if command_id in self.actual:
            rt.log("report_repeat", command_id=command_id)   # a copy of a report already booked
            return
        actual_kw = self.check_charge_drop(msg)
        self.actual[command_id] = actual_kw
        self.states[command_id] = "confirmed"
        rt.log("confirmed", command_id=command_id, home_id=msg["home_id"], actual_kw=actual_kw)

    def check_charge_drop(self, msg):
        """The kW to book for a report: what it says, unless the home's charge fell by less.

        The drop is read from the runtime (what the battery did), never from the message.
        """
        rt, hours = self.rt, self.rt.settings["tick_minutes"] / 60
        reported_kwh, dropped_kwh = msg["actual_kw"] * hours, rt.dropped[msg["command_id"]]
        if abs(reported_kwh - dropped_kwh) <= CHARGE_TOLERANCE_KWH:
            return msg["actual_kw"]
        rt.counts["charge_mismatch"] += 1
        rt.log("charge_mismatch", command_id=msg["command_id"], home_id=msg["home_id"],
               reported_kwh=reported_kwh, dropped_kwh=dropped_kwh)
        # The smaller magnitude of the claim and the kW the home really moved, taken as-is:
        # converting the kWh back to kW would drift by a rounding speck and show up as false
        # over-delivery. Magnitude, so a charge (negative) claim is never booked above reality.
        claimed, ran = msg["actual_kw"], rt.ran_kw[msg["command_id"]]
        return claimed if abs(claimed) <= abs(ran) else ran

    def check_deadline(self):
        """At 60 s: every planned command still unconfirmed gets one retry and one reassignment.

        Two passes on purpose: first every late home is marked suspect, then the work moves.
        Otherwise the first share could be handed to a home this same pass is about to time out.
        """
        rt = self.rt
        late = [cmd for cmd in self.shares if cmd.command_id not in self.actual]
        for cmd in late:
            self.states[cmd.command_id] = "timed_out"
            rt.suspect.add(cmd.home_id)
            rt.counts["timed_out"] += 1
            rt.log("timed_out", command_id=cmd.command_id, home_id=cmd.home_id)
        for cmd in late:
            rt.counts["retried"] += 1
            rt.log("retry", command_id=cmd.command_id, home_id=cmd.home_id)
            rt.channel.send(self.messages[cmd.command_id], rt.workers[cmd.home_id].receive)
            # A charge order is that home's own need, not a share of the target: retry only.
            if cmd.kw > 0:
                self.reassign(cmd)

    def reassign(self, cmd):
        rt = self.rt
        home, spare = self.pick_home(cmd)
        if home is None:
            rt.log("reassign_failed", command_id=cmd.command_id, zone=self.zone, reason="no_headroom")
            return
        child = Command(f"{home.home_id}:{rt.tick}:r", home.home_id,
                        round_down(min(cmd.kw, spare)), cmd.command_id)
        self.children[cmd.command_id] = child
        rt.reassigned_to.add(home.home_id)
        rt.counts["reassigned"] += 1
        rt.log("reassigned", command_id=child.command_id, home_id=home.home_id,
               parent_command_id=cmd.command_id, kw=child.kw)
        self.send(child)

    def pick_home(self, cmd):
        """The live, trusted home in this zone with the most spare safe kW; (None, 0) if none."""
        rt, best, best_spare = self.rt, None, 0.0
        for worker in rt.workers.values():
            home = worker.home
            view = rt.plan_view.get(home.home_id, home)
            if (home.zone != self.zone or view.status != "live" or home.home_id == cmd.home_id
                    or home.zone in rt.grid_down
                    or home.home_id in rt.suspect or home.home_id in rt.reassigned_to
                    or rt.planned_kw.get(home.home_id, 0.0) < 0):
                continue
            safe = safe_kw(view, rt.policy, rt.settings)
            spare = round_down(safe - rt.planned_kw.get(home.home_id, 0.0))
            if spare > best_spare:
                best, best_spare = home, spare
        return best, best_spare

    def close(self):
        """At 120 s: final states, and this zone's planned, confirmed, unconfirmed, over-delivered
        and charged kW. Charge is its own book: it is never confirmed or credited toward the target."""
        for command_id, state in self.states.items():
            if state != "confirmed":
                self.states[command_id] = "unconfirmed"
        planned = confirmed = unconfirmed = over = charged = 0.0
        for cmd in self.shares:
            if cmd.kw < 0:
                if cmd.command_id in self.actual:
                    took = min(-cmd.kw, max(0.0, -self.actual[cmd.command_id]))
                    charged += took
                    self.charged[cmd.home_id] = self.charged.get(cmd.home_id, 0.0) + took
                continue
            family = [cmd] + ([self.children[cmd.command_id]] if cmd.command_id in self.children else [])
            got = sum(self.actual[c.command_id] for c in family if c.command_id in self.actual)
            heard = any(c.command_id in self.actual for c in family)
            planned += cmd.kw
            if not heard:
                unconfirmed += cmd.kw
                continue
            if got > cmd.kw:
                # The slow original and its reassignment both ran. The share is booked once and
                # the rest is shown as over-delivery, so the batteries' real energy is not hidden.
                over += got - cmd.kw
                self.rt.counts["over_delivery"] += 1
                self.rt.log("over_delivery", command_id=cmd.command_id, planned_kw=cmd.kw, actual_kw=got)
            confirmed += min(cmd.kw, got)
            # The share goes to the original first, then its reassignment, up to what was planned.
            left = cmd.kw
            for c in family:
                take = min(self.actual.get(c.command_id, 0.0), left)
                if take > 0:
                    self.booked[c.home_id] = self.booked.get(c.home_id, 0.0) + take
                    left -= take
        return planned, confirmed, unconfirmed, over, charged


def short_fractions(frame):
    """home_id to the fraction of its order it really delivers, from the tape's events."""
    fractions = frame.events.get("short_delivery", {})
    for home_id, fraction in fractions.items():
        if not 0.0 <= fraction <= 1.0:
            raise ValueError(f"short_delivery for {home_id} must be between 0 and 1, got {fraction}")
    return fractions


NETWORK_RATES = ("drop_rate", "dup_rate", "late_rate")


def tick_faults(frame, homes, settings):
    """This tick's settings with the tape's fault events applied, and whether any were.

    "network": {drop_rate, dup_rate, late_rate} sets the channel's fault rates (0 to 1).
    "crash": [home_id] makes those homes' workers raise when they run an order (home goes dead).
    "misreport": {home_id: factor} makes those homes report factor x what they really gave.
    A bad value or an unknown home or key raises ValueError: a typo in a tape must not pass quietly.
    """
    events, known = frame.events, {home.home_id for home in homes}
    tick_settings, injected = dict(settings), False

    def check_ids(key, ids):
        unknown = sorted(set(ids) - known)
        if unknown:
            raise ValueError(f"{key} event names homes not in the fleet: {unknown}")

    network = events.get("network", {})
    for key, rate in network.items():
        if key not in NETWORK_RATES:
            raise ValueError(f"network event key {key!r} is not one of {NETWORK_RATES}")
        if not 0.0 <= rate <= 1.0:
            raise ValueError(f"network {key} must be between 0 and 1, got {rate}")
        tick_settings[f"channel_{key}"] = rate
        injected = True
    crash = events.get("crash", [])
    if crash:
        check_ids("crash", crash)
        tick_settings["_fail_home_ids"] = set(settings.get("_fail_home_ids", ())) | set(crash)
        injected = True
    misreport = events.get("misreport", {})
    if misreport:
        check_ids("misreport", misreport)
        for home_id, factor in misreport.items():
            if factor < 0:
                raise ValueError(f"misreport factor for {home_id} must be 0 or more, got {factor}")
        tick_settings["_misreport"] = {**settings.get("_misreport", {}), **misreport}
        injected = True
    return tick_settings, injected


def build_jobs(homes, plan, rt, fractions):
    """One supervisor per zone and one worker per home; the plan's commands go to supervisors."""
    supervisors = {}
    for home in homes:
        if home.zone not in supervisors:
            supervisors[home.zone] = ZoneSupervisor(home.zone, rt)
        sup = supervisors[home.zone]
        rt.workers[home.home_id] = HomeWorker(home, rt, sup, fractions.get(home.home_id, 1.0))
        if home.home_id in plan.per_home_kw:
            kw = plan.per_home_kw[home.home_id]
            rt.planned_kw[home.home_id] = kw
            sup.shares.append(Command(f"{home.home_id}:{rt.tick}", home.home_id, kw))
    return supervisors


def home_books(supervisors):
    """Per home: confirmed kW this tick, and which homes have a command we never heard back on."""
    confirmed, unsure = {}, set()
    for sup in supervisors.values():
        for cmd in list(sup.shares) + list(sup.children.values()):
            if cmd.command_id in sup.actual:
                confirmed[cmd.home_id] = confirmed.get(cmd.home_id, 0.0) + sup.actual[cmd.command_id]
            else:
                unsure.add(cmd.home_id)
    return confirmed, unsure


def orchestrate_tick(homes, frame, policy, mode, settings, seed, telemetry=None):
    """Plan, fan out, wait for the deadlines, and close the books for one tick. Writes no files.

    With a TelemetryState, the plan uses the batteries' reports (never the truth), readings flow
    until the tick ends at 300 s, and the result carries plant, zones and feed.
    """
    fractions = short_fractions(frame)
    settings, injected = tick_faults(frame, homes, settings)
    plan_homes = homes if telemetry is None else telemetry.reported_homes(homes)
    plan = allocate(plan_homes, frame, policy, mode, settings)
    rt = Runtime(settings, policy, frame.tick, seed)
    rt.plan_view = {h.home_id: h for h in plan_homes}
    rt.grid_down = grid_down_zones(frame)
    if telemetry is not None:
        telemetry.start_tick(rt.sched, homes, rt.grid_down)
        rt.feed = telemetry
    supervisors = build_jobs(homes, plan, rt, fractions)
    for sup in supervisors.values():
        for cmd in sup.shares:
            sup.send(cmd)
    rt.sched.run_until(settings.get("cycle_confirm_s", 60.0))
    for sup in supervisors.values():
        sup.check_deadline()
    rt.sched.run_until(settings.get("cycle_close_s", 120.0))
    rt.closed = True
    rt.log("closed")
    books = {zone: sup.close() for zone, sup in supervisors.items()}
    if telemetry is not None:
        # Readings keep flowing to the end of the tick, then stop so the drain below can end.
        rt.sched.run_until(telemetry.tick_s)
        telemetry.stop()
    # Drain what is still in flight: stragglers can only be logged as late or expired now.
    rt.sched.run_until(math.inf)
    result = build_result(frame, plan, rt, supervisors, books)
    if injected or fractions:
        # Say on screen that this tick's failures were simulated on purpose.
        result.allocation.reasons.append("faults_injected")
    if telemetry is not None:
        confirmed_kw, unsure = home_books(supervisors)
        telemetry.finish(result, homes, policy, confirmed_kw, unsure)
    return result


def build_result(frame, plan, rt, supervisors, books):
    zone_planned = {zone: b[0] / 1000 for zone, b in books.items()}
    zone_confirmed = {zone: b[1] / 1000 for zone, b in books.items()}
    zone_unconfirmed = {zone: b[2] / 1000 for zone, b in books.items()}
    over_delivery_mw = sum(b[3] for b in books.values()) / 1000
    zone_charging = {zone: b[4] / 1000 for zone, b in books.items()}
    confirmed_mw = sum(zone_confirmed.values())
    credited_mw = min(confirmed_mw, frame.target_mw)
    missed_mw = frame.target_mw - credited_mw
    c = rt.counts
    reasons = list(plan.reasons)
    for code in ("timed_out", "duplicates_ignored", "short_delivery", "over_delivery", "charge_mismatch"):
        if c[code]:
            reasons.append(f"{code}:{c[code]}")
    states, booked, charged = {}, {}, {}
    for sup in supervisors.values():
        states.update(sup.states)
        booked.update(sup.booked)
        charged.update(sup.charged)
    return CycleResult(
        allocation=Allocation(dict(plan.per_home_kw), credited_mw, missed_mw, reasons),
        breaches=c["breaches"], command_states=states,
        zone_planned_mw=zone_planned, zone_delivered_mw=zone_confirmed,
        zone_unconfirmed_mw=zone_unconfirmed, confirmed_mw=confirmed_mw, credited_mw=credited_mw,
        unconfirmed_mw=sum(zone_unconfirmed.values()), missed_mw=missed_mw,
        timed_out=c["timed_out"], retried=c["retried"], reassigned=c["reassigned"],
        duplicates_ignored=c["duplicates_ignored"], late=c["late"],
        over_delivery_mw=over_delivery_mw, events=rt.sched.events, home_confirmed_kw=booked,
        charging_mw=sum(zone_charging.values()), zone_charging_mw=zone_charging, home_charged_kw=charged,
    )


def asked_and_heard(result):
    """Homes we sent any command to, and homes with at least one confirmed command."""
    asked, heard = set(), set()
    for command_id, state in result.command_states.items():
        home_id = command_id.split(":")[0]   # "home_id:tick" or "home_id:tick:r"
        asked.add(home_id)
        if state == "confirmed":
            heard.add(home_id)
    return asked, heard


def cycle_rollups(homes, result, policy):
    """The wall's per-zone rollup after this tick, from the confirmed books, not the plan.

    Discharging counts and MW are what was booked; a home we never heard back from is
    unconfirmed (the same homes zone_acks calls unconfirmed).
    """
    asked, heard = asked_and_heard(result)
    return fleet_rollups(homes, result.allocation, policy,
                         confirmed_kw=result.home_confirmed_kw, unconfirmed=asked - heard)


def zone_acks(homes, result):
    """Per zone, how many homes are acked, held, silent, dead or unconfirmed after this tick.

    Status is read at the end of the tick, so a home that crashed mid-tick counts as dead.
    A home with any confirmed command (its own or a reassignment) is acked; one we sent work
    to but never heard back from is unconfirmed; a live home given no work is held.
    """
    asked, heard = asked_and_heard(result)
    acks = {}
    for home in homes:
        row = acks.setdefault(home.zone or "unassigned", {key: 0 for key in ACK_KEYS})
        if home.status == "dead":
            row["dead"] += 1
        elif home.status == "stale":
            row["silent"] += 1
        elif home.home_id in heard:
            row["acked"] += 1
        elif home.home_id in asked:
            row["unconfirmed"] += 1
        else:
            row["held"] += 1
    return acks


# --- runner: python -m server.engine.orchestration --tape PATH --seed N [--floor base|storm] ---

def load_frames(path):
    """Tape frames from a {label, frames} object (CONSTRAINTS) or a bare list of frames."""
    data = json.loads(Path(path).read_text())
    frames = data["frames"] if isinstance(data, dict) else data
    return [TapeFrame(**frame) for frame in frames]


def build_policy(floor, settings):
    """storm: the fail-safe floor (no risk signal). base: every zone at the base floor."""
    if floor == "storm":
        return reserve_policy(None, settings)
    pct = settings["base_reserve_pct"]
    zones = settings["zones"]
    return Policy(pct, "normal", "LOW", {z: pct for z in zones}, {z: "normal" for z in zones})


def tick_line(frame, result):
    planned = sum(result.zone_planned_mw.values())
    return (f"tick {frame.tick}: planned {planned:.3f} | confirmed {result.confirmed_mw:.3f}"
            f" | credited {result.credited_mw:.3f} of {frame.target_mw:.3f} MW ({frame.target_label})"
            f" | unconfirmed {result.unconfirmed_mw:.3f} | over-delivered {result.over_delivery_mw:.3f}"
            f" | timed out {result.timed_out}"
            f" | retried {result.retried} | reassigned {result.reassigned}"
            f" | duplicates ignored {result.duplicates_ignored} | breaches {result.breaches}")


def plant_line(result):
    p, f = result.plant, result.feed
    return (f"  plant: live {p['homes']['live']}/{p['homes']['total']} | stored {p['soc_mwh']:.3f} MWh"
            f" | available {p['available_mw']:.3f} MW | coverage {p['coverage']:.0%}"
            f" | feed {f['accepted']}/{f['received']} accepted, dups {f['duplicates']}, late {f['late']}"
            f" | suspect {p['homes']['suspect']} (synthetic)")


def run_tape(tape, seed, floor="storm", out_dir=OUT_DIR, telemetry=False):
    """Play every frame through orchestrate_tick, print one line per tick, write one JSON file."""
    settings = read_settings()
    settings["seed"] = seed
    policy = build_policy(floor, settings)
    homes = new_fleet(settings)
    state = TelemetryState(homes, settings, seed) if telemetry else None
    mode, ticks = "AUTO", []
    for frame in load_frames(tape):
        apply_events(homes, frame.events)
        mode = frame.events.get("operator", mode)   # HOLD/AUTO stays until the tape changes it
        # A different seed per tick, so each tick sees its own faults, still fixed by --seed.
        result = orchestrate_tick(homes, frame, policy, mode, settings, seed * 100_000 + frame.tick,
                                  telemetry=state)
        print(tick_line(frame, result))
        if state is not None:
            print(plant_line(result))
        ticks.append({"tick": frame.tick, "ts": frame.ts, "mode": mode, "target_mw": frame.target_mw,
                      "target_label": frame.target_label, **asdict(result)})
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{seed}.json"
    record = {"seed": seed, "tape": str(tape), "floor": floor, "reserve_pct": policy.reserve_pct,
              "policy_reason": policy.reason, "telemetry": telemetry, "ticks": ticks}
    path.write_text(json.dumps(record, indent=2))
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(prog="server.engine.orchestration",
                                     description="Play a tape through the orchestration runtime.")
    parser.add_argument("--tape", required=True, help="path to a tape JSON file")
    parser.add_argument("--seed", type=int, required=True, help="seed for every random fault")
    parser.add_argument("--floor", choices=("base", "storm"), default="storm",
                        help="reserve floor for every tick (default: storm)")
    parser.add_argument("--telemetry", action="store_true",
                        help="plan from a simulated battery feed instead of perfect knowledge")
    args = parser.parse_args(argv)
    print(f"wrote {run_tape(args.tape, args.seed, args.floor, telemetry=args.telemetry)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
