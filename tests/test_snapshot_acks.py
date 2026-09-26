"""Snapshot passes zone ack totals through. It does not invent per-home devices."""

import json

from server.api.snapshot import IngestError, build_snapshot

RUN = {
    "run_id": "ack-rollup",
    "decision_line": None,
    "ticks": [
        {
            "tick": 5,
            "ts": "2026-09-25T12:00:00-05:00",
            "target_mw": 0.4,
            "delivered_mw": 0.31,
            "zone_acks": {
                "Houston": {"acked": 10, "held": 15, "silent": 0, "dead": 0, "unconfirmed": 0},
                "North": {"acked": 8, "held": 12, "silent": 2, "dead": 3, "unconfirmed": 1},
            },
        }
    ],
}


def test_snapshot_keeps_zone_ack_totals(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps(RUN), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)

    def boom(_now):
        raise IngestError("auth")

    tick = build_snapshot(ingest=boom)
    assert tick["zone_acks"]["Houston"] == {
        "acked": 10, "held": 15, "silent": 0, "dead": 0, "unconfirmed": 0,
    }
    assert tick["zone_acks"]["North"] == {
        "acked": 8, "held": 12, "silent": 2, "dead": 3, "unconfirmed": 1,
    }
