"""The allocator: split the grid's target across homes using only energy above each floor.

`allocate` is pure. It reads the homes and the policy and returns an `Allocation`; it never
changes a home, reads a file, looks at the clock, or uses randomness. The floor math comes from
`fleet.floor_kwh` and `fleet.safe_kw`, so the planner here and the guard in `discharge` agree.
"""
import math

from server.engine.contracts import Allocation
from server.engine.fleet import has_unknown_zone, room_kw, safe_kw

# Policy reasons that mean "we are keeping extra backup on purpose".
STORM_REASONS = ("storm_risk_high", "signal_unavailable", "weather_alert")

# Shortfalls smaller than this (in MW) are float noise from the proportional split, not real.
MISSED_TOLERANCE_MW = 1e-9


def allocate(homes, frame, policy, mode, settings):
    """Plan how many kW each home gives this tick. See PRD K2 and the reason-code precedence.

    The price bands in `reserve_policy` set `Policy.intent`. HOLD mode wins over everything.
    Charge absorbs (negative kW). Discharge and hold both serve `target_mw` from
    headroom: a hold price is not a dispatch stop (CONSTRAINTS allocation rule). The tick's
    label comes from this plan via `acted_intent`, so a served call on a hold price reads discharge.
    `delivered_mw` counts discharge only, so a charge tick delivers 0 and misses the call.
    Homes in a zone named by the frame's `grid_down` event get 0 kW both ways (they back up
    their own homes); each such zone adds reason `grid_down:<zone>` after the other codes.
    """
    target_mw = frame.target_mw
    if target_mw < 0:
        raise ValueError(f"target_mw must not be negative, got {target_mw}")
    down = checked_grid_down(homes, frame, settings)
    # The operator's HOLD wins over everything, so the screen always shows why nothing ran.
    if mode == "HOLD":
        return Allocation({}, 0.0, target_mw, ["operator_hold"])
    if target_mw == 0:
        return Allocation({}, 0.0, 0.0, [])

    zone_intent = getattr(policy, "zone_intent", None)
    intent = getattr(policy, "intent", "hold")
    if isinstance(zone_intent, dict) and zone_intent:
        alloc = allocate_zoned(homes, frame, policy, settings, zone_intent)
    elif intent == "charge":
        alloc = allocate_charge(homes, frame, policy, settings)
    elif intent in ("discharge", "hold"):
        alloc = allocate_discharge(homes, frame, policy, settings)
    else:
        # Unknown intent holds rather than selling on a tick we do not understand.
        return Allocation({}, 0.0, target_mw, ["holding_spare_energy"] + status_suffixes(homes, policy))
    alloc.reasons += [f"grid_down:{zone}" for zone in sorted(down)]
    return alloc


def acted_intent(alloc, policy, mode):
    """The tick's (intent, intent_reason): what the fleet was ordered to do, not the price band.

    `Policy.intent` is the price band and is what `allocate` reads. Hold and discharge both
    serve the call, so a hold price can still sell. The wall and run file show this instead.
    Pure: reads the planned allocation and the policy, returns a pair.

        mode HOLD                        -> hold, operator_hold
        any kW > 0 (sold)                -> discharge, policy reason if policy said discharge
                                            else grid_call (the grid called, not the price)
        else any kW < 0 (charged)        -> charge, policy reason
        nothing moved, policy said hold  -> hold, policy reason (e.g. price_unavailable)
        nothing moved, charge/discharge  -> hold, no_grid_call when the target was 0,
                                            else policy reason (a call nobody could serve)

    A tick that both sells and charges is labelled discharge; the `charging` reason code on
    the allocation shows the charge.
    """
    if mode == "HOLD":
        return "hold", "operator_hold"
    planned = alloc.per_home_kw.values()
    if any(kw > 0 for kw in planned):
        return "discharge", policy.intent_reason if policy.intent == "discharge" else "grid_call"
    if any(kw < 0 for kw in planned):
        return "charge", policy.intent_reason
    target_mw = alloc.delivered_mw + alloc.missed_mw
    if policy.intent in ("charge", "discharge") and target_mw <= 0:
        return "hold", "no_grid_call"
    return "hold", policy.intent_reason


def grid_down_zones(frame):
    """Zones the frame marks grid down. Their batteries back up their own homes: no sell, no charge."""
    return set(frame.events.get("grid_down", []))


def checked_grid_down(homes, frame, settings):
    """grid_down_zones, refusing a zone name that is not in ZONES (or the fleet): a tape typo must not pass quietly."""
    down = grid_down_zones(frame)
    known = set(settings.get("zones") or {home.zone for home in homes})
    unknown = sorted(down - known)
    if unknown:
        raise ValueError(f"grid_down event names zones not in ZONES: {unknown}")
    return down


def allocate_discharge(homes, frame, policy, settings):
    """Today's positive split of `target_mw` across live homes with headroom above the floor."""
    target_mw = frame.target_mw
    caps = home_caps(homes, policy, settings, grid_down_zones(frame))
    per_home_kw = split_target(caps, target_mw * 1000)  # convert once: MW to kW
    # Clamp to the target so float noise in the split can never report over-delivery.
    delivered_mw = min(sum(per_home_kw.values()) / 1000, target_mw)
    missed_mw = max(0.0, target_mw - delivered_mw)
    reasons = reason_codes(homes, policy, missed_mw)
    return Allocation(per_home_kw, delivered_mw, missed_mw, reasons)


def charge_caps(homes, policy, settings, down=frozenset()):
    """The most each live home in a known zone can absorb this tick, keyed by home_id.

    Room to capacity (`capacity_kwh - soc_kwh`) spread over the tick, capped by `max_kw`.
    A full home has cap 0. Dead, stale, unknown-zone, and grid-down homes are left out.
    """
    caps = {}
    for home in homes:
        # Dead and stale homes get nothing: we don't send work to a home we can't hear from.
        if home.status != "live" or has_unknown_zone(home, policy) or home.zone in down:
            continue
        cap = round_down(room_kw(home, settings))
        if cap > 0:
            caps[home.home_id] = cap
    return caps


def allocate_charge(homes, frame, policy, settings):
    """Charge only: every live home with room absorbs at its cap (negative kW).

    `delivered_mw` counts discharge only, so a charge tick delivers 0 and misses the call
    with reason `charging`. Charge raises soc and is never a breach; the worker and
    `discharge` clamp it to `room_kw`, so it never fills past capacity.
    """
    target_mw = frame.target_mw
    caps = charge_caps(homes, policy, settings, grid_down_zones(frame))
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
    down = grid_down_zones(frame)
    by_id = {home.home_id: home for home in homes}
    discharge_caps = home_caps(homes, policy, settings, down)
    room_caps = charge_caps(homes, policy, settings, down)
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
        and home.zone not in down
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


def home_caps(homes, policy, settings, down=frozenset()):
    """The safe kW cap of every live home in a known zone whose grid is up and that still has headroom.

    A home at or under its floor is left out. Assigning it discharge kW would
    show DISCHARGING on the fleet table while the floor clamp gives it nothing
    and breaches stays 0.
    """
    caps = {}
    for home in homes:
        # Dead and stale homes get nothing: we don't send work to a home we can't hear from.
        if home.status != "live" or has_unknown_zone(home, policy) or home.zone in down:
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
