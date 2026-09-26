import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AckRail } from "../src/components/organisms/AckRail"
import { telemetryLine } from "../src/components/organisms/telemetryLine"
import type { RunFile, TickView } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"

const TELEMETRY = {
  plant: { homes: { total: 100, live: 69, suspect: 1 } },
  readings: { received: 3005, accepted: 2930, duplicates: 50, late: 25 },
}

function tick(extra: Partial<TickView> = {}): TickView {
  return {
    tick: 5, ts: "2026-09-25T12:00:00-05:00", mode: "AUTO", target_mw: 0.4, target_label: "synthetic",
    delivered_mw: 0.31, missed_mw: 0.09, price_usd_mwh: 185, price_label: "synthetic", reserve_pct: 60,
    policy_reason: "storm_risk_high", risk_level: "HIGH", live_homes: 69, stale_homes: 0, dead_homes: 31,
    breaches: 0, reasons: [], brief: "", ...extra,
  }
}

describe("telemetryLine", () => {
  it("reads live homes, suspects and accepted readings", () => {
    expect(telemetryLine(tick({ telemetry: TELEMETRY }))).toEqual({
      live: "69 of 100 live",
      suspect: 1,
      readings: "2,930 of 3,005 readings accepted",
    })
  })

  it("is null when the snapshot has no telemetry", () => {
    expect(telemetryLine(tick())).toBeNull()
  })

  it("is null when a count is missing, rather than inventing one", () => {
    const partial = { ...TELEMETRY, readings: { received: 3005 } } as unknown as TickView["telemetry"]
    expect(telemetryLine(tick({ telemetry: partial }))).toBeNull()
  })
})

describe("AckRail battery line", () => {
  const render = (t: TickView) => renderToStaticMarkup(createElement(AckRail, { tick: t }))

  it("shows the line, labeled synthetic, with a suspect in the dead colour", () => {
    const html = render(tick({ telemetry: TELEMETRY }))
    expect(html).toContain("Battery reports: 69 of 100 live")
    expect(html).toContain("2,930 of 3,005 readings accepted (synthetic)")
    expect(html).toMatch(/class="telemetry-suspect is-flagged"[^>]*>1 suspect</)
  })

  it("keeps a zero suspect count muted", () => {
    const calm = { ...TELEMETRY, plant: { homes: { total: 100, live: 100, suspect: 0 } } }
    const html = render(tick({ telemetry: calm }))
    expect(html).toMatch(/class="telemetry-suspect"[^>]*>0 suspect</)
  })

  it("hides the line without telemetry", () => {
    expect(render(tick())).not.toContain("Battery reports")
  })

  // Demo ticks 1-9 carry an engine run of tapes/demo.json; 10-12 were hand-edited off the tape.
  it("shows the storm frame in Demo and hides it where the file left the tape", () => {
    const ticks = (layoutRun as RunFile).ticks as TickView[]
    expect(render(ticks[6])).toContain("Battery reports: 69 of 100 live")
    expect(render(ticks[9])).not.toContain("Battery reports")
  })
})
