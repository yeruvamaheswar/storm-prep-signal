"""Copy last telemetry readings onto public.homes. Best effort.

Usage: python scripts/persist_telemetry.py [var/fleet/telemetry.json]
Reads last readings keyed by home_id. Merge-upserts only telemetry columns
on home_id. No history table. The engine never imports this module.

Needs SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

import load_ercot_archive as archive  # noqa: E402
from load_ercot_archive import BatchFailed, send  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402

# Same 200–500 band as persist_homes.py: telemetry rows are tiny vs 93 KB postings.
BATCH_SIZE = 400
DEFAULT_PATH = Path("var") / "fleet" / "telemetry.json"


def _get(obj, name, default=None):
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def last_seen_iso(value, as_of=None, now_s=None):
    """Keep data age when last_seen is still the virtual clock."""
    if value in (None, "") or (isinstance(value, float) and value == float("-inf")):
        return None
    if isinstance(value, str):
        return value
    stamp = as_of or datetime.now(timezone.utc)
    if isinstance(stamp, str):
        stamp = datetime.fromisoformat(stamp)
    clock = float(value) if now_s is None else float(now_s)
    return (stamp - timedelta(seconds=clock - float(value))).isoformat()


def row_from_last(home_id, last):
    """Map one last reading onto the telemetry columns of public.homes."""
    row = {"home_id": home_id}
    if last.get("last_seen") not in (None, ""):
        row["last_seen"] = last["last_seen"]
    if last.get("charge_state") not in (None, ""):
        row["charge_state"] = last["charge_state"]
    if last.get("power_kw") is not None:
        row["power_kw"] = last["power_kw"]
    if last.get("boot_id") not in (None, ""):
        row["boot_id"] = str(last["boot_id"])
    if last.get("last_seq") is not None:
        row["last_seq"] = last["last_seq"]
    if "soc_kwh" in last and last["soc_kwh"] is not None:
        row["soc_kwh"] = last["soc_kwh"]
    return row


def snapshot_from_state(homes, as_of=None, now_s=None):
    """Last accepted reading per home_id. Homes with no `last` are omitted."""
    snap = {}
    for home_id, hs in homes.items():
        last = _get(hs, "last")
        if not isinstance(last, dict):
            continue
        boot = _get(hs, "boot_id", last.get("boot_id"))
        seq = _get(hs, "last_seq")
        if seq is None or seq == -1:
            seq = last.get("seq")
        entry = {}
        iso = last_seen_iso(_get(hs, "last_seen"), as_of=as_of, now_s=now_s)
        if iso:
            entry["last_seen"] = iso
        if last.get("charge_state") not in (None, ""):
            entry["charge_state"] = last["charge_state"]
        if last.get("power_kw") is not None:
            entry["power_kw"] = last["power_kw"]
        if boot not in (None, ""):
            entry["boot_id"] = str(boot)
        if seq is not None and seq != -1:
            entry["last_seq"] = seq
        if "soc_kwh" in last and last["soc_kwh"] is not None:
            entry["soc_kwh"] = last["soc_kwh"]
        snap[home_id] = entry
    return snap


def write_snapshot(homes, path, as_of=None, now_s=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot_from_state(homes, as_of=as_of, now_s=now_s), indent=2))
    return path


def rows_from_snapshot(payload):
    if not isinstance(payload, dict):
        raise ValueError("telemetry.json must be keyed by home_id")
    homes = payload["homes"] if isinstance(payload.get("homes"), dict) else payload
    rows = []
    for home_id, last in homes.items():
        if not isinstance(last, dict):
            continue
        rows.append(row_from_last(home_id, last))
    return rows


def persist_telemetry(payload, url, key):
    if not (url and key):
        return "skipped: no_config"
    rows = rows_from_snapshot(payload)
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
    parser = argparse.ArgumentParser(
        description="Copy var/fleet/telemetry.json last readings onto public.homes.",
    )
    parser.add_argument("path", nargs="?", default=str(DEFAULT_PATH))
    parser.add_argument("--dry-run", action="store_true", help="print the row count, send nothing")
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    path = Path(args.path)
    if not path.is_file():
        print("telemetry_skipped: no_file")
        return 0
    try:
        payload = json.loads(path.read_text())
        rows = rows_from_snapshot(payload)
    except (OSError, ValueError, KeyError, TypeError):
        print("telemetry_skipped: bad_json")
        return 0
    if args.dry_run:
        print(f"telemetry_built: {len(rows)}")
        return 0
    if not (url and key):
        print("telemetry_skipped: no_config")
        return 0
    print(f"telemetry_{persist_telemetry(payload, url, key)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
