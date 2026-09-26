import type { Mode, TickView } from "../../contracts"

/**
 * The wall does not call the engine. A mode button jumps to the tape tick
 * that already carries that mode. The operator event sticks until the next
 * one, and allocate gives every home 0 kW while the mode is HOLD.
 */
export function modeTickIndex(ticks: readonly TickView[], mode: Mode, from: number): number | null {
  const current = ticks[from]
  if (current?.mode === mode) {
    return from
  }

  switch (mode) {
    case "HOLD": {
      const index = ticks.findIndex((tick) => tick.mode === "HOLD")
      return index >= 0 ? index : null
    }
    case "AUTO": {
      const after = ticks.findIndex((tick, index) => index > from && tick.mode === "AUTO")
      if (after >= 0) {
        return after
      }
      const first = ticks.findIndex((tick) => tick.mode === "AUTO")
      return first >= 0 ? first : null
    }
    default: {
      const neverMode: never = mode
      return neverMode
    }
  }
}
