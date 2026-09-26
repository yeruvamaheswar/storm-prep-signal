import { useEffect, useState } from "react"
import type { FleetRollups, ZoneRollup } from "../contracts"
import { apiBaseUrl } from "./health"

type FetchFn = typeof fetch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readZoneRollup(value: unknown): ZoneRollup | null {
  if (!isRecord(value)) {
    return null
  }
  const live = finiteNumber(value.live)
  const reserved = finiteNumber(value.reserved)
  const discharging = finiteNumber(value.discharging)
  const stale = finiteNumber(value.stale)
  const dead = finiteNumber(value.dead)
  const silent = finiteNumber(value.silent)
  const reservedMw = finiteNumber(value.reserved_mw)
  const dischargingMw = finiteNumber(value.discharging_mw)
  if (
    live === null ||
    reserved === null ||
    discharging === null ||
    stale === null ||
    dead === null ||
    silent === null ||
    reservedMw === null ||
    dischargingMw === null
  ) {
    return null
  }
  return {
    live,
    reserved,
    discharging,
    stale,
    dead,
    silent,
    reserved_mw: reservedMw,
    discharging_mw: dischargingMw,
  }
}

function readClusters(value: unknown): FleetRollups["clusters"] {
  if (!Array.isArray(value)) {
    return undefined
  }
  const clusters: NonNullable<FleetRollups["clusters"]> = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const id = item.id
    const zone = item.zone
    const lng = finiteNumber(item.lng)
    const lat = finiteNumber(item.lat)
    if (typeof id === "string" && typeof zone === "string" && lng !== null && lat !== null) {
      clusters.push({ id, zone, lng, lat })
    }
  }
  return clusters
}

/** Missing or malformed body is null so the wall keeps today's index % 4 fallback. */
export function parseFleetRollups(value: unknown): FleetRollups | null {
  if (!isRecord(value)) {
    return null
  }
  const n = finiteNumber(value.n)
  if (n === null || !isRecord(value.zones)) {
    return null
  }
  const zones: Record<string, ZoneRollup> = {}
  for (const [name, row] of Object.entries(value.zones)) {
    const parsed = readZoneRollup(row)
    if (parsed === null) {
      return null
    }
    zones[name] = parsed
  }
  const clusters = readClusters(value.clusters)
  return clusters === undefined ? { n, zones } : { n, zones, clusters }
}

export async function fetchFleetRollups(
  fetchFn: FetchFn = fetch,
  baseUrl = apiBaseUrl(),
): Promise<FleetRollups | null> {
  try {
    const response = await fetchFn(`${baseUrl}/v1/fleet/rollups`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
    if (!response.ok) {
      return null
    }
    return parseFleetRollups(await response.json())
  } catch {
    return null
  }
}

/** One GET. A failed or missing body stays null so callers keep the tape fallback. */
export function useFleetRollups(): FleetRollups | null {
  const [rollups, setRollups] = useState<FleetRollups | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchFleetRollups().then((next) => {
      if (!cancelled) {
        setRollups(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  return rollups
}
