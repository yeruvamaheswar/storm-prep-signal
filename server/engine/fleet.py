"""The simulated fleet: build the homes, mark their status, and apply an allocation.

Every home is a `Home` from contracts.py. There is no hardware here; "discharging" a home
means lowering its `soc_kwh` by the energy it gave. The floor is checked again in
`discharge`, so a wrong or late order can never take a home below its zone's reserve.
"""
import json
import os
from dataclasses import asdict
from pathlib import Path

from server.engine.contracts import Allocation, Home, Policy

STATUSES = ("live", "stale", "dead")
# Same order as web/src/components/organisms/homeNodes.ts ZONE_ORDER. Settings
# still win when new_fleet gets a dict; this order is for new_fleet(n).
ZONE_ORDER = ("South", "North", "West", "Houston")
ZONE_FIPS = {"South": "48355", "North": "48113", "West": "48329", "Houston": "48201"}
HOME_KWH = 20.0
HOME_MAX_KW = 5.0
SOC_MIN_PCT = 45.0
SOC_MAX_PCT = 75.0
# Demo tape is 100 homes / 0.40 MW peak. Live/archive scale from that, not the fixture number.
DEMO_FLEET_SIZE = 100
DEMO_PEAK_MW = 0.40
ACK_COUNT_KEYS = ("acked", "held", "silent", "dead", "unconfirmed")
# Metro box centers from homeNodes.ts CITY_WEIGHTS. Not street addresses.
CLUSTER_CENTROIDS = (
    {"id": "South:0", "zone": "South", "lng": -98.475, "lat": 29.45},
    {"id": "South:1", "zone": "South", "lng": -97.7, "lat": 30.275},
    {"id": "North:0", "zone": "North", "lng": -97.0, "lat": 32.825},
    {"id": "West:0", "zone": "West", "lng": -102.175, "lat": 31.925},
    {"id": "Houston:0", "zone": "Houston", "lng": -95.45, "lat": 29.775},
)
FLEET_DIR = Path("var") / "fleet"


def assign_zone(index, zones):
    """Zone for home number `index` (1-based): round-robin over the zones in settings order.

    Kept as one tiny function so the team can swap in contiguous blocks with one edit.
    """
    return zones[(index - 1) % len(zones)]


def fleet_cap_mw(settings):
    """Hard cap: FLEET_SIZE × HOME_MAX_KW / 1000. 10k × 5 kW = 50 MW."""
    return float(settings["fleet_size"]) * float(settings["home_max_kw"]) / 1000.0


def call_target_mw(settings):
    """The live/archive high call. Unset scales the demo 0.40 peak with fleet size."""
    cap = fleet_cap_mw(settings)
    raw = settings.get("call_target_mw")
    if raw is None:
        raw = DEMO_PEAK_MW * int(settings["fleet_size"]) / DEMO_FLEET_SIZE
    return min(float(raw), cap)


def scale_target_mw(tape_mw, settings):
    """Map a 100-home tape MW onto this fleet. Demo (100 homes, no override) is identity."""
    if int(settings["fleet_size"]) == DEMO_FLEET_SIZE and settings.get("call_target_mw") is None:
        return float(tape_mw)
    peak = call_target_mw(settings)
    return min(float(tape_mw) * (peak / DEMO_PEAK_MW), fleet_cap_mw(settings))


def _share(total, parts):
    """Largest-remainder split so integer parts sum to total."""
    weight = sum(parts)
    if total <= 0:
        return [0] * len(parts)
    if weight <= 0:
        out = [0] * len(parts)
        out[0] = total
        return out
    raw = [total * part / weight for part in parts]
    ints = [int(value) for value in raw]
    leftover = total - sum(ints)
    order = sorted(range(len(ints)), key=lambda i: raw[i] - ints[i], reverse=True)
    for i in range(leftover):
        ints[order[i % len(ints)]] += 1
    return ints


def scale_tick_to_fleet(tick, settings):
    """Rewrite a 100-home tick so counts and MW follow FLEET_SIZE. No-op when already sized."""
    sized = dict(tick)
    n = int(settings["fleet_size"])
    live = int(sized.get("live_homes") or 0)
    stale = int(sized.get("stale_homes") or 0)
    dead = int(sized.get("dead_homes") or 0)
    current = live + stale + dead
    if current == n:
        return sized
    if current <= 0:
        sized["live_homes"] = n
        sized["stale_homes"] = 0
        sized["dead_homes"] = 0
        sized["target_mw"] = scale_target_mw(sized.get("target_mw") or 0, settings)
        return sized
    live, stale, dead = _share(n, [live, stale, dead])
    sized["live_homes"] = live
    sized["stale_homes"] = stale
    sized["dead_homes"] = dead
    sized["target_mw"] = scale_target_mw(sized.get("target_mw") or 0, settings)
    sized["delivered_mw"] = scale_target_mw(sized.get("delivered_mw") or 0, settings)
    sized["missed_mw"] = scale_target_mw(sized.get("missed_mw") or 0, settings)
    delivered = sized.get("zone_delivered_mw")
    if isinstance(delivered, dict):
        sized["zone_delivered_mw"] = {
            zone: scale_target_mw(mw, settings) for zone, mw in delivered.items()
        }
    acks = sized.get("zone_acks")
    if isinstance(acks, dict):
        factor = n / current
        scaled = {}
        for zone, row in acks.items():
            if not isinstance(row, dict):
                scaled[zone] = row
                continue
            parts = [int(row.get(key) or 0) for key in ACK_COUNT_KEYS]
            shared = _share(round(sum(parts) * factor), parts)
            scaled[zone] = {**row, **dict(zip(ACK_COUNT_KEYS, shared))}
        sized["zone_acks"] = scaled
    return sized


def seed_settings(n):
    """Example 5 kW / 20 kWh homes, 45–75% charge, wall zone order. Not Base specs."""
    return {
        "fleet_size": n,
        "home_kwh": HOME_KWH,
        "home_max_kw": HOME_MAX_KW,
        "home_start_soc_min_pct": SOC_MIN_PCT,
        "home_start_soc_max_pct": SOC_MAX_PCT,
        "zones": {name: ZONE_FIPS[name] for name in ZONE_ORDER},
    }


def new_fleet(settings, persist=False, path=None):
    """`fleet_size` homes with charge spread evenly from the min to the max start percent.

    `settings` may be that dict, or an int n (uses seed_settings). The spread is by
    index, with no randomness, so a run is repeatable and a raised floor cuts the
    fleet in a visible place (about half the homes drop out at 60%). Persist writes
    only the homes file under var/fleet/; it is opt-in and git-ignored.
    """
    if isinstance(settings, int):
        settings = seed_settings(settings)
    n = settings["fleet_size"]
    kwh = settings["home_kwh"]
    lo, hi = settings["home_start_soc_min_pct"], settings["home_start_soc_max_pct"]
    zones = list(settings["zones"])
    homes = []
    for i in range(1, n + 1):
        pct = lo if n == 1 else lo + (hi - lo) * (i - 1) / (n - 1)
        homes.append(Home(f"home-{i:03d}", kwh, kwh * pct / 100, settings["home_max_kw"],
                          status="live", zone=assign_zone(i, zones)))
    if persist:
        save_fleet(homes, path)
    return homes


def save_fleet(homes, path=None):
    """Write the seeded homes. Callers that need the wall should read rollups, not this file."""
    dest = Path(path or FLEET_DIR / "homes.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps([asdict(home) for home in homes]))
    return dest


def load_fleet(path=None):
    """Read a persisted seed. Missing file is None, not an empty fleet."""
    src = Path(path or FLEET_DIR / "homes.json")
    if not src.is_file():
        return None
    return [Home(**row) for row in json.loads(src.read_text())]


def zone_delivered(homes, alloc):
    """MW each zone actually gave this tick. Sums to Allocation.delivered_mw."""
    by_id = {home.home_id: home for home in homes}
    delivered = {}
    for home_id, kw in alloc.per_home_kw.items():
        if kw <= 0:
            continue
        home = by_id.get(home_id)
        if home is None or not home.zone:
            continue
        delivered[home.zone] = delivered.get(home.zone, 0.0) + kw / 1000
    return delivered


def _empty_zone_row():
    return {
        "live": 0, "reserved": 0, "discharging": 0,
        "stale": 0, "dead": 0, "silent": 0,
        "reserved_mw": 0.0, "discharging_mw": 0.0,
    }


def fleet_rollups(homes, alloc=None, policy=None):
    """Per-zone counts and MW. No home ids. Silent is stale (no unconfirmed on this fleet).

    Reserved matches the wall: on HIGH, every live home that is not discharging.
    """
    per_home_kw = alloc.per_home_kw if alloc is not None else {}
    zones = {}
    for home in homes:
        zone = home.zone or "unassigned"
        row = zones.setdefault(zone, _empty_zone_row())
        if home.status == "live":
            row["live"] += 1
        elif home.status == "stale":
            row["stale"] += 1
            row["silent"] += 1
        elif home.status == "dead":
            row["dead"] += 1
        kw = per_home_kw.get(home.home_id, 0.0)
        if home.status == "live" and kw > 0:
            row["discharging"] += 1
            row["discharging_mw"] += kw / 1000
        elif home.status == "live" and policy is not None and policy.risk_level == "HIGH":
            row["reserved"] += 1
            row["reserved_mw"] += home.max_kw / 1000
    return {"n": len(homes), "zones": zones, "clusters": [dict(item) for item in CLUSTER_CENTROIDS]}


def save_rollups(rollups, path=None):
    dest = Path(path or FLEET_DIR / "rollups.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(rollups))
    return dest


def load_rollups(path=None):
    src = Path(path or FLEET_DIR / "rollups.json")
    if not src.is_file():
        return None
    return json.loads(src.read_text())


def current_rollups(fleet_dir=None, n=None):
    """What GET /v1/fleet/rollups returns. n follows FLEET_SIZE. Never a homes list."""
    size = int(n if n is not None else os.getenv("FLEET_SIZE", "100"))
    folder = Path(fleet_dir or FLEET_DIR)
    saved = load_rollups(folder / "rollups.json")
    if saved is not None and saved.get("n") == size:
        return saved
    homes = load_fleet(folder / "homes.json")
    if homes is None or len(homes) != size:
        # In-memory seed only. Do not persist a homes table.
        homes = new_fleet(size)
    return fleet_rollups(homes)


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
