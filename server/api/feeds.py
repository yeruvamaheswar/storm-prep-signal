"""ERCOT feed proxy. Username, password, subscription key, and the B2C token stay here."""

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path

from server.api.archive import (
    EVENT_WINDOWS,
    ArchiveUnavailable,
    archive_outage_feed,
    archive_price_feed,
    fetch_rows,
)
from server.env import load_env
from server.engine.signal import (
    CENTRAL,
    LIVE_PATH,
    PRICE_PATH,
    PRICE_STALE_MIN,
    SignalUnavailable,
    fetch_outages,
    fetch_price,
    parse_central,
    reject_stale,
    rows_by_name,
)

# Same windows the wall used when it called ERCOT itself.
OUTAGE_STALE_MIN = 90
# Same report keys as scripts/load_ercot_reports.POSTED. NP6-905-CD lives in ercot_prices.
FEED_EVENTS = tuple(EVENT_WINDOWS)
POSTED_REPORTS = (
    "NP3-233-CD",
    "NP3-565-CD",
    "NP4-732-CD",
    "NP4-733-CD",
    "NP4-737-CD",
    "NP4-738-CD",
)
FLOOR_REPORT = "NP3-233-CD"
PRICE_REPORT = "NP6-905-CD"


def fetch_settings():
    # Shared loader; the wall must never see these names.
    load_env()
    return {"fetch_timeout_s": float(os.getenv("FETCH_TIMEOUT_S", "3"))}


def http_status_from_reason(reason):
    """Last HTTP code from a secret-free SignalUnavailable line, or None."""
    match = re.search(r"HTTP (\d+)", reason)
    return int(match.group(1)) if match else None


def quality_from_reason(reason):
    """Map a secret-free SignalUnavailable line to the wall's quality codes."""
    if "credentials missing" in reason:
        return "auth"
    code = http_status_from_reason(reason)
    if code in (401, 403):
        return "auth"
    if code == 429 or (code is not None and code >= 500):
        return "unavailable"
    if "did not answer" in reason:
        return "timeout"
    if "not the expected JSON" in reason:
        return "malformed"
    if "min old" in reason:
        return "stale"
    return "unavailable"


def payload(quality, body, cached, http_status=None):
    return {"quality": quality, "cached": cached, "body": body, "http_status": http_status}


def read_cache(path):
    path = Path(path)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except ValueError:
        return None


def write_cache(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.is_file():
        path.write_text(json.dumps(raw))


def newest_price_time(raw):
    """Hour ending N, interval K ends at (N-1):00 plus K quarter hours, Central."""
    newest = None
    for row in rows_by_name(raw):
        try:
            end = parse_central(row["deliveryDate"]) + timedelta(
                hours=int(row["deliveryHour"]) - 1,
                minutes=int(row["deliveryInterval"]) * 15,
            )
        except (KeyError, TypeError, ValueError):
            raise SignalUnavailable("ERCOT reply was not the expected JSON") from None
        if newest is None or end > newest:
            newest = end
    return newest


def reject_stale_price(raw, now, limit_min):
    posted = newest_price_time(raw)
    if posted is None or now - posted > timedelta(minutes=limit_min):
        age_min = 0 if posted is None else int((now - posted).total_seconds() // 60)
        raise SignalUnavailable(f"data is {age_min} min old (limit {limit_min})")


def _from_cache(path, quality, stale_check, http_status=None):
    raw = read_cache(path)
    if raw is None:
        return payload(quality, None, False, http_status)
    # A rejected login is not a good read, even if yesterday's file is still on disk.
    if quality == "auth":
        return payload("auth", raw, True, http_status)
    try:
        stale_check(raw)
    except SignalUnavailable:
        return payload("stale", raw, True, http_status)
    # 429 / 5xx / timeout: last good body inside the window is still usable.
    return payload("ok", raw, True, http_status)


def serve_outage(
    now=None,
    fetch=fetch_outages,
    cache_path=LIVE_PATH,
    settings=None,
    source="live",
    event=None,
    clock=None,
    archive_get=None,
):
    if source != "live":
        return archive_outage_feed(event, clock or now, http_get=archive_get)
    settings = settings or fetch_settings()
    now = now or datetime.now(CENTRAL)

    def stale_check(raw):
        reject_stale(raw, now, OUTAGE_STALE_MIN)

    try:
        raw = fetch(settings, now, save_to=cache_path)
        write_cache(cache_path, raw)
        try:
            stale_check(raw)
        except SignalUnavailable:
            return payload("stale", raw, False, 200)
        return payload("ok", raw, False, 200)
    except SignalUnavailable as exc:
        reason = str(exc)
        return _from_cache(cache_path, quality_from_reason(reason), stale_check, http_status_from_reason(reason))


def serve_price(
    now=None,
    fetch=fetch_price,
    cache_path=PRICE_PATH,
    settings=None,
    source="live",
    event=None,
    clock=None,
    archive_get=None,
    settlement_points=None,
):
    if source != "live":
        return archive_price_feed(
            event, clock or now, settlement_points=settlement_points, http_get=archive_get
        )
    settings = settings or fetch_settings()
    now = now or datetime.now(CENTRAL)

    def stale_check(raw):
        reject_stale_price(raw, now, PRICE_STALE_MIN)

    try:
        raw = fetch(settings, now, save_to=cache_path)
        write_cache(cache_path, raw)
        try:
            stale_check(raw)
        except SignalUnavailable:
            return payload("stale", raw, False, 200)
        return payload("ok", raw, False, 200)
    except SignalUnavailable as exc:
        reason = str(exc)
        return _from_cache(cache_path, quality_from_reason(reason), stale_check, http_status_from_reason(reason))


def cache_quality(path, stale_check):
    """Quality from a var/signal/ file. Missing or unreadable is unavailable. Does not call ERCOT."""
    raw = read_cache(path)
    if raw is None:
        return "unavailable"
    try:
        stale_check(raw)
    except SignalUnavailable as exc:
        return quality_from_reason(str(exc))
    return "ok"


def fetch_latest_posting(event, report, http_get=None, settings=None):
    """Newest ercot_postings row for one report in this event, or None."""
    try:
        rows = fetch_rows(
            "ercot_postings",
            {
                "select": "report,posted_at,event,file_name,payload",
                "event": f"eq.{event}",
                "report": f"eq.{report}",
                "order": "posted_at.desc",
                "limit": "1",
            },
            settings=settings,
            http_get=http_get,
        )
    except ArchiveUnavailable:
        return None
    return rows[0] if rows else None


def latest_postings(event, get=None, http_get=None, settings=None):
    """Latest posting per loaded report. Empty when Supabase is missing or every read fails."""
    fetch = get or (lambda event_name, report: fetch_latest_posting(event_name, report, http_get, settings))
    found = {}
    for report in POSTED_REPORTS:
        row = fetch(event, report)
        if row is not None:
            found[report] = row
    return found


def product_row(report, event, posting, quality, role):
    posting = posting or {}
    payload_rows = posting.get("payload")
    return {
        "report": report,
        "posted_at": posting.get("posted_at"),
        "row_count": len(payload_rows) if isinstance(payload_rows, list) else None,
        "event": posting.get("event") or event,
        "file_name": posting.get("file_name"),
        "quality": quality,
        "role": role,
    }


def list_feeds(event="beryl", now=None, get=None, http_get=None, outage_path=LIVE_PATH, price_path=PRICE_PATH):
    """Catalog for the Feeds panel. History from ercot_postings; live quality from var/signal/."""
    now = now or datetime.now(CENTRAL)

    def outage_stale(raw):
        reject_stale(raw, now, OUTAGE_STALE_MIN)

    def price_stale(raw):
        reject_stale_price(raw, now, PRICE_STALE_MIN)

    found = latest_postings(event, get=get, http_get=http_get)
    products = [
        product_row(FLOOR_REPORT, event, found.get(FLOOR_REPORT), cache_quality(outage_path, outage_stale), "floor"),
        product_row(PRICE_REPORT, event, None, cache_quality(price_path, price_stale), "price"),
    ]
    for report in POSTED_REPORTS:
        if report == FLOOR_REPORT or report not in found:
            continue
        products.append(product_row(report, event, found[report], None, "history"))
    return {"event": event, "products": products}
