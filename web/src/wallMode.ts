import { modeTickIndex } from "./components/organisms/modeTicks"
import type { Mode, TickView } from "./contracts"
import type { RuntimeMode } from "./runtimeMode"

export type ModeChange =
  | { kind: "demo"; index: number }
  | { kind: "live"; mode: Mode }
  | { kind: "noop" }

/**
 * Demo still jumps to the tape tick that already carries the mode.
 * Live asks the engine; it does not open tick 08 or 09.
 */
export function planModeChange(
  runtime: RuntimeMode,
  ticks: readonly TickView[],
  current: Mode,
  next: Mode,
  selected: number,
): ModeChange {
  if (runtime === "live") {
    return current === next ? { kind: "noop" } : { kind: "live", mode: next }
  }
  if (current === next) {
    return { kind: "noop" }
  }
  const index = modeTickIndex(ticks, next, selected)
  return index === null ? { kind: "noop" } : { kind: "demo", index }
}
