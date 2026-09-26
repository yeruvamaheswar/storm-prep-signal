"""Snapshot mode is the persisted engine mode, not the last tape tick."""

import json

from server.api.snapshot import IngestError, build_snapshot

LAYOUT = {
    "run_id": "layout-fixture",
    "decision_line": None,
    "ticks": [
        {
            "tick": 12,
            "ts": "2024-07-08T14:55:00-05:00",
            "mode": "AUTO",
            "target_mw": 0.2,
            "target_label": "synthetic",
            "delivered_mw": 0.2,
            "missed_mw": 0.0,
            "price_usd_mwh": 48,
            "price_label": "synthetic",
            "reserve_pct": 30,
            "policy_reason": "normal",
            "risk_level": "LOW",
            "live_homes": 100,
            "stale_homes": 0,
            "dead_homes": 0,
            "breaches": 0,
            "reasons": [],
            "brief": "tape brief",
        }
    ],
}


def test_snapshot_mode_reads_engine_state(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "latest.json")
    (tmp_path / "latest.json").write_text(json.dumps(LAYOUT), encoding="utf-8")
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"mode": "HOLD"}), encoding="utf-8")
    monkeypatch.setattr("server.engine.fleet_state.STATE_PATH", state)

    def boom(_now):
        raise IngestError("auth")

    monkeypatch.setattr("server.api.snapshot.live_ingest", boom)
    assert build_snapshot()["mode"] == "HOLD"


def _hold_tick():
    return {
        "tick": 1, "ts": "2026-09-26T17:42:36-05:00", "mode": "HOLD",
        "target_mw": 40.0, "target_label": "synthetic",
        "delivered_mw": 0.0, "missed_mw": 40.0,
        "price_usd_mwh": 28.35, "price_label": "ercot",
        "reserve_pct": 30, "policy_reason": "normal", "risk_level": "LOW",
        "live_homes": 10000, "stale_homes": 0, "dead_homes": 0,
        "breaches": 0, "reasons": ["operator_hold"],
        "intent": "hold", "intent_reason": "operator_hold",
        "brief": "tape brief",
    }


def test_snapshot_auto_overlay_strips_stale_operator_hold(tmp_path, monkeypatch):
    run = {"run_id": "live-hold", "source": "live", "ticks": [_hold_tick()]}
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "latest.json")
    (tmp_path / "latest.json").write_text(json.dumps(run), encoding="utf-8")
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"mode": "AUTO"}), encoding="utf-8")
    monkeypatch.setattr("server.engine.fleet_state.STATE_PATH", state)

    def boom(_now):
        raise IngestError("auth")

    monkeypatch.setattr("server.api.snapshot.live_ingest", boom)
    tick = build_snapshot()
    assert tick["mode"] == "AUTO"
    assert "operator_hold" not in tick["reasons"]
    assert "Operator hold" not in tick["brief"]


def test_snapshot_hold_overlay_keeps_dispatched_reasons(tmp_path, monkeypatch):
    auto = {**_hold_tick(), "mode": "AUTO", "delivered_mw": 40.0,
            "missed_mw": 0.0, "reasons": [], "intent": "hold", "intent_reason": ""}
    run = {"run_id": "live-auto", "source": "live", "ticks": [auto]}
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "latest.json")
    (tmp_path / "latest.json").write_text(json.dumps(run), encoding="utf-8")
    state = tmp_path / "state.json"
    state.write_text(json.dumps({"mode": "HOLD"}), encoding="utf-8")
    monkeypatch.setattr("server.engine.fleet_state.STATE_PATH", state)

    def boom(_now):
        raise IngestError("auth")

    monkeypatch.setattr("server.api.snapshot.live_ingest", boom)
    tick = build_snapshot()
    assert tick["mode"] == "HOLD"
    assert "operator_hold" not in tick["reasons"]
