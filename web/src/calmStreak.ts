import type { TickView } from "./contracts"

export const CALM_NEEDED = 2

/** One line under the meter. Calm is a streak of clean LOW readings, separate from this tick's Risk. */
export const CALM_LINE = "clean LOW readings in a row"

/**
 * LOW readings in a row, capped at CALM_NEEDED. HIGH or a fail-safe tick resets it to 0.
 * Display only: the engine's reserve_policy still returns the base floor on the first LOW tick.
 */
export function calmStep(streak: number, tick: TickView, quality = "ok"): number {
  if (tick.policy_reason === "signal_unavailable" || quality === "timeout" || quality === "stale") {
    return 0
  }
  switch (tick.risk_level) {
    case "LOW":
      return Math.min(streak + 1, CALM_NEEDED)
    case "HIGH":
    case null:
      return 0
    default: {
      const neverLevel: never = tick.risk_level
      return neverLevel
    }
  }
}

/** Streak after the last tick in the list. The run starts at 0, the same as a fail-safe. */
export function calmStreak(ticks: TickView[], quality = "ok"): number {
  return ticks.reduce((streak, tick) => calmStep(streak, tick, quality), 0)
}

/** The Risk cell says "normal" only once the streak is full. */
export function riskCaption(tick: TickView, streak: number): string {
  if (tick.policy_reason !== "normal" || streak >= CALM_NEEDED) {
    return tick.policy_reason
  }
  const left = CALM_NEEDED - streak
  return left === 1 ? "1 more calm reading" : `${left} more calm readings`
}
