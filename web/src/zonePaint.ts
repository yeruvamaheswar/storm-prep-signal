import type { RiskLevel, TickView } from "./contracts"
import { stressReading } from "./stressReading"

/** Leaflet path options cannot read the CSS variables in DESIGN.md. */
const INK = "#1C1917"
const LINE = "#D6D1C8"
const RESERVED = "#B45309"
const MUTED = "#6B645B"

/** ERCOT load zones named by NP3-233-CD. Order matches the report fields. */
export const LOAD_ZONES = ["Houston", "North", "South", "West"] as const

export type LoadZone = (typeof LOAD_ZONES)[number]

export type ZoneFill = {
  zone: LoadZone
  mw: number | null
  share: number | null
  emphasized: boolean
}

export type ZonePaint = {
  muted: boolean
  zones: ZoneFill[]
}

const CATEGORIES = ["Resource", "IRR", "NewEquipResource"] as const

const ZONE_MW_FIELD: Record<LoadZone, "houston_mw" | "north_mw" | "south_mw" | "west_mw"> = {
  Houston: "houston_mw",
  North: "north_mw",
  South: "south_mw",
  West: "west_mw",
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function isLoadZone(value: string): value is LoadZone {
  return (LOAD_ZONES as readonly string[]).includes(value)
}

/** Sum the three NP3 category columns. Null unless every column is present. */
function postingFromTick(tick: TickView): Record<LoadZone, number> | null {
  const row = tick as TickView & Record<string, unknown>
  const totals = {} as Record<LoadZone, number>
  for (const zone of LOAD_ZONES) {
    let sum = 0
    for (const category of CATEGORIES) {
      const value = finite(row[`total${category}MWZone${zone}`])
      if (value === null) {
        return null
      }
      sum += value
    }
    totals[zone] = sum
  }
  return totals
}

/** Peak-hour MW from houston_mw, north_mw, south_mw, west_mw. Null unless every column is present. */
function namedZoneMw(tick: TickView): Record<LoadZone, number> | null {
  const totals = {} as Record<LoadZone, number>
  for (const zone of LOAD_ZONES) {
    const value = finite(tick[ZONE_MW_FIELD[zone]])
    if (value === null) {
      return null
    }
    totals[zone] = value
  }
  return totals
}

function largestZone(totals: Record<LoadZone, number>): LoadZone {
  let best: LoadZone = "Houston"
  for (const zone of LOAD_ZONES) {
    if (totals[zone] > totals[best]) {
      best = zone
    }
  }
  return best
}

export type ZonePathPaint = {
  fill: string
  fillOpacity: number
  stroke: string
  weight: number
}

/**
 * The chosen zone keeps the posting fill. Every other zone is a muted polygon.
 * With no choice, the driving zone is the one that stays filled.
 */
export function zoneHierarchyPaint(
  fill: ZoneFill,
  muted: boolean,
  risk: RiskLevel | null,
  selected: boolean,
): ZonePathPaint {
  if (!muted && selected) {
    return zonePathPaint({ ...fill, emphasized: true }, false, risk)
  }
  return {
    fill: MUTED,
    fillOpacity: muted ? 0.22 : 0.28,
    stroke: selected ? INK : LINE,
    weight: selected ? 2 : 1,
  }
}

/** Fill strength follows that zone's share of the posting. HIGH paints reserved; a missing report stays muted. */
export function zonePathPaint(fill: ZoneFill, muted: boolean, risk: RiskLevel | null): ZonePathPaint {
  if (muted || fill.mw === null || fill.share === null) {
    return { fill: MUTED, fillOpacity: 0.22, stroke: LINE, weight: 1 }
  }
  const share = fill.share
  const fillOpacity = fill.emphasized ? Math.min(0.92, 0.45 + share) : Math.min(0.7, 0.08 + share * 0.9)
  return {
    fill: risk === "HIGH" ? RESERVED : INK,
    fillOpacity,
    stroke: fill.emphasized ? INK : LINE,
    weight: fill.emphasized ? 2 : 1,
  }
}

/** Zone fills for the selected tick. Muted means the outage report cannot be drawn. */
export function zonePaint(tick: TickView): ZonePaint {
  const reading = stressReading(tick)
  const posted = postingFromTick(tick) ?? namedZoneMw(tick)
  const muted = posted === null || reading.outageMw === null
  const total = posted === null ? 0 : LOAD_ZONES.reduce((sum, zone) => sum + posted[zone], 0)
  const drivingField = (tick as TickView & Record<string, unknown>).driving_zone
  const named = typeof drivingField === "string" ? drivingField : reading.zone
  const driving =
    posted !== null && named !== null && isLoadZone(named)
      ? named
      : posted !== null
        ? largestZone(posted)
        : reading.zone

  return {
    muted,
    zones: LOAD_ZONES.map((zone) => {
      const mw = muted || posted === null ? null : posted[zone]
      const share = mw === null || total <= 0 ? null : mw / total
      const emphasized = !muted && tick.risk_level === "HIGH" && driving === zone
      return { zone, mw, share, emphasized }
    }),
  }
}
