import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ControlBar } from "../src/components/organisms/ControlBar"
import { modeTickIndex } from "../src/components/organisms/modeTicks"
import type { RunFile } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"

const run = layoutRun as RunFile

function bar(mode: "AUTO" | "HOLD", scene: "failsafe" | "devices" | "high" | null = null): string {
  return renderToStaticMarkup(
    createElement(ControlBar, {
      mode,
      ticks: run.ticks,
      selected: 0,
      scene,
      radar: false,
      onSelect: () => undefined,
      onScene: () => undefined,
      onMode: () => undefined,
      onRadar: () => undefined,
    }),
  )
}

describe("mode tick lookup", () => {
  it("opens the operator hold tick, then the auto tick after it", () => {
    const hold = modeTickIndex(run.ticks, "HOLD", 0)
    expect(hold).not.toBeNull()
    if (hold === null) {
      return
    }
    expect(run.ticks[hold]?.mode).toBe("HOLD")
    expect(run.ticks[hold]?.reasons).toContain("operator_hold")
    const auto = modeTickIndex(run.ticks, "AUTO", hold)
    expect(run.ticks[auto ?? -1]?.mode).toBe("AUTO")
    expect(auto).toBeGreaterThan(hold)
  })

  it("stays on an auto tick that is already showing", () => {
    expect(modeTickIndex(run.ticks, "AUTO", 0)).toBe(0)
  })

  it("has no hold tick to open when the tape never held", () => {
    const autos = run.ticks.filter((tick) => tick.mode === "AUTO")
    expect(modeTickIndex(autos, "HOLD", 0)).toBeNull()
  })
})

describe("mode toolbar", () => {
  it("shows one mode group and scenario chips, without the debug status line", () => {
    const html = bar("AUTO")
    expect(html).toContain("Mode")
    expect(html).toContain(">Hold<")
    expect(html).toContain(">Auto<")
    expect(html).toContain("Fail-safe")
    expect(html).toContain("High risk")
    expect(html).toContain("Radar")
    expect(html).toContain("15% offline")
    expect(html).not.toContain("15% dead")
    expect(html).not.toContain("AUTO · default")
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain("Auto. The controller dispatches to live homes.")
  })

  it("marks Hold as the armed stop and leaves Auto unselected", () => {
    const html = bar("HOLD")
    expect(html).toContain("is-pressed is-armed")
    expect(html).toContain("Hold. Discharge stays at zero until Auto.")
    expect(html).not.toContain("AUTO · default")
  })

  it("presses only the scenario that is on", () => {
    const html = bar("AUTO", "failsafe")
    expect(html).toContain("Fail-safe. The outage report timed out")
    expect(html).toContain("15% offline")
  })
})

describe("live run", () => {
  it("drops the tick scrubber, the playhead, and the tape scenes", () => {
    const html = renderToStaticMarkup(
      createElement(ControlBar, {
        mode: "AUTO",
        ticks: run.ticks,
        selected: 4,
        scene: null,
        radar: false,
        onSelect: () => undefined,
        onScene: () => undefined,
        onMode: () => undefined,
        onRadar: () => undefined,
        runtime: "live",
        liveSelectable: true,
        onRuntime: () => undefined,
      }),
    )
    expect(html).toContain(">Live<")
    expect(html).toContain(">Demo<")
    expect(html).toContain("Radar")
    expect(html).not.toContain('aria-label="Ticks"')
    expect(html).not.toContain("Tick 05")
    expect(html).not.toContain("Tick 06")
    expect(html).not.toContain("missed on purpose")
    expect(html).not.toContain("homes died")
    expect(html).not.toContain("Fail-safe")
    expect(html).not.toContain("15% offline")
    expect(html).toContain("Waiting for intervals")
    expect(html).toContain("interval-skeleton")
    expect(html).not.toContain(">01<")
    expect(html).not.toContain(">05<")
    expect(html).not.toContain(">12<")
  })

  it("draws the live series without tick buttons when intervals arrive", () => {
    const html = renderToStaticMarkup(
      createElement(ControlBar, {
        mode: "AUTO",
        ticks: run.ticks,
        selected: 4,
        scene: null,
        radar: false,
        onSelect: () => undefined,
        onScene: () => undefined,
        onMode: () => undefined,
        onRadar: () => undefined,
        runtime: "live",
        liveSelectable: true,
        onRuntime: () => undefined,
        intervals: [
          {
            ts: "2026-09-26T14:00:00-05:00",
            label: "14:00–14:15 CT",
            targetMw: 0.4,
            deliveredMw: 0.4,
            reservedMw: 0.1,
            events: [],
          },
          {
            ts: "2026-09-26T14:15:00-05:00",
            label: "14:15–14:30 CT",
            targetMw: 0.4,
            deliveredMw: 0.2,
            reservedMw: 0.3,
            events: ["risk-high", "floor-raised"],
          },
        ],
      }),
    )
    expect(html).toContain("Reserved")
    expect(html).toContain("14:15–14:30 CT risk HIGH")
    expect(html).toContain("14:15–14:30 CT floor raised")
    expect(html).not.toContain("Waiting for intervals")
    expect(html).not.toContain('aria-label="Ticks"')
    expect(html).not.toContain("missed on purpose")
    expect(html).not.toContain(">05<")
  })

  it("keeps the scrubber on Demo", () => {
    const html = bar("AUTO")
    expect(html).toContain('aria-label="Ticks"')
    expect(html).toContain(">01<")
    expect(html).toContain("Fail-safe")
  })
})
