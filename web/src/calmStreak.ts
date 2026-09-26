import type { RiskLevel, TickView } from "./contracts"

export const CALM_NEEDED = 2

/** How many snapshot readings to keep. The meter caps at 2, so a short tail is enough. */
const CALM_HISTORY = 12

/** One Live or archive pull. Same `ts` is the same reading; an empty `ts` is a fail-safe. */
export type CalmSample = {
  ts: string
  risk_level: RiskLevel | null
  policy_reason: string
  quality: string
}

type CalmTick = Pick<TickView, "risk_level" | "policy_reason">

/** One line under the meter. Calm is a streak of clean LOW readings, separate from this tick's Risk. */
export const CALM_LINE = "clean LOW readings in a row"

/**
 * LOW readings in a row, capped at CALM_NEEDED. HIGH or a fail-safe tick resets it to 0.
 * Display only: the engine's reserve_policy still returns the base floor on the first LOW tick.
 */
export function calmStep(streak: number, tick: CalmTick, quality = "ok"): number {
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
export function calmStreak(ticks: readonly TickView[], quality = "ok"): number {
  return ticks.reduce((streak, tick) => calmStep(streak, tick, quality), 0)
}

/**
 * A repeat of the same snapshot time replaces the last reading.
 * A 20s poll of one live cycle must not add a second calm point.
 * Consecutive fail-safes (empty ts) collapse the same way.
 */
export function pushCalmSample(samples: readonly CalmSample[], next: CalmSample): CalmSample[] {
  const last = samples.at(-1)
  const sameReading = last !== undefined && next.ts !== "" && last.ts === next.ts
  const sameFailure = last !== undefined && next.ts === "" && last.ts === ""
  const kept = sameReading || sameFailure ? samples.slice(0, -1) : samples
  return [...kept, next].slice(-CALM_HISTORY)
}

/** Streak across Live or archive pulls. Each sample keeps the quality it arrived with. */
export function calmFromSamples(samples: readonly CalmSample[]): number {
  return samples.reduce((streak, sample) => calmStep(streak, sample, sample.quality), 0)
}

/**
 * Demo tape counts the scrubber prefix. A scene is one staged tick.
 * Live and archive count snapshot samples, because the tape prefix is a different run.
 */
export function wallCalm(args: {
  tapeChosen: boolean
  overlay: boolean
  tapeTicks: readonly TickView[]
  selected: number
  tick: TickView
  quality: string
  samples: readonly CalmSample[]
}): number {
  if (!args.tapeChosen) return calmFromSamples(args.samples)
  if (args.overlay) return calmStreak([args.tick], args.quality)
  return calmStreak(args.tapeTicks.slice(0, args.selected + 1))
}

/** The Risk cell says "normal" only once the streak is full. */
export function riskCaption(tick: TickView, streak: number): string {
  if (tick.policy_reason !== "normal" || streak >= CALM_NEEDED) {
    return tick.policy_reason
  }
  const left = CALM_NEEDED - streak
  return left === 1 ? "1 more calm reading" : `${left} more calm readings`
}
