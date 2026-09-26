"""The PRD E1 failure cases that tests/test_orchestration.py does not already cover.

Each case breaks something on purpose (half the fleet dead, a floor raised between ticks, a lost
report, a worker too slow for the deadline, homes that give less than ordered) and checks that
the cycle still closes on time, no home goes below its floor, and the books stay honest.
"""
import pytest

from server.engine.contracts import Policy, TapeFrame
from server.engine.fleet import apply_events, floor_kwh, new_fleet
from server.engine.orchestration import HomeWorker, orchestrate_tick

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}
EPS = 1e-9

# Short delays: every command and report fits well inside 60 s unless a test says otherwise.
FAST = {"channel_delay_s": (1.0, 5.0), "worker_delay_s": (1.0, 5.0)}


def settings(**over):
    # The same keys read_settings() in __main__.py produces, plus the runtime knobs under test.
    base = {
        "fleet_size": 100, "home_kwh": 20.0, "home_max_kw": 5.0,
        "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
        "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0,
        "tick_minutes": 5, "zones": ZONES,
    }
    base.update(over)
    return base


def policy(pct=30.0, reason="normal"):
    return Policy(pct, reason, "LOW", zone_reserve_pct={z: pct for z in ZONES},
                  zone_reasons={z: reason for z in ZONES})


def frame(target_mw, events=None, tick=1):
    return TapeFrame(tick, "2026-09-25T12:00:00-05:00", target_mw, "synthetic", 40.0, "synthetic",
                     events=events or {})


def planned(result):
    return sum(result.zone_planned_mw.values())


def kinds(result, kind):
    return [e for e in result.events if e["kind"] == kind]


def check_books(result, target_mw, homes, pol, before):
    """Money invariants, no double execution, and no home that lost charge below its floor."""
    assert result.breaches == 0
    assert 0 <= result.credited_mw <= target_mw + EPS
    assert 0 <= result.confirmed_mw <= planned(result) + EPS
    assert result.missed_mw == pytest.approx(target_mw - result.credited_mw, abs=EPS)
    assert result.allocation.delivered_mw == pytest.approx(result.credited_mw, abs=EPS)
    executed = [e["command_id"] for e in kinds(result, "executed")]
    assert len(executed) == len(set(executed))
    for home in homes:
        if before[home.home_id] - home.soc_kwh > EPS:
            assert home.soc_kwh >= floor_kwh(home, pol) - EPS


def run(homes, target_mw, pol, s, seed=1, events=None, tick=1):
    """One cycle on the given homes. Returns (result, frame, charge before the cycle)."""
    f = frame(target_mw, events, tick)
    apply_events(homes, f.events)
    before = {h.home_id: h.soc_kwh for h in homes}
    return orchestrate_tick(homes, f, pol, "AUTO", s, seed), f, before


# --- mass failure ----------------------------------------------------------------

def test_mass_failure_delivers_from_the_homes_that_are_left():
    s = settings(**FAST)
    homes = new_fleet(s)
    dead = [h.home_id for h in homes][:60]   # 60 of 100: well over half, across every zone
    pol = policy()
    result, f, before = run(homes, 0.1, pol, s, events={"dead": dead})
    assert "homes_dead:60" in result.allocation.reasons
    assert not set(dead) & set(result.allocation.per_home_kw)
    assert result.credited_mw > 0 and planned(result) > 0
    for home_id in dead:   # a dead home is never touched
        assert next(h for h in homes if h.home_id == home_id).soc_kwh == before[home_id]
    assert kinds(result, "closed")[0]["t"] == 120.0
    check_books(result, f.target_mw, homes, pol, before)


def test_mass_failure_with_a_big_target_is_short_and_says_why():
    s = settings(**FAST)
    homes = new_fleet(s)
    dead = [h.home_id for h in homes][::2] + [h.home_id for h in homes][1:40:2]
    pol = policy()
    result, f, before = run(homes, 0.5, pol, s, events={"dead": dead})
    assert result.missed_mw > 0
    assert "fleet_headroom_short" in result.allocation.reasons
    assert f"homes_dead:{len(dead)}" in result.allocation.reasons
    check_books(result, f.target_mw, homes, pol, before)


# --- a floor raised between ticks ---------------------------------------------------

def test_a_newly_raised_floor_gives_under_floor_homes_nothing_and_is_not_a_breach():
    s = settings(**FAST)
    homes = new_fleet(s)
    base, storm = policy(30.0), policy(60.0, "storm_risk_high")
    first, f1, before1 = run(homes, 0.3, base, s, seed=1, tick=1)
    check_books(first, f1.target_mw, homes, base, before1)
    # The storm floor arrives: the same homes, with the charge the first tick left them.
    under = {h.home_id for h in homes if h.soc_kwh <= floor_kwh(h, storm)}
    assert under, "the raised floor should leave some homes at or under it"
    second, f2, before2 = run(homes, 0.3, storm, s, seed=2, tick=2)
    assert not under & set(second.allocation.per_home_kw)
    for home in homes:
        if home.home_id in under:
            assert home.soc_kwh == before2[home.home_id]   # under the new floor: untouched
    assert second.breaches == 0
    assert planned(second) < planned(first)
    check_books(second, f2.target_mw, homes, storm, before2)


# --- lost reports ---------------------------------------------------------------------

def lose_reports(monkeypatch, how_many):
    """Drop the first `how_many` reports of each command on the way back (None = all of them).

    The channel's drop rate hits commands and reports alike; this reaches the report leg only,
    so the home really discharged but the supervisor never hears about it.
    """
    real_send, seen = HomeWorker.send_report, {}

    def send_report(self, report):
        n = seen.get(report["command_id"], 0)
        seen[report["command_id"]] = n + 1
        if how_many is None or n < how_many:
            self.rt.log("report_lost_in_test", command_id=report["command_id"])
            return
        real_send(self, report)

    monkeypatch.setattr(HomeWorker, "send_report", send_report)


def test_a_report_lost_every_time_leaves_the_work_unconfirmed_and_uncredited(monkeypatch):
    lose_reports(monkeypatch, None)
    s = settings(**FAST)
    homes = new_fleet(s)
    pol = policy()
    result, f, before = run(homes, 0.2, pol, s)
    assert planned(result) > 0
    assert kinds(result, "executed")          # the homes really gave energy...
    assert result.confirmed_mw == 0 and result.credited_mw == 0   # ...but none of it is booked
    assert result.unconfirmed_mw == pytest.approx(planned(result))
    assert result.missed_mw == pytest.approx(f.target_mw)
    assert result.timed_out > 0 and result.retried == result.timed_out
    check_books(result, f.target_mw, homes, pol, before)


def test_a_lost_report_is_recovered_by_the_retry_without_running_twice(monkeypatch):
    lose_reports(monkeypatch, 1)
    s = settings(**FAST)
    homes = new_fleet(s)
    pol = policy()
    result, f, before = run(homes, 0.2, pol, s)
    # The retry reaches a worker that already ran it: it answers again but does not run again.
    assert result.duplicates_ignored > 0
    assert result.confirmed_mw == pytest.approx(planned(result))
    for home_id, kw in result.allocation.per_home_kw.items():
        home = next(h for h in homes if h.home_id == home_id)
        assert before[home_id] - home.soc_kwh >= kw * 5 / 60 - EPS   # ran at least once
    check_books(result, f.target_mw, homes, pol, before)


def test_every_message_dropped_confirms_nothing_and_touches_no_home():
    s = settings(channel_drop_rate=1.0)
    homes = new_fleet(s)
    pol = policy()
    result, f, before = run(homes, 0.2, pol, s)
    assert planned(result) > 0 and result.credited_mw == 0
    assert result.unconfirmed_mw == pytest.approx(planned(result))
    assert all(h.soc_kwh == before[h.home_id] for h in homes)
    check_books(result, f.target_mw, homes, pol, before)


# --- a straggler past the deadline ------------------------------------------------------

def test_a_straggler_past_the_close_expires_and_leaves_charge_alone():
    # Workers take 130-140 s, so no command can run before the 120 s close.
    s = settings(channel_delay_s=(1.0, 5.0), worker_delay_s=(130.0, 140.0))
    homes = new_fleet(s)
    pol = policy()
    result, f, before = run(homes, 0.2, pol, s)
    closed = kinds(result, "closed")
    assert len(closed) == 1 and closed[0]["t"] == 120.0
    assert kinds(result, "expired") and all(e["t"] > 120.0 for e in kinds(result, "expired"))
    assert not kinds(result, "executed")
    assert result.confirmed_mw == 0 and result.credited_mw == 0
    assert result.unconfirmed_mw == pytest.approx(planned(result))
    assert set(result.command_states.values()) == {"unconfirmed"}
    assert all(h.soc_kwh == before[h.home_id] for h in homes)
    check_books(result, f.target_mw, homes, pol, before)


# --- short delivery across many homes ------------------------------------------------------

def test_short_delivery_across_many_homes_books_only_what_was_given():
    s = settings(**FAST)
    homes = new_fleet(s)
    short = {h.home_id: 0.5 for h in homes[::2]}   # every other home gives half its order
    pol = policy()
    result, f, before = run(homes, 0.2, pol, s, events={"short_delivery": short})
    given = sum(e["actual_kw"] for e in kinds(result, "confirmed")) / 1000
    assert result.confirmed_mw == pytest.approx(given)
    assert result.credited_mw < planned(result)
    assert result.missed_mw > 0
    n_short = len(short.keys() & result.allocation.per_home_kw.keys())
    assert f"short_delivery:{n_short}" in result.allocation.reasons
    for home_id, kw in result.allocation.per_home_kw.items():   # charge fell by what was given
        home = next(h for h in homes if h.home_id == home_id)
        assert before[home_id] - home.soc_kwh == pytest.approx(kw * short.get(home_id, 1.0) * 5 / 60)
    check_books(result, f.target_mw, homes, pol, before)


# --- workers that misreport what they gave -------------------------------------------------

def test_homes_that_overstate_their_charge_drop_are_credited_only_what_the_battery_gave():
    s = settings(**FAST)
    homes = new_fleet(s)
    liars = {h.home_id: 1.5 for h in homes[::3]}   # every third home claims 50% more than it gave
    s["_misreport"] = liars
    pol = policy()
    result, f, before = run(homes, 0.2, pol, s)
    n_liars = len(liars.keys() & result.allocation.per_home_kw.keys())
    assert n_liars > 0 and len(kinds(result, "charge_mismatch")) == n_liars
    assert f"charge_mismatch:{n_liars}" in result.allocation.reasons
    dropped = sum(before[h.home_id] - h.soc_kwh for h in homes)   # kWh the batteries really gave
    assert result.confirmed_mw * 1000 * 5 / 60 == pytest.approx(dropped)
    check_books(result, f.target_mw, homes, pol, before)
