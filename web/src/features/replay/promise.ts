import type { FlowTick } from "../flow/types"

export type ReplayPromiseResult = Partial<FlowTick> & {
  unconfirmed_mw?: number
}

export type PromiseRow =
  | { key: "asked" | "sold_confirmed" | "sent_not_counted" | "not_sent" | "held_back"; label: string; mw: number }
  | { key: "breaches"; label: string; count: number }

function hasNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function raisedFloor(result: ReplayPromiseResult): boolean {
  if (hasNumber(result.reserve_pct) && result.reserve_pct > 30) return true
  return (result.reasons ?? []).some((reason) => ["storm_reserve", "storm_risk_high", "weather_alert", "signal_unavailable"].includes(reason))
}

export function promiseBreakdown(result: ReplayPromiseResult): PromiseRow[] {
  const rows: PromiseRow[] = []
  if (hasNumber(result.target_mw)) rows.push({ key: "asked", label: "Asked", mw: result.target_mw })
  if (hasNumber(result.delivered_mw)) rows.push({ key: "sold_confirmed", label: "Sold and confirmed", mw: result.delivered_mw })
  if (hasNumber(result.unconfirmed_mw)) rows.push({ key: "sent_not_counted", label: "Sent but not counted", mw: result.unconfirmed_mw })
  if (hasNumber(result.missed_mw)) rows.push({ key: "not_sent", label: "Not sent", mw: result.missed_mw })
  if (hasNumber(result.missed_mw) && raisedFloor(result)) {
    rows.push({ key: "held_back", label: "Held back for raised floor", mw: result.missed_mw })
  }
  if (hasNumber(result.breaches)) rows.push({ key: "breaches", label: "Backup breaches", count: result.breaches })
  return rows
}
