import type { TickView } from "../../contracts"
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
export const ACK_MARKS = ["pending", "acked", "held", "silent", "dead", "failsafe"] as const

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
  const counts: AckMarkCounts = { pending: 0, acked: 0, held: 0, silent: 0, dead: 0, failsafe: 0 }
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
  const quiet = silent + marks.failsafe > 0
  const parts = marks.pending > 0 ? [`${marks.pending} pending`] : []
  parts.push(`${silent} silent`, `${marks.acked} acked`)
  if (marks.held > 0) {
    parts.push(`${marks.held} held`)
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
