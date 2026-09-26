"""Check the storm rule's margin against the NP3-233-CD postings saved in Supabase.

Usage: python scripts/check_margin.py [--margins 10 15 20]

For each window it reads the postings from public.ercot_postings, builds the lead-matched baseline,
rates every posting at each margin with the engine's compute_risk, and writes data/margin_check.json.
Storm weeks (beryl, heather) use the 30 days before the week as the baseline, like replay_event.py.
The calm month (tuning-2026) has no earlier data loaded, so its baseline is the same month and
in_sample is true: its count shows how often normal swings cross the margin, not a forecast.
Needs SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env.
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import median

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from load_ercot_reports import WINDOWS  # noqa: E402
from make_baseline import LEAD_HOURS  # noqa: E402
from replay_event import BASELINE_DAYS, EVENTS, rate_posting  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402
from server.engine.cli import read_settings  # noqa: E402
from server.engine.risk import hour_total  # noqa: E402
from server.engine.signal import CENTRAL  # noqa: E402

OUT_PATH = ROOT / "data" / "margin_check.json"
REPORT = "NP3-233-CD"
CALM = "tuning-2026"
# One posting is about 93 KB of JSON, so 50 per page is about 5 MB.
PAGE_SIZE = 50
TIMEOUT_S = 60


class FetchFailed(Exception):
    pass


def windows():
    """Event name -> (first rated day, last rated day, first baseline day, last baseline day)."""
    spans = {}
    for event, (start, end) in EVENTS.items():
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        spans[event] = (first, last, first - timedelta(days=BASELINE_DAYS), first - timedelta(days=1))
    first, last = (date.fromisoformat(day) for day in WINDOWS[CALM])
    spans[CALM] = (first, last, first, last)
    return spans


def to_posting(row):
    """A Supabase row as (posted time in Central, no offset; its hours in time order)."""
    posted = datetime.fromisoformat(row["posted_at"]).astimezone(CENTRAL).replace(tzinfo=None)
    return posted, sorted(row["payload"], key=lambda hour: (hour["operatingDate"], hour["hourEnding"]))


def fetch_postings(url, key, event):
    """Every NP3-233-CD posting saved for one event, oldest first, one page at a time."""
    endpoint = f"{url.rstrip('/')}/rest/v1/ercot_postings"
    params = {"select": "posted_at,payload", "event": f"eq.{event}", "report": f"eq.{REPORT}",
              "order": "posted_at"}
    postings, start = [], 0
    while True:
        try:
            reply = requests.get(endpoint, params=params, timeout=TIMEOUT_S,
                                 headers={"apikey": key, "Range": f"{start}-{start + PAGE_SIZE - 1}"})
        except requests.Timeout:
            raise FetchFailed(f"no answer within {TIMEOUT_S} s") from None
        except requests.RequestException as exc:
            # The exception text can include the request, so only its type is shown.
            raise FetchFailed(f"network error ({type(exc).__name__})") from None
        if not reply.ok:
            raise FetchFailed(f"HTTP {reply.status_code}: {reply.text}")
        page = reply.json()
        postings += [to_posting(row) for row in page]
        if len(page) < PAGE_SIZE:
            return postings
        start += PAGE_SIZE


def current_hour(posted):
    """The (operatingDate, hourEnding) a posting was made in, as rate_posting reads it."""
    return posted.date().isoformat(), posted.hour + 1


def lead_totals(posted, rows):
    """Hour totals from the posting's own hour onward, like make_baseline.totals_by_lead."""
    now = current_hour(posted)
    return [hour_total(row) for row in rows if (row["operatingDate"], row["hourEnding"]) >= now]


def build_baseline(postings):
    """Median outage total at each lead hour, over postings that look at least LEAD_HOURS ahead."""
    kept = [totals for totals in (lead_totals(posted, rows) for posted, rows in postings)
            if len(totals) >= LEAD_HOURS]
    if not kept:
        raise ValueError("no usable postings in the baseline window")
    return {"postings": len(kept),
            "median_mw_by_lead": [float(median(totals[lead] for totals in kept)) for lead in range(LEAD_HOURS)]}


def rateable(postings):
    """Postings that include their own hour; compute_risk cannot rate the others."""
    return [(posted, rows) for posted, rows in postings
            if current_hour(posted) in {(row["operatingDate"], row["hourEnding"]) for row in rows}]


def count_high(postings, baseline, margins, lookahead_hours):
    """At each margin: how many postings rate HIGH, and when the first and last one was posted."""
    by_margin = {}
    for margin in margins:
        high = [posted for posted, rows in postings
                if rate_posting(rows, posted, baseline, margin, lookahead_hours).level == "HIGH"]
        by_margin[f"{margin:g}"] = {"high": len(high),
                                    "first_high": high[0].isoformat() if high else None,
                                    "last_high": high[-1].isoformat() if high else None}
    return by_margin


def check_event(postings, span, margins, lookahead_hours):
    first, last, base_first, base_last = span
    before = [item for item in postings if base_first <= item[0].date() <= base_last]
    during = [item for item in postings if first <= item[0].date() <= last]
    rated = rateable(during)
    baseline = build_baseline(before)
    return {"rated_from": first.isoformat(), "rated_to": last.isoformat(),
            "baseline_from": base_first.isoformat(), "baseline_to": base_last.isoformat(),
            "baseline_postings": baseline["postings"], "in_sample": (first, last) == (base_first, base_last),
            "rated": len(rated), "skipped": len(during) - len(rated),
            "by_margin": count_high(rated, baseline, margins, lookahead_hours)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check the storm rule's margin against saved ERCOT postings.")
    parser.add_argument("--margins", type=float, nargs="+",
                        help="margins to try, in percent (default: 10, the rule's margin, 20)")
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    if not (url and key):
        print("skipped: no_config")
        return 0

    # read_settings() still reads process env; this loader already filled server/.env.
    settings = read_settings()
    margins = sorted(set(args.margins or [10, settings["margin_pct"], 20]))
    results = {}
    try:
        for event, span in windows().items():
            results[event] = check_event(fetch_postings(url, key, event), span, margins,
                                         settings["lookahead_hours"])
    except (FetchFailed, ValueError) as exc:
        print(f"failed: {exc}")
        return 1

    OUT_PATH.write_text(json.dumps({
        "source": f"Supabase public.ercot_postings, ERCOT {REPORT}",
        "rule_margin_pct": settings["margin_pct"], "lookahead_hours": settings["lookahead_hours"],
        "windows": results}, indent=2) + "\n")
    for event, result in results.items():
        note = ", same month (in sample)" if result["in_sample"] else ""
        print(f"{event}: {result['rated']} postings rated ({result['skipped']} skipped),"
              f" baseline {result['baseline_postings']} postings"
              f" {result['baseline_from']} to {result['baseline_to']}{note}")
        for margin, found in result["by_margin"].items():
            when = f", first {found['first_high']}, last {found['last_high']}" if found["high"] else ""
            print(f"  +{margin}%: HIGH {found['high']} of {result['rated']}{when}")
    print(f"wrote {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
