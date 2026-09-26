import type { TickView, ZoneAckCounts } from "../../contracts"
import { zoneAggregates } from "../../fleetAggregate"
import { formatMw } from "../../format"
import { fleetCells, type HomeState } from "./fleetCells"
import { ZONE_ORDER } from "./homeNodes"

/**
 * One tick per home for the worker ack rail. The tape has no per-home acks, so this is
 * a staged reading of the tick: a dead home never answers, every other home answers.
 */
export const ACK_STATES = ["pending", "acked", "unconfirmed", "dead"] as const

export type AckState = (typeof ACK_STATES)[number]

/** A worker that has not answered by this point is unconfirmed and gets no work. */
export const ACK_TIMEOUT_MS = 2000

/** How long an unconfirmed home is shown before the controller writes it off as dead. */
export const DEAD_AFTER_MS = 3500

/** Answers land between these two marks, well inside the timeout. */
const ACK_FIRST_MS = 150
const ACK_SPREAD_MS = 1050

export type AckTick = {
  index: number
  zone: string
  home: HomeState
}

export type AckZone = {
  zone: string
  ticks: AckTick[]
}

/** Same index-to-zone rule as homeNodes, so a tick and its map dot sit in the same zone. */
export function ackTicks(tick: TickView): AckTick[] {
  return fleetCells(tick).map((home, index) => ({
    index,
    zone: ZONE_ORDER[index % ZONE_ORDER.length],
    home,
  }))
}

export function ackZones(ticks: readonly AckTick[]): AckZone[] {
  return ZONE_ORDER.map((zone) => ({ zone, ticks: ticks.filter((tick) => tick.zone === zone) }))
}

/** Deterministic, so a replayed scene lands the same answers in the same order. */
export function ackAtMs(index: number): number {
  return ACK_FIRST_MS + ((index * 37) % 100) * (ACK_SPREAD_MS / 100)
}

export function ackState(tick: AckTick, elapsedMs: number): AckState {
  if (tick.home === "dead") {
    if (elapsedMs >= DEAD_AFTER_MS) return "dead"
    if (elapsedMs >= ACK_TIMEOUT_MS) return "unconfirmed"
    return "pending"
  }
  return elapsedMs >= ackAtMs(tick.index) ? "acked" : "pending"
}

/**
 * What the rail paints. The timer still calls a stale home "acked" so it is not written off
 * as dead. The mark says it got no work, same as a reserved home and a fail-safe tick.
 */
export const ACK_MARKS = ["pending", "acked", "held", "silent", "unconfirmed", "dead", "failsafe"] as const

export type AckMark = (typeof ACK_MARKS)[number]

/** A missing storm reading stops discharge. Those homes are fail-safe, not a green ack. */
export function tickFailSafe(tick: TickView): boolean {
  return tick.risk_level === null || tick.policy_reason === "signal_unavailable"
}

export function ackMark(item: AckTick, elapsedMs: number, failSafe: boolean): AckMark {
  const stage = ackState(item, elapsedMs)
  if (stage === "pending") return "pending"
  if (stage === "unconfirmed") return "silent"
  if (stage === "dead") return "dead"
  switch (item.home) {
    case "reserved":
      return "held"
    case "stale":
    case "unconfirmed":
      return "silent"
    case "dead":
      return "dead"
    case "discharging":
    case "ok":
      return failSafe ? "failsafe" : "acked"
    default: {
      const unexpected: never = item.home
      return unexpected
    }
  }
}

export type AckMarkCounts = Record<AckMark, number>

export function ackMarkCounts(ticks: readonly AckTick[], elapsedMs: number, failSafe: boolean): AckMarkCounts {
  const counts: AckMarkCounts = { pending: 0, acked: 0, held: 0, silent: 0, unconfirmed: 0, dead: 0, failsafe: 0 }
  for (const item of ticks) {
    counts[ackMark(item, elapsedMs, failSafe)] += 1
  }
  return counts
}

/** Homes in this zone that answered and are discharging or idle. Held, silent, dead, and fail-safe stay out. */
export function zoneAcked(ticks: readonly AckTick[], elapsedMs: number, failSafe: boolean): number {
  return ticks.reduce((sum, item) => sum + (ackMark(item, elapsedMs, failSafe) === "acked" ? 1 : 0), 0)
}

/**
 * Operator line for one tick. Silent is stale, a nack (unconfirmed), and dead.
 * Held and fail-safe are named only when this tick has them. "still" reads true once
 * someone is quiet or the signal failed.
 */
export function ackSummary(marks: AckMarkCounts, deliveredMw: number): string {
  const silent = marks.silent + marks.dead
  const quiet = silent + marks.unconfirmed + marks.failsafe > 0
  const parts = marks.pending > 0 ? [`${marks.pending} pending`] : []
  parts.push(`${silent} silent`, `${marks.acked} acked`)
  if (marks.held > 0) {
    parts.push(`${marks.held} held`)
  }
  if (marks.unconfirmed > 0) {
    parts.push(`${marks.unconfirmed} unconfirmed`)
  }
  if (marks.failsafe > 0) {
    parts.push(`${marks.failsafe} fail-safe`)
  }
  parts.push(`call ${quiet ? "still " : ""}${formatMw(deliveredMw)} MW`)
  return parts.join(" · ")
}

export type AckCounts = Record<AckState, number>

export function ackCounts(ticks: readonly AckTick[], elapsedMs: number): AckCounts {
  const counts: AckCounts = { pending: 0, acked: 0, unconfirmed: 0, dead: 0 }
  for (const tick of ticks) {
    counts[ackState(tick, elapsedMs)] += 1
  }
  return counts
}

const ACK_TOTAL_KEYS = ["acked", "held", "silent", "dead", "unconfirmed"] as const

export function emptyZoneAcks(): ZoneAckCounts {
  return { acked: 0, held: 0, silent: 0, dead: 0, unconfirmed: 0 }
}

function isZoneAckCounts(value: unknown): value is ZoneAckCounts {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return ACK_TOTAL_KEYS.every((key) => typeof row[key] === "number")
}

/** Snapshot totals when the engine wrote them. Missing or partial rows are empty, not invented. */
export function readZoneAcks(tick: TickView): Record<string, ZoneAckCounts> | null {
  const raw = tick.zone_acks
  if (raw === undefined) return null
  const next: Record<string, ZoneAckCounts> = {}
  for (const [zone, row] of Object.entries(raw)) {
    if (isZoneAckCounts(row)) next[zone] = row
  }
  return Object.keys(next).length > 0 ? next : null
}

export type ZoneAckTotals = ZoneAckCounts & {
  zone: string
  failsafe: number
  pending: number
  homes: number
}

function paintZone(zone: string, counts: ZoneAckCounts, failSafe: boolean): ZoneAckTotals {
  const acked = failSafe ? 0 : counts.acked
  const failsafe = failSafe ? counts.acked : 0
  const homes = counts.acked + counts.held + counts.silent + counts.dead + counts.unconfirmed
  return { zone, ...counts, acked, failsafe, pending: 0, homes }
}

/**
 * One stacked bar per zone. Prefer engine zone_acks. A tape without that field
 * still paints from zoneAggregates so Demo does not grow 100 spans.
 */
export function zoneAckTotals(tick: TickView): ZoneAckTotals[] {
  const failSafe = tickFailSafe(tick)
  const written = readZoneAcks(tick)
  if (written !== null) {
    return ZONE_ORDER.map((zone) => paintZone(zone, written[zone] ?? emptyZoneAcks(), failSafe))
  }
  return zoneAggregates(tick).map((row) =>
    paintZone(
      row.zone,
      {
        acked: row.discharging + row.ok,
        held: row.reserved,
        silent: row.stale,
        dead: row.dead,
        unconfirmed: row.unconfirmed,
      },
      failSafe,
    ),
  )
}

export function totalsToMarks(rows: readonly ZoneAckTotals[]): AckMarkCounts {
  const marks: AckMarkCounts = { pending: 0, acked: 0, held: 0, silent: 0, unconfirmed: 0, dead: 0, failsafe: 0 }
  for (const row of rows) {
    marks.acked += row.acked
    marks.held += row.held
    marks.silent += row.silent
    marks.unconfirmed += row.unconfirmed
    marks.dead += row.dead
    marks.failsafe += row.failsafe
    marks.pending += row.pending
  }
  return marks
}

export const ACK_BAR_MARKS = ["acked", "held", "silent", "unconfirmed", "dead", "failsafe"] as const

export function barSegments(row: ZoneAckTotals): { mark: (typeof ACK_BAR_MARKS)[number]; count: number }[] {
  return ACK_BAR_MARKS.flatMap((mark) => {
    const count = row[mark]
    return count > 0 ? [{ mark, count }] : []
  })
}
