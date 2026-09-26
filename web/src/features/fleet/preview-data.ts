import type { Home, HomeStatus, HomeZone, StatusFilter } from "./types"

const ZONES: HomeZone[] = ["South", "North", "West", "Houston"]
const STATUSES: HomeStatus[] = ["live", "stale", "dead", "unconfirmed"]

/** Local rows for offline fallback. One page only; never expand to 10k. */
export const previewHomes: Home[] = [
  {
    home_id: "home-001",
    status: "live",
    zone: "North",
    capacity_kwh: 20,
    soc_kwh: 16.4,
    floor_kwh: 12,
    max_kw: 5,
    assigned_kw: 3.5,
    eligible: true,
    skip_reason: null,
    last_seen: "2026-07-08T19:20:04-05:00",
    last_command: {
      kw: 3.5,
      sent_at: "2026-07-08T19:20:01-05:00",
      ack: "ok",
    },
    charge_state: "DISCHARGING",
    power_kw: 3.5,
  },
  {
    home_id: "home-008",
    status: "live",
    zone: "Houston",
    capacity_kwh: 13.5,
    soc_kwh: 9.1,
    floor_kwh: 10,
    max_kw: 5,
    assigned_kw: 0,
    eligible: false,
    skip_reason: "below_floor",
    last_seen: "2026-07-08T19:20:04-05:00",
    last_command: {
      kw: 0,
      sent_at: "2026-07-08T19:20:01-05:00",
      ack: "ok",
    },
    charge_state: "HOLDING",
    power_kw: 0,
  },
  {
    home_id: "home-022",
    status: "stale",
    zone: "South",
    capacity_kwh: 20,
    soc_kwh: 14,
    floor_kwh: 12,
    max_kw: 5,
    assigned_kw: 0,
    eligible: false,
    skip_reason: "stale",
    last_seen: "2026-07-08T18:11:00-05:00",
    last_command: {
      kw: 2,
      sent_at: "2026-07-08T18:10:01-05:00",
      ack: null,
    },
    charge_state: "HOLDING",
    power_kw: 0,
  },
  {
    home_id: "home-031",
    status: "dead",
    zone: "West",
    capacity_kwh: 10,
    soc_kwh: 8.2,
    floor_kwh: 6,
    max_kw: 3,
    assigned_kw: 0,
    eligible: false,
    skip_reason: "dead",
    last_seen: "2026-07-08T16:02:00-05:00",
    last_command: {
      kw: 1,
      sent_at: "2026-07-08T16:00:01-05:00",
      ack: "rejected",
    },
    charge_state: null,
    power_kw: null,
  },
  {
    home_id: "home-014",
    status: "unconfirmed",
    zone: "North",
    capacity_kwh: 20,
    soc_kwh: 11.2,
    floor_kwh: 12,
    max_kw: 5,
    assigned_kw: 0,
    eligible: false,
    skip_reason: "unconfirmed",
    last_seen: "2026-07-08T19:11:00-05:00",
    last_command: {
      kw: 0,
      sent_at: "2026-07-08T19:20:01-05:00",
      ack: "timeout",
    },
    charge_state: null,
    power_kw: null,
  },
]

function virtualHome(index: number): Home {
  const n = index + 1
  const zone = ZONES[index % ZONES.length]
  const status = STATUSES[index % STATUSES.length]
  return {
    home_id: `home-${String(n).padStart(5, "0")}`,
    status,
    zone,
    capacity_kwh: 20,
    soc_kwh: 10 + (index % 8),
    floor_kwh: 12,
    max_kw: 5,
    assigned_kw: status === "live" ? 2 : 0,
    eligible: status === "live",
    skip_reason: status === "live" ? null : status,
    last_seen: "2026-07-08T19:20:04-05:00",
    last_command: null,
    charge_state: status === "live" ? "DISCHARGING" : "HOLDING",
    power_kw: status === "live" ? 2 : 0,
  }
}

/** One page from a virtual 10k fleet. Does not allocate the full list. */
export function pageVirtualHomes(input: {
  limit: number
  offset: number
  total?: number
  zone?: HomeZone
  status?: StatusFilter
  q?: string
}): Home[] {
  const total = input.total ?? 10_000
  const rows: Home[] = []
  let matched = 0
  for (let index = 0; index < total && rows.length < input.limit; index++) {
    const home = virtualHome(index)
    if (input.zone !== undefined && home.zone !== input.zone) continue
    if (input.status !== undefined && input.status !== "all" && home.status !== input.status) {
      continue
    }
    if (input.q !== undefined && input.q.length > 0 && !home.home_id.includes(input.q)) {
      continue
    }
    if (matched < input.offset) {
      matched += 1
      continue
    }
    rows.push(home)
    matched += 1
  }
  return rows
}
