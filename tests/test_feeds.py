"""GET /v1/feeds/* proxies ERCOT. The wall never sees the B2C token."""

import json
from datetime import datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from server.app import create_app
from server.api.feeds import (
    OUTAGE_STALE_MIN,
    PRICE_STALE_MIN,
    list_feeds,
    quality_from_reason,
    serve_outage,
    serve_price,
)
from server.api.fixtures import FixtureStore
from server.engine.signal import CENTRAL, LIVE_PATH, SignalUnavailable

NOW = datetime(2026, 9, 25, 23, 30, tzinfo=CENTRAL)
SETTINGS = {"fetch_timeout_s": 3}

OUTAGE_BODY = {
    "fields": [{"name": "postedDatetime"}, {"name": "operatingDate"}, {"name": "hourEnding"}],
    "data": [["2026-09-25T23:00:47", "2026-09-26", 1]],
}
PRICE_BODY = {
    "fields": [
        {"name": "deliveryDate"},
        {"name": "deliveryHour"},
        {"name": "deliveryInterval"},
        {"name": "settlementPointPrice"},
    ],
    "data": [["2026-09-25", 24, 1, 42.25]],
}


def test_quality_maps_http_codes():
    assert quality_from_reason("auth rejected (HTTP 401)") == "auth"
    assert quality_from_reason("auth rejected (HTTP 403)") == "auth"
    assert quality_from_reason("ERCOT credentials missing from .env") == "auth"
    assert quality_from_reason("ERCOT report request failed (HTTP 429)") == "unavailable"
    assert quality_from_reason("ERCOT report request failed (HTTP 503)") == "unavailable"
    assert quality_from_reason("ERCOT did not answer within 3 s") == "timeout"
    assert quality_from_reason("ERCOT reply was not the expected JSON") == "malformed"
    assert quality_from_reason(f"data is 120 min old (limit {OUTAGE_STALE_MIN})") == "stale"
    assert quality_from_reason("ERCOT login refused (HTTP 401)") == "auth"


def test_outage_ok_writes_cache(tmp_path):
    cache = tmp_path / "latest_np3.json"

    def fetch(_settings, _now, save_to=LIVE_PATH):
        Path(save_to).parent.mkdir(parents=True, exist_ok=True)
        Path(save_to).write_text(json.dumps(OUTAGE_BODY))
        return OUTAGE_BODY

    got = serve_outage(now=NOW, fetch=fetch, cache_path=cache, settings=SETTINGS)
    assert got == {"quality": "ok", "cached": False, "body": OUTAGE_BODY, "http_status": 200}
    assert json.loads(cache.read_text()) == OUTAGE_BODY


def test_outage_401_is_auth_even_with_cache(tmp_path):
    cache = tmp_path / "latest_np3.json"
    cache.write_text(json.dumps(OUTAGE_BODY))

    def fetch(_settings, _now, save_to=LIVE_PATH):
        raise SignalUnavailable("auth rejected (HTTP 401)")

    got = serve_outage(now=NOW, fetch=fetch, cache_path=cache, settings=SETTINGS)
    assert got["quality"] == "auth"
    assert got["cached"] is True
    assert got["body"] == OUTAGE_BODY


def test_outage_429_serves_fresh_cache(tmp_path):
    cache = tmp_path / "latest_np3.json"
    cache.write_text(json.dumps(OUTAGE_BODY))

    def fetch(_settings, _now, save_to=LIVE_PATH):
        raise SignalUnavailable("ERCOT report request failed (HTTP 429)")

    got = serve_outage(now=NOW, fetch=fetch, cache_path=cache, settings=SETTINGS)
    assert got == {"quality": "ok", "cached": True, "body": OUTAGE_BODY, "http_status": 429}


def test_outage_500_with_old_cache_is_stale(tmp_path):
    old = {
        "fields": [{"name": "postedDatetime"}, {"name": "operatingDate"}, {"name": "hourEnding"}],
        "data": [["2026-09-25T20:00:00", "2026-09-25", 21]],
    }
    cache = tmp_path / "latest_np3.json"
    cache.write_text(json.dumps(old))

    def fetch(_settings, _now, save_to=LIVE_PATH):
        raise SignalUnavailable("ERCOT report request failed (HTTP 500)")

    got = serve_outage(now=NOW, fetch=fetch, cache_path=cache, settings=SETTINGS)
    assert got["quality"] == "stale"
    assert got["cached"] is True


def test_price_stale_window_is_30_min(tmp_path):
    cache = tmp_path / "latest_np6.json"
    old_price = {
        "fields": PRICE_BODY["fields"],
        "data": [["2026-09-25", 22, 1, 30.0]],
    }

    def fetch(_settings, _now, save_to=cache):
        Path(save_to).write_text(json.dumps(old_price))
        return old_price

    got = serve_price(now=NOW, fetch=fetch, cache_path=cache, settings=SETTINGS)
    assert got["quality"] == "stale"
    assert PRICE_STALE_MIN == 30


def test_price_429_without_cache_is_unavailable(tmp_path):
    cache = tmp_path / "missing.json"

    def fetch(_settings, _now, save_to=cache):
        raise SignalUnavailable("ERCOT report request failed (HTTP 429)")

    got = serve_price(now=NOW, fetch=fetch, cache_path=cache, settings=SETTINGS)
    assert got == {"quality": "unavailable", "cached": False, "body": None, "http_status": 429}


def test_routes_return_feed_shape_and_no_token(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    def fake_outage(**_kwargs):
        return {"quality": "ok", "cached": False, "body": OUTAGE_BODY}

    def fake_price(**_kwargs):
        return {"quality": "ok", "cached": False, "body": PRICE_BODY}

    monkeypatch.setattr("server.api.v1.serve_outage", fake_outage)
    monkeypatch.setattr("server.api.v1.serve_price", fake_price)
    client = TestClient(create_app(FixtureStore()))
    outage = client.get("/v1/feeds/outage").json()
    price = client.get("/v1/feeds/price").json()
    assert outage["quality"] == "ok"
    assert price["body"]["data"][0][-1] == 42.25
    dumped = json.dumps({"outage": outage, "price": price})
    assert "Bearer" not in dumped
    assert "id_token" not in dumped
    assert "Ocp-Apim" not in dumped


def test_price_fresh_cache_survives_timeout(tmp_path):
    cache = tmp_path / "latest_np6.json"
    cache.write_text(json.dumps(PRICE_BODY))

    def fetch(_settings, _now, save_to=cache):
        raise SignalUnavailable("ERCOT did not answer within 3 s")

    # 23:00 + 15 min interval 1 of HE24 = 24:15? HE24 interval 1 ends at 23:15.
    # NOW is 23:30, so age is 15 min, inside the 30 min window.
    got = serve_price(now=NOW, fetch=fetch, cache_path=cache, settings=SETTINGS)
    assert got["quality"] == "ok"
    assert got["cached"] is True


def test_outage_stale_window_is_90_min():
    posted = NOW - timedelta(minutes=OUTAGE_STALE_MIN + 1)
    assert (NOW - posted).total_seconds() / 60 > OUTAGE_STALE_MIN


def _posting(report, file_name, rows=2):
    return {
        "report": report,
        "posted_at": "2024-07-11T23:01:04-05:00",
        "event": "beryl",
        "file_name": file_name,
        "payload": [{"hourEnding": n} for n in range(rows)],
    }


def test_list_feeds_merges_postings_and_cache_quality(tmp_path):
    outage = tmp_path / "latest_np3.json"
    outage.write_text(json.dumps(OUTAGE_BODY))
    price = tmp_path / "latest_np6.json"
    rows = {
        "NP3-233-CD": _posting("NP3-233-CD", "hourly.zip.csv", 3),
        "NP3-565-CD": _posting("NP3-565-CD", None, 4),
        "NP4-732-CD": _posting("NP4-732-CD", None, 1),
    }

    def get(_event, report):
        return rows.get(report)

    catalog = list_feeds(event="beryl", now=NOW, get=get, outage_path=outage, price_path=price)
    by_report = {row["report"]: row for row in catalog["products"]}
    assert catalog["event"] == "beryl"
    assert by_report["NP3-233-CD"]["role"] == "floor"
    assert by_report["NP3-233-CD"]["file_name"] == "hourly.zip.csv"
    assert by_report["NP3-233-CD"]["row_count"] == 3
    assert by_report["NP3-233-CD"]["quality"] == "ok"
    assert by_report["NP6-905-CD"] == {
        "report": "NP6-905-CD",
        "posted_at": None,
        "row_count": None,
        "event": "beryl",
        "file_name": None,
        "quality": "unavailable",
        "role": "price",
    }
    assert by_report["NP3-565-CD"]["role"] == "history"
    assert by_report["NP3-565-CD"]["file_name"] is None
    assert by_report["NP3-565-CD"]["quality"] is None
    assert "NP4-733-CD" not in by_report
    assert [row["role"] for row in catalog["products"] if row["role"] != "history"] == ["floor", "price"]


def test_list_feeds_without_supabase_still_returns_drivers(tmp_path):
    catalog = list_feeds(event="heather", now=NOW, get=lambda _e, _r: None, outage_path=tmp_path / "missing.json", price_path=tmp_path / "gone.json")
    reports = [row["report"] for row in catalog["products"]]
    assert reports == ["NP3-233-CD", "NP6-905-CD"]
    assert all(row["quality"] == "unavailable" for row in catalog["products"])


def test_feeds_catalog_route_rejects_unknown_event():
    client = TestClient(create_app(FixtureStore()))
    reply = client.get("/v1/feeds", params={"event": "uri"})
    assert reply.status_code == 422
    assert reply.json() == {"error": "bad_event", "brief": "event must be beryl, heather, or tuning-2026."}
