import { describe, expect, it } from "vitest"
import type { TickView } from "../src/contracts"
import { scenes } from "../src/fixtures/scenes"
import run from "../src/fixtures/layout-run.json"
import { briefDecision, headerIdentity, headerReason, lossCaption, reasonText, tapeStamp } from "../src/format"

const ticks = run.ticks as TickView[]

function tapeTick(tick: number): TickView {
  const found = ticks.find((item) => item.tick === tick)
  if (found === undefined) {
    throw new Error(`tick ${String(tick)} missing`)
  }
  return found
}

describe("reason text", () => {
  it("writes the storm tick in operator English", () => {
    expect(reasonText("storm_reserve")).toBe("Storm reserve raised")
    expect(reasonText("fleet_headroom_short")).toBe("Not enough headroom above the floor")
    expect(reasonText("homes_dead:20")).toBe("20 homes are dead")
    expect(reasonText("homes_stale:1")).toBe("1 home is stale")
    expect(reasonText("operator_hold")).toBe("Operator hold")
    expect(reasonText("holding_spare_energy")).toBe("Holding spare energy")
  })

  it("turns floor and risk reason codes into sentence-case labels", () => {
    expect(headerReason("storm_risk_high")).toEqual({
      label: "Storm risk high",
      tooltip: "Outage MW is past the reserve threshold, so every home's floor rose to the storm reserve.",
    })
    expect(headerReason("signal_unavailable").label).toBe("Signal unavailable")
    expect(headerReason("weather_alert").label).toBe("Weather alert")
    expect(headerReason("normal").label).toBe("Normal")
    for (const code of ["storm_risk_high", "signal_unavailable", "weather_alert", "normal"]) {
      const copy = headerReason(code)
      expect(copy.label).not.toContain("_")
      expect(copy.tooltip).toBeTruthy()
      expect(copy.tooltip).not.toContain("_")
    }
  })

  it("leaves a calm-meter sentence alone", () => {
    expect(headerReason("1 more calm reading")).toEqual({ label: "1 more calm reading" })
  })

  it("does not pass an unknown reason code through with underscores", () => {
    const copy = headerReason("zone_floor_raised")
    expect(copy.label).toBe("Zone floor raised")
    expect(copy.label).not.toContain("_")
    expect(copy.tooltip).toBeUndefined()
  })

  it("gates layout-fixture and the demo-tape disclaimer behind a Demo title", () => {
    expect(headerIdentity("layout-fixture", run.decision_line)).toEqual({
      runId: null,
      demoTitle: "layout-fixture — Layout fixture for the 12-tick demo tape. Not an engine run.",
    })
    expect(headerIdentity("demo-stress", null)).toEqual({
      runId: null,
      demoTitle: "demo-stress",
    })
    expect(briefDecision(run.decision_line)).toBeNull()
  })

  it("keeps an engine run id and a real decision line on the wall", () => {
    const line = "[NORMAL] risk LOW | source: live"
    expect(headerIdentity("20260926-131900-000001", line)).toEqual({
      runId: "20260926-131900-000001",
      demoTitle: null,
    })
    expect(briefDecision(line)).toBe(line)
    expect(briefDecision(null)).toBeNull()
    expect(briefDecision("  ")).toBeNull()
  })

  it("stamps quality and the tape tick once", () => {
    expect(tapeStamp(5, 12)).toBe("quality: ok · tape tick 5/12")
  })
})

describe("loss caption", () => {
  it("stays quiet while no home is dead", () => {
    expect(lossCaption(tapeTick(5))).toBeNull()
  })

  it("reads tick 06 as reallocated, without blaming the storm miss on the loss", () => {
    expect(lossCaption(tapeTick(6))).toEqual({
      kind: "reallocated",
      missed: "missed 0.16 MW rising",
      line: "reallocated to 80 live homes · 0.08 MW given up",
    })
  })

  it("reads the 15% dead scene as reallocated to the homes still live", () => {
    const devices = scenes.find((scene) => scene.id === "devices")
    expect(devices && lossCaption(devices.tick)).toEqual({
      kind: "reallocated",
      missed: "missed 0.06 MW rising",
      line: "reallocated to 81 live homes · 0.06 MW given up",
    })
  })

  it("says nothing moved while HOLD is on", () => {
    expect(lossCaption(tapeTick(8))).toEqual({
      kind: "frozen",
      missed: "missed 0.40 MW rising",
      line: "no reallocate · discharge frozen",
    })
  })
})
