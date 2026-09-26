import { describe, expect, it } from "vitest"
import {
  INTERVAL_WINDOW,
  eventNote,
  intervalClockLabel,
  intervalEvents,
  intervalPeak,
  intervalSeries,
  intervalSummary,
  rollingIntervals,
  type IntervalDraft,
} from "../src/intervalSeries"

function draft(partial: Partial<IntervalDraft> & Pick<IntervalDraft, "ts">): IntervalDraft {
  return {
    label: partial.label,
    targetMw: 0.4,
    deliveredMw: 0.4,
    reservedMw: 0.1,
    riskLevel: "LOW",
    reservePct: 30,
    policyReason: "normal",
    deadHomes: 0,
    mode: "AUTO",
    ...partial,
  }
}

describe("interval series", () => {
  it("labels a 15-minute Central window from the interval clock, not a tape index", () => {
    expect(intervalClockLabel("2026-09-26T14:07:00-05:00")).toBe("14:00–14:15 CT")
    expect(intervalClockLabel("not-a-time")).toBe("not-a-time")
  })

  it("marks risk HIGH, a raised floor, homes offline, and hold from the series", () => {
    const calm = draft({ ts: "2026-09-26T14:00:00-05:00" })
    const storm = draft({
      ts: "2026-09-26T14:15:00-05:00",
      deliveredMw: 0.2,
      reservedMw: 0.3,
      riskLevel: "HIGH",
      reservePct: 60,
      policyReason: "storm_risk_high",
      deadHomes: 15,
      mode: "HOLD",
    })
    expect(intervalEvents(calm, null)).toEqual([])
    expect(intervalEvents(storm, calm)).toEqual(["risk-high", "floor-raised", "homes-offline", "hold"])
  })

  it("keeps the newest window and leaves an empty feed empty", () => {
    const drafts = Array.from({ length: INTERVAL_WINDOW + 3 }, (_, index) =>
      draft({
        ts: `2026-09-26T${String(10 + index).padStart(2, "0")}:00:00-05:00`,
        label: `i${String(index)}`,
        targetMw: index,
      }),
    )
    const points = intervalSeries(drafts)
    const window = rollingIntervals(points)
    expect(window).toHaveLength(INTERVAL_WINDOW)
    expect(window[0]?.label).toBe("i3")
    expect(window.at(-1)?.label).toBe("i14")
    expect(rollingIntervals([])).toEqual([])
    expect(intervalSummary([])).toBe("Waiting for intervals")
  })

  it("names clock labels in the summary and scales all three series", () => {
    const points = intervalSeries([
      draft({ ts: "2026-09-26T14:00:00-05:00", label: "14:00–14:15 CT" }),
      draft({
        ts: "2026-09-26T14:15:00-05:00",
        label: "14:15–14:30 CT",
        targetMw: 0.5,
        deliveredMw: 0,
        reservedMw: 0.4,
        riskLevel: "HIGH",
        reservePct: 60,
        policyReason: "storm_risk_high",
      }),
    ])
    expect(intervalPeak(points)).toBe(0.5)
    expect(intervalSummary(points)).toContain("14:15–14:30 CT risk HIGH")
    expect(intervalSummary(points)).toContain("14:15–14:30 CT floor raised")
    expect(eventNote("homes-offline")).toBe("homes offline")
  })
})
