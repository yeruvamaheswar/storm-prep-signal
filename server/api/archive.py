"""Archived NP3-233-CD and NP6-905-CD rows for Demo/Synthetic.

Given an event and a clock, pick the newest posting `payload` and the four
load-zone price rows whose `posted_at` / `interval_ending` are at or before
that clock. Live fetch stays LZ_NORTH. Archive is multi-LZ.
Live keeps `server.engine.signal`. These two tables are durable: a tape reset
must never truncate them.

Upsert keys from `scripts/load_ercot_reports.py`:
  ercot_postings → (report, posted_at)
  ercot_prices   → (settlement_point, interval_ending)
`postedDatetime` is the `posted_at` column, not repeated inside `payload`.
"""

import os
from datetime import date, datetime

import requests

from server.api.prices import LOAD_ZONE_POINTS
from server.engine.signal import CENTRAL
from server.env import load_env

OUTAGE_REPORT = "NP3-233-CD"
PRICE_REPORT = "NP6-905-CD"
DEFAULT_LZ = "LZ_NORTH"
ARCHIVE_TABLES = frozenset({"ercot_postings", "ercot_prices"})
# Storm weeks include the 30-day baseline window that `check_margin.py` reads.
EVENT_WINDOWS = {
    "heather": (date(2023, 12, 13), date(2024, 1, 17)),
    "beryl": (date(2024, 6, 5), date(2024, 7, 11)),
    "tuning-2026": (date(2026, 8, 25), date(2026, 9, 25)),
}


class ArchiveUnavailable(Exception):
    """Archive read failed. `quality` is the wall code; `reason` holds no secrets."""

    def __init__(self, quality, reason=""):
        self.quality = quality
        self.reason = reason


def tape_reset_tables():
    """Tables a tape reset may clear. Archive history is not among them."""
    return frozenset()


def archive_settings():
    load_env()
    return {
        "url": os.getenv("SUPABASE_URL", ""),
        "key": os.getenv("SUPABASE_SECRET_KEY", ""),
        "timeout_s": float(os.getenv("FETCH_TIMEOUT_S", "3")),
    }


def as_central(value):
    if isinstance(value, datetime):
        posted = value
    else:
        posted = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if posted.tzinfo is None:
        return posted.replace(tzinfo=CENTRAL)
    return posted.astimezone(CENTRAL)


def posted_text(posted):
    """Naive Central stamp, the same shape the live ERCOT body uses."""
    return as_central(posted).strftime("%Y-%m-%dT%H:%M:%S")


def event_for_clock(clock):
    """Event folder whose loaded window covers this Central date, or None."""
    day = as_central(clock).date()
    for name, (first, last) in EVENT_WINDOWS.items():
        if first <= day <= last:
            return name
    return None


def as_ercot_body(rows):
    if not rows:
        return {"fields": [], "data": []}
    names = list(rows[0].keys())
    return {
        "fields": [{"name": name} for name in names],
        "data": [[row.get(name) for name in names] for row in rows],
    }


def as_outage_body(posted_at, payload):
    if not isinstance(payload, list) or not payload:
        raise ArchiveUnavailable("malformed", "empty payload")
    stamp = posted_text(posted_at)
    return as_ercot_body([{"postedDatetime": stamp, **hour} for hour in payload])


def as_price_body(price_rows):
    return as_ercot_body(
        [
            {
                "deliveryDate": row["delivery_date"],
                "deliveryHour": row["delivery_hour"],
                "deliveryInterval": row["delivery_interval"],
                "settlementPoint": row["settlement_point"],
                "settlementPointPrice": row["price_usd_mwh"],
            }
            for row in price_rows
        ]
    )


def fetch_rows(table, params, settings=None, http_get=None):
    """GET only. Never DELETE or truncate; archive tables survive a tape reset."""
    if table not in ARCHIVE_TABLES:
        raise ArchiveUnavailable("unavailable", "unknown table")
    settings = settings or archive_settings()
    url, key = settings["url"], settings["key"]
    if not (url and key):
        raise ArchiveUnavailable("unavailable", "no_config")
    get = http_get or requests.get
    try:
        reply = get(
            f"{url.rstrip('/')}/rest/v1/{table}",
            params=params,
            headers={"apikey": key},
            timeout=settings["timeout_s"],
        )
    except requests.Timeout:
        raise ArchiveUnavailable("timeout", "no answer") from None
    except requests.RequestException:
        raise ArchiveUnavailable("unavailable", "network") from None
    if not reply.ok:
        raise ArchiveUnavailable("unavailable", f"HTTP {reply.status_code}")
    try:
        rows = reply.json()
    except ValueError:
        raise ArchiveUnavailable("malformed", "not JSON") from None
    if not isinstance(rows, list):
        raise ArchiveUnavailable("malformed", "not a list")
    return rows


def read_outage(event, clock, http_get=None, settings=None):
    """Newest NP3-233-CD payload for this event with posted_at at or before clock."""
    if not event:
        raise ArchiveUnavailable("unavailable", "no event")
    rows = fetch_rows(
        "ercot_postings",
        {
            "select": "posted_at,payload",
            "event": f"eq.{event}",
            "report": f"eq.{OUTAGE_REPORT}",
            "posted_at": f"lte.{as_central(clock).isoformat()}",
            "order": "posted_at.desc",
            "limit": "1",
        },
        settings=settings,
        http_get=http_get,
    )
    if not rows:
        raise ArchiveUnavailable("unavailable", "no posting")
    row = rows[0]
    try:
        body = as_outage_body(row["posted_at"], row["payload"])
    except (KeyError, TypeError) as exc:
        raise ArchiveUnavailable("malformed", "posting row") from exc
    return {"body": body, "posted_at": as_central(row["posted_at"])}


def read_prices(event, clock, settlement_points=None, http_get=None, settings=None):
    """Newest NP6-905-CD LZ_NORTH row at or before clock; the other three LZs at that interval."""
    points = tuple(settlement_points or LOAD_ZONE_POINTS.values())
    if DEFAULT_LZ not in points:
        points = (DEFAULT_LZ, *points)
    if not event:
        raise ArchiveUnavailable("unavailable", "no event")
    north = fetch_rows(
        "ercot_prices",
        {
            "select": (
                "settlement_point,interval_ending,delivery_date,"
                "delivery_hour,delivery_interval,price_usd_mwh"
            ),
            "event": f"eq.{event}",
            "settlement_point": f"eq.{DEFAULT_LZ}",
            "interval_ending": f"lte.{as_central(clock).isoformat()}",
            "order": "interval_ending.desc",
            "limit": "1",
        },
        settings=settings,
        http_get=http_get,
    )
    if not north:
        raise ArchiveUnavailable("unavailable", "no LZ_NORTH")
    ending = north[0]["interval_ending"]
    extra = [point for point in points if point != DEFAULT_LZ]
    others = []
    if extra:
        others = fetch_rows(
            "ercot_prices",
            {
                "select": (
                    "settlement_point,interval_ending,delivery_date,"
                    "delivery_hour,delivery_interval,price_usd_mwh"
                ),
                "event": f"eq.{event}",
                "settlement_point": f"in.({','.join(extra)})",
                "interval_ending": f"eq.{ending}",
            },
            settings=settings,
            http_get=http_get,
        )
    rows = north + others
    return {"body": as_price_body(rows), "interval_ending": as_central(ending), "rows": rows}


def archive_outage_feed(event, clock, http_get=None, settings=None):
    try:
        got = read_outage(event, clock, http_get=http_get, settings=settings)
    except ArchiveUnavailable as exc:
        return {"quality": exc.quality, "cached": False, "body": None, "http_status": None}
    return {"quality": "ok", "cached": True, "body": got["body"], "http_status": None}


def archive_price_feed(event, clock, settlement_points=None, http_get=None, settings=None):
    try:
        got = read_prices(
            event, clock, settlement_points=settlement_points, http_get=http_get, settings=settings
        )
    except ArchiveUnavailable as exc:
        return {"quality": exc.quality, "cached": False, "body": None, "http_status": None}
    return {"quality": "ok", "cached": True, "body": got["body"], "http_status": None}
