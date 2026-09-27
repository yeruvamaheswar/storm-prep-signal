"""Compact per-home order timelines for Replay.

The orchestration event log is the source of truth. This module only filters and
normalizes it so the UI can animate one tick without carrying transport noise.
"""

NORMAL_KINDS = {
    "sent",
    "drop",
    "exec",
    "rdrop",
    "retry",
    "reassigned",
    "reassign_failed",
    "dup",
    "conf",
    "timeout",
    "mismatch",
    "late",
}


def _home_id(event):
    command_id = str(event.get("command_id") or "")
    return str(event.get("home_id") or command_id.split(":", 1)[0])


def _stamp(event):
    return round(float(event.get("t", 0.0)), 1)


def _append(timelines, home_id, event):
    if home_id:
        timelines.setdefault(home_id, []).append(event)


def order_timelines(events, per_home_kw):
    """Return {home_id: [[t, kind, extra], ...]} for orders in one tick.

    `per_home_kw` is the plan's signed kW by original home id. Reassigned child
    commands get their sent extra from the reassignment event's kW because they
    are not original plan entries.
    """
    timelines = {}
    sent = set()
    executed = set()
    explicit_command_kw = {}

    for event in events:
        command_id = str(event.get("command_id") or "")
        if not command_id or command_id.startswith("telemetry:"):
            continue
        kind = event.get("kind")
        home_id = _home_id(event)
        t = _stamp(event)

        if kind == "sent":
            if command_id in sent or command_id in executed:
                continue
            sent.add(command_id)
            extra = explicit_command_kw.get(command_id)
            if extra is None:
                extra = per_home_kw.get(home_id)
            _append(timelines, home_id, [t, "sent", extra])
        elif kind == "dropped":
            _append(timelines, home_id, [t, "rdrop" if command_id in executed else "drop", None])
        elif kind == "executed":
            executed.add(command_id)
            _append(timelines, home_id, [t, "exec", event.get("actual_kw")])
        elif kind == "retry":
            _append(timelines, home_id, [t, "retry", None])
        elif kind == "reassigned":
            parent = str(event.get("parent_command_id") or "")
            parent_home = parent.split(":", 1)[0]
            child_home = str(event.get("home_id") or command_id.split(":", 1)[0])
            explicit_command_kw[command_id] = event.get("kw")
            _append(timelines, parent_home, [t, "reassigned", child_home])
        elif kind == "reassign_failed":
            _append(timelines, home_id, [t, "reassign_failed", None])
        elif kind == "duplicate_ignored":
            _append(timelines, home_id, [t, "dup", None])
        elif kind in ("confirmed", "charge_confirmed"):
            _append(timelines, home_id, [t, "conf", event.get("actual_kw")])
        elif kind == "timed_out":
            _append(timelines, home_id, [t, "timeout", None])
        elif kind == "charge_mismatch":
            _append(timelines, home_id, [t, "mismatch", event.get("reported_kwh")])
        elif kind == "late_report":
            _append(timelines, home_id, [t, "late", event.get("actual_kw")])

    return {home_id: sorted(rows, key=lambda row: row[0]) for home_id, rows in timelines.items()}
