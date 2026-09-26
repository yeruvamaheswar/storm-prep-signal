"""Weekend replay: Demo pins an archive posting clock instead of the 12-tick layout numbers."""

import json
from pathlib import Path

from server.api.archive import ArchiveUnavailable
from server.api.runtime import ARCHIVE_EVENTS, FIXTURE_CLOCK, discover_runtime, posting_at
from server.api.snapshot import build_meta, build_snapshot
from server.engine.baseline import load_baseline
from server.engine.cli import read_settings
from server.engine.policy import reserve_policy
from server.engine.risk import compute_risk
from server.engine.signal import parse_central, to_signal

REPO = Path(__file__).resolve().parents[1]
BERYL_REPLAY = REPO / "data" / "events" / "beryl" / "replay.csv"

REPLAY_CSV = (
    "posted_at,peak_mw,trigger_mw,risk,driving_zone,houston_mw\n"
    "2024-07-08T13:01:11,21000,23652.6,LOW,South,5400\n"
    "2024-07-08T14:01:23,21799,23652.6,LOW,South,5580\n"
    "2024-01-15T13:03:00,24000,23000.0,HIGH,North,4100\n"
)


def _event_dir(tmp_path, name="beryl"):
    folder = tmp_path / name
    folder.mkdir()
    (folder / "replay.csv").write_text(REPLAY_CSV, encoding="utf-8")
    return folder


def test_discover_copies_layout_run_when_no_archive(tmp_path):
    found = discover_runtime(events_dir=tmp_path)
    assert found["source"] == "fixture"
    assert found["event"] is None
    assert found["clock"] == FIXTURE_CLOCK
    assert found["path"].name == "layout-run.json"


def test_discover_beryl_heather_tuning_from_replay_csv(tmp_path):
    _event_dir(tmp_path, "beryl")
    found = discover_runtime(event="beryl", events_dir=tmp_path)
    assert found["source"] == "archive"
    assert found["event"] == "beryl"
    assert found["clock"] == "2024-07-08T13:01:11-05:00"
    assert ARCHIVE_EVENTS == ("beryl", "heather", "tuning-2026")


def test_discover_unknown_event_falls_back_to_fixture(tmp_path):
    _event_dir(tmp_path, "beryl")
    found = discover_runtime(event="not-an-event", events_dir=tmp_path)
    assert found["source"] == "fixture"
    assert found["event"] is None
    assert found["path"].name == "layout-run.json"


def test_posting_at_pins_nearest_clock(tmp_path):
    path = _event_dir(tmp_path) / "replay.csv"
    row = posting_at(path, clock="2024-07-08T14:20:00-05:00")
    assert row["posted_at"] == "2024-07-08T14:01:23"
    assert row["risk"] == "LOW"
    assert float(row["peak_mw"]) == 21799


def test_meta_archive_sets_event_and_pinned_clock(tmp_path, monkeypatch):
    _event_dir(tmp_path, "beryl")
    monkeypatch.setattr("server.api.runtime.EVENTS_DIR", tmp_path)
    meta = build_meta({"source": "scenario", "settings": {"fleet_size": 50}}, event="beryl")
    assert meta["mode"] == "live"
    assert meta["fleet_size"] == 50
    assert meta["source"] == "archive"
    assert meta["event"] == "beryl"
    assert meta["clock"] == "archive"


def test_snapshot_archive_uses_compute_risk_not_tape_22348(tmp_path, monkeypatch):
    raw = json.loads((REPO / "tests" / "fixtures" / "np3_233_cd.json").read_text(encoding="utf-8"))
    posted = parse_central("2026-09-25T12:00:47")
    settings = read_settings()
    risk = compute_risk(
        to_signal(raw, posted),
        load_baseline(lookahead_hours=settings["lookahead_hours"]),
        margin_pct=settings["margin_pct"],
        lookahead_hours=settings["lookahead_hours"],
    )
    policy = reserve_policy(risk, settings)
    latest = tmp_path / "latest.json"
    latest.write_text(
        json.dumps({
            "run_id": "layout-fixture",
            "source": "archive",
            "event": "tuning-2026",
            "ticks": [{
                "tick": 5,
                "ts": "2026-09-25T12:00:47-05:00",
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
                "reasons": ["storm_reserve"],
                "brief": "missed on purpose",
                "trigger_mw": 22348,
            }],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)

    def fake_outage(_event, _clock, **_kwargs):
        return {"body": raw, "posted_at": posted}

    def fake_prices(*_args, **_kwargs):
        raise ArchiveUnavailable("unavailable", "no LZ_NORTH")

    monkeypatch.setattr("server.api.snapshot.read_outage", fake_outage)
    monkeypatch.setattr("server.api.snapshot.read_prices", fake_prices)

    tick = build_snapshot(now=posted, event="tuning-2026")
    assert tick["source"] == "archive"
    assert tick["trigger_mw"] == risk.trigger_mw
    assert tick["peak_mw"] == risk.peak_mw
    assert tick["policy_reason"] == policy.reason
    assert tick["price_usd_mwh"] is None
    assert 185 not in tick.values()
    assert 22348 not in tick.values()


def test_committed_beryl_replay_is_discoverable():
    assert BERYL_REPLAY.is_file()
    found = discover_runtime(event="beryl")
    assert found["source"] == "archive"
    assert found["event"] == "beryl"
    assert found["clock"].startswith("2024-07-05T00:01:04")


def test_snapshot_uses_replay_csv_when_archive_table_is_empty(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(
        json.dumps({
            "run_id": "layout-fixture",
            "source": "fixture",
            "ticks": [{
                "tick": 5,
                "ts": "2026-09-25T12:00:47-05:00",
                "mode": "AUTO",
                "target_mw": 0.4,
                "target_label": "synthetic",
                "delivered_mw": 0.31,
                "missed_mw": 0.09,
                "price_usd_mwh": 185,
                "price_label": "synthetic",
                "reserve_pct": 30,
                "policy_reason": "normal",
                "risk_level": "LOW",
                "live_homes": 100,
                "stale_homes": 0,
                "dead_homes": 0,
                "breaches": 0,
                "reasons": [],
                "brief": "tape",
                "trigger_mw": 22348,
            }],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    monkeypatch.setattr("server.api.runtime.EVENTS_DIR", tmp_path)
    _event_dir(tmp_path, "beryl")

    def missing(*_args, **_kwargs):
        raise ArchiveUnavailable("unavailable", "no posting")

    monkeypatch.setattr("server.api.snapshot.read_outage", missing)
    tick = build_snapshot(event="beryl", clock="2024-07-08T14:20:00-05:00")
    assert tick["source"] == "archive"
    assert tick["event"] == "beryl"
    assert tick["clock"] == "archive"
    assert tick["clock_pinned"] is True
    assert tick["outage_mw"] == 21799
    assert tick["trigger_mw"] == 23652.6
    assert tick["risk_level"] == "LOW"
    assert tick["price_usd_mwh"] is None
    assert 185 not in tick.values()
    assert 22348 not in tick.values()
