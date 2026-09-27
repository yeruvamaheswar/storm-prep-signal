import type { FlowHome, OrderTimelineEntry } from "../flow/types"
import { FEED_COLORS, homeOrderState, splitOrders } from "./orderState"
import { fmtClock } from "./tickClock"

export type FeedLine = { t: string; at: number; x: string; c: string }
export type FeedTickFacts = { breaches?: number }

type OrderUnit = {
  id: string
  timeline: OrderTimelineEntry[]
  sentKw?: number
  execKw?: number
  confKw?: number
  isCharge: boolean
}

function numericExtra(entry: OrderTimelineEntry | undefined): number | undefined {
  return entry && typeof entry[2] === "number" ? entry[2] : undefined
}

function orderUnits(orders: Record<string, OrderTimelineEntry[]>): OrderUnit[] {
  const units: OrderUnit[] = []
  for (const [id, timeline] of Object.entries(orders)) {
    const split = splitOrders(timeline)
    for (const entries of [split.own, split.r]) {
      if (!entries.length) continue
      const sentKw = numericExtra(entries.find((entry) => entry[1] === "sent"))
      const execKw = numericExtra(entries.find((entry) => entry[1] === "exec"))
      const confKw = numericExtra(entries.find((entry) => entry[1] === "conf"))
      const isCharge = (sentKw ?? execKw ?? confKw ?? 0) < 0
      units.push({ id, timeline: entries, sentKw, execKw, confKw, isCharge })
    }
  }
  return units
}

/** The planned (sent) magnitude, used for aggregate sums. Never falls back to a home's current kw:
 * an order with no planned kW contributes 0 kW rather than inventing one. */
function plannedKw(unit: OrderUnit): number {
  const value = unit.sentKw ?? unit.execKw ?? unit.confKw
  return value === undefined ? 0 : Math.abs(value)
}

/** The kW the "gave"/"charged" line reports: the exec extra, falling back to the planned (sent) kW
 * only when exec has none. Undefined means the sentence leaves the kW out entirely. */
function gaveKw(unit: OrderUnit): number | undefined {
  const value = unit.execKw ?? unit.sentKw
  return value === undefined ? undefined : Math.abs(value)
}

function add(lines: FeedLine[], at: number, x: string, c: string): void {
  lines.push({ t: fmtClock(at), at, x, c })
}

export function feedLines(
  orders: Record<string, OrderTimelineEntry[]> = {},
  tSeconds: number,
  homesById: Record<string, Pick<FlowHome, "kw"> | undefined> = {},
  tickFacts: FeedTickFacts = {},
): FeedLine[] {
  void homesById // kept for a stable call signature; kw always comes from the order's own timeline now.
  const units = orderUnits(orders)
  const lines: FeedLine[] = []
  if (!units.length) return lines

  const initialSent = units.filter((unit) => unit.timeline.some(([at, kind]) => at === 0 && kind === "sent"))
  if (initialSent.length) {
    const dischargeSent = initialSent.filter((unit) => !unit.isCharge)
    const chargeSent = initialSent.filter((unit) => unit.isCharge)
    const dischargeHomes = new Set(dischargeSent.map((unit) => unit.id)).size
    const dischargeKw = dischargeSent.reduce((sum, unit) => sum + plannedKw(unit), 0)
    let sentence = `Orders sent to ${dischargeHomes} homes for ${dischargeKw.toFixed(1)} kW.`
    if (chargeSent.length) {
      const chargeHomes = new Set(chargeSent.map((unit) => unit.id)).size
      const chargeKw = chargeSent.reduce((sum, unit) => sum + plannedKw(unit), 0)
      sentence = `Orders sent to ${dischargeHomes} homes for ${dischargeKw.toFixed(1)} kW and ${chargeHomes} homes to charge ${chargeKw.toFixed(1)} kW.`
    }
    add(lines, 0, sentence, FEED_COLORS.out)
  }

  const initialDrops = units.filter((unit) => unit.timeline.some(([at, kind]) => at < 1 && kind === "drop")).length
  if (initialDrops) add(lines, 0, `${initialDrops} orders were lost on the way.`, FEED_COLORS.lost)

  const retryCount = units.filter((unit) => unit.timeline.some(([at, kind]) => at >= 60 && at < 61 && kind === "retry")).length
  const hasReassignFailure = units.some((unit) => unit.timeline.some(([, kind]) => kind === "reassign_failed"))
  if (retryCount) {
    const suffix = hasReassignFailure ? " No spare home could take an order over." : ""
    add(lines, 60, `${retryCount} homes had not answered. Each got one retry.${suffix}`, FEED_COLORS.charging)
  }

  for (const unit of units) {
    const gave = gaveKw(unit)
    for (const [at, kind] of unit.timeline) {
      if (kind === "exec") {
        if (unit.isCharge) {
          add(lines, at, gave === undefined ? `${unit.id} charged.` : `${unit.id} charged ${gave.toFixed(2)} kW.`, FEED_COLORS.charging)
        } else {
          add(lines, at, gave === undefined ? `${unit.id} gave energy.` : `${unit.id} gave ${gave.toFixed(2)} kW.`, FEED_COLORS.gave)
        }
      }
      if (kind === "conf") {
        add(lines, at, unit.isCharge ? `${unit.id} charge confirmed.` : `${unit.id} confirmed. Counted.`, FEED_COLORS.ok)
      }
      if (kind === "rdrop") add(lines, at, `${unit.id}'s report was lost on the way back.`, FEED_COLORS.lost)
      if (kind === "dup") add(lines, at, `${unit.id}: a duplicate copy was ignored, so it did not run twice.`, FEED_COLORS.muted)
      if (kind === "drop" && at > 0) add(lines, at, `${unit.id}'s retry was lost too.`, FEED_COLORS.lost)
    }
  }

  if (tSeconds >= 120 && typeof tickFacts.breaches === "number") {
    const notCounted = units.filter((unit) => homeOrderState(unit.timeline, 120).s !== "ok")
    const notCountedKw = notCounted.reduce((sum, unit) => sum + plannedKw(unit), 0)
    add(
      lines,
      120,
      `Books closed. ${notCounted.length} homes not counted, ${notCountedKw.toFixed(1)} kW. Backup breaches: ${tickFacts.breaches}.`,
      FEED_COLORS.muted,
    )
  }

  return lines.filter((line) => line.at <= tSeconds).sort((a, b) => b.at - a.at)
}
