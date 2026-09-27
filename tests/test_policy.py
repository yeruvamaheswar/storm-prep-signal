"""The reserve floor for each risk outcome, including a missing signal."""
from server.engine.contracts import Home, Policy
from server.engine.policy import reserve_policy
from server.engine.risk import RiskResult

SETTINGS = {"base_reserve_pct": 30, "storm_reserve_pct": 60}  # example, not Base specs
# Charge/discharge bands are simulation knobs, not Base specs.
INTENT_SETTINGS = {**SETTINGS, "charge_threshold_usd_mwh": 25, "discharge_threshold_usd_mwh": 60}


def make_risk(level):
    # Only the level matters to the policy; the other numbers are placeholders.
    return RiskResult(level=level, peak_mw=0, peak_hour=1, baseline_mw=0, trigger_mw=0,
                      margin_mw=0, peak_lead=0, driving_zone="North", zone_mw={})


def test_high_risk_keeps_storm_reserve():
    policy = reserve_policy(make_risk("HIGH"), SETTINGS)
    assert policy == Policy(reserve_pct=60, reason="storm_risk_high", risk_level="HIGH")


def test_low_risk_keeps_base_reserve():
    policy = reserve_policy(make_risk("LOW"), SETTINGS)
    assert policy == Policy(reserve_pct=30, reason="normal", risk_level="LOW")


def test_missing_signal_fails_safe_to_storm_reserve():
    policy = reserve_policy(None, SETTINGS)
    assert policy == Policy(reserve_pct=60, reason="signal_unavailable", risk_level=None)


ZONE_SETTINGS = {**SETTINGS, "zones": {"Houston": "48201", "North": "48113",
                                       "South": "48355", "West": "48329"}}
ZONES = list(ZONE_SETTINGS["zones"])


def test_alert_in_houston_raises_only_houston():
    policy = reserve_policy(make_risk("LOW"), ZONE_SETTINGS, {"Houston": "Hurricane Warning"})
    assert (policy.reserve_pct, policy.reason, policy.risk_level) == (30, "normal", "LOW")
    assert policy.zone_reserve_pct == {"Houston": 60, "North": 30, "South": 30, "West": 30}
    assert policy.zone_reasons == {"Houston": "weather_alert", "North": "normal",
                                   "South": "normal", "West": "normal"}


def test_ercot_high_outranks_a_zone_alert():
    policy = reserve_policy(make_risk("HIGH"), ZONE_SETTINGS, {"Houston": "Hurricane Warning"})
    assert policy.zone_reserve_pct == {zone: 60 for zone in ZONES}
    assert policy.zone_reasons == {zone: "storm_risk_high" for zone in ZONES}


def test_missing_signal_fails_safe_in_every_zone():
    policy = reserve_policy(None, ZONE_SETTINGS, {"Houston": "Hurricane Warning"})
    assert policy.zone_reserve_pct == {zone: 60 for zone in ZONES}
    assert policy.zone_reasons == {zone: "signal_unavailable" for zone in ZONES}


def test_no_alerted_argument_matches_today():
    today = {"HIGH": (60, "storm_risk_high", "HIGH"), "LOW": (30, "normal", "LOW"),
             None: (60, "signal_unavailable", None)}
    for level, expected in today.items():
        risk = make_risk(level) if level else None
        policy = reserve_policy(risk, ZONE_SETTINGS)
        assert policy == reserve_policy(risk, ZONE_SETTINGS, None)
        assert (policy.reserve_pct, policy.reason, policy.risk_level) == expected
        assert policy.zone_reserve_pct == {zone: expected[0] for zone in ZONES}
        assert policy.zone_reasons == {zone: expected[1] for zone in ZONES}


def decide(risk, mode="AUTO", price=40, label="ercot"):
    """Reserve plus intent. Floor-only callers omit price/label and stay hold."""
    return reserve_policy(risk, INTENT_SETTINGS, mode=mode,
                          price_usd_mwh=price, price_label=label)


def test_operator_hold_intents_hold():
    # HOLD outranks a cheap price (would charge) and a high price (would discharge).
    cheap = decide(make_risk("LOW"), mode="HOLD", price=10)
    expensive = decide(make_risk("LOW"), mode="HOLD", price=80)
    assert cheap.intent == expensive.intent == "hold"
    assert cheap.intent_reason == expensive.intent_reason == "operator_hold"
    assert (cheap.reserve_pct, cheap.reason) == (30, "normal")


def test_missing_signal_holds_or_charges_never_discharges():
    cheap = decide(None, price=10)
    mid = decide(None, price=40)
    expensive = decide(None, price=80)
    assert cheap.intent == "charge"
    assert mid.intent == expensive.intent == "hold"
    assert expensive.intent != "discharge"


def test_high_risk_holds_or_charges_never_discharges():
    cheap = decide(make_risk("HIGH"), price=10)
    mid = decide(make_risk("HIGH"), price=40)
    expensive = decide(make_risk("HIGH"), price=80)
    assert cheap.intent == "charge"
    assert mid.intent == expensive.intent == "hold"
    assert expensive.intent != "discharge"
    assert cheap.reason == "storm_risk_high"


def test_low_auto_uses_price_thresholds():
    # Inclusive bands: <= 25 charge, >= 60 discharge, in between hold.
    assert decide(make_risk("LOW"), price=25).intent == "charge"
    assert decide(make_risk("LOW"), price=60).intent == "discharge"
    assert decide(make_risk("LOW"), price=40).intent == "hold"


def test_missing_price_holds_with_price_unavailable():
    policy = decide(make_risk("LOW"), price=None, label="none")
    assert policy.intent == "hold"
    assert policy.intent_reason == "price_unavailable"
    # Floor stays the LOW reserve; price only picks intent.
    assert (policy.reserve_pct, policy.reason, policy.risk_level) == (30, "normal", "LOW")


def test_home_defaults_include_zone_and_updated_at():
    home = Home("home-001", 20.0, 10.0, 5.0)
    assert home.zone == ""
    assert home.updated_at == ""


# --- each load zone decides from its own price ---------------------------------------------

ZONE_INTENT_SETTINGS = {**INTENT_SETTINGS, "zones": ZONE_SETTINGS["zones"]}
# Houston cheap, West expensive, North and South in between.
ZONE_PRICES = {"Houston": 10.0, "North": 40.0, "South": 40.0, "West": 80.0}


def zoned(risk, zone_prices=ZONE_PRICES, alerted=None, mode="AUTO", price=40.0, label="ercot"):
    return reserve_policy(risk, ZONE_INTENT_SETTINGS, alerted, mode=mode, price_usd_mwh=price,
                          price_label=label, zone_prices=zone_prices)


def test_each_zone_uses_the_fleet_bands_on_its_own_price():
    policy = zoned(make_risk("LOW"))
    # Cheap Houston charges, expensive West is in the discharge band, the rest hold.
    assert policy.zone_intent == {"Houston": "charge", "North": "hold", "South": "hold",
                                  "West": "discharge"}
    # The headline (North) price still sets the fleet band.
    assert policy.intent == "hold"


def test_an_expensive_zone_under_a_weather_alert_holds():
    policy = zoned(make_risk("LOW"), alerted={"West": "Winter Storm Warning"})
    assert policy.zone_reasons["West"] == "weather_alert"
    assert policy.zone_intent["West"] == "hold"
    assert policy.zone_intent["Houston"] == "charge"


def test_a_storm_or_missing_signal_never_gives_a_zone_the_discharge_band():
    for risk in (make_risk("HIGH"), None):
        policy = zoned(risk)
        assert policy.zone_intent == {"Houston": "charge", "North": "hold", "South": "hold",
                                      "West": "hold"}


def test_a_zone_with_no_price_follows_the_headline_price():
    policy = zoned(make_risk("LOW"), zone_prices={"Houston": 10.0, "West": None}, price=80.0)
    assert policy.intent == "discharge"
    assert policy.zone_intent == {"Houston": "charge", "North": "discharge", "South": "discharge",
                                  "West": "discharge"}


def test_operator_hold_sets_no_zone_intent():
    policy = zoned(make_risk("LOW"), mode="HOLD")
    assert policy.zone_intent == {}
    assert (policy.intent, policy.intent_reason) == ("hold", "operator_hold")


def test_no_zone_prices_keeps_one_fleet_decision():
    for missing in (None, {}, {"Houston": None}):
        assert zoned(make_risk("LOW"), zone_prices=missing).zone_intent == {}
    # Floor-only callers (no price label) get no zone intent either.
    floor_only = reserve_policy(make_risk("LOW"), ZONE_INTENT_SETTINGS, zone_prices=ZONE_PRICES)
    assert floor_only.zone_intent == {} and floor_only.intent == "hold"


def test_an_alerted_zone_with_no_price_never_takes_a_headline_discharge():
    policy = zoned(make_risk("LOW"), zone_prices={"North": 80.0}, price=80.0,
                   alerted={"Houston": "Hurricane Warning"})
    assert policy.intent == "discharge"
    assert policy.zone_intent["Houston"] == "hold"
    assert policy.zone_intent["South"] == "discharge"
    # A cheap headline still lets the alerted zone charge: charging never lowers backup.
    cheap = zoned(make_risk("LOW"), zone_prices={"North": 10.0}, price=10.0,
                  alerted={"Houston": "Hurricane Warning"})
    assert cheap.zone_intent["Houston"] == "charge"


def test_zone_prices_still_decide_when_the_headline_price_is_missing():
    policy = zoned(make_risk("LOW"), zone_prices={"Houston": 10.0}, price=None, label="none")
    assert (policy.intent, policy.intent_reason) == ("hold", "price_unavailable")
    assert policy.zone_intent == {"Houston": "charge", "North": "hold", "South": "hold", "West": "hold"}


# --- cheapest day-ahead (DAM) hours --------------------------------------------------------

DAM_SETTINGS = {**ZONE_INTENT_SETTINGS, "round_trip_pct": 89}


def dam(prices):
    """The next hours of DAM, current hour first, in TickResult.dam_hours shape."""
    return [{"hour_start": f"2026-08-30T{12 + i:02d}:00-05:00", "usd_mwh": usd} for i, usd in enumerate(prices)]


def with_dam(north_hours, needed, rt=None, risk="LOW", alerted=None, mode="AUTO"):
    zone_prices = {"North": rt} if rt is not None else {}
    return reserve_policy(make_risk(risk) if risk else None, DAM_SETTINGS, alerted, mode=mode,
                          price_usd_mwh=rt, price_label="ercot" if rt is not None else "none",
                          zone_prices=zone_prices, dam_hours={"North": north_hours},
                          zone_hours_needed={"North": needed})


def test_dam_waits_at_20_when_cheaper_hours_come_later():
    # $20 is under the $25 band, but two cheaper DAM hours are coming and 2 hours fill the zone.
    policy = with_dam(dam([20.0, 30.0, 8.0, 9.0, 60.0]), needed=2, rt=20.0)
    assert policy.zone_intent["North"] == "hold"
    assert policy.zone_charge_why["North"] == "cheaper_hour_later"
    assert policy.zone_charge_hours["North"] == ["2026-08-30T14:00-05:00", "2026-08-30T15:00-05:00"]


def test_dam_charges_at_26_when_this_is_one_of_the_cheapest_hours():
    policy = with_dam(dam([26.0, 40.0, 27.0, 90.0]), needed=2, rt=26.0)
    assert policy.zone_intent["North"] == "charge"
    assert policy.zone_charge_why["North"] == "dam_cheap_hour"


def test_dam_charges_on_a_real_time_dip_the_forecast_missed():
    # DAM said 30 now (not chosen), but real-time is 9: under the dearest chosen hour (12).
    policy = with_dam(dam([30.0, 10.0, 12.0, 90.0]), needed=2, rt=9.0)
    assert (policy.zone_intent["North"], policy.zone_charge_why["North"]) == ("charge", "rt_dip")


def test_dam_skips_a_cheap_hour_no_later_hour_pays_back():
    # 50 x 0.89 = 44.5, not above the 45 paid now: the round trip loses money.
    policy = with_dam(dam([45.0, 50.0, 50.0]), needed=1, rt=45.0)
    assert (policy.zone_intent["North"], policy.zone_charge_why["North"]) == ("hold", "no_payback")


def test_dam_full_zone_charges_nothing():
    policy = with_dam(dam([5.0, 90.0]), needed=0, rt=5.0)
    assert policy.zone_intent["North"] == "hold"
    assert (policy.zone_charge_why["North"], policy.zone_charge_hours["North"]) == ("full", [])


def test_dam_charge_hours_follow_how_much_charge_the_zone_needs():
    hours = dam([10.0, 11.0, 12.0, 13.0, 50.0, 60.0])
    assert len(with_dam(hours, needed=1, rt=10.0).zone_charge_hours["North"]) == 1
    four = with_dam(hours, needed=4, rt=10.0)
    assert four.zone_charge_hours["North"] == [h["hour_start"] for h in hours[:4]]
    # Needing more hours than the window holds picks every hour.
    assert len(with_dam(hours, needed=10, rt=10.0).zone_charge_hours["North"]) == 6


def test_dam_never_overrides_the_discharge_band():
    policy = with_dam(dam([70.0, 10.0, 90.0]), needed=2, rt=70.0)
    assert policy.zone_intent["North"] == "discharge"
    assert policy.zone_charge_why["North"] == "sell_band"


def test_dam_storm_zone_never_discharges():
    for risk, alerted in (("HIGH", None), (None, None), ("LOW", {"North": "Winter Storm Warning"})):
        policy = with_dam(dam([70.0, 10.0, 90.0]), needed=1, rt=70.0, risk=risk, alerted=alerted)
        assert policy.zone_intent["North"] == "hold"
        assert policy.zone_charge_why["North"] == "cheaper_hour_later"


def test_dam_with_no_real_time_price_uses_this_hours_dam_for_payback():
    policy = with_dam(dam([10.0, 40.0]), needed=1)
    assert (policy.zone_intent["North"], policy.zone_charge_why["North"]) == ("charge", "dam_cheap_hour")


def test_a_zone_with_no_dam_keeps_the_25_band():
    policy = reserve_policy(make_risk("LOW"), DAM_SETTINGS, mode="AUTO", price_usd_mwh=40.0,
                            price_label="ercot", zone_prices={"Houston": 20.0, "North": 20.0},
                            dam_hours={"North": dam([30.0, 5.0])}, zone_hours_needed={"North": 1, "Houston": 1})
    assert policy.zone_intent["Houston"] == "charge"
    assert "Houston" not in policy.zone_charge_why
    assert policy.zone_intent["North"] == "hold"
    # DAM hours without zone_hours_needed cannot size the charge, so the band stays.
    unsized = reserve_policy(make_risk("LOW"), DAM_SETTINGS, mode="AUTO", price_usd_mwh=20.0,
                             price_label="ercot", zone_prices={"North": 20.0},
                             dam_hours={"North": dam([30.0, 5.0])})
    assert unsized.zone_intent["North"] == "charge" and unsized.zone_charge_why == {}


def test_dam_operator_hold_sets_no_zone_intent():
    policy = with_dam(dam([5.0, 90.0]), needed=1, rt=5.0, mode="HOLD")
    assert policy.zone_intent == {} and policy.zone_charge_why == {}
