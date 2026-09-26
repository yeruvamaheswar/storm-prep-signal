"""Copy one local engine run into public.runs. Best effort. The wall still reads latest.json.

Usage: python scripts/persist_run.py [var/runs/latest.json]
`python -m server.engine` calls persist_after_run() after loop.run() writes the files.
The engine never imports this module during a tick.

Needs SUPABASE_URL and SUPABASE_SECRET_KEY in server/.env.
PostgREST upsert is on run_id. OpenAPI requires run_id, source, and result (ticks JSON).
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]

from load_ercot_archive import BatchFailed, send  # noqa: E402
from server.env import ENV_PATH, load_env  # noqa: E402
from server.engine.signal import LIVE_PATH, newest_posting_time, parse_central, rows_by_name  # noqa: E402

SOURCES = ("live", "scenario", "fixture")
HEADER = (
    "tick", "ts", "mode", "target_mw", "delivered_mw", "missed_mw",
    "reserve_pct", "risk_level", "policy_reason", "live_homes",
    "stale_homes", "dead_homes", "breaches", "price_usd_mwh", "price_label",
)
TIMEOUT_S = 10
REPORT = "NP3-233-CD"


def source_of(record):
    raw = record.get("source")
    return raw if raw in SOURCES else "fixture"


def tape_label_for(record, root=ROOT):
    tape = record.get("tape")
    if not tape:
        return record.get("run_id") or "unknown"
    if tape == "synthetic":
        return "synthetic"
    path = Path(tape)
    if not path.is_file():
        path = root / tape
    try:
        label = json.loads(path.read_text()).get("label")
    except (OSError, ValueError):
        return Path(tape).name
    return label if isinstance(label, str) and label else Path(tape).name


def summary_of(ticks):
    if not ticks:
        return {"tick_count": 0}
    last = ticks[-1]
    out = {key: last[key] for key in HEADER if key in last}
    out["tick_count"] = len(ticks)
    return out


def row_from_record(record, git_sha=None, posting_ids=None):
    """Map a var/runs/<id>.json record onto the unused public.runs OpenAPI row."""
    ticks = record["ticks"] if isinstance(record.get("ticks"), list) else []
    row = {
        "run_id": record["run_id"],
        "source": source_of(record),
        "tape_label": tape_label_for(record),
        "ercot_posting_ids": list(posting_ids or []),
        "summary": summary_of(ticks),
        "result": ticks,
    }
    if git_sha:
        row["git_sha"] = git_sha
    return row


def posted_at_from_signal(path):
    raw = json.loads(Path(path).read_text())
    return parse_central(newest_posting_time(rows_by_name(raw))).isoformat()


def posting_refs(record, root=ROOT, live_path=LIVE_PATH):
    """(report, posted_at) pairs for the posting(s) the run actually used."""
    refs = []
    tape = record.get("tape")
    if tape and tape != "synthetic":
        path = Path(tape) if Path(tape).is_file() else root / tape
        try:
            frames = json.loads(path.read_text()).get("frames") or []
        except (OSError, ValueError):
            frames = []
        for frame in frames:
            fixture = frame.get("risk_fixture")
            if not fixture:
                continue
            fixture_path = Path(fixture) if Path(fixture).is_file() else root / fixture
            try:
                refs.append((REPORT, posted_at_from_signal(fixture_path)))
            except (OSError, ValueError, KeyError):
                continue
    if record.get("source") == "live":
        live = Path(live_path)
        if not live.is_file():
            live = root / live_path
        try:
            refs.append((REPORT, posted_at_from_signal(live)))
        except (OSError, ValueError, KeyError):
            pass
    unique = []
    for item in refs:
        if item not in unique:
            unique.append(item)
    return unique


def lookup_posting_ids(refs, url, key, get=requests.get):
    """Resolve ercot_postings.id. A miss stays off the list; the run still upserts."""
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    ids = []
    for report, posted_at in refs:
        try:
            reply = get(
                f"{url.rstrip('/')}/rest/v1/ercot_postings",
                params={"select": "id", "report": f"eq.{report}",
                        "posted_at": f"eq.{posted_at}", "limit": 1},
                headers=headers, timeout=TIMEOUT_S,
            )
        except requests.RequestException:
            continue
        if not reply.ok:
            continue
        try:
            rows = reply.json()
        except ValueError:
            continue
        if rows:
            ids.append(int(rows[0]["id"]))
    return ids


def read_git_sha(root=ROOT):
    try:
        sha = subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            text=True, timeout=3,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return sha or None


def persist_record(record, url, key, git_sha=None, lookup=None):
    if not (url and key):
        return "skipped: no_config"
    try:
        ids = (lookup or lookup_posting_ids)(posting_refs(record), url, key)
    except Exception:
        ids = []
    sha = git_sha if git_sha is not None else read_git_sha()
    row = row_from_record(record, git_sha=sha, posting_ids=ids)
    try:
        send([row], url, key, table="runs", on_conflict="run_id")
    except BatchFailed as exc:
        return f"skipped: {exc}"
    return "ok"


def persist_latest(path=None, url=None, key=None, **kwargs):
    load_env(ENV_PATH)
    url = os.getenv("SUPABASE_URL", "") if url is None else url
    key = os.getenv("SUPABASE_SECRET_KEY", "") if key is None else key
    path = Path(path or Path("var") / "runs" / "latest.json")
    if not path.is_file():
        return "skipped: no_file"
    try:
        record = json.loads(path.read_text())
    except ValueError:
        return "skipped: bad_json"
    if not isinstance(record, dict) or not record.get("run_id"):
        return "skipped: bad_json"
    return persist_record(record, url, key, **kwargs)


def persist_after_run():
    print(f"runs_{persist_latest()}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Copy a local engine run into public.runs.")
    parser.add_argument("path", nargs="?", default=str(Path("var") / "runs" / "latest.json"))
    parser.add_argument("--dry-run", action="store_true", help="print the row, send nothing")
    args = parser.parse_args(argv)

    load_env(ENV_PATH)
    url, key = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
    path = Path(args.path)
    if not path.is_file():
        print("runs_skipped: no_file")
        return 0
    try:
        record = json.loads(path.read_text())
    except ValueError:
        print("runs_skipped: bad_json")
        return 0
    if not isinstance(record, dict) or not record.get("run_id"):
        print("runs_skipped: bad_json")
        return 0
    if args.dry_run:
        row = row_from_record(record, git_sha=read_git_sha())
        print(f"runs_built: {row['run_id']} {row['source']}")
        return 0
    if not (url and key):
        print("runs_skipped: no_config")
        return 0
    print(f"runs_{persist_record(record, url, key)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
