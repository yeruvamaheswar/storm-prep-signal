import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import geo from "../../geo/ercot-load-zones.json"
import type { FlowHome, HistoryPoint, OrderTimelineEntry } from "../src/features/flow/types"
import { NOT_REPORTED, sum } from "../src/features/replay/format"
import { LedgerDrawer, ledgerRow } from "../src/features/replay/LedgerDrawer"
import {
  chipLines, chipPlacement, insideRing, zoneActivity, zoneGeos, zoneRaised,
} from "../src/features/replay/mapModel"
import { PlaybackBar, tickProgress } from "../src/features/replay/PlaybackBar"
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
    // Task 11 replaced the three speed buttons with one slider and added Next tick.
    expect(html.match(/disabled=""/g)?.length).toBe(3) // play, next tick, speed slider
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
