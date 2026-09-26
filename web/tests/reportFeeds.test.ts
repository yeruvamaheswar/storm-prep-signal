import { describe, expect, it } from "vitest"
import type { RunFile, TickView } from "../src/contracts"
import layoutRun from "../src/fixtures/layout-run.json"
import { scenes } from "../src/fixtures/scenes"
import { fleetIntent } from "../src/fleetIntent"
import { feedReasons, feedStateLabel, readSuppliedFeeds, reportFeeds, type FeedRow, type ReportFeeds } from "../src/reportFeeds"
import { stressReading, type StressReading } from "../src/stressReading"
import { outageLine, UNTRUSTED_REPORT } from "../src/wallLines"

const run = layoutRun as RunFile

function tapeTick(n: number): TickView {
  const found = run.ticks.find((item) => item.tick === n)
  if (found === undefined) {
    throw new Error(`tick ${String(n)} missing`)
  }
  return found
}

function joined(feeds: ReportFeeds): string {
  return feeds.rows
    .flatMap((row) => [row.product, row.lz, row.asOf, row.lastSuccess, feedStateLabel(row.state)])
    .concat(feeds.purpose ?? "")
    .join("\n")
}

function states(feeds: ReportFeeds): string[] {
  return feeds.rows.map((row) => row.state)
}

describe("report feeds", () => {
  it("lists two fixture products on a bad pull, with hold and no EMIL rows", () => {
    const failsafe = scenes.find((scene) => scene.id === "failsafe")
    if (failsafe === undefined) {
      throw new Error("failsafe scene missing")
    }
    const reading = stressReading(failsafe.tick)
    const banner = fleetIntent(failsafe.tick, failsafe.quality, outageLine(reading)).line
    const feeds = reportFeeds(reading, "SYNTHETIC", banner)
    expect(banner).toBe(UNTRUSTED_REPORT)
    expect(feeds.rows).toHaveLength(2)
    expect(feeds.rows[0]).toMatchObject({
      product: "NP3-233-CD outage",
      lz: "—",
      asOf: "—",
      lastSuccess: "none",
      state: "hold",
    })
    expect(feeds.rows[1]).toMatchObject({
      product: "NP6-905-CD price",
      lz: "LZ_NORTH",
      state: "hold",
    })
    expect(feeds).toMatchObject({
      holdOnFail: "holding",
      badPull: true,
      holdingSpare: true,
      purpose: "Which ERCOT products are live",
    })
    expect(joined(feeds)).not.toMatch(/totalResource|totalIRR|postedDatetime|hourEnding|named fail/)
  })

  it("keeps a pinned calm posting live, with the posting as the last success", () => {
    const tick = tapeTick(1)
    const reading = stressReading(tick)
    const feeds = reportFeeds(reading, "SYNTHETIC", fleetIntent(tick, "ok", outageLine(reading)).line)
    expect(feeds.rows[0]).toMatchObject({
      product: "NP3-233-CD outage",
      lz: "North",
      asOf: "12:00 CT · 0 min",
      lastSuccess: "12:00 CT",
      state: "live",
    })
    expect(feeds.rows[1]).toMatchObject({ product: "NP6-905-CD price", lz: "LZ_NORTH", state: "live" })
    expect(feeds.holdOnFail).toBe("clear")
    expect(feeds.badPull).toBe(false)
    expect(feeds.purpose).toBeNull()
  })

  it("does not treat a storm raise as a bad report", () => {
    const tick = tapeTick(5)
    const reading = stressReading(tick)
    const banner = fleetIntent(tick, "ok", outageLine(reading)).line
    const feeds = reportFeeds(reading, "SYNTHETIC", banner)
    expect(banner).toContain("Discharge above the 60% floor")
    expect(feeds.holdOnFail).toBe("clear")
    expect(states(feeds)).toEqual(["live", "live"])
  })

  it("names an ingest auth failure as Auth, not the raw code", () => {
    const reading: StressReading = {
      outageMw: 22194,
      thresholdMw: null,
      marginMw: null,
      zone: "North",
      zoneMw: 9429,
      asOfLabel: "11:00 CT",
      ageMin: 40,
      clockPinned: false,
      quality: "auth",
    }
    const feeds = reportFeeds(reading, "LIVE", null, "live", { ingestQuality: "auth" })
    expect(states(feeds)).toEqual(["auth", "auth"])
    expect(feeds.holdOnFail).toBe("holding")
    expect(feeds.holdingSpare).toBe(true)
    expect(feeds.quality.label).toBe("Auth error")
    expect(feeds.rows[0]?.lastSuccess).toBe("none")
    expect(feeds.rows[0]?.asOf).toBe("11:00 CT · 40 min")
    expect(joined(feeds)).not.toContain("named fail")
    expect(joined(feeds)).not.toMatch(/\bauth\b/)
  })

  it("binds a later live failure to last success from ingest", () => {
    const reading: StressReading = {
      outageMw: 21000,
      thresholdMw: null,
      marginMw: null,
      zone: "Houston",
      zoneMw: 3000,
      asOfLabel: "14:00 CT",
      ageMin: 12,
      clockPinned: false,
      quality: "timeout",
    }
    const feeds = reportFeeds(reading, "LIVE", UNTRUSTED_REPORT, "live", {
      ingestQuality: "timeout",
      lastOkAsOf: "14:00 CT",
    })
    expect(states(feeds)).toEqual(["hold", "hold"])
    expect(feeds.rows[0]?.lastSuccess).toBe("14:00 CT")
    expect(feeds.holdingSpare).toBe(true)
  })

  it("leaves a passed live pull clear", () => {
    const reading: StressReading = {
      outageMw: 21000,
      thresholdMw: null,
      marginMw: null,
      zone: "Houston",
      zoneMw: 3000,
      asOfLabel: "14:00 CT",
      ageMin: 12,
      clockPinned: false,
      quality: "ok",
    }
    const feeds = reportFeeds(reading, "LIVE", null, "live", { ingestQuality: "ok", lastOkAsOf: "14:00 CT" })
    expect(feeds.rows[0]).toMatchObject({
      lz: "Houston",
      lastSuccess: "14:00 CT",
      state: "live",
    })
    expect(feeds.holdOnFail).toBe("clear")
    expect(feeds.badPull).toBe(false)
  })

  it("keeps a stale posting's time as the last success", () => {
    const reading: StressReading = {
      outageMw: null,
      thresholdMw: null,
      marginMw: null,
      zone: null,
      zoneMw: null,
      asOfLabel: "09:00 CT",
      ageMin: 120,
      clockPinned: false,
      quality: "stale",
    }
    const feeds = reportFeeds(reading, "LIVE", UNTRUSTED_REPORT, "live", { ingestQuality: "stale" })
    expect(states(feeds)).toEqual(["stale", "stale"])
    expect(feeds.rows[0]?.lastSuccess).toBe("09:00 CT")
    expect(feeds.holdOnFail).toBe("holding")
  })

  it("does not treat operator Hold as a bad report", () => {
    const tick = tapeTick(8)
    const reading = stressReading(tick)
    const banner = fleetIntent(tick, "ok", outageLine(reading)).line
    const feeds = reportFeeds(reading, "SYNTHETIC", banner)
    expect(banner).toBe("Hold. Discharge stays at zero until Auto.")
    expect(feeds.holdOnFail).toBe("clear")
    expect(states(feeds)).toEqual(["live", "live"])
  })

  it("does not treat a pinned auth overlay as a live bad pull", () => {
    const reading: StressReading = {
      outageMw: 22194,
      thresholdMw: 22348,
      marginMw: -154,
      zone: "North",
      zoneMw: 9429,
      asOfLabel: "12:00 CT",
      ageMin: 0,
      clockPinned: true,
      quality: "auth",
    }
    const feeds = reportFeeds(reading, "SYNTHETIC", null)
    expect(feeds.holdOnFail).toBe("clear")
    expect(states(feeds)).toEqual(["live", "live"])
    expect(feeds.rows[0]?.lastSuccess).toBe("12:00 CT")
  })

  it("uses a backend feeds list as written", () => {
    const supplied: FeedRow[] = [
      { product: "NP3-233-CD outage", lz: "Houston", asOf: "13:00 CT", lastSuccess: "13:00 CT", state: "stale" },
      { product: "NP6-905-CD price", lz: "LZ_NORTH", asOf: "13:15 CT", lastSuccess: "13:15 CT", state: "live" },
    ]
    const reading = stressReading(tapeTick(1))
    const feeds = reportFeeds(reading, "LIVE", null, "live", { supplied })
    expect(feeds.rows).toEqual(supplied)
    expect(feeds.quality.label).toBe("Stale")
    expect(feeds.holdingSpare).toBe(true)
    expect(readSuppliedFeeds(supplied)).toEqual(supplied)
    expect(readSuppliedFeeds({ product: "nope" })).toBeNull()
  })

  it("adds holding spare energy without a raw report dump", () => {
    expect(feedReasons(["homes_dead:2"], true)).toEqual(["holding_spare_energy", "homes_dead:2"])
    expect(feedReasons(["signal_unavailable"], true)).toEqual(["holding_spare_energy"])
    expect(feedReasons(["operator_hold"], false)).toEqual(["operator_hold"])
  })
})
