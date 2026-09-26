import { describe, expect, it } from "vitest"
import type { TickView } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"
import { scenes } from "../src/fixtures/scenes"
import type { RunFile } from "../src/contracts"
import { stressReading } from "../src/stressReading"
import { deliverableFloorCaption, outageLine, reserveBanner } from "../src/wallLines"

const run = layoutRun as RunFile

function tapeTick(n: number): TickView {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`tick ${String(n)} missing`)
  }
  return found
}

describe("outage line and reserve banner", () => {
  it("names the storm trigger from outage minus the reserve threshold", () => {
    const tick = tapeTick(5)
    const line = outageLine(stressReading(tick))
    expect(line.marginMw).toBe(191)
    expect(line.side).toBe("past")
    expect(line.marginCaption).toBe("past the reserve threshold")
    expect(line.trigger).toBe("Outage 22,539 MW vs 22,348 MW threshold")
    expect(reserveBanner(tick, "ok", line)).toBe(
      "Raise the reserve floor. Outage 22,539 MW vs 22,348 MW threshold.",
    )
    expect(reserveBanner(tick, "ok", line)).not.toContain("RESERVE")
    expect(line.marginCaption).not.toContain("the line")
  })

  it("keeps a calm posting under the reserve threshold, with no reserve banner", () => {
    const tick = tapeTick(1)
    const line = outageLine(stressReading(tick))
    expect(line.side).toBe("under")
    expect(line.marginCaption).toBe("under the reserve threshold")
    expect(reserveBanner(tick, "ok", line)).toBeNull()
  })

  it("treats an auth-fail as an untrusted report", () => {
    const tick = tapeTick(1)
    const line = outageLine(stressReading(tick))
    expect(reserveBanner(tick, "auth", line)).toBe("Hold the reserve floor. The outage report cannot be trusted.")
    expect(reserveBanner(tick, "unavailable", line)).toBe("Hold the reserve floor. The outage report cannot be trusted.")
  })

  it("says the report cannot be trusted without calling that an outage crossing", () => {
    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    if (failsafe === undefined) {
      throw new Error("failsafe scene missing")
    }
    const line = outageLine(stressReading(failsafe.tick))
    const banner = reserveBanner(failsafe.tick, failsafe.quality, line)
    expect(banner).toBe("Hold the reserve floor. The outage report cannot be trusted.")
    expect(banner).not.toContain("RESERVE")
    expect(banner).not.toContain("threshold")
  })

  it("names delivered energy against the home floor, not the reserve threshold", () => {
    expect(deliverableFloorCaption(60)).toBe("above the 60% floor")
    expect(deliverableFloorCaption(30)).not.toContain("threshold")
    expect(deliverableFloorCaption(30)).not.toContain("the line")
  })

  it("subtracts the threshold itself when a stored margin disagrees", () => {
    const tick = {
      ...tapeTick(1),
      outage_mw: 22539,
      threshold_mw: 22348,
      margin_mw: -191,
      driving_zone: "North",
    }
    const line = outageLine(stressReading(tick))
    expect(line.marginMw).toBe(191)
    expect(line.side).toBe("past")
    expect(line.marginCaption).toBe("past the reserve threshold")
  })
})
