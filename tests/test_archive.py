"""Archive reader: event + clock → newest NP3 payload and LZ_NORTH price. No network."""

import json
from datetime import datetime

import pytest
import requests

from server.api.archive import (
    ARCHIVE_TABLES,
    ArchiveUnavailable,
    as_outage_body,
    event_for_clock,
    read_outage,
    read_prices,
    tape_reset_tables,
)
from server.api.feeds import serve_outage, serve_price
from server.api.snapshot import archive_ingest, build_snapshot
from server.engine.risk import CATEGORIES, ZONES
from server.engine.signal import CENTRAL, read_price, to_signal

CLOCK = datetime(2024, 7, 8, 14, 55, tzinfo=CENTRAL)
SETTINGS = {"url": "https://example.supabase.co", "key": "test-key", "timeout_s": 3}


class Reply:
    def __init__(self, rows, ok=True, status_code=200):
        self._rows = rows
        self.ok = ok
        self.status_code = status_code

    def json(self):
        return self._rows


def hour(day, hour_ending, north_mw):
    row = {"operatingDate": day, "hourEnding": hour_ending}
    row.update({f"total{category}MWZone{zone}": 0.0 for category in CATEGORIES for zone in ZONES})
    row["totalResourceMWZoneNorth"] = north_mw
    return row


def posting(posted_at, hours, event="beryl"):
    return {"event": event, "report": "NP3-233-CD", "posted_at": posted_at, "payload": hours}


def price(ending, usd, point="LZ_NORTH", hour=15, interval=3, event="beryl"):
    return {
        "event": event,
        "settlement_point": point,
        "interval_ending": ending,
        "delivery_date": "2024-07-08",
        "delivery_hour": hour,
        "delivery_interval": interval,
        "price_usd_mwh": usd,
    }


def fake_get(postings, prices):
    def http_get(url, params=None, headers=None, timeout=None):
        assert "apikey" in (headers or {})
        params = params or {}
        if url.endswith("/ercot_postings"):
            rows = list(postings)
            if params.get("event", "").startswith("eq."):
                rows = [row for row in rows if row["event"] == params["event"][3:]]
            if params.get("posted_at", "").startswith("lte."):
                limit = params["posted_at"][4:]
                rows = [row for row in rows if row["posted_at"] <= limit]
            rows = sorted(rows, key=lambda row: row["posted_at"], reverse=True)
            if params.get("limit"):
                rows = rows[: int(params["limit"])]
            return Reply(rows)
        if url.endswith("/ercot_prices"):
            rows = list(prices)
            if params.get("event", "").startswith("eq."):
                rows = [row for row in rows if row["event"] == params["event"][3:]]
            if params.get("settlement_point", "").startswith("eq."):
                rows = [row for row in rows if row["settlement_point"] == params["settlement_point"][3:]]
            if params.get("settlement_point", "").startswith("in.("):
                wanted = params["settlement_point"][4:-1].split(",")
                rows = [row for row in rows if row["settlement_point"] in wanted]
            if params.get("interval_ending", "").startswith("lte."):
                limit = params["interval_ending"][4:]
                rows = [row for row in rows if row["interval_ending"] <= limit]
            if params.get("interval_ending", "").startswith("eq."):
                rows = [row for row in rows if row["interval_ending"] == params["interval_ending"][3:]]
            rows = sorted(rows, key=lambda row: row["interval_ending"], reverse=True)
            if params.get("limit"):
                rows = rows[: int(params["limit"])]
            return Reply(rows)
        raise AssertionError(f"unexpected url {url}")

    return http_get


def test_event_windows_cover_loaded_rows():
    assert event_for_clock(CLOCK) == "beryl"
    assert event_for_clock(datetime(2024, 1, 14, 12, tzinfo=CENTRAL)) == "heather"
    assert event_for_clock(datetime(2026, 9, 1, 12, tzinfo=CENTRAL)) == "tuning-2026"
    assert event_for_clock(datetime(2025, 1, 1, tzinfo=CENTRAL)) is None


def test_tape_reset_never_touches_archive_tables():
    assert tape_reset_tables().isdisjoint(ARCHIVE_TABLES)
    assert ARCHIVE_TABLES == frozenset({"ercot_postings", "ercot_prices"})


def test_newest_posting_at_or_before_clock():
    later = posting("2024-07-08T15:00:00-05:00", [hour("2024-07-08", 16, 9)])
    earlier = posting("2024-07-08T14:50:00-05:00", [hour("2024-07-08", 15, 8)])
    older = posting("2024-07-08T14:00:00-05:00", [hour("2024-07-08", 14, 7)])

    got = read_outage("beryl", CLOCK, http_get=fake_get([later, earlier, older], []), settings=SETTINGS)

    assert got["posted_at"].isoformat() == "2024-07-08T14:50:00-05:00"
    signal = to_signal(got["body"], CLOCK)
    assert signal["rows"][0]["totalResourceMWZoneNorth"] == 8


def test_newest_lz_north_at_or_before_clock_keeps_other_lzs():
    later = price("2024-07-08T15:00:00-05:00", 99.0)
    north = price("2024-07-08T14:45:00-05:00", 42.25)
    houston = price("2024-07-08T14:45:00-05:00", 20.0, point="LZ_HOUSTON")
    older = price("2024-07-08T14:30:00-05:00", 10.0)

    got = read_prices(
        "beryl",
        CLOCK,
        settlement_points=("LZ_NORTH", "LZ_HOUSTON"),
        http_get=fake_get([], [later, north, houston, older]),
        settings=SETTINGS,
    )

    parsed = read_price(got["body"], CLOCK)
    assert parsed["usd_mwh"] == 42.25
    points = {row["settlement_point"] for row in got["rows"]}
    assert points == {"LZ_NORTH", "LZ_HOUSTON"}


def test_outage_body_puts_posted_datetime_back_on_payload():
    body = as_outage_body("2024-07-08T14:50:00-05:00", [hour("2024-07-08", 15, 1)])
    names = [field["name"] for field in body["fields"]]
    assert "postedDatetime" in names
    assert "2024-07-08T14:50:00" in body["data"][0]


def test_missing_config_is_unavailable(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    with pytest.raises(ArchiveUnavailable) as exc:
        read_outage("beryl", CLOCK, settings={"url": "", "key": "", "timeout_s": 3})

    assert exc.value.quality == "unavailable"


def test_timeout_is_named():
    def boom(*_args, **_kwargs):
        raise requests.Timeout()

    with pytest.raises(ArchiveUnavailable) as exc:
        read_outage("beryl", CLOCK, http_get=boom, settings=SETTINGS)

    assert exc.value.quality == "timeout"


def test_serve_archive_skips_live_fetch():
    def refuse(*_args, **_kwargs):
        raise AssertionError("live ERCOT must not run in archive mode")

    hours = [hour("2024-07-08", 15 + lead, 1000) for lead in range(6)]
    get = fake_get([posting("2024-07-08T14:50:00-05:00", hours)], [price("2024-07-08T14:45:00-05:00", 42.25)])

    outage = serve_outage(source="archive", event="beryl", clock=CLOCK, archive_get=get, fetch=refuse)
    priced = serve_price(source="archive", event="beryl", clock=CLOCK, archive_get=get, fetch=refuse)

    assert outage["quality"] == "ok"
    assert outage["cached"] is True
    assert priced["body"]["data"][0][-1] == 42.25


def test_archive_ingest_rates_outage_and_stamps_price(tmp_path, monkeypatch):
    hours = [hour("2024-07-08", 15 + lead, 1000) for lead in range(6)]
    get = fake_get(
        [posting("2024-07-08T14:50:00-05:00", hours)],
        [price("2024-07-08T14:45:00-05:00", 42.25)],
    )
    latest = tmp_path / "latest.json"
    latest.write_text(
        json.dumps({
            "run_id": "layout-fixture",
            "ticks": [{
                "tick": 12,
                "ts": "2024-07-08T14:55:00-05:00",
                "mode": "AUTO",
                "target_mw": 0.2,
                "target_label": "synthetic",
                "delivered_mw": 0.2,
                "missed_mw": 0.0,
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
                "brief": "tape brief",
            }],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)

    tick = build_snapshot(
        now=CLOCK,
        ingest=lambda now: archive_ingest(now, event="beryl", http_get=get, settings=SETTINGS),
    )

    assert tick["price_usd_mwh"] == 42.25
    assert tick["price_label"] == "ercot"
    assert tick["clock_pinned"] is True
    assert tick["outage_mw"] is not None
    assert tick["quality"] == "ok"


def test_archive_ingest_missing_price_does_not_hold(tmp_path, monkeypatch):
    hours = [hour("2024-07-08", 15 + lead, 1000) for lead in range(6)]
    get = fake_get([posting("2024-07-08T14:50:00-05:00", hours)], [])
    latest = tmp_path / "latest.json"
    latest.write_text(
        json.dumps({
            "run_id": "layout-fixture",
            "ticks": [{
                "tick": 1,
                "ts": "2024-07-08T14:55:00-05:00",
                "mode": "AUTO",
                "target_mw": 0.2,
                "target_label": "synthetic",
                "delivered_mw": 0.2,
                "missed_mw": 0.0,
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
                "brief": "tape brief",
            }],
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr("server.api.snapshot.LATEST_RUN", latest)

    tick = build_snapshot(
        now=CLOCK,
        ingest=lambda now: archive_ingest(now, event="beryl", http_get=get, settings=SETTINGS),
    )

    assert tick["price_usd_mwh"] is None
    assert tick["price_label"] == "none"
    assert tick["quality"] == "ok"
    assert tick["policy_reason"] != "signal_unavailable"
