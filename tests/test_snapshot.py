"""GET /v1/runs/latest and snapshot fail-safe. Live ingest is /v1/feeds."""

import json
from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from server.app import create_app
from server.api.archive import ArchiveUnavailable
from server.api.fixtures import FixtureStore
from server.api.snapshot import IngestError, build_meta, build_snapshot
from server.engine.baseline import load_baseline
from server.engine.cli import read_settings
from server.engine.policy import reserve_policy
from server.engine.risk import ZONES, compute_risk, current_hour_index, zone_fields
from server.engine.signal import parse_central, to_signal

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
            "zone_delivered_mw": {"North": 0.05},
        }
    ],
}


def _client():
    return TestClient(create_app(FixtureStore()))


def test_latest_run_prefers_engine_file(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps({**LAYOUT, "run_id": "engine-run"}), encoding="utf-8")
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    assert _client().get("/v1/runs/latest").json()["run_id"] == "engine-run"


def test_latest_run_falls_back_to_layout(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "missing.json")
    monkeypatch.setattr("server.api.snapshot.LAYOUT_RUN", tmp_path / "layout.json")
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [])
    (tmp_path / "layout.json").write_text(json.dumps(LAYOUT), encoding="utf-8")
    body = _client().get("/v1/runs/latest").json()
    assert body["run_id"] == "layout-fixture"
    assert body["ticks"][0]["target_mw"] == 0.2


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


def _latest(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "latest.json")
    (tmp_path / "latest.json").write_text(json.dumps(LAYOUT), encoding="utf-8")


def test_snapshot_auth_is_named(tmp_path, monkeypatch):
    _latest(tmp_path, monkeypatch)

    def boom(_now):
        raise IngestError("auth")

    tick = build_snapshot(ingest=boom)
    assert tick["quality"] == "auth"
    assert tick["target_mw"] == 0.2


def test_snapshot_lists_outage_and_price_feeds(tmp_path, monkeypatch):
    _latest(tmp_path, monkeypatch)
    tick = build_snapshot(ingest=lambda _now: LIVE)
    products = [row["product"] for row in tick["feeds"]]
    assert products == ["NP3-233-CD", "NP6-905-CD"]
    outage, price = tick["feeds"]
    assert outage["path"] == "/api/public-reports/np3-233-cd/hourly_res_outage_cap"
    assert price["path"] == "/api/public-reports/np6-905-cd/spp_node_zone_hub"
    assert outage["as_of"] == "23:00 CT"
    assert outage["age_min"] == 30
    assert outage["quality"] == "ok"
    assert outage["hold_on_fail"] is False
    assert price["quality"] == "ok"
    assert price["hold_on_fail"] is False


def test_snapshot_outage_failure_holds_and_names_policy(tmp_path, monkeypatch):
    _latest(tmp_path, monkeypatch)

    def boom(_now):
        raise IngestError("timeout")

    tick = build_snapshot(ingest=boom)
    assert tick["quality"] == "timeout"
    assert tick["policy_reason"] == "signal_unavailable"
    outage = next(row for row in tick["feeds"] if row["product"] == "NP3-233-CD")
    assert outage["quality"] == "timeout"
    assert outage["hold_on_fail"] is True
    price = next(row for row in tick["feeds"] if row["product"] == "NP6-905-CD")
    assert price["quality"] == "timeout"
    assert price["hold_on_fail"] is False


def test_snapshot_keeps_http_status_off_secrets(tmp_path, monkeypatch):
    _latest(tmp_path, monkeypatch)

    def boom(_now):
        raise IngestError("auth", http_status=401)

    tick = build_snapshot(ingest=boom)
    assert {row["http_status"] for row in tick["feeds"]} == {401}
    blob = json.dumps(tick)
    assert "Bearer" not in blob
    assert "Ocp-Apim" not in blob
    assert "id_token" not in blob
    assert "password" not in blob.lower()
    assert tick["price_usd_mwh"] is None
    assert tick["price_label"] == "none"
    assert tick["trigger_mw"] is None
    assert 185 not in tick.values()


def test_meta_reads_engine_source_and_fleet(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(
        json.dumps({**LAYOUT, "source": "live", "settings": {"fleet_size": 10000}}),
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    meta = _client().get("/v1/meta").json()
    assert meta["mode"] == "live"
    assert meta["fleet_size"] == 10000
    assert meta["source"] == "live"
    assert meta["event"] is None
    assert meta["clock"] in (None, "wall")
    assert meta["fleet_cap_mw"] == 50.0
    assert meta["call_target_mw"] == 40.0


def test_meta_falls_back_to_demo_fixture(tmp_path, monkeypatch):
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", tmp_path / "missing.json")
    monkeypatch.setattr("server.api.snapshot.LAYOUT_RUN", tmp_path / "layout.json")
    monkeypatch.setattr("server.api.snapshot.fetch_runs_table", lambda: [])
    (tmp_path / "layout.json").write_text(json.dumps(LAYOUT), encoding="utf-8")
    meta = _client().get("/v1/meta").json()
    assert meta["mode"] == "demo"
    assert meta["source"] == "fixture"
    assert meta["event"] is None
    assert meta["clock"] in ("fixture", "2026-09-25T12:00:00-05:00")
    scenario = build_meta({"source": "scenario", "settings": {"fleet_size": 50}})
    assert scenario["mode"] == "demo"
    assert scenario["source"] in ("scenario", "fixture")
    assert scenario["event"] is None


def _raw(name):
    return json.loads((Path(__file__).resolve().parent / "fixtures" / name).read_text(encoding="utf-8"))


def _v2_ingest(raw, as_of="12:00 CT", age_min=0):
    def ingest(_now):
        return {"price_usd_mwh": 42.25, "raw": raw, "as_of": as_of, "age_min": age_min}

    return ingest


def _v2_expected(raw):
    posted = parse_central("2026-09-25T12:00:47")
    settings = read_settings()
    signal = to_signal(raw, posted)
    risk = compute_risk(
        signal,
        load_baseline(lookahead_hours=settings["lookahead_hours"]),
        margin_pct=settings["margin_pct"],
        lookahead_hours=settings["lookahead_hours"],
    )
    return posted, risk, reserve_policy(risk, settings), signal


def test_snapshot_sends_v2_trigger_from_compute_risk(tmp_path, monkeypatch):
    raw = _raw("np3_233_cd.json")
    posted, risk, policy, signal = _v2_expected(raw)
    _latest(tmp_path, monkeypatch)
    tick = build_snapshot(now=posted, ingest=_v2_ingest(raw))
    assert risk.level == "LOW"
    assert tick["peak_mw"] == risk.peak_mw
    assert tick["outage_mw"] == risk.peak_mw
    assert tick["trigger_mw"] == risk.trigger_mw
    assert tick["margin_mw"] == tick["outage_mw"] - tick["trigger_mw"]
    assert tick["reserve_pct"] == policy.reserve_pct
    assert tick["policy_reason"] == policy.reason
    assert tick["risk_level"] == policy.risk_level
    peak = signal["rows"][current_hour_index(signal) + risk.peak_lead]
    for zone in ZONES:
        for field in zone_fields(zone):
            assert tick[field] == peak[field]


def test_snapshot_high_uses_reserve_policy(tmp_path, monkeypatch):
    raw = _raw("np3_spike_synthetic.json")
    posted, risk, policy, _signal = _v2_expected(raw)
    _latest(tmp_path, monkeypatch)
    tick = build_snapshot(now=posted, ingest=_v2_ingest(raw))
    assert risk.level == "HIGH"
    assert tick["trigger_mw"] == risk.trigger_mw
    assert tick["margin_mw"] == tick["outage_mw"] - tick["trigger_mw"]
    assert tick["reserve_pct"] == policy.reserve_pct
    assert tick["policy_reason"] == "storm_risk_high"
    assert tick["risk_level"] == "HIGH"


def test_snapshot_stale_is_fail_safe(tmp_path, monkeypatch):
    _latest(tmp_path, monkeypatch)

    def boom(_now):
        raise IngestError("stale")

    tick = build_snapshot(ingest=boom)
    assert tick["risk_level"] is None
    assert tick["policy_reason"] == "signal_unavailable"
    assert tick["reserve_pct"] == 60
    assert tick["outage_mw"] is None
    assert tick["trigger_mw"] is None
    assert tick["peak_mw"] is None
    assert tick["quality"] == "stale"
    assert tick["feed"] == "LIVE"
    assert tick["clock_pinned"] is False


def _archive_run(tmp_path, monkeypatch, event="tuning-2026"):
    latest = tmp_path / "latest.json"
    latest.write_text(
        json.dumps({**LAYOUT, "source": "archive", "event": event, "ticks": [
            {**LAYOUT["ticks"][0], "trigger_mw": 22348, "price_usd_mwh": 185},
        ]}),
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)


def test_snapshot_archive_rates_payload_with_compute_risk(tmp_path, monkeypatch):
    raw = _raw("np3_233_cd.json")
    posted, risk, policy, signal = _v2_expected(raw)
    _archive_run(tmp_path, monkeypatch)

    def fake_outage(_event, _clock, **_kwargs):
        return {"body": raw, "posted_at": posted}

    def fake_prices(*_args, **_kwargs):
        raise ArchiveUnavailable("unavailable", "no LZ_NORTH")

    monkeypatch.setattr("server.api.snapshot.read_outage", fake_outage)
    monkeypatch.setattr("server.api.snapshot.read_prices", fake_prices)

    tick = build_snapshot(now=posted, event="tuning-2026")
    assert tick["source"] == "archive"
    assert tick["peak_mw"] == risk.peak_mw
    assert tick["outage_mw"] == risk.peak_mw
    assert tick["trigger_mw"] == risk.trigger_mw
    assert tick["houston_mw"] == risk.zone_mw["Houston"]
    assert tick["north_mw"] == risk.zone_mw["North"]
    assert tick["south_mw"] == risk.zone_mw["South"]
    assert tick["west_mw"] == risk.zone_mw["West"]
    assert tick["policy_reason"] == policy.reason
    assert tick["reserve_pct"] == policy.reserve_pct
    assert 22348 not in tick.values()
    assert 185 not in tick.values()
    peak = signal["rows"][current_hour_index(signal) + risk.peak_lead]
    for zone in ZONES:
        for field in zone_fields(zone):
            assert tick[field] == peak[field]


def test_snapshot_archive_missing_posting_is_fail_safe(tmp_path, monkeypatch):
    posted, _risk, _policy, _signal = _v2_expected(_raw("np3_233_cd.json"))
    _archive_run(tmp_path, monkeypatch)

    def missing(*_args, **_kwargs):
        raise ArchiveUnavailable("unavailable", "no posting")

    monkeypatch.setattr("server.api.snapshot.read_outage", missing)
    tick = build_snapshot(now=posted, event="tuning-2026")
    assert tick["policy_reason"] == "signal_unavailable"
    assert tick["reserve_pct"] == 60
    assert tick["risk_level"] is None
    assert tick["trigger_mw"] is None
    assert tick["peak_mw"] is None


def test_snapshot_archive_stale_posting_is_fail_safe(tmp_path, monkeypatch):
    raw = _raw("np3_233_cd.json")
    posted, _risk, _policy, _signal = _v2_expected(raw)
    _archive_run(tmp_path, monkeypatch)

    def fake_outage(_event, _clock, **_kwargs):
        return {"body": raw, "posted_at": posted}

    def fake_prices(*_args, **_kwargs):
        raise ArchiveUnavailable("unavailable", "no LZ_NORTH")

    monkeypatch.setattr("server.api.snapshot.read_outage", fake_outage)
    monkeypatch.setattr("server.api.snapshot.read_prices", fake_prices)
    tick = build_snapshot(now=posted + timedelta(minutes=120), event="tuning-2026")
    assert tick["quality"] == "stale"
    assert tick["policy_reason"] == "signal_unavailable"
    assert tick["reserve_pct"] == 60
    assert tick["trigger_mw"] is None
