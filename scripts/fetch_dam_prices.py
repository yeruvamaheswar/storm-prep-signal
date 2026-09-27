"""Save ERCOT Day-Ahead Market prices (NP4-190-CD) for the four load zones, one file per delivery day.

Usage:
  python scripts/fetch_dam_prices.py 2026-08-30 2026-08-31      # named days
  python scripts/fetch_dam_prices.py --scenarios                # every scenario day, plus the day after
  python scripts/fetch_dam_prices.py --scenarios --force        # refetch files already saved

Writes data/fixtures/dam/np4_190_cd_YYYYMMDD.json ({source, delivery_date, fields, data}).
The scenario tapes point at these files (TapeFrame.dam_fixtures), so a replay never needs the network.
Needs ERCOT_USERNAME, ERCOT_PASSWORD and ERCOT_SUBSCRIPTION_KEY in .env. A failed day prints why and
the script exits 1; days already saved are kept.
"""
import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from server.engine.cli import read_settings  # noqa: E402
from server.engine.signal import SignalUnavailable, fetch_dam_prices  # noqa: E402

DAM_DIR = Path("data") / "fixtures" / "dam"
# DAM results are big replies for four GETs; the engine's 3 s live timeout is too short here.
FETCH_TIMEOUT_S = 60


def dam_path(day):
    """Repo-relative path of one delivery day's file (day is a date or an ISO date string)."""
    day = date.fromisoformat(str(day))
    return DAM_DIR / f"np4_190_cd_{day:%Y%m%d}.json"


def scenario_days():
    """Every calendar day a scenario window touches, plus the day after (published the afternoon before)."""
    from build_scenarios import SCENARIOS
    days = set()
    for spec in SCENARIOS:
        first = datetime.fromisoformat(spec["start"]).date()
        last = datetime.fromisoformat(spec["end"]).date() + timedelta(days=1)
        while first <= last:
            days.add(first)
            first += timedelta(days=1)
    return sorted(days)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Save ERCOT NP4-190-CD DAM prices, one file per day.")
    parser.add_argument("days", nargs="*", help="delivery days, YYYY-MM-DD")
    parser.add_argument("--scenarios", action="store_true", help="every scenario day plus the day after")
    parser.add_argument("--force", action="store_true", help="refetch days already saved")
    args = parser.parse_args(argv)
    days = sorted({date.fromisoformat(day) for day in args.days} | set(scenario_days() if args.scenarios else []))
    if not days:
        parser.error("name at least one day, or pass --scenarios")

    load_dotenv(ROOT / ".env")
    settings = {**read_settings(), "fetch_timeout_s": FETCH_TIMEOUT_S}
    failed = 0
    for day in days:
        path = ROOT / dam_path(day)
        if path.exists() and not args.force:
            print(f"kept {dam_path(day)}")
            continue
        try:
            body = fetch_dam_prices(settings, day.isoformat())
        except SignalUnavailable as exc:
            print(f"failed {day}: {exc}")
            failed += 1
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body, indent=1) + "\n")
        print(f"wrote {dam_path(day)}: {len(body['data'])} rows")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
