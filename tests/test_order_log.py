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


def grouped_by_key(rows):
    grouped = {}
    for row in rows:
        grouped.setdefault(row[3], []).append(row)
    return grouped


def assert_lifecycle_is_well_formed(rows):
    assert rows[0][1] == "sent"
    kinds = [row[1] for row in rows]
    for idx, kind in enumerate(kinds):
        if kind == "conf":
            assert "exec" in kinds[:idx]
        if kind == "rdrop":
            assert "exec" in kinds[:idx] or "dup" in kinds[:idx]
        if kind == "rdrop" and "retry" in kinds[:idx]:
            last_retry = max(i for i, prior in enumerate(kinds[:idx]) if prior == "retry")
            assert rows[last_retry][0] != rows[idx][0] or any(k in ("exec", "dup") for k in kinds[last_retry + 1:idx])


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
        [0.0, "sent", 4.0, "own"],
        [3.2, "exec", 4.0, "own"],
        [3.2, "rdrop", None, "own"],
        [60.0, "retry", None, "own"],
        [60.0, "reassigned", "home-002", "own"],
    ]
    assert timelines["home-002"] == [
        [60.0, "sent", 2.5, "r"],
        [65.0, "mismatch", 0.5, "r"],
        [66.0, "conf", -2.0, "r"],
    ]
    assert all(row[1] in NORMAL_KINDS for rows in timelines.values() for row in rows)
    assert all(row[3] in {"own", "r"} for rows in timelines.values() for row in rows)


def test_lost_retry_order_is_drop_not_report_drop():
    events = [
        {"t": 0.0, "kind": "sent", "command_id": "home-005:1"},
        {"t": 10.0, "kind": "executed", "command_id": "home-005:1", "home_id": "home-005", "actual_kw": 2.0},
        {"t": 10.0, "kind": "sent", "command_id": "home-005:1"},
        {"t": 10.0, "kind": "dropped", "command_id": "home-005:1"},
        {"t": 60.0, "kind": "retry", "command_id": "home-005:1", "home_id": "home-005"},
        {"t": 60.0, "kind": "sent", "command_id": "home-005:1"},
        {"t": 60.0, "kind": "dropped", "command_id": "home-005:1"},
    ]

    assert order_timelines(events, {"home-005": 2.0})["home-005"] == [
        [0.0, "sent", 2.0, "own"],
        [10.0, "exec", 2.0, "own"],
        [10.0, "rdrop", None, "own"],
        [60.0, "retry", None, "own"],
        [60.0, "drop", None, "own"],
    ]


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
        for keyed_rows in grouped_by_key(rows).values():
            assert_lifecycle_is_well_formed(keyed_rows)
            keyed_kinds = [row[1] for row in keyed_rows]
            keyed_times = [row[0] for row in keyed_rows]
            if "drop" in keyed_kinds and "retry" in keyed_kinds:
                drop_idx = keyed_kinds.index("drop")
                retry_idx = keyed_kinds.index("retry")
                if drop_idx < retry_idx:
                    assert keyed_times[retry_idx] == pytest.approx(60.0)
                    lost_then_retried += 1

    assert lost_then_retried > 0


def test_fault_tick_distinguishes_own_and_reassigned_orders():
    s = settings(channel_drop_rate=0.4)
    homes = new_fleet(s)
    f = frame({"network": {"drop_rate": 0.4}})
    apply_events(homes, f.events)
    result = orchestrate_tick(homes, f, policy(), "AUTO", s, seed=1)

    timelines = order_timelines(result.events, result.allocation.per_home_kw)
    homes_with_both = [home_id for home_id, rows in timelines.items() if {"own", "r"} <= set(grouped_by_key(rows))]

    assert homes_with_both
    for rows in timelines.values():
        for keyed_rows in grouped_by_key(rows).values():
            assert_lifecycle_is_well_formed(keyed_rows)


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_fault_tick_report_drops_follow_execution_or_duplicate(seed):
    s = settings(channel_drop_rate=0.4)
    homes = new_fleet(s)
    f = frame({"network": {"drop_rate": 0.4}})
    apply_events(homes, f.events)
    result = orchestrate_tick(homes, f, policy(), "AUTO", s, seed=seed)

    timelines = order_timelines(result.events, result.allocation.per_home_kw)

    for rows in timelines.values():
        for keyed_rows in grouped_by_key(rows).values():
            assert_lifecycle_is_well_formed(keyed_rows)
