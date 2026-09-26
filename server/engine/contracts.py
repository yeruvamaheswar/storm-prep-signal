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
    # events keys: "dead", "stale", "live" (lists of home_id), "operator" ("HOLD" | "AUTO")
    weather_fixture: Optional[str] = None  # path to a saved weather alerts response

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

@dataclass
class Allocation:
    # Signed kW, only for homes given work. >0 discharge (sell), <0 charge (absorb).
    # One field, not per_home_charge_kw / per_home_discharge_kw. See CONSTRAINTS.md.
    per_home_kw: dict
    delivered_mw: float
    missed_mw: float          # target_mw minus delivered_mw, never negative
    reasons: list = field(default_factory=list)
    # reason codes: "operator_hold", "storm_reserve", "signal_unavailable",
    # "homes_dead:<n>", "homes_stale:<n>", "fleet_headroom_short"

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
    intent: str = "hold"              # "charge" | "discharge" | "hold"
    intent_reason: str = ""           # policy reason, or "operator_hold" when mode is HOLD
    zone_reserve_pct: dict = field(default_factory=dict)   # zone name to floor percent
    zone_reasons: dict = field(default_factory=dict)       # zone name to reason code
    zone_delivered_mw: dict = field(default_factory=dict)  # zone name to MW delivered
    weather_label: str = "none"  # source of the weather alerts, or "none"
    price_as_of: Optional[str] = None  # Central interval end when price_label is ercot
    # Zone name to {acked, held, silent, dead, unconfirmed}. In-process rollup until devices exist.
    zone_acks: dict = field(default_factory=dict)
