"""Tests for server/engine/controller.py: allocate() splits the target using only energy above each floor."""
import copy

import pytest

from server.engine.contracts import Home, Policy, TapeFrame
from server.engine.controller import allocate
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


def policy(pct=30.0, reason="normal", **zone_over):
    """Every zone at `pct`, except the zones named in zone_over (for example Houston=60.0)."""
    floors = {z: pct for z in ZONES}
    floors.update(zone_over)
    reasons = {z: reason for z in ZONES}
    level = "HIGH" if reason == "storm_risk_high" else "LOW"
    return Policy(pct, reason, level, zone_reserve_pct=floors, zone_reasons=reasons)


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
