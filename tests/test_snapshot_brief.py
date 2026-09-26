"""Live snapshot brief comes from TickResult codes. Demo tape keeps layout-run.json text."""

import json

from fastapi.testclient import TestClient

from server.app import create_app
from server.api.fixtures import FixtureStore
from server.api.snapshot import IngestError, build_snapshot

STORM_TAPE = {
    "run_id": "layout-fixture",
    "decision_line": None,
    "ticks": [
        {
            "tick": 5,
            "ts": "2024-07-08T12:20:00-05:00",
            "mode": "AUTO",
            "target_mw": 0.4,
            "target_label": "synthetic",
            "delivered_mw": 0.31,
            "missed_mw": 0.09,
            "price_usd_mwh": 185,
            "price_label": "synthetic",
            "reserve_pct": 60,
            "policy_reason": "storm_risk_high",
            "risk_level": "HIGH",
            "live_homes": 100,
            "stale_homes": 0,
            "dead_homes": 0,
            "breaches": 0,
            "reasons": ["storm_reserve", "fleet_headroom_short"],
            "brief": (
                "Delivered 0.31 of 0.40 MW (synthetic target). "
                "Floor raised to 60% because storm risk is HIGH; 0.09 MW missed on purpose."
            ),
            "zone_delivered_mw": {"North": 0.08},
        }
    ],
}

LIVE = {
    "price_usd_mwh": 42.25,
    "price_as_of": "2026-09-25T23:15:00-05:00",
    "zone_columns": {"totalResourceMWZoneNorth": 8000.0},
    "zone_totals": {"Houston": 3500.0, "North": 9000.0, "South": 2900.0, "West": 2800.0},
    "outage_mw": 18200.0,
    "driving_zone": "North",
    "zone_mw": 9000.0,
    "as_of": "23:00 CT",
    "age_min": 30,
}


def _client():
    return TestClient(create_app(FixtureStore()))


def test_snapshot_brief_uses_reason_codes_not_tape_prose(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "latest.json")
    (tmp_path / "latest.json").write_text(json.dumps(STORM_TAPE), encoding="utf-8")
    tick = build_snapshot(ingest=lambda _now: LIVE)
    assert tick["reasons"] == ["storm_reserve", "fleet_headroom_short"]
    assert tick["brief"] == (
        "Delivered 0.31 of 0.40 MW. Storm reserve raised; not enough headroom above the floor."
    )
    assert "missed on purpose" not in tick["brief"]
    assert "tape tick" not in tick["brief"]


def test_snapshot_fail_still_drops_tape_prose(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "latest.json")
    (tmp_path / "latest.json").write_text(json.dumps(STORM_TAPE), encoding="utf-8")

    def boom(_now):
        raise IngestError("auth")

    tick = build_snapshot(ingest=boom)
    assert "missed on purpose" not in tick["brief"]
    assert "tape tick" not in tick["brief"]
    assert "storm reserve raised" in tick["brief"].lower()


def test_latest_run_keeps_layout_brief(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "missing.json")
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [])
    layout = tmp_path / "layout.json"
    layout.write_text(json.dumps(STORM_TAPE), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LAYOUT_RUN", layout)
    body = _client().get("/v1/runs/latest").json()
    assert "missed on purpose" in body["ticks"][0]["brief"]
    assert body["ticks"][0]["reasons"] == ["storm_reserve", "fleet_headroom_short"]
