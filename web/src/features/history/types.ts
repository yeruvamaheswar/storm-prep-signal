/** Field names match Tape, Playback, and Tick in docs/agents/plans/operator-console.md. */

export type TickSource = "live" | "playback"

export type FeedSource = "ercot" | "utility" | `tape:${string}`

export type Mode = "AUTO" | "HOLD" | "RESERVE"

export type Quality =
  | "ok"
  | "timeout"
  | "http"
  | "bad_payload"
  | "missing_field"
  | "impossible_value"
  | "stale"

export type StressLevel = "LOW" | "HIGH"

export type ReserveReason =
  | "normal"
  | "stress_high"
  | "signal_untrusted"
  | "operator_hold"
  | "command_rejected"

export type AttentionChoice = "approve" | "retry" | "skip"

export type AttentionInput = "target" | "price" | "stress"

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

export type Target = {
  mw: number
  source: FeedSource
  as_of: string
  quality: Quality
}

export type Price = {
  usd_mwh: number
  source: FeedSource
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
  calm_streak: number
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

export type PlaybackPageProps = {
  tapes: Tape[]
  playback: Playback | null
  onStart: (tapeId: string) => void
  onStop: () => void
}

export type LogPageProps = {
  ticks: Tick[]
  selectedTickId: string | null
  onSelect: (tickId: string) => void
}
