"""Best-effort HOLD/AUTO copy in public.operator_settings.

The engine never imports this module. A missing config or a failed
call leaves var/state.json as the local cache.
"""

import os

import requests

from server.engine.fleet_state import load_fleet_mode, write_fleet_mode
from server.env import load_env

FLEET_ID = "fleet"
TABLE = "operator_settings"
MODES = ("AUTO", "HOLD")


def table_config():
    load_env()
    try:
        timeout_s = float(os.getenv("FETCH_TIMEOUT_S", "3"))
    except ValueError:
        timeout_s = 3.0
    return os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", ""), timeout_s


def row_for_mode(mode, operator_id=None):
    row = {"id": FLEET_ID, "mode": mode}
    if operator_id:
        row["updated_by"] = operator_id
    return row


def persist_mode(mode, url="", key="", operator_id=None, http_post=None, timeout_s=3):
    """Upsert the fleet row. Returns 'ok' or 'skipped: <reason>'."""
    if mode not in MODES:
        return "skipped: bad_mode"
    if not (url and key):
        return "skipped: no_config"
    post = http_post or requests.post
    try:
        reply = post(
            f"{url.rstrip('/')}/rest/v1/{TABLE}?on_conflict=id",
            json=[row_for_mode(mode, operator_id)],
            headers={
                "apikey": key,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
            },
            timeout=timeout_s,
        )
    except requests.Timeout:
        return "skipped: timeout"
    except requests.RequestException:
        return "skipped: network"
    if not getattr(reply, "ok", False):
        return f"skipped: HTTP {getattr(reply, 'status_code', '?')}"
    return "ok"


def load_mode(url="", key="", http_get=None, timeout_s=3):
    """AUTO or HOLD from the table. None when missing, unusable, or offline."""
    if not (url and key):
        return None
    get = http_get or requests.get
    try:
        reply = get(
            f"{url.rstrip('/')}/rest/v1/{TABLE}",
            params={"id": f"eq.{FLEET_ID}", "select": "mode", "limit": 1},
            headers={"apikey": key},
            timeout=timeout_s,
        )
    except requests.RequestException:
        return None
    if not getattr(reply, "ok", False):
        return None
    try:
        rows = reply.json()
    except ValueError:
        return None
    if not isinstance(rows, list) or not rows:
        return None
    mode = rows[0].get("mode") if isinstance(rows[0], dict) else None
    return mode if mode in MODES else None


def hydrate_local_mode(path, url="", key="", http_get=None, timeout_s=3):
    """Table wins so the laptop worker sees a wall write on Render.

    An empty or failed table leaves the local file (AUTO when that is missing).
    """
    mode = load_mode(url, key, http_get=http_get, timeout_s=timeout_s)
    if mode:
        write_fleet_mode(mode, path)
        return mode
    return load_fleet_mode(path)
