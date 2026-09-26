"""Copy the local fleet snapshot into public.homes. Best effort.

Usage: python scripts/persist_homes.py [var/fleet/homes.json]
Reads a list of Home dicts (what fleet.save_fleet writes), or a wrapper
{homes, assigned_kw, run_id, tick}. Upserts on home_id. The engine never
imports this module during a tick.

Needs SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

import load_ercot_archive as archive  # noqa: E402
from load_ercot_archive import BatchFailed, send  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402

# Home rows are a few hundred bytes. Postings are ~93 KB, so archive send()
# uses 25. 400 stays inside the 200–500 band this script is allowed.
BATCH_SIZE = 400
DEFAULT_PATH = Path("var") / "fleet" / "homes.json"


def row_from_home(home, now=None, assigned_kw=None, run_id=None, tick=None):
    """Map one Home dict onto the public.homes current-state columns."""
    stamp = now or datetime.now(timezone.utc).isoformat()
    if assigned_kw is None:
        assigned_kw = home.get("assigned_kw", 0)
    if run_id is None:
        run_id = home.get("run_id")
    if tick is None:
        tick = home.get("tick")
    row = {
        "home_id": home["home_id"],
        "zone": home.get("zone") or "",
        "capacity_kwh": home["capacity_kwh"],
        "soc_kwh": home["soc_kwh"],
        "max_kw": home["max_kw"],
        "status": home.get("status") or "live",
        "assigned_kw": assigned_kw,
        "updated_at": home.get("updated_at") or stamp,
    }
    if run_id not in (None, ""):
        row["run_id"] = run_id
    if tick is not None:
        row["tick"] = tick
    return row


def rows_from_payload(payload, now=None):
    """Accept save_fleet's list, or a wrapper with optional assigned_kw/run_id/tick."""
    if isinstance(payload, list):
        homes, assigned_map, run_id, tick = payload, {}, None, None
    elif isinstance(payload, dict) and isinstance(payload.get("homes"), list):
        assigned = payload.get("assigned_kw")
        homes = payload["homes"]
        assigned_map = assigned if isinstance(assigned, dict) else {}
        run_id = payload.get("run_id")
        tick = payload.get("tick")
    else:
        raise ValueError("homes.json must be a list of Home dicts")
    rows = []
    for home in homes:
        kw = home["assigned_kw"] if "assigned_kw" in home else assigned_map.get(home.get("home_id"), 0)
        rid = home["run_id"] if "run_id" in home else run_id
        tck = home["tick"] if "tick" in home else tick
        rows.append(row_from_home(home, now=now, assigned_kw=kw, run_id=rid, tick=tck))
    return rows


def persist_homes(payload, url, key, now=None):
    if not (url and key):
        return "skipped: no_config"
    rows = rows_from_payload(payload, now=now)
    previous = archive.BATCH_SIZE
    archive.BATCH_SIZE = BATCH_SIZE
    try:
        send(rows, url, key, table="homes", on_conflict="home_id")
    except BatchFailed as exc:
        return f"skipped: {exc}"
    finally:
        archive.BATCH_SIZE = previous
    return "ok"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Copy var/fleet/homes.json into public.homes.")
    parser.add_argument("path", nargs="?", default=str(DEFAULT_PATH))
    parser.add_argument("--dry-run", action="store_true", help="print the row count, send nothing")
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    path = Path(args.path)
    if not path.is_file():
        print("homes_skipped: no_file")
        return 0
    try:
        payload = json.loads(path.read_text())
        rows = rows_from_payload(payload)
    except (OSError, ValueError, KeyError, TypeError):
        print("homes_skipped: bad_json")
        return 0
    if args.dry_run:
        print(f"homes_built: {len(rows)}")
        return 0
    if not (url and key):
        print("homes_skipped: no_config")
        return 0
    print(f"homes_{persist_homes(payload, url, key)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
