"""Tests for server/engine/controller.py: allocate() splits the target using only energy above each floor."""
import copy

import pytest

from server.engine.contracts import Allocation, Home, Policy, TapeFrame
from server.engine.controller import acted_intent, allocate
from server.engine.fleet import discharge, floor_kwh, new_fleet

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}


def settings(**over):
    # The same keys read_settings() in __main__.py produces, with the .env.example defaults.
    base = {
        "fleet_size": 100, "home_kwh": 20.0, "home_max_kw": 5.0,
        "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
        "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0,
        "tick_minutes": 5, "zones": ZONES,
    }
    base.update(over)
    return base


def policy(pct=30.0, reason="normal", intent="discharge", **zone_over):
    """Every zone at `pct`, except the zones named in zone_over (for example Houston=60.0)."""
    floors = {z: pct for z in ZONES}
    floors.update(zone_over)
    reasons = {z: reason for z in ZONES}
    level = "HIGH" if reason == "storm_risk_high" else "LOW"
    p = Policy(pct, reason, level, zone_reserve_pct=floors, zone_reasons=reasons)
    p.intent = intent
    return p


def frame(target_mw):
    return TapeFrame(1, "2026-09-25T12:00:00-05:00", target_mw, "synthetic", 40.0, "synthetic")


def home(home_id, soc_kwh, zone="Houston", status="live", max_kw=100.0):
    # max_kw is large by default so the floor, not the inverter, sets the cap.
    return Home(home_id, 20.0, soc_kwh, max_kw, status=status, zone=zone)


def check_books(alloc, target_mw):
    """The money invariant every test checks: missed is exactly what was not delivered."""
    assert alloc.missed_mw == pytest.approx(target_mw - alloc.delivered_mw, abs=1e-9)
    assert 0 <= alloc.delivered_mw <= target_mw + 1e-12
    assert all(kw > 0 for kw in alloc.per_home_kw.values())


def check_charge_books(alloc, target_mw):
    """An idle charge tick (no call) delivers 0, misses nothing, and writes negative kW only."""
    assert alloc.delivered_mw == 0.0
    assert alloc.missed_mw == pytest.approx(target_mw)
    assert all(kw < 0 for kw in alloc.per_home_kw.values())


def assert_real_reasons(alloc):
    """Wall codes only. A TEMP stub must never leak `temp_stub` onto the tick."""
    assert "temp_stub" not in alloc.reasons
    for code in alloc.reasons:
        ok = code in ("operator_hold", "holding_spare_energy", "charging",
                      "storm_reserve", "fleet_headroom_short", "unknown_zone")
        ok = ok or code.startswith("homes_dead:") or code.startswith("homes_stale:")
        assert ok, f"unexpected reason {code!r}"


# --- units and splitting ---------------------------------------------------

def test_half_a_megawatt_is_treated_as_500_kw():
    # Default fleet at a 30% floor: every home can give its full 5 kW, 100 x 5 = 500 kW.
    alloc = allocate(new_fleet(settings()), frame(0.5), policy(), "AUTO", settings())
    assert sum(alloc.per_home_kw.values()) == pytest.approx(500.0)
    assert alloc.delivered_mw == pytest.approx(0.5)
    assert alloc.reasons == []
    check_books(alloc, 0.5)


def test_target_under_capacity_gives_proportional_shares_summing_to_target():
    # Headroom over a 6 kWh floor: 1, 2, 3 kWh, so caps 12, 24, 36 kW (60 / 5 min = x12).
    homes = [home("a", 7.0), home("b", 8.0), home("c", 9.0)]
    alloc = allocate(homes, frame(0.036), policy(), "AUTO", settings())
    kw = alloc.per_home_kw
    assert sum(kw.values()) == pytest.approx(36.0)
    assert kw["a"] == pytest.approx(6.0) and kw["b"] == pytest.approx(12.0) and kw["c"] == pytest.approx(18.0)
    assert alloc.reasons == []
    check_books(alloc, 0.036)


def test_target_above_capacity_gives_every_home_its_cap_and_headroom_short():
    homes = [home("a", 7.0), home("b", 8.0)]          # caps 12 and 24 kW
    alloc = allocate(homes, frame(1.0), policy(), "AUTO", settings())
    assert alloc.per_home_kw == {"a": 12.0, "b": 24.0}
    assert alloc.delivered_mw == pytest.approx(0.036)
    assert alloc.reasons == ["fleet_headroom_short"]
    check_books(alloc, 1.0)


def test_shortfall_under_a_storm_policy_is_storm_reserve():
    homes = [home("a", 13.0)]                          # 60% floor = 12 kWh, cap 12 kW
    alloc = allocate(homes, frame(1.0), policy(60.0, "storm_risk_high"), "AUTO", settings())
    assert alloc.reasons == ["storm_reserve"]
    check_books(alloc, 1.0)


def test_one_zone_weather_alert_makes_a_shortfall_storm_reserve():
    p = policy(30.0, Houston=60.0)
    p.zone_reasons["Houston"] = "weather_alert"
    alloc = allocate([home("a", 7.0, zone="North")], frame(1.0), p, "AUTO", settings())
    assert alloc.reasons == ["storm_reserve"]
    check_books(alloc, 1.0)


def test_caps_are_rounded_down_to_six_decimals():
    # Headroom 1/7 kWh gives 12/7 = 1.7142857... kW; rounding down keeps it under the true cap.
    homes = [home("a", 6.0 + 1 / 7)]
    alloc = allocate(homes, frame(1.0), policy(), "AUTO", settings())
    assert alloc.per_home_kw == {"a": 1.714285}
    check_books(alloc, 1.0)


# --- floors ----------------------------------------------------------------

def test_home_exactly_at_its_floor_gets_nothing():
    homes = [home("a", 6.0), home("b", 7.0)]           # 30% of 20 kWh = 6 kWh exactly
    alloc = allocate(homes, frame(0.001), policy(), "AUTO", settings())
    assert "a" not in alloc.per_home_kw
    assert alloc.per_home_kw["b"] == pytest.approx(1.0)
    check_books(alloc, 0.001)


def test_home_under_a_raised_zone_floor_gets_nothing():
    homes = [home("a", 9.0)]                           # 45%, under a 60% floor of 12 kWh
    alloc = allocate(homes, frame(0.1), policy(60.0, "storm_risk_high"), "AUTO", settings())
    assert alloc.per_home_kw == {}
    assert alloc.delivered_mw == 0.0
    assert alloc.reasons == ["storm_reserve"]
    check_books(alloc, 0.1)


def test_per_zone_floors_are_honored_houston_60_others_30():
    homes = [home("h", 13.0, zone="Houston"), home("n", 13.0, zone="North"),
             home("s", 13.0, zone="South"), home("w", 13.0, zone="West")]
    p = policy(30.0, Houston=60.0)
    alloc = allocate(homes, frame(1.0), p, "AUTO", settings())
    assert alloc.per_home_kw["h"] == pytest.approx(12.0)   # 13 - 12 kWh floor, x12
    for other in ("n", "s", "w"):
        assert alloc.per_home_kw[other] == pytest.approx(84.0)  # 13 - 6 kWh floor, x12
    check_books(alloc, 1.0)


def test_max_kw_limits_the_cap():
    alloc = allocate([home("a", 19.0, max_kw=5.0)], frame(1.0), policy(), "AUTO", settings())
    assert alloc.per_home_kw == {"a": 5.0}
    check_books(alloc, 1.0)


# --- bad data and operator -------------------------------------------------

def test_dead_and_stale_homes_get_nothing_and_are_counted():
    homes = [home("a", 10.0, status="dead"), home("b", 10.0, status="dead"),
             home("c", 10.0, status="stale"), home("d", 10.0)]
    alloc = allocate(homes, frame(1.0), policy(), "AUTO", settings())
    assert set(alloc.per_home_kw) == {"d"}
    assert alloc.reasons == ["fleet_headroom_short", "homes_dead:2", "homes_stale:1"]
    check_books(alloc, 1.0)


def test_dead_count_is_reported_even_when_the_target_is_met():
    homes = [home("a", 10.0, status="dead"), home("b", 10.0)]
    alloc = allocate(homes, frame(0.001), policy(), "AUTO", settings())
    assert alloc.reasons == ["homes_dead:1"]
    check_books(alloc, 0.001)


def test_all_dead_delivers_nothing():
    homes = [home("a", 10.0, status="dead"), home("b", 10.0, status="dead")]
    alloc = allocate(homes, frame(0.2), policy(), "AUTO", settings())
    assert alloc.per_home_kw == {} and alloc.delivered_mw == 0.0
    assert alloc.reasons == ["fleet_headroom_short", "homes_dead:2"]
    check_books(alloc, 0.2)


def test_hold_gives_nothing_with_operator_hold_only():
    homes = [home("a", 10.0), home("b", 10.0, status="dead")]
    alloc = allocate(homes, frame(0.2), policy(), "HOLD", settings())
    assert alloc.per_home_kw == {}
    assert alloc.delivered_mw == 0.0 and alloc.missed_mw == pytest.approx(0.2)
    assert alloc.reasons == ["operator_hold"]
    check_books(alloc, 0.2)


def test_negative_target_is_rejected():
    with pytest.raises(ValueError):
        allocate([home("a", 10.0)], frame(-0.1), policy(), "AUTO", settings())


def test_zero_target_is_a_no_op():
    homes = [home("a", 10.0), home("b", 10.0, status="dead")]
    alloc = allocate(homes, frame(0.0), policy(), "AUTO", settings())
    assert alloc.per_home_kw == {} and alloc.delivered_mw == 0.0 and alloc.missed_mw == 0.0
    assert alloc.reasons == []
    check_books(alloc, 0.0)


def test_unknown_zone_gets_nothing_with_unknown_zone():
    homes = [home("a", 10.0, zone="Panhandle"), home("b", 10.0, zone=""), home("c", 7.0)]
    alloc = allocate(homes, frame(1.0), policy(), "AUTO", settings())
    assert set(alloc.per_home_kw) == {"c"}
    assert alloc.reasons == ["fleet_headroom_short", "unknown_zone"]
    check_books(alloc, 1.0)


def test_policy_without_zone_floors_falls_back_to_reserve_pct():
    # An older Policy with no zone table: every home uses reserve_pct, and no zone is "unknown".
    p = Policy(30.0, "normal", "LOW")
    p.intent = "discharge"
    alloc = allocate([home("a", 7.0, zone="")], frame(1.0), p, "AUTO", settings())
    assert alloc.per_home_kw == {"a": 12.0}
    assert alloc.reasons == ["fleet_headroom_short"]
    check_books(alloc, 1.0)


# --- purity and the second guard -------------------------------------------

def test_allocate_never_changes_the_homes():
    homes = new_fleet(settings())
    homes[0].status = "dead"
    homes[1].status = "stale"
    before = copy.deepcopy(homes)
    allocate(homes, frame(0.3), policy(60.0, "storm_risk_high"), "AUTO", settings())
    allocate(homes, frame(0.3), policy(), "HOLD", settings())
    assert homes == before


@pytest.mark.parametrize("pct, reason", [(30.0, "normal"), (60.0, "storm_risk_high")])
@pytest.mark.parametrize("target_mw", [0.1, 0.5, 2.0])
def test_discharge_of_an_allocation_never_breaches(pct, reason, target_mw):
    homes = new_fleet(settings())
    p = policy(pct, reason)
    start = {h.home_id: h.soc_kwh for h in homes}
    alloc = allocate(homes, frame(target_mw), p, "AUTO", settings())
    check_books(alloc, target_mw)
    assert discharge(homes, alloc, p, settings()) == 0
    # At 60% about half the fleet starts under the floor; those homes must simply not move.
    for h in homes:
        assert h.soc_kwh >= min(start[h.home_id], floor_kwh(h, p)) - 1e-9
        if start[h.home_id] <= floor_kwh(h, p):
            assert h.soc_kwh == start[h.home_id]


# --- archive 0.40 MW wall cases (HOLD / AUTO under cap / storm 60% miss) ---

def test_hold_on_archive_call_delivers_zero():
    # HOLD is the reserved stop: every home 0 kW, missed is the 0.40 MW call.
    homes = new_fleet(settings())
    p, s = policy(), settings()
    alloc = allocate(homes, frame(0.40), p, "HOLD", s)
    assert alloc.per_home_kw == {}
    assert alloc.delivered_mw == 0.0 and alloc.missed_mw == pytest.approx(0.40)
    assert alloc.reasons == ["operator_hold"]
    assert_real_reasons(alloc)
    check_books(alloc, 0.40)
    assert discharge(homes, alloc, p, s) == 0


def test_auto_under_cap_splits_040_mw_across_live_homes():
    # 100 live homes above a 30% floor can give 0.50 MW. 0.40 MW is under that cap.
    homes = new_fleet(settings())
    p, s = policy(), settings()
    alloc = allocate(homes, frame(0.40), p, "AUTO", s)
    assert alloc.delivered_mw == pytest.approx(0.40)
    assert alloc.missed_mw == pytest.approx(0.0)
    assert len(alloc.per_home_kw) == 100
    assert all(0 < kw <= 5.0 for kw in alloc.per_home_kw.values())
    assert alloc.reasons == []
    assert_real_reasons(alloc)
    check_books(alloc, 0.40)
    assert discharge(homes, alloc, p, s) == 0


def test_storm_60_floor_misses_040_mw_without_breaches():
    # About half the seeded fleet starts under 60%, so the 0.40 MW call is missed on purpose.
    homes = new_fleet(settings())
    p, s = policy(60.0, "storm_risk_high"), settings()
    start = {h.home_id: h.soc_kwh for h in homes}
    alloc = allocate(homes, frame(0.40), p, "AUTO", s)
    assert 0 < alloc.delivered_mw < 0.40
    assert alloc.missed_mw == pytest.approx(0.40 - alloc.delivered_mw)
    assert alloc.reasons == ["storm_reserve"]
    assert_real_reasons(alloc)
    check_books(alloc, 0.40)
    assert discharge(homes, alloc, p, s) == 0
    for h in homes:
        assert h.soc_kwh >= min(start[h.home_id], floor_kwh(h, p)) - 1e-9
        if start[h.home_id] <= floor_kwh(h, p):
            assert h.soc_kwh == start[h.home_id]


# --- intent: hold still serves the call, discharge sells, charge absorbs ---------

def test_hold_intent_still_serves_the_call_from_headroom():
    # Hold is a wall label, not a dispatch stop: the grid's call is served from
    # headroom (CONSTRAINTS allocation rule). Caps bind first: 4 kWh x12 = 48 kW each.
    homes = [home("a", 10.0), home("b", 10.0)]
    alloc = allocate(homes, frame(0.2), policy(intent="hold"), "AUTO", settings())
    assert alloc.per_home_kw == {"a": 48.0, "b": 48.0}
    assert alloc.delivered_mw == pytest.approx(0.096)
    assert alloc.missed_mw == pytest.approx(0.104)
    assert alloc.reasons == ["fleet_headroom_short"]
    assert_real_reasons(alloc)
    check_books(alloc, 0.2)


def test_hold_intent_still_counts_dead_and_stale():
    homes = [home("a", 10.0), home("b", 10.0, status="dead"), home("c", 10.0, status="stale")]
    alloc = allocate(homes, frame(0.2), policy(intent="hold"), "AUTO", settings())
    assert alloc.per_home_kw == {"a": 48.0}
    assert alloc.delivered_mw == pytest.approx(0.048)
    assert alloc.missed_mw == pytest.approx(0.152)
    assert alloc.reasons == ["fleet_headroom_short", "homes_dead:1", "homes_stale:1"]
    assert_real_reasons(alloc)
    check_books(alloc, 0.2)


def test_discharge_intent_keeps_the_positive_split():
    # Cheap-tick fix must not change a sell tick: same proportional shares as before.
    homes = [home("a", 7.0), home("b", 8.0), home("c", 9.0)]
    alloc = allocate(homes, frame(0.036), policy(intent="discharge"), "AUTO", settings())
    assert alloc.per_home_kw["a"] == pytest.approx(6.0)
    assert alloc.per_home_kw["b"] == pytest.approx(12.0)
    assert alloc.per_home_kw["c"] == pytest.approx(18.0)
    assert alloc.delivered_mw == pytest.approx(0.036)
    check_books(alloc, 0.036)


def test_idle_charge_intent_writes_negative_kw_only():
    # No call, cheap power. Room to a 20 kWh cap: 10, 5, 1 kWh x12 = 120, 60, 12 kW, capped by max_kw 100.
    homes = [home("a", 10.0), home("b", 15.0), home("c", 19.0)]
    alloc = allocate(homes, frame(0.0), policy(intent="charge"), "AUTO", settings())
    assert alloc.per_home_kw == {"a": -100.0, "b": -60.0, "c": -12.0}
    assert alloc.delivered_mw == 0.0
    assert alloc.missed_mw == 0.0
    assert alloc.reasons == ["charging"]
    assert_real_reasons(alloc)
    check_charge_books(alloc, 0.0)


def test_cheap_call_is_served_by_the_fewest_homes_and_the_rest_charge():
    # Headroom above a 30% floor (6 kWh) x12: a 8.0 = 24, b 10.0 = 48, c 9.0 = 36, d 7.0 = 12 kW.
    # A 0.06 MW call: b (48) then c (36) cover 60 kW, so only they sell; a and d charge.
    homes = [home("a", 8.0), home("b", 10.0), home("c", 9.0), home("d", 7.0)]
    alloc = allocate(homes, frame(0.06), policy(intent="charge"), "AUTO", settings())
    sellers = {h: kw for h, kw in alloc.per_home_kw.items() if kw > 0}
    assert set(sellers) == {"b", "c"}
    assert sellers["b"] == pytest.approx(60 * 48 / 84)
    assert sellers["c"] == pytest.approx(60 * 36 / 84)
    # Room to 20 kWh x12, capped by max_kw 100: a 12 kWh = 100, d 13 kWh = 100.
    assert alloc.per_home_kw["a"] == -100.0
    assert alloc.per_home_kw["d"] == -100.0
    assert alloc.delivered_mw == pytest.approx(0.06)
    assert alloc.missed_mw == pytest.approx(0.0, abs=1e-9)
    assert alloc.reasons == ["charging"]
    assert_real_reasons(alloc)


def test_cheap_call_ties_on_headroom_pick_the_lower_home_id():
    # Equal headroom 48 kW each; a 0.04 MW call needs one home, so "a" sells and "b" charges.
    homes = [home("b", 10.0), home("a", 10.0)]
    alloc = allocate(homes, frame(0.04), policy(intent="charge"), "AUTO", settings())
    assert alloc.per_home_kw["a"] == pytest.approx(40.0)
    assert alloc.per_home_kw["b"] < 0
    assert alloc.delivered_mw == pytest.approx(0.04)


def test_cheap_call_short_on_headroom_sells_everything_and_names_the_shortfall():
    # Caps 48 + 48 = 96 kW for a 200 kW call: both sell at cap, nobody charges.
    homes = [home("a", 10.0), home("b", 10.0), home("c", 10.0, status="dead")]
    alloc = allocate(homes, frame(0.2), policy(intent="charge"), "AUTO", settings())
    assert alloc.per_home_kw == {"a": 48.0, "b": 48.0}
    assert alloc.delivered_mw == pytest.approx(0.096)
    assert alloc.missed_mw == pytest.approx(0.104)
    assert alloc.reasons == ["fleet_headroom_short", "homes_dead:1"]
    check_books(alloc, 0.2)


def test_cheap_call_short_puts_the_shortfall_code_before_charging():
    # "a" is at its floor (no headroom) but has room, so it charges; "b" sells at cap 48 kW.
    homes = [home("a", 6.0), home("b", 10.0)]
    alloc = allocate(homes, frame(0.1), policy(intent="charge"), "AUTO", settings())
    assert alloc.per_home_kw["b"] == 48.0
    assert alloc.per_home_kw["a"] < 0
    assert alloc.missed_mw == pytest.approx(0.052)
    assert alloc.reasons == ["fleet_headroom_short", "charging"]


def test_cheap_call_never_sells_and_charges_the_same_home():
    homes = new_fleet(settings())
    alloc = allocate(homes, frame(0.2), policy(intent="charge"), "AUTO", settings())
    sellers = [h for h, kw in alloc.per_home_kw.items() if kw > 0]
    chargers = [h for h, kw in alloc.per_home_kw.items() if kw < 0]
    assert sellers and chargers
    assert not set(sellers) & set(chargers)
    assert len(sellers) + len(chargers) == len(homes)
    assert alloc.delivered_mw == pytest.approx(0.2)
    assert alloc.missed_mw == pytest.approx(0.0, abs=1e-9)


def test_cheap_power_with_no_call_charges_every_home_with_room():
    homes = [home("a", 10.0), home("b", 20.0), home("c", 10.0, status="dead")]
    alloc = allocate(homes, frame(0.0), policy(intent="charge"), "AUTO", settings())
    assert alloc.per_home_kw == {"a": -100.0}
    assert alloc.delivered_mw == 0.0
    assert alloc.missed_mw == 0.0
    assert alloc.reasons == ["charging", "homes_dead:1"]


def test_no_call_on_a_non_charge_tick_stays_empty():
    homes = [home("a", 10.0)]
    for intent in ("hold", "discharge"):
        alloc = allocate(homes, frame(0.0), policy(intent=intent), "AUTO", settings())
        assert alloc.per_home_kw == {} and alloc.reasons == []


def test_operator_hold_wins_over_cheap_idle_charging():
    homes = [home("a", 10.0)]
    alloc = allocate(homes, frame(0.0), policy(intent="charge"), "HOLD", settings())
    assert alloc.per_home_kw == {}
    assert alloc.reasons == ["operator_hold"]


def test_charge_cap_is_room_to_capacity_capped_by_max_kw():
    # Room 13 kWh x12 = 156 kW, so the 5 kW inverter wins; room 0.1 kWh x12 = 1.2 kW wins.
    homes = [home("a", 7.0, max_kw=5.0), home("b", 19.9, max_kw=5.0)]
    alloc = allocate(homes, frame(0.0), policy(intent="charge"), "AUTO", settings())
    assert alloc.per_home_kw == {"a": -5.0, "b": -1.2}
    check_charge_books(alloc, 0.0)


def test_charge_never_fills_past_capacity_and_skips_full_homes():
    homes = [home("a", 20.0), home("b", 19.0, max_kw=5.0)]
    alloc = allocate(homes, frame(0.0), policy(intent="charge"), "AUTO", settings())
    assert "a" not in alloc.per_home_kw
    assert alloc.per_home_kw == {"b": -5.0}
    # No order can fill past the cap: energy added is |kw| x tick/60 <= room.
    s = settings()
    for h in homes:
        if h.home_id in alloc.per_home_kw:
            added = abs(alloc.per_home_kw[h.home_id]) * s["tick_minutes"] / 60
            assert h.soc_kwh + added <= h.capacity_kwh + 1e-9
    check_charge_books(alloc, 0.0)


def test_charge_leaves_dead_and_stale_at_zero():
    homes = [home("a", 10.0), home("b", 10.0, status="dead"),
             home("c", 10.0, status="stale"), home("d", 10.0, zone="Panhandle")]
    alloc = allocate(homes, frame(0.0), policy(intent="charge"), "AUTO", settings())
    assert set(alloc.per_home_kw) == {"a"}
    assert alloc.per_home_kw["a"] < 0
    assert alloc.reasons == ["charging", "homes_dead:1", "homes_stale:1", "unknown_zone"]
    assert_real_reasons(alloc)
    check_charge_books(alloc, 0.0)


def test_charge_allocate_never_changes_the_homes():
    homes = [home("a", 10.0), home("b", 15.0)]
    before = copy.deepcopy(homes)
    allocate(homes, frame(0.2), policy(intent="charge"), "AUTO", settings())
    allocate(homes, frame(0.2), policy(intent="hold"), "AUTO", settings())
    assert homes == before


# --- zone intent: each home follows its own zone --------------------------------

def test_zone_intent_splits_discharge_charge_and_hold_by_zone():
    p = policy(intent="hold")
    p.zone_intent = {"Houston": "discharge", "North": "charge", "South": "hold"}
    homes = [home("h", 10.0, zone="Houston"), home("n", 10.0, zone="North"),
             home("s", 10.0, zone="South"), home("w", 10.0, zone="West")]
    alloc = allocate(homes, frame(1.0), p, "AUTO", settings())
    # A 1 MW call is bigger than the whole fleet's headroom, so every zone sells its cap:
    # the call is served from any zone with headroom, cheap zones last.
    assert alloc.per_home_kw == {"h": 48.0, "n": 48.0, "s": 48.0, "w": 48.0}
    assert alloc.delivered_mw == pytest.approx(0.192)
    assert alloc.missed_mw == pytest.approx(1.0 - alloc.delivered_mw)
    # A selling home never charges, and a miss with every home selling is plain short headroom.
    assert alloc.reasons == ["fleet_headroom_short"]
    assert_real_reasons(alloc)


def test_zone_intent_with_no_call_charges_only_the_charge_zones():
    p = policy(intent="charge")
    p.zone_intent = {"Houston": "charge", "North": "discharge"}
    homes = [home("a", 10.0), home("b", 10.0, zone="North"), home("c", 10.0, zone="South")]
    alloc = allocate(homes, frame(0.0), p, "AUTO", settings())
    assert alloc.per_home_kw == {"a": -100.0}
    assert alloc.delivered_mw == 0.0
    assert alloc.missed_mw == 0.0
    assert alloc.reasons == ["charging"]


def test_zone_intent_with_no_call_and_no_charge_zone_stays_empty():
    p = policy(intent="charge")
    p.zone_intent = {"Houston": "hold", "North": "discharge"}
    homes = [home("a", 10.0), home("b", 10.0, zone="North")]
    alloc = allocate(homes, frame(0.0), p, "AUTO", settings())
    assert alloc.per_home_kw == {} and alloc.reasons == []
    assert alloc.delivered_mw == 0.0 and alloc.missed_mw == 0.0


def test_zone_intent_with_no_call_never_charges_a_grid_down_zone():
    p = policy(intent="charge")
    p.zone_intent = {"Houston": "charge", "North": "charge"}
    homes = [home("a", 10.0), home("b", 10.0, zone="North")]
    down = TapeFrame(1, "2026-09-25T12:00:00-05:00", 0.0, "synthetic", 40.0, "synthetic",
                     events={"grid_down": ["Houston"]})
    alloc = allocate(homes, down, p, "AUTO", settings())
    assert alloc.per_home_kw == {"b": -100.0}
    assert alloc.reasons == ["charging", "grid_down:Houston"]


def test_zone_intent_missing_zone_holds_while_others_charge():
    p = policy(intent="discharge")
    p.zone_intent = {"Houston": "charge"}
    homes = [home("h", 10.0, zone="Houston"), home("n", 10.0, zone="North")]
    # North has no row, so it is a hold zone: it serves a call it can cover; Houston charges.
    alloc = allocate(homes, frame(0.04), p, "AUTO", settings())
    assert alloc.per_home_kw == {"n": 40.0, "h": -100.0}
    assert alloc.delivered_mw == pytest.approx(0.04) and alloc.missed_mw == pytest.approx(0.0)
    assert alloc.reasons == ["charging"]
    assert_real_reasons(alloc)


def test_zone_intent_discharge_and_hold_zones_share_the_call_proportionally():
    p = policy(intent="hold")
    p.zone_intent = {"Houston": "charge", "North": "hold", "South": "hold", "West": "discharge"}
    # Headroom caps: h 100 (inverter), n 48, s 72, w 48. Room caps: h 24, n 100, s 96, w 100.
    homes = [home("h", 18.0, zone="Houston"), home("n", 10.0, zone="North"),
             home("s", 12.0, zone="South"), home("w", 10.0, zone="West")]
    alloc = allocate(homes, frame(0.1), p, "AUTO", settings())
    # Discharge and hold zones (168 kW of caps) cover the call, so every one of their homes
    # shares it in proportion to its cap. Houston has the most headroom but is cheap, so it
    # charges instead of selling.
    assert set(alloc.per_home_kw) == {"w", "n", "s", "h"}
    assert alloc.per_home_kw["w"] == pytest.approx(100 * 48 / 168)
    assert alloc.per_home_kw["n"] == pytest.approx(100 * 48 / 168)
    assert alloc.per_home_kw["s"] == pytest.approx(100 * 72 / 168)
    assert alloc.per_home_kw["h"] == -24.0
    assert alloc.delivered_mw == pytest.approx(0.1) and alloc.missed_mw == pytest.approx(0.0)
    assert alloc.reasons == ["charging"]
    check_zoned_books(alloc, 0.1)


def test_zone_intent_uses_a_charge_zone_home_when_nothing_else_has_headroom():
    p = policy(intent="hold")
    p.zone_intent = {"Houston": "charge", "West": "discharge"}
    # West is at its floor. The call is still served, from the fewest Houston homes.
    homes = [home("a", 10.0), home("b", 10.0), home("w", 6.0, zone="West")]
    alloc = allocate(homes, frame(0.04), p, "AUTO", settings())
    assert alloc.per_home_kw == {"a": 40.0, "b": -100.0}
    assert alloc.delivered_mw == pytest.approx(0.04)
    assert alloc.reasons == ["charging"]
    check_zoned_books(alloc, 0.04)


def test_zone_intent_charge_zone_covers_only_the_remainder_from_the_fewest_homes():
    p = policy(intent="hold")
    p.zone_intent = {"Houston": "charge", "West": "discharge"}
    # West gives its full 48 kW cap; the 22 kW left comes from one Houston home (most
    # headroom, ties by id), and the other Houston home still charges.
    homes = [home("a", 10.0), home("b", 10.0), home("w", 10.0, zone="West")]
    alloc = allocate(homes, frame(0.07), p, "AUTO", settings())
    assert alloc.per_home_kw == {"w": 48.0, "a": pytest.approx(22.0), "b": -100.0}
    assert alloc.delivered_mw == pytest.approx(0.07)
    assert alloc.reasons == ["charging"]
    check_zoned_books(alloc, 0.07)


def test_zone_intent_spreads_a_small_call_over_every_discharge_and_hold_home():
    p = policy(intent="hold")
    p.zone_intent = {"Houston": "discharge", "North": "hold"}
    homes = [home("h1", 10.0), home("h2", 12.0), home("n", 16.0, zone="North")]
    alloc = allocate(homes, frame(0.06), p, "AUTO", settings())
    # Caps 48, 72, 100 (220 kW): each home gives its share of 60 kW; nobody charges.
    assert alloc.per_home_kw == {"h1": pytest.approx(60 * 48 / 220), "h2": pytest.approx(60 * 72 / 220),
                                 "n": pytest.approx(60 * 100 / 220)}
    assert alloc.reasons == []
    check_zoned_books(alloc, 0.06)


def test_zone_intent_never_sells_without_a_call():
    p = policy(intent="discharge")
    p.zone_intent = {"Houston": "discharge", "North": "hold", "South": "charge"}
    homes = [home("h", 16.0), home("n", 16.0, zone="North"), home("s", 10.0, zone="South")]
    alloc = allocate(homes, frame(0.0), p, "AUTO", settings())
    assert alloc.per_home_kw == {"s": -100.0}
    assert alloc.delivered_mw == 0.0 and alloc.missed_mw == 0.0


def test_zoned_allocate_never_changes_the_homes():
    p = policy(intent="hold")
    p.zone_intent = {"Houston": "charge", "North": "discharge"}
    homes = [home("a", 10.0), home("b", 15.0, zone="North")]
    before = copy.deepcopy(homes)
    allocate(homes, frame(0.2), p, "AUTO", settings())
    assert homes == before


def check_zoned_books(alloc, target_mw):
    """Sold kW is delivery and never over the call; charged kW is never delivery."""
    sold = sum(kw for kw in alloc.per_home_kw.values() if kw > 0)
    assert sold / 1000 == pytest.approx(alloc.delivered_mw)
    assert 0 <= alloc.delivered_mw <= target_mw + 1e-12
    assert alloc.missed_mw == pytest.approx(target_mw - alloc.delivered_mw, abs=1e-9)


def test_zone_intent_leaves_dead_and_stale_at_zero():
    p = policy(intent="discharge")
    p.zone_intent = {"Houston": "discharge", "North": "charge"}
    homes = [home("h", 10.0, zone="Houston", status="dead"),
             home("n", 10.0, zone="North", status="stale"),
             home("m", 10.0, zone="Houston")]
    alloc = allocate(homes, frame(0.2), p, "AUTO", settings())
    assert set(alloc.per_home_kw) == {"m"}
    assert alloc.per_home_kw["m"] > 0
    assert_real_reasons(alloc)


# --- acted_intent: the tick's label says what the fleet was ordered to do --------------

def labelled(intent, reason=""):
    p = policy(intent=intent)
    p.intent_reason = reason
    return p


def test_acted_intent_operator_hold_is_hold():
    alloc = Allocation({}, 0.0, 0.2, ["operator_hold"])
    assert acted_intent(alloc, labelled("hold", "operator_hold"), "HOLD") == ("hold", "operator_hold")


def test_acted_intent_selling_on_a_hold_price_is_a_grid_call_discharge():
    # HIGH risk at $80 (or LOW at a mid-band $40): the policy says hold, the fleet serves the call.
    alloc = Allocation({"a": 5.0, "b": 3.0}, 0.008, 0.0, [])
    assert acted_intent(alloc, labelled("hold"), "AUTO") == ("discharge", "grid_call")


def test_acted_intent_selling_with_no_price_is_a_grid_call_discharge():
    alloc = Allocation({"a": 5.0}, 0.005, 0.0, [])
    assert acted_intent(alloc, labelled("hold", "price_unavailable"), "AUTO") == ("discharge", "grid_call")


def test_acted_intent_discharge_price_that_sells_keeps_the_policy_reason():
    alloc = Allocation({"a": 5.0}, 0.005, 0.0, [])
    assert acted_intent(alloc, labelled("discharge"), "AUTO") == ("discharge", "")


def test_acted_intent_charge_keeps_the_policy_reason():
    alloc = Allocation({"a": -5.0, "b": -2.0}, 0.0, 0.2, ["charging"])
    assert acted_intent(alloc, labelled("charge"), "AUTO") == ("charge", "")


def test_acted_intent_sell_heavy_mixed_tick_is_discharge():
    # Net flow out: the `charging` reason on the allocation shows the smaller charge.
    alloc = Allocation({"a": 5.0, "b": -2.0}, 0.005, 0.0, ["charging"])
    assert acted_intent(alloc, labelled("charge"), "AUTO") == ("discharge", "grid_call")


def test_acted_intent_charge_heavy_mixed_tick_is_charge_with_the_call_served():
    # Cheap power: 1 home sells 2 kW for the call while 3 homes charge 15 kW.
    alloc = Allocation({"a": 2.0, "b": -5.0, "c": -5.0, "d": -5.0}, 0.002, 0.0, ["charging"])
    assert acted_intent(alloc, labelled("charge"), "AUTO") == ("charge", "grid_call_served")


def test_acted_intent_exact_tie_is_discharge():
    alloc = Allocation({"a": 4.0, "b": -4.0}, 0.004, 0.0, ["charging"])
    assert acted_intent(alloc, labelled("charge"), "AUTO") == ("discharge", "grid_call")


def test_acted_intent_float_noise_tie_is_discharge():
    # 0.1 + 0.2 charged is 0.30000000000000004 kW: noise over the 0.3 kW sold, still a tie.
    alloc = Allocation({"a": 0.3, "b": -0.1, "c": -0.2}, 0.0003, 0.0, ["charging"])
    assert acted_intent(alloc, labelled("charge"), "AUTO") == ("discharge", "grid_call")


def test_acted_intent_noise_sized_kw_is_not_movement():
    alloc = Allocation({"a": 1e-9, "b": -1e-9}, 0.0, 0.0, [])
    assert acted_intent(alloc, labelled("discharge"), "AUTO") == ("hold", "no_grid_call")


def test_acted_intent_discharge_price_with_no_call_is_hold():
    alloc = Allocation({}, 0.0, 0.0, [])
    assert acted_intent(alloc, labelled("discharge"), "AUTO") == ("hold", "no_grid_call")


def test_acted_intent_charge_price_with_no_call_is_hold():
    # With idle charging this only happens when every home is already full.
    alloc = Allocation({}, 0.0, 0.0, [])
    assert acted_intent(alloc, labelled("charge"), "AUTO") == ("hold", "no_grid_call")


def test_acted_intent_call_nobody_could_serve_keeps_the_policy_reason():
    # A call came but every home sat at its floor: nothing moved, and not for lack of a call.
    alloc = Allocation({}, 0.0, 0.2, ["storm_reserve"])
    assert acted_intent(alloc, labelled("discharge"), "AUTO") == ("hold", "")


def test_acted_intent_hold_with_nothing_moved_keeps_price_unavailable():
    alloc = Allocation({}, 0.0, 0.0, [])
    assert acted_intent(alloc, labelled("hold", "price_unavailable"), "AUTO") == ("hold", "price_unavailable")


def test_acted_intent_reads_what_allocate_planned():
    p = policy(intent="hold")
    alloc = allocate([home("a", 15.0), home("b", 15.0)], frame(0.004), p, "AUTO", settings())
    assert sum(alloc.per_home_kw.values()) > 0
    assert acted_intent(alloc, p, "AUTO") == ("discharge", "grid_call")
