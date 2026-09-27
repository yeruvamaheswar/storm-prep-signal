import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FlowHome, OrderTimelineEntry } from "../src/features/flow/types"
import { NOT_REPORTED } from "../src/features/replay/format"
import { HomePanel } from "../src/features/replay/HomePanel"
import { ReplayPage } from "../src/features/replay/ReplayPage"
import { ZoneBoard } from "../src/features/replay/ZoneBoard"
import { ZonePanel } from "../src/features/replay/ZonePanel"
import { OrderPaths } from "../src/features/replay/OrderPaths"
import { berylHoustonHomes22, berylHoustonOrders22 } from "./fixtures/beryl22"
import {
  askedText, countedText, homeFacts, iso, journeySteps, keepGauge, lossPoint, lotLook, notAskedLabel, notAskedReason, orderPath, refillLine, storyHomes,
  trustMarks, zoneLots, zonePaths, zoneSummary,
} from "../src/features/replay/zoneModel"

// Real tick-3 order timelines for the 12 North homes that got an order (failures tape, seed 1), as in mockup/Zone.dc.html.
const northOrders: Record<string, OrderTimelineEntry[]> = {
  "home-054": [[0, "sent", 0.01], [9.4, "exec", 0.01], [9.4, "rdrop", null], [60, "retry", null], [74.8, "dup", null], [74.8, "rdrop", null]],
  "home-058": [[0, "sent", 0.03], [7.1, "exec", 0.03], [22.3, "conf", 0.03]],
  "home-062": [[0, "sent", 0.11], [0, "drop", null], [60, "retry", null], [77.1, "exec", 0.11], [93.3, "conf", 0.11]],
  "home-066": [[0, "sent", 2.11], [0, "drop", null], [60, "retry", null], [80.7, "exec", 2.11], [82.3, "conf", 2.11]],
  "home-070": [[0, "sent", 5], [0, "drop", null], [60, "retry", null], [60, "drop", null]],
  "home-074": [[0, "sent", 5], [0, "drop", null], [60, "retry", null], [72.9, "dup", null], [82.1, "exec", 5], [82.1, "rdrop", null]],
  "home-078": [[0, "sent", 5], [17.7, "exec", 5], [36.9, "conf", 5]],
  "home-082": [[0, "sent", 5], [12.2, "exec", 5], [25.2, "conf", 5]],
  "home-086": [[0, "sent", 5], [13.6, "exec", 5], [32.8, "conf", 5], [119.6, "dup", null]],
  "home-090": [[0, "sent", 5], [38.4, "exec", 5], [45.8, "conf", 5]],
  "home-094": [[0, "sent", 5], [19.5, "dup", null], [26.0, "exec", 5], [60, "retry", null], [60, "rdrop", null]],
  "home-098": [[0, "sent", 5], [0, "drop", null], [60, "retry", null], [73.8, "dup", null], [78.6, "exec", 5], [80.8, "conf", 5]],
}

// The 25 North homes of that fleet are home-002, home-006, ... home-098. The 13 without an order sat at their floor.
const northHomes: FlowHome[] = Array.from({ length: 25 }, (_, k) => {
  const id = `home-${String(2 + k * 4).padStart(3, "0")}`
  const asked = id in northOrders
  return {
    id, zone: "North", soc_pct: asked ? 55 : 30, soc_before_pct: asked ? 60 : 30, kw: 0,
    state: asked ? "selling" : "at_floor", status: "live", floor_pct: 30,
  } as FlowHome
})

// Real reassignment from the live faults session (seed 1): home-071 timed out and handed its order to home-003.
const reassignOrders: Record<string, OrderTimelineEntry[]> = {
  "home-003": [[0, "sent", 0.9727, "own"], [20.7, "exec", 0.9727, "own"], [29.6, "conf", 0.9727, "own"], [60, "sent", 0.972727, "r"], [74.6, "exec", 0.972727, "r"], [87.7, "conf", 0.972727, "r"]],
  "home-071": [[0, "sent", 0.9727, "own"], [48.8, "exec", 0.9727, "own"], [60, "timeout", null, "own"], [60, "retry", null, "own"], [60, "reassigned", "home-003", "own"], [64.5, "conf", 0.9727, "own"], [66, "dup", null, "own"]],
}

const chargeOrder: OrderTimelineEntry[] = [[0, "sent", -3.2], [8, "exec", -3.2], [13, "conf", -3.2]]

function classesAt(t: number): Record<string, string> {
  const lots = zoneLots(northHomes, "North")
  return Object.fromEntries(zonePaths(lots.slots, northOrders, t).map((p) => [p.homeId, p.cls]))
}

describe("zone lot layout and geometry", () => {
  it("uses the mockup isometric projection", () => {
    expect(iso(0, 0)).toEqual([700, 250])
    expect(iso(4, 0)).toEqual([1020, 426])
    expect(iso(0, 4)).toEqual([380, 426])
    expect(iso(4, 4)).toEqual([700, 602])
  })

  it("lays the zone's homes out 5 x 5 in id order, painted back to front", () => {
    const lots = zoneLots([...northHomes].reverse(), "North")
    expect(lots.total).toBe(25)
    expect(lots.shown).toBe(25)
    expect(lots.slots).toHaveLength(25)
    const bySlot = [...lots.slots].sort((a, b) => a.slot - b.slot)
    expect(bySlot[0]).toMatchObject({ i: 0, j: 0, cx: 700, cy: 250 })
    expect(bySlot[0].home?.id).toBe("home-002")
    expect(bySlot[6]).toMatchObject({ i: 1, j: 1 })
    expect(bySlot[6].home?.id).toBe("home-026")
    expect(bySlot[24].home?.id).toBe("home-098")
    const depth = lots.slots.map((lot) => lot.i + lot.j)
    expect(depth).toEqual([...depth].sort((a, b) => a - b))
  })

  it("leaves empty lots for a small zone and keeps only 25 of a large one", () => {
    const small = zoneLots(northHomes.slice(0, 7), "North")
    expect(small.slots.filter((lot) => lot.home)).toHaveLength(7)
    expect(small.slots.filter((lot) => !lot.home)).toHaveLength(18)
    const extra = Array.from({ length: 5 }, (_, k) => ({ ...northHomes[0], id: `home-9${k}0` }))
    const big = zoneLots([...northHomes, ...extra], "North")
    expect(big).toMatchObject({ total: 30, shown: 25 })
  })

  it("routes an order from the substation down the side street and along the lot's row", () => {
    expect(orderPath(0, 0, 0)).toBe("M444,285 L500,316 L620,250 L660,272 L676,263")
    expect(orderPath(2, 3, -4)).toBe("M444,281 L500,312 L380,378 L580,488 L596,479")
    expect(lossPoint(2, 3, -4)).toEqual([480, 433])
  })

  it('notes "Showing 25 of N" in the breadcrumb when a zone has more than 25 homes', () => {
    const extra = Array.from({ length: 3 }, (_, k) => ({ ...northHomes[0], id: `home-99${k}` }))
    const html = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes: [...northHomes, ...extra], orders: northOrders, tSeconds: 0, lens: "send",
      openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(html).toContain("Showing 25 of 28")
  })
})

describe("order path classes follow the real timeline at the playhead", () => {
  it("maps state to the mockup path class", () => {
    expect(classesAt(0)).toMatchObject({ "home-054": "p-out", "home-066": "p-lost", "home-070": "p-lost", "home-058": "p-out" })
    expect(classesAt(10)).toMatchObject({ "home-054": "p-rlost", "home-058": "p-wait" })
    expect(classesAt(30)).toMatchObject({ "home-058": "p-ok" })
    expect(classesAt(61)).toMatchObject({ "home-054": "p-wait", "home-066": "p-retry", "home-070": "p-lost" })
    expect(classesAt(82.3)).toMatchObject({ "home-066": "p-ok", "home-074": "p-rlost" })
    expect(classesAt(120)).toMatchObject({ "home-054": "p-nc", "home-066": "p-ok", "home-070": "p-nc", "home-094": "p-nc" })
  })

  it("puts the red loss marker only on lost orders", () => {
    const lots = zoneLots(northHomes, "North")
    const marked = zonePaths(lots.slots, northOrders, 0).filter((p) => p.marker).map((p) => p.homeId)
    expect(marked.sort()).toEqual(["home-062", "home-066", "home-070", "home-074", "home-098"])
  })

  it("labels lots for screen readers from the same state", () => {
    const html = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes: northHomes, orders: northOrders, tSeconds: 90, lens: "send",
      openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(html.match(/<button[^>]*class="zone-lot/g)).toHaveLength(25)
    expect(html).toContain('aria-label="home-066, Confirmed, counted"')
    expect(html).toContain('aria-label="home-070, Order lost"')
    expect(html).toContain('aria-label="home-002, Not asked, at its floor"')
  })

  it("tags up to three story lots: first lost, first report lost, first confirmed after a retry", () => {
    expect(storyHomes(northOrders, northHomes.map((h) => h.id))).toEqual(["home-062", "home-054", "home-098"])
    const html = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes: northHomes, orders: northOrders, tSeconds: 90, lens: "send",
      openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(html.match(/class="zone-tag"/g)).toHaveLength(3)
    expect(html).toContain("home-098: Confirmed, counted")
  })

  it("draws two paths for a home with its own and a reassigned-in order, and its state follows own", () => {
    const homes: FlowHome[] = [{ id: "home-003", zone: "Houston", soc_pct: 50, kw: 1, state: "selling", status: "live", floor_pct: 30 }]
    const lots = zoneLots(homes, "Houston")
    const paths = zonePaths(lots.slots, reassignOrders, 70)
    expect(paths.map((p) => p.key)).toEqual(["own", "r"])
    expect(paths[0].d).not.toBe(paths[1].d)
    expect(paths.map((p) => p.cls)).toEqual(["p-ok", "p-out"])
    expect(zonePaths(lots.slots, reassignOrders, 30).map((p) => p.cls)).toEqual(["p-ok", "p-idle"])
    const look = lotLook(homes[0], reassignOrders["home-003"], 70, false)
    expect(look.label).toBe("Confirmed, counted")
    expect(look.aria).toBe("home-003, Confirmed, counted, also took over another home's order")
  })
})

describe("charge orders", () => {
  it("draw amber paths and say Charging X kW", () => {
    // A charging home still under its floor: the engine names why (scenario.py under_floor_why, set since #41).
    const homes: FlowHome[] = [{ id: "home-010", zone: "West", soc_pct: 20, kw: -3.2, state: "charging", status: "live", floor_pct: 30, under_floor_why: "started_under" }]
    const lots = zoneLots(homes, "West")
    const [path] = zonePaths(lots.slots, { "home-010": chargeOrder }, 5)
    expect(path.cls).toBe("p-out p-charge")
    expect(path.charging).toBe(true)
    expect(zonePaths(lots.slots, { "home-010": chargeOrder }, 20)[0].cls).toBe("p-ok p-charge")
    const svg = renderToStaticMarkup(createElement(OrderPaths, { paths: [path, ...zonePaths(zoneLots(northHomes, "North").slots, northOrders, 0)] }))
    expect(svg).toContain('class="zp p-out p-charge" d="' + path.d + '" data-home="home-010" data-key="own" style="stroke:var(--rg-charging)"')
    expect(svg.match(/--rg-charging/g)).toHaveLength(1)
    expect(askedText(chargeOrder)).toBe("Charging 3.20 kW")
    expect(countedText(chargeOrder, 20).text).toBe("Charging, not a sale")
    expect(journeySteps(chargeOrder, 20).map((s) => s.x)).toEqual([
      "Charge order sent: charging 3.20 kW for this tick.", "Battery charged 3.20 kW.", "Charge confirmed.",
    ])
  })
})

describe("home journey", () => {
  it("lists every logged step and greys the ones still ahead of the playhead", () => {
    const steps = journeySteps(northOrders["home-066"], 70)
    expect(steps.map((s) => [s.t, s.x, s.later])).toEqual([
      ["0:00", "Order sent: 2.11 kW for this tick.", false],
      ["0:00", "Lost on the way.", false],
      ["1:00", "No answer. Retried once.", false],
      ["1:20", "Battery gave 2.11 kW, never going under its floor.", true],
      ["1:22", "Confirmed. Counted as sold.", true],
    ])
  })

  it("adds the books-closed step for an order never confirmed", () => {
    const before = journeySteps(northOrders["home-054"], 90)
    expect(before.at(-1)).toEqual({ at: 120, t: "2:00", x: "Books closed. Energy was given but never confirmed, so it is not counted.", later: true })
    expect(before.find((s) => s.x === "Its report had not arrived. Retried once.")).toBeDefined()
    expect(journeySteps(northOrders["home-070"], 120).at(-1)).toMatchObject({ x: "Books closed. Not counted.", later: false })
  })

  it("renders the home panel from the playhead", () => {
    const home = northHomes.find((h) => h.id === "home-066") as FlowHome
    const html = renderToStaticMarkup(createElement(HomePanel, { homeId: "home-066", home, orders: northOrders, tSeconds: 90, onClose: () => {} }))
    expect(html).toContain("home-066")
    expect(html).toContain("North zone. Backup floor 30% this tick.")
    expect(html).toContain("Confirmed, counted")
    expect(html).toContain("This order&#x27;s journey")
    expect(html).toContain("2.11 kW")
    expect(html).toContain("60.0% → 55.0%")
    expect(html).not.toContain("later")
    const early = renderToStaticMarkup(createElement(HomePanel, { homeId: "home-066", home, orders: northOrders, tSeconds: 70, onClose: () => {} }))
    expect(early.match(/zone-step later/g)).toHaveLength(2)
    expect(early).toContain("Not yet")
  })

  it("names the home a reassigned order came from", () => {
    const home: FlowHome = { id: "home-003", zone: "Houston", soc_pct: 50, kw: 1, state: "selling", status: "live", floor_pct: 30 }
    const html = renderToStaticMarkup(createElement(HomePanel, { homeId: "home-003", home, orders: reassignOrders, tSeconds: 90, onClose: () => {} }))
    expect(html).toContain("Also took over home-071&#x27;s order")
    expect(html).toContain("Taken over from home-071")
  })
})

describe("Not reported fallbacks", () => {
  it("never invents a charge or floor", () => {
    expect(homeFacts({})).toEqual({ floor: NOT_REPORTED, chargeBefore: NOT_REPORTED, chargeAfter: NOT_REPORTED })
    expect(homeFacts({ soc_pct: 41.25, floor_pct: 30 })).toEqual({ floor: "30%", chargeBefore: NOT_REPORTED, chargeAfter: "41.3%" })
    const home = { id: "home-002", zone: "North", kw: 0, state: "at_floor", status: "live" } as unknown as FlowHome
    const html = renderToStaticMarkup(createElement(HomePanel, { homeId: "home-002", home, orders: northOrders, tSeconds: 30, onClose: () => {} }))
    expect(html).toContain("Backup floor not reported.")
    expect(html).toContain("Not reported → Not reported")
    expect(html).toContain("Not asked this tick. Its charge is at its floor, so it keeps it all for backup.")
    expect(html).not.toMatch(/>0(\.0+)? kW</)
  })

  it("says Not reported for a kW the order log does not carry", () => {
    expect(askedText([[0, "sent", null]])).toBe(NOT_REPORTED)
    expect(countedText([[0, "sent", 2], [5, "conf", null]], 10).text).toBe(NOT_REPORTED)
    const summary = zoneSummary("North", northHomes, { "home-054": [[0, "sent", null]] }, 10, 1)
    expect(summary.sellKw).toBe(NOT_REPORTED)
  })

  it("shows Not reported in the zone panel with no order log", () => {
    const html = renderToStaticMarkup(createElement(ZonePanel, { zone: "North", homes: northHomes, orders: undefined, tick: null, tSeconds: 60 }))
    expect(html).toContain("North this tick, 25 homes")
    expect(html.match(/Not reported/g)?.length).toBeGreaterThanOrEqual(4)
  })
})

describe("zone summary from real data", () => {
  it("reads asks, confirmations and open kW at the playhead", () => {
    const tick = { breaches: 0 } as never
    const html = renderToStaticMarkup(createElement(ZonePanel, { zone: "North", homes: northHomes, orders: northOrders, tick, tSeconds: 125 }))
    expect(html).toContain("Asked of 12 homes")
    expect(html).toContain("42.3 kW")
    expect(html).toContain("Not counted")
    expect(html).toContain("15.0 kW")
    expect(html).toContain("Not asked, at their floor")
    expect(html).toContain("13 homes")
    expect(html).toContain("Books closed. 4 homes not counted, 15.0 kW. Backup breaches: 0.")
    const s = zoneSummary("North", northHomes, northOrders, 30, 12)
    expect(s.openLabel).toBe("Still open")
  })

  it("does not pin a fleet breach count on the zone feed", () => {
    const html = renderToStaticMarkup(createElement(ZonePanel, { zone: "North", homes: northHomes, orders: northOrders, tick: { breaches: 2 } as never, tSeconds: 125 }))
    expect(html).not.toContain("Books closed.")
    expect(html).toContain("Whole fleet, this tick")
  })
})

describe("Replay page zone view", () => {
  const session = {
    status: "paused", error: null, updated_at: "", scenario: null, seed: 1, speed: 60, speeds: [15, 60, 300], step_seconds: 2,
    tick_minutes: 5, tick_index: 3, tick_count: 4, start: {}, tick: { tick: 3, breaches: 0 }, homes: northHomes, orders: northOrders,
    zones: {}, charging_mw: 0, provenance: null, alerts: [], grid_down_zones: [], history: [], totals: null, log: [], honest_limits: [],
  }

  it("replaces the placeholder with the zone board and keeps the playback bar", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, { scenarios: null, state: session as never, nowMs: 0, selectedZone: "North" }))
    expect(html).not.toContain("Zone view coming next")
    expect(html).toContain("North substation")
    expect(html).toContain('aria-label="North this tick"')
    expect(html).toContain('aria-label="Playback"')
    expect(html).not.toContain("replay-map-stage")
  })

  it("opens the home panel for ?home=", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, { scenarios: null, state: session as never, nowMs: 0, selectedZone: "North", selectedHome: "home-066" }))
    expect(html).toContain('aria-label="Home detail"')
    expect(html).toContain("replay-scene has-home")
    expect(html).not.toContain('aria-label="North this tick"')
  })

  describe("keyboard", () => {
    let host: HTMLDivElement
    let root: Root
    beforeEach(() => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      host = document.createElement("div")
      document.body.appendChild(host)
      root = createRoot(host)
    })
    afterEach(() => {
      act(() => root.unmount())
      host.remove()
    })

    it("focuses the home panel, closes it on Escape and opens a home from its lot", async () => {
      const onCloseHome = vi.fn()
      const onHome = vi.fn()
      await act(async () => {
        root.render(createElement(ReplayPage, {
          scenarios: null, state: session as never, nowMs: 0, selectedZone: "North", selectedHome: "home-066", onCloseHome, onHome,
        }))
      })
      expect(document.activeElement).toBe(host.querySelector('[aria-label="Home detail"]'))
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      expect(onCloseHome).toHaveBeenCalledTimes(1)
      const lot = host.querySelector<HTMLButtonElement>('button[data-home="home-070"]')
      await act(async () => lot?.click())
      expect(onHome).toHaveBeenCalledWith("home-070")
    })
  })
})

describe("fix round 1", () => {
  // Engine logs reported_kwh = actual_kw * hours, so a charge report is negative (orchestration.py check_charge_drop).
  const chargeMismatch: OrderTimelineEntry[] = [[0, "sent", -4, "own"], [10, "exec", -4, "own"], [20, "mismatch", -0.5, "own"], [20, "conf", -4, "own"]]
  const sellMismatch: OrderTimelineEntry[] = [[0, "sent", 3, "own"], [10, "exec", 3, "own"], [20, "mismatch", 0.5, "own"], [20, "conf", 3, "own"]]
  const live = { zone: "North", kw: 0, status: "live", floor_pct: 30, soc_pct: 55 } as const

  it("words a charge mismatch as charged and taken in, unsigned", () => {
    const marks = trustMarks({ state: "charging" }, chargeMismatch, 30, 5)
    expect(marks.mismatch).toBe("Reported 0.50 kWh charged, took in 0.33 kWh")
    const step = journeySteps(chargeMismatch, 30, 5).find((s) => s.at === 20 && s.x.startsWith("Its"))
    expect(step?.x).toBe("Its report said it charged 0.50 kWh, but it took in 0.33 kWh. Booked at the truth.")
    expect(journeySteps(chargeMismatch, 30).some((s) => s.x === "Its charge report did not match what the battery did. Booked at the truth.")).toBe(true)
    expect(JSON.stringify(journeySteps(chargeMismatch, 30, 5))).not.toContain("-")
  })

  it("words a discharge mismatch as reported and gave", () => {
    expect(trustMarks({ state: "selling" }, sellMismatch, 30, 5).mismatch).toBe("Reported 0.50 kWh, gave 0.25 kWh")
    expect(trustMarks({ state: "selling" }, sellMismatch, 19, 5).mismatch).toBeNull()
    expect(journeySteps(sellMismatch, 30, 5).map((s) => s.x)).toContain("Its report said 0.50 kWh, but it gave 0.25 kWh. Booked at the truth.")
  })

  it("finds a mismatch on a reassigned-in order", () => {
    const timeline: OrderTimelineEntry[] = [
      [0, "sent", 1, "own"], [10, "exec", 1, "own"], [20, "conf", 1, "own"],
      [60, "sent", 3, "r"], [70, "exec", 3, "r"], [80, "mismatch", 0.5, "r"], [80, "conf", 3, "r"],
    ]
    expect(trustMarks({ state: "selling" }, timeline, 79, 5).mismatch).toBeNull()
    expect(trustMarks({ state: "selling" }, timeline, 90, 5).mismatch).toBe("Reported 0.50 kWh, gave 0.25 kWh")
  })

  it("keep lens draws each battery's charge and floor, and says when they are not reported", () => {
    expect(keepGauge({ soc_pct: 55, floor_pct: 30 })).toEqual({ charge: 0.55, floor: 0.3 })
    expect(keepGauge({} as never)).toEqual({ charge: null, floor: null })
    const homes = northHomes.map((h) => (h.id === "home-010" ? { ...h, soc_pct: undefined as unknown as number, floor_pct: undefined as unknown as number } : h))
    const html = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes, orders: northOrders, tSeconds: 90, lens: "keep", openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(html.match(/class="zone-gauge"/g)).toHaveLength(25)
    expect(html).toContain('aria-label="home-066, Confirmed, counted, charge 55%, floor 30%"')
    expect(html).toContain('aria-label="home-010, Not asked, at its floor, charge not reported, floor not reported"')
    const send = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes, orders: northOrders, tSeconds: 90, lens: "send", openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(send).not.toContain("zone-gauge")
  })

  it("trust lens marks stale, dead and unconfirmed homes and shows a mismatch", () => {
    const homes: FlowHome[] = [
      { ...live, id: "home-002", state: "stale" },
      { ...live, id: "home-006", state: "dead" },
      { ...live, id: "home-010", state: "unconfirmed" },
      { ...live, id: "home-014", state: "selling" },
    ]
    const html = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes, orders: { "home-014": sellMismatch }, tSeconds: 30, lens: "trust", tickMinutes: 5,
      openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(html).toContain(">Stale</span>")
    expect(html).toContain(">Dead</span>")
    expect(html).toContain(">Unconfirmed</span>")
    expect(html).toContain(">Reported 0.50 kWh, gave 0.25 kWh</span>")
    expect(html).toContain('aria-label="home-002, Not asked, stale"')
    expect(html).toContain("home-014, Confirmed, counted, Reported 0.50 kWh, gave 0.25 kWh")
    expect(html.match(/stroke-dasharray="3 4"/g)).toHaveLength(3)
  })

  it("counts a home with its own and a reassigned-in sell once, and keeps charge homes apart", () => {
    // Real heather tick 1, North (engine in-process, seed 42, HOME_MAX_KW=11.4, HOME_KWH=25): a mixed zone.
    // Charge orders are sent once and never reassigned (policy-intent.md), so a home's second unit is always a sell.
    const homes: FlowHome[] = [
      { ...live, id: "home-002", state: "charging", under_floor_why: "started_under" },
      { ...live, id: "home-006", state: "selling" },
      { ...live, id: "home-010", state: "charging", under_floor_why: "started_under" },
    ]
    const orders: Record<string, OrderTimelineEntry[]> = {
      "home-002": [[0, "sent", -11.4, "own"], [21, "exec", -11.4, "own"], [23.3, "conf", -11.4, "own"]],
      "home-006": [
        [0, "sent", 2.8650702804190176, "own"], [33.4, "exec", 2.8650702804190176, "own"], [50.2, "conf", 2.8650702804190176, "own"],
        [60, "sent", 2.86507, "r"], [92.4, "exec", 2.86507, "r"], [95.6, "conf", 2.86507, "r"],
      ],
      "home-010": [[0, "sent", -11.4, "own"], [30.9, "exec", -11.4, "own"], [38.6, "conf", -11.4, "own"]],
    }
    const s = zoneSummary("North", homes, orders, 100, 3)
    expect(s.sellHomes).toBe(1)
    expect(s.chargeHomes).toBe(2)
    expect(s.sellKw).toBeCloseTo(5.73014, 5)
    expect(s.chargeKw).toBeCloseTo(22.8, 9)
  })

  it("does not show an asked kW before the order is sent", () => {
    const timeline: OrderTimelineEntry[] = [[60, "sent", 0.97, "r"], [74.6, "exec", 0.97, "r"], [87.7, "conf", 0.97, "r"]]
    expect(askedText(timeline, 30)).toBe("Not yet")
    expect(askedText(timeline, 60)).toBe("0.97 kW")
    const home: FlowHome = { ...live, id: "home-003", zone: "Houston", state: "selling" }
    const orders = { "home-003": timeline, "home-071": [[60, "reassigned", "home-003", "own"]] as OrderTimelineEntry[] }
    const early = renderToStaticMarkup(createElement(HomePanel, { homeId: "home-003", home, orders, tSeconds: 30, onClose: () => {} }))
    // The tile waits for `sent`; the 0.97 kW appears only in the greyed (later) journey steps.
    expect(early).toContain('<p class="replay-label">Asked</p><p class="v">Not yet</p>')
    expect(early).not.toContain('<p class="v">0.97 kW</p>')
    expect(early).toContain('<div class="zone-step later"><span class="tm">1:00</span><span>Order sent: 0.97 kW')
    const later = renderToStaticMarkup(createElement(HomePanel, { homeId: "home-003", home, orders, tSeconds: 90, onClose: () => {} }))
    expect(later).toContain('<p class="replay-label">Asked</p><p class="v">0.97 kW</p>')
  })
})

// Real rows from the merged engine (in-process, seed 42, HOME_MAX_KW=11.4, HOME_KWH=25).
// heather tick 74, West: the planner saw home-012 as stale (plan_status), so it got no refill; the rest of West refilled.
const west74: FlowHome[] = [
  { id: "home-004", name: "West-Midland-004", zone: "West", county: "48329", county_name: "Midland", soc_pct: 33.8, soc_before_pct: 30.0,
    kw: -11.4, state: "charging", status: "live", floor_pct: 60.0, floor_reason: "storm_risk_high", under_floor_why: "floor_raised", plan_status: "live" },
  { id: "home-008", name: "West-Ector-008", zone: "West", county: "48135", county_name: "Ector", soc_pct: 33.8, soc_before_pct: 30.0,
    kw: -11.4, state: "charging", status: "live", floor_pct: 60.0, floor_reason: "storm_risk_high", under_floor_why: "floor_raised", plan_status: "live" },
  { id: "home-012", name: "West-TomGreen-012", zone: "West", county: "48451", county_name: "Tom Green", soc_pct: 52.0, soc_before_pct: 52.0,
    kw: 0.0, state: "below_floor", status: "live", floor_pct: 60.0, floor_reason: "storm_risk_high", under_floor_why: "floor_raised", plan_status: "stale" },
]
const west74Orders: Record<string, OrderTimelineEntry[]> = {
  "home-004": [[0, "sent", -11.4, "own"], [9.2, "exec", -11.4, "own"], [11.2, "conf", -11.4, "own"]],
  "home-008": [[0, "sent", -11.4, "own"], [31.2, "exec", -11.4, "own"], [44.1, "conf", -11.4, "own"]],
}
// operator-hold tick 4 (mode HOLD): nothing was sent, and home-002 sat under its floor.
const hold4Home: FlowHome = {
  id: "home-002", name: "North-Dallas-002", zone: "North", county: "48113", county_name: "Dallas", soc_pct: 23.52, soc_before_pct: 23.52,
  kw: 0.0, state: "below_floor", status: "live", floor_pct: 30.0, floor_reason: "normal", under_floor_why: "started_under", plan_status: "live",
}

describe("why a home got no order names the real cause (Task 12: W2, W5)", () => {
  it("an operator hold, a stale plan, or an under-floor home with no refill", () => {
    expect(notAskedReason(hold4Home, "HOLD")).toBe("Operator hold: no orders this tick.")
    expect(notAskedReason(west74[2], "AUTO")).toBe("No fresh reading, so no order.")
    // No longer "keeps it all for backup": a live under-floor home refills unless something stopped it.
    expect(notAskedReason(hold4Home, "AUTO")).toBe("Under its floor (started under it) and got no refill order this tick.")
    expect(notAskedReason({ ...west74[2], plan_status: "live" })).toBe("Under its floor (the floor rose) and got no refill order this tick.")
    expect(notAskedReason({ ...hold4Home, under_floor_why: null })).toBe("Under its floor and got no refill order this tick.")
    expect(notAskedReason({ ...hold4Home, state: "at_floor", under_floor_why: null })).toBe("Its charge is at its floor, so it keeps it all for backup.")
    // A home the planner did not see as live is named so whatever its state.
    expect(notAskedReason({ ...west74[2], state: "holding", under_floor_why: null, plan_status: "dead" })).toBe("No fresh reading, so no order.")
  })

  it("labels a stale-plan lot and an under-floor lot apart from a lot at its floor", () => {
    expect(notAskedLabel(west74[2])).toBe("No fresh reading, so no order")
    expect(notAskedLabel(hold4Home)).toBe("Not asked, under its floor")
    expect(notAskedLabel({ ...hold4Home, state: "at_floor" })).toBe("Not asked, at its floor")
    // An older worker sends no plan_status: the home reads by its state.
    const { plan_status: _p, ...old } = west74[2]
    expect(notAskedLabel(old)).toBe("Not asked, under its floor")
    const html = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "West", homes: west74, orders: west74Orders, tSeconds: 120, lens: "send", openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(html).toContain('aria-label="home-012, No fresh reading, so no order"')
  })

  it("the home panel reads the stale plan and the hold, not a choice to keep energy", () => {
    const stale = renderToStaticMarkup(createElement(HomePanel, {
      homeId: "home-012", home: west74[2], orders: west74Orders, tSeconds: 120, mode: "AUTO", onClose: () => {},
    }))
    expect(stale).toContain("No fresh reading, so no order")
    expect(stale).toContain("Not asked this tick. No fresh reading, so no order.")
    expect(stale).not.toContain("keeps it all for backup")
    const hold = renderToStaticMarkup(createElement(HomePanel, {
      homeId: "home-002", home: hold4Home, orders: {}, tSeconds: 120, mode: "HOLD", onClose: () => {},
    }))
    expect(hold).toContain("Not asked this tick. Operator hold: no orders this tick.")
  })

  it("the zone panel counts a stale-plan home and an under-floor home apart from 'at their floor'", () => {
    const s = zoneSummary("West", west74, west74Orders, 120, 2)
    expect(s.notAskedAtFloor).toBe(0)
    expect(s.notAskedNoReading).toBe(1)
    expect(s.notAskedUnderFloor).toBe(0)
    const html = renderToStaticMarkup(createElement(ZonePanel, {
      zone: "West", homes: west74, orders: west74Orders, tick: { mode: "AUTO", breaches: 0 } as never, tSeconds: 120,
    }))
    expect(html).toContain("<span>Not asked, no fresh reading</span><b>1 home</b>")
    expect(html).toContain("<span>Not asked, at their floor</span><b>0 homes</b>")

    const north = [hold4Home, { ...hold4Home, id: "home-006", soc_pct: 30, state: "at_floor" as const, under_floor_why: null }]
    const held = zoneSummary("North", north, {}, 120, 0)
    expect(held).toMatchObject({ notAskedAtFloor: 1, notAskedUnderFloor: 1, notAskedNoReading: 0 })
    const heldHtml = renderToStaticMarkup(createElement(ZonePanel, {
      zone: "North", homes: north, orders: {}, tick: { mode: "HOLD", breaches: 0 } as never, tSeconds: 120,
    }))
    expect(heldHtml).toContain("Operator hold: no orders this tick.")
    expect(heldHtml).toContain("<span>Not asked, under their floor</span><b>1 home</b>")
  })

  it("the Replay page hands the tick's mode to the home panel", () => {
    const session = {
      status: "paused", error: null, updated_at: "", scenario: null, seed: 42, speed: 60, speeds: [15, 60, 300], step_seconds: 2,
      tick_minutes: 5, tick_index: 4, tick_count: 61, start: {}, tick: { tick: 4, mode: "HOLD", breaches: 0 }, homes: [hold4Home], orders: {},
      zones: {}, charging_mw: 0, provenance: null, alerts: [], grid_down_zones: [], history: [], totals: null, log: [], honest_limits: [],
    }
    const html = renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: null, state: session as never, nowMs: 0, selectedZone: "North", selectedHome: "home-002",
    }))
    expect(html).toContain("Not asked this tick. Operator hold: no orders this tick.")
  })
})

// heather tick 1, North (merged engine): home-002 started under its 30% floor and refilled at full power.
const refill1: FlowHome = {
  id: "home-002", name: "North-Dallas-002", zone: "North", county: "48113", county_name: "Dallas", soc_pct: 15.92, soc_before_pct: 12.12,
  kw: -11.4, state: "charging", status: "live", floor_pct: 30.0, floor_reason: "normal", under_floor_why: "started_under", plan_status: "live",
}
const refill1Orders: Record<string, OrderTimelineEntry[]> = {
  "home-002": [[0, "sent", -11.4, "own"], [21, "exec", -11.4, "own"], [23.3, "conf", -11.4, "own"]],
}

describe("a battery refilling to its floor says so (Task 12: W4)", () => {
  it("names why it is under its floor", () => {
    expect(refillLine(refill1)).toBe("Refilling to its backup floor (started under it)")
    expect(refillLine(west74[0])).toBe("Refilling to its backup floor (the floor rose)")
    expect(refillLine({ ...refill1, under_floor_why: "something_new" as never })).toBe("Refilling to its backup floor (under its floor)")
    expect(refillLine({ ...refill1, under_floor_why: null })).toBeNull()
    expect(refillLine({ ...refill1, state: "selling" })).toBeNull()
  })

  it("shows the line on the home panel and names the lot", () => {
    const html = renderToStaticMarkup(createElement(HomePanel, {
      homeId: "home-002", home: refill1, orders: refill1Orders, tSeconds: 30, mode: "AUTO", onClose: () => {},
    }))
    expect(html).toContain("Refilling to its backup floor (started under it).")
    expect(lotLook(refill1, refill1Orders["home-002"], 30, false).label).toBe("Charging to its floor")
    expect(lotLook(refill1, refill1Orders["home-002"], 22, false).label).toBe("Charging to its floor, waiting for its report")
    expect(lotLook(refill1, refill1Orders["home-002"], 5, false).label).toBe("Order on its way")
    // A charge that does not leave the battery under its floor keeps the plain label.
    expect(lotLook({ ...refill1, under_floor_why: null }, refill1Orders["home-002"], 30, false).label).toBe("Charge confirmed")
    const board = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes: [refill1], orders: refill1Orders, tSeconds: 30, lens: "send", openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(board).toContain('aria-label="home-002, Charging to its floor"')
  })
})

describe("a home says why its floor is what it is (Task 12 / #47: W3)", () => {
  const home = (id: string) => berylHoustonHomes22.find((h) => h.id === id) as FlowHome

  it("names the county floor reason on the home panel", () => {
    const fortBend = renderToStaticMarkup(createElement(HomePanel, {
      homeId: "home-005", home: home("home-005"), orders: berylHoustonOrders22, tSeconds: 120, mode: "AUTO", onClose: () => {},
    }))
    expect(fortBend).toContain("Backup floor 30% this tick. County not named by the alert (base floor).")
    const harris = renderToStaticMarkup(createElement(HomePanel, {
      homeId: "home-021", home: home("home-021"), orders: berylHoustonOrders22, tSeconds: 120, mode: "AUTO", onClose: () => {},
    }))
    expect(harris).toContain("Backup floor 60% this tick. NWS alert, JEV yes.")
  })

  it("says what raised a reserved home's floor", () => {
    expect(notAskedReason(home("home-021"), "AUTO")).toBe("Its floor was raised (NWS alert, JEV yes), so it keeps its energy for backup.")
    const { floor_reason: _r, ...old } = home("home-021")
    expect(notAskedReason(old, "AUTO")).toBe("Its floor was raised, so it keeps its energy for backup.")
  })
})

describe("a reserved home well above its floor is kept for backup, not at its floor (Task 12 / #47: W4)", () => {
  // beryl tick 22: home-021 (Harris) is full at 100% on a 60% floor and got no order.
  const home021 = berylHoustonHomes22.find((h) => h.id === "home-021") as FlowHome

  it("labels the lot kept for backup", () => {
    expect(notAskedLabel(home021)).toBe("Not asked, kept for backup")
    expect(lotLook(home021, undefined, 120, false).label).toBe("Not asked, kept for backup")
  })

  it("counts reserved homes in their own zone panel row", () => {
    const s = zoneSummary("Houston", berylHoustonHomes22, berylHoustonOrders22, 120, 5)
    expect(s.notAskedReserved).toBe(4)
    expect(s.notAskedAtFloor).toBe(0)
    expect(s.notAskedOther).toBe(16)
    const html = renderToStaticMarkup(createElement(ZonePanel, {
      zone: "Houston", homes: berylHoustonHomes22, orders: berylHoustonOrders22, tick: { mode: "AUTO", breaches: 0 } as never, tSeconds: 120,
    }))
    expect(html).toContain("<span>Not asked, kept for backup (floor raised)</span><b>4 homes</b>")
    expect(html).toContain("<span>Not asked, at their floor</span><b>0 homes</b>")
  })
})
