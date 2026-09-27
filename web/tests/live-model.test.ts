// Task 9 part 2: the Live page's pure model. Every label must be true against the real API replies.
import { describe, expect, it } from "vitest"
import {
  REPLAY_WINDOW_SECONDS, fleetSizeFrom, flowHomeFromRow, homesFromReply, homesWarning, inputRows, livePill, liveStatus,
  liveTick, liveZones, meaningLine, nextRun, ordersForTick, ordersFromReply, replayDone, replayT, runFromReply,
  settingsFromRun, simulatedLine, snapshotFromReply, tickHomes, tickTiming,
  type HomesState, type LiveStatus, type OrdersState, type RunState, type SnapshotState,
} from "../src/features/live/liveModel"
import {
  archiveSnapshot, homesHeaders, homesRows, liveOrders, liveSnapshot, NOW_1221, oldRun10k, rollups, runLatest,
  tableRunNoSettings,
} from "./fixtures/live"

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })
const ready = (value: Record<string, unknown>): SnapshotState => ({ kind: "ready", value })
const settings = settingsFromRun(runLatest)
const run = runFromReply(200, runLatest)
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

describe("the run (GET /v1/runs/latest)", () => {
  it("reads tick length, base floor and fleet size from the run's settings, never a default", () => {
    expect(settings).toEqual({ tickMinutes: 5, baseFloorPct: 30, fleetSize: 100 })
    expect(settingsFromRun({ settings: {} })).toEqual({ tickMinutes: undefined, baseFloorPct: undefined, fleetSize: undefined })
    expect(settingsFromRun(null)).toEqual({ tickMinutes: undefined, baseFloorPct: undefined, fleetSize: undefined })
    expect(settingsFromRun({ settings: {}, totals: { tick_minutes: 15 } }).tickMinutes).toBe(15)
  })

  it("keeps the run id and its newest tick's time, to match the snapshot to the same run", () => {
    expect(run).toEqual({ kind: "ready", settings, runId: runLatest.run_id, lastTs: "2026-09-27T12:20:00-05:00" })
    expect(runFromReply(404, { brief: "No run file is available." })).toEqual({ kind: "error", brief: "http 404: No run file is available." })
  })

  it("a failed poll keeps the last good run, and never switches the guards off", () => {
    const failed: RunState = { kind: "error", brief: "http 502" }
    expect(nextRun(run, failed)).toBe(run)
    expect(nextRun({ kind: "loading" }, failed)).toEqual(failed)
    expect(nextRun(run, runFromReply(200, oldRun10k))).toMatchObject({ settings: { fleetSize: 10000 } })
  })
})

describe("is this live?", () => {
  const status = (snapshot: SnapshotState, r: RunState = run, demo: number | null = 100, now = NOW_1221) =>
    liveStatus(snapshot, r, demo, now)

  it("a fresh live run of the demo fleet, matched to its own run file, is live", () => {
    expect(status(ready(liveSnapshot))).toEqual({ kind: "live" })
  })

  it("passes loading and snapshot errors through, and waits for the run", () => {
    expect(status({ kind: "loading" })).toEqual({ kind: "loading" })
    expect(status({ kind: "error", brief: "http 404: No run file is available." }))
      .toEqual({ kind: "error", brief: "http 404: No run file is available." })
    expect(status(ready(liveSnapshot), { kind: "loading" })).toEqual({ kind: "loading" })
  })

  it("an unread run file is not live", () => {
    expect(status(ready(liveSnapshot), { kind: "error", brief: "http 502" })).toEqual({
      kind: "not_live", pill: "Not live, run not checked", reason: "The run file could not be read (http 502), so this tick cannot be checked.",
    })
  })

  it("an old 10,000-home run is not live, and never says 10,000", () => {
    const got = status(ready(liveSnapshot), runFromReply(200, oldRun10k))
    expect(got).toMatchObject({ kind: "not_live", reason: "The newest run is from before the 100-home demo fleet, so it is not shown." })
    expect(JSON.stringify(got)).not.toMatch(/10,?000/)
  })

  it("a table row with no settings (persisted before 9c, rescaled to 100 by the snapshot) is not live", () => {
    const got = status(ready(liveSnapshot), runFromReply(200, tableRunNoSettings))
    expect(got).toEqual({
      kind: "not_live",
      pill: "Not live, run not checked",
      reason: "The run does not report its fleet size, so it cannot be checked against the 100-home demo fleet.",
    })
  })

  it("an unknown demo fleet size is not live", () => {
    expect(status(ready(liveSnapshot), run, null)).toMatchObject({
      kind: "not_live", reason: "The demo fleet size is not reported, so the run cannot be checked against it.",
    })
  })

  it("a smaller run than the demo fleet is not live either", () => {
    const small = runFromReply(200, { ...runLatest, settings: { ...runLatest.settings, fleet_size: 37 } })
    expect(status(ready(liveSnapshot), small))
      .toMatchObject({ kind: "not_live", reason: "The newest run did not use the 100-home demo fleet, so it is not shown." })
  })

  it("an unknown tick length is not live: freshness cannot be checked", () => {
    const noLength = runFromReply(200, { ...runLatest, settings: { fleet_size: 100 }, totals: {} })
    expect(status(ready(liveSnapshot), noLength)).toMatchObject({
      kind: "not_live", reason: "The run does not report its tick length, so freshness cannot be checked.",
    })
  })

  it("a snapshot that is not the run file's newest tick is not live", () => {
    const other = runFromReply(200, { ...runLatest, ticks: [{ tick: 2, ts: "2026-09-27T12:25:00-05:00" }] })
    expect(status(ready(liveSnapshot), other)).toMatchObject({
      kind: "not_live", reason: "The snapshot and the run file do not name the same newest tick, so it is not shown as live.",
    })
    expect(status(ready(liveSnapshot), runFromReply(200, { ...runLatest, ticks: [] })).kind).toBe("not_live")
  })

  it("says the worker looks stopped when no tick came for two tick lengths", () => {
    const later = Date.parse("2026-09-27T17:31:00Z")
    expect(status(ready(liveSnapshot), run, 100, later)).toEqual({
      kind: "not_live",
      pill: "Not live, last tick 11 min ago",
      reason: "No new tick since 12:20 CT, so the live worker looks stopped or asleep.",
    })
    // Within the worker's normal lag (one extra tick length) it is still live.
    expect(status(ready(liveSnapshot), run, 100, Date.parse("2026-09-27T17:29:00Z"))).toEqual({ kind: "live" })
  })

  it("a fresh matching tick whose ERCOT data check failed is not live, and names the failed check", () => {
    expect(status(ready({ ...liveSnapshot, quality: "auth" }))).toEqual({
      kind: "not_live",
      pill: "Live tick, ERCOT data check failed",
      reason: "The newest tick's ERCOT data check failed (auth), so it is not shown as live.",
    })
    expect(status(ready({ ...liveSnapshot, quality: "stale_feed" }))).toMatchObject({
      kind: "not_live", reason: "The newest tick's ERCOT data check failed (stale feed), so it is not shown as live.",
    })
    expect(status(ready({ ...liveSnapshot, quality: undefined }))).toEqual({
      kind: "not_live",
      pill: "Not live, run not checked",
      reason: "The newest tick does not report its ERCOT data check, so it is not shown as live.",
    })
    // A stale tick still says the worker looks stopped first, whatever its check said.
    expect(status(ready({ ...liveSnapshot, quality: "auth" }), run, 100, Date.parse("2026-09-27T17:31:00Z")))
      .toMatchObject({ pill: "Not live, last tick 11 min ago" })
  })

  it("an archive, scenario or sample snapshot is not live", () => {
    const archiveRun = runFromReply(200, { ...runLatest, ticks: [{ ts: archiveSnapshot.ts }] })
    expect(status(ready(archiveSnapshot), archiveRun)).toEqual({
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

  it("says what is simulated, from the data", () => {
    expect(simulatedLine(liveSnapshot, 100)).toBe("The 100-home demo fleet and its orders are simulated. The target is a practice number (synthetic).")
    expect(simulatedLine({ ...liveSnapshot, target_label: "ercot", price_label: "tape:beryl" }, null))
      .toBe("The demo fleet and its orders are simulated. The price is labeled tape:beryl.")
  })

  it("gives the mockup's meaning sentence only when the fields support every word", () => {
    const storm = { ...liveSnapshot, margin_mw: 191, policy_reason: "storm_risk_high", reserve_pct: 60, zone_reserve_pct: { Houston: 60, North: 60, South: 60, West: 60 } }
    expect(meaningLine(storm)).toBe("Offline plants are over the stress line, so every home keeps 60% for backup.")
    const calm = { ...storm, margin_mw: -3049.4, policy_reason: "normal", reserve_pct: 30, zone_reserve_pct: { Houston: 30, North: 30, South: 30, West: 30 } }
    expect(meaningLine(calm)).toBe("Offline plants are under the stress line, so every home keeps the usual 30% for backup.")
    // A zone raised by a weather alert: "every home" would be false.
    expect(meaningLine({ ...calm, zone_reserve_pct: { ...calm.zone_reserve_pct, Houston: 60 } })).toBeNull()
    expect(meaningLine({ ...calm, county_reserve_pct: { 48201: 60 } })).toBeNull()
    // Over the line but the floor did not rise (for example a missing signal): no sentence.
    expect(meaningLine({ ...storm, policy_reason: "signal_unavailable" })).toBeNull()
    expect(meaningLine({ ...storm, margin_mw: undefined })).toBeNull()
    expect(meaningLine({ ...storm, zone_reserve_pct: undefined })).toBeNull()
  })

  it("adds no JEV text anywhere", () => {
    const text = JSON.stringify([inputRows(liveSnapshot), simulatedLine(liveSnapshot, 100), meaningLine(liveSnapshot)])
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

  it("allows one tick length of grace: the worker sleeps a whole tick after each cycle", () => {
    expect(tickTiming(liveSnapshot, settings, Date.parse("2026-09-27T17:25:00Z"))).toBe("Last tick ran at 12:20 CT. Next tick due now.")
    expect(tickTiming(liveSnapshot, settings, Date.parse("2026-09-27T17:29:59Z"))).toBe("Last tick ran at 12:20 CT. Next tick due now.")
    expect(tickTiming(liveSnapshot, settings, Date.parse("2026-09-27T17:31:00Z")))
      .toBe("Last tick ran at 12:20 CT. Next tick was due at 12:25 CT and has not arrived.")
  })

  it("adds the day when the last tick was on another day", () => {
    const nextDay = Date.parse("2026-09-28T15:00:00Z")
    expect(tickTiming(liveSnapshot, settings, nextDay)).toBe("Last tick ran at Sep 27, 12:20 CT. Next tick was due at Sep 27, 12:25 CT and has not arrived.")
  })

  it("an archive tick is stamped with its archive clock and gets no countdown", () => {
    expect(tickTiming(archiveSnapshot, settings, NOW_1221))
      .toBe("Newest tick is stamped Sep 25, 12:00 CT (archive clock). Next tick: Not reported, this is not a live run.")
  })

  it("only an archive tick is called an archive clock; a scenario or sample tick is not", () => {
    for (const source of ["scenario", "fixture", undefined]) {
      expect(tickTiming({ ...archiveSnapshot, source }, settings, NOW_1221))
        .toBe("Newest tick is stamped Sep 25, 12:00 CT. Next tick: Not reported, this is not a live run.")
    }
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
    expect(liveTick({ ...liveSnapshot, charging_mw: 0.12 }).charging_mw).toBe(0.12)
    expect(liveTick({ target_mw: "lots", breaches: null })).toEqual({})
  })

  it("builds zone rows from the snapshot's own zone fields only", () => {
    const zones = liveZones(archiveSnapshot)
    expect(zones.Houston).toEqual({ reserve_pct: 60, reason: "storm_risk_high", grid_down: false })
    expect(liveZones({})).toEqual({})
  })
})

describe("homes from GET /v1/homes", () => {
  it("takes who and where from the row: id, the engine's name, zone and county", () => {
    const one = flowHomeFromRow(homesRows[0])
    expect(one).toMatchObject({ id: "home-001", name: "Houston-Harris-001", zone: "Houston", county: "48201", county_name: "Harris" })
    expect(flowHomeFromRow(homesRows[5])?.name).toBeUndefined()
    expect(flowHomeFromRow({ status: "live" })).toBeNull()
  })

  it("never reads the table's stale charge, power or status", () => {
    for (const home of homesRows.map(flowHomeFromRow)) {
      expect(Number.isNaN(home?.soc_pct)).toBe(true)
      expect(Number.isNaN(home?.kw)).toBe(true)
      expect(home?.status).toBe("")
    }
  })

  it("places homes by the zone /v1/homes reports (the engine's, after Task 17)", () => {
    const placed = homesFromReply(homesRows, headers(homesHeaders)).homes
    expect(placed.filter((home) => home.zone === "Houston").map((home) => home.id)).toEqual(["home-001", "home-005"])
  })

  it("the state comes from this tick's orders, the floor from the snapshot (county, then zone, then fleet)", () => {
    const rows = homesFromReply(homesRows, headers(homesHeaders)).homes
    const snap = { ...liveSnapshot, reserve_pct: 30, zone_reserve_pct: { Houston: 30, North: 60 }, county_reserve_pct: { 48157: 60 } }
    const orders = (ordersFromReply(200, liveOrders) as Extract<OrdersState, { kind: "ready" }>).orders
    const got = Object.fromEntries(tickHomes(rows, snap, orders).map((home) => [home.id, home]))
    expect(got["home-001"]).toMatchObject({ state: "selling", floor_pct: 30 })
    expect(got["home-002"]).toMatchObject({ state: "selling", floor_pct: 60 })
    expect(got["home-003"]).toMatchObject({ state: "charging", floor_pct: 30 })
    // The table says home-005 gives 3.3 kW; it had no order this tick, so it holds. Its county floor wins.
    expect(got["home-005"]).toMatchObject({ state: "holding", floor_pct: 60 })
    expect(got["home-004"]).toMatchObject({ state: "holding", floor_pct: 30 })
    expect(Number.isNaN(tickHomes(rows, {}, undefined)[0].floor_pct)).toBe(true)
  })

  it("says nothing about a full live table; warns on an error, sample rows or partial rows", () => {
    const full: HomesState = { kind: "ready", ...homesFromReply(homesRows, headers(homesHeaders)) }
    expect(full.kind === "ready" && full.rows).toBe(6)
    // Six fixture rows stand in for a page of 100: a real full page has 100 rows.
    const fullPage: HomesState = { ...full, rows: 100 } as HomesState
    expect(homesWarning(fullPage)).toBeNull()
    expect(homesWarning(full)).toBe("100-home demo fleet. Live fleet from Supabase: 100 of 100 homes.")
    expect(homesWarning({ ...fullPage, total: 80 } as HomesState)).toBe("100-home demo fleet. Live fleet from Supabase: 100 of 100 homes.")
    expect(homesWarning({ kind: "ready", ...homesFromReply(homesRows.slice(0, 3), headers({ "x-homes-source": "fixture" })) }))
      .toBe("3 sample rows (no Supabase connection), not live data.")
    expect(homesWarning({ kind: "error", brief: "http 500: boom" })).toBe("Could not read the homes: http 500: boom.")
    expect(homesWarning({ kind: "loading" })).toBeNull()
  })

  it("takes the fleet size from the headers, then the rollups, never a constant", () => {
    expect(fleetSizeFrom(100, rollups)).toBe(100)
    expect(fleetSizeFrom(null, { ...rollups, n: 37 })).toBe(37)
    expect(fleetSizeFrom(null, null)).toBeNull()
    expect(fleetSizeFrom(null, { n: "x" })).toBeNull()
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
