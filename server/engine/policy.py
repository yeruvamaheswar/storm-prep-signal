"""The reserve floor rule. Pure function only: no files, no clock, no network."""
from server.engine.contracts import Policy


def reserve_policy(risk, settings, alerted=None, mode="AUTO", price_usd_mwh=None,
                   price_label=None):
    """Pick the reserve floor, then charge | hold | discharge intent.

    Floor is unchanged: HIGH and a missing signal keep storm_reserve_pct. Intent is a
    label. allocate still only discharges. Pass price_label to compute intent; omit it
    for a floor-only call (intent stays hold).
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
    _set_intent(policy, settings, mode, price_usd_mwh, price_label)
    return policy


def _set_intent(policy, settings, mode, price_usd_mwh, price_label):
    # Floor-only callers omit the label. The tick loop always passes one, including "none".
    if price_label is None:
        return
    if mode == "HOLD":
        policy.intent = "hold"
        policy.intent_reason = "operator_hold"
        return
    if price_label == "none" or price_usd_mwh is None:
        policy.intent = "hold"
        policy.intent_reason = "price_unavailable"
        return
    charge_at = settings.get("charge_threshold_usd_mwh", 25)
    # HIGH and a missing signal may charge when cheap. They never discharge.
    if policy.risk_level is None or policy.risk_level == "HIGH":
        policy.intent = "charge" if price_usd_mwh <= charge_at else "hold"
        return
    discharge_at = settings.get("discharge_threshold_usd_mwh", 60)
    if price_usd_mwh <= charge_at:
        policy.intent = "charge"
    elif price_usd_mwh >= discharge_at:
        policy.intent = "discharge"
    else:
        policy.intent = "hold"


def _zone_floor(zone, policy, alerted, settings):
    # A fleet-wide reason (no signal, or ERCOT HIGH) outranks any single zone's alert.
    if policy.reason != "normal":
        return policy.reserve_pct, policy.reason
    # Zones react only to weather alerts; there is no per-zone ERCOT threshold.
    if zone in alerted:
        return settings["storm_reserve_pct"], "weather_alert"
    return settings["base_reserve_pct"], "normal"
