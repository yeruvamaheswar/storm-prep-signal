import type { TickView } from "../../contracts"
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

export type AckCounts = Record<AckState, number>

export function ackCounts(ticks: readonly AckTick[], elapsedMs: number): AckCounts {
  const counts: AckCounts = { pending: 0, acked: 0, unconfirmed: 0, dead: 0 }
  for (const tick of ticks) {
    counts[ackState(tick, elapsedMs)] += 1
  }
  return counts
}
