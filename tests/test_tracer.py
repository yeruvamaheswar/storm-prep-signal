"""Tracer test: the real fleet and allocator plugged into the engine's tick loop (Story 3.3).

engine.py still carries TEMP stand-ins for new_fleet, apply_events, allocate and discharge.
We swap in the real ones with monkeypatch (engine.py is not edited) and play tape_tiny.json:
tick 1 calm (30% floor), tick 2 storm (60% floor), tick 3 missing signal (60% floor).
"""
import json
from pathlib import Path

import pytest

from server.engine import controller, fleet
from server.engine import loop as engine
from server.engine.cli import read_settings

ROOT = Path(__file__).parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"
STORM_REASONS = ("storm_risk_high", "signal_unavailable")


@pytest.fixture
def traced_run(tmp_path, monkeypatch):
    """Run the engine with our functions and remember the fleet and each tick's floor check."""
    # The tape's risk_fixture paths are relative to the repo root (same as test_engine.py).
    monkeypatch.chdir(ROOT)
    seen = {"homes": None, "floor_ok": []}

    def new_fleet(settings):
        # Keep a handle on the fleet: the run record does not include homes.
        seen["homes"] = fleet.new_fleet(settings)
        return seen["homes"]

    def discharge(homes, alloc, policy, settings):
        before = {h.home_id: h.soc_kwh for h in homes}
        breaches = fleet.discharge(homes, alloc, policy, settings)
        # Homes start at 45-75% charge, so at a 60% floor some are already under it before
        # any discharge. The rule is: never push a home below its floor. So a home that lost
        # charge this tick must end at or above the floor of the policy in force this tick.
        seen["floor_ok"].append(all(
            h.soc_kwh >= fleet.floor_kwh(h, policy) - 1e-9
            for h in homes if h.soc_kwh < before[h.home_id]
        ))
        return breaches

    monkeypatch.setattr(engine, "new_fleet", new_fleet)
    monkeypatch.setattr(engine, "apply_events", fleet.apply_events)
    monkeypatch.setattr(engine, "allocate", controller.allocate)
    monkeypatch.setattr(engine, "discharge", discharge)
    runs_dir = tmp_path / "runs"
    record = engine.run(TAPE, read_settings(), log_dir=tmp_path / "logs", runs_dir=runs_dir)
    return record, runs_dir, seen


def test_no_tick_breaches_the_floor(traced_run):
    record, _, _ = traced_run
    assert [t["breaches"] for t in record["ticks"]] == [0, 0, 0]


def test_calm_tick_delivers_power(traced_run):
    record, _, _ = traced_run
    first = record["ticks"][0]
    assert first["reserve_pct"] == 30
    assert first["delivered_mw"] > 0


def test_storm_ticks_deliver_a_smaller_share_or_say_why(traced_run):
    record, _, _ = traced_run
    first, *storm = record["ticks"]
    calm_share = first["delivered_mw"] / first["target_mw"]
    for tick in storm:
        assert tick["reserve_pct"] == 60
        assert tick["policy_reason"] in STORM_REASONS
        share = tick["delivered_mw"] / tick["target_mw"]
        has_reason = any(r in ("storm_reserve", "fleet_headroom_short") for r in tick["reasons"])
        assert share < calm_share or has_reason, tick


def test_delivered_plus_missed_equals_target(traced_run):
    record, _, _ = traced_run
    for tick in record["ticks"]:
        assert abs(tick["delivered_mw"] + tick["missed_mw"] - tick["target_mw"]) <= 1e-9, tick


def test_run_file_matches_the_returned_record(traced_run):
    record, runs_dir, _ = traced_run
    run_file = runs_dir / f"{record['run_id']}.json"
    assert run_file.exists()
    saved = json.loads(run_file.read_text())
    assert saved["ticks"] == record["ticks"]
    assert len(saved["ticks"]) == 3


def test_no_home_is_discharged_below_its_floor(traced_run):
    _, _, seen = traced_run
    assert seen["homes"], "the engine never built the fleet through new_fleet"
    assert seen["floor_ok"] == [True, True, True]
