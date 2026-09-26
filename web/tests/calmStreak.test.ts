import { describe, expect, it } from "vitest"
import layoutRun from "../src/fixtures/layout-run.json"
import { calmStreak, riskCaption } from "../src/calmStreak"
import type { RunFile, TickView } from "../src/contracts"
import { scenes } from "../src/fixtures/scenes"

const run = layoutRun as RunFile

function upTo(tickNumber: number): TickView[] {
  return run.ticks.filter((tick) => tick.tick <= tickNumber)
}

function withRisk(base: TickView, risk_level: TickView["risk_level"]): TickView {
  const policy_reason = risk_level === "HIGH" ? "storm_risk_high" : risk_level === "LOW" ? "normal" : "signal_unavailable"
  return { ...base, risk_level, policy_reason }
}

describe("calm streak", () => {
  it("climbs 0, 1, 2 across fixture ticks 9 to 11 and holds at 2 on tick 12", () => {
    expect([9, 10, 11, 12].map((tick) => calmStreak(upTo(tick)))).toEqual([0, 1, 2, 2])
  })

  it("says normal on the Risk cell only once the streak is full", () => {
    const tick10 = upTo(10).at(-1) as TickView
    const tick11 = upTo(11).at(-1) as TickView
    expect(riskCaption(tick10, calmStreak(upTo(10)))).toBe("1 more calm reading")
    expect(riskCaption(tick11, calmStreak(upTo(11)))).toBe("normal")
  })

  it("keeps the engine reason on HIGH and fail-safe ticks", () => {
    const tick9 = upTo(9).at(-1) as TickView
    expect(riskCaption(tick9, 0)).toBe("storm_risk_high")
  })

  it("resets on HIGH: HIGH, LOW, HIGH, LOW stays short of normal", () => {
    const base = run.ticks[0] as TickView
    const ticks = (["HIGH", "LOW", "HIGH", "LOW"] as const).map((level) => withRisk(base, level))
    expect(calmStreak(ticks)).toBe(1)
  })

  it("resets on a fail-safe tick", () => {
    const base = run.ticks[0] as TickView
    expect(calmStreak([withRisk(base, "LOW"), withRisk(base, "LOW"), withRisk(base, null)])).toBe(0)
    expect(calmStreak([withRisk(base, "LOW")], "timeout")).toBe(0)
  })

  it("reads the staged fail-safe scene as 0", () => {
    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    expect(failsafe).toBeDefined()
    if (failsafe !== undefined) {
      expect(calmStreak([failsafe.tick], failsafe.quality)).toBe(0)
    }
  })
})
