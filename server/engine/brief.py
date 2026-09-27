"""One or two sentences after the decision. Built only from TickResult fields. No LLM."""
from types import SimpleNamespace

# Same phrases the wall prints from reasonText(). Live copy must not invent tape prose.
REASON_LINES = {
    "storm_reserve": "Storm reserve raised",
    "fleet_headroom_short": "Not enough headroom above the floor",
    "operator_hold": "Operator hold",
    "signal_unavailable": "Storm signal could not be read",
    "holding_spare_energy": "Holding spare energy",
    "reserve_refill": "Refilling batteries under their reserve floor",
}


def reason_line(code):
    """Operator English for one reason code, including homes_dead:n and homes_stale:n."""
    known = REASON_LINES.get(code)
    if known is not None:
        return known
    for prefix, state in (("homes_dead:", "dead"), ("homes_stale:", "stale")):
        if code.startswith(prefix):
            raw = code[len(prefix) :]
            try:
                count = int(raw)
            except ValueError:
                return f"{raw} homes are {state}"
            if count == 1:
                return f"1 home is {state}"
            return f"{count} homes are {state}"
    return code.replace("_", " ").replace(":", " ")


def brief_codes(result):
    """Reasons on the tick, plus signal_unavailable from the policy when it is the fail-safe."""
    codes = list(result.reasons)
    if result.policy_reason == "signal_unavailable" and "signal_unavailable" not in codes:
        codes = ["signal_unavailable", *codes]
    return codes


def _join_clauses(lines):
    first, *rest = lines
    parts = [first]
    for line in rest:
        if line:
            parts.append(line[:1].lower() + line[1:])
    return "; ".join(parts)


def zone_floor_notes(result):
    """Zones whose floor differs from the fleet floor, as "Houston 60%: weather_alert"."""
    notes = []
    for zone, pct in result.zone_reserve_pct.items():
        if pct == result.reserve_pct:
            continue
        reason = result.zone_reasons.get(zone)
        notes.append(f"{zone} {pct:g}%: {reason}" if reason else f"{zone} {pct:g}%")
    return notes


def write_brief(result):
    """One or two sentences from delivered MW, the floor, and the reason codes.

    The floor is named when there are no codes, or when a zone's floor differs from the fleet's.
    """
    delivered = f"Delivered {result.delivered_mw:.2f} of {result.target_mw:.2f} MW"
    lines = [reason_line(code) for code in brief_codes(result)]
    notes = zone_floor_notes(result)
    if notes:
        lines = [f"Floor {result.reserve_pct:g}% ({', '.join(notes)})", *lines]
    if not lines:
        return f"{delivered}. Floor {result.reserve_pct:g}%."
    return f"{delivered}. {_join_clauses(lines)}."


def write_brief_from_tick(tick):
    """Same sentences as write_brief, from a TickView dict the snapshot already holds."""
    return write_brief(
        SimpleNamespace(
            delivered_mw=float(tick.get("delivered_mw") or 0),
            target_mw=float(tick.get("target_mw") or 0),
            reserve_pct=float(tick.get("reserve_pct") or 0),
            reasons=list(tick.get("reasons") or []),
            policy_reason=str(tick.get("policy_reason") or ""),
            zone_reserve_pct=dict(tick.get("zone_reserve_pct") or {}),
            zone_reasons=dict(tick.get("zone_reasons") or {}),
        )
    )


def apply_tick_brief(tick):
    """Put generated brief and reasons on a TickView. Live uses this; Demo tape does not."""
    stamped = dict(tick)
    stamped["reasons"] = list(stamped.get("reasons") or [])
    stamped["brief"] = write_brief_from_tick(stamped)
    return stamped
