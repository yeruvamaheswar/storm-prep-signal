"""Load the lead-matched baseline that compute_risk compares against.

The file is built from past postings by scripts/make_baseline.py.
"""
import json
from datetime import datetime
from pathlib import Path

BASELINE_PATH = Path(__file__).resolve().parent.parent / "data" / "baseline_by_lead.json"


class BaselineError(ValueError):
    """The baseline file is missing or too short: a setup error, never a signal problem."""


def load_baseline(path=BASELINE_PATH, lookahead_hours=6):
    path = Path(path)
    if not path.exists():
        raise BaselineError(f"baseline file missing: {path} (run scripts/make_baseline.py)")
    baseline = json.loads(path.read_text())
    count = len(baseline["median_mw_by_lead"])
    # compute_risk needs a typical value for every hour in the look-ahead window.
    if count < lookahead_hours:
        raise BaselineError(f"baseline too short: {count} lead hours in {path}, need {lookahead_hours}")
    return baseline


def baseline_span(baseline):
    """The dates the baseline covers, for the decision line, e.g. "Aug 25-Sep 25"."""
    start, end = (datetime.fromisoformat(baseline[key]) for key in ("from", "to"))
    return f"{start:%b} {start.day}-{end:%b} {end.day}"
