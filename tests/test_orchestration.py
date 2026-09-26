"""Tests for server/engine/orchestration.py: orchestrate_tick fans commands out and closes on a deadline."""
from dataclasses import asdict

import pytest

from server.engine.contracts import Policy, TapeFrame
from server.engine.fleet import apply_events, fleet_rollups, floor_kwh, new_fleet
from server.engine.orchestration import ACK_KEYS, cycle_rollups, orchestrate_tick, zone_acks

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
    return orchestrate_tick(homes, f, policy(), "AUTO", s, seed), homes, f


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


def test_a_caught_overstatement_is_booked_exactly_and_is_never_over_delivery():
    # Fast channel: nothing times out, so nothing is reassigned and nothing can over-deliver.
    liars = {f"home-{i:03d}": 1.5 for i in range(5, 101, 5)}
    result, _, f = cycle(0.2, _misreport=liars, **FAST)
    assert kinds(result, "charge_mismatch")
    assert not kinds(result, "over_delivery")
    assert not any(r.startswith("over_delivery") for r in result.allocation.reasons)
    ran = {e["command_id"]: e["actual_kw"] for e in kinds(result, "executed")}
    booked = {e["command_id"]: e["actual_kw"] for e in kinds(result, "confirmed")}
    for e in kinds(result, "charge_mismatch"):
        assert booked[e["command_id"]] == ran[e["command_id"]]   # exact, no rounding drift
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
    result = orchestrate_tick(homes, frame(0.2), policy(), "HOLD", s, 1)
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


# --- failures scheduled by the tape: events "network", "crash", "misreport" ----------

def run_frame(events, seed=3, **over):
    s = settings(**over)
    homes = new_fleet(s)
    f = frame(0.2, events)
    apply_events(homes, f.events)
    return orchestrate_tick(homes, f, policy(), "AUTO", s, seed), homes, f


def test_a_network_event_is_the_same_as_those_channel_settings_and_says_so():
    by_tape, _, f = run_frame({"network": {"drop_rate": 0.5, "dup_rate": 0.3, "late_rate": 0.2}})
    by_settings, _, _ = run_frame({}, channel_drop_rate=0.5, channel_dup_rate=0.3, channel_late_rate=0.2)
    assert by_tape.timed_out > 0
    assert "faults_injected" in by_tape.allocation.reasons
    assert "faults_injected" not in by_settings.allocation.reasons
    a, b = asdict(by_tape), asdict(by_settings)
    a["allocation"]["reasons"].remove("faults_injected")
    assert a == b
    check_books(by_tape, f.target_mw)


def test_a_crash_event_kills_only_the_listed_homes_that_ran_an_order():
    crash = ["home-001", "home-002", "home-003"]
    result, homes, f = run_frame({"crash": crash}, **FAST)
    ordered = {h for h, kw in result.allocation.per_home_kw.items() if kw > 0}
    status = {h.home_id: h.status for h in homes}
    assert set(crash) & ordered, "the fleet should give at least one listed home an order"
    for home_id in crash:
        assert status[home_id] == ("dead" if home_id in ordered else "live")
    assert sum(1 for s in status.values() if s == "dead") == len(set(crash) & ordered)
    assert len(kinds(result, "worker_error")) == len(set(crash) & ordered)
    assert "faults_injected" in result.allocation.reasons
    check_books(result, f.target_mw)


def test_a_misreport_event_is_caught_as_a_charge_mismatch():
    result, _, f = run_frame({"misreport": {"home-001": 1.5}}, **FAST)
    assert any(r.startswith("charge_mismatch:") for r in result.allocation.reasons)
    assert "faults_injected" in result.allocation.reasons
    check_books(result, f.target_mw)


def test_a_short_delivery_event_also_says_faults_injected():
    result, _, _ = run_frame({"short_delivery": {"home-001": 0.5}}, **FAST)
    assert "faults_injected" in result.allocation.reasons


def test_a_frame_without_fault_events_does_not_say_faults_injected():
    result, _, _ = run_frame({"dead": ["home-001"]}, **FAST)
    assert "faults_injected" not in result.allocation.reasons


@pytest.mark.parametrize("events", [
    {"network": {"drop_rate": 1.5}},
    {"network": {"drop": 0.5}},
    {"crash": ["home-999"]},
    {"misreport": {"home-001": -1.0}},
    {"misreport": {"home-999": 1.5}},
])
def test_a_bad_fault_event_stops_the_run_with_a_clear_error(events):
    with pytest.raises(ValueError):
        run_frame(events)


# --- zone acks: the per-zone counts the wall reads ---------------------------------

def check_acks(acks, homes):
    """Every zone has all five keys, and each home is counted exactly once in its own zone."""
    for zone, row in acks.items():
        assert tuple(row) == ACK_KEYS
        assert sum(row.values()) == sum(1 for h in homes if (h.zone or "unassigned") == zone)
    assert sum(sum(row.values()) for row in acks.values()) == len(homes)


def test_zone_acks_with_no_faults_acks_every_commanded_home_and_holds_the_rest():
    result, homes, _ = cycle(0.2, **FAST)
    acks = zone_acks(homes, result)
    check_acks(acks, homes)
    assert set(acks) == set(ZONES)
    commanded = {h for h, kw in result.allocation.per_home_kw.items() if kw > 0}
    assert sum(row["acked"] for row in acks.values()) == len(commanded)
    assert sum(row["held"] for row in acks.values()) == len(homes) - len(commanded)
    assert all(row["unconfirmed"] == row["dead"] == row["silent"] == 0 for row in acks.values())


def test_zone_acks_counts_dead_and_stale_homes_by_their_end_of_tick_status():
    houston = [h.home_id for h in new_fleet(settings()) if h.zone == "Houston"]
    result, homes, _ = cycle(0.2, events={"dead": houston[:3], "stale": houston[3:5]},
                             _fail_home_ids=["home-002"], **FAST)
    acks = zone_acks(homes, result)
    check_acks(acks, homes)
    home_002 = next(h for h in homes if h.home_id == "home-002")
    assert home_002.status == "dead"  # crashed mid-tick: dead, not unconfirmed
    dead_by_zone = {z: sum(1 for h in homes if h.zone == z and h.status == "dead") for z in ZONES}
    assert {z: acks[z]["dead"] for z in ZONES} == dead_by_zone
    assert acks["Houston"]["dead"] >= 3 and acks["Houston"]["silent"] == 2


def test_zone_acks_shows_homes_we_never_heard_back_from_as_unconfirmed():
    result, homes, _ = cycle(0.2, seed=3, channel_drop_rate=0.5)
    acks = zone_acks(homes, result)
    check_acks(acks, homes)
    heard = {cid.split(":")[0] for cid, state in result.command_states.items() if state == "confirmed"}
    asked = {cid.split(":")[0] for cid in result.command_states}
    live_unheard = {h.home_id for h in homes if h.status == "live"} & (asked - heard)
    assert live_unheard, "the seed should leave some live homes unconfirmed"
    assert sum(row["unconfirmed"] for row in acks.values()) == len(live_unheard)
    assert sum(row["acked"] for row in acks.values()) == len(heard & {h.home_id for h in homes
                                                                       if h.status == "live"})


def test_zone_acks_on_hold_counts_every_live_home_as_held():
    s = settings()
    homes = new_fleet(s)
    result = orchestrate_tick(homes, frame(0.2), policy(), "HOLD", s, 1)
    acks = zone_acks(homes, result)
    check_acks(acks, homes)
    assert sum(row["held"] for row in acks.values()) == len(homes)


@pytest.mark.parametrize("seed, over", [
    (3, {"channel_drop_rate": 0.5}),
    (5, {"channel_delay_s": (1.0, 100.0), "worker_delay_s": (1.0, 5.0)}),  # has over-delivery
])
def test_per_home_booked_kw_adds_up_to_the_confirmed_books(seed, over):
    result, homes, f = cycle(0.2 if seed == 3 else 0.05, seed=seed, **over)
    assert result.home_confirmed_kw
    assert all(kw > 0 for kw in result.home_confirmed_kw.values())
    assert sum(result.home_confirmed_kw.values()) / 1000 == pytest.approx(result.confirmed_mw)
    zone_of = {h.home_id: h.zone for h in homes}
    for zone, mw in result.zone_delivered_mw.items():
        in_zone = sum(kw for h, kw in result.home_confirmed_kw.items() if zone_of[h] == zone)
        assert in_zone / 1000 == pytest.approx(mw)
    check_books(result, f.target_mw)


def test_rollups_after_lost_orders_match_the_confirmed_books_and_the_acks():
    result, homes, _ = cycle(0.2, seed=3, channel_drop_rate=0.5)
    body = cycle_rollups(homes, result, policy())
    rows = body["zones"]
    acks = zone_acks(homes, result)
    assert sum(r["discharging_mw"] for r in rows.values()) == pytest.approx(result.confirmed_mw)
    assert sum(r["discharging"] for r in rows.values()) == len(result.home_confirmed_kw)
    for zone, row in rows.items():
        assert row["silent"] - row["stale"] == acks[zone]["unconfirmed"]
        assert row["live"] + row["silent"] + row["dead"] == sum(1 for h in homes if h.zone == zone)
    assert sum(r["discharging"] for r in rows.values()) < sum(
        1 for kw in result.allocation.per_home_kw.values() if kw > 0), "some orders were lost"


def test_rollups_with_no_faults_match_the_plan():
    result, homes, _ = cycle(0.2, **FAST)
    body = cycle_rollups(homes, result, policy())
    assert body == fleet_rollups(homes, result.allocation, policy())


def test_zone_acks_puts_a_home_with_no_zone_under_unassigned():
    result, homes, _ = cycle(0.2, **FAST)
    homes[0].zone = ""
    acks = zone_acks(homes, result)
    check_acks(acks, homes)
    assert sum(acks["unassigned"].values()) == 1


# --- charging: negative kW absorbs, is never delivery, never overfills ----------

def charge_policy(intent="charge", zone_intent=None):
    p = policy()
    p.intent = intent
    if zone_intent is not None:
        p.zone_intent = zone_intent
    return p


def charge_cycle(target_mw=0.2, seed=1, p=None, soc_pct=None, **over):
    """One cycle under a charge policy. soc_pct sets every home's start charge."""
    s = settings(**over)
    homes = new_fleet(s)
    if soc_pct is not None:
        for h in homes:
            h.soc_kwh = h.capacity_kwh * soc_pct / 100
    before = {h.home_id: h.soc_kwh for h in homes}
    result = orchestrate_tick(homes, frame(target_mw), p or charge_policy(), "AUTO", s, seed)
    return result, homes, before


def test_a_charge_tick_delivers_nothing_and_books_the_charge_apart():
    result, homes, before = charge_cycle(0.2, **FAST)
    check_books(result, 0.2)
    assert result.confirmed_mw == 0 and result.credited_mw == 0
    assert result.missed_mw == pytest.approx(0.2)
    assert planned(result) == 0
    absorbed = sum(h.soc_kwh - before[h.home_id] for h in homes) * 60 / 5 / 1000
    assert result.charged_mw > 0
    assert result.charged_mw == pytest.approx(absorbed)
    assert result.home_confirmed_kw == {}
    assert "charging" in result.allocation.reasons


def test_charging_never_fills_a_battery_past_full():
    faults = {"channel_drop_rate": 0.3, "channel_dup_rate": 0.3, "channel_late_rate": 0.2}
    for seed in range(1, 40):
        result, homes, _ = charge_cycle(0.2, seed=seed, soc_pct=98.5, **faults)
        over = [h.home_id for h in homes if h.soc_kwh > h.capacity_kwh + 1e-9]
        assert not over, f"seed {seed}: {over} past full"
        assert result.breaches == 0


def test_charging_a_home_still_under_a_raised_floor_is_not_a_breach():
    # 40% charge under a 60% floor: charging moves it up toward the floor, never below it.
    p = charge_policy()
    p.zone_reserve_pct = {z: 60.0 for z in ZONES}
    result, homes, before = charge_cycle(0.2, p=p, soc_pct=40.0, **FAST)
    assert all(h.soc_kwh > before[h.home_id] for h in homes)
    assert result.breaches == 0


def test_a_lost_charge_order_is_not_retried_or_reassigned():
    result, _, _ = charge_cycle(0.2, seed=3, channel_drop_rate=0.5)
    assert result.timed_out == 0 and result.retried == 0 and result.reassigned == 0
    assert not kinds(result, "reassigned")
    assert "unconfirmed" in result.command_states.values()


def test_an_oversized_charge_order_is_clamped_at_full(monkeypatch):
    import server.engine.orchestration as orch
    from server.engine.contracts import Allocation

    def huge_charge(homes, frame, policy, mode, settings):
        return Allocation({h.home_id: -50.0 for h in homes}, 0.0, frame.target_mw, ["charging"])

    monkeypatch.setattr(orch, "allocate", huge_charge)
    result, homes, _ = charge_cycle(0.2, soc_pct=99.0, **FAST)
    assert all(h.soc_kwh <= h.capacity_kwh + 1e-9 for h in homes)
    assert kinds(result, "clamped")


def test_a_charging_home_is_never_handed_discharge_work(monkeypatch):
    import server.engine.orchestration as orch
    from server.engine.contracts import Allocation

    def mixed(homes, frame, policy, mode, settings):
        # One zone with both directions: Houston's discharge orders get lost and must move.
        houston = [h for h in homes if h.zone == "Houston"]
        per_home = {h.home_id: 1.0 for h in houston[:5]}
        per_home.update({h.home_id: -1.0 for h in houston[5:]})
        return Allocation(per_home, 0.005, frame.target_mw - 0.005, [])

    monkeypatch.setattr(orch, "allocate", mixed)
    result, _, _ = charge_cycle(0.2, seed=3, channel_drop_rate=0.5)
    charging = {home_id for home_id, kw in result.allocation.per_home_kw.items() if kw < 0}
    assert kinds(result, "reassigned"), "the seed should move some lost discharge work"
    moved_to = {e["home_id"] for e in kinds(result, "reassigned")}
    assert not moved_to & charging


def test_a_battery_that_overstates_its_charge_is_booked_at_what_it_took():
    p = charge_policy()
    result, homes, before = charge_cycle(0.2, p=p, _misreport={"home-010": 2.0}, **FAST)
    assert "charge_mismatch:1" in result.allocation.reasons
    absorbed = sum(h.soc_kwh - before[h.home_id] for h in homes) * 60 / 5 / 1000
    assert result.charged_mw == pytest.approx(absorbed)


def test_zone_intent_books_discharge_and_charge_apart():
    p = charge_policy("discharge", {"Houston": "discharge", "North": "charge"})
    result, homes, before = charge_cycle(0.05, p=p, **FAST)
    check_books(result, 0.05)
    zone_of = {h.home_id: h.zone for h in homes}
    assert result.credited_mw == pytest.approx(0.05)
    assert {zone_of[h] for h in result.home_confirmed_kw} == {"Houston"}
    north_took = sum(h.soc_kwh - before[h.home_id] for h in homes if h.zone == "North")
    assert result.charged_mw == pytest.approx(north_took * 60 / 5 / 1000)
    acks = zone_acks(homes, result)
    assert acks["North"]["acked"] == 25


def test_a_charging_battery_is_not_flagged_as_a_liar_by_the_feed():
    from server.engine.telemetry import TelemetryState

    quiet = {"telemetry_outage_rate": 0.0, "telemetry_dup_rate": 0.0,
             "telemetry_late_rate": 0.0, "telemetry_liar_ids": ()}
    s = settings(**quiet, **FAST)
    homes = new_fleet(s)
    state = TelemetryState(homes, s, 1)
    for tick in (1, 2):
        orchestrate_tick(homes, frame(0.2, tick=tick), charge_policy(), "AUTO", s, 100 + tick,
                         telemetry=state)
    assert not [i for i, hs in state.homes.items() if hs.suspect]
