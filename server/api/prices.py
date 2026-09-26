"""Bind NP6-905-CD prices to the four load zones.

PK on public.ercot_prices is (settlement_point, interval_ending). Live GET stays
LZ_NORTH. Archive (or a multi-LZ body) can fill the other three. Ignore
LZ_AEN|CPS|LCRA|RAYBN. Label ercot only when the number came from a row.
"""

import os
from datetime import datetime

import requests

from server.env import load_env
from server.engine.signal import CENTRAL, price_interval_end, rows_by_name

LOAD_ZONE_POINTS = {
    "Houston": "LZ_HOUSTON",
    "North": "LZ_NORTH",
    "South": "LZ_SOUTH",
    "West": "LZ_WEST",
}
IGNORE_POINTS = {"LZ_AEN", "LZ_CPS", "LZ_LCRA", "LZ_RAYBN"}
POINT_TO_ZONE = {point: zone for zone, point in LOAD_ZONE_POINTS.items()}
ARCHIVE_TIMEOUT_S = 3


def _usd(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _ending_key(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        posted = value
    else:
        try:
            posted = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return str(value)
    if posted.tzinfo is None:
        posted = posted.replace(tzinfo=CENTRAL)
    return posted.astimezone(CENTRAL).isoformat(timespec="seconds")


def bind_zone_prices(rows, interval_ending=None):
    """Zone name -> price_usd_mwh for one interval. Missing zone means no row."""
    wanted = _ending_key(interval_ending)
    kept = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        point = row.get("settlement_point")
        if point in IGNORE_POINTS or point not in POINT_TO_ZONE:
            continue
        ending = _ending_key(row.get("interval_ending"))
        usd = _usd(row.get("price_usd_mwh"))
        if ending is None or usd is None:
            continue
        kept.append((POINT_TO_ZONE[point], ending, usd))
    if wanted is None and kept:
        wanted = max(ending for _zone, ending, _usd in kept)
    bound = {}
    for zone, ending, usd in kept:
        if ending == wanted:
            bound[zone] = usd
    return bound


def price_for_zone(bound, zone):
    usd = bound.get(zone) if isinstance(bound, dict) else None
    return usd if isinstance(usd, float) else None


def price_label_for(bound, zone):
    return "ercot" if price_for_zone(bound, zone) is not None else "none"


def rows_from_np6(raw):
    """NP6 body rows as ercot_prices-shaped dicts. Skips ignored settlement points."""
    if not isinstance(raw, dict):
        return []
    try:
        parsed = rows_by_name(raw)
    except (KeyError, TypeError):
        return []
    rows = []
    for row in parsed:
        point = row.get("settlementPoint")
        if point in IGNORE_POINTS or point not in POINT_TO_ZONE:
            continue
        try:
            ending = price_interval_end(
                row["deliveryDate"], row["deliveryHour"], row["deliveryInterval"],
            ).isoformat(timespec="seconds")
            usd = float(row["settlementPointPrice"])
        except (KeyError, TypeError, ValueError):
            continue
        rows.append({
            "settlement_point": point,
            "interval_ending": ending,
            "price_usd_mwh": usd,
        })
    return rows


def fetch_archive_prices(interval_ending, get=requests.get):
    """Rows for the four load zones at one interval. Empty when Supabase is unset or fails."""
    if not interval_ending:
        return []
    load_env()
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    if not (url and key):
        return []
    points = ",".join(LOAD_ZONE_POINTS.values())
    try:
        reply = get(
            f"{url.rstrip('/')}/rest/v1/ercot_prices",
            params={
                "select": "settlement_point,interval_ending,price_usd_mwh",
                "interval_ending": f"eq.{interval_ending}",
                "settlement_point": f"in.({points})",
            },
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=ARCHIVE_TIMEOUT_S,
        )
        if not reply.ok:
            return []
        rows = reply.json()
    except (requests.RequestException, ValueError, TypeError):
        return []
    return rows if isinstance(rows, list) else []
