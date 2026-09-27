export type Mode = "AUTO" | "HOLD" | "RESERVE"

export type Quality =
  | "ok"
  | "timeout"
  | "http"
  | "bad_payload"
  | "missing_field"
  | "impossible_value"
  | "stale"

export type TickSource = "live" | "playback"

export type ReserveReason =
  | "normal"
  | "stress_high"
  | "signal_untrusted"
  | "operator_hold"
  | "command_rejected"

export type StressLevel = "LOW" | "HIGH"

export type CalmStreak = 0 | 1 | 2

export type AttentionInput = "target" | "price" | "stress"

export type AttentionChoice = "approve" | "retry" | "skip"

export type HomeStatus = "live" | "stale" | "dead" | "unconfirmed"

/** ERCOT load zones on a home row. Missing on older fixtures. */
export const HOME_ZONES = ["South", "North", "West", "Houston"] as const

export type HomeZone = (typeof HOME_ZONES)[number]

/** Last reported SunSpec-style charge state. Missing until the feed writes. */
export const CHARGE_STATES = ["CHARGING", "DISCHARGING", "HOLDING", "FULL", "EMPTY"] as const

export type ChargeState = (typeof CHARGE_STATES)[number]

export type Ack = "ok" | "rejected" | "timeout"

export type SkipReason =
  | "below_floor"
  | "stale"
  | "dead"
  | "unconfirmed"
  | "hold"
  | "reserve"

export type Target = {
  mw: number
  source: string
  as_of: string
  quality: Quality
}

export type Price = {
  usd_mwh: number
  source: string
  as_of: string
  quality: Quality
}

export type Reserve = {
  pct: number
  reason: ReserveReason
  sellable_mwh: number
  held_mwh: number
}

export type Stress = {
  outage_mw: number
  threshold_mw: number
  margin_mw: number
  zone_id: string
  level: StressLevel | null
  as_of: string
  quality: Quality
  calm_streak: CalmStreak
}

export type Fleet = {
  live: number
  stale: number
  dead: number
  unconfirmed: number
  breaches: number
}

export type Attention = {
  attention_id: string
  reason: string
  input: AttentionInput
  prompt: string
  choices: AttentionChoice[]
  retry_spent: boolean
}

export type Tick = {
  tick_id: string
  ts: string
  source: TickSource
  tape_id: string | null
  mode: Mode
  target: Target
  price: Price
  delivered_mw: number
  missed_mw: number
  reserve: Reserve
  stress: Stress
  fleet: Fleet
  quality: Quality
  reasons: string[]
  brief: string
  attention: Attention | null
}

export type Zone = {
  zone_id: string
  zone_name: string
  reserve_pct_normal: number
  reserve_pct_stressed: number
  stress_threshold_mw: number
  stress_margin_mw: number
  tick_minutes: number
}

export type HomeCommand = {
  kw: number
  sent_at: string
  ack: Ack | null
}

export type Home = {
  home_id: string
  status: HomeStatus
  zone: HomeZone | null
  capacity_kwh: number
  soc_kwh: number
  floor_kwh: number
  max_kw: number
  assigned_kw: number
  eligible: boolean
  skip_reason: SkipReason | null
  last_seen: string
  last_command: HomeCommand | null
  charge_state: ChargeState | null
  power_kw: number | null
  /** Task 17, add-only: the engine's display name (e.g. Houston-FortBend-005) and county name from GET /v1/homes. */
  name?: string | null
  county_name?: string | null
}

export type Tape = {
  tape_id: string
  title: string
  ticks: number
  labeled: string
}

export type HomeReading = {
  tick: number | null
  seen_at: string
  soc_kwh: number
  charge_state: ChargeState | null
  power_kw: number | null
}

export type HomeHistoryCommand = {
  command_id: string
  tick: number | null
  kw: number
  actual_kw: number | null
  ack: Ack | null
  sent_at: string
}

export type HomeHistory = {
  home_id: string
  readings: HomeReading[]
  commands: HomeHistoryCommand[]
}

export type Playback = {
  tape_id: string
  tick_index: number
  tick_count: number
}
