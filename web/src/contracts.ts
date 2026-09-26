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
}

export type TickView = TickResult & {
  brief: string
  houston_mw?: number
  north_mw?: number
  south_mw?: number
  west_mw?: number
}

export type RunFile = {
  run_id: string
  decision_line: string | null
  ticks: TickView[]
}
