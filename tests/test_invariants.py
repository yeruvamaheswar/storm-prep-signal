"""Seeded fuzzing of the orchestration runtime (PRD E2): every rule, every tick, many random worlds.

How it works: for each seed 1..N (N from the env var FUZZ_SEEDS, default 30) we build one random
world from random.Random(seed) (fleet size, per-zone floors that move mid-run, target, channel
faults, dead and stale homes, whole-zone kills, short deliveries, crashing and misreporting workers), run 12 ticks of run_cycle, and check the PRD rules after
every tick. The only randomness is the seeded Random, so a failing seed fails the same way forever.

Rerun one seed (prints one line per tick, raises on the first broken rule):
    .venv/bin/python -c "import sys; sys.path[:0] = ['.', 'tests']; from test_invariants import rerun; rerun(17)"
Run more seeds:
    FUZZ_SEEDS=50 .venv/bin/pytest -q -s tests/test_invariants.py

Manual mutation demo (notes, not tooling; do it on a scratch branch and undo it after):
    The floor math lives in server/engine/fleet.py, safe_kw():
        headroom = max(0.0, home.soc_kwh - floor_kwh(home, policy))
    Both floor guards read it (allocate's cap in controller.py and the execute clamp in
    HomeWorker.run in orchestration.py). Break it by replacing that line with
        headroom = max(0.0, home.soc_kwh)   # floor removed: the mutation
    and run `.venv/bin/pytest -q -s tests/test_invariants.py`. The fuzzer fails within the first
    seeds with "seed <n> tick <t>: breaches ..." (the runtime's own counter) and the
    "ended below its zone floor" check; rerun that seed with rerun(<n>) to watch it happen.
    Why not the execute clamp alone (orchestration.py HomeWorker.run, `kw = min(cmd.kw, safe)`)?
    Inside one cycle nothing lowers a home's headroom after allocate plans it (a reassignment only
    uses the spare kW left after the plan), so with allocate's cap in place that clamp never bites
    and removing only it leaves the fuzzer green. It is defense in depth, not the active guard.
"""
import os
import random

from server.engine.contracts import Policy, TapeFrame
from server.engine.fleet import apply_events, floor_kwh, new_fleet
from server.engine.orchestration import run_cycle

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}
TICKS = 12
TICK_MINUTES = 5
EPS = 1e-9
# Event kinds the runtime logs when a worker actually runs a command. A worker_error is a run
# that crashed part way, so it counts as an execution too: a command must never be tried twice.
EXECUTION_KINDS = ("executed", "worker_error")


def fuzz_seeds():
    return int(os.environ.get("FUZZ_SEEDS", "30"))


def base_settings(rng):
    # The same keys read_settings() in __main__.py produces, plus the runtime fault knobs.
    return {
        "fleet_size": rng.randint(20, 120), "home_kwh": 20.0, "home_max_kw": 5.0,
        "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
        "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0,
        "tick_minutes": TICK_MINUTES, "zones": ZONES,
        "channel_drop_rate": rng.uniform(0.0, 0.5),
        "channel_dup_rate": rng.uniform(0.0, 0.5),
        "channel_late_rate": rng.uniform(0.0, 0.3),
    }


def random_floors(rng):
    """Each zone independently at the base (30%) or storm (60%) floor."""
    return {zone: rng.choice((30.0, 60.0)) for zone in ZONES}


def make_policy(floors):
    # A copy of floors, so a later floor move never rewrites a policy an earlier tick used.
    reasons = {zone: ("weather_alert" if pct == 60.0 else "normal") for zone, pct in floors.items()}
    return Policy(30.0, "normal", "LOW", zone_reserve_pct=dict(floors), zone_reasons=reasons)


def random_events(rng, homes):
    """This tick's dead and stale homes, a few stale ones coming back, and some short deliveries."""
    ids = [h.home_id for h in homes]
    events = {
        "dead": rng.sample(ids, rng.randint(0, len(ids) // 10)),
        "stale": rng.sample(ids, rng.randint(0, len(ids) // 10)),
    }
    # Now and then a whole zone goes down at once (a feeder outage).
    if rng.random() < 0.05:
        zone = rng.choice(list(ZONES))
        events["dead"] += [h.home_id for h in homes if h.zone == zone and h.home_id not in events["dead"]]
    # A stale home can come back; a dead one stays dead. The lists never overlap, so the order
    # in which apply_events applies them does not matter.
    stale_now = [h.home_id for h in homes if h.status == "stale"]
    events["live"] = [i for i in rng.sample(stale_now, len(stale_now) // 2) if i not in events["dead"]]
    events["live"] = [i for i in events["live"] if i not in events["stale"]]
    short = rng.sample(ids, rng.randint(0, len(ids) // 4))
    events["short_delivery"] = {home_id: rng.random() for home_id in short}
    return events


def make_frame(tick, target_mw, events):
    return TapeFrame(tick, "2026-09-25T12:00:00-05:00", target_mw, "synthetic", 40.0, "synthetic",
                     events=events)


def check_tick(seed, tick, result, homes, policy, before, status_before, target_mw):
    """Every PRD rule and money invariant for one tick. The seed is in every message."""
    at = f"seed {seed} tick {tick}"
    planned = sum(result.zone_planned_mw.values())
    assert result.breaches == 0, f"{at}: breaches {result.breaches} (rerun({seed}))"
    assert 0 <= result.credited_mw <= target_mw + EPS, \
        f"{at}: credited {result.credited_mw} outside 0..{target_mw}"
    assert 0 <= result.confirmed_mw <= planned + EPS, \
        f"{at}: confirmed {result.confirmed_mw} outside 0..planned {planned}"
    assert abs(result.missed_mw - (target_mw - result.credited_mw)) <= EPS, \
        f"{at}: missed {result.missed_mw} != target {target_mw} - credited {result.credited_mw}"

    # Honest books: everything reported before the close is booked or shown as over-delivery.
    heard = sum(e["actual_kw"] for e in result.events if e["kind"] == "confirmed") / 1000
    assert abs(result.confirmed_mw + result.over_delivery_mw - heard) <= EPS, \
        f"{at}: confirmed {result.confirmed_mw} + over {result.over_delivery_mw} != heard {heard}"

    # Honest books under misreporting: no home is booked for more kWh than its charge dropped.
    booked = {}
    for e in result.events:
        if e["kind"] == "confirmed":
            booked[e["home_id"]] = booked.get(e["home_id"], 0.0) + e["actual_kw"] * TICK_MINUTES / 60
    for home_id, kwh in booked.items():
        dropped = before[home_id] - next(h for h in homes if h.home_id == home_id).soc_kwh
        assert kwh <= dropped + EPS, f"{at}: {home_id} booked {kwh} kWh but dropped only {dropped}"

    # Work only moves to a home that answered on time, never to one that timed out.
    timed_out = {e["home_id"] for e in result.events if e["kind"] == "timed_out"}
    moved_to = {e["home_id"] for e in result.events if e["kind"] == "reassigned"}
    assert not moved_to & timed_out, f"{at}: reassigned to timed-out homes {moved_to & timed_out}"

    # Bad data means play safe: no work for a home that was dead or stale when the plan was made.
    for home_id in result.allocation.per_home_kw:
        assert status_before[home_id] == "live", \
            f"{at}: {home_id} was {status_before[home_id]} but got work"

    # No command runs twice: at most one execution event per command id.
    runs = {}
    for event in result.events:
        if event["kind"] in EXECUTION_KINDS:
            runs[event["command_id"]] = runs.get(event["command_id"], 0) + 1
    twice = {cid: n for cid, n in runs.items() if n > 1}
    assert not twice, f"{at}: commands executed more than once: {twice}"

    by_id = {h.home_id: h for h in homes}
    for home_id, soc_before in before.items():
        home = by_id[home_id]
        lost = soc_before - home.soc_kwh
        if status_before[home_id] != "live":
            assert lost <= EPS, f"{at}: {home_id} was {status_before[home_id]} but lost {lost} kWh"
        if lost > EPS:
            floor = floor_kwh(home, policy)
            assert home.soc_kwh >= floor - EPS, \
                f"{at}: {home_id} ended below its zone floor ({home.soc_kwh} < {floor} kWh)"


def run_scenario(seed, verbose=False):
    """Build seed's random world, run TICKS cycles, check every tick. Returns (ticks, breaches)."""
    rng = random.Random(seed)
    settings = base_settings(rng)
    homes = new_fleet(settings)
    floors = random_floors(rng)
    target_mw = rng.uniform(0.05, 0.7)
    breaches = 0
    if rng.random() < 0.5:
        ids = [h.home_id for h in homes]
        settings["_fail_home_ids"] = rng.sample(ids, rng.randint(1, max(1, len(ids) // 10)))
    if rng.random() < 0.5:
        # Some workers misreport what they gave (0.5x to 2x); the books must still follow the charge.
        ids = [h.home_id for h in homes]
        liars = rng.sample(ids, rng.randint(1, max(1, len(ids) // 10)))
        settings["_misreport"] = {home_id: rng.uniform(0.5, 2.0) for home_id in liars}
    for tick in range(1, TICKS + 1):
        # Sometimes one zone's floor moves mid-run (a weather alert starts or ends), so homes
        # already below a newly raised floor must get nothing and not count as breaches.
        if rng.random() < 0.25:
            floors[rng.choice(list(ZONES))] = rng.choice((30.0, 60.0))
        policy = make_policy(floors)
        events = random_events(rng, homes)
        frame = make_frame(tick, target_mw, events)
        apply_events(homes, events)
        before = {h.home_id: h.soc_kwh for h in homes}
        status_before = {h.home_id: h.status for h in homes}
        # A distinct seed per tick, so each tick draws its own faults, all fixed by `seed`.
        result = run_cycle(homes, frame, policy, "AUTO", settings, seed * 1000 + tick)
        if verbose:
            print(f"seed {seed} tick {tick}: target {target_mw:.3f} planned "
                  f"{sum(result.zone_planned_mw.values()):.3f} confirmed {result.confirmed_mw:.3f} "
                  f"credited {result.credited_mw:.3f} unconfirmed {result.unconfirmed_mw:.3f} "
                  f"breaches {result.breaches}")
        breaches += result.breaches
        check_tick(seed, tick, result, homes, policy, before, status_before, target_mw)
    return TICKS, breaches


def rerun(seed):
    """Replay one seed with a line per tick; raises AssertionError on the first broken rule."""
    return run_scenario(seed, verbose=True)


def test_every_rule_holds_on_every_tick_of_every_seed():
    n = fuzz_seeds()
    ticks = breaches = 0
    for seed in range(1, n + 1):
        t, b = run_scenario(seed)
        ticks, breaches = ticks + t, breaches + b
    print(f"{n} seeds, {ticks} ticks, {breaches} floor breaches")
