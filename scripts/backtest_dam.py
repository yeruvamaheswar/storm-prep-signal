"""How good is ERCOT's day-ahead price as a forecast of the cheapest real-time hours?

Usage: python scripts/backtest_dam.py [YYYY-MM-DD ...]     (default: every saved DAM day)

For each saved DAM day (data/fixtures/dam/, from scripts/fetch_dam_prices.py) and each load zone it reads
the real-time NP6-905-CD 15-minute prices for the same day from Supabase public.ercot_prices, averages
them to hours, and prints, for k = 1 to 4 charge hours:
- hit: the share of the k cheapest DAM hours that were really among the k cheapest real-time hours.
- dam / best / band: the average real-time $/MWh paid in the k DAM-chosen hours, in the k truly cheapest
  hours (hindsight), and in the first k hours at or under the $25 band (today's rule; "-" if fewer).
A day whose real-time prices are not all there is listed as skipped, never filled in.
Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env. Always exits 0: it is a report.
"""
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from build_tape import PRICE_INTERVAL, fetch_prices  # noqa: E402
from check_margin import FetchFailed  # noqa: E402
from fetch_dam_prices import DAM_DIR, dam_path  # noqa: E402
from server.engine.signal import CENTRAL, ZONE_POINTS, read_dam_prices  # noqa: E402

KS = (1, 2, 3, 4)
BAND_USD = 25.0


def hourly_rt(intervals, day):
    """{Central hour start: mean $/MWh} for one day, or None unless every hour has its 4 intervals."""
    by_hour = {}
    for ending, usd in intervals:
        start = (ending - PRICE_INTERVAL).astimezone(CENTRAL)
        if start.date() == day and usd is not None:
            by_hour.setdefault(start.replace(minute=0), []).append(float(usd))
    if len(by_hour) < 23 or any(len(values) != 4 for values in by_hour.values()):
        return None
    return {hour: sum(values) / 4 for hour, values in by_hour.items()}


def score_day(dam, rt, k, band_usd=BAND_USD):
    """One zone-day for k hours. dam and rt map the same hour starts to $/MWh.

    Returns {hit, dam, best, band}: band is None when fewer than k hours sit at or under the band.
    """
    hours = sorted(set(dam) & set(rt))
    chosen = sorted(hours, key=lambda hour: (dam[hour], hour))[:k]
    best = sorted(hours, key=lambda hour: (rt[hour], hour))[:k]
    cheap = [hour for hour in hours if rt[hour] <= band_usd][:k]

    def mean(picked):
        return sum(rt[hour] for hour in picked) / len(picked)

    return {"hit": len(set(chosen) & set(best)) / k, "dam": mean(chosen), "best": mean(best),
            "band": mean(cheap) if len(cheap) == k else None}


def saved_days():
    return sorted(date.fromisoformat(f"{p.stem[-8:-4]}-{p.stem[-4:-2]}-{p.stem[-2:]}")
                  for p in (ROOT / DAM_DIR).glob("np4_190_cd_*.json"))


def money(value):
    return "-" if value is None else f"{value:8.2f}"


def main(argv=None):
    args = argv if argv is not None else sys.argv[1:]
    days = [date.fromisoformat(day) for day in args] or saved_days()
    load_dotenv(ROOT / ".env")
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    if not (url and key):
        print("backtest_dam_skipped: no_config")
        return 0
    print("day        zone     k   hit   dam $/MWh best $/MWh band $/MWh   (real-time price paid)")
    totals = {k: {"hit": 0.0, "dam": 0.0, "best": 0.0, "n": 0} for k in KS}
    for day in days:
        path = ROOT / dam_path(day)
        if not path.exists():
            print(f"{day}  skipped: no DAM file (run scripts/fetch_dam_prices.py {day})")
            continue
        dam_all = read_dam_prices([json.loads(path.read_text())])
        start = datetime.combine(day, datetime.min.time(), tzinfo=CENTRAL)
        for zone, point in ZONE_POINTS.items():
            try:
                rt = hourly_rt(fetch_prices(url, key, point, start, start + timedelta(days=1)), day)
            except FetchFailed as exc:
                print(f"{day}  {zone:<8} skipped: {exc}")
                continue
            if rt is None:
                print(f"{day}  {zone:<8} skipped: real-time prices incomplete in ercot_prices")
                continue
            dam = {hour.astimezone(CENTRAL): usd for hour, usd in dam_all.get(zone, [])}
            for k in KS:
                row = score_day(dam, rt, k)
                print(f"{day}  {zone:<8} {k}  {row['hit']:4.0%}   {money(row['dam'])}   {money(row['best'])}"
                      f"   {money(row['band'])}")
                total = totals[k]
                total["hit"] += row["hit"]
                total["dam"] += row["dam"]
                total["best"] += row["best"]
                total["n"] += 1
    for k, total in totals.items():
        if total["n"]:
            n = total["n"]
            print(f"all {n} zone-days, k={k}: hit {total['hit'] / n:.0%}, dam-chosen ${total['dam'] / n:.2f},"
                  f" hindsight ${total['best'] / n:.2f} $/MWh real-time")
    return 0


if __name__ == "__main__":
    sys.exit(main())
