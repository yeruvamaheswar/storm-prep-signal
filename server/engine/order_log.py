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


def _key(command_id):
    return "r" if str(command_id).endswith(":r") else "own"


def order_timelines(events, per_home_kw):
    """Return {home_id: [[t, kind, extra, key], ...]} for orders in one tick.

    `per_home_kw` is the plan's signed kW by original home id. Reassigned child
    commands get their sent extra from the reassignment event's kW because they
    are not original plan entries.
    """
    timelines = {}
    sent = set()
    next_message = {}
    explicit_command_kw = {}

    for event in events:
        command_id = str(event.get("command_id") or "")
        if not command_id or command_id.startswith("telemetry:"):
            continue
        kind = event.get("kind")
        home_id = _home_id(event)
        t = _stamp(event)

        if kind == "sent":
            direction = next_message.get(command_id, "order")
            if command_id in sent:
                continue
            sent.add(command_id)
            if direction != "order":
                continue
            extra = explicit_command_kw.get(command_id)
            if extra is None:
                extra = per_home_kw.get(home_id)
            _append(timelines, home_id, [t, "sent", extra, _key(command_id)])
        elif kind == "dropped":
            direction = next_message.get(command_id, "order")
            _append(timelines, home_id, [t, "rdrop" if direction == "report" else "drop", None, _key(command_id)])
            next_message[command_id] = "report" if direction == "order" else "order"
        elif kind == "executed":
            next_message[command_id] = "report"
            _append(timelines, home_id, [t, "exec", event.get("actual_kw"), _key(command_id)])
        elif kind == "retry":
            next_message[command_id] = "order"
            _append(timelines, home_id, [t, "retry", None, _key(command_id)])
        elif kind == "reassigned":
            parent = str(event.get("parent_command_id") or "")
            parent_home = parent.split(":", 1)[0]
            child_home = str(event.get("home_id") or command_id.split(":", 1)[0])
            explicit_command_kw[command_id] = event.get("kw")
            _append(timelines, parent_home, [t, "reassigned", child_home, _key(parent)])
        elif kind == "reassign_failed":
            _append(timelines, home_id, [t, "reassign_failed", None, _key(command_id)])
        elif kind == "duplicate_ignored":
            next_message[command_id] = "report"
            _append(timelines, home_id, [t, "dup", None, _key(command_id)])
        elif kind in ("confirmed", "charge_confirmed"):
            _append(timelines, home_id, [t, "conf", event.get("actual_kw"), _key(command_id)])
        elif kind == "timed_out":
            _append(timelines, home_id, [t, "timeout", None, _key(command_id)])
        elif kind == "charge_mismatch":
            _append(timelines, home_id, [t, "mismatch", event.get("reported_kwh"), _key(command_id)])
        elif kind == "late_report":
            _append(timelines, home_id, [t, "late", event.get("actual_kw"), _key(command_id)])

    return {home_id: sorted(rows, key=lambda row: row[0]) for home_id, rows in timelines.items()}
