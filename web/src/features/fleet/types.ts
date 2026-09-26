/** Home object from GET /v1/homes. Ack null means no ack yet. */

export type HomeStatus = "live" | "stale" | "dead" | "unconfirmed"

export type StatusFilter = "all" | HomeStatus

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
  capacity_kwh: number
  soc_kwh: number
  floor_kwh: number
  max_kw: number
  assigned_kw: number
  eligible: boolean
  skip_reason: SkipReason
  last_seen: string
  last_command: LastCommand | null
}

export type FleetPageProps = {
  homes: Home[]
  statusFilter: StatusFilter
  onFilter: (status: StatusFilter) => void
  onOpenHome: (homeId: string) => void
}

export type HomePageProps = {
  home: Home
  onBack: () => void
}
