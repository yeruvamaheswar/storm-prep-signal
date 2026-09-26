import { describe, expect, it } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile } from "../src/contracts"
import {
  ercotIntervalLabel,
  ingestHealth,
  liveBrief,
  liveRailStamp,
  liveSelectable,
  readingForMode,
  resolveRuntimeMode,
} from "../src/runtimeMode"
import { stressReading } from "../src/stressReading"

const run = layoutRun as RunFile

describe("runtime mode", () => {
  it("stays on Demo when the API is down, and when the first pull fails", () => {
    expect(resolveRuntimeMode(false, "up", true, null)).toBe("demo")
    expect(resolveRuntimeMode(true, "down", false, null)).toBe("demo")
    expect(resolveRuntimeMode(true, "down", false, "live")).toBe("demo")
    expect(liveSelectable(true, "down", false)).toBe(false)
  })

  it("defaults to Live once the API is up and the pull has not failed", () => {
    expect(resolveRuntimeMode(true, "unknown", false, null)).toBe("live")
    expect(resolveRuntimeMode(true, "up", true, null)).toBe("live")
    expect(resolveRuntimeMode(true, "down", true, null)).toBe("live")
    expect(resolveRuntimeMode(true, "up", true, "demo")).toBe("demo")
    expect(resolveRuntimeMode(true, "up", true, null, "demo")).toBe("demo")
    expect(resolveRuntimeMode(false, "unknown", false, null, "live")).toBe("live")
    expect(resolveRuntimeMode(true, "unknown", false, null, null, "demo")).toBe("demo")
    expect(resolveRuntimeMode(false, "down", false, null, "live")).toBe("demo")
    expect(ingestHealth(null)).toBe("unknown")
    expect(ingestHealth("ok")).toBe("up")
    expect(ingestHealth("auth")).toBe("down")
  })

  it("names the fifteen-minute ERCOT window in Central time", () => {
    expect(ercotIntervalLabel(Date.parse("2026-09-26T19:07:00Z"))).toBe("14:00–14:15 CT")
    expect(ercotIntervalLabel(Date.parse("2026-09-26T19:45:00Z"))).toBe("14:45–15:00 CT")
    expect(ercotIntervalLabel(Date.parse("2026-09-27T04:50:00Z"))).toBe("23:45–00:00 CT")
  })

  it("drops the pinned fixture clock and the tape index in Live", () => {
    const tick = run.ticks[4]
    if (tick === undefined) throw new Error("tick missing")
    const reading = readingForMode(stressReading(tick), "live")
    expect(reading.clockPinned).toBe(false)
    expect(reading.asOfLabel).toBeNull()
    expect(readingForMode(stressReading(tick), "demo").clockPinned).toBe(true)
    expect(liveBrief(tick, null)).toBe(
      "Delivered 0.31 of 0.40 MW. Storm reserve raised; not enough headroom above the floor.",
    )
    expect(liveBrief(tick, null)).not.toContain("missed on purpose")
    expect(liveBrief(tick, "14:00 CT")).not.toContain("synthetic")
    expect(liveBrief(tick, "14:00 CT")).not.toContain("tape tick")
    expect(liveRailStamp("Live", "14:00 CT")).toBe("quality: Live · as of 14:00 CT")
    expect(liveRailStamp("Auth error", null)).not.toContain("tape tick")
  })
})
