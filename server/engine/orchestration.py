"""The orchestration runtime (PRD O3, O4): one tick's commands, fanned out and closed on a deadline.

A central node plans with `allocate`, hands each zone's commands to a `ZoneSupervisor`, and
the supervisors send them through the lossy `Channel` to one `HomeWorker` per home. Everything
runs as events on one seeded `Scheduler`, so a run is replayable from its seed.

In-tick timeline (virtual seconds):
    0    commands go out
    60   unconfirmed commands are timed_out: one retry (same id), one reassignment (new id)
    120  the books close; anything that arrives later is logged as late and never counted

run_cycle writes no files. The runner at the bottom plays a tape and writes var/orchestration/.
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
from server.engine.controller import allocate, round_down
from server.engine.fleet import apply_events, floor_kwh, new_fleet, safe_kw, set_status
from server.engine.policy import reserve_policy
from server.engine.scheduler import Scheduler

OUT_DIR = Path("var") / "orchestration"
COUNTERS = ("breaches", "timed_out", "retried", "reassigned", "duplicates_ignored", "late",
            "short_delivery", "over_delivery", "charge_mismatch")
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
        self.counts = dict.fromkeys(COUNTERS, 0)
        self.workers = {}          # home_id to HomeWorker
        self.planned_kw = {}       # home_id to kW from the plan (used to find spare headroom)
        self.suspect = set()       # homes that timed out: kept live, but given no new work
        self.reassigned_to = set() # homes already holding a ":r" command (keeps ids unique)
        self.closed = False

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
        """Discharge for one command. The clamp is the second floor guard (the first is allocate)."""
        rt, home = self.rt, self.home
        if home.home_id in rt.fail_ids:
            raise RuntimeError("injected worker fault")
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
        if home.soc_kwh < floor_kwh(home, rt.policy) - 1e-9:
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
        return min(reported_kwh, dropped_kwh) / hours

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
            if (home.zone != self.zone or home.status != "live" or home.home_id == cmd.home_id
                    or home.home_id in rt.suspect or home.home_id in rt.reassigned_to):
                continue
            safe = safe_kw(home, rt.policy, rt.settings)
            spare = round_down(safe - rt.planned_kw.get(home.home_id, 0.0))
            if spare > best_spare:
                best, best_spare = home, spare
        return best, best_spare

    def close(self):
        """At 120 s: final states, and this zone's planned, confirmed, unconfirmed and over-delivered kW."""
        for command_id, state in self.states.items():
            if state != "confirmed":
                self.states[command_id] = "unconfirmed"
        planned = confirmed = unconfirmed = over = 0.0
        for cmd in self.shares:
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
        return planned, confirmed, unconfirmed, over


def short_fractions(frame):
    """home_id to the fraction of its order it really delivers, from the tape's events."""
    fractions = frame.events.get("short_delivery", {})
    for home_id, fraction in fractions.items():
        if not 0.0 <= fraction <= 1.0:
            raise ValueError(f"short_delivery for {home_id} must be between 0 and 1, got {fraction}")
    return fractions


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


def run_cycle(homes, frame, policy, mode, settings, seed):
    """Plan, fan out, wait for the deadlines, and close the books for one tick. Writes no files."""
    fractions = short_fractions(frame)
    plan = allocate(homes, frame, policy, mode, settings)
    rt = Runtime(settings, policy, frame.tick, seed)
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
    # Drain what is still in flight: stragglers can only be logged as late or expired now.
    rt.sched.run_until(math.inf)
    return build_result(frame, plan, rt, supervisors, books)


def build_result(frame, plan, rt, supervisors, books):
    zone_planned = {zone: b[0] / 1000 for zone, b in books.items()}
    zone_confirmed = {zone: b[1] / 1000 for zone, b in books.items()}
    zone_unconfirmed = {zone: b[2] / 1000 for zone, b in books.items()}
    over_delivery_mw = sum(b[3] for b in books.values()) / 1000
    confirmed_mw = sum(zone_confirmed.values())
    credited_mw = min(confirmed_mw, frame.target_mw)
    missed_mw = frame.target_mw - credited_mw
    c = rt.counts
    reasons = list(plan.reasons)
    for code in ("timed_out", "duplicates_ignored", "short_delivery", "over_delivery", "charge_mismatch"):
        if c[code]:
            reasons.append(f"{code}:{c[code]}")
    states = {}
    for sup in supervisors.values():
        states.update(sup.states)
    return CycleResult(
        allocation=Allocation(dict(plan.per_home_kw), credited_mw, missed_mw, reasons),
        breaches=c["breaches"], command_states=states,
        zone_planned_mw=zone_planned, zone_delivered_mw=zone_confirmed,
        zone_unconfirmed_mw=zone_unconfirmed, confirmed_mw=confirmed_mw, credited_mw=credited_mw,
        unconfirmed_mw=sum(zone_unconfirmed.values()), missed_mw=missed_mw,
        timed_out=c["timed_out"], retried=c["retried"], reassigned=c["reassigned"],
        duplicates_ignored=c["duplicates_ignored"], late=c["late"],
        over_delivery_mw=over_delivery_mw, events=rt.sched.events,
    )


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


def run_tape(tape, seed, floor="storm", out_dir=OUT_DIR):
    """Play every frame through run_cycle, print one line per tick, write one JSON file."""
    settings = read_settings()
    settings["seed"] = seed
    policy = build_policy(floor, settings)
    homes = new_fleet(settings)
    mode, ticks = "AUTO", []
    for frame in load_frames(tape):
        apply_events(homes, frame.events)
        mode = frame.events.get("operator", mode)   # HOLD/AUTO stays until the tape changes it
        # A different seed per tick, so each tick sees its own faults, still fixed by --seed.
        result = run_cycle(homes, frame, policy, mode, settings, seed * 100_000 + frame.tick)
        print(tick_line(frame, result))
        ticks.append({"tick": frame.tick, "ts": frame.ts, "mode": mode, "target_mw": frame.target_mw,
                      "target_label": frame.target_label, **asdict(result)})
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{seed}.json"
    record = {"seed": seed, "tape": str(tape), "floor": floor, "reserve_pct": policy.reserve_pct,
              "policy_reason": policy.reason, "ticks": ticks}
    path.write_text(json.dumps(record, indent=2))
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(prog="server.engine.orchestration",
                                     description="Play a tape through the orchestration runtime.")
    parser.add_argument("--tape", required=True, help="path to a tape JSON file")
    parser.add_argument("--seed", type=int, required=True, help="seed for every random fault")
    parser.add_argument("--floor", choices=("base", "storm"), default="storm",
                        help="reserve floor for every tick (default: storm)")
    args = parser.parse_args(argv)
    print(f"wrote {run_tape(args.tape, args.seed, args.floor)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
