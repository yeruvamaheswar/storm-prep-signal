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
