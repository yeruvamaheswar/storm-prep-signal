"""The reserve floor rule. Pure function only: no files, no clock, no network."""
from server.engine.contracts import Policy
from server.engine.controller import STORM_REASONS


def reserve_policy(risk, settings, alerted=None, mode="AUTO", price_usd_mwh=None,
                   price_label=None, zone_prices=None):
    """Pick the reserve floor, then the charge | hold | discharge price band.

    Floor is unchanged: HIGH and a missing signal keep storm_reserve_pct. Pass price_label
    to compute intent; omit it for a floor-only call (intent stays hold). Pass zone_prices
    (zone name to $/MWh) to give each zone its own band in `zone_intent`.
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
    _set_zone_intent(policy, settings, mode, price_label, zone_prices)
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
    # HIGH and a missing signal may charge when cheap. They never discharge.
    storm = policy.risk_level is None or policy.risk_level == "HIGH"
    policy.intent = price_band(price_usd_mwh, settings, storm)


def _set_zone_intent(policy, settings, mode, price_label, zone_prices):
    """Each zone's band from its own price. No zone prices, HOLD, or floor-only: stays empty."""
    priced = {zone: usd for zone, usd in (zone_prices or {}).items() if usd is not None}
    if price_label is None or mode == "HOLD" or not priced:
        return
    for zone in settings.get("zones", {}):
        if zone not in priced:
            # No number for this zone: it follows the headline price, like the whole fleet did.
            policy.zone_intent[zone] = policy.intent
            continue
        # A zone keeping storm backup (fleet storm, missing signal, or its own weather alert)
        # never sells on price, the same rule the fleet follows.
        storm = policy.zone_reasons.get(zone) in STORM_REASONS
        policy.zone_intent[zone] = price_band(priced[zone], settings, storm)


def price_band(usd, settings, storm):
    """charge at or below the charge band, discharge at or above the discharge band, else hold.

    `storm` caps the answer at charge | hold: backup kept for a storm is not sold on price.
    """
    if usd <= settings.get("charge_threshold_usd_mwh", 25):
        return "charge"
    if not storm and usd >= settings.get("discharge_threshold_usd_mwh", 60):
        return "discharge"
    return "hold"


def _zone_floor(zone, policy, alerted, settings):
    # A fleet-wide reason (no signal, or ERCOT HIGH) outranks any single zone's alert.
    if policy.reason != "normal":
        return policy.reserve_pct, policy.reason
    # Zones react only to weather alerts; there is no per-zone ERCOT threshold.
    if zone in alerted:
        return settings["storm_reserve_pct"], "weather_alert"
    return settings["base_reserve_pct"], "normal"
