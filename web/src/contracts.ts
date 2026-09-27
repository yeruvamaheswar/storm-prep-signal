/** Field names match storm_prep/contracts.py. That file wins if these disagree. */

export type Mode = "AUTO" | "HOLD"

export type RiskLevel = "LOW" | "HIGH"

export type TickResult = {
  tick: number
  ts: string
  mode: Mode
  target_mw: number
  target_label: string
  delivered_mw: number
  missed_mw: number
  price_usd_mwh: number | null
  price_label: string
  reserve_pct: number
  policy_reason: string
  risk_level: RiskLevel | null
  live_homes: number
  stale_homes: number
  dead_homes: number
  breaches: number
  reasons: string[]
  zone_acks?: Record<string, ZoneAckCounts>
  /** Simulated battery feed rollups; empty objects when TELEMETRY_FEED=0. */
  plant?: Record<string, unknown>
  zone_telemetry?: Record<string, Record<string, unknown>>
  /** The snapshot bundles plant and the engine's feed counts here. `feed` stays the ERCOT text. */
  telemetry?: TickTelemetry
  /** Next 24 h of DAM hours by load zone. The snapshot drops it when the tick is stale. */
  dam_hours?: Record<string, DamHour[]>
  /** "ercot" | "recorded:ERCOT NP4-190-CD" | "none" */
  dam_label?: string
  dam_as_of?: string | null
  zone_hours_needed?: Record<string, number>
  /** Chosen charge hours by load zone, as DamHour.hour_start strings. */
  zone_charge_hours?: Record<string, string[]>
  /** "dam_cheap_hour" | "before_spike" | "rt_dip" | "cheaper_hour_later" | "no_payback" | "full" | "sell_band" */
  zone_charge_why?: Record<string, string>
}

export type DamHour = { hour_start: string; usd_mwh: number }

/** Built from battery reports only (docs/agents/telemetry-vpp.md). All numbers are synthetic. */
export type TickTelemetry = {
  plant: { homes: { total: number; live: number; suspect: number } }
  readings: { received: number; accepted: number; duplicates: number; late: number }
}

export type ZoneAckCounts = {
  acked: number
  held: number
  silent: number
  dead: number
  unconfirmed: number
}

export type TickView = TickResult & {
  brief: string
  houston_mw?: number
  north_mw?: number
  south_mw?: number
  west_mw?: number
  zone_delivered_mw?: Record<string, number>
  outage_mw?: number | null
  peak_mw?: number | null
  trigger_mw?: number | null
  threshold_mw?: number | null
  margin_mw?: number | null
  driving_zone?: string | null
  zone_mw?: number | null
  as_of?: string | null
  quality?: string
  feed?: string
  clock_pinned?: boolean
  source?: string
  event?: string | null
  clock?: string | null
  feeds?: FeedHealth[]
  /** LZ settlement $/MWh keyed by load zone. Present only when a row exists. */
  zone_prices?: Partial<Record<string, number>>
}

/** Per-product health from GET /v1/snapshot. QUALITY/AS OF used to be derived from one stamp. */
export type FeedHealth = {
  product: string
  path: string
  as_of: string | null
  age_min: number | null
  quality: string
  hold_on_fail: boolean
  http_status?: number | null
}

/** GET /v1/fleet/rollups. Zone grain only; the body never lists homes. */
export type ZoneRollup = {
  live: number
  reserved: number
  discharging: number
  stale: number
  dead: number
  silent: number
  reserved_mw: number
  discharging_mw: number
}

export type FleetRollups = {
  n: number
  zones: Record<string, ZoneRollup>
  clusters?: { id: string; zone: string; lng: number; lat: number }[]
}

export type RunFile = {
  run_id: string
  decision_line: string | null
  ticks: TickView[]
  source?: string
  settings?: { fleet_size?: number }
}

export type WallMeta = {
  mode: "live" | "demo"
  fleet_size: number
  source: string
  event: string | null
  clock: string | null
  fleet_cap_mw?: number
  call_target_mw?: number
}
