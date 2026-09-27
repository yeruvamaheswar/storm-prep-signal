"""PostgREST reader for public.homes: paged console homes and zone rollups.

Missing keys or a failed GET raise HomesUnavailable so the route can fall
back to fixtures / current_rollups(). This module never raises a 500.
"""

import os
import re
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace

import requests
from dotenv import dotenv_values

from server.engine.fleet import (
    CLUSTER_CENTROIDS, ZONE_ORDER, county_name, fleet_counties, home_label, new_fleet, seed_settings,
)
from server.engine.loop import with_fleet_defaults
from server.env import load_env

HOME_SELECT = (
    "home_id,zone,capacity_kwh,soc_kwh,max_kw,status,assigned_kw,"
    "last_seen,charge_state,power_kw"
)
CHARGE_STATES = ("CHARGING", "DISCHARGING", "HOLDING", "FULL", "EMPTY")
COMMAND_ACKS = ("ok", "timeout")
BASE_RESERVE_PCT = 30.0
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
HISTORY_DEFAULT_LIMIT = 48
HISTORY_MAX_LIMIT = 200
READING_SELECT = "tick,seen_at,soc_kwh,charge_state,power_kw"
COMMAND_SELECT = "command_id,tick,kw,actual_kw,ack,sent_at"
SEARCH_SAFE = re.compile(r"[^A-Za-z0-9_-]")
# Task 13: public.homes may hold the 10k seed. The API reads only the demo fleet's ids.
# Above this many ids the in-list would make the URL too long, so no id filter is sent.
FLEET_FILTER_MAX_IDS = 1000


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


def fleet_size_setting():
    """FLEET_SIZE (default 100): the one demo fleet Replay, Live and Fleet all show."""
    load_env()
    try:
        return max(0, int(os.getenv("FLEET_SIZE", "100")))
    except ValueError:
        return 100


def _fleet_n(fleet_size):
    return fleet_size_setting() if fleet_size is None else max(0, int(fleet_size))


def fleet_ids(fleet_size=None):
    """The fleet's ids in engine order (new_fleet), so home-1000 never counts as one of the first 100."""
    return [home.home_id for home in new_fleet(_fleet_n(fleet_size))]


def fleet_scoped(fleet_size=None):
    """True when table reads can be limited to the fleet's ids. Above FLEET_FILTER_MAX_IDS they
    cannot, so a table read is the whole table and must not be labelled as the fleet."""
    return _fleet_n(fleet_size) <= FLEET_FILTER_MAX_IDS


def fleet_filter(fleet_size=None):
    """PostgREST `and=(home_id.in.(...))` for the fleet. Its own key, so `home_id` stays free for eq/ilike."""
    n = _fleet_n(fleet_size)
    if not fleet_scoped(n):
        return {}
    return {"and": f"(home_id.in.({','.join(fleet_ids(n))}))"}


@lru_cache(maxsize=4)
def _fleet_id_set(n):
    return frozenset(fleet_ids(n))


def in_fleet(home_id, fleet_size=None):
    """Checked here against the fleet's ids at any size: no URL is built, so the id cap does not apply."""
    return home_id in _fleet_id_set(_fleet_n(fleet_size))


ENGINE_DIR = Path(os.path.abspath(__file__)).parents[1] / "engine"


def engine_dotenv_path():
    """The .env file the engine's read_settings() loads. It calls load_dotenv() with no path from
    server/engine/cli.py, so python-dotenv walks up from server/engine and takes the first .env it finds
    (server/.env if there is one, else the repo root's). None when there is none."""
    for folder in (ENGINE_DIR, *ENGINE_DIR.parents):
        candidate = folder / ".env"
        if candidate.is_file():
            return candidate
    return None


def engine_zones():
    """ZONES exactly as the engine reads it (server/engine/cli.py read_settings, `Zone:FIPS,...`): the
    process env first, then the engine's .env (engine_dotenv_path), else the engine's default order
    (loop._FLEET_DEFAULTS, Houston first). The Live worker and the scenario session (Replay) both seed
    their fleet from it. The .env is read with dotenv_values, never loaded into os.environ, because
    read_settings()' load_dotenv() would pull the repo-root .env (Supabase keys) into the API process."""
    raw = os.environ.get("ZONES")
    if raw is None:
        path = engine_dotenv_path()
        raw = dotenv_values(path).get("ZONES") if path else None
    raw = (raw or "").strip()
    try:
        if raw:
            return dict(pair.split(":", 1) for pair in raw.split(","))
    except ValueError:
        pass  # A malformed ZONES stops the engine too; the API keeps the default order, never a 500.
    return with_fleet_defaults({})["zones"]


@lru_cache(maxsize=8)
def _engine_homes(n, zones):
    settings = {**seed_settings(n), "zones": dict(zones)}
    return {home_id: {"zone": zone, "county": fips, "county_name": county_name(fips),
                      "name": home_label(SimpleNamespace(home_id=home_id, zone=zone, county=fips))}
            for home_id, (zone, fips) in fleet_counties(settings).items()}


def engine_homes(fleet_size=None):
    """Task 17: {home_id: {zone, county, county_name, name}} for every fleet home as the engine assigns them
    (assign_zone and assign_county over the ZONES order, as scenario.seed_fleet and loop.run seed the fleet),
    so Fleet shows each home in the same zone, county and name as Replay and Live. public.homes keeps the
    seed's own zone column; only the reported values change. Any fleet size (fix round 1): the labels
    need no URL, only the id filter and the rollups stop at FLEET_FILTER_MAX_IDS."""
    return _engine_homes(_fleet_n(fleet_size), tuple(engine_zones().items()))


def engine_zone_filter(zone, fleet_size=None):
    """`and=(home_id.in.(...))` for the fleet homes the engine puts in `zone`. Replaces `zone=eq.`, which
    would filter on the seed's zone column. None above FLEET_FILTER_MAX_IDS (the URL would be too long),
    where the table's zone column is the only filter there is."""
    if not fleet_scoped(fleet_size):
        return None
    ids = [home_id for home_id, who in engine_homes(fleet_size).items() if who["zone"] == zone]
    return {"and": f"(home_id.in.({','.join(ids)}))"}


def as_fleet_home(row, fleet_size=None, reserve_pct=None, zone_reserve_pct=None):
    """Console home with the engine's zone, county and name for a fleet id. The zone is set before the
    floor is read, so a zone override applies to the zone the engine planned the home in. A row outside
    the fleet (only possible above FLEET_FILTER_MAX_IDS, when no id filter is sent) keeps the table's zone
    and gets a null county and no name, never the seed order's guess."""
    who = engine_homes(fleet_size).get(row.get("home_id"))
    if who is None:
        home = as_console_home(row, reserve_pct=reserve_pct, zone_reserve_pct=zone_reserve_pct)
        home["county"], home["county_name"] = None, None
        return home
    home = as_console_home({**row, "zone": who["zone"]}, reserve_pct=reserve_pct, zone_reserve_pct=zone_reserve_pct)
    home["county"], home["county_name"], home["name"] = who["county"], who["county_name"], who["name"]
    return home


def page_limit(limit):
    if limit is None:
        return DEFAULT_LIMIT
    return min(MAX_LIMIT, max(1, int(limit)))


def history_limit(limit):
    # History never returns 10k rows: default 48, max 200, oldest first.
    if limit is None:
        return HISTORY_DEFAULT_LIMIT
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return HISTORY_DEFAULT_LIMIT
    return min(HISTORY_MAX_LIMIT, max(1, value))


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


def _as_tick(value):
    # Tick may be null in the history tables; keep it null, never 0-by-default.
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def as_reading(row):
    # One home_readings row in the history shape. Missing state stays null,
    # never a synthetic HOLDING row.
    charge = row.get("charge_state")
    return {
        "tick": _as_tick(row.get("tick")),
        "seen_at": row.get("seen_at"),
        "soc_kwh": _as_float(row.get("soc_kwh")),
        "charge_state": charge if charge in CHARGE_STATES else None,
        "power_kw": None if row.get("power_kw") is None else _as_float(row.get("power_kw")),
    }


def as_command(row):
    # One home_commands row in the history shape. Ack is ok/timeout only.
    ack = row.get("ack")
    if ack not in COMMAND_ACKS:
        ack = None
    actual = row.get("actual_kw")
    return {
        "command_id": row.get("command_id"),
        "tick": _as_tick(row.get("tick")),
        "kw": _as_float(row.get("kw")),
        "actual_kw": None if actual is None else _as_float(actual),
        "ack": ack,
        "sent_at": row.get("sent_at"),
    }


def as_last_command(row):
    # Newest command collapsed to the HomeCommand shape web/src/domain/types.ts reads.
    ack = row.get("ack")
    if ack not in COMMAND_ACKS:
        ack = None
    return {
        "kw": _as_float(row.get("kw")),
        "sent_at": row.get("sent_at"),
        "ack": ack,
    }


def _floor_pct_for_zone(zone, reserve_pct=None, zone_reserve_pct=None):
    # Snapshot/policy floor wins; a zone override wins for its own zone.
    # None means no snapshot was available, so fall back to BASE_RESERVE_PCT.
    if isinstance(zone_reserve_pct, dict) and zone in zone_reserve_pct:
        try:
            return float(zone_reserve_pct[zone])
        except (TypeError, ValueError):
            pass
    if reserve_pct is not None:
        try:
            return float(reserve_pct)
        except (TypeError, ValueError):
            pass
    return BASE_RESERVE_PCT


def as_console_home(row, reserve_pct=None, zone_reserve_pct=None):
    """Console Home JSON, add-only. `zone` is the one new field.

    Floor comes from the snapshot/policy reserve_pct, with a per-zone
    override when zone_reserve_pct names this home's zone. BASE_RESERVE_PCT
    is only the fallback when no snapshot is available. SOC is copied from
    the row as-is: the row already carries the emit upsert's soc_kwh next to
    assigned_kw (see scripts/stream_telemetry.py rows_for_homes), so this
    function never invents a charge number.
    """
    capacity = _as_float(row.get("capacity_kwh"))
    soc = _as_float(row.get("soc_kwh"))
    status = row.get("status") or "live"
    pct = _floor_pct_for_zone(row.get("zone"), reserve_pct, zone_reserve_pct)
    floor = capacity * pct / 100
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
    _hold_below_floor(home)
    return home


def _hold_below_floor(home):
    """A stored DISCHARGING label on a home under the floor is stale.

    The engine clamp does not count that home as a breach, so the table must
    not keep the discharge. Charge (power below 0) is left as stored.
    """
    if home["soc_kwh"] >= home["floor_kwh"]:
        return
    power = home["power_kw"]
    discharging = home["charge_state"] == "DISCHARGING" or (power is not None and power > 0)
    if discharging:
        home["charge_state"] = "HOLDING"
        home["assigned_kw"] = 0.0
        home["power_kw"] = 0.0
    elif home["assigned_kw"] > 0:
        home["assigned_kw"] = 0.0


def _table_get(table, params, settings=None, http_get=None, extra_headers=None):
    """One GET to a PostgREST table. Injected getter is the I/O so CI needs no keys."""
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
            f"{url.rstrip('/')}/rest/v1/{table}",
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


def _homes_get(params, settings=None, http_get=None, extra_headers=None):
    """One GET public.homes. Kept so existing callers keep working."""
    return _table_get("homes", params, settings=settings, http_get=http_get, extra_headers=extra_headers)


def fetch_table_rows(table, params, settings=None, http_get=None):
    """GET rows from any fleet table. Never uses aggregate functions."""
    reply = _table_get(table, params, settings=settings, http_get=http_get)
    try:
        rows = reply.json()
    except ValueError:
        raise HomesUnavailable("malformed") from None
    if not isinstance(rows, list):
        raise HomesUnavailable("malformed")
    return rows


def fetch_home_rows(params, settings=None, http_get=None):
    """GET public.homes rows. Never uses aggregate functions."""
    return fetch_table_rows("homes", params, settings=settings, http_get=http_get)


def fetch_readings(home_id, limit=None, settings=None, http_get=None):
    """Oldest-first readings for one home. Capped so history never returns 10k rows."""
    rows = fetch_table_rows(
        "home_readings",
        {
            "select": READING_SELECT,
            "home_id": f"eq.{home_id}",
            "order": "seen_at.asc",
            "limit": str(history_limit(limit)),
        },
        settings=settings,
        http_get=http_get,
    )
    return [as_reading(item) for item in rows]


def fetch_commands(home_id, limit=None, settings=None, http_get=None):
    """Oldest-first commands for one home. Capped so history never returns 10k rows."""
    rows = fetch_table_rows(
        "home_commands",
        {
            "select": COMMAND_SELECT,
            "home_id": f"eq.{home_id}",
            "order": "sent_at.asc",
            "limit": str(history_limit(limit)),
        },
        settings=settings,
        http_get=http_get,
    )
    return [as_command(item) for item in rows]


def read_home_history(home_id, limit=None, settings=None, http_get=None):
    """History payload for GET /v1/homes/{home_id}/history.

    A missing table or missing config returns empty arrays, never a 500 and
    never a synthetic HOLDING series. Each side fails independently so one
    missing table does not hide the other table's rows.
    """
    capped = history_limit(limit)
    try:
        readings = fetch_readings(home_id, limit=capped, settings=settings, http_get=http_get)
    except HomesUnavailable:
        readings = []
    try:
        commands = fetch_commands(home_id, limit=capped, settings=settings, http_get=http_get)
    except HomesUnavailable:
        commands = []
    return {"home_id": home_id, "readings": readings, "commands": commands}


def read_last_command(home_id, settings=None, http_get=None):
    """Newest command as HomeCommand {kw, sent_at, ack}. None when unknown."""
    rows = fetch_table_rows(
        "home_commands",
        {
            "select": COMMAND_SELECT,
            "home_id": f"eq.{home_id}",
            "order": "sent_at.desc",
            "limit": "1",
        },
        settings=settings,
        http_get=http_get,
    )
    if not rows:
        return None
    return as_last_command(rows[0])


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


def list_homes(zone=None, status=None, q=None, limit=None, offset=None, settings=None, http_get=None,
             reserve_pct=None, zone_reserve_pct=None, fleet_size=None):
    params = {
        "select": HOME_SELECT,
        "order": "home_id.asc",
        "limit": str(page_limit(limit)),
        "offset": str(page_offset(offset)),
        **fleet_filter(fleet_size),
    }
    if zone:
        # Demo fleet: the engine's zone (Task 17), which is an id subset of the fleet filter.
        by_engine = engine_zone_filter(zone, fleet_size)
        if by_engine is None:
            params["zone"] = f"eq.{zone}"
        else:
            params.update(by_engine)
    if status:
        params["status"] = f"eq.{status}"
    needle = SEARCH_SAFE.sub("", q or "")
    if needle:
        params["home_id"] = f"ilike.*{needle}*"
    return [as_fleet_home(row, fleet_size, reserve_pct=reserve_pct, zone_reserve_pct=zone_reserve_pct)
            for row in fetch_home_rows(params, settings=settings, http_get=http_get)]


def read_home(home_id, settings=None, http_get=None, reserve_pct=None, zone_reserve_pct=None,
              fleet_size=None):
    if not in_fleet(home_id, fleet_size):
        # Outside the demo fleet: not found, even when the 10k seed has the row.
        return None
    rows = fetch_home_rows(
        {"select": HOME_SELECT, "home_id": f"eq.{home_id}", "limit": "1"},
        settings=settings,
        http_get=http_get,
    )
    if not rows:
        return None
    home = as_fleet_home(rows[0], fleet_size, reserve_pct=reserve_pct, zone_reserve_pct=zone_reserve_pct)
    # Fill last_command from the newest command. A missing history table or
    # missing config keeps null instead of raising, so the home still returns.
    try:
        home["last_command"] = read_last_command(home_id, settings=settings, http_get=http_get)
    except HomesUnavailable:
        home["last_command"] = None
    return home


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


def _zone_scope(zone, fleet_size=None):
    """Rows of one zone within the fleet: the engine's zone for the demo fleet (Task 17), else the table's."""
    by_engine = engine_zone_filter(zone, fleet_size)
    if by_engine is not None:
        return by_engine
    return {"zone": f"eq.{zone}", **fleet_filter(fleet_size)}


def _discharging_mw(zone, settings=None, http_get=None, fleet_size=None):
    total_kw = 0.0
    offset = 0
    while True:
        rows = fetch_home_rows(
            {
                "select": "assigned_kw",
                "status": "eq.live",
                "assigned_kw": "gt.0",
                "limit": "200",
                "offset": str(offset),
                **_zone_scope(zone, fleet_size),
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


def fleet_count(fleet_size=None, settings=None, http_get=None):
    """How many of the fleet's homes have a row in public.homes (Content-Range, no aggregates)."""
    return exact_count(fleet_filter(fleet_size), settings=settings, http_get=http_get)


def table_rollups(settings=None, http_get=None, fleet_size=None):
    """Zone counts from Content-Range. Never count() — PostgREST returns PGRST123.

    Raises HomesUnavailable("fleet_unscoped") when the fleet is too large to filter by id: counting
    the whole table would report its rows as the fleet. The route then serves current_rollups().
    """
    if not fleet_scoped(fleet_size):
        raise HomesUnavailable("fleet_unscoped")
    zones = {name: _empty_zone_row() for name in ZONE_ORDER}
    n = 0
    for zone in ZONE_ORDER:
        # Task 17: each zone is the engine's (ids), not the seed's zone column.
        scope = _zone_scope(zone, fleet_size)
        for status in ("live", "stale", "dead"):
            count = exact_count(
                {"status": f"eq.{status}", **scope},
                settings=settings,
                http_get=http_get,
            )
            n += count
            zones[zone][status] += count
            if status == "stale":
                zones[zone]["silent"] += count
        discharging = exact_count(
            {"status": "eq.live", "assigned_kw": "gt.0", **scope},
            settings=settings,
            http_get=http_get,
        )
        zones[zone]["discharging"] = discharging
        if discharging:
            zones[zone]["discharging_mw"] = _discharging_mw(
                zone, settings=settings, http_get=http_get, fleet_size=fleet_size)
    return {"n": n, "zones": zones, "clusters": [dict(item) for item in CLUSTER_CENTROIDS]}
