import { describe, expect, it } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile } from "../src/contracts"
import { chartPoint, seriesMax, tapeColumns, tapeSummary } from "../src/components/organisms/tapeSpark"

const run = layoutRun as RunFile

describe("tape sparkline", () => {
  const columns = tapeColumns(run.ticks)

  it("marks tick 05 as the on-purpose miss when risk flips HIGH", () => {
    expect(columns).toHaveLength(12)
    expect(columns[4]?.tick).toBe(5)
    expect(columns[4]?.events).toEqual(["risk-high", "missed-on-purpose"])
    expect(tapeSummary(columns)).toContain("Tick 05 missed on purpose when risk flipped HIGH.")
  })

  it("marks tick 06 where homes died and leaves the later recovery unmarked", () => {
    expect(columns[5]?.tick).toBe(6)
    expect(columns[5]?.events).toEqual(["home-died"])
    expect(columns[9]?.events).toEqual([])
  })

  it("places delivered below target on the on-purpose miss", () => {
    const max = seriesMax(columns)
    expect(max).toBe(0.4)
    const target = chartPoint(4, columns.length, columns[4]?.target ?? 0, max)
    const delivered = chartPoint(4, columns.length, columns[4]?.delivered ?? 0, max)
    expect(delivered.y).toBeGreaterThan(target.y)
    expect(target.x).toBeCloseTo(((4 + 0.5) / 12) * 100)
  })
})
