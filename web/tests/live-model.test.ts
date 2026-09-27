// Task 9 part 2: the Live page's pure model. Every label must be true against the real API replies.
import { describe, expect, it } from "vitest"
import {
  REPLAY_WINDOW_SECONDS, engineZone, engineZoneOrder, fleetSizeFrom, flowHomeFromRow, homesFromReply, inputRows, livePill,
  liveStatus, liveTick, liveZones, ordersForTick, ordersFromReply, placeHomes, provenanceLines, replayDone, replayT,
  runFleetSize, settingsFromRun, snapshotFromReply, tickTiming, ZONE_NOTE,
  type LiveStatus, type OrdersState, type SnapshotState,
} from "../src/features/live/liveModel"
import {
  archiveSnapshot, homesHeaders, homesRows, liveOrders, liveSnapshot, NOW_1221, oldRun10k, oldSnapshot10k, rollups, runLatest,
} from "./fixtures/live"

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })
const ready = (value: Record<string, unknown>): SnapshotState => ({ kind: "ready", value })
const settings = settingsFromRun(runLatest)
const LIVE: LiveStatus = { kind: "live" }

describe("snapshot and orders replies", () => {
  it("keeps a 200 snapshot and turns a failure into the server's brief", () => {
    expect(snapshotFromReply(200, liveSnapshot)).toEqual({ kind: "ready", value: liveSnapshot })
    expect(snapshotFromReply(404, { error: "no_run", brief: "No run file is available." }))
      .toEqual({ kind: "error", brief: "http 404: No run file is available." })
    expect(snapshotFromReply(200, [1, 2])).toEqual({ kind: "error", brief: "the snapshot reply was not an object" })
  })

  it("treats a 404 on /v1/live/orders as no orders yet, with the server's brief", () => {
    expect(ordersFromReply(404, { error: "no_tick_orders", brief: "No tick has written its orders yet." }))
      .toEqual({ kind: "none", brief: "No tick has written its orders yet." })
    // The same 404 for a read that collided with a write.
    expect(ordersFromReply(404, { error: "no_tick_orders", brief: "The tick orders file could not be read." }))
      .toEqual({ kind: "none", brief: "The tick orders file could not be read." })
    expect(ordersFromReply(404, null)).toEqual({ kind: "none", brief: "No tick has written its orders yet." })
    expect(ordersFromReply(500, { brief: "boom" })).toEqual({ kind: "error", brief: "http 500: boom" })
  })

  it("keeps the logged timelines exactly and drops malformed entries", () => {
    const got = ordersFromReply(200, { ...liveOrders, orders: { ...liveOrders.orders, "home-009": "nope", "home-010": [["x", "sent"]] } })
    expect(got).toEqual({ kind: "ready", tick: 1, ts: liveOrders.ts, orders: liveOrders.orders })
    expect(ordersFromReply(200, { tick: 1 })).toEqual({ kind: "error", brief: "the orders reply had no orders" })
  })
})

describe("the run's own settings (GET /v1/runs/latest)", () => {
  it("reads tick length, base floor and fleet size from the run, never a default", () => {
    expect(settings).toEqual({ tickMinutes: 5, baseFloorPct: 30, fleetSize: 100 })
    expect(settingsFromRun({ settings: {} })).toEqual({ tickMinutes: undefined, baseFloorPct: undefined, fleetSize: undefined })
    expect(settingsFromRun(null)).toEqual({ tickMinutes: undefined, baseFloorPct: undefined, fleetSize: undefined })
  })

  it("falls back to the scoreboard's tick_minutes when settings omit it", () => {
    expect(settingsFromRun({ settings: {}, totals: { tick_minutes: 15 } }).tickMinutes).toBe(15)
  })

  it("takes the run's fleet from its settings, then the tick's own home counts", () => {
    expect(runFleetSize(settings, liveSnapshot)).toBe(100)
    expect(runFleetSize(settingsFromRun(oldRun10k), liveSnapshot)).toBe(10000)
    expect(runFleetSize({}, oldSnapshot10k)).toBe(10000)
    expect(runFleetSize({}, { live_homes: 100 })).toBeNull()
    expect(runFleetSize({}, null)).toBeNull()
  })
})

describe("is this live?", () => {
  const status = (snapshot: SnapshotState, run = settings, demo: number | null = 100, now = NOW_1221) =>
    liveStatus(snapshot, run, demo, now)

  it("a fresh live run of the demo fleet is live", () => {
    expect(status(ready(liveSnapshot))).toEqual({ kind: "live" })
  })

  it("passes loading and snapshot errors through", () => {
    expect(status({ kind: "loading" })).toEqual({ kind: "loading" })
    expect(status({ kind: "error", brief: "http 404: No run file is available." }))
      .toEqual({ kind: "error", brief: "http 404: No run file is available." })
  })

  it("an old 10,000-home run is not live, and never says 10,000", () => {
    const got = status(ready(liveSnapshot), settingsFromRun(oldRun10k))
    expect(got).toMatchObject({ kind: "not_live", reason: "The newest run is from before the 100-home demo fleet, so it is not shown." })
    expect(JSON.stringify(got)).not.toMatch(/10,?000/)
    const noSettings = status(ready(oldSnapshot10k), {})
    expect(noSettings.kind).toBe("not_live")
    expect(JSON.stringify(noSettings)).not.toMatch(/10,?000|9,?800/)
  })

  it("a smaller run than the demo fleet is not live either", () => {
    expect(status(ready(liveSnapshot), { ...settings, fleetSize: 37 }))
      .toMatchObject({ kind: "not_live", reason: "The newest run did not use the 100-home demo fleet, so it is not shown." })
  })

  it("says the worker looks stopped when no tick came for two tick lengths", () => {
    const later = Date.parse("2026-09-27T17:31:00Z")
    expect(status(ready(liveSnapshot), settings, 100, later)).toEqual({
      kind: "not_live",
      pill: "Not live, last tick 11 min ago",
      reason: "No new tick since 12:20 CT, so the live worker looks stopped. It runs only when someone starts it.",
    })
  })

  it("never judges staleness without the run's tick length", () => {
    const later = Date.parse("2026-09-27T19:00:00Z")
    expect(status(ready(liveSnapshot), { tickMinutes: undefined, fleetSize: 100 }, 100, later)).toEqual({ kind: "live" })
  })

  it("an archive, scenario or sample snapshot is not live", () => {
    expect(status(ready(archiveSnapshot))).toEqual({
      kind: "not_live",
      pill: "ERCOT archive (tuning-2026), not live",
      reason: "The newest run replays the tuning-2026 archive, not live ERCOT.",
    })
    expect(status(ready({ ...archiveSnapshot, source: "scenario" }))).toMatchObject({ pill: "Scenario run, not live ERCOT" })
    expect(status(ready({ ...archiveSnapshot, source: "fixture" }))).toMatchObject({ pill: "Sample data, not live ERCOT" })
    expect(status(ready({ ...archiveSnapshot, source: undefined }))).toMatchObject({ pill: "Source not reported, not live" })
  })
})

describe("the top-right pill", () => {
  it("says live only when live, with minutes since the tick", () => {
    expect(livePill(LIVE, liveSnapshot, NOW_1221)).toEqual({ text: "Live from ERCOT, updated 1 min ago", live: true })
    expect(livePill(LIVE, liveSnapshot, Date.parse("2026-09-27T17:20:30Z")).text).toBe("Live from ERCOT, updated under a minute ago")
    expect(livePill(LIVE, { ...liveSnapshot, ts: undefined }, NOW_1221).text).toBe("Live from ERCOT, update time not reported")
  })

  it("never calls anything else live", () => {
    expect(livePill({ kind: "not_live", pill: "ERCOT archive (tuning-2026), not live", reason: "x" }, archiveSnapshot, NOW_1221))
      .toEqual({ text: "ERCOT archive (tuning-2026), not live", live: false })
    expect(livePill({ kind: "loading" }, null, NOW_1221).text).toBe("Reading the ERCOT snapshot")
    expect(livePill({ kind: "error", brief: "x" }, null, NOW_1221)).toEqual({ text: "ERCOT snapshot unavailable", live: false })
  })
})

describe("what ERCOT is telling us", () => {
  it("reads price, plants offline, stress line, margin and data check from the snapshot", () => {
    const rows = inputRows(liveSnapshot)
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Wholesale price", "$185"],
      ["Power plants offline", "22,539 MW"],
      ["Stress line", "22,348 MW"],
      ["Over the line by", "191 MW"],
      ["Data check", "Passed"],
    ])
    expect(rows[0].unit).toBe("/MWh")
    expect(rows[3].tone).toBe("warn")
    expect(rows[4].tone).toBe("ok")
  })

  it("says under the line when the margin is negative", () => {
    const margin = inputRows(archiveSnapshot)[3]
    expect([margin.label, margin.value, margin.tone]).toEqual(["Under the line by", "1,184 MW", undefined])
  })

  it("shows Not reported for every missing field, never a 0", () => {
    const rows = inputRows({})
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Wholesale price", "Not reported"],
      ["Power plants offline", "Not reported"],
      ["Stress line", "Not reported"],
      ["Margin to the line", "Not reported"],
      ["Data check", "Not reported"],
    ])
    expect(rows[0].unit).toBeUndefined()
    expect(inputRows({ price_usd_mwh: null }).at(0)?.value).toBe("Not reported")
  })

  it("names a failed data check by its quality code", () => {
    const check = inputRows({ quality: "stale" })[4]
    expect([check.value, check.tone]).toEqual(["Failed: stale", "bad"])
  })

  it("labels what is real and what is simulated, from the data", () => {
    expect(provenanceLines(liveSnapshot, 100)).toEqual([
      "These are live ERCOT inputs.",
      "The 100-home demo fleet and its orders are simulated. The target is a practice number (synthetic).",
    ])
    expect(provenanceLines(archiveSnapshot, null)).toEqual([
      "These ERCOT inputs come from the tuning-2026 archive, not live.",
      "The demo fleet and its orders are simulated. The target is a practice number (synthetic).",
    ])
    expect(provenanceLines({ ...liveSnapshot, target_label: "ercot", price_label: "tape:beryl" }, 37)[1])
      .toBe("The 37-home demo fleet and its orders are simulated. The price is labeled tape:beryl.")
  })

  it("adds no JEV text anywhere", () => {
    const text = JSON.stringify([inputRows(liveSnapshot), provenanceLines(liveSnapshot, 100), ZONE_NOTE])
    expect(text).not.toMatch(/JEV/i)
  })
})

describe("tick timing", () => {
  it("names the last tick in Central time and counts down to the next from tick_minutes", () => {
    expect(tickTiming(liveSnapshot, settings, NOW_1221)).toBe("Last tick ran at 12:20 CT. Next tick in 3:40.")
  })

  it("never assumes a tick length", () => {
    expect(tickTiming(liveSnapshot, { tickMinutes: undefined }, NOW_1221)).toBe("Last tick ran at 12:20 CT. Next tick: Not reported.")
  })

  it("says so when the next tick is overdue", () => {
    const late = Date.parse("2026-09-27T17:31:00Z")
    expect(tickTiming(liveSnapshot, settings, late)).toBe("Last tick ran at 12:20 CT. Next tick was due at 12:25 CT and has not arrived.")
  })

  it("adds the day when the last tick was on another day", () => {
    const nextDay = Date.parse("2026-09-28T15:00:00Z")
    expect(tickTiming(liveSnapshot, settings, nextDay)).toBe("Last tick ran at Sep 27, 12:20 CT. Next tick was due at Sep 27, 12:25 CT and has not arrived.")
  })

  it("an archive tick is stamped with its archive clock and gets no countdown", () => {
    expect(tickTiming(archiveSnapshot, settings, NOW_1221))
      .toBe("Newest tick is stamped Sep 25, 12:00 CT (archive clock). Next tick: Not reported, this is not a live run.")
  })

  it("a missing tick time is Not reported", () => {
    expect(tickTiming({ ...liveSnapshot, ts: undefined }, settings, NOW_1221)).toBe("Last tick time: Not reported.")
    expect(tickTiming(null, settings, NOW_1221)).toBe("Last tick time: Not reported.")
  })
})

describe("snapshot into Replay props", () => {
  it("copies the tick's own fields and leaves missing ones out", () => {
    const tick = liveTick(liveSnapshot)
    expect(tick.target_mw).toBe(0.4)
    expect(tick.delivered_mw).toBe(0.4)
    expect(tick.intent).toBe("discharge")
    expect(tick.intent_reason).toBe("grid_call")
    expect(tick.zone_reserve_pct).toEqual(liveSnapshot.zone_reserve_pct)
    expect(tick.reasons).toEqual(liveSnapshot.reasons)
    expect("unconfirmed_mw" in tick).toBe(false)
    expect("charging_mw" in tick).toBe(false)
    expect(liveTick({ target_mw: "lots", breaches: null })).toEqual({})
  })

  it("builds zone rows from the snapshot's own zone fields only", () => {
    const zones = liveZones(archiveSnapshot)
    expect(zones.Houston).toEqual({ reserve_pct: 60, reason: "storm_risk_high", grid_down: false })
    expect(liveZones({})).toEqual({})
  })
})

describe("homes from GET /v1/homes", () => {
  it("maps a row into the Replay home shape with the engine's state words", () => {
    const [sell, below, charge, stale, atFloor, missing] = homesRows.map(flowHomeFromRow)
    expect(sell).toMatchObject({ id: "home-001", zone: "South", soc_pct: 70, floor_pct: 60, kw: 2.5, state: "selling", status: "live", county_name: "Nueces" })
    expect(below?.state).toBe("below_floor")
    expect(charge?.state).toBe("charging")
    expect(stale?.state).toBe("stale")
    expect(atFloor?.state).toBe("at_floor")
    expect(missing?.state).toBe("holding")
    expect(Number.isNaN(missing?.soc_pct)).toBe(true)
    expect(flowHomeFromRow({ status: "live" })).toBeNull()
  })

  it("labels the fleet from the headers", () => {
    const got = homesFromReply(homesRows, headers(homesHeaders))
    expect(got.homes).toHaveLength(6)
    expect(got.fleetSize).toBe(100)
    expect(got.note).toBe("100-home demo fleet. Live fleet from Supabase: 100 of 100 homes.")
    const sample = homesFromReply(homesRows.slice(0, 3), headers({ "x-homes-source": "fixture" }))
    expect(sample.note).toBe("3 sample rows (no Supabase connection), not live data.")
  })

  it("takes the fleet size from the headers, then the rollups, never a constant", () => {
    expect(fleetSizeFrom(100, rollups)).toBe(100)
    expect(fleetSizeFrom(null, { ...rollups, n: 37 })).toBe(37)
    expect(fleetSizeFrom(null, null)).toBeNull()
    expect(fleetSizeFrom(null, { n: "x" })).toBeNull()
  })
})

describe("homes in the engine's zones", () => {
  it("reads the engine's zone order from the snapshot's own per-zone floors", () => {
    expect(engineZoneOrder(liveSnapshot)).toEqual(["Houston", "North", "South", "West"])
    expect(engineZoneOrder({ zone_reasons: { West: "normal", South: "normal" } })).toEqual(["West", "South"])
    expect(engineZoneOrder({})).toEqual([])
    expect(engineZoneOrder(null)).toEqual([])
  })

  it("follows fleet.assign_zone: home number i takes zone (i - 1) mod the zone count", () => {
    const order = ["Houston", "North", "South", "West"]
    expect(["home-001", "home-002", "home-003", "home-004", "home-005", "home-100"].map((id) => engineZone(id, order)))
      .toEqual(["Houston", "North", "South", "West", "Houston", "West"])
    expect(engineZone("home-abc", order)).toBeNull()
    expect(engineZone("home-000", order)).toBeNull()
    expect(engineZone("home-001", [])).toBeNull()
  })

  it("moves each home to its engine zone and takes that zone's floor from the snapshot", () => {
    const rows = homesFromReply(homesRows, headers(homesHeaders)).homes
    const placed = placeHomes(rows, { ...liveSnapshot, zone_reserve_pct: { Houston: 60, North: 30, South: 30, West: 30 } })
    const one = placed.find((home) => home.id === "home-001")
    // home-001 is South in public.homes and Houston in every engine output.
    expect(one).toMatchObject({ zone: "Houston", floor_pct: 60, soc_pct: 70, state: "selling" })
    expect(one?.county).toBeUndefined()
    expect(one?.county_name).toBeUndefined()
    expect(placed.find((home) => home.id === "home-002")).toMatchObject({ zone: "North", floor_pct: 30 })
    // home-005 sat at its 30% South floor in the table; in Houston (60%) it is below the floor.
    expect(placed.find((home) => home.id === "home-005")).toMatchObject({ zone: "Houston", floor_pct: 60, state: "below_floor" })
  })

  it("places no home when the engine's zone order is not reported", () => {
    const rows = homesFromReply(homesRows, headers(homesHeaders)).homes
    expect(placeHomes(rows, {})).toEqual([])
  })

  it("the note says zones can differ from the Fleet page", () => {
    expect(ZONE_NOTE).toBe("Homes sit in the engine's zones, which can differ from the Fleet page. Charge levels are the Fleet table's.")
  })
})

describe("orders against the tick on screen", () => {
  const readyOrders = ordersFromReply(200, liveOrders) as Extract<OrdersState, { kind: "ready" }>

  it("shows orders written for the snapshot's own tick", () => {
    const got = ordersForTick(readyOrders, liveSnapshot)
    expect(got.orders).toEqual(liveOrders.orders)
    expect(got.canReplay).toBe(true)
    expect(got.note).toBe("Live shows the newest tick. Replay it to watch its orders move.")
  })

  it("never shows another tick's orders as this tick's", () => {
    const got = ordersForTick(readyOrders, archiveSnapshot)
    expect(got.orders).toBeUndefined()
    expect(got.canReplay).toBe(false)
    expect(got.note).toBe("The orders on file are from the tick at Sep 27, 12:20 CT, not the tick shown here.")
  })

  it("says plainly when no orders are on file yet", () => {
    const got = ordersForTick({ kind: "none", brief: "No tick has written its orders yet." }, liveSnapshot)
    expect(got.orders).toBeUndefined()
    expect(got.canReplay).toBe(false)
    expect(got.note).toBe("No orders to replay yet. No tick has written its orders yet.")
    expect(got.note).not.toMatch(/\b0 orders\b/)
    expect(ordersForTick({ kind: "loading" }, liveSnapshot).note).toBe("Reading this tick's orders.")
    expect(ordersForTick({ kind: "error", brief: "http 500" }, liveSnapshot).note).toBe("Could not read this tick's orders: http 500.")
  })

  it("an orders file with no tick time cannot be matched", () => {
    const got = ordersForTick({ ...readyOrders, ts: null }, liveSnapshot)
    expect(got.orders).toBeUndefined()
    expect(got.note).toBe("The orders on file do not say which tick they are from, so they are not shown.")
  })
})

describe("Replay this tick", () => {
  it("shows the final state (2:05) while not replaying", () => {
    expect(replayT(null, NOW_1221)).toBe(125)
  })

  it("plays the order window in about 25 s, then holds at 2:00", () => {
    expect(REPLAY_WINDOW_SECONDS).toBe(25)
    const start = 1_000_000
    expect(replayT(start, start)).toBe(0)
    expect(replayT(start, start + 12_500)).toBeCloseTo(62.5)
    expect(replayT(start, start + 24_000)).toBe(120)
    expect(replayT(start, start + 60_000)).toBe(120)
    expect(replayDone(start, start + 10_000)).toBe(false)
    expect(replayDone(start, start + 24_000)).toBe(true)
  })
})
