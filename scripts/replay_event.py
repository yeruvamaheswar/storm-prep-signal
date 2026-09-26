"""Replay a past storm week through our risk rule, using ERCOT's NP3-233-CD archive.

Usage: python scripts/replay_event.py --event beryl [--start 2024-07-05 --end 2024-07-11]

Downloads every posting from 30 days before --start through --end to data/events/<event>/raw/,
builds a baseline from the 30 days before --start the way scripts/make_baseline.py does, rates
each posting from --start to --end with compute_risk, and writes data/events/<event>/replay.csv.
"""
import argparse
import csv
import json
import os
import sys
import time
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median

import requests

ROOT = Path(__file__).resolve().parent.parent
# The repo root holds storm_prep; scripts/ holds make_baseline. Both are needed when a test imports this file.
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from make_baseline import LEAD_HOURS, posting_time, totals_by_lead  # noqa: E402
from storm_prep.__main__ import read_settings  # noqa: E402
from storm_prep.baseline import load_baseline  # noqa: E402
from storm_prep.risk import CATEGORIES, ZONES, compute_risk  # noqa: E402
from storm_prep.signal import SignalUnavailable, get_id_token  # noqa: E402

ARCHIVE_URL = "https://api.ercot.com/api/public-reports/archive/np3-233-cd"
EVENTS_DIR = ROOT / "data" / "events"
EVENTS = {"beryl": ("2024-07-05", "2024-07-11"), "heather": ("2024-01-12", "2024-01-17")}
BASELINE_DAYS = 30
# ERCOT answered HTTP 429 after about 30 calls in one minute at 0.5 s, so stay under 30 a minute.
PAUSE_S = 2.0
KNOWN = [f"Total{category}MWZone{zone}" for category in CATEGORIES for zone in ZONES]


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Replay a past storm week through the risk rule.")
    parser.add_argument("--event", required=True, choices=sorted(EVENTS))
    parser.add_argument("--start", type=date.fromisoformat, help="first day to rate (YYYY-MM-DD)")
    parser.add_argument("--end", type=date.fromisoformat, help="last day to rate (YYYY-MM-DD)")
    args = parser.parse_args(argv)
    default_start, default_end = (date.fromisoformat(day) for day in EVENTS[args.event])
    args.start = args.start or default_start
    args.end = args.end or default_end
    return args


def ercot_get(headers, timeout, params):
    reply = requests.get(ARCHIVE_URL, params=params, headers=headers, timeout=timeout)
    if reply.status_code != 200:
        raise SignalUnavailable(f"ERCOT archive request failed (HTTP {reply.status_code})")
    return reply


def list_archives(headers, timeout, since, until):
    """Every archived posting between two Central times, one page at a time."""
    docs, page = [], 1
    while True:
        body = ercot_get(headers, timeout, {"postDatetimeFrom": since, "postDatetimeTo": until,
                                            "size": 1000, "page": page}).json()
        docs += body["archives"]
        if page >= body["_meta"]["totalPages"]:
            return docs
        page += 1
        time.sleep(PAUSE_S)


def download_window(raw_dir, first_day, last_day, timeout):
    """Log in once, then save each posting's zip as raw/<docId>.zip, skipping ones already saved."""
    username, password, key = (os.getenv(name, "") for name in
                               ("ERCOT_USERNAME", "ERCOT_PASSWORD", "ERCOT_SUBSCRIPTION_KEY"))
    if not (username and password and key):
        raise SignalUnavailable("ERCOT credentials missing from .env")
    headers = {"Authorization": f"Bearer {get_id_token(username, password, timeout)}",
               "Ocp-Apim-Subscription-Key": key}
    docs = list_archives(headers, timeout, f"{first_day}T00:00:00", f"{last_day}T23:59:59")
    raw_dir.mkdir(parents=True, exist_ok=True)
    fetched = 0
    for doc in docs:
        target = raw_dir / f"{doc['docId']}.zip"
        if target.exists():
            continue
        time.sleep(PAUSE_S)
        body = ercot_get(headers, timeout, {"download": doc["docId"]}).content
        # Write then rename, so an interrupted download is never mistaken for a finished one.
        partial = target.with_suffix(".part")
        partial.write_bytes(body)
        partial.replace(target)
        fetched += 1
    print(f"{len(docs)} postings listed, {fetched} downloaded, {len(docs) - fetched} already saved")


def csv_in_zip(zip_path):
    """The one CSV inside a downloaded zip, readable in place without unzipping to disk."""
    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()
    if len(names) != 1:
        raise ValueError(f"{zip_path.name}: expected one CSV, found {names}")
    return zipfile.Path(zip_path, names[0])


def read_posting(csv_file):
    """One posting's rows, renamed to the live API fields that compute_risk reads."""
    with csv_file.open(newline="") as file:
        reader = csv.DictReader(file)
        totals = [name for name in reader.fieldnames if name.startswith("Total")]
        # make_baseline sums every Total column, so they must be exactly the 12 that compute_risk sums.
        missing, unknown = set(KNOWN) - set(totals), set(totals) - set(KNOWN)
        if missing or unknown:
            raise ValueError(f"{csv_file.name}: missing {sorted(missing)}, unexpected {sorted(unknown)}")
        rows = []
        for row in reader:
            api_row = {"operatingDate": datetime.strptime(row["Date"], "%m/%d/%Y").date().isoformat(),
                       "hourEnding": int(row["HourEnding"])}
            # The CSV says TotalResourceMWZoneSouth where the API (and compute_risk) says totalResource...
            for column in KNOWN:
                api_row["t" + column[1:]] = float(row[column])
            rows.append(api_row)
    return sorted(rows, key=lambda row: (row["operatingDate"], row["hourEnding"]))


def build_baseline(postings):
    """The same median-by-lead as scripts/make_baseline.py main(), for these postings only."""
    kept = []
    for posted, csv_file in postings:
        totals = totals_by_lead(csv_file, posted)
        if len(totals) >= LEAD_HOURS:
            kept.append((posted, totals))
    if not kept:
        raise ValueError("no usable postings in the baseline window")
    return {
        "source": "ERCOT NP3-233-CD archive",
        "postings": len(kept),
        "from": kept[0][0].isoformat(),
        "to": kept[-1][0].isoformat(),
        "median_mw_by_lead": [float(median(t[lead] for _, t in kept)) for lead in range(LEAD_HOURS)],
    }


def rate_posting(rows, posted, baseline, margin_pct, lookahead_hours):
    """Rate one posting as if it were the newest: its own hour is the current hour, as in to_signal."""
    signal = {"current_date": posted.date().isoformat(), "current_hour_ending": posted.hour + 1,
              "rows": rows}
    return compute_risk(signal, baseline, margin_pct=margin_pct, lookahead_hours=lookahead_hours)


def main(argv=None):
    args = parse_args(argv)
    settings = read_settings()
    event_dir = EVENTS_DIR / args.event
    raw_dir = event_dir / "raw"
    first_day = args.start - timedelta(days=BASELINE_DAYS)
    timeout = settings["fetch_timeout_s"]
    try:
        download_window(raw_dir, first_day, args.end, timeout)
    except requests.Timeout:
        sys.exit(f"ERCOT did not answer within {timeout:g} s")
    except requests.RequestException as exc:
        sys.exit(f"network error reaching ERCOT ({type(exc).__name__})")
    except SignalUnavailable as exc:
        sys.exit(str(exc))

    files = (csv_in_zip(path) for path in raw_dir.glob("*.zip"))
    postings = sorted(((posting_time(file), file) for file in files), key=lambda item: item[0])
    before = [item for item in postings if first_day <= item[0].date() < args.start]
    during = [item for item in postings if args.start <= item[0].date() <= args.end]

    baseline_path = event_dir / "baseline.json"
    baseline_path.write_text(json.dumps(build_baseline(before)) + "\n")
    baseline = load_baseline(baseline_path, settings["lookahead_hours"])
    print(f"baseline: {baseline['postings']} postings, {baseline['from']} to {baseline['to']}")

    fired = []
    with (event_dir / "replay.csv").open("w", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["posted_at", "peak_mw", "trigger_mw", "risk", "driving_zone", "houston_mw"])
        for posted, csv_file in during:
            risk = rate_posting(read_posting(csv_file), posted, baseline,
                                settings["margin_pct"], settings["lookahead_hours"])
            line = [posted.isoformat(), round(risk.peak_mw), round(risk.trigger_mw, 1), risk.level,
                    risk.driving_zone, round(risk.zone_mw["Houston"])]
            writer.writerow(line)
            if risk.level == "HIGH":
                fired.append(line)
    print(f"rated {len(during)} postings with baseline +{settings['margin_pct']:g}%"
          f" -> {event_dir / 'replay.csv'}")
    for posted_at, peak, trigger, _, zone, houston in fired:
        print(f"HIGH {posted_at}: peak {peak:,} MW vs trigger {trigger:,} MW,"
              f" driving zone {zone}, Houston {houston:,} MW")
    if not fired:
        print("rule never fired")


if __name__ == "__main__":
    main()
