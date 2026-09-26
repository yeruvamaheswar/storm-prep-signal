import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { calmStreak } from "../src/calmStreak"
import { TopStrip } from "../src/components/organisms/TopStrip"
import { SideRail } from "../src/components/organisms/SideRail"
import type { RunFile, TickView } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"
import { scenes } from "../src/fixtures/scenes"
import { feedChip } from "../src/format"
import { reportFeeds } from "../src/reportFeeds"
import { stressReading } from "../src/stressReading"
import { liveSnapshot, wallSnapshot } from "../src/wallSnapshot"

const run = layoutRun as RunFile
const apiOk = { state: "ok" as const }

function tick(number: number): TickView {
  const found = run.ticks.find((item) => item.tick === number)
  if (found === undefined) {
    throw new Error(`tick ${String(number)} missing`)
  }
  return found
}

function strip(number: number, runId = run.run_id, decisionLine: string | null = run.decision_line): string {
  const current = tick(number)
  const calm = calmStreak(run.ticks.filter((item) => item.tick <= number))
  return renderToStaticMarkup(
    createElement(TopStrip, {
      tick: current,
      runId,
      decisionLine,
      tickCount: run.ticks.length,
      calm,
      snapshot: wallSnapshot({ runtime: "demo", tick: current, calm }),
      api: apiOk,
    }),
  )
}

describe("floor and risk subtitles", () => {
  it("shows sentence-case reasons on a high tick, with a tooltip, and no raw code", () => {
    const html = strip(9)
    expect(html).toContain("Storm risk high")
    expect(html).toContain("every home")
    expect(html).toContain("storm reserve")
    expect(html).not.toContain("storm_risk_high")
  })

  it("keeps the calm sentence on Risk and sentence-cases the floor while the streak is short", () => {
    const html = strip(10)
    expect(html).toContain("1 more calm reading")
    expect(html).toContain("Normal")
    expect(html).not.toContain(">normal<")
  })

  it("sentence-cases the fail-safe reason on both cells", () => {
    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    expect(failsafe).toBeDefined()
    if (failsafe === undefined) {
      return
    }
    const html = renderToStaticMarkup(
      createElement(TopStrip, {
        tick: failsafe.tick,
        runId: "scene",
        tickCount: 1,
        calm: 0,
        snapshot: wallSnapshot({ runtime: "demo", tick: failsafe.tick, calm: 0 }),
        api: apiOk,
      }),
    )
    expect(html).toContain("Signal unavailable")
    expect(html).not.toContain("signal_unavailable")
  })
})

describe("fixture chrome", () => {
  it("names the margin as the reserve threshold and delivered MW as the home floor", () => {
    const html = strip(5)
    expect(html).toContain("+191")
    expect(html).toContain("past the reserve threshold")
    expect(html).toContain("above the 60% floor")
    expect(html).not.toContain("above the line")
    expect(html).not.toContain("over the line")
  })

  it("keeps SYNTHETIC compact in the mast and gates the fixture id behind Demo", () => {
    const html = strip(1)
    expect(html).toContain("source-chip")
    expect(html).toContain("SYNTHETIC")
    expect(html).toContain(">Demo<")
    expect(html).toContain("layout-fixture — Layout fixture for the 12-tick demo tape. Not an engine run.")
    expect(html).not.toContain('class="run-id"')
    expect(html).not.toContain(">layout-fixture<")
  })

  it("prints a real run id and leaves the Demo badge off", () => {
    const html = strip(1, "20260926-131900-000001", "[NORMAL] risk LOW | source: live")
    expect(html).toContain("20260926-131900-000001")
    expect(html).toContain("SYNTHETIC")
    expect(html).not.toContain("demo-badge")
  })

  it("lists fixture feeds on Quality without dumping EMIL columns", () => {
    const current = tick(1)
    const reading = stressReading(current)
    const feeds = reportFeeds(reading, feedChip(current.target_label, current.price_label), null)
    const html = renderToStaticMarkup(
      createElement(TopStrip, {
        tick: current,
        runId: run.run_id,
        decisionLine: run.decision_line,
        tickCount: run.ticks.length,
        calm: 0,
        snapshot: wallSnapshot({ runtime: "demo", tick: current, calm: 0 }),
        feeds,
        api: apiOk,
      }),
    )
    expect(html).toContain("NP3-233-CD outage")
    expect(html).toContain("NP6-905-CD price")
    expect(html).toContain("LZ_NORTH")
    expect(html).toContain("Feeds freshness")
    expect(html).not.toMatch(/totalResource|postedDatetime|hourEnding/)
  })

  it("prints holding spare energy from a bad feed, not a raw report name", () => {
    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    expect(failsafe).toBeDefined()
    if (failsafe === undefined) {
      return
    }
    const reading = stressReading(failsafe.tick)
    const banner = null
    const feeds = reportFeeds(reading, "SYNTHETIC", banner)
    const html = renderToStaticMarkup(
      createElement(SideRail, {
        brief: failsafe.tick.brief,
        reasons: failsafe.tick.reasons,
        decisionLine: null,
        tick: 0,
        tickCount: 1,
        feeds,
      }),
    )
    expect(html).toContain("Holding spare energy")
    expect(html).toContain("Feeds")
    expect(html).not.toContain("Storm signal could not be read")
    expect(html).not.toMatch(/totalResource|postedDatetime/)
  })

  it("shows the tick brief and hides the fixture footer", () => {
    const html = renderToStaticMarkup(
      createElement(SideRail, {
        brief: "Delivered 0.20 of 0.20 MW (synthetic target).",
        reasons: [],
        decisionLine: run.decision_line,
        tick: 1,
        tickCount: 12,
        feeds: reportFeeds(stressReading(tick(1)), feedChip(tick(1).target_label, tick(1).price_label), null),
      }),
    )
    expect(html).toContain("Delivered 0.20 of 0.20 MW (synthetic target).")
    expect(html).not.toContain("Not an engine run")
    expect(html).not.toContain("decision-line")
  })

  it("uses the ERCOT interval in Live and hides the tape chrome", () => {
    const current = tick(5)
    const html = renderToStaticMarkup(
      createElement(TopStrip, {
        tick: current,
        runId: run.run_id,
        decisionLine: run.decision_line,
        tickCount: run.ticks.length,
        calm: 0,
        snapshot: liveSnapshot(current, { latest: null, lastOk: null }, 0),
        runtime: "live",
        intervalLabel: "14:30–14:45 CT",
        clockLabel: "Sep 26, 14:32 CDT",
        api: apiOk,
      }),
    )
    expect(html).toContain("Live · 14:30–14:45 CT")
    expect(html).toContain("Sep 26, 14:32 CDT")
    expect(html).toContain(">LIVE<")
    expect(html).toContain("Degraded")
    expect(html).toContain("waiting on pull")
    expect(html).not.toContain("tick 05")
    expect(html).not.toContain("clock pinned")
    expect(html).not.toContain("demo-badge")
    expect(html).not.toContain("SYNTHETIC")
    expect(html).not.toContain("Demo data")
    expect(html).not.toContain("Unchecked")
  })

  it("fills Live tiles from the poll snapshot, not the tape", () => {
    const current = tick(5)
    const stamp = {
      quality: "ok" as const,
      priceUsdMwh: 42.25,
      outageMw: 20200,
      zone: "North" as const,
      zoneMw: 9000,
      zoneColumns: {},
      asOfLabel: "23:00 CT",
      ageMin: 30,
    }
    const html = renderToStaticMarkup(
      createElement(TopStrip, {
        tick: current,
        runId: run.run_id,
        tickCount: run.ticks.length,
        calm: 0,
        snapshot: liveSnapshot(current, { latest: stamp, lastOk: stamp }, 0),
        runtime: "live",
        intervalLabel: "23:00–23:15 CT",
        clockLabel: "Sep 25, 23:30 CDT",
        api: apiOk,
      }),
    )
    expect(html).toContain("0.40")
    expect(html).toContain(">42<")
    expect(html).toContain("20,200")
    expect(html).toContain(">Live<")
    expect(html).toContain("23:00 CT")
    expect(html).toContain(">30<")
    expect(html).not.toContain("clock pinned")
    expect(html).not.toContain("185")
    expect(html).not.toContain("22,539")
    expect(html).not.toContain("Demo data")
  })

  it("keeps a real decision line under the brief", () => {
    const line = "[NORMAL] risk LOW | source: live"
    const html = renderToStaticMarkup(
      createElement(SideRail, {
        brief: "Delivered 0.20 of 0.20 MW.",
        reasons: [],
        decisionLine: line,
        tick: 1,
        tickCount: 12,
        feeds: reportFeeds(stressReading(tick(1)), feedChip(tick(1).target_label, tick(1).price_label), null),
      }),
    )
    expect(html).toContain(line)
  })
})
