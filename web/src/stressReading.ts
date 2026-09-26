import type { RiskLevel, TickView } from "./contracts"

/** Numbers behind the Storm Prep row. Null means the tape did not carry that fact. */
export type StressReading = {
  outageMw: number | null
  thresholdMw: number | null
  marginMw: number | null
  zone: string | null
  zoneMw: number | null
  asOfLabel: string | null
  ageMin: number | null
  clockPinned: boolean
  quality: string
}

const PINNED: Pick<StressReading, "asOfLabel" | "ageMin" | "clockPinned" | "quality"> = {
  asOfLabel: "12:00 CT",
  ageMin: 0,
  clockPinned: true,
  quality: "unchecked",
}

const UNREAD: StressReading = {
  outageMw: null,
  thresholdMw: null,
  marginMw: null,
  zone: null,
  zoneMw: null,
  asOfLabel: null,
  ageMin: null,
  clockPinned: false,
  quality: "signal_unavailable",
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

type ZoneMwTotals = { Houston: number; North: number; South: number; West: number }

function zoneMwTotals(tick: TickView): ZoneMwTotals | null {
  const houston = finiteNumber(tick.houston_mw)
  const north = finiteNumber(tick.north_mw)
  const south = finiteNumber(tick.south_mw)
  const west = finiteNumber(tick.west_mw)
  if (houston === null || north === null || south === null || west === null) {
    return null
  }
  return { Houston: houston, North: north, South: south, West: west }
}

function largestZone(totals: ZoneMwTotals): keyof ZoneMwTotals {
  let best: keyof ZoneMwTotals = "Houston"
  for (const zone of ["Houston", "North", "South", "West"] as const) {
    if (totals[zone] > totals[best]) {
      best = zone
    }
  }
  return best
}

function triggerMw(tick: TickView): number | null {
  const row = tick as TickView & Record<string, unknown>
  return finiteNumber(row.trigger_mw) ?? finiteNumber(row.threshold_mw)
}

function readingFromZoneColumns(tick: TickView): StressReading | null {
  if (tick.policy_reason === "signal_unavailable" || tick.risk_level === null) {
    return null
  }
  const totals = zoneMwTotals(tick)
  if (totals === null) {
    return null
  }
  const outageMw = totals.Houston + totals.North + totals.South + totals.West
  const zone = largestZone(totals)
  const thresholdMw = triggerMw(tick)
  return {
    outageMw,
    thresholdMw,
    marginMw: thresholdMw === null ? null : outageMw - thresholdMw,
    zone,
    zoneMw: totals[zone],
    ...PINNED,
  }
}

function readingFromFields(tick: TickView): StressReading | null {
  const row = tick as TickView & Record<string, unknown>
  const named = text(row.stress_quality)
  if ((named === "timeout" || named === "stale") && finiteNumber(row.outage_mw) === null) {
    return { ...UNREAD, quality: named }
  }
  const outageMw = finiteNumber(row.outage_mw)
  const thresholdMw = triggerMw(tick)
  const zone = text(row.driving_zone)
  if (outageMw === null || zone === null) {
    return null
  }
  const quality = text(row.stress_quality) ?? "unchecked"
  return {
    outageMw,
    thresholdMw,
    marginMw: thresholdMw === null ? finiteNumber(row.margin_mw) : outageMw - thresholdMw,
    zone,
    zoneMw: finiteNumber(row.zone_mw),
    asOfLabel: text(row.stress_as_of),
    ageMin: finiteNumber(row.stress_age_min),
    clockPinned: row.clock_pinned === true,
    quality,
  }
}

function fallback(level: RiskLevel | null, policyReason: string): StressReading {
  if (policyReason === "signal_unavailable" || level === null) {
    return UNREAD
  }
  return { ...UNREAD, quality: "unchecked" }
}

/** Prefer outage fields on the tick, then houston_mw columns. Do not invent a MW trigger. */
export function stressReading(tick: TickView): StressReading {
  return readingFromFields(tick) ?? readingFromZoneColumns(tick) ?? fallback(tick.risk_level, tick.policy_reason)
}
