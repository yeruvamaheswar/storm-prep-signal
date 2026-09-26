"""Build a storm replay tape from the ERCOT history saved in Supabase.

Usage: python scripts/build_tape.py [--start 2024-01-15T07:00 --end 2024-01-15T19:00] [--zone LZ_HOUSTON]

Reads Winter Storm Heather's NP3-233-CD postings (public.ercot_postings) and NP6-905-CD prices
(public.ercot_prices), then writes committed local files the engine replays offline:
- data/fixtures/heather/np3_233_cd_<posted>.json: each posting the tape points at, in the live API shape.
- data/fixtures/heather/baseline.json: the lead-matched baseline from the 30 days before the storm week,
  the way scripts/replay_event.py and scripts/check_margin.py rate a past storm.
- tapes/heather.json: one frame per tick. Risk and price are recorded ERCOT data; the target is synthetic,
  because no public dispatch target exists.
Replay it with: python -m server.engine --tape tapes/heather.json --baseline data/fixtures/heather/baseline.json

Supabase is never needed at run time. If it fails here, the old files stay and the script exits 0.
Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from check_margin import FetchFailed, build_baseline, fetch_postings, windows  # noqa: E402
from server.engine.cli import read_settings  # noqa: E402
from server.engine.signal import CENTRAL  # noqa: E402

ENV_PATH = ROOT / ".env"
EVENT = "heather"
FIXTURE_DIR = Path("data") / "fixtures" / EVENT
TAPE_PATH = Path("tapes") / f"{EVENT}.json"
# The only HIGH posting at +15% was 2024-01-15 13:03 (data/margin_check.json); this window surrounds it.
DEFAULT_START, DEFAULT_END = "2024-01-15T07:00", "2024-01-15T19:00"
TARGET_MW = 0.2
PRICE_INTERVAL = timedelta(minutes=15)
TIMEOUT_S = 60


def fetch_prices(url, key, zone, start, end):
    """(interval_ending in Central, price) for one load zone, every interval that overlaps start..end."""
    endpoint = f"{url.rstrip('/')}/rest/v1/ercot_prices"
    last = end + PRICE_INTERVAL
    params = {"select": "interval_ending,price_usd_mwh", "settlement_point": f"eq.{zone}",
              "and": f"(interval_ending.gt.{start.isoformat()},interval_ending.lte.{last.isoformat()})",
              "order": "interval_ending"}
    try:
        reply = requests.get(endpoint, params=params, headers={"apikey": key}, timeout=TIMEOUT_S)
    except requests.Timeout:
        raise FetchFailed(f"no answer within {TIMEOUT_S} s") from None
    except requests.RequestException as exc:
        # The exception text can include the request, so only its type is shown.
        raise FetchFailed(f"network error ({type(exc).__name__})") from None
    if not reply.ok:
        raise FetchFailed(f"HTTP {reply.status_code}: {reply.text}")
    return [(datetime.fromisoformat(row["interval_ending"]).astimezone(CENTRAL), row["price_usd_mwh"])
            for row in reply.json()]


def price_at(prices, ts):
    """The price of the 15-minute interval that holds ts, or None when that interval is missing."""
    for ending, price in prices:
        if ending - PRICE_INTERVAL <= ts < ending:
            return price
    return None


def latest_posting(postings, ts):
    """The newest posting made at or before ts, or None. `postings` are oldest first, times in Central."""
    made = [item for item in postings if item[0].replace(tzinfo=CENTRAL) <= ts]
    return made[-1] if made else None


def fixture_name(posted):
    return f"np3_233_cd_{posted:%Y%m%dT%H%M%S}.json"


def posting_fixture(posted, rows):
    """One posting in the live API shape that signal.load_signal reads with --file."""
    names = ["postedDatetime", "operatingDate", "hourEnding"]
    names += sorted(key for key in rows[0] if key not in names)
    stamp = posted.isoformat(timespec="seconds")
    return {"source": f"Supabase public.ercot_postings, event {EVENT}, ERCOT NP3-233-CD",
            "fields": [{"name": name} for name in names],
            "data": [[stamp if name == "postedDatetime" else row[name] for name in names] for row in rows]}


def build_frames(postings, prices, start, end, tick_minutes, zone):
    """Tape frames every tick_minutes from start to end, and the postings they point at."""
    frames, used = [], {}
    ts, tick = start, 1
    while ts <= end:
        price = price_at(prices, ts)
        posting = latest_posting(postings, ts)
        fixture = None
        if posting:
            fixture = str(FIXTURE_DIR / fixture_name(posting[0]))
            used[fixture] = posting
        frames.append({"tick": tick, "ts": ts.isoformat(timespec="seconds"),
                       "target_mw": TARGET_MW, "target_label": "synthetic",
                       "price_usd_mwh": price,
                       "price_label": f"recorded:ERCOT NP6-905-CD {zone}" if price is not None else "none",
                       "risk_fixture": fixture, "events": {}})
        ts += timedelta(minutes=tick_minutes)
        tick += 1
    return frames, used


def baseline_file(postings, first_day, last_day):
    """The baseline JSON from the postings made between first_day and last_day, like data/baseline_by_lead.json."""
    before = [item for item in postings if first_day <= item[0].date() <= last_day]
    baseline = build_baseline(before)
    return {"source": f"Supabase public.ercot_postings, event {EVENT}, ERCOT NP3-233-CD",
            "postings": baseline["postings"],
            "from": before[0][0].isoformat(timespec="seconds"), "to": before[-1][0].isoformat(timespec="seconds"),
            "median_mw_by_lead": baseline["median_mw_by_lead"]}


def write_json(path, value):
    path = ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=1) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the Heather replay tape from Supabase.")
    parser.add_argument("--start", default=DEFAULT_START, help="first tick, Central time (default %(default)s)")
    parser.add_argument("--end", default=DEFAULT_END, help="last tick, Central time (default %(default)s)")
    parser.add_argument("--zone", default="LZ_HOUSTON", help="load zone for the price (default %(default)s)")
    args = parser.parse_args(argv)
    start, end = (datetime.fromisoformat(text).replace(tzinfo=CENTRAL) for text in (args.start, args.end))

    load_dotenv(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    if not (url and key):
        print("build_tape_skipped: no_config")
        return 0
    settings = read_settings()
    try:
        postings = fetch_postings(url, key, EVENT)
        prices = fetch_prices(url, key, args.zone, start, end)
        _, _, base_first, base_last = windows()[EVENT]
        baseline = baseline_file(postings, base_first, base_last)
    except (FetchFailed, ValueError) as exc:
        print(f"build_tape_skipped: {exc}")
        return 0

    frames, used = build_frames(postings, prices, start, end, settings["tick_minutes"], args.zone)
    for path, (posted, rows) in used.items():
        write_json(path, posting_fixture(posted, rows))
    write_json(FIXTURE_DIR / "baseline.json", baseline)
    write_json(TAPE_PATH, {
        "label": (f"ERCOT replay, Winter Storm Heather, {args.start} to {args.end} CT. Risk: recorded NP3-233-CD."
                  f" Price: recorded NP6-905-CD {args.zone}. Target: synthetic."),
        "frames": frames})
    priced = sum(frame["price_usd_mwh"] is not None for frame in frames)
    print(f"wrote {TAPE_PATH}: {len(frames)} frames ({priced} priced), {len(used)} postings in {FIXTURE_DIR},"
          f" baseline {baseline['postings']} postings {baseline['from']} to {baseline['to']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
