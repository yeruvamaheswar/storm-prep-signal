"""The reserve floor for each risk outcome, including a missing signal."""
from server.engine.contracts import Policy
from server.engine.policy import reserve_policy
from server.engine.risk import RiskResult

SETTINGS = {"base_reserve_pct": 30, "storm_reserve_pct": 60}  # example, not Base specs


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
