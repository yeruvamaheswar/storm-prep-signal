import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import geo from "../../geo/ercot-load-zones.json"
import type { FlowHome, HistoryPoint, OrderTimelineEntry } from "../src/features/flow/types"
import { NOT_REPORTED, sum } from "../src/features/replay/format"
import { LedgerDrawer, ledgerRow } from "../src/features/replay/LedgerDrawer"
import {
  chipLines, chipPlacement, insideRing, zoneActivity, zoneArcClass, zoneGeos, zoneGoes, zoneRaised,
} from "../src/features/replay/mapModel"
import { PlaybackBar, tickProgress } from "../src/features/replay/PlaybackBar"
import { berylHoustonHomes22, berylHoustonRow22, berylTick22 } from "./fixtures/beryl22"
import { ReplayPage } from "../src/features/replay/ReplayPage"

// Consistent with the engine: missed = target - delivered, and missed already includes unconfirmed.
const history: HistoryPoint[] = [
  { tick: 1, ts: "t1", target_mw: 0.2, delivered_mw: 0.15, charging_mw: 0, missed_mw: 0.05, unconfirmed_mw: 0.02, reasons: ["network_loss"], breaches: 0 },
  { tick: 2, ts: "t2", target_mw: 0.4, delivered_mw: 0.25, charging_mw: 0, missed_mw: 0.15, unconfirmed_mw: 0.05, reasons: ["storm_reserve"], breaches: 2 },
]

describe("format.sum", () => {
  it("returns Not reported when every value is missing, never 0", () => {
    expect(sum([])).toBe(NOT_REPORTED)
    expect(sum([undefined, null, undefined])).toBe(NOT_REPORTED)
  })
  it("sums only the reported values", () => {
    expect(sum([1, undefined, 2])).toBe(3)
    expect(sum([0, undefined])).toBe(0)
  })
})

describe("ledger rows", () => {
  it("asked = sold + not counted + not sold on every row (no double count)", () => {
    for (const point of history) {
      const row = ledgerRow(point)
      expect(row.asked).toBeCloseTo((row.sold ?? NaN) + (row.notCounted ?? NaN) + (row.notSold ?? NaN), 9)
    }
    expect(ledgerRow(history[1]).notSold).toBeCloseTo(0.1, 9)
  })

  it("leaves not sold and breaches unreported when their inputs are missing", () => {
    const row = ledgerRow({ tick: 3, ts: "t3", target_mw: 0.2, delivered_mw: 0.1, charging_mw: 0, missed_mw: 0.1 })
    expect(row.notSold).toBeUndefined()
    expect(row.breaches).toBeUndefined()
  })

  it("puts the not-sold reason in the why column", () => {
    expect(ledgerRow(history[1]).why).toContain("Kept for backup, floor raised")
    expect(ledgerRow(history[0]).why).toContain("Not sent, no spare energy above floors")
    expect(ledgerRow(history[0]).why).toContain("Network loss")
  })

  it("renders real breaches per row and in total, and a Not sold column", () => {
    const html = renderToStaticMarkup(createElement(LedgerDrawer, { title: "Ledger", history, onClose: () => {} }))
    expect(html).toContain(">Not sold<")
    expect(html).not.toContain(">Not sent<")
    expect(html).toContain('<td class="n">2</td>')
    expect(html).toMatch(/Backup breaches<\/p><b>2<\/b>/)
    expect(html).toContain("Not sold: 0.130 MW")
    expect(html).toContain("Not counted: 0.070 MW")
  })

  it("shows Not reported for breaches when history rows do not carry them", () => {
    const bare = history.map(({ breaches: _b, ...rest }) => rest)
    const html = renderToStaticMarkup(createElement(LedgerDrawer, { title: "Ledger", history: bare, onClose: () => {} }))
    expect(html).toMatch(/Backup breaches<\/p><b>Not reported<\/b>/)
    expect(html).not.toMatch(/<td class="n">0<\/td>/)
  })
})

// Real post-#41 history points (engine in-process, seed 42, HOME_MAX_KW=11.4; main-impact-audit.md S3).
// History points carry no mode; intent and intent_reason are copied from the tick (scenario.py, Task 12).
const heather74: HistoryPoint = {
  tick: 74, ts: "t74", target_mw: 0.2, delivered_mw: 0, charging_mw: 1.1286, missed_mw: 0.2, unconfirmed_mw: 0,
  reasons: ["storm_reserve", "reserve_refill", "homes_stale:1"], breaches: 0, intent: "charge", intent_reason: "reserve_refill",
}
const beryl1: HistoryPoint = {
  tick: 1, ts: "t1", target_mw: 0.02, delivered_mw: 0.02, charging_mw: 0.908, missed_mw: 0, unconfirmed_mw: 0,
  reasons: ["charging", "reserve_refill"], breaches: 0, intent: "charge", intent_reason: "grid_call_served",
}
const hold4: HistoryPoint = {
  tick: 4, ts: "t4", target_mw: 0.5477, delivered_mw: 0, charging_mw: 0, missed_mw: 0.5477, unconfirmed_mw: 0,
  reasons: ["operator_hold"], breaches: 0, intent: "hold", intent_reason: "operator_hold",
}
const realHistory = [beryl1, hold4, heather74]

describe("ledger on post-#41 history (B2, B3, W3)", () => {
  it("heather tick 74: the unsold call is kept for backup, never 'Not sent', and the refill is charged", () => {
    const row = ledgerRow(heather74)
    expect(row.why).toContain("Kept for backup, floor raised")
    expect(row.why).not.toContain("Not sent")
    expect(row.charged).toBe(1.1286)
    expect(row.sold).toBe(0)
  })

  it("an operator hold reads 'Not sent, operator hold' from the reason alone", () => {
    const row = ledgerRow(hold4)
    expect(row.why).toContain("Not sent, operator hold")
    expect(row.why).not.toContain("no spare energy")
  })

  it("names tick reasons with the shared reason copy", () => {
    const why = ledgerRow(heather74).why
    expect(why).toContain("Storm reserve raised")
    expect(why).toContain("Refilling batteries under their reserve floor")
    expect(why).toContain("1 home is stale")
    expect(why).not.toContain("Homes stale:1")
    expect(ledgerRow(beryl1).why).toContain("Charging on cheap power")
  })

  it("carries the tick's own intent label, and none when the point has no intent", () => {
    expect(ledgerRow(heather74).intent).toBe("Fleet did: Charge — refilled batteries under their floor")
    expect(ledgerRow(beryl1).intent).toBe("Fleet did: Charge — served the call, then charged")
    expect(ledgerRow(hold4).intent).toBe("Fleet did: Hold — operator hold")
    expect(ledgerRow(history[0]).intent).toBeUndefined()
  })

  it("heather tick 1, a mixed tick (merged engine, HOME_KWH=25): served, then charged; no cause for a 0.000 MW gap", () => {
    const heather1: HistoryPoint = {
      tick: 1, ts: "2024-01-15T07:00:00-06:00", target_mw: 0.2, delivered_mw: 0.19999999971958105, charging_mw: 0.246587997,
      missed_mw: 2.804189658256462e-10, unconfirmed_mw: 0, reserve_pct: 30, risk_level: "LOW",
      reasons: ["reserve_refill", "timed_out:2", "duplicates_ignored:1", "over_delivery:1"], breaches: 0,
      intent: "charge", intent_reason: "grid_call_served",
    }
    const row = ledgerRow(heather1)
    expect(row.intent).toBe("Fleet did: Charge — served the call, then charged")
    expect(row.charged).toBe(0.246587997)
    expect(row.why).not.toContain("Not sent")
    expect(row.why).not.toContain("Not sold")
    expect(row.why).toContain("Refilling batteries under their reserve floor")
  })

  it("leaves charged unreported when charging_mw is not a finite number", () => {
    expect(ledgerRow({ ...heather74, charging_mw: Number.NaN }).charged).toBeUndefined()
  })

  it("renders an amber Charged column and a run total kept apart from asked and sold", () => {
    const html = renderToStaticMarkup(createElement(LedgerDrawer, { title: "Ledger", history: realHistory, onClose: () => {} }))
    expect(html).toContain(">Charged<")
    expect(html).toContain('<td class="n is-charge">1.129 MW</td>')
    expect(html).toContain('<td class="n is-charge">0.908 MW</td>')
    expect(html).toMatch(/Charged from the grid over 3 ticks<\/p><b class="is-charge">2\.037 MW<\/b>/)
    // Asked 0.768 and sold 0.020 over the run; the 2.037 bought never enters either.
    expect(html).toMatch(/Asked over 3 ticks<\/p><b>0\.768 MW<\/b>/)
    expect(html).toMatch(/Sold and confirmed<\/p><b class="is-confirmed">0\.020 MW<\/b>/)
    expect(html).toContain("Fleet did: Hold — operator hold")
  })
})

const homes: FlowHome[] = [
  { id: "h1", zone: "North", soc_pct: 50, kw: 0, state: "selling", status: "ok", floor_pct: 30 },
  { id: "h2", zone: "North", soc_pct: 50, kw: 0, state: "selling", status: "ok", floor_pct: 30 },
  { id: "h3", zone: "South", soc_pct: 50, kw: 0, state: "selling", status: "ok", floor_pct: 30 },
]
const orders: Record<string, OrderTimelineEntry[]> = {
  h1: [[0, "sent", 3, "own"], [20, "exec", 3, "own"], [40, "conf", 2.5, "own"]],
  h2: [[0, "sent", 4, "own"], [0.5, "drop", null, "own"], [60, "retry", null, "own"], [70, "conf", 4, "own"]],
  h3: [[30, "sent", 2, "own"]],
}

describe("zone activity follows the playhead", () => {
  it("counts asked, confirmed and kW sold at tSeconds", () => {
    expect(zoneActivity("North", homes, orders, 0)).toMatchObject({ asked: 2, confirmed: 0, soldKw: 0, sent: true, dropped: false })
    expect(zoneActivity("North", homes, orders, 1)).toMatchObject({ dropped: true })
    expect(zoneActivity("North", homes, orders, 45)).toMatchObject({ confirmed: 1, soldKw: 2.5 })
    expect(zoneActivity("North", homes, orders, 120)).toMatchObject({ confirmed: 2, soldKw: 6.5 })
  })

  it("has no arc (sent) for a zone until its first sent", () => {
    expect(zoneActivity("South", homes, orders, 29).sent).toBe(false)
    expect(zoneActivity("South", homes, orders, 30).sent).toBe(true)
    expect(zoneActivity("West", homes, orders, 120).sent).toBe(false)
  })

  it("does not invent kW for a confirmed discharge with no kW on record", () => {
    const bare = { h1: [[0, "sent", 3, "own"], [40, "conf", null, "own"]] as OrderTimelineEntry[] }
    expect(zoneActivity("North", homes, bare, 120).soldKw).toBeUndefined()
    expect(chipLines("North", zoneActivity("North", homes, bare, 120), undefined, null, "send")[1]).toBe("kW sold not reported")
  })
})

describe("zone activity splits sell from charge (W1)", () => {
  // Heather tick 74 shape: every order in a zone can be a charge (negative planned kW), and a
  // zone can hold both. A single home never gets both in one tick (controller.py serve_then_charge).
  const zoneHomes: FlowHome[] = [
    { id: "c1", zone: "North", soc_pct: 40, kw: -11.4, state: "charging", status: "live", floor_pct: 60, under_floor_why: "floor_raised" },
    { id: "c2", zone: "North", soc_pct: 41, kw: -11.4, state: "charging", status: "live", floor_pct: 60, under_floor_why: "floor_raised" },
    { id: "s1", zone: "South", soc_pct: 70, kw: 2, state: "selling", status: "live", floor_pct: 30 },
    { id: "c3", zone: "South", soc_pct: 20, kw: -5, state: "charging", status: "live", floor_pct: 30, under_floor_why: "started_under" },
  ]
  const zoneOrders: Record<string, OrderTimelineEntry[]> = {
    c1: [[0, "sent", -11.4, "own"], [8, "exec", -11.4, "own"], [20, "conf", -11.4, "own"]],
    c2: [[0, "sent", -11.4, "own"], [9, "exec", -11.4, "own"], [25, "conf", -11.4, "own"]],
    s1: [[0, "sent", 2, "own"], [10, "exec", 2, "own"], [30, "conf", 2, "own"]],
    c3: [[0, "sent", -5, "own"], [12, "exec", -5, "own"], [40, "conf", -5, "own"]],
  }

  it("a charge-only zone reads as charging, not asked to sell, and its charges are not 'confirmed' sales", () => {
    const act = zoneActivity("North", zoneHomes, zoneOrders, 120)
    expect(act).toMatchObject({ askedSell: 0, askedCharge: 2, confirmed: 0, confirmedCharge: 2, soldKw: 0, chargedKw: 22.8 })
    expect(chipLines("North", act, undefined, null, "send")).toEqual(["2 homes charging", "22.8 kW charged"])
    expect(chipLines("North", act, undefined, null, "trust")).toEqual(["2 homes charging", "2 charge confirmed"])
    expect(zoneArcClass("send", act)).toBe("arc arc-charge")
    expect(zoneArcClass("trust", act)).toBe("arc arc-charge")
    expect(zoneGoes(act)).toBe(false)
  })

  it("a zone that sells and charges names both, and only the sale is sold or confirmed", () => {
    const act = zoneActivity("South", zoneHomes, zoneOrders, 120)
    expect(act).toMatchObject({ askedSell: 1, askedCharge: 1, confirmed: 1, confirmedCharge: 1, soldKw: 2, chargedKw: 5 })
    expect(chipLines("South", act, undefined, null, "send")).toEqual(["1 asked to sell · 1 charging", "2.0 kW sold"])
    expect(chipLines("South", act, undefined, null, "trust")).toEqual(["1 asked to sell · 1 charging", "1 confirmed · 1 charge confirmed"])
    expect(zoneArcClass("send", act)).toBe("arc arc-send")
    expect(zoneGoes(act)).toBe(true)
  })

  it("a sell-only zone keeps its wording and the blue send arc", () => {
    const act = zoneActivity("North", homes, orders, 120)
    expect(act).toMatchObject({ askedSell: 2, askedCharge: 0, confirmedCharge: 0 })
    expect(chipLines("North", act, undefined, null, "send")).toEqual(["2 homes asked", "6.5 kW sold"])
    expect(chipLines("North", act, undefined, null, "trust")).toEqual(["2 homes asked", "2 confirmed"])
    expect(zoneArcClass("send", act)).toBe("arc arc-send")
    expect(zoneArcClass("keep", act)).toBe("arc arc-keep")
    expect(zoneArcClass("trust", act)).toBe("arc arc-live")
    expect(zoneGoes(act)).toBe(true)
  })

  it("does not invent charged kW for a confirmed charge with no kW on record", () => {
    const bare = { c1: [[0, "sent", -11.4, "own"], [20, "conf", null, "own"]] as OrderTimelineEntry[] }
    const act = zoneActivity("North", zoneHomes, bare, 120)
    expect(act.chargedKw).toBeUndefined()
    expect(chipLines("North", act, undefined, null, "send")).toEqual(["1 home charging", "kW charged not reported"])
  })
})

describe("zone emphasis is data driven", () => {
  const tick = { zone_reserve_pct: { North: 60, South: 30 }, zone_reasons: { North: "storm_risk_high", South: "normal" } }
  it("marks a zone raised only above the reported base floor", () => {
    expect(zoneRaised("North", tick, 30)).toBe(true)
    expect(zoneRaised("South", tick, 30)).toBe(false)
    expect(zoneRaised("North", tick, undefined)).toBe(false)
    expect(zoneRaised("West", tick, 30)).toBe(false)
  })
  it("keep lens chip uses plain words, not a raw code", () => {
    const [floor, reason] = chipLines("North", null, undefined, tick, "keep")
    expect(floor).toBe("Floor 60%")
    expect(reason).toBe("Storm risk high")
  })

  it("keep lens names a floor range when the zone's counties keep different floors (Task 12 / #47: B2)", () => {
    // beryl tick 22: the Houston zone floor is 60% (its highest county), but only Harris's 5 homes keep 60%.
    expect(chipLines("Houston", null, berylHoustonRow22, berylTick22, "keep", berylHoustonHomes22))
      .toEqual(["Floor 30–60% by county", "Weather alert: 5 of 25 homes raised"])
    // Every home at the zone floor: the one floor, as before.
    const north = berylHoustonHomes22.map((home) => ({ ...home, zone: "North", floor_pct: 30 }))
    expect(chipLines("North", null, undefined, berylTick22, "keep", north)).toEqual(["Floor 30%", "Normal"])
    // No homes passed (or none in the zone): the zone floor alone.
    expect(chipLines("Houston", null, berylHoustonRow22, berylTick22, "keep")).toEqual(["Floor 60%", "Weather alert"])
    expect(chipLines("Houston", null, berylHoustonRow22, berylTick22, "keep", north)).toEqual(["Floor 60%", "Weather alert"])
  })
})

describe("map geometry", () => {
  it("anchors each zone's chip and dot cluster inside that zone", () => {
    const zones = zoneGeos(geo)
    expect(zones.map((z) => z.zone).sort()).toEqual(["Houston", "North", "South", "West"])
    for (const z of zones) expect(insideRing(z.anchor.lng, z.anchor.lat, z.ring)).toBe(true)
  })
  it("flips a chip below its cluster when it would cover the controller node", () => {
    expect(chipPlacement([500, 500], 20, [500, 440]).below).toBe(true)
    expect(chipPlacement([500, 500], 20, [900, 440]).below).toBe(false)
  })
})

describe("playback bar", () => {
  it("shows Tick N of M with no invented minimum", () => {
    expect(tickProgress({ tick_index: 3, tick_count: 10 })).toEqual({ label: "Tick 3 of 10", pct: 30 })
    expect(tickProgress({ tick_index: 1, tick_count: 2 })).toEqual({ label: "Tick 1 of 2", pct: 50 })
    expect(tickProgress(null)).toEqual({ label: "Tick not reported", pct: null })
  })
  it("has no tick buttons, and disables speeds when the catalog failed", () => {
    const html = renderToStaticMarkup(createElement(PlaybackBar, { state: null, tSeconds: 0, speedsAvailable: false, onSend: () => {} }))
    expect(html).not.toContain('aria-label="Tick"')
    expect(html).toContain("Tick not reported")
    expect(html.match(/disabled=""/g)?.length).toBe(4) // play plus three speeds
  })
})

describe("replay page states", () => {
  it("shows a POST error as an alert", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, { scenarios: null, state: null, nowMs: 0, postError: "Could not send \"play\": http 409." }))
    expect(html).toContain('role="alert"')
    expect(html).toContain("Could not send")
  })
  it("names an unreachable API separately from a stopped worker", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, { scenarios: null, state: null, nowMs: 0, apiDown: true }))
    expect(html).toContain("Cannot reach the ReserveGate API at")
    expect(html).not.toContain("The scenario worker is not running")
  })
  it("says the catalog failed instead of inventing one", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage, { scenarios: null, scenariosFailed: true, state: null, nowMs: 0 }))
    expect(html).toContain("Cannot load the scenario list from the API.")
  })
})

describe("drawers", () => {
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

  function button(name: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)
    if (!found) throw new Error(`no button ${name}`)
    return found
  }

  it("moves focus in, closes on Escape, returns focus, and opening one closes the other", async () => {
    await act(async () => {
      root.render(createElement(ReplayPage, { scenarios: null, state: null, nowMs: 0 }))
    })
    const openLedger = button("Open the ledger")
    openLedger.focus()
    await act(async () => openLedger.click())
    const ledger = host.querySelector('[aria-label="Ledger"]')
    expect(ledger).not.toBeNull()
    expect(document.activeElement).toBe(ledger)
    expect(host.querySelector('[aria-label="Close ledger"]')).not.toBeNull()

    await act(async () => button("About this data").click())
    expect(host.querySelector('[aria-label="Ledger"]')).toBeNull()
    expect(host.querySelector('[role="dialog"][aria-label="About this data"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Close about this data"]')).not.toBeNull()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button("About this data"))
  })
})
