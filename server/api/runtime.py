"""Weekend replay clock. Demo can pin an archive posting instead of the layout tape.

layout-run.json is the copy/fallback path when no event folder has a replay.csv.
"""

import csv
from datetime import datetime
from pathlib import Path
from typing import Optional

from server.engine.signal import CENTRAL

REPO_ROOT = Path(__file__).resolve().parents[2]
EVENTS_DIR = REPO_ROOT / "data" / "events"
LAYOUT_RUN = REPO_ROOT / "web" / "src" / "fixtures" / "layout-run.json"
# NP3 fixture posting. stressReading shows this as pinned 12:00 CT.
FIXTURE_CLOCK = "2026-09-25T12:00:00-05:00"
ARCHIVE_EVENTS = ("beryl", "heather", "tuning-2026")


def pin_clock(posted_at: str) -> str:
    """Attach the Central offset so a 2024 posting is never read as 'now'."""
    return datetime.fromisoformat(posted_at).replace(tzinfo=CENTRAL).isoformat()


def _replay_path(events_dir: Path, event: str) -> Optional[Path]:
    path = events_dir / event / "replay.csv"
    return path if path.is_file() else None


def _first_clock(path: Path) -> Optional[str]:
    rows = list(read_replay(path))
    if not rows:
        return None
    return pin_clock(rows[0]["posted_at"])


def read_replay(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def posting_at(path: Path, clock: Optional[str] = None) -> dict:
    """Nearest saved posting to the pinned clock. First row when clock is omitted."""
    rows = read_replay(path)
    if not rows:
        raise FileNotFoundError("empty replay")
    if not clock:
        return rows[0]
    target = datetime.fromisoformat(clock.replace("Z", "+00:00"))
    if target.tzinfo is None:
        target = target.replace(tzinfo=CENTRAL)

    def age(row):
        posted = datetime.fromisoformat(row["posted_at"]).replace(tzinfo=CENTRAL)
        return abs((posted - target).total_seconds())

    row = min(rows, key=age)
    for field in ("peak_mw", "trigger_mw", "houston_mw"):
        raw = row.get(field)
        if isinstance(raw, str) and raw != "":
            row[field] = float(raw) if "." in raw else int(raw)
    return row


def normalize_event(event: Optional[str]) -> Optional[str]:
    if event in ARCHIVE_EVENTS:
        return event
    return None


def discover_runtime(
    event: Optional[str] = None,
    events_dir: Optional[Path] = None,
    clock: Optional[str] = None,
) -> dict:
    """Pick archive replay.csv, or the layout-run.json fallback (the cp path)."""
    folder = events_dir if events_dir is not None else EVENTS_DIR
    chosen = normalize_event(event)
    path = _replay_path(folder, chosen) if chosen else None
    if path is None:
        return {
            "source": "fixture",
            "event": None,
            "clock": FIXTURE_CLOCK,
            "path": LAYOUT_RUN,
        }
    pinned = pin_clock(posting_at(path, clock)["posted_at"]) if clock else _first_clock(path)
    return {
        "source": "archive",
        "event": chosen,
        "clock": pinned or FIXTURE_CLOCK,
        "path": path,
    }
