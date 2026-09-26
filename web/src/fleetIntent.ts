import type { TickView } from "./contracts"
import { formatMw } from "./format"
import { UNTRUSTED_REPORT, untrustedReport, type OutageLine } from "./wallLines"

/** What the fleet is doing on this tick. Charging is not a dispatch. */
export type FleetAction = "discharge" | "hold"

export type FleetIntent = {
  action: FleetAction
  line: string
}

/**
 * One reading of the tick the engine already wrote.
 * The wall does not allocate, set the floor, or pick a price.
 * An untrusted outage report outranks operator Hold, because Auto must not resume selling on that report.
 */
export function fleetIntent(tick: TickView, quality: string, line: OutageLine): FleetIntent {
  if (untrusted(tick, quality)) {
    return { action: "hold", line: UNTRUSTED_REPORT }
  }
  if (tick.mode === "HOLD") {
    return { action: "hold", line: "Hold. Discharge stays at zero until Auto." }
  }
  if (isPendingAuto(tick)) {
    return {
      action: "hold",
      line: `Auto requested — next dispatch pending. Delivered ${formatMw(tick.delivered_mw)} of ${formatMw(tick.target_mw)} MW (${tick.target_label}).`,
    }
  }
  const delivered = `Delivered ${formatMw(tick.delivered_mw)} of ${formatMw(tick.target_mw)} MW (${tick.target_label})`
  const floor = `above the ${String(tick.reserve_pct)}% floor`
  const trigger = stormTrigger(tick, line)
  if (tick.delivered_mw > 0) {
    const storm = trigger === null ? "" : ` ${trigger}.`
    return { action: "discharge", line: `Discharge ${floor}. ${delivered}.${storm}` }
  }
  const storm = trigger === null ? "" : ` ${trigger}.`
  return { action: "hold", line: `Hold ${floor}. ${delivered}.${storm}` }
}

function untrusted(tick: TickView, quality: string): boolean {
  return untrustedReport(tick, quality)
}

/**
 * AUTO with a full miss and no reason code is not a policy hold: it is the
 * stale HOLD tick after the operator already requested AUTO. The engine
 * always names a miss (storm_reserve, fleet_headroom_short, homes_dead:n,
 * ...), so an empty list means the next live_cycle dispatch has not run yet.
 */
function isPendingAuto(tick: TickView): boolean {
  if (tick.mode !== "AUTO") return false
  if (!(tick.delivered_mw <= 0)) return false
  if (!(tick.target_mw > 0)) return false
  if (!(tick.missed_mw >= tick.target_mw - 1e-9)) return false
  const reasons = tick.reasons ?? []
  return reasons.length === 0
}

/** The outage crossing, included only when this tick's floor was raised for that posting. */
function stormTrigger(tick: TickView, line: OutageLine): string | null {
  if (tick.policy_reason !== "storm_risk_high" || tick.risk_level !== "HIGH") {
    return null
  }
  if (line.side !== "past" || line.trigger === null) {
    return null
  }
  return line.trigger
}
