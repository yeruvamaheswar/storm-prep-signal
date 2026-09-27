import type { FlowTick } from "../flow/types"
import { isFloorRaisingReason } from "./reasonCodes"

export type ReplayPromiseResult = Partial<FlowTick> & {
  unconfirmed_mw?: number
}

export type PromiseRow =
  | { key: "asked" | "sold_confirmed" | "sent_not_counted" | "not_sold"; label: string; mw: number }
  | { key: "breaches"; label: string; count: number }

function hasNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function floorRaised(result: ReplayPromiseResult): boolean {
  return (result.reasons ?? []).some(isFloorRaisingReason)
}

export function promiseBreakdown(result: ReplayPromiseResult): PromiseRow[] {
  const rows: PromiseRow[] = []
  if (hasNumber(result.target_mw)) rows.push({ key: "asked", label: "Asked", mw: result.target_mw })
  if (hasNumber(result.delivered_mw)) rows.push({ key: "sold_confirmed", label: "Sold and confirmed", mw: result.delivered_mw })
  if (hasNumber(result.unconfirmed_mw)) rows.push({ key: "sent_not_counted", label: "Sent, not counted", mw: result.unconfirmed_mw })
  // missed_mw already includes unconfirmed_mw (server/engine/orchestration.py: missed_mw = target_mw - credited_mw,
  // and credited_mw only counts confirmed energy). Subtract it back out so this single row never double-counts.
  if (hasNumber(result.missed_mw) && hasNumber(result.unconfirmed_mw)) {
    const notSold = Math.max(0, result.missed_mw - result.unconfirmed_mw)
    const label = floorRaised(result) ? "Kept for backup, floor raised" : "Not sent, no spare energy above floors"
    rows.push({ key: "not_sold", label, mw: notSold })
  }
  if (hasNumber(result.breaches)) rows.push({ key: "breaches", label: "Backup breaches", count: result.breaches })
  return rows
}
