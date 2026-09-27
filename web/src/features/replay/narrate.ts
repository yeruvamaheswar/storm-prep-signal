import type { FlowHome, OrderTimelineEntry } from "../flow/types"
import { homeName, type NameableHome } from "./homeName"
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

/** The planned (sent) magnitude, used for aggregate sums. Never falls back to a home's current kw,
 * and never invents 0: an order with no known kW stays undefined. */
function plannedKw(unit: OrderUnit): number | undefined {
  const value = unit.sentKw ?? unit.execKw ?? unit.confKw
  return value === undefined ? undefined : Math.abs(value)
}

/** Sum of the known planned kW across units. Undefined when no unit has a known kW, so the caller
 * leaves the kW out of the sentence instead of printing an invented "0.0 kW". */
function knownKwSum(units: OrderUnit[]): number | undefined {
  let sum: number | undefined
  for (const unit of units) {
    const kw = plannedKw(unit)
    if (kw !== undefined) sum = (sum ?? 0) + kw
  }
  return sum
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
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
  homesById: Record<string, (Pick<FlowHome, "kw"> & NameableHome) | undefined> = {},
  tickFacts: FeedTickFacts = {},
): FeedLine[] {
  // kW always comes from the order's own timeline; the home row only gives the name (Task 17).
  const nameOf = (id: string) => {
    const home = homesById[id]
    return home ? homeName({ ...home, id }) : id
  }
  const units = orderUnits(orders)
  const lines: FeedLine[] = []
  if (!units.length) return lines

  const initialSent = units.filter((unit) => unit.timeline.some(([at, kind]) => at === 0 && kind === "sent"))
  if (initialSent.length) {
    const dischargeSent = initialSent.filter((unit) => !unit.isCharge)
    const chargeSent = initialSent.filter((unit) => unit.isCharge)
    const dischargeHomes = new Set(dischargeSent.map((unit) => unit.id)).size
    const chargeHomes = new Set(chargeSent.map((unit) => unit.id)).size
    const dischargeKw = knownKwSum(dischargeSent)
    const chargeKw = knownKwSum(chargeSent)
    const forKw = (kw: number | undefined) => (kw === undefined ? "" : ` for ${kw.toFixed(1)} kW`)
    let sentence: string
    if (!chargeHomes) {
      sentence = `Orders sent to ${plural(dischargeHomes, "home", "homes")}${forKw(dischargeKw)}.`
    } else if (!dischargeHomes) {
      sentence = `Charge orders sent to ${plural(chargeHomes, "home", "homes")}${forKw(chargeKw)}.`
    } else {
      const chargeClause = chargeKw === undefined ? " to charge" : ` to charge ${chargeKw.toFixed(1)} kW`
      sentence = `Orders sent to ${plural(dischargeHomes, "home", "homes")}${forKw(dischargeKw)} and ${plural(chargeHomes, "home", "homes")}${chargeClause}.`
    }
    add(lines, 0, sentence, FEED_COLORS.out)
  }

  const initialDrops = units.filter((unit) => unit.timeline.some(([at, kind]) => at < 1 && kind === "drop")).length
  if (initialDrops) add(lines, 0, `${plural(initialDrops, "order was", "orders were")} lost on the way.`, FEED_COLORS.lost)

  const retryCount = units.filter((unit) => unit.timeline.some(([at, kind]) => at >= 60 && at < 61 && kind === "retry")).length
  const hasReassignFailure = units.some((unit) => unit.timeline.some(([, kind]) => kind === "reassign_failed"))
  if (retryCount) {
    const suffix = hasReassignFailure ? " No spare home could take an order over." : ""
    add(lines, 60, `${plural(retryCount, "home", "homes")} had not answered. Each got one retry.${suffix}`, FEED_COLORS.charging)
  }

  for (const unit of units) {
    const gave = gaveKw(unit)
    const name = nameOf(unit.id)
    for (const [at, kind] of unit.timeline) {
      if (kind === "exec") {
        if (unit.isCharge) {
          add(lines, at, gave === undefined ? `${name} charged.` : `${name} charged ${gave.toFixed(2)} kW.`, FEED_COLORS.charging)
        } else {
          add(lines, at, gave === undefined ? `${name} gave energy.` : `${name} gave ${gave.toFixed(2)} kW.`, FEED_COLORS.gave)
        }
      }
      if (kind === "conf") {
        add(lines, at, unit.isCharge ? `${name} charge confirmed.` : `${name} confirmed. Counted.`, FEED_COLORS.ok)
      }
      if (kind === "rdrop") add(lines, at, `${name}'s report was lost on the way back.`, FEED_COLORS.lost)
      if (kind === "dup") add(lines, at, `${name}: a duplicate copy was ignored, so it did not run twice.`, FEED_COLORS.muted)
      if (kind === "drop" && at > 0) add(lines, at, `${name}'s retry was lost too.`, FEED_COLORS.lost)
    }
  }

  if (tSeconds >= 120 && typeof tickFacts.breaches === "number") {
    const notCounted = units.filter((unit) => homeOrderState(unit.timeline, 120).s !== "ok")
    const notCountedKw = knownKwSum(notCounted)
    const kwPart = notCountedKw === undefined ? "" : `, ${notCountedKw.toFixed(1)} kW`
    add(
      lines,
      120,
      `Books closed. ${plural(notCounted.length, "home", "homes")} not counted${kwPart}. Backup breaches: ${tickFacts.breaches}.`,
      FEED_COLORS.muted,
    )
  }

  return lines.filter((line) => line.at <= tSeconds).sort((a, b) => b.at - a.at)
}
