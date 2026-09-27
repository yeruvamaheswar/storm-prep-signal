import json

import pytest

from server.engine.contracts import Policy, TapeFrame
from server.engine.fleet import apply_events, new_fleet
from server.engine.order_log import NORMAL_KINDS, order_timelines
from server.engine.orchestration import orchestrate_tick

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}


def settings(**over):
    base = {
        "fleet_size": 100, "home_kwh": 20.0, "home_max_kw": 5.0,
        "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
        "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0,
        "tick_minutes": 5, "zones": ZONES,
    }
    base.update(over)
    return base


def policy():
    return Policy(30.0, "normal", "LOW", {zone: 30.0 for zone in ZONES}, {zone: "normal" for zone in ZONES})


def frame(events=None):
    return TapeFrame(1, "2026-09-25T12:00:00-05:00", 0.2, "synthetic", 40.0, "synthetic",
                     events=events or {})


def test_order_timelines_normalize_kinds_and_filter_noise():
    events = [
        {"t": 0.04, "kind": "sent", "command_id": "home-001:1"},
        {"t": 0.05, "kind": "sent", "command_id": "telemetry:home-001:1:1"},
        {"t": 3.22, "kind": "executed", "command_id": "home-001:1", "home_id": "home-001", "actual_kw": 4.0},
        {"t": 3.23, "kind": "sent", "command_id": "home-001:1"},
        {"t": 3.24, "kind": "dropped", "command_id": "home-001:1"},
        {"t": 60.0, "kind": "retry", "command_id": "home-001:1", "home_id": "home-001"},
        {"t": 60.0, "kind": "reassigned", "command_id": "home-002:1:r", "home_id": "home-002",
         "parent_command_id": "home-001:1", "kw": 2.5},
        {"t": 60.0, "kind": "sent", "command_id": "home-002:1:r"},
        {"t": 65.0, "kind": "charge_mismatch", "command_id": "home-002:1:r", "home_id": "home-002",
         "reported_kwh": 0.5},
        {"t": 66.0, "kind": "charge_confirmed", "command_id": "home-002:1:r", "home_id": "home-002",
         "actual_kw": -2.0},
    ]

    timelines = order_timelines(events, {"home-001": 4.0})

    assert timelines["home-001"] == [
        [0.0, "sent", 4.0],
        [3.2, "exec", 4.0],
        [3.2, "rdrop", None],
        [60.0, "retry", None],
        [60.0, "reassigned", "home-002"],
    ]
    assert timelines["home-002"] == [
        [60.0, "sent", 2.5],
        [65.0, "mismatch", 0.5],
        [66.0, "conf", -2.0],
    ]
    assert all(row[1] in NORMAL_KINDS for rows in timelines.values() for row in rows)


def test_fault_tick_order_timelines_stay_compact_and_consistent():
    s = settings(channel_drop_rate=0.4)
    homes = new_fleet(s)
    f = frame({"network": {"drop_rate": 0.4}})
    apply_events(homes, f.events)
    result = orchestrate_tick(homes, f, policy(), "AUTO", s, seed=1)

    timelines = order_timelines(result.events, result.allocation.per_home_kw)
    by_command_home = {command_id.split(":", 1)[0] for command_id in result.command_states}

    assert set(timelines) == by_command_home
    assert len(json.dumps({"orders": timelines}, separators=(",", ":"))) < 60_000

    lost_then_retried = 0
    for rows in timelines.values():
        kinds = [row[1] for row in rows]
        times = [row[0] for row in rows]
        if "conf" in kinds:
            assert "exec" in kinds
            assert kinds.index("exec") < kinds.index("conf")
        for idx, kind in enumerate(kinds):
            if kind == "rdrop":
                assert "exec" in kinds[:idx]
        if "drop" in kinds and "retry" in kinds:
            assert kinds.index("drop") < kinds.index("retry")
            assert times[kinds.index("retry")] == pytest.approx(60.0)
            lost_then_retried += 1

    assert lost_then_retried > 0
