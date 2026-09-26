"""Load the saved NP3-233-CD postings in data/events/ into the Supabase table public.ercot_postings.

Usage: python scripts/load_ercot_archive.py [--event beryl] [--dry-run]

Each zip in data/events/<event>/raw/ is one posting and becomes one row. Rows are upserted on
(report, posted_at), so running the script again updates rows instead of adding copies.
Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env, except with --dry-run.
"""
import argparse
import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from make_baseline import posting_time  # noqa: E402
from replay_event import EVENTS_DIR, csv_in_zip, read_posting  # noqa: E402

ENV_PATH = ROOT / ".env"
REPORT = "NP3-233-CD"
# One posting is about 93 KB of JSON. 100 per batch (9 MB) sometimes missed the 10 s timeout.
BATCH_SIZE = 25
TIMEOUT_S = 10
# ERCOT names files in Central Prevailing Time with no offset, so we attach it here.
CENTRAL = ZoneInfo("America/Chicago")


class BatchFailed(Exception):
    pass


def event_names(events_dir=EVENTS_DIR):
    """Every folder under data/events/ that has saved posting zips in raw/."""
    return sorted(raw.parent.name for raw in events_dir.glob("*/raw") if any(raw.glob("*.zip")))


def build_rows(event_dir):
    """One table row per saved posting, oldest first."""
    rows = []
    for zip_path in sorted((event_dir / "raw").glob("*.zip")):
        csv_file = csv_in_zip(zip_path)
        rows.append({
            "report": REPORT,
            "posted_at": posting_time(csv_file).replace(tzinfo=CENTRAL).isoformat(),
            "event": event_dir.name,
            "file_name": csv_file.name,
            "payload": read_posting(csv_file),
        })
    return sorted(rows, key=lambda row: row["posted_at"])


def send(rows, url, key, table="ercot_postings", on_conflict="report,posted_at"):
    """POST rows in batches. Raises BatchFailed on the first batch Supabase does not accept."""
    endpoint = f"{url.rstrip('/')}/rest/v1/{table}?on_conflict={on_conflict}"
    headers = {"apikey": key, "Content-Type": "application/json",
               "Prefer": "resolution=merge-duplicates"}
    for start in range(0, len(rows), BATCH_SIZE):
        try:
            reply = requests.post(endpoint, json=rows[start:start + BATCH_SIZE],
                                  headers=headers, timeout=TIMEOUT_S)
        except requests.Timeout:
            raise BatchFailed(f"no answer within {TIMEOUT_S} s") from None
        except requests.RequestException as exc:
            # The exception text can include the request, so only its type is shown.
            raise BatchFailed(f"network error ({type(exc).__name__})") from None
        if not reply.ok:
            raise BatchFailed(f"HTTP {reply.status_code}: {reply.text}")


def main(argv=None):
    events = event_names()
    parser = argparse.ArgumentParser(description="Load saved NP3-233-CD postings into Supabase.")
    parser.add_argument("--event", choices=events, help="load only this event folder")
    parser.add_argument("--dry-run", action="store_true", help="build rows and count them, send nothing")
    args = parser.parse_args(argv)

    load_dotenv(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    if not args.dry_run and not (url and key):
        print("skipped: no_config")
        return 0

    verb = "built (dry run)" if args.dry_run else "sent"
    total = 0
    for event in [args.event] if args.event else events:
        rows = build_rows(EVENTS_DIR / event)
        if not args.dry_run:
            try:
                send(rows, url, key)
            except BatchFailed as exc:
                print(f"{event}: batch failed, {exc}")
                return 1
        print(f"{event}: {len(rows)} rows {verb}")
        total += len(rows)
    print(f"total: {total} rows {verb}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
