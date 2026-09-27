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
