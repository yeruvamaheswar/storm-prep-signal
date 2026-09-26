"""Fleet mode lives in var/state.json so Hold/Auto survive a restart."""

import json

from server.engine.fleet_state import apply_mode, load_fleet_mode, write_fleet_mode


def test_missing_state_is_auto(tmp_path):
    assert load_fleet_mode(tmp_path / "missing.json") == "AUTO"


def test_write_then_load_round_trips_hold(tmp_path):
    path = tmp_path / "state.json"
    write_fleet_mode("HOLD", path)
    assert json.loads(path.read_text(encoding="utf-8")) == {"mode": "HOLD"}
    assert load_fleet_mode(path) == "HOLD"


def test_invalid_or_unknown_mode_falls_back_to_auto(tmp_path):
    path = tmp_path / "state.json"
    path.write_text("{not json", encoding="utf-8")
    assert load_fleet_mode(path) == "AUTO"
    path.write_text(json.dumps({"mode": "RESERVE"}), encoding="utf-8")
    assert load_fleet_mode(path) == "AUTO"


def test_apply_mode_overlays_hold_and_keeps_tape_when_missing(tmp_path):
    tick = {"mode": "AUTO", "delivered_mw": 0.2}
    assert apply_mode(tick, tmp_path / "missing.json") == tick
    write_fleet_mode("HOLD", tmp_path / "state.json")
    assert apply_mode(tick, tmp_path / "state.json") == {"mode": "HOLD", "delivered_mw": 0.2}
