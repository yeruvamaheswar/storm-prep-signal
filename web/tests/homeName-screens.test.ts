// Task 17: every screen names a home the engine's way (Zone-County-Number). Ids stay in data-home and URLs.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FlowHome, OrderTimelineEntry } from "../src/features/flow/types"
import { FleetPage } from "../src/features/fleet/FleetPage"
import { HomePage } from "../src/features/fleet/HomePage"
import type { FleetPageProps, Home } from "../src/features/fleet/types"
import { BatteryCell } from "../src/features/fleetgrid/BatteryCell"
import { HomeDetail } from "../src/features/fleetgrid/HomeDetail"
import { fromLiveRows, fromScenarioHomes, tileAria } from "../src/features/fleetgrid/fleetModel"
import { HomePanel } from "../src/features/replay/HomePanel"
import { feedLines } from "../src/features/replay/narrate"
import { ZoneBoard } from "../src/features/replay/ZoneBoard"
import { journeySteps, lotLook } from "../src/features/replay/zoneModel"

// Real scenario rows (server/engine/scenario.py home_row, default ZONES order, Houston first).
function engineHome(id: string, name: string, zone: string, county: string, countyName: string, extra: Partial<FlowHome> = {}): FlowHome {
  return { id, name, zone, county, county_name: countyName, soc_pct: 55, soc_before_pct: 60, kw: 0, state: "selling", status: "live", floor_pct: 30, ...extra }
}

const north: FlowHome[] = [
  engineHome("home-054", "North-Tarrant-054", "North", "48439", "Tarrant"),
  engineHome("home-062", "North-Denton-062", "North", "48121", "Denton"),
  engineHome("home-066", "North-Dallas-066", "North", "48113", "Dallas"),
  engineHome("home-098", "North-Dallas-098", "North", "48113", "Dallas"),
]
const northOrders: Record<string, OrderTimelineEntry[]> = {
  "home-054": [[0, "sent", 0.01], [9.4, "exec", 0.01], [9.4, "rdrop", null], [60, "retry", null], [74.8, "dup", null]],
  "home-062": [[0, "sent", 0.11], [0, "drop", null], [60, "retry", null], [77.1, "exec", 0.11], [93.3, "conf", 0.11]],
  "home-066": [[0, "sent", 2.11], [0, "drop", null], [60, "retry", null], [80.7, "exec", 2.11], [82.3, "conf", 2.11]],
  "home-098": [[0, "sent", 5], [0, "drop", null], [60, "retry", null], [78.6, "exec", 5], [80.8, "conf", 5]],
}

// Real reassignment shape: home-071 handed its order to home-003.
const south: FlowHome[] = [
  engineHome("home-003", "South-Nueces-003", "South", "48355", "Nueces", { kw: 1 }),
  engineHome("home-071", "South-Bexar-071", "South", "48029", "Bexar", { kw: 1 }),
]
const reassignOrders: Record<string, OrderTimelineEntry[]> = {
  "home-003": [[0, "sent", 0.97, "own"], [20.7, "exec", 0.97, "own"], [29.6, "conf", 0.97, "own"], [60, "sent", 0.97, "r"], [74.6, "exec", 0.97, "r"], [87.7, "conf", 0.97, "r"]],
  "home-071": [[0, "sent", 0.97, "own"], [48.8, "exec", 0.97, "own"], [60, "timeout", null, "own"], [60, "retry", null, "own"], [60, "reassigned", "home-003", "own"], [64.5, "conf", 0.97, "own"]],
}

describe("What happened feed", () => {
  it("names each home by its engine name", () => {
    const byId = Object.fromEntries(north.map((home) => [home.id, home]))
    const text = feedLines(northOrders, 120, byId, { breaches: 0 }).map((line) => line.x)
    expect(text).toContain("North-Tarrant-054's report was lost on the way back.")
    expect(text).toContain("North-Tarrant-054: a duplicate copy was ignored, so it did not run twice.")
    expect(text).toContain("North-Dallas-066 gave 2.11 kW.")
    expect(text).toContain("North-Dallas-066 confirmed. Counted.")
    expect(text.some((line) => /home-\d/.test(line))).toBe(false)
  })

  it("keeps the raw id for a home the session does not report", () => {
    const text = feedLines({ "home-077": [[0, "sent", 1], [5, "exec", 1]] }, 10, {}).map((line) => line.x)
    expect(text).toContain("home-077 gave 1.00 kW.")
  })
})

describe("Zone board", () => {
  it("names lots and story tags in visible and aria text, and keeps data-home on the id", () => {
    expect(lotLook(north[2], northOrders["home-066"], 90, false).aria).toBe("North-Dallas-066, Confirmed, counted")
    const html = renderToStaticMarkup(createElement(ZoneBoard, {
      zone: "North", homes: north, orders: northOrders, tSeconds: 90, lens: "send",
      openHome: null, onHome: () => {}, onBack: () => {},
    }))
    expect(html).toContain('aria-label="North-Dallas-066, Confirmed, counted"')
    expect(html).toContain('data-home="home-066"')
    expect(html).toContain("North-Dallas-098: Confirmed, counted")
    expect(html).toContain("North-Tarrant-054: Gave energy, waiting for its report")
    expect(html).not.toMatch(/class="zone-tag"[^>]*>home-/)
  })
})

describe("Home panel", () => {
  it("titles the panel with the engine name", () => {
    const html = renderToStaticMarkup(createElement(HomePanel, { homeId: "home-066", home: north[2], orders: northOrders, tSeconds: 90, onClose: () => {} }))
    expect(html).toContain("<h2>North-Dallas-066</h2>")
  })

  it("names the home a reassigned order came from and went to", () => {
    const took = renderToStaticMarkup(createElement(HomePanel, {
      homeId: "home-003", home: south[0], homes: south, orders: reassignOrders, tSeconds: 90, onClose: () => {},
    }))
    expect(took).toContain("Also took over South-Bexar-071&#x27;s order")
    expect(took).toContain("Taken over from South-Bexar-071")
    const gave = renderToStaticMarkup(createElement(HomePanel, {
      homeId: "home-071", home: south[1], homes: south, orders: reassignOrders, tSeconds: 90, onClose: () => {},
    }))
    expect(gave).toContain("Its order was handed to South-Nueces-003.")
  })

  it("journey steps name the receiving home when given a namer, and keep the id without one", () => {
    const steps = (nameOf?: (id: string) => string) => journeySteps(reassignOrders["home-071"], 90, undefined, nameOf).map((s) => s.x)
    expect(steps((id) => (id === "home-003" ? "South-Nueces-003" : id))).toContain("Its order was handed to South-Nueces-003.")
    expect(steps()).toContain("Its order was handed to home-003.")
  })
})

describe("Fleet grid", () => {
  const liveRow = {
    home_id: "home-005", name: "Houston-FortBend-005", status: "live", zone: "Houston", county: "48157", county_name: "Fort Bend",
    capacity_kwh: 25, soc_kwh: 15, floor_kwh: 7.5, max_kw: 11.4, assigned_kw: 0, charge_state: "HOLDING", power_kw: 0,
  }

  it("reads the API's name and uses it in the cell tooltip and aria label", () => {
    const [home] = fromLiveRows([liveRow])
    expect(home.name).toBe("Houston-FortBend-005")
    expect(tileAria(home)).toMatch(/^Houston-FortBend-005, Fort Bend County, /)
    const html = renderToStaticMarkup(createElement(BatteryCell, { home, dim: false, selected: false, found: false, onSelect: () => {} }))
    expect(html).toContain('title="Houston-FortBend-005"')
    expect(html).toContain('data-home="home-005"')
  })

  it("builds the name from zone and county when a row has none, and the detail panel uses it", () => {
    const { name: _name, ...rest } = liveRow
    const [home] = fromLiveRows([rest])
    expect(tileAria(home)).toMatch(/^Houston-FortBend-005, /)
    const html = renderToStaticMarkup(createElement(HomeDetail, { home, onClose: () => {} }))
    expect(html).toContain("<h2>Houston-FortBend-005</h2>")
  })

  it("scenario homes keep the engine name", () => {
    const [home] = fromScenarioHomes([north[0]])
    expect(tileAria(home)).toMatch(/^North-Tarrant-054, Tarrant County, /)
  })
})

describe("Fleet table", () => {
  const home: Home = {
    home_id: "home-005", name: "Houston-FortBend-005", status: "live", zone: "Houston", county_name: "Fort Bend",
    capacity_kwh: 25, soc_kwh: 15, floor_kwh: 7.5, max_kw: 11.4, assigned_kw: 0, eligible: true, skip_reason: null,
    last_seen: "2026-09-27T12:00:00+00:00", last_command: null, charge_state: "HOLDING", power_kw: 0,
  }

  function page(overrides: Partial<FleetPageProps>): string {
    return renderToStaticMarkup(createElement(FleetPage, {
      homes: [home], statusFilter: "all", zoneFilter: "all", query: "", offset: 0, limit: 50, hasMore: false,
      onFilter: () => undefined, onZone: () => undefined, onQuery: () => undefined, onPage: () => undefined, onOpenHome: () => undefined,
      ...overrides,
    }))
  }

  it("a single home is named, never 'Home N'", () => {
    const html = page({})
    expect(html).toContain(">Houston-FortBend-005<")
    expect(html).not.toMatch(/>Home \d/)
  })

  it("a range of many homes keeps its numbers", () => {
    const html = page({ homes: [home, { ...home, home_id: "home-009", name: "Houston-Brazoria-009" }] })
    expect(html).toContain("Homes 1–2")
  })

  it("the home page titles the home by name", () => {
    const html = renderToStaticMarkup(createElement(HomePage, { home, onBack: () => undefined }))
    expect(html).toContain("Houston-FortBend-005")
  })
})
