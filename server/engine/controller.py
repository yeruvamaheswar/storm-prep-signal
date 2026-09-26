"""The allocator: split the grid's target across homes using only energy above each floor.

`allocate` is pure. It reads the homes and the policy and returns an `Allocation`; it never
changes a home, reads a file, looks at the clock, or uses randomness. The floor math comes from
`fleet.floor_kwh` and `fleet.safe_kw`, so the planner here and the guard in `discharge` agree.
"""
import math

from server.engine.contracts import Allocation
from server.engine.fleet import has_unknown_zone, safe_kw

# Policy reasons that mean "we are keeping extra backup on purpose".
STORM_REASONS = ("storm_risk_high", "signal_unavailable", "weather_alert")

# Shortfalls smaller than this (in MW) are float noise from the proportional split, not real.
MISSED_TOLERANCE_MW = 1e-9


def allocate(homes, frame, policy, mode, settings):
    """Plan how many kW each home gives this tick. See PRD K2 and the reason-code precedence."""
    target_mw = frame.target_mw
    if target_mw < 0:
        raise ValueError(f"target_mw must not be negative, got {target_mw}")
    # The operator's HOLD wins over everything, so the screen always shows why nothing ran.
    if mode == "HOLD":
        return Allocation({}, 0.0, target_mw, ["operator_hold"])
    if target_mw == 0:
        return Allocation({}, 0.0, 0.0, [])

    caps = home_caps(homes, policy, settings)
    per_home_kw = split_target(caps, target_mw * 1000)  # convert once: MW to kW
    # Clamp to the target so float noise in the split can never report over-delivery.
    delivered_mw = min(sum(per_home_kw.values()) / 1000, target_mw)
    missed_mw = max(0.0, target_mw - delivered_mw)
    reasons = reason_codes(homes, policy, missed_mw)
    return Allocation(per_home_kw, delivered_mw, missed_mw, reasons)


def home_caps(homes, policy, settings):
    """The safe kW cap of every live home in a known zone, keyed by home_id."""
    caps = {}
    for home in homes:
        # Dead and stale homes get nothing: we don't send work to a home we can't hear from.
        if home.status != "live" or has_unknown_zone(home, policy):
            continue
        caps[home.home_id] = round_down(safe_kw(home, policy, settings))
    return caps


def split_target(caps, target_kw):
    """Every home at its cap if that is not enough; otherwise shares in proportion to the caps."""
    total = sum(caps.values())
    if total <= target_kw:
        shares = dict(caps)
    else:
        # min() keeps float rounding from pushing a share a hair above its cap.
        shares = {home_id: min(cap, cap * target_kw / total) for home_id, cap in caps.items()}
    # Only homes given real work are listed, so a reader never mistakes a 0 for an order.
    return {home_id: kw for home_id, kw in shares.items() if kw > 0}


def reason_codes(homes, policy, missed_mw):
    """Why the target was missed, in the PRD's order: shortfall, dead, stale, unknown zone."""
    reasons = []
    if missed_mw > MISSED_TOLERANCE_MW:
        reasons.append("storm_reserve" if is_storm_policy(policy) else "fleet_headroom_short")
    dead = sum(h.status == "dead" for h in homes)
    stale = sum(h.status == "stale" for h in homes)
    if dead:
        reasons.append(f"homes_dead:{dead}")
    if stale:
        reasons.append(f"homes_stale:{stale}")
    if any(h.status == "live" and has_unknown_zone(h, policy) for h in homes):
        reasons.append("unknown_zone")
    return reasons


def is_storm_policy(policy):
    """True when the policy, or any one zone, is holding extra backup because of a storm."""
    return policy.reason in STORM_REASONS or any(r in STORM_REASONS for r in policy.zone_reasons.values())


def round_down(kw):
    """Round down to 6 decimals, so rounding can only leave a home a little more backup."""
    return math.floor(kw * 1_000_000) / 1_000_000
