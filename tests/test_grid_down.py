"""Grid down (docs/agents/telemetry-vpp.md R9): a zone's batteries back up their own homes.

They neither sell nor charge. allocate gives them 0 kW both ways with reason grid_down:<zone>,
the worker runs 0 if an order reaches one anyway, and reassignment never picks one.
"""
import copy
import json
from pathlib import Path

import pytest

from server.engine import orchestration
from server.engine.contracts import Allocation, Policy, TapeFrame
from server.engine.controller import allocate
from server.engine.fleet import new_fleet
from server.engine.loop import play_frame, with_fleet_defaults
from server.engine.orchestration import orchestrate_tick
from server.engine.scenario import Session
from server.engine.telemetry import TelemetryState

ROOT = Path(__file__).resolve().parent.parent
ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}
FAST = {"channel_delay_s": (1.0, 5.0), "worker_delay_s": (1.0, 5.0)}
DOWN = {"grid_down": ["Houston"]}


def settings(**over):
    base = {
        "fleet_size": 100, "home_kwh": 20.0, "home_max_kw": 5.0,
        "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
        "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0,
        "tick_minutes": 5, "zones": ZONES, **FAST,
    }
    base.update(over)
    return base


def policy(intent="discharge", zone_intent=None):
    p = Policy(30.0, "normal", "LOW", zone_reserve_pct={z: 30.0 for z in ZONES},
               zone_reasons={z: "normal" for z in ZONES}, intent=intent)
    if zone_intent is not None:
        p.zone_intent = zone_intent
    return p


def frame(target_mw, events=None, tick=1):
    return TapeFrame(tick, "2026-09-25T12:00:00-05:00", target_mw, "synthetic", 40.0, "synthetic",
                     events=events or {})


def zone_of(homes):
    return {h.home_id: h.zone for h in homes}


def test_down_zone_gets_nothing_and_the_other_zones_carry_the_target():
    homes = new_fleet(settings())
    alloc = allocate(homes, frame(0.2, DOWN), policy(), "AUTO", settings())
    zones = zone_of(homes)
    assert alloc.per_home_kw and all(zones[i] != "Houston" for i in alloc.per_home_kw)
    assert alloc.delivered_mw == pytest.approx(0.2)
    assert alloc.missed_mw == pytest.approx(0.0)
    assert alloc.reasons == ["grid_down:Houston"]


def test_a_shortfall_still_names_its_cause_before_the_grid_down_code():
    homes = new_fleet(settings())
    alloc = allocate(homes, frame(5.0, DOWN), policy(), "AUTO", settings())
    assert alloc.missed_mw == pytest.approx(5.0 - alloc.delivered_mw)
    assert alloc.missed_mw > 0
    assert alloc.reasons == ["fleet_headroom_short", "grid_down:Houston"]


def test_a_charge_tick_does_not_charge_a_down_zone():
    homes = new_fleet(settings())
    alloc = allocate(homes, frame(0.0, DOWN), policy("charge"), "AUTO", settings())
    zones = zone_of(homes)
    assert alloc.per_home_kw and all(kw < 0 for kw in alloc.per_home_kw.values())
    assert {zones[i] for i in alloc.per_home_kw} == {"North", "South", "West"}
    assert alloc.reasons == ["charging", "grid_down:Houston"]


def test_mixed_zone_intents_skip_the_down_zone_both_ways():
    homes = new_fleet(settings())
    intents = {"Houston": "charge", "North": "discharge", "South": "charge", "West": "hold"}
    alloc = allocate(homes, frame(0.1, DOWN), policy(zone_intent=intents), "AUTO", settings())
    zones = zone_of(homes)
    assert "Houston" not in {zones[i] for i in alloc.per_home_kw}
    assert alloc.reasons[-1] == "grid_down:Houston"


def test_hold_is_unchanged_and_a_zero_target_still_names_the_down_zone():
    homes = new_fleet(settings())
    assert allocate(homes, frame(0.2, DOWN), policy(), "HOLD", settings()).reasons == ["operator_hold"]
    # CONSTRAINTS allocation rule 7: grid_down:<zone> on every tick the zone is down, call or not.
    assert allocate(homes, frame(0.0, DOWN), policy(), "AUTO", settings()).reasons == ["grid_down:Houston"]


def test_a_zone_name_typo_is_refused():
    homes = new_fleet(settings())
    with pytest.raises(ValueError, match="Houstn"):
        allocate(homes, frame(0.2, {"grid_down": ["Houstn"]}), policy(), "AUTO", settings())


def test_allocate_is_pure_with_a_down_zone():
    homes = new_fleet(settings())
    before = copy.deepcopy(homes)
    allocate(homes, frame(0.2, DOWN), policy("charge"), "AUTO", settings())
    assert homes == before


def test_the_worker_runs_zero_for_an_order_that_reaches_a_down_zone(monkeypatch):
    """Defense in depth: even a plan that names a Houston home moves no charge there."""
    s = settings()
    homes = new_fleet(s)
    sell, absorb = [h.home_id for h in homes if h.zone == "Houston"][:2]
    plan = Allocation({sell: 4.0, absorb: -4.0}, 0.004, 0.196, [])
    monkeypatch.setattr(orchestration, "allocate", lambda *args: plan)
    before = {h.home_id: h.soc_kwh for h in homes}
    result = orchestrate_tick(homes, frame(0.2, DOWN), policy(), "AUTO", s, 1)
    guarded = [e for e in result.events if e["kind"] == "grid_down"]
    assert {e["home_id"] for e in guarded} == {sell, absorb}
    assert all(h.soc_kwh == before[h.home_id] for h in homes)
    assert result.credited_mw == 0.0 and result.charging_mw == 0.0
    assert result.breaches == 0


def test_reassignment_never_picks_a_home_in_a_down_zone(monkeypatch):
    s = settings()
    homes = new_fleet(s)
    crashing = next(h.home_id for h in homes if h.zone == "Houston")
    s["_fail_home_ids"] = {crashing}
    plan = Allocation({crashing: 4.0}, 0.004, 0.196, [])
    monkeypatch.setattr(orchestration, "allocate", lambda *args: plan)
    result = orchestrate_tick(homes, frame(0.2, DOWN), policy(), "AUTO", s, 1)
    assert [e["kind"] for e in result.events if e["kind"].startswith("reassign")] == ["reassign_failed"]
    assert result.reassigned == 0


def test_down_zone_homes_hold_their_charge_through_a_cycle():
    s = settings()
    homes = new_fleet(s)
    before = {h.home_id: h.soc_kwh for h in homes}
    result = orchestrate_tick(homes, frame(0.2, DOWN), policy(), "AUTO", s, 3)
    houston = [h for h in homes if h.zone == "Houston"]
    assert all(h.soc_kwh == before[h.home_id] for h in houston)
    assert result.zone_delivered_mw.get("Houston", 0.0) == 0.0
    assert result.credited_mw == pytest.approx(0.2)
    assert result.allocation.reasons[-1] == "grid_down:Houston"


def test_telemetry_reports_grid_down_for_those_homes():
    s = settings()
    homes = new_fleet(s)
    feed = TelemetryState(homes, s, 1)
    result = orchestrate_tick(homes, frame(0.2, DOWN), policy(), "AUTO", s, 1, telemetry=feed)
    grids = {h.zone: set() for h in homes}
    for h in homes:
        grids[h.zone].add(feed.homes[h.home_id].last["grid"])
    assert grids["Houston"] == {"down"}
    assert grids["North"] == {"connected"}
    assert result.zones["Houston"]["grid_down"] is True
    assert result.zones["Houston"]["available_mw"] == 0.0
    assert result.zones["North"]["grid_down"] is False
    assert result.plant["grid_down"] is True


def test_tick_result_names_the_down_zones():
    s = with_fleet_defaults(settings())
    homes = new_fleet(s)
    result, *_ = play_frame(frame(0.2, DOWN), homes, s, None, "AUTO")
    assert result.grid_down_zones == ["Houston"]
    assert result.zone_delivered_mw.get("Houston", 0.0) == 0.0
    plain, *_ = play_frame(frame(0.2), new_fleet(s), s, None, "AUTO")
    assert plain.grid_down_zones == []


SESSION_SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 25.0, "home_max_kw": 11.4,
    "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "telemetry_feed": False,
}


def overlay_session(tmp_path):
    catalog = json.loads((ROOT / "tapes" / "scenarios" / "catalog.json").read_text())["scenarios"]
    heather = next(entry for entry in catalog if entry["id"] == "heather")
    entry = {**heather, "id": "heather-overlay", "grid_down_overlay": True}
    return Session(dict(SESSION_SETTINGS), [entry], log_dir=tmp_path / "logs")


def test_session_islands_down_zone_batteries_and_their_charge_does_not_move(tmp_path):
    s = overlay_session(tmp_path)
    s.start("heather-overlay", 42)
    for _ in range(3):
        s.step()
    s.set_grid_down("Houston", True)
    for _ in range(5):
        before = {h.home_id: h.soc_kwh for h in s.homes if h.zone == "Houston"}
        s.step()
        assert all(h.soc_kwh == before[h.home_id] for h in s.homes if h.zone == "Houston")
    tick = s.last["result"]
    assert tick["grid_down_zones"] == ["Houston"]
    assert tick["mode"] == "AUTO" and tick["target_mw"] > 0
    assert "grid_down:Houston" in tick["reasons"]
    houston = [h for h in s.last["homes"] if h["zone"] == "Houston" and h["status"] == "live"]
    assert houston and {h["state"] for h in houston} == {"islanded"}
    row = s.last["zones"]["Houston"]
    assert row["grid_down"] is True and row["selling_mw"] == 0.0 and row["charging_mw"] == 0.0

    s.set_grid_down("Houston", False)
    s.step()
    assert s.last["result"]["grid_down_zones"] == []
    assert s.last["zones"]["Houston"]["grid_down"] is False


def test_the_weather_step_requests_name_the_alert_zones_and_island_them(tmp_path):
    """The page's 'alert + grid down' step: the alert request, then grid_down for the alert's zones."""
    alert_dir = tmp_path / "nws"
    alert_dir.mkdir()
    (alert_dir / "harris-warning.json").write_text(json.dumps({
        "event": "Hurricane Warning", "areaDesc": "Harris", "counties": ["048201"],
        "expires": "2099-01-01T00:00:00-06:00"}))
    catalog = json.loads((ROOT / "tapes" / "scenarios" / "catalog.json").read_text())["scenarios"]
    heather = next(entry for entry in catalog if entry["id"] == "heather")
    entry = {**heather, "alerts": ["harris-warning"], "grid_down_overlay": True}
    s = Session(dict(SESSION_SETTINGS), [entry], log_dir=tmp_path / "logs", alert_dir=alert_dir)
    s.start("heather", 7)
    assert s.state()["scenario"]["alerts"][0]["zones"] == ["Houston"]
    s.apply({"kind": "alert", "body": {"alert_id": "harris-warning"}})
    s.apply({"kind": "grid_down", "body": {"zone": "Houston", "down": True}})
    before = {h.home_id: h.soc_kwh for h in s.homes if h.zone == "Houston"}
    s.step()
    assert all(h.soc_kwh == before[h.home_id] for h in s.homes if h.zone == "Houston")
    state = s.state()
    assert state["grid_down_zones"] == ["Houston"] and state["zones"]["Houston"]["grid_down"] is True
    assert state["tick"]["zone_reasons"]["Houston"] == "weather_alert"
    assert state["tick"]["zone_reasons"]["North"] == "normal"


def test_session_refuses_grid_down_without_the_overlay(tmp_path):
    catalog = json.loads((ROOT / "tapes" / "scenarios" / "catalog.json").read_text())["scenarios"]
    heather = next(entry for entry in catalog if entry["id"] == "heather")
    s = Session(dict(SESSION_SETTINGS), [{**heather, "grid_down_overlay": False}], log_dir=tmp_path / "logs")
    s.start("heather", 1)
    s.apply({"kind": "grid_down", "body": {"zone": "Houston", "down": True}})
    assert s.grid_down_zones == []
    assert s.messages[-1]["text"] == "refused grid_down: this scenario has no grid-down overlay"
