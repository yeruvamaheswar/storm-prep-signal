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
    """Plan how many kW each home gives this tick. See PRD K2 and the reason-code precedence.

    The price bands in `reserve_policy` set `Policy.intent`. HOLD mode wins over everything.
    Charge absorbs (negative kW). Discharge and hold both serve `target_mw` from
    headroom: hold is a label for the wall, not a dispatch stop (CONSTRAINTS
    allocation rule; contracts.py says allocate still only discharges).
    `delivered_mw` counts discharge only, so a charge tick delivers 0 and misses the call.
    """
    target_mw = frame.target_mw
    if target_mw < 0:
        raise ValueError(f"target_mw must not be negative, got {target_mw}")
    # The operator's HOLD wins over everything, so the screen always shows why nothing ran.
    if mode == "HOLD":
        return Allocation({}, 0.0, target_mw, ["operator_hold"])
    if target_mw == 0:
        return Allocation({}, 0.0, 0.0, [])

    zone_intent = getattr(policy, "zone_intent", None)
    if isinstance(zone_intent, dict) and zone_intent:
        return allocate_zoned(homes, frame, policy, settings, zone_intent)

    intent = getattr(policy, "intent", "hold")
    if intent == "charge":
        return allocate_charge(homes, frame, policy, settings)
    if intent in ("discharge", "hold"):
        return allocate_discharge(homes, frame, policy, settings)
    # Unknown intent holds rather than selling on a tick we do not understand.
    return Allocation({}, 0.0, target_mw, ["holding_spare_energy"] + status_suffixes(homes, policy))


def allocate_discharge(homes, frame, policy, settings):
    """Today's positive split of `target_mw` across live homes with headroom above the floor."""
    target_mw = frame.target_mw
    caps = home_caps(homes, policy, settings)
    per_home_kw = split_target(caps, target_mw * 1000)  # convert once: MW to kW
    # Clamp to the target so float noise in the split can never report over-delivery.
    delivered_mw = min(sum(per_home_kw.values()) / 1000, target_mw)
    missed_mw = max(0.0, target_mw - delivered_mw)
    reasons = reason_codes(homes, policy, missed_mw)
    return Allocation(per_home_kw, delivered_mw, missed_mw, reasons)


def charge_caps(homes, policy, settings):
    """The most each live home in a known zone can absorb this tick, keyed by home_id.

    Room to capacity (`capacity_kwh - soc_kwh`) spread over the tick, capped by `max_kw`.
    A full home has cap 0. Dead, stale, and unknown-zone homes are left out.
    """
    caps = {}
    for home in homes:
        # Dead and stale homes get nothing: we don't send work to a home we can't hear from.
        if home.status != "live" or has_unknown_zone(home, policy):
            continue
        room_kwh = max(0.0, home.capacity_kwh - home.soc_kwh)
        if room_kwh <= 0:
            continue
        caps[home.home_id] = round_down(min(home.max_kw, room_kwh * 60 / settings["tick_minutes"]))
    return caps


def allocate_charge(homes, frame, policy, settings):
    """Charge only: every live home with room absorbs at its cap (negative kW).

    `delivered_mw` counts discharge only, so a charge tick delivers 0 and misses the call
    with reason `charging`. Charge raises soc and is never a breach; `discharge` still
    skips `kw <= 0` until the worker clamp lands.
    """
    target_mw = frame.target_mw
    caps = charge_caps(homes, policy, settings)
    per_home_kw = {home_id: -kw for home_id, kw in caps.items() if kw > 0}
    reasons = ["charging"] + status_suffixes(homes, policy)
    return Allocation(per_home_kw, 0.0, target_mw, reasons)


def allocate_zoned(homes, frame, policy, settings, zone_intent):
    """Each live home follows its own zone's intent; a zone with no row holds.

    Discharge homes share `target_mw` in proportion to their headroom caps. Charge homes
    each absorb at their room cap (negative kW). Hold and missing-zone homes get nothing.
    `delivered_mw` counts the positive shares only; `missed_mw` is what was not delivered.
    """
    target_mw = frame.target_mw
    by_id = {home.home_id: home for home in homes}
    discharge_caps = home_caps(homes, policy, settings)
    room_caps = charge_caps(homes, policy, settings)
    # Keep only the homes whose zone asks for that direction.
    discharge_caps = {
        home_id: cap for home_id, cap in discharge_caps.items()
        if zone_intent.get(by_id[home_id].zone, "hold") == "discharge"
    }
    room_caps = {
        home_id: cap for home_id, cap in room_caps.items()
        if zone_intent.get(by_id[home_id].zone, "hold") == "charge"
    }
    positive = split_target(discharge_caps, target_mw * 1000)
    negative = {home_id: -kw for home_id, kw in room_caps.items() if kw > 0}
    per_home_kw = {**positive, **negative}
    delivered_mw = min(sum(positive.values()) / 1000, target_mw)
    missed_mw = max(0.0, target_mw - delivered_mw)
    reasons = []
    if missed_mw > MISSED_TOLERANCE_MW:
        reasons.append("storm_reserve" if is_storm_policy(policy) else "fleet_headroom_short")
    if negative:
        reasons.append("charging")
    if missed_mw > MISSED_TOLERANCE_MW and any(
        home.status == "live"
        and not has_unknown_zone(home, policy)
        and zone_intent.get(home.zone, "hold") == "hold"
        for home in homes
    ):
        reasons.append("holding_spare_energy")
    reasons += status_suffixes(homes, policy)
    return Allocation(per_home_kw, delivered_mw, missed_mw, reasons)


def status_suffixes(homes, policy):
    """Dead, stale, and unknown-zone counts, without the shortfall head code."""
    reasons = []
    dead = sum(h.status == "dead" for h in homes)
    stale = sum(h.status == "stale" for h in homes)
    if dead:
        reasons.append(f"homes_dead:{dead}")
    if stale:
        reasons.append(f"homes_stale:{stale}")
    if any(h.status == "live" and has_unknown_zone(h, policy) for h in homes):
        reasons.append("unknown_zone")
    return reasons


def home_caps(homes, policy, settings):
    """The safe kW cap of every live home in a known zone that still has headroom.

    A home at or under its floor is left out. Assigning it discharge kW would
    show DISCHARGING on the fleet table while the floor clamp gives it nothing
    and breaches stays 0.
    """
    caps = {}
    for home in homes:
        # Dead and stale homes get nothing: we don't send work to a home we can't hear from.
        if home.status != "live" or has_unknown_zone(home, policy):
            continue
        cap = round_down(safe_kw(home, policy, settings))
        if cap <= 0:
            continue
        caps[home.home_id] = cap
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
