import { describe, expect, it } from "vitest"
import type { RunFile, TickView } from "../src/contracts"
import { fleetIntent } from "../src/fleetIntent"
import layoutRun from "../src/fixtures/layout-run.json"
import { scenes } from "../src/fixtures/scenes"
import { stressReading } from "../src/stressReading"
import { outageLine } from "../src/wallLines"

const run = layoutRun as RunFile

function tapeTick(n: number): TickView {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`tick ${String(n)} missing`)
  }
  return found
}

function intent(tick: TickView, quality = "ok") {
  return fleetIntent(tick, quality, outageLine(stressReading(tick)))
}

describe("fleet intent", () => {
  it("reads a calm tick as discharge above the home floor", () => {
    const next = intent(tapeTick(1))
    expect(next.action).toBe("discharge")
    expect(next.line).toBe("Discharge above the 30% floor. Delivered 0.20 of 0.20 MW (synthetic).")
    expect(next.line).not.toMatch(/\bCharge\b/)
  })

  it("keeps selling on a high tick and names the same outage trigger", () => {
    const next = intent(tapeTick(5))
    expect(next.action).toBe("discharge")
    expect(next.line).toBe(
      "Discharge above the 60% floor. Delivered 0.31 of 0.40 MW (synthetic). Outage 22,539 MW vs 22,348 MW threshold.",
    )
  })

  it("lets operator Hold beat a raised floor", () => {
    const next = intent(tapeTick(8))
    expect(next.action).toBe("hold")
    expect(next.line).toBe("Hold. Discharge stays at zero until Auto.")
    expect(next.line).not.toContain("threshold")
  })

  it("holds an auth-fail the same way as a late report", () => {
    const next = intent(tapeTick(1), "auth")
    expect(next.action).toBe("hold")
    expect(next.line).toBe("Hold the reserve floor. The outage report cannot be trusted.")
  })

  it("holds when the outage report cannot be trusted", () => {
    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    if (failsafe === undefined) {
      throw new Error("failsafe scene missing")
    }
    const next = intent(failsafe.tick, failsafe.quality)
    expect(next.action).toBe("hold")
    expect(next.line).toBe("Hold the reserve floor. The outage report cannot be trusted.")
    expect(next.line).not.toContain("threshold")
  })

  it("holds a stale report even when the tick still shows delivered megawatts", () => {
    const next = intent({ ...tapeTick(1), delivered_mw: 0.2 }, "stale")
    expect(next.action).toBe("hold")
    expect(next.line).toBe("Hold the reserve floor. The outage report cannot be trusted.")
  })

  it("holds an automatic tick that delivered nothing, and still names a storm trigger", () => {
    const next = intent({ ...tapeTick(5), delivered_mw: 0, missed_mw: 0.4 })
    expect(next.action).toBe("hold")
    expect(next.line).toBe(
      "Hold above the 60% floor. Delivered 0.00 of 0.40 MW (synthetic). Outage 22,539 MW vs 22,348 MW threshold.",
    )
  })

  it("reads the offline scene as discharge from the homes still live", () => {
    const devices = scenes.find((scene) => scene.id === "devices")
    if (devices === undefined) {
      throw new Error("devices scene missing")
    }
    const next = intent(devices.tick, devices.quality)
    expect(next.action).toBe("discharge")
    expect(next.line).toBe("Discharge above the 30% floor. Delivered 0.34 of 0.40 MW (synthetic).")
  })
})
