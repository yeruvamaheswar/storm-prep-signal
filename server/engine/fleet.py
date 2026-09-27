"""The simulated fleet: build the homes, mark their status, and apply an allocation.

Every home is a `Home` from contracts.py. There is no hardware here; "discharging" a home
means lowering its `soc_kwh` by the energy it gave. The floor is checked again in
`discharge`, so a wrong or late order can never take a home below its zone's reserve.
"""
import json
import math
import os
from dataclasses import asdict
from pathlib import Path

from server.engine.contracts import Allocation, Home, Policy

STATUSES = ("live", "stale", "dead")
# Same order as web/src/components/organisms/homeNodes.ts ZONE_ORDER. Settings
# still win when new_fleet gets a dict; this order is for new_fleet(n).
ZONE_ORDER = ("South", "North", "West", "Houston")
ZONE_FIPS = {"South": "48355", "North": "48113", "West": "48329", "Houston": "48201"}
# Simulation roster, not ERCOT's county map. Anchor county (ZONE_FIPS) first.
ZONE_COUNTIES = {
    "Houston": (("48201", "Harris"), ("48157", "Fort Bend"), ("48039", "Brazoria"),
                ("48167", "Galveston"), ("48339", "Montgomery")),
    "North": (("48113", "Dallas"), ("48439", "Tarrant"), ("48085", "Collin"), ("48121", "Denton")),
    "West": (("48329", "Midland"), ("48135", "Ector"), ("48451", "Tom Green"), ("48441", "Taylor")),
    "South": (("48355", "Nueces"), ("48029", "Bexar"), ("48453", "Travis"), ("48215", "Hidalgo")),
}
COUNTY_NAMES = {fips: name for counties in ZONE_COUNTIES.values() for fips, name in counties}
HOME_KWH = 25.0
HOME_MAX_KW = 11.4
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


def zone_counties(settings):
    """(zone, fips, name) for each roster county of the settings' zones, in roster order.

    A zone missing from the roster has one county: its ZONES anchor, named by its FIPS.
    """
    zones = settings["zones"]
    order = [zone for zone in ZONE_COUNTIES if zone in zones] + [zone for zone in zones if zone not in ZONE_COUNTIES]
    return [(zone, fips, name) for zone in order
            for fips, name in ZONE_COUNTIES.get(zone, ((zones[zone], zones[zone]),))]


def assign_county(index_in_zone, counties):
    """County for the zone's home number `index_in_zone` (1-based): round-robin, like assign_zone."""
    return counties[(index_in_zone - 1) % len(counties)]


def county_name(fips):
    return COUNTY_NAMES.get(fips, fips)


def home_label(home):
    """Display name like Houston-FortBend-005. The number is the home_id's; home_id never changes."""
    return f"{home.zone}-{county_name(home.county).replace(' ', '')}-{home.home_id.rsplit('-', 1)[-1]}"


def fleet_cap_mw(settings):
    """Hard cap: FLEET_SIZE × HOME_MAX_KW / 1000. 10k × 11.4 kW = 114 MW."""
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
    target = scale_target_mw(sized.get("target_mw") or 0, settings)
    delivered_mw = min(scale_target_mw(sized.get("delivered_mw") or 0, settings), target)
    sized["target_mw"] = target
    sized["delivered_mw"] = delivered_mw
    # Scaled on its own, a capped target breaks the books; missed is what was not delivered.
    sized["missed_mw"] = max(0.0, target - delivered_mw)
    if "charging_mw" in sized:
        sized["charging_mw"] = scale_target_mw(sized.get("charging_mw") or 0, settings)
    for key in ("zone_delivered_mw", "zone_charging_mw"):
        by_zone = sized.get(key)
        if isinstance(by_zone, dict):
            sized[key] = {zone: scale_target_mw(mw, settings) for zone, mw in by_zone.items()}
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
    """Example 11.4 kW / 25 kWh homes, 45–75% charge, wall zone order. Not Base specs."""
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


def fleet_counties(settings):
    """{home_id: (zone, county FIPS)} for new_fleet(settings), in fleet order.

    The same rule scenario.seed_fleet uses: each zone's homes take its roster counties
    round-robin (assign_county) by their place within the zone. No randomness. `settings`
    may be that dict, or an int n (seed_settings: the Supabase seed's ZONE_ORDER, South first,
    as scripts/seed_homes.py wrote public.homes). The engine (Live worker and Replay) uses the
    ZONES order instead, Houston first, so per-id zones differ; counts per zone and county do not.
    See docs/agents/demo-fleet.md, Counties.
    """
    if isinstance(settings, int):
        settings = seed_settings(settings)
    counties = {}
    for zone, fips, _ in zone_counties(settings):
        counties.setdefault(zone, []).append(fips)
    in_zone, out = {}, {}
    for home in new_fleet(settings):
        in_zone[home.zone] = in_zone.get(home.zone, 0) + 1
        out[home.home_id] = (home.zone, assign_county(in_zone[home.zone], counties[home.zone]))
    return out


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


def fleet_rollups(homes, alloc=None, policy=None, confirmed_kw=None, unconfirmed=frozenset()):
    """Per-zone counts and MW. No home ids. Silent is stale plus unconfirmed.

    Reserved matches the wall: on HIGH, every live home that is not discharging.
    With confirmed_kw (home_id to booked kW, from the orchestrator), only confirmed homes are
    discharging; a live home in `unconfirmed` (sent work, never heard back) is silent, not live,
    since the wall reads silent minus stale as unconfirmed. Without it, the plan is used.
    """
    per_home_kw = confirmed_kw if confirmed_kw is not None else (alloc.per_home_kw if alloc is not None else {})
    zones = {}
    for home in homes:
        zone = home.zone or "unassigned"
        row = zones.setdefault(zone, _empty_zone_row())
        if home.status == "live" and home.home_id in unconfirmed:
            row["silent"] += 1
            continue
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
    """The energy this home must keep: its county's floor, else its zone's, else the fleet's."""
    pct = policy.county_reserve_pct.get(home.county, policy.zone_reserve_pct.get(home.zone, policy.reserve_pct))
    return home.capacity_kwh * pct / 100


def safe_kw(home, policy, settings):
    """The most this home can give this tick: headroom above its floor, capped by its max kW.

    A home whose zone has no floor in the policy gets 0: we do not guess which floor applies.
    """
    if has_unknown_zone(home, policy):
        return 0.0
    headroom = max(0.0, home.soc_kwh - floor_kwh(home, policy))
    return min(home.max_kw, headroom * 60 / settings["tick_minutes"])


def room_kw(home, settings):
    """The most this home can take in this tick: room left to full, capped by its max kW."""
    room = max(0.0, home.capacity_kwh - home.soc_kwh)
    return min(home.max_kw, room * 60 / settings["tick_minutes"])


def zone_hours_needed(homes, settings, grid_down=()):
    """Zone to whole hours of charging that fill it: ceil(room kWh / max kW), both summed over the zone.

    Counts live homes in a known zone whose grid is up; a zone with none of them needs 0.
    Pure. Pass the planner's view (reported homes when the battery feed is on), never the truth.
    """
    room, rate = {}, {}
    for home in homes:
        if home.status != "live" or home.zone in grid_down:
            continue
        room[home.zone] = room.get(home.zone, 0.0) + max(0.0, home.capacity_kwh - home.soc_kwh)
        rate[home.zone] = rate.get(home.zone, 0.0) + home.max_kw
    # 1e-9 keeps float noise (19.000000001 kWh at 1 kW) from asking for an extra hour.
    return {zone: (math.ceil(room.get(zone, 0.0) / rate[zone] - 1e-9) if rate.get(zone) else 0)
            for zone in settings.get("zones", {})}


def discharge(homes, alloc, policy, settings):
    """Apply the allocation and return how many homes ended below their floor (must be 0).

    Second guard on the floor: each order is clamped to the home's safe kW (headroom under its
    current zone floor, and its max kW), so a clamp instead of a breach is the normal outcome
    of a bad order. A negative order charges, clamped to `room_kw`, so it never fills past
    capacity; charge is never a breach. A home that is not live cannot act on an order.
    Called once per tick; it sees no command ids, so duplicate protection lives in orchestrate_tick.
    """
    by_id = {h.home_id: h for h in homes}
    breaches = 0
    for home_id, kw in alloc.per_home_kw.items():
        home = by_id[home_id]
        if kw == 0 or home.status != "live":
            continue
        if kw < 0:
            home.soc_kwh += min(-kw, room_kw(home, settings)) * settings["tick_minutes"] / 60
            continue
        # Headroom <= 0 means the home is already at or under its floor. Skip it.
        # That is not a breach: breaches counts a discharge that crosses the floor.
        if safe_kw(home, policy, settings) <= 0:
            continue
        actual_kw = min(kw, safe_kw(home, policy, settings))
        if actual_kw <= 0:
            continue
        home.soc_kwh -= actual_kw * settings["tick_minutes"] / 60
        if home.soc_kwh < floor_kwh(home, policy) - 1e-9:
            breaches += 1  # only possible if the clamp above is removed (the mutation demo)
    return breaches
