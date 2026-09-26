"""Rebuild data/baseline_by_lead.json from saved NP3-233-CD MIS CSV files.

Usage: python scripts/make_baseline.py <csv_folder>

For each posting, lead 0 is the hour the posting was made in, lead 1 the hour after, and so on.
The baseline is the median outage total at each lead across all postings, so compute_risk can
compare an hour with what is typical that far ahead.
"""
import csv
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from statistics import median

LEAD_HOURS = 6
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "baseline_by_lead.json"
# cdr.00013103.<id>.YYYYMMDD.HHMMSS.HRLYRESOUTCAPNP3233.csv
PATTERN = "cdr.00013103.*.HRLYRESOUTCAPNP3233.csv"


def posting_time(path):
    date, time = path.name.split(".")[3:5]
    return datetime.strptime(date + time, "%Y%m%d%H%M%S")


def totals_by_lead(path, posted):
    """Hour totals from the posting's current hour onward, in time order."""
    current_hour = posted.replace(minute=0, second=0)
    hours = []
    with path.open(newline="") as file:
        for row in csv.DictReader(file):
            # Hour ending N covers the hour that starts at N-1:00.
            start = datetime.strptime(row["Date"], "%m/%d/%Y") + timedelta(hours=int(row["HourEnding"]) - 1)
            if start >= current_hour:
                total = sum(float(value) for name, value in row.items() if name.startswith("Total"))
                hours.append((start, total))
    return [total for _, total in sorted(hours)]


def main(folder):
    postings = sorted((posting_time(path), path) for path in Path(folder).glob(PATTERN))
    kept = []
    for posted, path in postings:
        totals = totals_by_lead(path, posted)
        if len(totals) >= LEAD_HOURS:
            kept.append((posted, totals))
    if not kept:
        sys.exit(f"no usable postings in {folder}")
    baseline = {
        "source": "ERCOT NP3-233-CD",
        "postings": len(kept),
        "from": kept[0][0].isoformat(),
        "to": kept[-1][0].isoformat(),
        "median_mw_by_lead": [float(median(t[lead] for _, t in kept)) for lead in range(LEAD_HOURS)],
    }
    OUT_PATH.write_text(json.dumps(baseline) + "\n")
    print(f"wrote {OUT_PATH}: {len(kept)} postings")


if __name__ == "__main__":
    main(sys.argv[1])
