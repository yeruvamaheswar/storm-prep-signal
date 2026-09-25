"""Load an NP3-233-CD response and turn it into the signal that compute_risk reads."""
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

# ERCOT writes times in Central Prevailing Time with no offset, so we attach the zone ourselves.
CENTRAL = ZoneInfo("America/Chicago")
FIXTURE_PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "np3_233_cd.json"


def rows_by_name(raw):
    """Turn each data row (a plain list) into a dict keyed by the names in `fields`.

    ERCOT describes the columns in `fields`, so we never depend on column positions.
    """
    names = [field["name"] for field in raw["fields"]]
    return [dict(zip(names, values)) for values in raw["data"]]


def newest_posting_time(rows):
    # The timestamps share one format, so the largest string is the newest posting.
    return max(row["postedDatetime"] for row in rows)


def parse_central(text):
    return datetime.fromisoformat(text).replace(tzinfo=CENTRAL)


def load_signal(args):
    """Read a saved response given by --fixture or --file.

    File modes pin the clock to the posting time so a saved file rates the same way every run.
    """
    path = FIXTURE_PATH if args.fixture else Path(args.file)
    raw = json.loads(path.read_text())
    # A top-level "_note" marks a hand-edited file, so the decision line can say so.
    source = "fixture (synthetic)" if "_note" in raw else "fixture"
    now = parse_central(newest_posting_time(rows_by_name(raw)))
    return {"raw": raw, "now": now, "source": source, "clock_pinned": True, "path": str(path)}


def to_signal(raw, now):
    """Build the plain dict that compute_risk needs. Pure: the clock comes in as `now`."""
    rows = rows_by_name(raw)
    newest = newest_posting_time(rows)
    # Only the newest posting counts; older postings are outdated forecasts.
    posting = [row for row in rows if row["postedDatetime"] == newest]
    posting.sort(key=lambda row: (row["operatingDate"], row["hourEnding"]))
    local_now = now.astimezone(CENTRAL)
    return {
        "posted_at": parse_central(newest),
        "current_date": local_now.date().isoformat(),
        # Hour ending N is the hour that finishes at N:00, so 12:00-12:59 is HE13.
        "current_hour_ending": local_now.hour + 1,
        "rows": posting,
    }
