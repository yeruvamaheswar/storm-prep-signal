"""Tracer test: the engine's tick loop runs every tick through orchestrate_tick (Story 3.3).

We wrap orchestrate_tick to check the floor after each tick and play tape_tiny.json:
tick 1 calm (30% floor), tick 2 storm (60% floor), tick 3 missing signal (60% floor).
"""
import json
from pathlib import Path

import pytest

from server.engine import fleet, orchestration
from server.engine import loop as engine
from server.engine.cli import read_settings

ROOT = Path(__file__).parent.parent
TAPE = ROOT / "tests" / "fixtures" / "tape_tiny.json"
STORM_REASONS = ("storm_risk_high", "signal_unavailable")


def traced(tmp_path, monkeypatch, tape=TAPE, **over):
    """Run the engine and remember the fleet and each tick's floor check."""
    # The tape's risk_fixture paths are relative to the repo root (same as test_engine.py).
    monkeypatch.chdir(ROOT)
    seen = {"homes": None, "floor_ok": []}

    def new_fleet(settings):
        # Keep a handle on the fleet: the run record does not include homes.
        seen["homes"] = fleet.new_fleet(settings)
        return seen["homes"]

    def orchestrate_tick(homes, frame, policy, mode, settings, seed):
        before = {h.home_id: h.soc_kwh for h in homes}
        result = orchestration.orchestrate_tick(homes, frame, policy, mode, settings, seed)
        # Homes start at 45-75% charge, so at a 60% floor some are already under it before
        # any discharge. The rule is: never push a home below its floor. So a home that lost
        # charge this tick must end at or above the floor of the policy in force this tick.
        seen["floor_ok"].append(all(
            h.soc_kwh >= fleet.floor_kwh(h, policy) - 1e-9
            for h in homes if h.soc_kwh < before[h.home_id]
        ))
        return result

    monkeypatch.setattr(engine, "new_fleet", new_fleet)
    monkeypatch.setattr(engine, "orchestrate_tick", orchestrate_tick)
    runs_dir = tmp_path / "runs"
    settings = {**read_settings(), **over}
    record = engine.run(tape, settings, log_dir=tmp_path / "logs", runs_dir=runs_dir)
    return record, runs_dir, seen


@pytest.fixture
def traced_run(tmp_path, monkeypatch):
    return traced(tmp_path, monkeypatch)


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


def test_every_tick_counts_every_home_once_in_zone_acks(traced_run):
    record, _, seen = traced_run
    for tick in record["ticks"]:
        assert sum(sum(row.values()) for row in tick["zone_acks"].values()) == len(seen["homes"])


def test_lost_orders_are_unconfirmed_and_never_counted_as_delivered(tmp_path, monkeypatch):
    record, _, seen = traced(tmp_path, monkeypatch, channel_drop_rate=0.5)
    calm = record["ticks"][0]
    assert any(r.startswith("timed_out:") for r in calm["reasons"])
    assert sum(row["unconfirmed"] for row in calm["zone_acks"].values()) > 0
    assert calm["delivered_mw"] < calm["target_mw"]
    assert sum(calm["zone_delivered_mw"].values()) == pytest.approx(calm["delivered_mw"])
    assert [t["breaches"] for t in record["ticks"]] == [0, 0, 0]
    assert seen["floor_ok"] == [True, True, True]


ZONE_PRICES = {"Houston": 900.0, "North": 40.0, "South": 55.0, "West": 20.0}


def test_tape_zone_prices_reach_each_tick_and_price_each_zones_dollars(tmp_path, monkeypatch):
    data = json.loads(TAPE.read_text())
    for frame in data["frames"]:
        frame["zone_prices"] = ZONE_PRICES
        frame["zone_price_label"] = "recorded:ERCOT NP6-905-CD"
    tape = tmp_path / "tape_zone_prices.json"
    tape.write_text(json.dumps(data))
    record, _, _ = traced(tmp_path, monkeypatch, tape=tape)
    hours = record["totals"]["tick_minutes"] / 60
    for tick in record["ticks"]:
        assert tick["zone_prices"] == ZONE_PRICES
        assert tick["zone_price_label"] == "recorded:ERCOT NP6-905-CD"
    for zone, entry in record["totals"]["by_zone"].items():
        mwh = sum(t["zone_delivered_mw"].get(zone, 0.0) for t in record["ticks"]) * hours
        assert entry["dollars"] == pytest.approx(mwh * ZONE_PRICES[zone])
        assert entry["dollars_label"] == "recorded:ERCOT NP6-905-CD"


def test_a_tape_without_zone_prices_leaves_them_empty(traced_run):
    record, _, _ = traced_run
    assert all(t["zone_prices"] == {} and t["zone_price_label"] == "none" for t in record["ticks"])
    assert all(e["dollars"] is None for e in record["totals"]["by_zone"].values())
