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
  capacity_kwh: number
  soc_kwh: number
  floor_kwh: number
  max_kw: number
  assigned_kw: number
  eligible: boolean
  skip_reason: SkipReason | null
  last_seen: string
  last_command: HomeCommand | null
}

export type Tape = {
  tape_id: string
  title: string
  ticks: number
  labeled: string
}

export type Playback = {
  tape_id: string
  tick_index: number
  tick_count: number
}
