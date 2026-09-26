"""The reserve floor rule. Pure function only: no files, no clock, no network."""
from storm_prep.contracts import Policy


def reserve_policy(risk, settings, alerted=None):
    """Pick how much charge every home must keep back, from the risk result.

    alerted maps zone name to the weather alert's event name, or is None when no alerts.
    """
    # No signal means we can't rule out a storm, so fail safe and keep the larger reserve.
    if risk is None:
        policy = Policy(settings["storm_reserve_pct"], "signal_unavailable", None)
    elif risk.level == "HIGH":
        policy = Policy(settings["storm_reserve_pct"], "storm_risk_high", "HIGH")
    else:
        policy = Policy(settings["base_reserve_pct"], "normal", "LOW")

    alerted = alerted or {}
    for zone in settings.get("zones", {}):
        pct, reason = _zone_floor(zone, policy, alerted, settings)
        policy.zone_reserve_pct[zone] = pct
        policy.zone_reasons[zone] = reason
    return policy


def _zone_floor(zone, policy, alerted, settings):
    # A fleet-wide reason (no signal, or ERCOT HIGH) outranks any single zone's alert.
    if policy.reason != "normal":
        return policy.reserve_pct, policy.reason
    # Zones react only to weather alerts; there is no per-zone ERCOT threshold.
    if zone in alerted:
        return settings["storm_reserve_pct"], "weather_alert"
    return settings["base_reserve_pct"], "normal"
