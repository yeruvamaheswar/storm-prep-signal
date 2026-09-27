import type { OrderKind, OrderTimelineEntry } from "../flow/types"

export type ReplayKeyMoments = {
  firstDrop?: number
  retry?: number
  reassign?: number
  close: number
  mismatch?: number
  floorChange?: number
}

function firstTime(orders: Record<string, OrderTimelineEntry[]>, kinds: OrderKind[]): number | undefined {
  let first: number | undefined
  for (const timeline of Object.values(orders)) {
    for (const [at, kind] of timeline) {
      if (!kinds.includes(kind)) continue
      first = first === undefined ? at : Math.min(first, at)
    }
  }
  return first
}

export function keyMoments(orders: Record<string, OrderTimelineEntry[]> = {}, floorChange?: number): ReplayKeyMoments {
  const moments: ReplayKeyMoments = {
    firstDrop: firstTime(orders, ["drop"]),
    retry: firstTime(orders, ["retry"]),
    reassign: firstTime(orders, ["reassigned", "reassign_failed"]),
    close: 120,
    mismatch: firstTime(orders, ["mismatch"]),
  }
  if (typeof floorChange === "number" && Number.isFinite(floorChange)) moments.floorChange = floorChange
  return Object.fromEntries(Object.entries(moments).filter(([, value]) => value !== undefined)) as ReplayKeyMoments
}
