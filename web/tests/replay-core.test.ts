import { describe, expect, test } from "vitest"
import type { FlowHome, OrderTimelineEntry } from "../src/features/flow/types"
import { keyMoments } from "../src/features/replay/keyMoments"
import { feedLines } from "../src/features/replay/narrate"
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

  test("formats replay seconds as the mockup clock", () => {
    expect(fmtClock(0)).toBe("0:00")
    expect(fmtClock(82.9)).toBe("1:22")
    expect(fmtClock(125)).toBe("2:05")
  })
})

describe("feedLines", () => {
  test("returns newest-first mockup narration from the real North tick-3 timelines", () => {
    const lines = feedLines(northOrders, 120, homesById, { breaches: 0 })
    expect(lines[0]).toEqual({ t: "2:00", x: "Books closed. 4 homes not counted, 15.0 kW. Backup breaches: 0.", c: "#8A928C" })
    expect(lines).toContainEqual({ t: "1:14", x: "home-054: a duplicate copy was ignored, so it did not run twice.", c: "#8A928C" })
    expect(lines).toContainEqual({ t: "0:09", x: "home-054's report was lost on the way back.", c: "#C8412F" })
  })

  test("aggregates send, initial drops, retry and reassign-failed lines", () => {
    const lines = feedLines(northOrders, 60, homesById, { breaches: 0 })
    expect(lines).toContainEqual({ t: "0:00", x: "Orders sent to 12 homes for 42.3 kW.", c: "#1FA9B5" })
    expect(lines).toContainEqual({ t: "0:00", x: "5 orders were lost on the way.", c: "#C8412F" })
    expect(lines[0]).toEqual({ t: "1:00", x: "7 homes had not answered. Each got one retry.", c: "#C98A1B" })

    const withFailedReassign = { ...northOrders, "home-100": [[60, "reassign_failed", null, "r"]] satisfies OrderTimelineEntry[] }
    expect(feedLines(withFailedReassign, 60, homesById, { breaches: 0 })[0].x).toContain("No spare home could take an order over.")
  })
})

describe("promiseBreakdown", () => {
  test("returns only rows backed by the tick result fields", () => {
    const tick = {
      target_mw: 0.06,
      delivered_mw: 0.02735,
      missed_mw: 0.01765,
      unconfirmed_mw: 0.015,
      breaches: 0,
      reserve_pct: 60,
      reasons: ["storm_reserve"],
    } satisfies ReplayPromiseResult
    expect(promiseBreakdown(tick)).toEqual([
      { key: "asked", label: "Asked", mw: 0.06 },
      { key: "sold_confirmed", label: "Sold and confirmed", mw: 0.02735 },
      { key: "sent_not_counted", label: "Sent but not counted", mw: 0.015 },
      { key: "not_sent", label: "Not sent", mw: 0.01765 },
      { key: "held_back", label: "Held back for raised floor", mw: 0.01765 },
      { key: "breaches", label: "Backup breaches", count: 0 },
    ])
  })

  test("omits values that are not present instead of inventing them", () => {
    expect(promiseBreakdown({ target_mw: 0.4, delivered_mw: 0.2 })).toEqual([
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
