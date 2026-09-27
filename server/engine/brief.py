"""One or two sentences after the decision. Built only from TickResult fields. No LLM."""
from types import SimpleNamespace

from server.engine.fleet import ZONE_COUNTIES

# Same phrases the wall prints from reasonText(). Live copy must not invent tape prose.
REASON_LINES = {
    "storm_reserve": "Storm reserve raised",
    "fleet_headroom_short": "Not enough headroom above the floor",
    "operator_hold": "Operator hold",
    "signal_unavailable": "Storm signal could not be read",
    "holding_spare_energy": "Holding spare energy",
    "reserve_refill": "Refilling batteries under their reserve floor",
    "charging": "Charging on cheap power",
}

# Why a county's floor was raised (policy.py _county_floor), in the words /flow's REASON_LABEL uses.
COUNTY_REASON_WORDS = {
    "weather_alert_jev_yes": "JEV yes",
    "weather_alert_no_jev": "no JEV reading (fail safe)",
    "weather_alert": "NWS weather alert",
    "storm_risk_high": "ERCOT outage rule HIGH",
    "signal_unavailable": "outage report unreadable (fail safe)",
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


def _zone_counties(result, zone):
    """The zone's roster counties that carry a county floor this tick, as (fips, name), roster order."""
    floors = getattr(result, "county_reserve_pct", None) or {}
    return [(fips, name) for fips, name in ZONE_COUNTIES.get(zone, ()) if fips in floors]


def _raised_by(result, counties):
    """ "Harris raised, JEV yes" for the counties above the zone's lowest county floor, grouped by reason."""
    floors = result.county_reserve_pct
    reasons = getattr(result, "county_reasons", None) or {}
    low = min(floors[fips] for fips, _ in counties)
    groups = {}
    for fips, name in counties:
        if floors[fips] > low:
            groups.setdefault(reasons.get(fips, ""), []).append(name)
    parts = []
    for reason, names in groups.items():
        words = COUNTY_REASON_WORDS.get(reason, reason.replace("_", " "))
        parts.append(f"{' and '.join(names)} raised, {words}" if words else f"{' and '.join(names)} raised")
    return " and ".join(parts)


def zone_floor_notes(result):
    """Zones whose floor differs from the fleet floor, as "Houston 60%: weather_alert".

    Since #47 a zone's floor is its highest county floor, so when its counties keep different floors
    the note names the range and the raised counties: "Houston 30–60% by county: Harris raised, JEV yes".
    """
    notes = []
    floors = getattr(result, "county_reserve_pct", None) or {}
    for zone, pct in result.zone_reserve_pct.items():
        if pct == result.reserve_pct:
            continue
        counties = _zone_counties(result, zone)
        if counties:
            low = min(floors[fips] for fips, _ in counties)
            high = max(floors[fips] for fips, _ in counties)
            if low < high:
                notes.append(f"{zone} {low:g}–{high:g}% by county: {_raised_by(result, counties)}")
                continue
        reason = result.zone_reasons.get(zone)
        notes.append(f"{zone} {pct:g}%: {reason}" if reason else f"{zone} {pct:g}%")
    return notes


def jev_no_zones(result):
    """Zones an alert named whose named counties JEV all said no to, so the base floor was kept."""
    reasons = getattr(result, "county_reasons", None) or {}
    zones = []
    for zone in result.zone_reserve_pct:
        named = [reasons[fips] for fips, _ in _zone_counties(result, zone)
                 if fips in reasons and reasons[fips] != "not_in_alert"]
        if named and all(code == "jev_no" for code in named):
            zones.append(zone)
    return zones


def write_brief(result):
    """One or two sentences from delivered MW, the floor, and the reason codes.

    The floor is named when there are no codes, or when a zone's floor differs from the fleet's.
    """
    delivered = f"Delivered {result.delivered_mw:.2f} of {result.target_mw:.2f} MW"
    lines = [reason_line(code) for code in brief_codes(result)]
    kept = jev_no_zones(result)
    if kept:
        lines = [f"Base floor kept in {' and '.join(kept)}: NWS alert, JEV no", *lines]
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
            county_reserve_pct=dict(tick.get("county_reserve_pct") or {}),
            county_reasons=dict(tick.get("county_reasons") or {}),
        )
    )


def apply_tick_brief(tick):
    """Put generated brief and reasons on a TickView. Live uses this; Demo tape does not."""
    stamped = dict(tick)
    stamped["reasons"] = list(stamped.get("reasons") or [])
    stamped["brief"] = write_brief_from_tick(stamped)
    return stamped
