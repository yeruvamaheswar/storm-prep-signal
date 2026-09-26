// Prop types for the shift screen. They follow the Tick, Zone, and Home objects
// in the operator-console plan. This folder does not import web/src/domain.

export type Mode = "AUTO" | "HOLD" | "RESERVE"

export type TickSource = "live" | "playback"

export type Quality =
  | "ok"
  | "timeout"
  | "http"
  | "bad_payload"
  | "missing_field"
  | "impossible_value"
  | "stale"

export type MoneySource = "ercot" | "utility" | `tape:${string}`

export type ReserveReason =
  | "normal"
  | "stress_high"
  | "signal_untrusted"
  | "operator_hold"
  | "command_rejected"

export type StressLevel = "LOW" | "HIGH" | null

export type AttentionChoice = "approve" | "retry" | "skip"

export type AttentionInput = "target" | "price" | "stress"

export type HomeStatus = "live" | "stale" | "dead" | "unconfirmed"

export type Zone = {
  zone_id: string
  zone_name: string
  reserve_pct_normal: number
  reserve_pct_stressed: number
  stress_threshold_mw: number
  stress_margin_mw: number
  tick_minutes: number
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
  target: {
    mw: number
    source: MoneySource
    as_of: string
    quality: Quality
  }
  price: {
    usd_mwh: number
    source: MoneySource
    as_of: string
    quality: Quality
  }
  delivered_mw: number
  missed_mw: number
  reserve: {
    pct: number
    reason: ReserveReason
    sellable_mwh: number
    held_mwh: number
  }
  stress: {
    outage_mw: number
    threshold_mw: number
    margin_mw: number
    zone_id: string
    level: StressLevel
    as_of: string
    quality: Quality
    calm_streak: 0 | 1 | 2
  }
  fleet: {
    live: number
    stale: number
    dead: number
    unconfirmed: number
    breaches: number
  }
  quality: Quality
  reasons: string[]
  brief: string
  attention: Attention | null
}

export type RecentTick = {
  tick_id: string
  target_mw: number
  delivered_mw: number
}

export type WallHome = {
  home_id: string
  status: HomeStatus
}

export type WallPageProps = {
  zone: Zone
  tick: Tick
  recentTicks: RecentTick[]
  homes: WallHome[]
  onMode: (mode: "HOLD" | "AUTO") => void
  onAttention: (choice: AttentionChoice) => void
  onOpenHome: (homeId: string) => void
}
