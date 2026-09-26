"""The reserve floor rule. Pure function only: no files, no clock, no network."""
from storm_prep.contracts import Policy


def reserve_policy(risk, settings):
    """Pick how much charge every home must keep back, from the risk result."""
    # No signal means we can't rule out a storm, so fail safe and keep the larger reserve.
    if risk is None:
        return Policy(settings["storm_reserve_pct"], "signal_unavailable", None)
    if risk.level == "HIGH":
        return Policy(settings["storm_reserve_pct"], "storm_risk_high", "HIGH")
    return Policy(settings["base_reserve_pct"], "normal", "LOW")
