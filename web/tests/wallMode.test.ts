import { describe, expect, it } from "vitest"
import type { RunFile } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"
import { planModeChange } from "../src/wallMode"

const run = layoutRun as RunFile

describe("planModeChange", () => {
  it("keeps Demo on the tape jump to hold, then auto after it", () => {
    const hold = planModeChange("demo", run.ticks, "AUTO", "HOLD", 0)
    expect(hold).toEqual({ kind: "demo", index: expect.any(Number) })
    if (hold.kind !== "demo") {
      return
    }
    expect(run.ticks[hold.index]?.mode).toBe("HOLD")
    const auto = planModeChange("demo", run.ticks, "HOLD", "AUTO", hold.index)
    expect(auto).toEqual({ kind: "demo", index: expect.any(Number) })
    if (auto.kind !== "demo") {
      return
    }
    expect(auto.index).toBeGreaterThan(hold.index)
    expect(run.ticks[auto.index]?.mode).toBe("AUTO")
  })

  it("asks the engine in Live instead of opening a tape tick", () => {
    expect(planModeChange("live", run.ticks, "AUTO", "HOLD", 0)).toEqual({ kind: "live", mode: "HOLD" })
    expect(planModeChange("live", run.ticks, "HOLD", "AUTO", 7)).toEqual({ kind: "live", mode: "AUTO" })
    expect(planModeChange("live", run.ticks, "HOLD", "HOLD", 7)).toEqual({ kind: "noop" })
  })
})
