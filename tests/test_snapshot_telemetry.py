"""Snapshot carries the engine's battery feed as `telemetry`. The text `feed` stays the ERCOT status."""

import json

from server.api.snapshot import IngestError, build_snapshot

PLANT = {"homes": {"total": 100, "live": 69, "stale": 0, "dead": 30, "suspect": 1},
         "soc_mwh": 1.2, "available_mw": 0.3, "coverage": 0.69}
READINGS = {"received": 3005, "accepted": 2930, "duplicates": 50, "late": 25}


def _run(tick_extra):
    tick = {"tick": 5, "ts": "2026-09-25T12:00:00-05:00", "target_mw": 0.4, "delivered_mw": 0.31}
    return {"run_id": "telemetry", "decision_line": None, "ticks": [{**tick, **tick_extra}]}


def _snapshot(tmp_path, monkeypatch, run):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps(run), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)

    def boom(_now):
        raise IngestError("auth")

    return build_snapshot(ingest=boom)


def test_snapshot_bundles_plant_and_readings(tmp_path, monkeypatch):
    tick = _snapshot(tmp_path, monkeypatch, _run({"plant": PLANT, "feed": READINGS}))
    assert tick["telemetry"] == {"plant": PLANT, "readings": READINGS}


def test_engine_feed_dict_never_reaches_the_text_feed(tmp_path, monkeypatch):
    tick = _snapshot(tmp_path, monkeypatch, _run({"plant": PLANT, "feed": READINGS}))
    assert not isinstance(tick.get("feed"), dict)


def test_no_telemetry_when_the_feed_was_off(tmp_path, monkeypatch):
    # TELEMETRY_FEED=0 leaves plant and feed as empty dicts on the engine tick.
    tick = _snapshot(tmp_path, monkeypatch, _run({"plant": {}, "feed": {}}))
    assert "telemetry" not in tick
