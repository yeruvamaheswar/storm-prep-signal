import { describe, expect, it } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile, TickView } from "../src/contracts"
import { stressReading } from "../src/stressReading"

const run = layoutRun as RunFile

function tick(partial: Partial<TickView> & Record<string, unknown>): TickView {
  return { ...run.ticks[0], ...partial }
}

describe("stress reading", () => {
  it("sums houston_mw columns for the tick 05 stress row", () => {
    const storm = run.ticks.find((item) => item.tick === 5)
    expect(storm?.risk_level).toBe("HIGH")
    expect(storm?.reserve_pct).toBe(60)
    expect(storm?.missed_mw).toBe(0.09)
    expect(storm?.north_mw).toBe(9294)
    const reading = stressReading(storm as TickView)
    expect(reading.outageMw).toBe(22539)
    expect(reading.thresholdMw).toBe(22348)
    expect(reading.marginMw).toBe(191)
    expect(reading.zone).toBe("North")
    expect(reading.zoneMw).toBe(storm?.north_mw)
    expect(reading.ageMin).toBe(0)
    expect(reading.asOfLabel).toBe("12:00 CT")
    expect(reading.clockPinned).toBe(true)
    expect(reading.quality).toBe("unchecked")
  })

  it("follows the zone MW columns instead of the painted-spike totals", () => {
    const reading = stressReading(
      tick({
        risk_level: "HIGH",
        houston_mw: 100,
        north_mw: 400,
        south_mw: 200,
        west_mw: 150,
      }),
    )
    expect(reading.outageMw).toBe(850)
    expect(reading.zone).toBe("North")
    expect(reading.zoneMw).toBe(400)
    expect(reading.thresholdMw).toBe(22348)
    expect(reading.marginMw).toBe(850 - 22348)
  })

  it("uses the saved real posting when the tape says LOW", () => {
    const calmTick = run.ticks[0]
    const calm = stressReading(calmTick)
    expect(calm.outageMw).toBe(22194)
    expect(calm.marginMw).toBe(-154)
    expect(calm.zoneMw).toBe(calmTick?.north_mw)
    expect(calm.quality).toBe("unchecked")
    expect(calm.outageMw ?? 0).toBeLessThan(22348)
  })

  it("prefers outage fields already on the tick", () => {
    const reading = stressReading(
      tick({
        risk_level: "LOW",
        outage_mw: 2100,
        threshold_mw: 1500,
        margin_mw: 600,
        driving_zone: "Houston",
        zone_mw: 900,
        stress_as_of: "19:00 CT",
        stress_age_min: 20,
        stress_quality: "timeout",
      }),
    )
    expect(reading.outageMw).toBe(2100)
    expect(reading.thresholdMw).toBe(1500)
    expect(reading.marginMw).toBe(600)
    expect(reading.zone).toBe("Houston")
    expect(reading.zoneMw).toBe(900)
    expect(reading.asOfLabel).toBe("19:00 CT")
    expect(reading.ageMin).toBe(20)
    expect(reading.quality).toBe("timeout")
    expect(reading.clockPinned).toBe(false)
  })

  it("names an unreadable signal instead of inventing megawatts", () => {
    const reading = stressReading(tick({ risk_level: null, policy_reason: "signal_unavailable" }))
    expect(reading.outageMw).toBeNull()
    expect(reading.quality).toBe("signal_unavailable")
  })
})
