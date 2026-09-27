"""The reserve floor rule. Pure function only: no files, no clock, no network."""
from server.engine.contracts import Policy
from server.engine.controller import STORM_REASONS
from server.engine.fleet import zone_counties

COUNTY_RAISED = ("weather_alert",)


def reserve_policy(risk, settings, alerted=None, mode="AUTO", price_usd_mwh=None,
                   price_label=None, zone_prices=None, county_alerts=None, dam_hours=None,
                   zone_hours_needed=None):
    """Pick the reserve floor, then the charge | hold | discharge price band.

    Floor is unchanged: HIGH and a missing signal keep storm_reserve_pct. Pass price_label
    to compute intent; omit it for a floor-only call (intent stays hold). Pass zone_prices
    (zone name to $/MWh) to give each zone its own band in `zone_intent`. Pass county_alerts
    (county FIPS named by an active alert to that alert's NWS event name): a named county
    keeps the storm reserve, and the zone's other roster counties keep the base floor.
    Pass dam_hours (zone to the next 24 h of [{hour_start, usd_mwh}], current hour first) with
    zone_hours_needed (zone to hours of charging that fill it) to replace a zone's $25 charge
    test with the cheapest-DAM-hours rule (`dam_charge`).
    """
    # No signal means we can't rule out a storm, so fail safe and keep the larger reserve.
    if risk is None:
        policy = Policy(settings["storm_reserve_pct"], "signal_unavailable", None)
    elif risk.level == "HIGH":
        policy = Policy(settings["storm_reserve_pct"], "storm_risk_high", "HIGH")
    else:
        policy = Policy(settings["base_reserve_pct"], "normal", "LOW")

    alerted = alerted or {}
    raised = {}   # zone name to the floors of its raised counties
    if county_alerts:
        roster = zone_counties(settings)
        named_zones = {zone for zone, fips, _ in roster if fips in county_alerts}
        # Every county of a named zone gets its own floor, so a county the alert skipped
        # never falls back to the zone's raised floor.
        for zone, fips, _ in roster:
            if zone not in named_zones:
                continue
            pct, reason = _county_floor(zone, fips in county_alerts, policy, alerted, settings)
            policy.county_reserve_pct[fips] = pct
            policy.county_reasons[fips] = reason
            if reason in COUNTY_RAISED:
                raised.setdefault(zone, []).append(pct)
    for zone in settings.get("zones", {}):
        pct, reason = _zone_floor(zone, policy, alerted, raised, settings)
        policy.zone_reserve_pct[zone] = pct
        policy.zone_reasons[zone] = reason
    _set_intent(policy, settings, mode, price_usd_mwh, price_label)
    _set_zone_intent(policy, settings, mode, price_label, zone_prices, dam_hours, zone_hours_needed)
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


def _set_zone_intent(policy, settings, mode, price_label, zone_prices, dam_hours=None,
                     zone_hours_needed=None):
    """Each zone's band from its own price, and its DAM hours when it has them.

    No zone prices and no DAM hours, HOLD, or floor-only: stays empty.
    """
    priced = {zone: usd for zone, usd in (zone_prices or {}).items() if usd is not None}
    needed = zone_hours_needed or {}
    # The DAM rule needs both the hours and how much charge the zone takes.
    dam = {zone: hours for zone, hours in (dam_hours or {}).items() if hours and zone in needed}
    if price_label is None or mode == "HOLD" or not (priced or dam):
        return
    for zone in settings.get("zones", {}):
        # A zone keeping storm backup (fleet storm, missing signal, or its own weather alert)
        # never sells on price, the same rule the fleet follows.
        storm = policy.zone_reasons.get(zone) in STORM_REASONS
        if zone in priced:
            band = price_band(priced[zone], settings, storm)
        elif storm and policy.intent == "discharge":
            # No number: follow the headline band, but an alerted zone holds instead of selling.
            band = "hold"
        else:
            band = policy.intent
        if zone in dam:
            chosen, why, charge = dam_charge(dam[zone], priced.get(zone), needed[zone], settings)
            policy.zone_charge_hours[zone] = chosen
            if band == "discharge":
                policy.zone_charge_why[zone] = "sell_band"
            else:
                policy.zone_charge_why[zone] = why
                band = "charge" if charge else "hold"
        policy.zone_intent[zone] = band


def dam_charge(hours, rt_usd, hours_needed, settings):
    """(chosen hour starts, why, charge?) for one zone from its next 24 DAM hours, current hour first.

    Chosen: the hours_needed cheapest hours before the first later hour in the sell band (the
    battery would sell into that hour first), ties to the earlier. Charge now when this hour is
    chosen, or the real-time price is at or below the dearest chosen hour (a dip the forecast
    missed), and some later hour in the whole window, spike included, pays back: later DAM
    price x round trip > the price now. `before_spike` when the cut changed the chosen hours.
    """
    if hours_needed <= 0:
        return [], "full", False
    sell_at = settings.get("discharge_threshold_usd_mwh", 60)
    spike = next((i for i in range(1, len(hours)) if hours[i]["usd_mwh"] >= sell_at), len(hours))
    chosen = _cheapest(hours[:spike], hours_needed)
    starts = [hours[i]["hour_start"] for i in chosen]
    dearest = max(hours[i]["usd_mwh"] for i in chosen)
    in_chosen = chosen[0] == 0
    dip = rt_usd is not None and rt_usd <= dearest
    if not (in_chosen or dip):
        return starts, "cheaper_hour_later", False
    now_usd = rt_usd if rt_usd is not None else hours[0]["usd_mwh"]
    keep = settings.get("round_trip_pct", 89) / 100
    if not any(hour["usd_mwh"] * keep > now_usd for hour in hours[1:]):
        return starts, "no_payback", False
    if not in_chosen:
        return starts, "rt_dip", True
    return starts, "dam_cheap_hour" if chosen == _cheapest(hours, hours_needed) else "before_spike", True


def _cheapest(hours, count):
    """Indexes of the count cheapest hours, ties to the earlier, in time order."""
    return sorted(sorted(range(len(hours)), key=lambda i: (hours[i]["usd_mwh"], i))[:count])


def price_band(usd, settings, storm):
    """charge at or below the charge band, discharge at or above the discharge band, else hold.

    `storm` caps the answer at charge | hold: backup kept for a storm is not sold on price.
    """
    if usd <= settings.get("charge_threshold_usd_mwh", 25):
        return "charge"
    if not storm and usd >= settings.get("discharge_threshold_usd_mwh", 60):
        return "discharge"
    return "hold"


def _zone_floor(zone, policy, alerted, raised, settings):
    # A fleet-wide reason (no signal, or ERCOT HIGH) outranks any single zone's alert.
    if policy.reason != "normal":
        return policy.reserve_pct, policy.reason
    # Zones react only to weather alerts; there is no per-zone ERCOT threshold.
    if zone in alerted:
        return settings["storm_reserve_pct"], "weather_alert"
    # A zone with any raised county never sells on price; its floor is the highest county floor.
    if zone in raised:
        return max(raised[zone]), "weather_alert"
    return settings["base_reserve_pct"], "normal"


def _county_floor(zone, named, policy, alerted, settings):
    # Fleet-wide reasons, and a whole-zone alert with no county detail, outrank the county rule.
    if policy.reason != "normal":
        return policy.reserve_pct, policy.reason
    if zone in alerted:
        return settings["storm_reserve_pct"], "weather_alert"
    # Any alert that names the county keeps the storm reserve, whatever the alert type.
    if named:
        return settings["storm_reserve_pct"], "weather_alert"
    return settings["base_reserve_pct"], "not_in_alert"
