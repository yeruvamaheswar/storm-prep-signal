import type { FlowTick } from "../flow/types"
import { isFloorRaisingReason, isOperatorHold } from "./reasonCodes"

export type ReplayPromiseResult = Partial<FlowTick> & {
  unconfirmed_mw?: number
}

export type PromiseRow =
  | { key: "asked" | "sold_confirmed" | "sent_not_counted" | "not_sold" | "charged"; label: string; mw: number }
  | { key: "breaches"; label: string; count: number }

function hasNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function floorRaised(result: ReplayPromiseResult): boolean {
  return (result.reasons ?? []).some(isFloorRaisingReason)
}

/** The smallest MW that shows as more than 0.000 MW (mw() prints 3 decimals). */
export const SHOWN_MW = 0.0005

function notSoldLabel(result: ReplayPromiseResult, notSold: number): string {
  // A call served to within float residue left nothing unsold on screen: name no cause for a 0.000 MW row.
  if (notSold < SHOWN_MW) return "Not sold"
  if (isOperatorHold(result)) return "Not sent, operator hold"
  return floorRaised(result) ? "Kept for backup, floor raised" : "Not sent, no spare energy above floors"
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
    rows.push({ key: "not_sold", label: notSoldLabel(result, notSold), mw: notSold })
  }
  // Energy bought from the grid this tick. Not a sale: never part of asked, sold or not sold.
  if (hasNumber(result.charging_mw)) rows.push({ key: "charged", label: "Charged from the grid", mw: result.charging_mw })
  if (hasNumber(result.breaches)) rows.push({ key: "breaches", label: "Backup breaches", count: result.breaches })
  return rows
}
