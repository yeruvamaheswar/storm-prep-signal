import { chartPoint } from "../../chartPlot"
import type { TickView } from "../../contracts"

export { chartPoint, valuesPolyline } from "../../chartPlot"

/** Why a tape column is marked on the sparkline. */
export type TapeEvent = "risk-high" | "home-died" | "missed-on-purpose"

export type TapeColumn = {
  index: number
  tick: number
  target: number
  delivered: number
  events: TapeEvent[]
}

export function padTick(tick: number): string {
  return String(tick).padStart(2, "0")
}

export function tapeColumns(ticks: TickView[]): TapeColumn[] {
  return ticks.map((tick, index) => {
    const previous = index === 0 ? null : ticks[index - 1]
    const events: TapeEvent[] = []
    if (tick.risk_level === "HIGH" && previous?.risk_level !== "HIGH") {
      events.push("risk-high")
    }
    if (previous !== null && tick.dead_homes > previous.dead_homes) {
      events.push("home-died")
    }
    if (tick.brief.toLowerCase().includes("missed on purpose")) {
      events.push("missed-on-purpose")
    }
    return {
      index,
      tick: tick.tick,
      target: tick.target_mw,
      delivered: tick.delivered_mw,
      events,
    }
  })
}

export function seriesMax(columns: TapeColumn[]): number {
  return columns.reduce((max, column) => Math.max(max, column.target, column.delivered), 0)
}

export function polyline(columns: TapeColumn[], key: "target" | "delivered", max: number): string {
  return columns
    .map((column) => {
      const point = chartPoint(column.index, columns.length, column[key], max)
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`
    })
    .join(" ")
}

export function tickButtonLabel(column: TapeColumn): string {
  const notes: string[] = []
  for (const event of column.events) {
    switch (event) {
      case "risk-high":
        notes.push("risk flipped HIGH")
        break
      case "home-died":
        notes.push("homes died")
        break
      case "missed-on-purpose":
        notes.push("missed on purpose")
        break
      default: {
        const neverEvent: never = event
        notes.push(neverEvent)
      }
    }
  }
  const base = `Tick ${padTick(column.tick)}`
  return notes.length === 0 ? base : `${base}, ${notes.join(", ")}`
}

export function tapeSummary(columns: TapeColumn[]): string {
  const parts = [`Target and delivered across ${String(columns.length)} ticks.`]
  for (const column of columns) {
    const label = padTick(column.tick)
    const purpose = column.events.includes("missed-on-purpose")
    const risk = column.events.includes("risk-high")
    const died = column.events.includes("home-died")
    if (purpose && risk) {
      parts.push(`Tick ${label} missed on purpose when risk flipped HIGH.`)
    } else if (purpose) {
      parts.push(`Tick ${label} missed on purpose.`)
    } else if (risk) {
      parts.push(`Tick ${label} risk flipped HIGH.`)
    }
    if (died) {
      parts.push(`Tick ${label} homes died.`)
    }
  }
  return parts.join(" ")
}
