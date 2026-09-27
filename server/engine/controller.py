"""The allocator: split the grid's target across homes using only energy above each floor.

`allocate` is pure. It reads the homes and the policy and returns an `Allocation`; it never
changes a home, reads a file, looks at the clock, or uses randomness. The floor math comes from
`fleet.floor_kwh` and `fleet.safe_kw`, so the planner here and the guard in `discharge` agree.
"""
import math

from server.engine.contracts import Allocation
from server.engine.fleet import floor_kwh, has_unknown_zone, room_kw, safe_kw

# Policy reasons that mean "we are keeping extra backup on purpose".
STORM_REASONS = ("storm_risk_high", "signal_unavailable", "weather_alert")

# Shortfalls smaller than this (in MW) are float noise from the proportional split, not real.
MISSED_TOLERANCE_MW = 1e-9


def allocate(homes, frame, policy, mode, settings):
    """Plan how many kW each home gives this tick. See PRD K2 and the reason-code precedence.

    The price bands in `reserve_policy` set `Policy.intent`. HOLD mode wins over everything.
    Discharge and hold both serve `target_mw` from headroom: a hold price is not a
    dispatch stop (CONSTRAINTS allocation rule). Charge serves the call from the
    fewest homes first, then every other home with room absorbs (negative kW); with no
    call, cheap power still charges. `delivered_mw` counts discharge only.
    The tick's label comes from this plan via `acted_intent`, so a served call on a hold
    price reads discharge.
    Whatever the price or the call, a live home under its zone floor that got no other order
    charges back up to that floor (`add_refill`): backup is kept before a storm arrives.
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

    zone_intent = getattr(policy, "zone_intent", None)
    intent = getattr(policy, "intent", "hold")
    zoned = isinstance(zone_intent, dict) and bool(zone_intent)
    # With no call only cheap power has work to do: it refills the fleet (per zone if zoned).
    wants_charge = "charge" in zone_intent.values() if zoned else intent == "charge"
    if target_mw == 0 and not wants_charge:
        return add_refill(Allocation({}, 0.0, 0.0, []), homes, policy, settings, down)
    if zoned:
        alloc = allocate_zoned(homes, frame, policy, settings, zone_intent)
    elif intent == "charge":
        alloc = allocate_charge(homes, frame, policy, settings)
    elif intent in ("discharge", "hold"):
        alloc = allocate_discharge(homes, frame, policy, settings)
    else:
        # Unknown intent holds rather than selling on a tick we do not understand.
        return Allocation({}, 0.0, target_mw, ["holding_spare_energy"] + status_suffixes(homes, policy))
    alloc = add_refill(alloc, homes, policy, settings, down)
    alloc.reasons += [f"grid_down:{zone}" for zone in sorted(down)]
    return alloc


def refill_kw(homes, policy, settings, down=frozenset()):
    """What each live, grid-up home under its zone floor draws to get back to that floor this tick.

    Backup comes before price: the floor is the energy a home needs in a blackout, and a storm
    or weather alert raises it before the storm lands. So refill runs at any price. It stops
    at the floor (room to full is the cheap-power path's job) and is capped by `max_kw`.
    Dead, stale, unknown-zone and grid-down homes are left out, as in `charge_caps`.
    """
    kw = {}
    for home in homes:
        if home.status != "live" or has_unknown_zone(home, policy) or home.zone in down:
            continue
        short_kwh = floor_kwh(home, policy) - home.soc_kwh
        if short_kwh <= 0:
            continue
        # The floor is never above capacity, so this never asks for more than room_kw.
        cap = round_down(min(home.max_kw, short_kwh * 60 / settings["tick_minutes"]))
        if cap > 0:
            kw[home.home_id] = cap
    return kw


def add_refill(alloc, homes, policy, settings, down):
    """Add a refill charge for every home under its floor that has no order yet, plus `reserve_refill`.

    A home under its floor has no headroom, so it is never a seller; a home the cheap path
    already charges takes its full room cap, which covers the floor. The code goes after the
    shortfall and `charging` codes and before the status codes.
    """
    extra = {home_id: -kw for home_id, kw in refill_kw(homes, policy, settings, down).items()
             if home_id not in alloc.per_home_kw}
    if not extra:
        return alloc
    head = sum(code in ("storm_reserve", "fleet_headroom_short", "charging") for code in alloc.reasons)
    reasons = alloc.reasons[:head] + ["reserve_refill"] + alloc.reasons[head:]
    return Allocation({**alloc.per_home_kw, **extra}, alloc.delivered_mw, alloc.missed_mw, reasons)


def acted_intent(alloc, policy, mode):
    """The tick's (intent, intent_reason): what the fleet was ordered to do this tick, not the price band.

    It is the order, not the result: if every discharge order times out, the label is still
    discharge and `delivered_mw` shows the shortfall.

    `Policy.intent` is the price band and is what `allocate` reads. Hold and discharge both
    serve the call, so a hold price can still sell. The wall and run file show this instead.
    Pure: reads the planned allocation and the policy, returns a pair.

    Net flow picks the label: sold = the positive kW, charged = the negative kW, as sizes.

        mode HOLD                        -> hold, operator_hold
        charged > sold                   -> charge; grid_call_served if anything sold (the
                                            call was met while the fleet mostly charged),
                                            else policy reason on a charge band,
                                            zone_price when a zone's own price charged
                                            (`charging` code), else reserve_refill (only
                                            homes under their floor charged)
        sold >= charged, sold > 0        -> discharge, policy reason if policy said discharge
                                            else grid_call (the grid called, not the price)
        nothing moved, policy said hold  -> hold, policy reason (e.g. price_unavailable)
        nothing moved, charge/discharge  -> hold, no_grid_call when the target was 0,
                                            else policy reason (a call nobody could serve)

    Sizes within MISSED_TOLERANCE_MW (as kW) are float noise: a noise-sized kW is not
    movement, and charge wins only by more than that. An exact tie reads discharge: the call was served. A discharge-winning mixed tick shows
    its charge through the `charging` reason code on the allocation.
    A cheap tick with no call charges every home with room, so it reads charge; the
    charge-band no_grid_call row only happens when every home is full.
    """
    if mode == "HOLD":
        return "hold", "operator_hold"
    planned = alloc.per_home_kw.values()
    sold_kw = sum(kw for kw in planned if kw > 0)
    charged_kw = -sum(kw for kw in planned if kw < 0)
    # Split noise must not flip a tie to charge or count as movement.
    noise_kw = MISSED_TOLERANCE_MW * 1000
    sold = sold_kw > noise_kw
    if charged_kw > noise_kw and charged_kw - sold_kw > noise_kw:
        if sold:
            return "charge", "grid_call_served"
        # Only homes under their floor charged (no `charging` code): backup, not price.
        if "reserve_refill" in alloc.reasons and "charging" not in alloc.reasons:
            return "charge", "reserve_refill"
        # Charging without a charge band means a zone's own price was cheap.
        return "charge", policy.intent_reason if policy.intent == "charge" else "zone_price"
    if sold:
        return "discharge", policy.intent_reason if policy.intent == "discharge" else "grid_call"
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
    """Cheap power: serve the call from the fewest homes, then every other home with room charges.

    Sellers are picked most headroom first (ties by home_id, so a replay picks the same
    homes) until their caps cover the call, and split it with `split_target`. Every other
    live home with room absorbs at its cap (negative kW). A home never sells and charges
    in one tick. Charge raises soc and is never a breach; the worker and `discharge` clamp
    it to `room_kw`, so it never fills past capacity.
    """
    def sell(caps, target_kw):
        return split_target(pick_sellers(caps, target_kw), target_kw)

    return serve_then_charge(homes, frame, policy, settings, sell, lambda home: True)


def allocate_zoned(homes, frame, policy, settings, zone_intent):
    """Each zone's own price band, but the call is always served while any zone has headroom.

    Every live home with headroom in a discharge or hold zone (a zone with no row counts as
    hold) shares the call in proportion to its cap, like `allocate_discharge`: spreading the
    drain keeps the most homes above their floors for the next call. Only when those caps
    fall short do charge-zone homes sell the remainder, the fewest of them (most headroom
    first, ties by home_id), so the rest of the cheap zone still charges. Non-selling homes
    in hold and discharge zones do nothing: the fleet only sells on a call.
    """
    zone_of = {home.home_id: home.zone for home in homes}

    def cheap(home_id):
        return zone_intent.get(zone_of[home_id], "hold") == "charge"

    def sell(caps, target_kw):
        spread = {home_id: cap for home_id, cap in caps.items() if not cheap(home_id)}
        shares = split_target(spread, target_kw)
        remainder = target_kw - sum(spread.values())
        # Split noise is not a shortfall: a cheap home must not sell 1e-15 kW and lose its charge.
        if remainder > MISSED_TOLERANCE_MW * 1000:
            # Fewest cheap homes cover what the other zones could not: the rest keep charging.
            cheap_caps = {home_id: cap for home_id, cap in caps.items() if cheap(home_id)}
            shares.update(split_target(pick_sellers(cheap_caps, remainder), remainder))
        return shares

    return serve_then_charge(homes, frame, policy, settings, sell,
                             lambda home: cheap(home.home_id))


def serve_then_charge(homes, frame, policy, settings, sell, may_charge):
    """Serve `target_mw` with `sell(caps, target_kw)`, then charge the non-sellers `may_charge` allows.

    Shared by the fleet charge path and the zoned path so both keep the same books:
    delivered counts the sellers only, missed is the rest, and a home never sells and
    charges in one tick.
    """
    target_kw = frame.target_mw * 1000
    down = grid_down_zones(frame)
    positive = sell(home_caps(homes, policy, settings, down), target_kw)
    room = charge_caps(homes, policy, settings, down)
    by_id = {home.home_id: home for home in homes}
    negative = {home_id: -kw for home_id, kw in room.items()
                if home_id not in positive and may_charge(by_id[home_id])}
    delivered_mw = min(sum(positive.values()) / 1000, frame.target_mw)
    missed_mw = max(0.0, frame.target_mw - delivered_mw)
    reasons = shortfall_codes(policy, missed_mw)
    if negative:
        reasons.append("charging")
    reasons += status_suffixes(homes, policy)
    return Allocation({**positive, **negative}, delivered_mw, missed_mw, reasons)


def pick_sellers(caps, target_kw):
    """The fewest homes whose caps cover target_kw, most headroom first; all of them if short.

    Selling from few homes leaves the most homes free to charge on cheap power.
    """
    picked, total = {}, 0.0
    for home_id, cap in sorted(caps.items(), key=lambda item: (-item[1], item[0])):
        if total >= target_kw:
            break
        picked[home_id] = cap
        total += cap
    return picked


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
    return shortfall_codes(policy, missed_mw) + status_suffixes(homes, policy)


def shortfall_codes(policy, missed_mw):
    """The head code when the call was really missed: storm reserve or plain short headroom."""
    if missed_mw > MISSED_TOLERANCE_MW:
        return ["storm_reserve" if is_storm_policy(policy) else "fleet_headroom_short"]
    return []


def is_storm_policy(policy):
    """True when the policy, or any one zone, is holding extra backup because of a storm."""
    return policy.reason in STORM_REASONS or any(r in STORM_REASONS for r in policy.zone_reasons.values())


def round_down(kw):
    """Round down to 6 decimals, so rounding can only leave a home a little more backup."""
    return math.floor(kw * 1_000_000) / 1_000_000
