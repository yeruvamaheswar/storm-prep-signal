"""Per-tick controller emit: shape, charge states, acks, and the loop wiring."""
import json
from pathlib import Path

from server.engine.contracts import Home, Policy, TapeFrame
from server.engine.fleet import new_fleet
from server.engine.loop import run
from server.engine.orchestration import orchestrate_tick
from server.engine.tick_emit import build_tick_emit, charge_state

ZONES = {"Houston": "48201", "North": "48113", "South": "48355", "West": "48329"}
FAST = {"channel_delay_s": (1.0, 5.0), "worker_delay_s": (1.0, 5.0)}
SETTINGS = {"margin_pct": 15, "lookahead_hours": 6, "fleet_size": 20, "home_kwh": 20.0,
            "home_max_kw": 5.0, "home_start_soc_min_pct": 45.0, "home_start_soc_max_pct": 75.0,
            "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0, "tick_minutes": 5, "zones": ZONES}
ROOT = Path(__file__).resolve().parent.parent


def make_policy(pct=30.0):
    return Policy(pct, "normal", "LOW", zone_reserve_pct={z: pct for z in ZONES},
                  zone_reasons={z: "normal" for z in ZONES})


def make_frame(tick=1, target_mw=0.05):
    return TapeFrame(tick, "2026-09-26T17:00:00-05:00", target_mw, "synthetic",
                     40.0, "synthetic", events={})


def test_emit_matches_shared_shape():
    homes = new_fleet({**SETTINGS, **FAST})
    frame = make_frame()
    cycle = orchestrate_tick(homes, frame, make_policy(), "AUTO", {**SETTINGS, **FAST}, 1)
    emit = build_tick_emit(frame, homes, cycle)

    assert emit["tick"] == 1 and emit["ts"] == frame.ts
    assert emit["target_mw"] == frame.target_mw and emit["target_label"] == "synthetic"
    assert emit["delivered_mw"] == cycle.credited_mw
    assert emit["fleet_size"] == len(homes) and len(emit["homes"]) == len(homes)
    for home_id, row in emit["homes"].items():
        assert set(row) == {"soc_kwh", "assigned_kw", "power_kw", "charge_state",
                            "status", "zone", "last_seen", "command"}
        assert row["charge_state"] in ("CHARGING", "DISCHARGING", "HOLDING", "FULL", "EMPTY")
        cmd = row["command"]
        if cmd is None:
            assert row["assigned_kw"] == 0.0
        else:
            assert set(cmd) == {"command_id", "kw", "actual_kw", "ack", "sent_at"}
            assert cmd["ack"] in ("ok", "timeout")
            assert cmd["sent_at"] == frame.ts


def test_confirmed_homes_discharge_and_unconfirmed_hold_at_zero():
    settings = {**SETTINGS, **FAST, "channel_drop_rate": 0.5}
    homes = new_fleet(settings)
    frame = make_frame()
    cycle = orchestrate_tick(homes, frame, make_policy(), "AUTO", settings, 3)
    emit = build_tick_emit(frame, homes, cycle)

    assert cycle.unconfirmed_mw > 0
    for home_id, row in emit["homes"].items():
        cmd = row["command"]
        assert cmd is not None  # every live home was sent work
        if cmd["ack"] == "ok":
            assert row["power_kw"] > 0 and row["charge_state"] == "DISCHARGING"
            assert cmd["actual_kw"] == row["power_kw"]
        else:
            assert cmd["ack"] == "timeout"
            assert row["power_kw"] == 0.0 and row["charge_state"] in ("HOLDING", "FULL", "EMPTY")
            assert cmd["actual_kw"] == 0.0


def test_hold_sends_nothing_so_every_command_is_null():
    homes = new_fleet({**SETTINGS, **FAST})
    frame = make_frame()
    cycle = orchestrate_tick(homes, frame, make_policy(), "HOLD", {**SETTINGS, **FAST}, 1)
    emit = build_tick_emit(frame, homes, cycle)

    assert cycle.command_states == {}
    assert all(row["command"] is None for row in emit["homes"].values())
    assert all(row["assigned_kw"] == 0.0 and row["power_kw"] == 0.0
               for row in emit["homes"].values())


def test_rails_are_full_and_empty_only_at_zero_kw():
    assert charge_state(0.0, 20.0, 20.0) == "FULL"
    assert charge_state(0.0, 0.0, 20.0) == "EMPTY"
    assert charge_state(0.0, 12.0, 20.0) == "HOLDING"
    assert charge_state(2.5, 12.0, 20.0) == "DISCHARGING"
    assert charge_state(-2.5, 12.0, 20.0) == "CHARGING"


def test_full_home_with_no_order_reports_full_not_holding():
    homes = [Home("home-001", 20.0, 20.0, 5.0, "live", "South"),
             Home("home-002", 20.0, 0.0, 5.0, "live", "South")]
    frame = make_frame(target_mw=0.0)
    cycle = orchestrate_tick(homes, frame, make_policy(), "HOLD", {**SETTINGS, **FAST}, 1)
    emit = build_tick_emit(frame, homes, cycle)

    assert emit["homes"]["home-001"]["charge_state"] == "FULL"
    assert emit["homes"]["home-002"]["charge_state"] == "EMPTY"


def test_loop_writes_tick_emit_every_tick(tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    tape = tmp_path / "emit.json"
    tape.write_text(json.dumps({
        "label": "emit",
        "frames": [
            {"tick": 1, "ts": "2026-09-25T12:00:00-05:00", "target_mw": 0.05,
             "target_label": "synthetic", "price_usd_mwh": 35.0, "price_label": "synthetic",
             "events": {}},
            {"tick": 2, "ts": "2026-09-25T12:05:00-05:00", "target_mw": 0.05,
             "target_label": "synthetic", "price_usd_mwh": 35.0, "price_label": "synthetic",
             "events": {"operator": "HOLD"}},
        ],
    }))
    run(str(tape), SETTINGS, log_dir=tmp_path / "logs", runs_dir=tmp_path / "runs")
    emit = json.loads((tmp_path / "runs" / ".." / "fleet" / "tick_emit.json").read_text())

    # The file is the last tick: HOLD sent nothing, but the whole fleet is still there.
    assert emit["tick"] == 2 and emit["fleet_size"] == SETTINGS["fleet_size"]
    assert len(emit["homes"]) == SETTINGS["fleet_size"]
    assert all(row["command"] is None for row in emit["homes"].values())


def test_engine_never_imports_supabase():
    for path in (ROOT / "server" / "engine" / "tick_emit.py", ROOT / "server" / "engine" / "loop.py"):
        imports = [line for line in path.read_text().splitlines()
                   if line.strip().startswith(("import ", "from "))]
        assert not any("supabase" in line.lower() for line in imports)
