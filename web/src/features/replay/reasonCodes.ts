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
