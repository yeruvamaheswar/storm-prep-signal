import type { Mode, RiskLevel } from "./contracts"
import { ercotIntervalLabel } from "./runtimeMode"

/** Last N SCED / 15-minute intervals on the Live strip. */
export const INTERVAL_WINDOW = 12

/** Why an interval is marked. These come from the series, not tape copy. */
export type IntervalEvent = "risk-high" | "floor-raised" | "homes-offline" | "hold"

export type IntervalDraft = {
  ts: string
  label?: string
  targetMw: number
  deliveredMw: number
  reservedMw: number
  riskLevel: RiskLevel | null
  reservePct: number
  policyReason: string
  deadHomes: number
  mode: Mode
}

export type IntervalPoint = {
  ts: string
  label: string
  targetMw: number
  deliveredMw: number
  reservedMw: number
  events: IntervalEvent[]
}

export function intervalClockLabel(ts: string): string {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) {
    return ts
  }
  return ercotIntervalLabel(ms)
}

export function intervalEvents(current: IntervalDraft, previous: IntervalDraft | null): IntervalEvent[] {
  const events: IntervalEvent[] = []
  if (current.riskLevel === "HIGH" && previous?.riskLevel !== "HIGH") {
    events.push("risk-high")
  }
  const floorUp = previous !== null && current.reservePct > previous.reservePct
  const leftNormal = previous !== null && previous.policyReason === "normal" && current.policyReason !== "normal"
  if (floorUp || leftNormal) {
    events.push("floor-raised")
  }
  if (previous !== null && current.deadHomes > previous.deadHomes) {
    events.push("homes-offline")
  }
  if (current.mode === "HOLD" && previous?.mode !== "HOLD") {
    events.push("hold")
  }
  return events
}

export function toInterval(current: IntervalDraft, previous: IntervalDraft | null): IntervalPoint {
  return {
    ts: current.ts,
    label: current.label ?? intervalClockLabel(current.ts),
    targetMw: current.targetMw,
    deliveredMw: current.deliveredMw,
    reservedMw: current.reservedMw,
    events: intervalEvents(current, previous),
  }
}

export function intervalSeries(drafts: readonly IntervalDraft[]): IntervalPoint[] {
  return drafts.map((draft, index) => toInterval(draft, index === 0 ? null : (drafts[index - 1] ?? null)))
}

/** Newest intervals stay; older ones fall off the left. An empty feed stays empty. */
export function rollingIntervals(points: readonly IntervalPoint[], windowSize = INTERVAL_WINDOW): IntervalPoint[] {
  if (windowSize <= 0 || points.length === 0) {
    return []
  }
  return points.slice(-windowSize)
}

export function intervalPeak(points: readonly IntervalPoint[]): number {
  return points.reduce((max, point) => Math.max(max, point.targetMw, point.deliveredMw, point.reservedMw), 0)
}

export function eventNote(event: IntervalEvent): string {
  switch (event) {
    case "risk-high":
      return "risk HIGH"
    case "floor-raised":
      return "floor raised"
    case "homes-offline":
      return "homes offline"
    case "hold":
      return "hold"
    default: {
      const neverEvent: never = event
      return neverEvent
    }
  }
}

export function intervalSummary(points: readonly IntervalPoint[]): string {
  if (points.length === 0) {
    return "Waiting for intervals"
  }
  const parts = [`Target, delivered, and reserved across ${String(points.length)} intervals.`]
  for (const point of points) {
    for (const event of point.events) {
      parts.push(`${point.label} ${eventNote(event)}.`)
    }
  }
  return parts.join(" ")
}
