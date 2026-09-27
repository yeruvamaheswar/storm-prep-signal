/** Shapes from GET /v1/scenarios and GET /v1/scenario/state (server/engine/scenario.py). */

export const FLOW_ZONES = ["West", "North", "South", "Houston"] as const
export type FlowZone = (typeof FLOW_ZONES)[number]

export type BatteryState =
  | "selling"
  | "charging"
  | "holding"
  | "reserved"
  | "at_floor"
  | "below_floor"
  | "islanded"
  | "unconfirmed"
  | "stale"
  | "dead"

export type AlertSummary = {
  id: string
  event?: string
  headline?: string
  areaDesc?: string
  onset?: string
  expires?: string
  sent?: string
  sender?: string
  source_url?: string
  source_label?: string
  counties?: string[]
}

/** A roster county the alert names. Its homes keep the storm reserve. */
export type NamedCounty = {
  fips: string
  county_name: string
  zone: string
}

export type ActiveAlert = AlertSummary & {
  zones: string[]
  sent_at_tick: number | null
  /** Roster order. */
  named_counties?: NamedCounty[]
}

export type FlowCounty = { zone: string; fips: string; name: string }

export type ScenarioEntry = {
  id: string
  name: string
  event?: string
  window?: string
  summary?: string
  label?: string
  tape?: string
  baseline?: string
  alerts: AlertSummary[]
  grid_down_overlay?: boolean
}

export type ScenarioList = {
  scenarios: ScenarioEntry[]
  speeds: number[]
  default_speed: number
}

export type FlowHome = {
  id: string
  name?: string
  zone: string
  county?: string
  county_name?: string
  floor_reason?: string
  soc_pct: number
  kw: number
  state: BatteryState
  status: string
  floor_pct: number
  under_floor_why?: "started_under" | "floor_raised" | null
}

export type FlowZoneRow = {
  selling_mw: number
  charging_mw: number
  reserve_pct: number
  reason: string
  price_usd_mwh: number | null
  grid_down: boolean
  homes: number
  states: Partial<Record<BatteryState, number>>
  soc_mwh: number
}

export type FlowTick = {
  tick: number
  ts: string
  mode: string
  target_mw: number
  target_label: string
  delivered_mw: number
  missed_mw: number
  price_usd_mwh: number | null
  price_label: string
  reserve_pct: number
  policy_reason: string
  risk_level: string | null
  intent: string
  intent_reason: string
  reasons: string[]
  breaches: number
  zone_reserve_pct: Record<string, number>
  zone_reasons: Record<string, string>
  county_reserve_pct?: Record<string, number>
  county_reasons?: Record<string, string>
  brief: string
  charging_mw?: number
  grid_down_zones?: string[]
}

export type Provenance = {
  tick: number
  ts: string
  posting: {
    report: string
    table: string
    file: string
    posted_at: string | null
    rows: number
    source?: string
  } | null
  rating: {
    level: string
    peak_mw: number
    peak_hour: number
    trigger_mw: number
    baseline_mw: number
    margin_mw: number
    driving_zone: string
  } | null
  price: { usd_mwh: number | null; label: string }
  zone_prices: { label: string; zones: Record<string, number> }
  target: { mw: number; label: string }
  baseline: { file: string; postings?: number; from?: string; to?: string; source?: string }
  events: Record<string, unknown>
  archive_rows: ArchiveRows | null
}

/** Supabase rows the scenario builder read for this tick (tapes/scenarios/<id>.provenance.json). */
export type ArchiveRows = {
  posting?: { id?: number; report?: string; posted_at?: string; file_name?: string; event?: string }
  prices?: Array<{ settlement_point: string; interval_ending: string; price_usd_mwh: number }>
  overlay?: string
}

export type StartSummary = {
  seed: number
  range_pct: [number, number]
  histogram: number[]
  min_pct: number
  max_pct: number
  mean_pct: number
  below_base_floor: Record<string, number>
  base_floor_pct: number
  homes: number
  pack: { kwh: number; kw: number }
}

export type HistoryPoint = {
  tick: number
  ts: string
  target_mw: number
  delivered_mw: number
  charging_mw: number
}

export type SessionState = {
  status: "idle" | "playing" | "paused" | "finished" | "error"
  error: string | null
  updated_at: string
  scenario: (Omit<ScenarioEntry, "alerts"> & { alerts: Array<AlertSummary & { zones?: string[] }> }) | null
  seed: number | null
  speed: number
  speeds: number[]
  step_seconds: number
  tick_minutes: number
  tick_index: number
  tick_count: number
  start: StartSummary | Record<string, never>
  tick: FlowTick | null
  homes: FlowHome[]
  zones: Partial<Record<string, FlowZoneRow>>
  charging_mw: number
  provenance: Provenance | null
  alerts: ActiveAlert[]
  counties?: FlowCounty[]
  grid_down_zones: string[]
  history: HistoryPoint[]
  totals: Record<string, unknown> | null
  log: Array<{ at: string; text: string }>
  honest_limits: string[]
}

export type WorkerDown = { status: "worker_not_running"; brief: string; last_state_at?: string }

export type StateReply = SessionState | WorkerDown

export function isWorkerDown(reply: StateReply): reply is WorkerDown {
  return reply.status === "worker_not_running"
}
