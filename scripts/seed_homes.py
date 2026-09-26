"""Seed public.homes with the 10k fleet: same zones as new_fleet, random 45–75% SOC.

Usage: python scripts/seed_homes.py [--dry-run]

Rows are current-state upserts on home_id, not a reading history. The engine
never imports this module. Needs SUPABASE_URL and SUPABASE_SECRET_KEY in
server/.env, except with --dry-run.
"""
import argparse
import os
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from load_ercot_archive import BatchFailed, send  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402
from server.engine.fleet import SOC_MAX_PCT, SOC_MIN_PCT, new_fleet  # noqa: E402

FLEET_SIZE = 10_000


def random_soc_kwh(capacity_kwh, rng):
    """Charge anywhere in the 45–75% band. The engine's even spread stays in new_fleet."""
    pct = rng.uniform(SOC_MIN_PCT, SOC_MAX_PCT)
    return capacity_kwh * pct / 100


def row_from_home(home, rng):
    """Map a Home onto the public.homes current-state row. Telemetry stays null."""
    return {
        "home_id": home.home_id,
        "zone": home.zone,
        "capacity_kwh": home.capacity_kwh,
        "soc_kwh": random_soc_kwh(home.capacity_kwh, rng),
        "max_kw": home.max_kw,
        "status": home.status,
        "assigned_kw": 0,
    }


def build_rows(n=FLEET_SIZE, rng=None):
    """Exactly n homes: assign_zone from new_fleet, SOC rolled in the 45–75% band."""
    rng = random.Random() if rng is None else rng
    return [row_from_home(home, rng) for home in new_fleet(n)]


def persist_rows(rows, url, key):
    if not (url and key):
        return "skipped: no_config"
    try:
        send(rows, url, key, table="homes", on_conflict="home_id")
    except BatchFailed as exc:
        return f"skipped: {exc}"
    return "ok"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Seed public.homes with the 10k fleet.")
    parser.add_argument("--dry-run", action="store_true", help="build 10k rows and send nothing")
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    rows = build_rows()
    if args.dry_run:
        print(f"homes_built: {len(rows)}")
        return 0
    if not (url and key):
        print("homes_skipped: no_config")
        return 0
    print(f"homes_{persist_rows(rows, url, key)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
