"""scripts/live_cycle.py: live ERCOT rows go to Supabase, then one allocate tick. No live network."""
import importlib.util
import json
from datetime import datetime
from pathlib import Path

import pytest
import requests

from server.api.archive import read_outage
from server.api.snapshot import IngestError, build_snapshot
from server.engine.signal import CENTRAL

ROOT = Path(__file__).resolve().parent.parent
NP3 = ROOT / "tests" / "fixtures" / "np3_233_cd.json"
NP6 = ROOT / "tests" / "fixtures" / "np6_905_cd.json"
spec = importlib.util.spec_from_file_location("live_cycle", ROOT / "scripts" / "live_cycle.py")
cycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cycle)

NOW = datetime(2026, 9, 25, 12, 0, 47, tzinfo=CENTRAL)
SETTINGS = {
    "margin_pct": 15, "lookahead_hours": 6, "fleet_size": 100, "home_kwh": 20.0,
    "home_max_kw": 5.0, "base_reserve_pct": 30.0, "storm_reserve_pct": 60.0,
    "tick_minutes": 5, "fetch_timeout_s": 3, "stale_after_min": 90,
}


class FakeResponse:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


class Reply:
    def __init__(self, rows, ok=True, status_code=200):
        self._rows = rows
        self.ok = ok
        self.status_code = status_code

    def json(self):
        return self._rows


def _fake_ercot(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for name in ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"):
        monkeypatch.setenv(name, "fake")

    def post(url, **kwargs):
        return FakeResponse(200, json.dumps({"id_token": "token"}))

    def get(url, **kwargs):
        if "np6-905-cd" in url:
            return FakeResponse(200, NP6.read_text())
        return FakeResponse(200, NP3.read_text())

    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(requests, "get", get)


def test_unique_rows_keep_last_on_upsert_key():
    # Postgres 21000: one POST cannot update the same (report, posted_at) twice.
    rows = [
        {"report": "NP3-233-CD", "posted_at": "2026-09-26T15:00:00-05:00", "payload": [1]},
        {"report": "NP3-233-CD", "posted_at": "2026-09-26T15:00:00-05:00", "payload": [2]},
        {"report": "NP3-233-CD", "posted_at": "2026-09-26T15:05:00-05:00", "payload": [3]},
    ]
    unique = cycle.unique_rows(rows, ("report", "posted_at"))
    assert [row["payload"] for row in unique] == [[2], [3]]


def test_duplicate_price_intervals_send_once(tmp_path, monkeypatch):
    raw = {
        "fields": [{"name": n} for n in (
            "deliveryDate", "deliveryHour", "deliveryInterval",
            "settlementPoint", "settlementPointPrice",
        )],
        "data": [
            ["2026-09-25", 12, 4, "LZ_NORTH", 31.5],
            ["2026-09-25", 12, 4, "LZ_NORTH", 42.25],
        ],
    }
    prices = cycle.unique_rows(cycle.live_price_rows(raw), ("settlement_point", "interval_ending"))
    assert len(prices) == 1
    assert prices[0]["price_usd_mwh"] == 42.25


def test_hold_state_delivers_zero(tmp_path, monkeypatch):
    _fake_ercot(monkeypatch, tmp_path)
    (tmp_path / "state.json").write_text(json.dumps({"mode": "HOLD"}))
    result = cycle.run_cycle(
        SETTINGS, now=NOW, runs_dir=tmp_path / "runs", log_dir=tmp_path / "logs",
        state_path=tmp_path / "state.json", url="", key="", persist=False, send=None,
    )
    tick = result["record"]["ticks"][-1]
    assert tick["mode"] == "HOLD"
    assert tick["delivered_mw"] == 0.0
    assert tick["reasons"] == ["operator_hold"]


def test_live_posting_rows_use_event_live():
    rows = cycle.live_posting_rows(json.loads(NP3.read_text()))
    assert rows
    assert all(row["event"] == "live" and row["report"] == "NP3-233-CD" for row in rows)
    assert all(row["file_name"] is None for row in rows)
    assert "postedDatetime" not in rows[0]["payload"][0]


def test_one_cycle_upserts_live_rows_and_allocates(tmp_path, monkeypatch):
    _fake_ercot(monkeypatch, tmp_path)
    sent = []

    def fake_send(rows, url, key, table="ercot_postings", on_conflict="report,posted_at"):
        sent.append((table, list(rows), on_conflict))

    result = cycle.run_cycle(
        SETTINGS, now=NOW, runs_dir=tmp_path / "runs", log_dir=tmp_path / "logs",
        state_path=tmp_path / "state.json", url="https://example.supabase.co", key="test-key",
        persist=False, send=fake_send,
    )

    tables = [table for table, _rows, _conflict in sent]
    assert "ercot_postings" in tables
    assert "ercot_prices" in tables
    assert all(row["event"] == "live" for table, rows, _ in sent for row in rows)
    tick = result["record"]["ticks"][-1]
    assert result["record"]["source"] == "live"
    assert len(result["record"]["ticks"]) == 1
    assert tick["delivered_mw"] == pytest.approx(0.40)
    assert tick["missed_mw"] == pytest.approx(0.0)
    assert "temp_stub" not in tick["reasons"]
    assert tick["breaches"] == 0
    latest = json.loads((tmp_path / "runs" / "latest.json").read_text())
    assert latest["ticks"][-1]["delivered_mw"] == pytest.approx(0.40)


def test_missing_supabase_still_writes_a_live_tick(tmp_path, monkeypatch):
    _fake_ercot(monkeypatch, tmp_path)
    result = cycle.run_cycle(
        SETTINGS, now=NOW, runs_dir=tmp_path / "runs", log_dir=tmp_path / "logs",
        state_path=tmp_path / "state.json", url="", key="", persist=False, send=None,
    )
    assert result["upsert"].startswith("skipped")
    assert result["record"]["ticks"][-1]["delivered_mw"] == pytest.approx(0.40)


def test_snapshot_live_reads_event_live_posting(tmp_path, monkeypatch):
    hours = json.loads(NP3.read_text())
    from server.engine.signal import rows_by_name
    payload = [{k: v for k, v in row.items() if k != "postedDatetime"} for row in rows_by_name(hours)]
    postings = [{
        "event": "live", "report": "NP3-233-CD",
        "posted_at": "2026-09-25T12:00:47-05:00", "payload": payload,
    }]
    prices = [{
        "event": "live", "settlement_point": "LZ_NORTH",
        "interval_ending": "2026-09-25T12:00:00-05:00",
        "delivery_date": "2026-09-25", "delivery_hour": 12, "delivery_interval": 4,
        "price_usd_mwh": 42.25,
    }]

    def http_get(url, params=None, headers=None, timeout=None):
        params = params or {}
        rows = postings if url.endswith("/ercot_postings") else prices
        if params.get("event", "").startswith("eq."):
            rows = [row for row in rows if row["event"] == params["event"][3:]]
        return Reply(rows[:1] if params.get("limit") else rows)

    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps({
        "run_id": "live-1", "source": "live", "ticks": [{
            "tick": 1, "ts": "2026-09-25T12:00:47-05:00", "mode": "AUTO",
            "target_mw": 0.4, "target_label": "synthetic",
            "delivered_mw": 0.4, "missed_mw": 0.0,
            "price_usd_mwh": 42.25, "price_label": "ercot",
            "reserve_pct": 30, "policy_reason": "normal", "risk_level": "LOW",
            "live_homes": 100, "stale_homes": 0, "dead_homes": 0, "breaches": 0,
            "reasons": [],
        }],
    }))
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    monkeypatch.setattr("server.api.snapshot.LAYOUT_RUN", tmp_path / "missing.json")
    got = read_outage("live", NOW, http_get=http_get,
                      settings={"url": "https://example.supabase.co", "key": "k", "timeout_s": 3})
    assert got["posted_at"].isoformat() == "2026-09-25T12:00:47-05:00"
    tick = build_snapshot(now=NOW, event="live", ingest=lambda _now: {
        "price_usd_mwh": 42.25, "price_as_of": "2026-09-25T12:00:00-05:00",
        "price_rows": prices, "raw": got["body"], "as_of": "12:00 CT", "age_min": 0,
    })
    assert tick["source"] == "live"
    assert tick["delivered_mw"] == pytest.approx(0.4)
    assert tick["reasons"] == []


def test_live_snapshot_reads_event_live_before_direct_ercot(tmp_path, monkeypatch):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps({
        "run_id": "live-1", "source": "live", "ticks": [{
            "tick": 1, "ts": "2026-09-25T12:00:47-05:00", "mode": "AUTO",
            "target_mw": 0.4, "target_label": "synthetic",
            "delivered_mw": 0.4, "missed_mw": 0.0,
            "price_usd_mwh": None, "price_label": "none",
            "reserve_pct": 30, "policy_reason": "normal", "risk_level": "LOW",
            "live_homes": 100, "stale_homes": 0, "dead_homes": 0, "breaches": 0,
            "reasons": [],
        }],
    }))
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)
    called = []

    def fake_archive(now, event=None, **kwargs):
        called.append(event)
        raise IngestError("unavailable")

    def boom(_now):
        raise IngestError("auth")

    monkeypatch.setattr("server.api.snapshot.archive_ingest", fake_archive)
    monkeypatch.setattr("server.api.snapshot.live_ingest", boom)
    tick = build_snapshot(now=NOW)
    assert called == ["live"]
    assert tick["delivered_mw"] == pytest.approx(0.4)
    assert tick["quality"] == "auth"
