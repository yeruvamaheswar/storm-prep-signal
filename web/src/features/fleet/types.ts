/** Home object from GET /v1/homes. Ack null means no ack yet. */

export type HomeStatus = "live" | "stale" | "dead" | "unconfirmed"

export type HomeZone = "South" | "North" | "West" | "Houston"

export type ChargeState = "CHARGING" | "DISCHARGING" | "HOLDING" | "FULL" | "EMPTY"

export type StatusFilter = "all" | HomeStatus

export type ZoneFilter = "all" | HomeZone

export type Ack = "ok" | "rejected" | "timeout" | null

export type SkipReason =
  | "below_floor"
  | "stale"
  | "dead"
  | "unconfirmed"
  | "hold"
  | "reserve"
  | null

export type LastCommand = {
  kw: number
  sent_at: string
  ack: Ack
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
  skip_reason: SkipReason
  last_seen: string
  last_command: LastCommand | null
  charge_state: ChargeState | null
  power_kw: number | null
  /** Task 17, add-only: the engine's display name and county name (GET /v1/homes). Shown through homeName. */
  name?: string | null
  county_name?: string | null
}

export type FleetPageProps = {
  homes: Home[]
  statusFilter: StatusFilter
  zoneFilter: ZoneFilter
  query: string
  offset: number
  limit: number
  hasMore: boolean
  onFilter: (status: StatusFilter) => void
  onZone: (zone: ZoneFilter) => void
  onQuery: (query: string) => void
  onPage: (offset: number) => void
  onOpenHome: (homeId: string) => void
}

export type HomePageProps = {
  home: Home
  onBack: () => void
}
