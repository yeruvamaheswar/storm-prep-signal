import { describe, expect, it } from "vitest"
import type { TickView } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"
import type { RunFile } from "../src/contracts"
import type { LiveWatch } from "../src/liveStamp"
import { demoSnapshot, liveSnapshot, wallSnapshot } from "../src/wallSnapshot"

const run = layoutRun as RunFile

function tick(number: number): TickView {
  const found = run.ticks.find((item) => item.tick === number)
  if (found === undefined) {
    throw new Error(`tick ${String(number)} missing`)
  }
  return found
}

const LIVE_OK = {
  quality: "ok" as const,
  priceUsdMwh: 42.25,
  outageMw: 20200,
  zone: "North" as const,
  zoneMw: 9000,
  zoneColumns: {},
  asOfLabel: "23:00 CT",
  ageMin: 30,
}

describe("demo snapshot maps the tape", () => {
  it("fills the header contract from a high tape tick", () => {
    const snapshot = demoSnapshot(tick(5), 0)
    expect(snapshot).toMatchObject({
      targetMw: 0.4,
      deliveredMw: 0.31,
      missedMw: 0.09,
      priceMwh: 185,
      floorPct: 60,
      risk: "HIGH",
      calm: 0,
      outageMw: 22539,
      outageThresholdMw: 22348,
      marginMw: 191,
      zone: "North",
      asOf: { ageMin: 0, label: "12:00 CT", pinned: true },
      quality: "demo",
      reasonCodes: ["storm_reserve", "fleet_headroom_short"],
      mode: "AUTO",
      brief: tick(5).brief,
    })
    expect(snapshot.brief).toContain("missed on purpose")
  })

  it("keeps operator hold reasons and the HOLD mode", () => {
    const snapshot = demoSnapshot(tick(8), 0)
    expect(snapshot.mode).toBe("HOLD")
    expect(snapshot.reasonCodes).toContain("operator_hold")
    expect(snapshot.deliveredMw).toBe(0)
  })
})

describe("live snapshot maps the backend poll", () => {
  it("keeps tape target, floor, and reasons, and overlays the poll", () => {
    const watch: LiveWatch = { latest: LIVE_OK, lastOk: LIVE_OK }
    const snapshot = liveSnapshot(tick(5), watch, 0)
    expect(snapshot.targetMw).toBe(0.4)
    expect(snapshot.deliveredMw).toBe(0.31)
    expect(snapshot.floorPct).toBe(60)
    expect(snapshot.risk).toBe("HIGH")
    expect(snapshot.reasonCodes).toEqual(["storm_reserve", "fleet_headroom_short"])
    expect(snapshot.brief).toBe(
      "Delivered 0.31 of 0.40 MW. Storm reserve raised; not enough headroom above the floor.",
    )
    expect(snapshot.brief).not.toContain("missed on purpose")
    expect(snapshot.brief).not.toContain("tape tick")
    expect(snapshot.mode).toBe("AUTO")
    expect(snapshot.priceMwh).toBe(42.25)
    expect(snapshot.outageMw).toBe(20200)
    expect(snapshot.outageThresholdMw).toBeNull()
    expect(snapshot.marginMw).toBeNull()
    expect(snapshot.zone).toBe("North")
    expect(snapshot.asOf).toEqual({ ageMin: 30, label: "23:00 CT", pinned: false })
    expect(snapshot.quality).toBe("live")
  })

  it("uses feed lag for AS OF, not a pinned fixture clock", () => {
    const watch: LiveWatch = { latest: { quality: "auth" }, lastOk: null }
    const snapshot = liveSnapshot(tick(1), watch, 1)
    expect(snapshot.asOf.pinned).toBe(false)
    expect(snapshot.asOf.ageMin).toBeNull()
    expect(snapshot.asOf.label).toBeNull()
    expect(snapshot.quality).toBe("auth_error")
  })

  it("pins AS OF only when the operator pins", () => {
    const watch: LiveWatch = { latest: LIVE_OK, lastOk: LIVE_OK }
    const snapshot = liveSnapshot(tick(1), watch, 1, true)
    expect(snapshot.asOf).toEqual({ ageMin: 0, label: "12:00 CT", pinned: true })
    expect(snapshot.quality).toBe("live")
  })

  it("drops fixture strings from Live QUALITY", () => {
    const allowed = ["live", "stale", "auth_error", "degraded"]
    const watch: LiveWatch = { latest: { quality: "timeout" }, lastOk: null }
    const timeout = liveSnapshot(tick(1), watch, 0)
    expect(allowed).toContain(timeout.quality)
    expect(timeout.quality).toBe("degraded")
    expect(timeout.quality).not.toBe("demo")
    expect(timeout.quality).not.toBe("unchecked")

    const empty = liveSnapshot(tick(1), { latest: null, lastOk: null }, 0)
    expect(allowed).toContain(empty.quality)
    expect(empty.quality).not.toBe("demo")
    expect(empty.quality).not.toBe("unchecked")
  })

  it("keeps last-good poll numbers when a later pull fails", () => {
    const watch: LiveWatch = { latest: { quality: "stale" }, lastOk: LIVE_OK }
    const snapshot = liveSnapshot(tick(5), watch, 0)
    expect(snapshot.priceMwh).toBe(42.25)
    expect(snapshot.asOf).toEqual({ ageMin: 30, label: "23:00 CT", pinned: false })
    expect(snapshot.quality).toBe("stale")
    expect(snapshot.floorPct).toBe(60)
    expect(snapshot.risk).toBeNull()
    expect(snapshot.quality).not.toBe("demo")
  })

  it("uses the Python trigger, not the 22348 tape fixture", () => {
    const rated = {
      ...LIVE_OK,
      outageMw: 23539,
      triggerMw: 23263.35,
      peakMw: 23539,
      marginMw: 23539 - 23263.35,
      reservePct: 60,
      risk: "HIGH" as const,
      policyReason: "storm_risk_high",
    }
    const snapshot = liveSnapshot(tick(1), { latest: rated, lastOk: rated }, 0)
    expect(snapshot.outageMw).toBe(23539)
    expect(snapshot.outageThresholdMw).toBe(23263.35)
    expect(snapshot.marginMw).toBe(23539 - 23263.35)
    expect(snapshot.floorPct).toBe(60)
    expect(snapshot.risk).toBe("HIGH")
    expect(snapshot.outageThresholdMw).not.toBe(22348)
  })

  it("shows fail-safe floor and quality when the live report is unavailable", () => {
    const watch: LiveWatch = { latest: { quality: "stale" }, lastOk: null }
    const snapshot = liveSnapshot(tick(5), watch, 0)
    expect(snapshot.floorPct).toBe(60)
    expect(snapshot.risk).toBeNull()
    expect(snapshot.outageMw).toBeNull()
    expect(snapshot.outageThresholdMw).toBeNull()
    expect(snapshot.quality).toBe("stale")
    expect(snapshot.quality).not.toBe("demo")
  })
})

describe("one snapshot type both modes fill", () => {
  it("dispatches Demo to the tape and Live to the poll", () => {
    const watch: LiveWatch = { latest: LIVE_OK, lastOk: LIVE_OK }
    const demo = wallSnapshot({ runtime: "demo", tick: tick(5), calm: 0 })
    const live = wallSnapshot({ runtime: "live", tick: tick(5), calm: 0, watch })
    expect(demo.priceMwh).toBe(185)
    expect(demo.quality).toBe("demo")
    expect(demo.asOf.pinned).toBe(true)
    expect(live.priceMwh).toBe(42.25)
    expect(live.quality).toBe("live")
    expect(live.asOf.pinned).toBe(false)
  })

  it("uses the selected zone's LZ row for PRICE and leaves a missing row unread", () => {
    const priced = {
      ...tick(1),
      price_usd_mwh: 42.25,
      price_label: "ercot",
      zone_prices: { Houston: 20.63, North: 42.25, South: 18.5, West: 31.1 },
    }
    const watch: LiveWatch = { latest: LIVE_OK, lastOk: LIVE_OK, tick: priced }
    expect(wallSnapshot({ runtime: "live", tick: priced, calm: 0, watch, zone: "Houston" }).priceMwh).toBe(20.63)
    expect(wallSnapshot({ runtime: "live", tick: priced, calm: 0, watch, zone: "North" }).priceMwh).toBe(42.25)
    const northOnly = { ...priced, zone_prices: { North: 42.25 } }
    expect(wallSnapshot({ runtime: "live", tick: northOnly, calm: 0, watch, zone: "Houston" }).priceMwh).toBeNull()
  })

  it("keeps Demo numbers on fallback and names the failed live pull", () => {
    const snapshot = wallSnapshot({ runtime: "demo", tick: tick(5), calm: 0, fallbackQuality: "auth" })
    expect(snapshot.priceMwh).toBe(185)
    expect(snapshot.outageThresholdMw).toBe(22348)
    expect(snapshot.quality).toBe("auth_error")
    expect(snapshot.quality).not.toBe("demo")
  })
})
