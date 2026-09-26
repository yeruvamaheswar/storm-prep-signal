"""PostgREST reader for public.homes: paged console homes and zone rollups.

Missing keys or a failed GET raise HomesUnavailable so the route can fall
back to fixtures / current_rollups(). This module never raises a 500.
"""

import os
import re

import requests

from server.engine.fleet import CLUSTER_CENTROIDS, ZONE_ORDER
from server.env import load_env

HOME_SELECT = (
    "home_id,zone,capacity_kwh,soc_kwh,max_kw,status,assigned_kw,"
    "last_seen,charge_state,power_kw"
)
CHARGE_STATES = ("CHARGING", "DISCHARGING", "HOLDING", "FULL", "EMPTY")
BASE_RESERVE_PCT = 30.0
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
SEARCH_SAFE = re.compile(r"[^A-Za-z0-9_-]")


class HomesUnavailable(Exception):
    """Table read failed. `reason` holds no secrets."""

    def __init__(self, reason):
        self.reason = reason


def homes_settings():
    load_env()
    try:
        timeout_s = float(os.getenv("FETCH_TIMEOUT_S", "3"))
    except ValueError:
        timeout_s = 3.0
    return {
        "url": os.getenv("SUPABASE_URL", ""),
        "key": os.getenv("SUPABASE_SECRET_KEY", ""),
        "timeout_s": timeout_s,
    }


def page_limit(limit):
    if limit is None:
        return DEFAULT_LIMIT
    return min(MAX_LIMIT, max(1, int(limit)))


def page_offset(offset):
    if offset is None:
        return 0
    return max(0, int(offset))


def _as_int(value, default=0):
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value, default=0.0):
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def as_console_home(row):
    """Console Home JSON, add-only. `zone` is the one new field."""
    capacity = _as_float(row.get("capacity_kwh"))
    soc = _as_float(row.get("soc_kwh"))
    status = row.get("status") or "live"
    floor = capacity * BASE_RESERVE_PCT / 100
    skip = None
    if status in ("stale", "dead", "unconfirmed"):
        skip = status
    elif soc < floor:
        skip = "below_floor"
    home = {
        "home_id": row["home_id"],
        "status": status,
        "capacity_kwh": capacity,
        "soc_kwh": soc,
        "floor_kwh": floor,
        "max_kw": _as_float(row.get("max_kw")),
        "assigned_kw": _as_float(row.get("assigned_kw")),
        "eligible": skip is None,
        "skip_reason": skip,
        "last_seen": row.get("last_seen"),
        "last_command": None,
        "charge_state": row.get("charge_state") if row.get("charge_state") in CHARGE_STATES else None,
        "power_kw": None if row.get("power_kw") is None else _as_float(row.get("power_kw")),
    }
    zone = row.get("zone")
    if zone:
        home["zone"] = zone
    return home


def _homes_get(params, settings=None, http_get=None, extra_headers=None):
    """One GET public.homes. Injected getter is the I/O so CI needs no keys."""
    settings = settings or homes_settings()
    url, key = settings["url"], settings["key"]
    if not (url and key):
        if http_get is None:
            raise HomesUnavailable("no_config")
        url = url or "https://example.invalid"
        key = key or "injected"
    get = http_get or requests.get
    headers = {"apikey": key}
    if extra_headers:
        headers.update(extra_headers)
    try:
        reply = get(
            f"{url.rstrip('/')}/rest/v1/homes",
            params=params,
            headers=headers,
            timeout=settings["timeout_s"],
        )
    except requests.Timeout:
        raise HomesUnavailable("timeout") from None
    except requests.RequestException:
        raise HomesUnavailable("network") from None
    if not reply.ok:
        raise HomesUnavailable(f"HTTP {reply.status_code}")
    return reply


def fetch_home_rows(params, settings=None, http_get=None):
    """GET public.homes rows. Never uses aggregate functions."""
    reply = _homes_get(params, settings=settings, http_get=http_get)
    try:
        rows = reply.json()
    except ValueError:
        raise HomesUnavailable("malformed") from None
    if not isinstance(rows, list):
        raise HomesUnavailable("malformed")
    return rows


def _content_range_total(reply):
    raw = ""
    headers = getattr(reply, "headers", None) or {}
    for key, value in headers.items():
        if str(key).lower() == "content-range":
            raw = str(value)
            break
    if "/" not in raw:
        raise HomesUnavailable("malformed")
    tail = raw.rsplit("/", 1)[1]
    if tail == "*":
        return 0
    try:
        return max(0, int(tail))
    except ValueError:
        raise HomesUnavailable("malformed") from None


def exact_count(params, settings=None, http_get=None):
    """Row count from Prefer: count=exact. This project's PostgREST rejects count()."""
    query = dict(params)
    query["select"] = "home_id"
    query["limit"] = "1"
    reply = _homes_get(query, settings=settings, http_get=http_get, extra_headers={"Prefer": "count=exact"})
    return _content_range_total(reply)


def list_homes(zone=None, status=None, q=None, limit=None, offset=None, settings=None, http_get=None):
    params = {
        "select": HOME_SELECT,
        "order": "home_id.asc",
        "limit": str(page_limit(limit)),
        "offset": str(page_offset(offset)),
    }
    if zone:
        params["zone"] = f"eq.{zone}"
    if status:
        params["status"] = f"eq.{status}"
    needle = SEARCH_SAFE.sub("", q or "")
    if needle:
        params["home_id"] = f"ilike.*{needle}*"
    return [as_console_home(row) for row in fetch_home_rows(params, settings=settings, http_get=http_get)]


def read_home(home_id, settings=None, http_get=None):
    rows = fetch_home_rows(
        {"select": HOME_SELECT, "home_id": f"eq.{home_id}", "limit": "1"},
        settings=settings,
        http_get=http_get,
    )
    if not rows:
        return None
    return as_console_home(rows[0])


def _empty_zone_row():
    return {
        "live": 0, "reserved": 0, "discharging": 0,
        "stale": 0, "dead": 0, "silent": 0,
        "reserved_mw": 0.0, "discharging_mw": 0.0,
    }


def rollups_from_groups(count_rows, discharge_rows=None):
    zones = {name: _empty_zone_row() for name in ZONE_ORDER}
    n = 0
    for row in count_rows:
        n += _as_int(row.get("count"), 1)
        zone = zones.get(row.get("zone"))
        if zone is None:
            continue
        status = row.get("status")
        count = _as_int(row.get("count"), 1)
        if status == "live":
            zone["live"] += count
        elif status == "stale":
            zone["stale"] += count
            zone["silent"] += count
        elif status == "dead":
            zone["dead"] += count
    for row in discharge_rows or []:
        zone = zones.get(row.get("zone"))
        if zone is None:
            continue
        zone["discharging"] += _as_int(row.get("count"), 1)
        mw = row.get("sum")
        if mw is None:
            mw = row.get("assigned_kw")
        zone["discharging_mw"] += _as_float(mw) / 1000
    return {"n": n, "zones": zones, "clusters": [dict(item) for item in CLUSTER_CENTROIDS]}


def _discharging_mw(zone, settings=None, http_get=None):
    total_kw = 0.0
    offset = 0
    while True:
        rows = fetch_home_rows(
            {
                "select": "assigned_kw",
                "zone": f"eq.{zone}",
                "status": "eq.live",
                "assigned_kw": "gt.0",
                "limit": "200",
                "offset": str(offset),
            },
            settings=settings,
            http_get=http_get,
        )
        if not rows:
            break
        total_kw += sum(_as_float(item.get("assigned_kw")) for item in rows)
        if len(rows) < 200:
            break
        offset += 200
    return total_kw / 1000


def table_rollups(settings=None, http_get=None):
    """Zone counts from Content-Range. Never count() — PostgREST returns PGRST123."""
    zones = {name: _empty_zone_row() for name in ZONE_ORDER}
    n = 0
    for zone in ZONE_ORDER:
        for status in ("live", "stale", "dead"):
            count = exact_count(
                {"zone": f"eq.{zone}", "status": f"eq.{status}"},
                settings=settings,
                http_get=http_get,
            )
            n += count
            zones[zone][status] += count
            if status == "stale":
                zones[zone]["silent"] += count
        discharging = exact_count(
            {"zone": f"eq.{zone}", "status": "eq.live", "assigned_kw": "gt.0"},
            settings=settings,
            http_get=http_get,
        )
        zones[zone]["discharging"] = discharging
        if discharging:
            zones[zone]["discharging_mw"] = _discharging_mw(zone, settings=settings, http_get=http_get)
    return {"n": n, "zones": zones, "clusters": [dict(item) for item in CLUSTER_CENTROIDS]}
