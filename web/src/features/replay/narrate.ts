import type { FlowHome, OrderTimelineEntry } from "../flow/types"
import { homeOrderState, splitOrders } from "./orderState"
import { fmtClock } from "./tickClock"

export type FeedLine = { t: string; x: string; c: string }
export type FeedTickFacts = { breaches?: number }

type OrderUnit = {
  id: string
  timeline: OrderTimelineEntry[]
  kw: number
}

const COLOR = {
  out: "#1FA9B5",
  gave: "#35C3CE",
  lost: "#C8412F",
  ok: "#2F8A55",
  warn: "#C98A1B",
  muted: "#8A928C",
}

function orderUnits(orders: Record<string, OrderTimelineEntry[]>): OrderUnit[] {
  const units: OrderUnit[] = []
  for (const [id, timeline] of Object.entries(orders)) {
    const split = splitOrders(timeline)
    for (const entries of [split.own, split.r]) {
      if (!entries.length) continue
      const sent = entries.find((entry) => entry[1] === "sent")
      const exec = entries.find((entry) => entry[1] === "exec")
      const conf = entries.find((entry) => entry[1] === "conf")
      const rawKw = sent?.[2] ?? exec?.[2] ?? conf?.[2]
      units.push({ id, timeline: entries, kw: typeof rawKw === "number" ? Math.abs(rawKw) : 0 })
    }
  }
  return units
}

function kwFor(id: string, unitKw: number, homesById: Record<string, Pick<FlowHome, "kw"> | undefined>): number {
  return unitKw || Math.abs(homesById[id]?.kw ?? 0)
}

function sumKw(units: OrderUnit[], homesById: Record<string, Pick<FlowHome, "kw"> | undefined>): number {
  return units.reduce((sum, unit) => sum + kwFor(unit.id, unit.kw, homesById), 0)
}

function add(line: FeedLine[], at: number, x: string, c: string): void {
  line.push({ t: fmtClock(at), x, c })
}

export function feedLines(
  orders: Record<string, OrderTimelineEntry[]> = {},
  tSeconds: number,
  homesById: Record<string, Pick<FlowHome, "kw"> | undefined> = {},
  tickFacts: FeedTickFacts = {},
): FeedLine[] {
  const units = orderUnits(orders)
  const lines: FeedLine[] = []
  if (!units.length) return lines

  add(lines, 0, `Orders sent to ${units.length} homes for ${sumKw(units, homesById).toFixed(1)} kW.`, COLOR.out)

  const initialDrops = units.filter((unit) => unit.timeline.some(([at, kind]) => at === 0 && kind === "drop")).length
  if (initialDrops) add(lines, 0, `${initialDrops} orders were lost on the way.`, COLOR.lost)

  const retryCount = units.filter((unit) => unit.timeline.some(([at, kind]) => at === 60 && kind === "retry")).length
  const hasReassignFailure = units.some((unit) => unit.timeline.some(([, kind]) => kind === "reassign_failed"))
  if (retryCount) {
    const suffix = hasReassignFailure ? " No spare home could take an order over." : ""
    add(lines, 60, `${retryCount} homes had not answered. Each got one retry.${suffix}`, COLOR.warn)
  }

  for (const unit of units) {
    const kw = kwFor(unit.id, unit.kw, homesById)
    for (const [at, kind] of unit.timeline) {
      if (kind === "exec") add(lines, at, `${unit.id} gave ${kw.toFixed(2)} kW.`, COLOR.gave)
      if (kind === "conf") add(lines, at, `${unit.id} confirmed. Counted.`, COLOR.ok)
      if (kind === "rdrop") add(lines, at, `${unit.id}'s report was lost on the way back.`, COLOR.lost)
      if (kind === "dup") add(lines, at, `${unit.id}: a duplicate copy was ignored, so it did not run twice.`, COLOR.muted)
      if (kind === "drop" && at > 0) add(lines, at, `${unit.id}'s retry was lost too.`, COLOR.lost)
    }
  }

  if (tSeconds >= 120 && typeof tickFacts.breaches === "number") {
    const notCounted = units.filter((unit) => homeOrderState(unit.timeline, 120).s !== "ok")
    add(
      lines,
      120,
      `Books closed. ${notCounted.length} homes not counted, ${sumKw(notCounted, homesById).toFixed(1)} kW. Backup breaches: ${tickFacts.breaches}.`,
      COLOR.muted,
    )
  }

  return lines.filter((line) => clockSeconds(line.t) <= tSeconds).sort((a, b) => clockSeconds(b.t) - clockSeconds(a.t))
}

function clockSeconds(clock: string): number {
  const [minutes, seconds] = clock.split(":").map(Number)
  return minutes * 60 + seconds
}
