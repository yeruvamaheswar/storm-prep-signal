import { describe, expect, test } from "vitest"
import type { FlowHome, OrderTimelineEntry } from "../src/features/flow/types"
import { keyMoments } from "../src/features/replay/keyMoments"
import { feedLines } from "../src/features/replay/narrate"
import { intentLine } from "../src/features/replay/intentCopy"
import { promiseBreakdown, type ReplayPromiseResult } from "../src/features/replay/promise"
import { fmtClock, replayTickSeconds, stepSeconds } from "../src/features/replay/tickClock"

const northOrders: Record<string, OrderTimelineEntry[]> = {
  "home-054": [
    [0, "sent", 0.01],
    [9.4, "exec", 0.01],
    [9.4, "rdrop", null],
    [60, "retry", null],
    [74.8, "dup", null],
    [74.8, "rdrop", null],
  ],
  "home-058": [
    [0, "sent", 0.03],
    [7.1, "exec", 0.03],
    [22.3, "conf", 0.03],
  ],
  "home-062": [
    [0, "sent", 0.11],
    [0, "drop", null],
    [60, "retry", null],
    [77.1, "exec", 0.11],
    [93.3, "conf", 0.11],
  ],
  "home-066": [
    [0, "sent", 2.11],
    [0, "drop", null],
    [60, "retry", null],
    [80.7, "exec", 2.11],
    [82.3, "conf", 2.11],
  ],
  "home-070": [
    [0, "sent", 5],
    [0, "drop", null],
    [60, "retry", null],
    [60, "drop", null],
  ],
  "home-074": [
    [0, "sent", 5],
    [0, "drop", null],
    [60, "retry", null],
    [72.9, "dup", null],
    [82.1, "exec", 5],
    [82.1, "rdrop", null],
  ],
  "home-078": [
    [0, "sent", 5],
    [17.7, "exec", 5],
    [36.9, "conf", 5],
  ],
  "home-082": [
    [0, "sent", 5],
    [12.2, "exec", 5],
    [25.2, "conf", 5],
  ],
  "home-086": [
    [0, "sent", 5],
    [13.6, "exec", 5],
    [32.8, "conf", 5],
    [119.6, "dup", null],
  ],
  "home-090": [
    [0, "sent", 5],
    [38.4, "exec", 5],
    [45.8, "conf", 5],
  ],
  "home-094": [
    [0, "sent", 5],
    [19.5, "dup", null],
    [26, "exec", 5],
    [60, "retry", null],
    [60, "rdrop", null],
  ],
  "home-098": [
    [0, "sent", 5],
    [0, "drop", null],
    [60, "retry", null],
    [73.8, "dup", null],
    [78.6, "exec", 5],
    [80.8, "conf", 5],
  ],
}

const homesById = Object.fromEntries(
  Object.entries(northOrders).map(([id, timeline]) => [
    id,
    { id, zone: "North", kw: Number(timeline[0][2]), soc_pct: 70, state: "selling", status: "ok", floor_pct: 30 } satisfies FlowHome,
  ]),
)

describe("tickClock", () => {
  test("maps session speed to real seconds per animation tick", () => {
    expect(stepSeconds(5, 15)).toBe(20)
    expect(stepSeconds(5, 600)).toBe(0.5)
  })

  test("maps elapsed wall time into the 125-second replay while playing", () => {
    expect(replayTickSeconds({ playing: true, nowMs: 20_000, tickArrivedAtMs: 10_000, stepSeconds: 2, scrubberT: 88 })).toBe(125)
    expect(replayTickSeconds({ playing: true, nowMs: 11_000, tickArrivedAtMs: 10_000, stepSeconds: 2, scrubberT: 88 })).toBe(62.5)
    expect(replayTickSeconds({ playing: false, nowMs: 11_000, tickArrivedAtMs: 10_000, stepSeconds: 2, scrubberT: 88 })).toBe(88)
  })

  test("clamps the scrubber value to 0..125 while paused", () => {
    expect(replayTickSeconds({ playing: false, nowMs: 0, tickArrivedAtMs: 0, stepSeconds: 2, scrubberT: -5 })).toBe(0)
    expect(replayTickSeconds({ playing: false, nowMs: 0, tickArrivedAtMs: 0, stepSeconds: 2, scrubberT: 400 })).toBe(125)
  })

  test("formats replay seconds as the mockup clock", () => {
    expect(fmtClock(0)).toBe("0:00")
    expect(fmtClock(82.9)).toBe("1:22")
    expect(fmtClock(125)).toBe("2:05")
  })
})

describe("feedLines", () => {
  test("returns newest-first mockup narration from the real North tick-3 timelines", () => {
    const lines = feedLines(northOrders, 120, homesById, { breaches: 0 })
    expect(lines[0]).toEqual({ t: "2:00", at: 120, x: "Books closed. 4 homes not counted, 15.0 kW. Backup breaches: 0.", c: "var(--rg-not-counted)" })
    expect(lines).toContainEqual({ t: "1:14", at: 74.8, x: "home-054: a duplicate copy was ignored, so it did not run twice.", c: "var(--rg-not-counted)" })
    expect(lines).toContainEqual({ t: "0:09", at: 9.4, x: "home-054's report was lost on the way back.", c: "var(--rg-lost)" })
  })

  test("aggregates send, initial drops, retry and reassign-failed lines", () => {
    const lines = feedLines(northOrders, 60, homesById, { breaches: 0 })
    expect(lines).toContainEqual({ t: "0:00", at: 0, x: "Orders sent to 12 homes for 42.3 kW.", c: "var(--rg-order-way)" })
    expect(lines).toContainEqual({ t: "0:00", at: 0, x: "5 orders were lost on the way.", c: "var(--rg-lost)" })
    expect(lines[0]).toEqual({ t: "1:00", at: 60, x: "7 homes had not answered. Each got one retry.", c: "var(--rg-charging)" })

    const withFailedReassign = { ...northOrders, "home-100": [[60, "reassign_failed", null, "r"]] satisfies OrderTimelineEntry[] }
    expect(feedLines(withFailedReassign, 60, homesById, { breaches: 0 })[0].x).toContain("No spare home could take an order over.")
  })

  test("filters and sorts on the numeric at field, not on the formatted clock string", () => {
    // 9:00 (540s) sorts before 0:09 (9s) alphabetically, but must sort after it numerically.
    const lines = feedLines(
      { "home-001": [[9, "exec", 1, "own"], [540, "conf", 1, "own"]] },
      600,
      { "home-001": { kw: 1 } },
    )
    const at9 = lines.find((l) => l.x.includes("gave"))
    const at540 = lines.find((l) => l.x.includes("confirmed"))
    expect(at9?.at).toBe(9)
    expect(at540?.at).toBe(540)
    expect(lines.indexOf(at540!)).toBeLessThan(lines.indexOf(at9!))
  })

  test("a charge order (negative planned kW) narrates 'charged' and 'charge confirmed', never 'gave'", () => {
    const chargeOrders = { "home-200": [[0, "sent", -3], [8, "exec", -3], [13, "conf", -3]] satisfies OrderTimelineEntry[] }
    const lines = feedLines(chargeOrders, 120, { "home-200": { kw: -3 } })
    expect(lines).toContainEqual(expect.objectContaining({ x: "home-200 charged 3.00 kW." }))
    expect(lines).toContainEqual(expect.objectContaining({ x: "home-200 charge confirmed." }))
    expect(lines.some((l) => l.x.includes("gave"))).toBe(false)
  })

  test("the 'gave' line uses the exec extra, falling back to the planned kW only if exec has none", () => {
    const partial = { "home-201": [[0, "sent", 5], [10, "exec", 3]] satisfies OrderTimelineEntry[] }
    expect(feedLines(partial, 20, { "home-201": { kw: 5 } })).toContainEqual(
      expect.objectContaining({ x: "home-201 gave 3.00 kW." }),
    )

    const noExecKw = { "home-202": [[0, "sent", 5], [10, "exec", null]] satisfies OrderTimelineEntry[] }
    expect(feedLines(noExecKw, 20, { "home-202": { kw: 5 } })).toContainEqual(
      expect.objectContaining({ x: "home-202 gave 5.00 kW." }),
    )
  })

  test("kwFor never falls back to the home's current kw; an order with no planned kW leaves the kW out", () => {
    const noKw = { "home-203": [[0, "sent", null], [5, "exec", null]] satisfies OrderTimelineEntry[] }
    const lines = feedLines(noKw, 20, { "home-203": { kw: 10 } })
    expect(lines).toContainEqual(expect.objectContaining({ x: "home-203 gave energy." }))
    // No order in the group has a known kW, so the kW clause is left out (never "0.0 kW").
    expect(lines).toContainEqual(expect.objectContaining({ x: "Orders sent to 1 home." }))
    expect(lines.some((l) => l.x.includes("0.0 kW"))).toBe(false)
  })

  test("the 0 s aggregate counts only sent entries at t === 0, and reports charge kW separately", () => {
    const mixed = {
      "home-300": [[0, "sent", 10]] satisfies OrderTimelineEntry[],
      "home-301": [[0, "sent", -6]] satisfies OrderTimelineEntry[],
    }
    const lines = feedLines(mixed, 0, { "home-300": { kw: 10 }, "home-301": { kw: -6 } })
    expect(lines).toContainEqual(expect.objectContaining({
      x: "Orders sent to 1 home for 10.0 kW and 1 home to charge 6.0 kW.",
    }))
  })

  test("the retry aggregate counts retries within [60, 61), and the initial-drop aggregate counts drops with t < 1", () => {
    const timelines = {
      "home-400": [[0, "sent", 5], [0.9, "drop", null]] satisfies OrderTimelineEntry[],
      "home-401": [[0, "sent", 5], [1, "drop", null]] satisfies OrderTimelineEntry[],
      "home-402": [[0, "sent", 5], [60.9, "retry", null]] satisfies OrderTimelineEntry[],
      "home-403": [[0, "sent", 5], [61, "retry", null]] satisfies OrderTimelineEntry[],
    }
    const homes = Object.fromEntries(Object.keys(timelines).map((id) => [id, { kw: 5 }]))
    const lines = feedLines(timelines, 61, homes, { breaches: 0 })
    expect(lines).toContainEqual(expect.objectContaining({ x: "1 order was lost on the way." }))
    expect(lines).toContainEqual(expect.objectContaining({ x: "1 home had not answered. Each got one retry." }))
  })
})

describe("promiseBreakdown", () => {
  test("returns one 'not sold' row, labeled 'Kept for backup, floor raised' when a floor-raising reason is present", () => {
    // Self-consistent fixture: missed_mw = target_mw - delivered_mw, unconfirmed_mw <= missed_mw.
    const tick = {
      target_mw: 0.06,
      delivered_mw: 0.02735,
      missed_mw: 0.03265,
      unconfirmed_mw: 0.015,
      breaches: 0,
      reserve_pct: 60,
      reasons: ["storm_reserve"],
    } satisfies ReplayPromiseResult
    const rows = promiseBreakdown(tick)
    expect(rows).toEqual([
      { key: "asked", label: "Asked", mw: 0.06 },
      { key: "sold_confirmed", label: "Sold and confirmed", mw: 0.02735 },
      { key: "sent_not_counted", label: "Sent, not counted", mw: 0.015 },
      { key: "not_sold", label: "Kept for backup, floor raised", mw: 0.01765 },
      { key: "breaches", label: "Backup breaches", count: 0 },
    ])
    const mwOf = (key: string) => {
      const row = rows.find((r) => r.key === key)
      return row && "mw" in row ? row.mw : 0
    }
    expect(mwOf("asked")).toBeCloseTo(mwOf("sold_confirmed") + mwOf("sent_not_counted") + mwOf("not_sold"), 9)
  })

  test("labels the 'not sold' row 'Not sent, no spare energy above floors' without a floor-raising reason", () => {
    const rows = promiseBreakdown({
      target_mw: 0.06,
      delivered_mw: 0.02735,
      missed_mw: 0.03265,
      unconfirmed_mw: 0.015,
      reasons: ["timed_out:2"],
    })
    expect(rows).toContainEqual({ key: "not_sold", label: "Not sent, no spare energy above floors", mw: 0.01765 })
  })

  test("a reason merely starting with 'weather' still raises the floor label", () => {
    const rows = promiseBreakdown({
      target_mw: 0.06, delivered_mw: 0.02735, missed_mw: 0.03265, unconfirmed_mw: 0.015, reasons: ["weather_alert:North"],
    })
    expect(rows).toContainEqual({ key: "not_sold", label: "Kept for backup, floor raised", mw: 0.01765 })
  })

  test("a high reserve_pct alone (no reason code) does not raise the floor label; there is no threshold", () => {
    const rows = promiseBreakdown({
      target_mw: 0.06, delivered_mw: 0.02735, missed_mw: 0.03265, unconfirmed_mw: 0.015, reserve_pct: 60, reasons: [],
    })
    expect(rows).toContainEqual({ key: "not_sold", label: "Not sent, no spare energy above floors", mw: 0.01765 })
  })

  test("omits values that are not present instead of inventing them", () => {
    expect(promiseBreakdown({ target_mw: 0.4, delivered_mw: 0.2 })).toEqual([
      { key: "asked", label: "Asked", mw: 0.4 },
      { key: "sold_confirmed", label: "Sold and confirmed", mw: 0.2 },
    ])
  })

  test("omits the 'not sold' row unless both missed_mw and unconfirmed_mw are present", () => {
    expect(promiseBreakdown({ target_mw: 0.4, delivered_mw: 0.2, missed_mw: 0.2 })).toEqual([
      { key: "asked", label: "Asked", mw: 0.4 },
      { key: "sold_confirmed", label: "Sold and confirmed", mw: 0.2 },
    ])
  })
})

describe("keyMoments", () => {
  test("finds the first event times that drive replay captions", () => {
    const moments = keyMoments({
      ...northOrders,
      "home-100": [
        [50, "reassigned", "home-101", "own"],
        [87, "mismatch", null, "own"],
      ],
    })
    expect(moments).toEqual({
      firstDrop: 0,
      retry: 60,
      reassign: 50,
      close: 120,
      mismatch: 87,
    })
  })

})

describe("feedLines kW honesty and plurals", () => {
  test("aggregate kW sums include only known values; unknown kW is never counted as 0", () => {
    const partialKw = {
      "home-500": [[0, "sent", 4]] satisfies OrderTimelineEntry[],
      "home-501": [[0, "sent", null]] satisfies OrderTimelineEntry[],
    }
    const lines = feedLines(partialKw, 0, {})
    expect(lines).toContainEqual(expect.objectContaining({ x: "Orders sent to 2 homes for 4.0 kW." }))
  })

  test("with only charge orders, the discharge clause is omitted", () => {
    const chargeOnly = {
      "home-600": [[0, "sent", -3]] satisfies OrderTimelineEntry[],
      "home-601": [[0, "sent", -6]] satisfies OrderTimelineEntry[],
    }
    expect(feedLines(chargeOnly, 0, {})).toContainEqual(expect.objectContaining({ x: "Charge orders sent to 2 homes for 9.0 kW." }))
    const oneChargeNoKw = { "home-602": [[0, "sent", null], [5, "exec", -2]] satisfies OrderTimelineEntry[] }
    expect(feedLines(oneChargeNoKw, 0, {})).toContainEqual(expect.objectContaining({ x: "Charge orders sent to 1 home for 2.0 kW." }))
  })

  test("an unknown-kW home counts as a home but adds nothing to the discharge kW sum", () => {
    const mixed = {
      "home-700": [[0, "sent", 5]] satisfies OrderTimelineEntry[],
      "home-701": [[0, "sent", -1], [3, "exec", null]] satisfies OrderTimelineEntry[],
      "home-702": [[0, "sent", null]] satisfies OrderTimelineEntry[],
    }
    // home-702 has no known kW: it counts as a discharge home but adds nothing to the kW sum.
    expect(feedLines(mixed, 0, {})).toContainEqual(expect.objectContaining({
      x: "Orders sent to 2 homes for 5.0 kW and 1 home to charge 1.0 kW.",
    }))
  })

  test("Books closed uses singular for one home and omits kW when none is known", () => {
    const one = { "home-800": [[0, "sent", null]] satisfies OrderTimelineEntry[] }
    expect(feedLines(one, 120, {}, { breaches: 1 })[0].x).toBe("Books closed. 1 home not counted. Backup breaches: 1.")
    const known = { "home-801": [[0, "sent", 2.5]] satisfies OrderTimelineEntry[], "home-802": [[0, "sent", null]] satisfies OrderTimelineEntry[] }
    expect(feedLines(known, 120, {}, { breaches: 0 })[0].x).toBe("Books closed. 2 homes not counted, 2.5 kW. Backup breaches: 0.")
  })
})

// Real post-#41 ticks (engine in-process, seed 42, HOME_MAX_KW=11.4; main-impact-audit.md S3).
const heather74 = {
  tick: 74, mode: "AUTO", target_mw: 0.2, delivered_mw: 0, missed_mw: 0.2, unconfirmed_mw: 0, charging_mw: 1.1286,
  intent: "charge", intent_reason: "reserve_refill", reasons: ["storm_reserve", "reserve_refill", "homes_stale:1"], breaches: 0,
} satisfies ReplayPromiseResult
const beryl1 = {
  tick: 1, mode: "AUTO", target_mw: 0.02, delivered_mw: 0.02, missed_mw: 0, unconfirmed_mw: 0, charging_mw: 0.908,
  intent: "charge", intent_reason: "grid_call_served", reasons: ["charging", "reserve_refill"], breaches: 0,
} satisfies ReplayPromiseResult
const hold4 = {
  tick: 4, mode: "HOLD", target_mw: 0.5477, delivered_mw: 0, missed_mw: 0.5477, unconfirmed_mw: 0, charging_mw: 0,
  intent: "hold", intent_reason: "operator_hold", reasons: ["operator_hold"], breaches: 0,
} satisfies ReplayPromiseResult

describe("promiseBreakdown on post-#41 ticks (B1, B3)", () => {
  test("heather tick 74: the refill shows as charged, apart from the call, and never as sold", () => {
    expect(promiseBreakdown(heather74)).toEqual([
      { key: "asked", label: "Asked", mw: 0.2 },
      { key: "sold_confirmed", label: "Sold and confirmed", mw: 0 },
      { key: "sent_not_counted", label: "Sent, not counted", mw: 0 },
      { key: "not_sold", label: "Kept for backup, floor raised", mw: 0.2 },
      { key: "charged", label: "Charged from the grid", mw: 1.1286 },
      { key: "breaches", label: "Backup breaches", count: 0 },
    ])
  })

  test("beryl tick 1: a served call still names the energy bought", () => {
    const rows = promiseBreakdown(beryl1)
    expect(rows).toContainEqual({ key: "sold_confirmed", label: "Sold and confirmed", mw: 0.02 })
    expect(rows).toContainEqual({ key: "charged", label: "Charged from the grid", mw: 0.908 })
    // Asked still splits into sold + not counted + not sold; charged is outside that sum.
    const mwOf = (key: string) => {
      const row = rows.find((r) => r.key === key)
      return row && "mw" in row ? row.mw : Number.NaN
    }
    expect(mwOf("asked")).toBeCloseTo(mwOf("sold_confirmed") + mwOf("sent_not_counted") + mwOf("not_sold"), 9)
  })

  test("no charged row when charging_mw is missing or not a finite number (never an invented 0)", () => {
    const { charging_mw: _c, ...bare } = heather74
    expect(promiseBreakdown(bare).some((row) => row.key === "charged")).toBe(false)
    expect(promiseBreakdown({ ...heather74, charging_mw: Number.NaN }).some((row) => row.key === "charged")).toBe(false)
  })

  test("an operator HOLD tick reads 'Not sent, operator hold', not 'no spare energy'", () => {
    expect(promiseBreakdown(hold4)).toContainEqual({ key: "not_sold", label: "Not sent, operator hold", mw: 0.5477 })
    // By mode alone, and by the reason alone (history points carry no mode).
    const { reasons: _r, ...byMode } = hold4
    expect(promiseBreakdown(byMode)).toContainEqual({ key: "not_sold", label: "Not sent, operator hold", mw: 0.5477 })
    const { mode: _m, ...byReason } = hold4
    expect(promiseBreakdown(byReason)).toContainEqual({ key: "not_sold", label: "Not sent, operator hold", mw: 0.5477 })
  })
})

describe("intentLine (B1, B2 shared copy)", () => {
  test("maps the six engine intent reasons to plain words", () => {
    expect(intentLine("charge", "grid_call_served")).toBe("Fleet did: Charge, served the call, then charged")
    expect(intentLine("charge", "reserve_refill")).toBe("Fleet did: Charge, refilled batteries under their floor")
    expect(intentLine("discharge", "grid_call")).toBe("Fleet did: Sell, sold for the grid call")
    expect(intentLine("charge", "zone_price")).toBe("Fleet did: Charge, charged on a cheap zone price")
    expect(intentLine("hold", "no_grid_call")).toBe("Fleet did: Hold, no call")
    expect(intentLine("hold", "operator_hold")).toBe("Fleet did: Hold, operator hold")
  })

  test("an empty reason gives the verb only; an unknown code is the code in words; no intent gives no line", () => {
    expect(intentLine("discharge", "")).toBe("Fleet did: Sell")
    expect(intentLine("hold", "price_unavailable")).toBe("Fleet did: Hold, price unavailable")
    expect(intentLine("idle_mode", undefined)).toBe("Fleet did: Idle mode")
    expect(intentLine(undefined, "grid_call")).toBeNull()
    expect(intentLine("", "")).toBeNull()
  })
})

// Real heather tick 1 on the merged engine (seed 42, HOME_MAX_KW=11.4, HOME_KWH=25): a mixed tick. North sold and
// charged in the same tick, the call was served to within float residue, and the fleet then charged.
// unconfirmed_mw comes from the history point, as ReplayPage.promiseTick merges it.
const heather1 = {
  tick: 1, mode: "AUTO", target_mw: 0.2, delivered_mw: 0.19999999971958105, missed_mw: 2.804189658256462e-10, unconfirmed_mw: 0,
  charging_mw: 0.246587997, intent: "charge", intent_reason: "grid_call_served",
  reasons: ["reserve_refill", "timed_out:2", "duplicates_ignored:1", "over_delivery:1"], breaches: 0,
} satisfies ReplayPromiseResult

describe("promiseBreakdown closes the old 'no spare energy on a charging tick' minor (Task 12)", () => {
  test("a served call whose unsold part rounds to 0.000 MW names no cause for it", () => {
    for (const tick of [heather1, beryl1]) {
      const notSold = promiseBreakdown(tick).find((row) => row.key === "not_sold")
      expect(notSold).toEqual({ key: "not_sold", label: "Not sold", mw: tick.missed_mw })
    }
  })

  test("a real unsold amount still names its cause", () => {
    expect(promiseBreakdown(heather74)).toContainEqual({ key: "not_sold", label: "Kept for backup, floor raised", mw: 0.2 })
    expect(promiseBreakdown(hold4)).toContainEqual({ key: "not_sold", label: "Not sent, operator hold", mw: 0.5477 })
  })
})
