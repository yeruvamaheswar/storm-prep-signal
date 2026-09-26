import { HOMES_PAGE_LIMIT, HOMES_PAGE_MAX, type HomesQuery } from "../../api/client"
import type { StatusFilter, ZoneFilter } from "./types"

export const FLEET_PAGE_LIMIT = HOMES_PAGE_LIMIT

const ZONES: ZoneFilter[] = ["South", "North", "West", "Houston"]

export function selectedZoneFromSearch(search: string): ZoneFilter | null {
  const raw = search.startsWith("?") ? search.slice(1) : search
  const zone = new URLSearchParams(raw).get("zone")
  if (zone === null) return null
  return ZONES.find((name) => name === zone) ?? null
}

export function fleetListHref(zone: string | null | undefined): string {
  if (zone === undefined || zone === null || zone === "all") return "/fleet"
  return `/fleet?zone=${encodeURIComponent(zone)}`
}

export function homesQuery(input: {
  zone: ZoneFilter
  status: StatusFilter
  q: string
  offset: number
  limit?: number
}): HomesQuery {
  const limit = Math.min(HOMES_PAGE_MAX, Math.max(1, input.limit ?? FLEET_PAGE_LIMIT))
  const q = input.q.trim()
  return {
    zone: input.zone === "all" ? undefined : input.zone,
    status: input.status === "all" ? undefined : input.status,
    q: q.length === 0 ? undefined : q,
    limit,
    offset: Math.max(0, input.offset),
  }
}
