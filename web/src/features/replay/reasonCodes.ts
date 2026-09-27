/** Engine reason codes the Replay views read, kept in one place so the promise panel and the weather rule
 * cannot drift apart. Sources: server/engine/policy.py (zone reasons) and server/engine/contracts.py
 * (allocation reasons). */

/** The zone's floor was raised because the ERCOT risk signal is missing. A missing feed is not weather. */
export const SIGNAL_MISSING_REASON = "signal_unavailable"

/** Tick reasons that mean a floor was raised, so energy was deliberately kept back (promise panel).
 * Any reason that starts with "weather" counts too (e.g. "weather_alert:North"). */
export const FLOOR_RAISING_REASONS = ["storm_reserve", SIGNAL_MISSING_REASON, "weather_alert"] as const

/** Zone reasons that mean real weather raised the zone's floor: the ERCOT storm rule or a weather alert.
 * Any reason that starts with "weather" counts too. */
export const WEATHER_REASONS = ["storm_risk_high", "weather_alert"] as const

const WEATHER_PREFIX = "weather"

function matches(codes: readonly string[], reason: string | null | undefined): boolean {
  return !!reason && (codes.includes(reason) || reason.startsWith(WEATHER_PREFIX))
}

export function isFloorRaisingReason(reason: string | null | undefined): boolean {
  return matches(FLOOR_RAISING_REASONS, reason)
}

export function isWeatherReason(reason: string | null | undefined): boolean {
  return matches(WEATHER_REASONS, reason)
}

/** An operator HOLD sends nothing (controller.py: Allocation({}, 0, target, ["operator_hold"])). History points
 * carry no mode, so the reason alone also counts. The one HOLD rule for the promise panel, ledger and zone views. */
export function isOperatorHold(tick: { mode?: string | null; reasons?: readonly string[] | null } | null | undefined): boolean {
  return tick?.mode === "HOLD" || (tick?.reasons ?? []).includes("operator_hold")
}

export const OPERATOR_HOLD_TEXT = "Operator hold: no orders this tick."

/** The planner used a reading that was not live (scenario.py `plan_status`, from telemetry.reported_homes).
 * False when the row carries no `plan_status` (an older worker). Shared by the Replay and the fleet grid. */
export function planNotLive(home: { plan_status?: string | null }): boolean {
  return typeof home.plan_status === "string" && home.plan_status !== "live"
}

/** This home's own floor was raised by weather (#47: floors are set per county). Its `floor_reason` says why:
 * `weather_alert` / `storm_risk_high` raise it; `not_in_alert` and `normal` keep the base floor. An older worker
 * sends no `floor_reason`: trust the zone. */
export function homeFloorRaised(home: { floor_reason?: string | null }): boolean {
  if (typeof home.floor_reason !== "string") return true
  return isWeatherReason(home.floor_reason)
}
