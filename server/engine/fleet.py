"""The simulated fleet: build the homes, mark their status, and apply an allocation.

Every home is a `Home` from contracts.py. There is no hardware here; "discharging" a home
means lowering its `soc_kwh` by the energy it gave. The floor is checked again in
`discharge`, so a wrong or late order can never take a home below its zone's reserve.
"""
from server.engine.contracts import Allocation, Home, Policy

STATUSES = ("live", "stale", "dead")


def assign_zone(index, zones):
    """Zone for home number `index` (1-based): round-robin over the zones in settings order.

    Kept as one tiny function so the team can swap in contiguous blocks with one edit.
    """
    return zones[(index - 1) % len(zones)]


def new_fleet(settings):
    """`fleet_size` homes with charge spread evenly from the min to the max start percent.

    The spread is by index, with no randomness, so a run is repeatable and a raised floor
    cuts the fleet in a visible place (about half the homes drop out at 60%).
    """
    n = settings["fleet_size"]
    kwh = settings["home_kwh"]
    lo, hi = settings["home_start_soc_min_pct"], settings["home_start_soc_max_pct"]
    zones = list(settings["zones"])
    homes = []
    for i in range(1, n + 1):
        pct = lo if n == 1 else lo + (hi - lo) * (i - 1) / (n - 1)
        homes.append(Home(f"home-{i:03d}", kwh, kwh * pct / 100, settings["home_max_kw"],
                          zone=assign_zone(i, zones)))
    return homes


def set_status(home, status):
    """Change one home's status. Anything outside the contract's three values is a bug."""
    if status not in STATUSES:
        raise ValueError(f"unknown home status {status!r} for {home.home_id}")
    home.status = status


def apply_events(homes, events):
    """Mark homes dead, stale or live from the tape frame's events. Touches status only.

    Other event keys (for example "operator") belong to the engine and are ignored here.
    """
    by_id = {h.home_id: h for h in homes}
    for status in STATUSES:
        for home_id in events.get(status, []):
            if home_id not in by_id:
                raise ValueError(f"tape event names {home_id!r}, which is not in the fleet")
            set_status(by_id[home_id], status)


def has_unknown_zone(home, policy):
    """A zone missing from the policy's floor table. With no table at all, reserve_pct covers everyone."""
    return bool(policy.zone_reserve_pct) and home.zone not in policy.zone_reserve_pct


def floor_kwh(home, policy):
    """The energy this home must keep, using its zone's floor when the policy has one."""
    pct = policy.zone_reserve_pct.get(home.zone, policy.reserve_pct)
    return home.capacity_kwh * pct / 100


def safe_kw(home, policy, settings):
    """The most this home can give this tick: headroom above its floor, capped by its max kW.

    A home whose zone has no floor in the policy gets 0: we do not guess which floor applies.
    """
    if has_unknown_zone(home, policy):
        return 0.0
    headroom = max(0.0, home.soc_kwh - floor_kwh(home, policy))
    return min(home.max_kw, headroom * 60 / settings["tick_minutes"])


def discharge(homes, alloc, policy, settings):
    """Apply the allocation and return how many homes ended below their floor (must be 0).

    Second guard on the floor: each order is clamped to the home's safe kW (headroom under its
    current zone floor, and its max kW), so a clamp instead of a breach is the normal outcome
    of a bad order. A home that is not live cannot act on an order, so it is left alone.
    Called once per tick; it sees no command ids, so duplicate protection lives in run_cycle.
    """
    by_id = {h.home_id: h for h in homes}
    breaches = 0
    for home_id, kw in alloc.per_home_kw.items():
        if kw <= 0:
            continue
        home = by_id[home_id]
        if home.status != "live":
            continue
        actual_kw = min(kw, safe_kw(home, policy, settings))
        if actual_kw <= 0:
            continue  # already at or under its floor: it gives nothing, and that is not a breach
        home.soc_kwh -= actual_kw * settings["tick_minutes"] / 60
        if home.soc_kwh < floor_kwh(home, policy) - 1e-9:
            breaches += 1  # only possible if the clamp above is removed (the mutation demo)
    return breaches
