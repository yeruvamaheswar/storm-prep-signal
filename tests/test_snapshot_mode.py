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
