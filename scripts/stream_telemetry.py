"""Write realistic last readings and merge-upsert them onto public.homes.

Usage:
  python scripts/stream_telemetry.py            # one pulse for the 10k fleet
  python scripts/stream_telemetry.py --loop     # every --every seconds
  python scripts/stream_telemetry.py --dry-run  # print the count, write nothing

Synthetic, but the mix matches the VPP feed: 5–8% silent, most live, some
stale or dead, power sign locked to charge_state. The engine never imports
this module. Needs SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env.
"""
import argparse
import json
import os
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

import load_ercot_archive as archive  # noqa: E402
from load_ercot_archive import BatchFailed, send  # noqa: E402
from persist_telemetry import BATCH_SIZE, DEFAULT_PATH, row_from_last  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402
from server.engine.fleet import new_fleet  # noqa: E402

FLEET_SIZE = 10_000
SILENT_RATE = 0.06
EVERY_S = 15.0
# AEMO-style coverage: most report, a few go quiet. Weights are HOLDING-heavy
# because a reserve fleet sits idle until a tick assigns discharge.
STATE_WEIGHTS = (
    ("HOLDING", 0.70),
    ("DISCHARGING", 0.15),
    ("CHARGING", 0.10),
    ("FULL", 0.03),
    ("EMPTY", 0.02),
)


def pick_state(rng):
    roll = rng.random()
    acc = 0.0
    for state, weight in STATE_WEIGHTS:
        acc += weight
        if roll < acc:
            return state
    return "EMPTY"


def pick_age_s(rng):
    roll = rng.random()
    if roll < 0.82:
        return rng.uniform(0, 90)
    if roll < 0.94:
        return rng.uniform(181, 599)
    return rng.uniform(601, 1800)


def power_for(state, max_kw, rng):
    if state == "DISCHARGING":
        return round(rng.uniform(0.5, max_kw), 2)
    if state == "CHARGING":
        return -round(rng.uniform(0.5, max_kw), 2)
    return 0.0


def soc_for(state, capacity_kwh, rng):
    if state == "FULL":
        return round(rng.uniform(18.0, capacity_kwh), 2)
    if state == "EMPTY":
        return round(rng.uniform(0.0, 2.0), 2)
    return round(capacity_kwh * rng.uniform(0.45, 0.75), 2)


def last_for(home, now, rng, pulse, previous):
    prior = previous.get(home.home_id) if previous else None
    state = pick_state(rng)
    power = power_for(state, home.max_kw, rng)
    soc = soc_for(state, home.capacity_kwh, rng)
    if prior and state not in ("FULL", "EMPTY"):
        # Drift a little from the last report so a loop looks like a live feed.
        soc = round(min(home.capacity_kwh, max(0.0, prior["soc_kwh"] - power * 0.01)), 2)
    seq = prior["last_seq"] + 1 if prior else pulse
    boot = prior["boot_id"] if prior else "1"
    seen = now - timedelta(seconds=pick_age_s(rng))
    return {
        "last_seen": seen.isoformat(),
        "charge_state": state,
        "power_kw": power,
        "boot_id": str(boot),
        "last_seq": seq,
        "soc_kwh": soc,
    }


def build_snapshot(homes, now=None, rng=None, pulse=1, previous=None):
    """Last accepted reading per home_id. Silent homes are omitted."""
    now = now or datetime.now(timezone.utc)
    rng = random.Random() if rng is None else rng
    n_silent = int(round(len(homes) * SILENT_RATE))
    silent = set(rng.sample([home.home_id for home in homes], n_silent))
    snap = {}
    for home in homes:
        if home.home_id in silent:
            continue
        snap[home.home_id] = last_for(home, now, rng, pulse, previous)
    return snap


def rows_for_upsert(homes, snap):
    """Telemetry columns plus the NOT NULL identity Postgres checks on INSERT.

    merge-duplicates still updates only posted keys, but ON CONFLICT validates
    the insert row first. Stamp zone/capacity/max_kw/status from new_fleet
    (same values as seed). Leave assigned_kw off so the last tick's assignment
    is not wiped.
    """
    by_id = {home.home_id: home for home in homes}
    rows = []
    for home_id, last in snap.items():
        row = row_from_last(home_id, last)
        home = by_id[home_id]
        row["zone"] = home.zone
        row["capacity_kwh"] = home.capacity_kwh
        row["max_kw"] = home.max_kw
        row["status"] = home.status
        rows.append(row)
    return rows


def persist_pulse(homes, snap, url, key):
    if not (url and key):
        return "skipped: no_config"
    previous = archive.BATCH_SIZE
    archive.BATCH_SIZE = BATCH_SIZE
    try:
        send(rows_for_upsert(homes, snap), url, key, table="homes", on_conflict="home_id")
    except BatchFailed as exc:
        return f"skipped: {exc}"
    finally:
        archive.BATCH_SIZE = previous
    return "ok"


def write_pulse(snap, path):
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(snap, indent=2))
    return dest


def run_pulse(homes, path, url, key, rng, pulse, previous, dry_run, now=None):
    snap = build_snapshot(homes, now=now, rng=rng, pulse=pulse, previous=previous)
    if dry_run:
        print(f"telemetry_built: {len(snap)}", flush=True)
        return 0, snap
    write_pulse(snap, path)
    if not (url and key):
        print("telemetry_skipped: no_config", flush=True)
        return 0, snap
    print(f"telemetry_{persist_pulse(homes, snap, url, key)}", flush=True)
    return 0, snap


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Stream realistic last readings onto public.homes.",
    )
    parser.add_argument("--dry-run", action="store_true", help="print the row count, write nothing")
    parser.add_argument("--loop", action="store_true", help="repeat every --every seconds")
    parser.add_argument("--n", type=int, default=FLEET_SIZE, help="fleet size (default 10000)")
    parser.add_argument("--path", default=str(DEFAULT_PATH))
    parser.add_argument("--every", type=float, default=EVERY_S)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    homes = new_fleet(args.n)
    rng = random.Random(args.seed)
    previous = None
    pulse = 1

    def once():
        nonlocal previous, pulse
        code, previous = run_pulse(
            homes, args.path, url, key, rng, pulse, previous, args.dry_run,
        )
        pulse += 1
        return code

    if not args.loop:
        return once()
    while True:
        once()
        if args.dry_run:
            return 0
        time.sleep(max(1.0, args.every))


if __name__ == "__main__":
    sys.exit(main())
