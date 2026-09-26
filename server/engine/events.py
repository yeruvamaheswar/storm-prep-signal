"""The one place that writes the run's event log (JSON Lines, one event per line).

The field names are the schema in docs/plan.md. Fields may be added, never renamed.
"""
import json
from datetime import datetime
from pathlib import Path

# The current run's id and log file, set by start_run().
_current = {"run_id": None, "path": None}


def start_run(log_dir):
    """Open a new log file for this run and return its run id."""
    # Microseconds keep two runs in the same second from sharing one log file.
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    _current["run_id"] = run_id
    _current["path"] = log_dir / f"{run_id}.jsonl"
    return run_id


def log_event(stage, event, ok=True, reason=None, **data):
    """Append one event to the run's log.

    Callers pass plain values only, never headers, tokens or credentials.
    """
    if _current["path"] is None:
        raise RuntimeError("start_run() must be called before log_event()")
    record = {
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
        "run_id": _current["run_id"],
        "stage": stage,
        "event": event,
        "ok": ok,
        "reason": reason,
        "data": data,
    }
    with _current["path"].open("a") as log_file:
        # default=str writes datetimes as readable text instead of failing.
        log_file.write(json.dumps(record, default=str) + "\n")
    return record
