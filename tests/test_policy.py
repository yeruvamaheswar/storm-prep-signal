"""The reserve floor for each risk outcome, including a missing signal."""
from storm_prep.contracts import Policy
from storm_prep.policy import reserve_policy
from storm_prep.risk import RiskResult

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
