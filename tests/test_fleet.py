"""Tests for server/engine/fleet.py: the simulated homes, their zones, and discharge."""
import pytest

from server.engine.contracts import Allocation, Policy
from server.engine.fleet import (apply_events, assign_zone, discharge, floor_kwh, new_fleet,
                                 safe_kw, set_status)

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


def normal_policy():
    return Policy(30.0, "normal", "LOW", zone_reserve_pct={z: 30.0 for z in ZONES})


# --- new_fleet -------------------------------------------------------------

def test_fleet_has_100_homes_25_per_zone():
    homes = new_fleet(settings())
    assert len(homes) == 100
    assert homes[0].home_id == "home-001" and homes[-1].home_id == "home-100"
    per_zone = {z: sum(h.zone == z for h in homes) for z in ZONES}
    assert per_zone == {z: 25 for z in ZONES}


def test_charge_spreads_evenly_from_45_to_75_percent():
    homes = new_fleet(settings())
    assert homes[0].soc_kwh == pytest.approx(0.45 * 20)
    assert homes[-1].soc_kwh == pytest.approx(0.75 * 20)
    # Strictly increasing by index, so the storm floor cuts the fleet in a visible place.
    assert all(a.soc_kwh < b.soc_kwh for a, b in zip(homes, homes[1:]))


def test_fleet_is_deterministic():
    assert new_fleet(settings()) == new_fleet(settings())


def test_assign_zone_round_robins_in_settings_order():
    zones = list(ZONES)
    assert [assign_zone(i, zones) for i in range(1, 6)] == ["Houston", "North", "South", "West", "Houston"]


# --- apply_events ----------------------------------------------------------

def test_apply_events_sets_status_only():
    homes = new_fleet(settings())
    before = [(h.soc_kwh, h.zone) for h in homes]
    apply_events(homes, {"dead": ["home-001"], "stale": ["home-002"], "operator": "HOLD"})
    assert homes[0].status == "dead" and homes[1].status == "stale" and homes[2].status == "live"
    assert [(h.soc_kwh, h.zone) for h in homes] == before


def test_unknown_status_is_rejected():
    homes = new_fleet(settings(fleet_size=4))
    with pytest.raises(ValueError):
        set_status(homes[0], "zombie")


# --- discharge -------------------------------------------------------------

def test_discharge_lowers_charge_by_kw_times_tick():
    homes = new_fleet(settings(fleet_size=4))
    start = homes[3].soc_kwh
    alloc = Allocation({"home-004": 3.0}, 0.003, 0.0)
    assert discharge(homes, alloc, normal_policy(), settings()) == 0
    assert homes[3].soc_kwh == pytest.approx(start - 3.0 * 5 / 60)


def test_oversized_order_is_clamped_to_the_floor_not_breached():
    homes = new_fleet(settings(fleet_size=4))
    home = homes[0]
    home.soc_kwh = 6.2                   # floor at 30% = 6 kWh: only 0.2 kWh (2.4 kW) to give
    alloc = Allocation({home.home_id: 1000.0}, 1.0, 0.0)   # absurd order
    breaches = discharge(homes, alloc, normal_policy(), settings())
    assert breaches == 0
    assert home.soc_kwh == pytest.approx(6.0)             # stopped exactly at the floor


def test_order_above_the_homes_max_kw_is_clamped_to_max_kw():
    homes = new_fleet(settings(fleet_size=4))
    home = homes[3]                      # 75% of 20 kWh = 15 kWh: 9 kWh above the floor
    alloc = Allocation({home.home_id: 1000.0}, 1.0, 0.0)
    assert discharge(homes, alloc, normal_policy(), settings()) == 0
    # A 5 kW battery gives at most 5 kW for 5 minutes, however big the order.
    assert home.soc_kwh == pytest.approx(15.0 - 5.0 * 5 / 60)


def test_safe_kw_never_exceeds_max_kw():
    homes = new_fleet(settings(fleet_size=4))
    assert safe_kw(homes[3], normal_policy(), settings()) == pytest.approx(5.0)


# --- unknown zones ------------------------------------------------------------

def test_home_in_a_zone_missing_from_the_policy_table_gets_nothing():
    homes = new_fleet(settings(fleet_size=4))
    home = homes[3]
    home.zone = "Mars"                   # not in the policy's zone table
    assert safe_kw(home, normal_policy(), settings()) == 0
    alloc = Allocation({home.home_id: 2.0}, 0.002, 0.0)
    assert discharge(homes, alloc, normal_policy(), settings()) == 0
    assert home.soc_kwh == pytest.approx(15.0)             # untouched


def test_with_no_zone_table_the_fleet_floor_covers_every_home():
    homes = new_fleet(settings(fleet_size=4))
    home = homes[3]
    home.zone = "Mars"
    flat = Policy(30.0, "normal", "LOW")   # zone_reserve_pct is empty
    assert floor_kwh(home, flat) == pytest.approx(6.0)
    assert safe_kw(home, flat, settings()) == pytest.approx(5.0)


# --- discharge edge cases -----------------------------------------------------

def test_discharge_never_touches_a_dead_or_stale_home():
    homes = new_fleet(settings(fleet_size=4))
    dead, stale = homes[2], homes[3]
    apply_events(homes, {"dead": [dead.home_id], "stale": [stale.home_id]})
    before = (dead.soc_kwh, stale.soc_kwh)
    alloc = Allocation({dead.home_id: 2.0, stale.home_id: 2.0}, 0.004, 0.0)
    assert discharge(homes, alloc, normal_policy(), settings()) == 0
    assert (dead.soc_kwh, stale.soc_kwh) == before


def test_discharge_ignores_zero_and_negative_orders():
    homes = new_fleet(settings(fleet_size=4))
    before = [h.soc_kwh for h in homes]
    alloc = Allocation({homes[0].home_id: 0.0, homes[1].home_id: -3.0}, 0.0, 0.0)
    assert discharge(homes, alloc, normal_policy(), settings()) == 0
    assert [h.soc_kwh for h in homes] == before


def test_discharge_leaves_homes_outside_the_allocation_alone():
    homes = new_fleet(settings(fleet_size=4))
    before = [h.soc_kwh for h in homes]
    alloc = Allocation({homes[3].home_id: 1.0}, 0.001, 0.0)
    discharge(homes, alloc, normal_policy(), settings())
    assert [h.soc_kwh for h in homes[:3]] == before[:3]


def test_energy_taken_scales_with_the_tick_length():
    homes = new_fleet(settings(fleet_size=4))
    home = homes[3]
    alloc = Allocation({home.home_id: 2.0}, 0.002, 0.0)
    assert discharge(homes, alloc, normal_policy(), settings(tick_minutes=15)) == 0
    assert home.soc_kwh == pytest.approx(15.0 - 2.0 * 15 / 60)


def test_safe_kw_is_headroom_spread_over_one_tick():
    homes = new_fleet(settings(fleet_size=4))
    home = homes[3]
    home.soc_kwh = 6.5                   # 0.5 kWh above a 6 kWh floor
    # Over 5 minutes that is 6 kW, capped by the 5 kW battery; over 15 minutes it is 2 kW.
    assert safe_kw(home, normal_policy(), settings(tick_minutes=5)) == pytest.approx(5.0)
    assert safe_kw(home, normal_policy(), settings(tick_minutes=15)) == pytest.approx(2.0)


# --- new_fleet and apply_events edge cases ---------------------------------------

def test_a_fleet_of_one_starts_at_the_minimum_charge():
    homes = new_fleet(settings(fleet_size=1))
    assert len(homes) == 1
    assert homes[0].soc_kwh == pytest.approx(0.45 * 20)
    assert homes[0].zone == "Houston"


def test_zones_that_do_not_divide_evenly_differ_by_at_most_one_home():
    three = {"Houston": "48201", "North": "48113", "South": "48355"}
    homes = new_fleet(settings(fleet_size=100, zones=three))
    per_zone = [sum(h.zone == z for h in homes) for z in three]
    assert per_zone == [34, 33, 33]


def test_every_home_starts_live_with_its_settings_capacity():
    homes = new_fleet(settings(fleet_size=4, home_kwh=13.5, home_max_kw=7.0))
    assert all(h.status == "live" for h in homes)
    assert all(h.capacity_kwh == 13.5 and h.max_kw == 7.0 for h in homes)


def test_a_stale_home_can_come_back_live():
    homes = new_fleet(settings(fleet_size=4))
    apply_events(homes, {"stale": ["home-002"]})
    apply_events(homes, {"live": ["home-002"]})
    assert homes[1].status == "live"


def test_empty_events_change_nothing():
    homes = new_fleet(settings(fleet_size=4))
    before = [(h.status, h.soc_kwh) for h in homes]
    apply_events(homes, {})
    assert [(h.status, h.soc_kwh) for h in homes] == before


def test_events_naming_a_home_that_does_not_exist_are_rejected():
    homes = new_fleet(settings(fleet_size=4))
    with pytest.raises(ValueError, match="home-999"):
        apply_events(homes, {"dead": ["home-999"]})


def test_home_below_a_raised_zone_floor_gets_nothing_and_is_not_a_breach():
    homes = new_fleet(settings(fleet_size=4))
    home = homes[0]                      # 9 kWh, under a 60% floor of 12 kWh
    storm = Policy(60.0, "storm_risk_high", "HIGH", zone_reserve_pct={z: 60.0 for z in ZONES})
    alloc = Allocation({home.home_id: 2.0}, 0.002, 0.0)
    assert discharge(homes, alloc, storm, settings()) == 0
    assert home.soc_kwh == pytest.approx(9.0)


def test_discharge_uses_each_homes_zone_floor():
    homes = new_fleet(settings(fleet_size=4))
    houston, north = homes[0], homes[1]  # 45% (9.0 kWh) and 55% (11.0 kWh) of 20 kWh
    north_start = north.soc_kwh
    policy = Policy(30.0, "normal", "LOW", zone_reserve_pct={**{z: 30.0 for z in ZONES}, "Houston": 60.0})
    alloc = Allocation({houston.home_id: 2.0, north.home_id: 2.0}, 0.004, 0.0)
    assert discharge(homes, alloc, policy, settings()) == 0
    assert houston.soc_kwh == pytest.approx(9.0)                        # Houston floor is 12: no headroom
    assert north.soc_kwh == pytest.approx(north_start - 2.0 * 5 / 60)   # North floor is 6: order applied
