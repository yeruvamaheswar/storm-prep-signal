"""Tests for server/engine/orchestration.py: run_cycle fans commands out and closes on a deadline."""
from dataclasses import asdict

import pytest

from server.engine.contracts import Policy, TapeFrame
from server.engine.fleet import apply_events, floor_kwh, new_fleet
from server.engine.orchestration import run_cycle

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}

# Short delays: every command and report fits well inside 60 s, so nothing times out.
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


def policy(pct=30.0):
    return Policy(pct, "normal", "LOW", zone_reserve_pct={z: pct for z in ZONES},
                  zone_reasons={z: "normal" for z in ZONES})


def frame(target_mw, events=None, tick=1):
    return TapeFrame(tick, "2026-09-25T12:00:00-05:00", target_mw, "synthetic", 40.0, "synthetic",
                     events=events or {})


def cycle(target_mw=0.2, seed=1, events=None, **over):
    """One cycle on a fresh default fleet. Returns (result, homes, frame)."""
    s = settings(**over)
    homes = new_fleet(s)
    f = frame(target_mw, events)
    apply_events(homes, f.events)
    return run_cycle(homes, f, policy(), "AUTO", s, seed), homes, f


def planned(result):
    return sum(result.zone_planned_mw.values())


def kinds(result, kind):
    return [e for e in result.events if e["kind"] == kind]


def check_reassignments(result):
    """Work is only ever handed to a home that answered on time, never to one that timed out."""
    timed_out = {e["home_id"] for e in kinds(result, "timed_out")}
    for move in kinds(result, "reassigned"):
        assert move["home_id"] not in timed_out, f"{move['command_id']} went to a timed-out home"


def check_books(result, target_mw):
    """The PRD money terms and invariants, checked on every result."""
    eps = 1e-9
    check_reassignments(result)
    assert result.breaches == 0
    assert 0 <= result.credited_mw <= target_mw + eps
    assert 0 <= result.confirmed_mw <= planned(result) + eps
    assert result.credited_mw == pytest.approx(min(result.confirmed_mw, target_mw), abs=eps)
    assert result.missed_mw == pytest.approx(target_mw - result.credited_mw, abs=eps)
    assert result.allocation.delivered_mw == pytest.approx(result.credited_mw, abs=eps)
    assert result.unconfirmed_mw >= 0
    assert result.confirmed_mw + result.unconfirmed_mw <= planned(result) + eps
    # Honest books: every kW a home reported before the close is either booked against its
    # share or shown as over-delivery. Nothing the batteries gave is silently dropped.
    heard = sum(e["actual_kw"] for e in kinds(result, "confirmed")) / 1000
    assert result.over_delivery_mw >= 0
    assert result.confirmed_mw + result.over_delivery_mw == pytest.approx(heard, abs=eps)
    # No command is booked above what its battery actually gave.
    ran = {e["command_id"]: e["actual_kw"] for e in kinds(result, "executed")}
    for e in kinds(result, "confirmed"):
        assert e["actual_kw"] <= ran[e["command_id"]] + eps


# --- determinism and the happy path ------------------------------------------

def test_same_seed_gives_the_same_cycle_result():
    faults = {"channel_drop_rate": 0.3, "channel_dup_rate": 0.3, "channel_late_rate": 0.2}
    a, _, _ = cycle(seed=7, **faults)
    b, _, _ = cycle(seed=7, **faults)
    assert asdict(a) == asdict(b)


def test_no_faults_confirms_everything_planned():
    result, _, f = cycle(0.2, **FAST)
    assert planned(result) == pytest.approx(0.2)
    assert result.confirmed_mw == pytest.approx(planned(result))
    assert result.unconfirmed_mw == 0 and result.timed_out == 0 and result.late == 0
    assert set(result.command_states.values()) == {"confirmed"}
    check_books(result, f.target_mw)


def test_cycle_closes_at_120_seconds():
    result, _, _ = cycle(channel_drop_rate=0.5)
    closed = kinds(result, "closed")
    assert len(closed) == 1 and closed[0]["t"] == 120.0


# --- channel faults ----------------------------------------------------------

def test_half_the_messages_dropped_leaves_unconfirmed_but_safe():
    result, _, f = cycle(0.2, seed=3, channel_drop_rate=0.5)
    assert result.unconfirmed_mw > 0
    assert result.credited_mw <= planned(result) + 1e-9
    assert any(r.startswith("timed_out:") for r in result.allocation.reasons)
    check_books(result, f.target_mw)


def test_every_message_duplicated_runs_each_command_once():
    s = settings(**FAST)
    before = {h.home_id: h.soc_kwh for h in new_fleet(s)}
    result, homes, f = cycle(0.2, channel_dup_rate=1.0, **FAST)
    assert result.duplicates_ignored > 0
    executed = [e["command_id"] for e in kinds(result, "executed")]
    assert len(executed) == len(set(executed))
    # Each home's charge dropped exactly once, by its planned kW over one tick.
    for home in homes:
        kw = result.allocation.per_home_kw.get(home.home_id, 0.0)
        assert before[home.home_id] - home.soc_kwh == pytest.approx(kw * 5 / 60)
    assert result.confirmed_mw == pytest.approx(planned(result))
    check_books(result, f.target_mw)


def test_late_reports_are_logged_but_not_counted():
    # Every message gets +100 s: commands still run before the close, reports land after it.
    result, _, f = cycle(0.2, channel_late_rate=1.0, channel_delay_s=(1.0, 5.0),
                         worker_delay_s=(1.0, 2.0))
    assert result.late > 0
    assert len(kinds(result, "late_report")) == result.late
    assert result.confirmed_mw == 0 and result.credited_mw == 0
    assert result.missed_mw == pytest.approx(f.target_mw)
    check_books(result, f.target_mw)


# --- failures inside the fleet -------------------------------------------------

def test_a_whole_dead_zone_still_lets_the_others_deliver():
    houston = [h.home_id for h in new_fleet(settings()) if h.zone == "Houston"]
    result, _, f = cycle(0.2, events={"dead": houston}, **FAST)
    assert result.zone_planned_mw.get("Houston", 0) == 0
    for zone in ("North", "South", "West"):
        assert result.zone_delivered_mw[zone] > 0
    assert kinds(result, "closed")[0]["t"] == 120.0
    check_books(result, f.target_mw)


def test_a_zone_that_fails_mid_cycle_does_not_stall_the_others():
    north = [h.home_id for h in new_fleet(settings()) if h.zone == "North"]
    result, homes, f = cycle(0.2, _fail_home_ids=north, **FAST)
    assert result.zone_delivered_mw["North"] == 0
    assert result.zone_unconfirmed_mw["North"] > 0
    assert all(result.zone_delivered_mw[z] > 0 for z in ("Houston", "South", "West"))
    assert all(h.status == "dead" for h in homes if h.zone == "North")
    assert kinds(result, "reassign_failed")  # no live home left in North to take the work
    assert kinds(result, "closed")[0]["t"] == 120.0
    check_books(result, f.target_mw)


def test_a_raising_worker_turns_only_that_home_dead():
    result, homes, f = cycle(0.2, _fail_home_ids=["home-005"], **FAST)
    dead = [h.home_id for h in homes if h.status == "dead"]
    assert dead == ["home-005"]
    errors = kinds(result, "worker_error")
    assert [e["home_id"] for e in errors] == ["home-005"]
    check_books(result, f.target_mw)


def test_short_delivery_is_booked_at_what_the_home_actually_gave():
    result, _, f = cycle(0.2, events={"short_delivery": {"home-010": 0.5}}, **FAST)
    kw = result.allocation.per_home_kw["home-010"]
    report = [e for e in kinds(result, "confirmed") if e["command_id"] == "home-010:1"][0]
    assert report["actual_kw"] == pytest.approx(kw * 0.5)
    assert "short_delivery:1" in result.allocation.reasons
    check_books(result, f.target_mw)


def test_an_overstated_report_is_flagged_and_booked_at_the_real_charge_drop():
    honest, _, _ = cycle(0.2, **FAST)
    result, _, f = cycle(0.2, _misreport={"home-010": 2.0}, **FAST)
    kw = result.allocation.per_home_kw["home-010"]
    [mismatch] = kinds(result, "charge_mismatch")
    assert mismatch["command_id"] == "home-010:1" and mismatch["home_id"] == "home-010"
    assert mismatch["dropped_kwh"] == pytest.approx(kw * 5 / 60)
    assert mismatch["reported_kwh"] == pytest.approx(2 * kw * 5 / 60)
    assert "charge_mismatch:1" in result.allocation.reasons
    report = [e for e in kinds(result, "confirmed") if e["command_id"] == "home-010:1"][0]
    assert report["actual_kw"] == pytest.approx(kw)   # the battery's real kW, not the claim
    assert result.confirmed_mw == pytest.approx(honest.confirmed_mw)
    check_books(result, f.target_mw)


def test_an_understated_report_is_flagged_and_booked_at_what_was_reported():
    result, _, f = cycle(0.2, _misreport={"home-010": 0.5}, **FAST)
    kw = result.allocation.per_home_kw["home-010"]
    [mismatch] = kinds(result, "charge_mismatch")
    assert mismatch["reported_kwh"] == pytest.approx(0.5 * mismatch["dropped_kwh"])
    report = [e for e in kinds(result, "confirmed") if e["command_id"] == "home-010:1"][0]
    assert report["actual_kw"] == pytest.approx(kw * 0.5)
    assert "charge_mismatch:1" in result.allocation.reasons
    check_books(result, f.target_mw)


def test_honest_reports_raise_no_charge_mismatch():
    result, _, _ = cycle(0.2, channel_dup_rate=1.0, events={"short_delivery": {"home-010": 0.5}}, **FAST)
    assert not kinds(result, "charge_mismatch")
    assert not any(r.startswith("charge_mismatch") for r in result.allocation.reasons)


def test_short_delivery_outside_zero_to_one_is_rejected():
    with pytest.raises(ValueError):
        cycle(0.2, events={"short_delivery": {"home-010": 1.5}})


# --- retry and reassignment ------------------------------------------------------

def test_a_retry_keeps_its_command_id():
    result, _, f = cycle(0.2, seed=2, channel_drop_rate=0.5)
    retries = kinds(result, "retry")
    assert retries and result.retried == len(retries)
    for event in retries:
        assert event["command_id"] == f"{event['home_id']}:1"
    check_books(result, f.target_mw)


def test_a_reassignment_gets_a_new_id_linked_to_its_parent():
    homes = new_fleet(settings())
    zone_of = {h.home_id: h.zone for h in homes}
    result, _, f = cycle(0.05, _fail_home_ids=["home-001"], **FAST)
    moves = kinds(result, "reassigned")
    assert len(moves) == 1 and result.reassigned == 1
    move = moves[0]
    assert move["parent_command_id"] == "home-001:1"
    assert move["command_id"] == f"{move['home_id']}:1:r"
    assert move["home_id"] != "home-001" and zone_of[move["home_id"]] == zone_of["home-001"]
    assert result.command_states[move["command_id"]] == "confirmed"
    # The dead home's share is made up by the reassignment, so nothing is left unconfirmed.
    assert result.unconfirmed_mw == 0
    check_books(result, f.target_mw)


def test_a_slow_original_and_its_reassignment_both_delivering_is_shown_as_over_delivery():
    # A channel this slow leaves some commands unconfirmed at 60 s but still running before the
    # close, so the slow original and the reassignment that replaced it can both deliver.
    result, _, f = cycle(0.05, seed=5, channel_delay_s=(1.0, 100.0), worker_delay_s=(1.0, 5.0))
    over = kinds(result, "over_delivery")
    assert over, "seed 5 should produce at least one double delivery"
    assert result.over_delivery_mw > 0
    excess = sum(e["actual_kw"] - e["planned_kw"] for e in over) / 1000
    assert result.over_delivery_mw == pytest.approx(excess)
    assert f"over_delivery:{len(over)}" in result.allocation.reasons
    # The share itself is still booked once, never above what was planned for it.
    assert result.confirmed_mw <= planned(result) + 1e-9
    check_books(result, f.target_mw)


def test_work_is_never_reassigned_to_a_home_that_also_timed_out():
    # Every message is 100 s late: nothing confirms by 60 s, so every home is suspect at once
    # and there is nobody trusted left to take anyone else's share.
    result, _, f = cycle(0.2, channel_late_rate=1.0)
    assert result.timed_out > 0
    assert result.reassigned == 0
    assert kinds(result, "reassign_failed")
    check_books(result, f.target_mw)


def test_hold_sends_nothing_and_still_closes():
    s = settings()
    homes = new_fleet(s)
    result = run_cycle(homes, frame(0.2), policy(), "HOLD", s, 1)
    assert result.command_states == {} and result.credited_mw == 0
    assert result.allocation.reasons == ["operator_hold"]
    check_books(result, 0.2)


# --- invariants across many faulty runs ------------------------------------------

@pytest.mark.parametrize("seed", range(1, 13))
def test_money_invariants_hold_under_random_faults(seed):
    faults = {"channel_drop_rate": 0.3, "channel_dup_rate": 0.3, "channel_late_rate": 0.2}
    target = 0.05 * seed  # 0.05 .. 0.6 MW, so some runs ask for more than the fleet has
    result, homes, f = cycle(target, seed=seed, _fail_home_ids=["home-003", "home-050"], **faults)
    check_books(result, f.target_mw)
    for home in homes:
        assert home.soc_kwh >= floor_kwh(home, policy()) - 1e-9
