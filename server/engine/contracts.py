"""Shared data shapes. Fields may be added, never renamed or removed."""
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class Home:
    home_id: str
    capacity_kwh: float
    soc_kwh: float            # energy stored right now
    max_kw: float             # fastest it can discharge
    status: str = "live"      # "live" | "stale" | "dead"
    zone: str = ""            # ERCOT load zone name from the ZONES setting, "" if unassigned
    updated_at: str = ""      # ISO 8601 with UTC offset; "" until the fleet stamps a write
    county: str = ""          # county FIPS from fleet.ZONE_COUNTIES, "" if unassigned

@dataclass
class TapeFrame:
    tick: int
    ts: str                   # ISO 8601 with UTC offset
    target_mw: float
    target_label: str         # "synthetic" or "recorded:<source>"
    price_usd_mwh: Optional[float]
    price_label: str          # "synthetic", "recorded:<source>", "ercot", or "none"
    risk_fixture: Optional[str] = None   # path to an ERCOT outage posting
    events: dict = field(default_factory=dict)
    # events keys: "dead", "stale", "live" (lists of home_id), "operator" ("HOLD" | "AUTO"),
    # simulated faults "network", "crash", "misreport", "short_delivery" (docs/agents/failure-modes.md),
    # "grid_down" (list of zone names whose batteries back up their own homes: no sell, no charge),
    # "weather" (zone names under an alert), "weather_counties" (county FIPS named by an alert
    # to that alert's NWS event name)
    weather_fixture: Optional[str] = None  # path to a saved weather alerts response
    # Load-zone name to $/MWh, only zones with a price (same map as the snapshot's zone_prices).
    zone_prices: dict = field(default_factory=dict)
    zone_price_label: str = "none"   # source of zone_prices, for example "recorded:<source>"
    # Paths of the NP4-190-CD day files published at this tick: today's, plus tomorrow's from 13:30 CT.
    dam_fixtures: list = field(default_factory=list)

@dataclass
class Policy:
    reserve_pct: float        # floor as a percent of capacity
    reason: str               # "normal" | "storm_risk_high" | "signal_unavailable"
    risk_level: Optional[str] # "LOW" | "HIGH" | None
    zone_reserve_pct: dict = field(default_factory=dict)  # zone name to floor percent
    zone_reasons: dict = field(default_factory=dict)      # zone name to reason code
    # Default hold: floor-only callers omit price, and allocate still only discharges.
    intent: str = "hold"              # "charge" | "discharge" | "hold"
    intent_reason: str = ""           # "price_unavailable" | "operator_hold" | ""
    # Zone name to its own price band, set only when the tick has zone prices. Empty: every
    # zone follows `intent`. See docs/agents/policy-intent.md "Each zone decides".
    zone_intent: dict = field(default_factory=dict)
    # County FIPS to floor percent and reason, for every roster county of a zone an active alert names.
    county_reserve_pct: dict = field(default_factory=dict)
    # "weather_alert" | "not_in_alert", or a fleet reason
    county_reasons: dict = field(default_factory=dict)
    # Zones with DAM hours on the tick: the hour starts picked to charge in, and why the zone charges
    # or waits ("dam_cheap_hour" | "before_spike" | "rt_dip" | "cheaper_hour_later" | "no_payback" | "full"
    # | "sell_band").
    zone_charge_hours: dict = field(default_factory=dict)
    zone_charge_why: dict = field(default_factory=dict)

@dataclass
class Allocation:
    # Signed kW, only for homes given work. >0 discharge (sell), <0 charge (absorb).
    # One field, not per_home_charge_kw / per_home_discharge_kw. See CONSTRAINTS.md.
    per_home_kw: dict
    delivered_mw: float
    missed_mw: float          # target_mw minus delivered_mw, never negative
    reasons: list = field(default_factory=list)
    # reason codes: "operator_hold", "storm_reserve", "signal_unavailable",
    # "homes_dead:<n>", "homes_stale:<n>", "fleet_headroom_short", "grid_down:<zone>"

@dataclass
class TickResult:
    tick: int
    ts: str
    mode: str                 # "AUTO" | "HOLD"
    target_mw: float
    target_label: str
    delivered_mw: float
    missed_mw: float
    price_usd_mwh: Optional[float]
    price_label: str
    reserve_pct: float
    policy_reason: str
    risk_level: Optional[str]
    live_homes: int
    stale_homes: int
    dead_homes: int
    breaches: int             # homes discharged below their floor this tick; must be 0
    reasons: list = field(default_factory=list)
    intent: str = "hold"              # what the fleet was ordered to do (controller.acted_intent)
    intent_reason: str = ""           # policy reason, "operator_hold", "grid_call", "no_grid_call", "zone_price"
    zone_reserve_pct: dict = field(default_factory=dict)   # zone name to floor percent
    zone_reasons: dict = field(default_factory=dict)       # zone name to reason code
    zone_delivered_mw: dict = field(default_factory=dict)  # zone name to MW delivered
    weather_label: str = "none"  # source of the weather alerts, or "none"
    price_as_of: Optional[str] = None  # Central interval end when price_label is ercot
    # Zone name to {acked, held, silent, dead, unconfirmed}. In-process rollup until devices exist.
    zone_acks: dict = field(default_factory=dict)
    zone_prices: dict = field(default_factory=dict)  # load-zone name to $/MWh, copied from the frame
    zone_price_label: str = "none"
    # Simulated battery feed (docs/agents/telemetry-vpp.md), built from reports only.
    # Empty when settings["telemetry_feed"] is off.
    plant: dict = field(default_factory=dict)           # plant rollup: homes by status, MWh, MW, coverage
    feed: dict = field(default_factory=dict)            # readings received, accepted, duplicates, late
    zone_telemetry: dict = field(default_factory=dict)  # zone name to the same rollup as plant
    # Confirmed charge (MW absorbed from the grid). Never counted in delivered_mw.
    charging_mw: float = 0.0
    zone_charging_mw: dict = field(default_factory=dict)  # zone name to MW absorbed
    grid_down_zones: list = field(default_factory=list)   # zones whose batteries only back up their homes
    county_reserve_pct: dict = field(default_factory=dict)  # county FIPS to floor percent (alerted zones' counties)
    county_reasons: dict = field(default_factory=dict)      # county FIPS to reason code
    # Day-ahead look-ahead (docs/agents/dam-forecast.md). Empty / "none" with no DAM on the tick.
    dam_hours: dict = field(default_factory=dict)          # zone to [{hour_start, usd_mwh}], next 24 h
    dam_label: str = "none"                                # "ercot" | "recorded:ERCOT NP4-190-CD" | "none"
    dam_as_of: Optional[str] = None                        # delivery dates read, e.g. "2026-08-30,2026-08-31"
    zone_hours_needed: dict = field(default_factory=dict)  # zone to hours of charging to fill it
    zone_charge_hours: dict = field(default_factory=dict)  # zone to the hour starts picked to charge in
    zone_charge_why: dict = field(default_factory=dict)    # zone to why it charges or waits
