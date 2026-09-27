import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FlowHome } from "../src/features/flow/types"
import { FleetGridPage, type FleetGridPageProps } from "../src/features/fleetgrid/FleetGridPage"
import {
  NOT_REPORTED, cellGeometry, cellLook, filterCounts, findHome, floorLegend, fromLiveRows, fromScenarioHomes,
  errorText, focusZoneFromSearch, isUnderFloor, otherNote, liveSourceNote, matchesFilter, scenarioSourceNote, nowText, pctLabel, replayHref, shortId, shortState, statusLabel, zoneBanks,
  type GridHome,
} from "../src/features/fleetgrid/fleetModel"

// Rows shaped like GET /v1/homes (server/api/homes.py as_console_home), one of each case.
const liveRows = [
  // live, 82% on a 30% floor, selling 3.2 kW
  { home_id: "home-001", status: "live", zone: "Houston", capacity_kwh: 20, soc_kwh: 16.4, floor_kwh: 6, max_kw: 5,
    assigned_kw: 3.2, charge_state: "DISCHARGING", power_kw: 3.2 },
  // live, under floor: 25% on a 30% floor
  { home_id: "home-002", status: "live", zone: "North", capacity_kwh: 20, soc_kwh: 5, floor_kwh: 6, max_kw: 5,
    assigned_kw: 0, charge_state: "HOLDING", power_kw: 0 },
  // live, exactly at the floor: not under
  { home_id: "home-003", status: "live", zone: "North", capacity_kwh: 20, soc_kwh: 6, floor_kwh: 6, max_kw: 5,
    assigned_kw: 0, charge_state: "HOLDING", power_kw: 0 },
  // stale, under its floor but the reading is old: counted as stale, not under floor
  { home_id: "home-004", status: "stale", zone: "West", capacity_kwh: 20, soc_kwh: 2, floor_kwh: 6, max_kw: 5,
    assigned_kw: 0, charge_state: null, power_kw: null },
  // dead = offline
  { home_id: "home-005", status: "dead", zone: "South", capacity_kwh: 13.5, soc_kwh: 4.2, floor_kwh: 6, max_kw: 5,
    assigned_kw: 0 },
  // live, missing charge and floor
  { home_id: "home-006", status: "live", zone: "Houston", capacity_kwh: 20, soc_kwh: null, max_kw: 5, assigned_kw: 0 },
  // live, charging, no zone reported
  { home_id: "home-007", status: "live", zone: null, capacity_kwh: 20, soc_kwh: 10, floor_kwh: 6, max_kw: 5,
    assigned_kw: -2.5, charge_state: "CHARGING", power_kw: -2.5 },
  // unconfirmed: not live, stale or offline
  { home_id: "home-008", status: "unconfirmed", zone: "West", capacity_kwh: 20, soc_kwh: 11.2, floor_kwh: 12, max_kw: 5,
    assigned_kw: 0 },
]

const homes = fromLiveRows(liveRows)
const byId = (id: string) => homes.find((h) => h.id === id) as GridHome

describe("fromLiveRows", () => {
  it("keeps every row and derives charge and floor from kWh over capacity", () => {
    expect(homes).toHaveLength(8)
    expect(byId("home-001").socPct).toBeCloseTo(82)
    expect(byId("home-001").floorPct).toBeCloseTo(30)
    expect(byId("home-005").socPct).toBeCloseTo(31.11, 1)
    expect(byId("home-001").action).toBe("selling")
    expect(byId("home-001").kw).toBeCloseTo(3.2)
    expect(byId("home-007").action).toBe("charging")
  })

  it("maps dead to offline and keeps unconfirmed apart", () => {
    expect(byId("home-005").status).toBe("offline")
    expect(byId("home-004").status).toBe("stale")
    expect(byId("home-008").status).toBe("other")
    expect(statusLabel(byId("home-008"))).toBe("Unconfirmed")
  })

  it("never invents a missing charge, floor or zone", () => {
    const h = byId("home-006")
    expect(h.socPct).toBeNull()
    expect(h.floorPct).toBeNull()
    expect(h.action).toBeNull()
    expect(byId("home-007").zone).toBeNull()
    expect(fromLiveRows([{ home_id: "x", status: "live", capacity_kwh: 0, soc_kwh: 5, floor_kwh: 1 }])[0].socPct).toBeNull()
  })

  it("drops rows with no id and a non-array body", () => {
    expect(fromLiveRows([{ status: "live" }, null, 3])).toEqual([])
    expect(fromLiveRows({ detail: "nope" })).toEqual([])
  })
})

describe("fromScenarioHomes", () => {
  it("reads soc_pct, floor_pct and the engine state", () => {
    const flow: FlowHome[] = [
      { id: "home-010", zone: "North", soc_pct: 64, kw: 4, state: "selling", status: "live", floor_pct: 30 },
      { id: "home-011", zone: "South", soc_pct: 40, kw: -2.2, state: "charging", status: "live", floor_pct: 60, under_floor_why: "floor_raised" },
      { id: "home-012", zone: "West", soc_pct: 30, kw: 0, state: "at_floor", status: "live", floor_pct: 30 },
      { id: "home-013", zone: "Houston", soc_pct: 50, kw: 0, state: "dead", status: "dead", floor_pct: 30 },
      { id: "home-014", zone: "Houston", soc_pct: 50, kw: 0, state: "stale", status: "stale", floor_pct: 30 },
    ]
    const grid = fromScenarioHomes(flow)
    expect(grid.map((h) => h.status)).toEqual(["live", "live", "live", "offline", "stale"])
    expect(grid.map((h) => h.action)).toEqual(["selling", "charging", "holding", null, null])
    expect(grid[1].floorPct).toBe(60)
    expect(isUnderFloor(grid[1])).toBe(true)
    expect(isUnderFloor(grid[2])).toBe(false)
  })
})

describe("a home the planner treated as stale does not read as live (Task 12: W5)", () => {
  // Real heather tick 74 row (merged engine, seed 42, HOME_MAX_KW=11.4, HOME_KWH=25): the engine's home is live,
  // but the reading the planner used was stale, so it got no refill order.
  const row: FlowHome = {
    id: "home-012", name: "West-TomGreen-012", zone: "West", county: "48451", county_name: "Tom Green", soc_pct: 52.0, soc_before_pct: 52.0,
    kw: 0.0, state: "below_floor", status: "live", floor_pct: 60.0, floor_reason: "storm_risk_high", under_floor_why: "floor_raised", plan_status: "stale",
  }

  it("says no fresh reading, so no order, with the stale look", () => {
    const [h] = fromScenarioHomes([row])
    expect(h.planStale).toBe(true)
    expect(h.action).toBeNull()
    expect(nowText(h)).toBe("No fresh reading, so no order")
    expect(shortState(h)).toBe("No fresh reading")
    expect(cellLook(h).fill).toBe("var(--rg-not-counted)")
    expect(cellLook(h).dash).toBe("4 3")
    // Its status is still the engine's: it counts as live, and its charge really is under its floor.
    expect(matchesFilter(h, "live")).toBe(true)
    expect(isUnderFloor(h)).toBe(true)
  })

  it("a live plan, or no plan_status from an older worker, reads as before", () => {
    const [live] = fromScenarioHomes([{ ...row, plan_status: "live" }])
    expect(live.planStale).toBe(false)
    expect(nowText(live)).toBe("Under its floor, holding")
    const { plan_status: _p, ...old } = row
    expect(fromScenarioHomes([old])[0].planStale).toBe(false)
    expect(fromLiveRows(liveRows).every((h) => h.planStale === false)).toBe(true)
  })
})

describe("a battery charging back to its floor says so (Task 12: W4)", () => {
  it("heather tick 1 home-002: charging, still under its 30% floor", () => {
    const [h] = fromScenarioHomes([{
      id: "home-002", name: "North-Dallas-002", zone: "North", county: "48113", county_name: "Dallas", soc_pct: 15.92, soc_before_pct: 12.12,
      kw: -11.4, state: "charging", status: "live", floor_pct: 30.0, floor_reason: "normal", under_floor_why: "started_under", plan_status: "live",
    }])
    expect(nowText(h)).toBe("Charging back to its floor")
    expect(shortState(h)).toBe("Charging 11.4")
    // Charging above its floor reads as before.
    expect(nowText({ ...h, socPct: 45 })).toBe("Charging 11.4 kW")
  })
})

describe("filter counts", () => {
  it("counts each filter from the loaded homes and All is the real total", () => {
    const counts = filterCounts(homes)
    expect(counts).toEqual({ all: 8, live: 5, stale: 1, offline: 1, below: 1 })
    // Live + stale + offline + other adds up to All.
    const other = homes.filter((h) => h.status === "other").length
    expect(counts.live + counts.stale + counts.offline + other).toBe(counts.all)
  })

  it("under floor needs a reported charge below a reported floor on a live home", () => {
    expect(homes.filter(isUnderFloor).map((h) => h.id)).toEqual(["home-002"])
    expect(matchesFilter(byId("home-006"), "below")).toBe(false)
    expect(matchesFilter(byId("home-004"), "below")).toBe(false)
    expect(matchesFilter(byId("home-004"), "stale")).toBe(true)
    expect(matchesFilter(byId("home-008"), "all")).toBe(true)
    expect(matchesFilter(byId("home-008"), "live")).toBe(false)
  })

  it("counts zero homes as zeros", () => {
    expect(filterCounts([])).toEqual({ all: 0, live: 0, stale: 0, offline: 0, below: 0 })
  })
})

describe("short labels", () => {
  it("short id drops the home- prefix", () => {
    expect(shortId("home-066")).toBe("066")
    expect(shortId("house-9")).toBe("house-9")
  })

  it("percent label rounds, says off for offline and Not reported when missing", () => {
    expect(pctLabel(byId("home-001"))).toBe("82%")
    expect(pctLabel(byId("home-005"))).toBe("off")
    expect(pctLabel(byId("home-006"))).toBe(NOT_REPORTED)
    expect(NOT_REPORTED).toBe("Not reported")
  })

  it("short state follows the mockup wording", () => {
    expect(shortState(byId("home-001"))).toBe("Selling 3.2")
    expect(shortState(byId("home-007"))).toBe("Charging 2.5")
    expect(shortState(byId("home-002"))).toBe("Under floor")
    expect(shortState(byId("home-003"))).toBe("Holding")
    expect(shortState(byId("home-004"))).toBe("No reading")
    expect(shortState(byId("home-005"))).toBe("Offline")
    expect(shortState(byId("home-006"))).toBe(NOT_REPORTED)
    expect(shortState(byId("home-008"))).toBe("Unconfirmed")
  })

  it("right now text for the detail panel", () => {
    expect(nowText(byId("home-001"))).toBe("Selling 3.2 kW")
    expect(nowText(byId("home-007"))).toBe("Charging 2.5 kW")
    expect(nowText(byId("home-002"))).toBe("Under its floor, holding")
    expect(nowText(byId("home-005"))).toBe("Offline, gets no work")
    expect(nowText(byId("home-004"))).toBe("No reading")
    expect(nowText(byId("home-006"))).toBe(NOT_REPORTED)
  })
})

describe("cell geometry", () => {
  const cell = (socPct: number | null, floorPct: number | null, status: GridHome["status"] = "live") =>
    cellGeometry({ id: "home-1", zone: "North", status, rawStatus: status, socPct, floorPct, kw: 0, action: "holding" })

  it("fills from the bottom of the 50 px well to the charge", () => {
    expect(cell(100, 30)).toMatchObject({ fillY: 5, fillH: 50 })
    expect(cell(50, 30)).toMatchObject({ fillY: 30, fillH: 25 })
    expect(cell(82, 30).fillH).toBeCloseTo(41)
    // A tiny charge still shows a 3 px sliver, like the mockup.
    expect(cell(2, 30)).toMatchObject({ fillY: 52, fillH: 3 })
    expect(cell(140, 30)).toMatchObject({ fillY: 5, fillH: 50 })
  })

  it("puts the floor line at the floor", () => {
    expect(cell(50, 60).floorY).toBe(25)
    expect(cell(50, 30).floorY).toBe(40)
    expect(cell(50, 0).floorY).toBe(55)
  })

  it("draws no fill and no floor when not reported, and no fill offline", () => {
    expect(cell(null, null)).toEqual({ fillY: null, fillH: null, floorY: null })
    expect(cell(null, 30)).toEqual({ fillY: null, fillH: null, floorY: 40 })
    expect(cell(70, 30, "offline")).toMatchObject({ fillY: null, fillH: null })
  })

  it("colours by state like the mockup", () => {
    expect(cellLook(byId("home-001")).fill).toBe("var(--rg-order-way)")
    expect(cellLook(byId("home-007")).fill).toBe("var(--rg-charging)")
    expect(cellLook(byId("home-002")).fill).toBe("var(--rg-fleet-under)")
    expect(cellLook(byId("home-003")).fill).toBe("var(--rg-confirmed)")
    expect(cellLook(byId("home-004")).fill).toBe("var(--rg-not-counted)")
    expect(cellLook(byId("home-004")).dash).toBe("4 3")
    expect(cellLook(byId("home-005")).shell).toBe("var(--rg-fleet-off-shell)")
    expect(cellLook(byId("home-001")).dash).toBe("none")
  })
})

describe("banks, search, legend and links", () => {
  it("groups homes into the four zones in mockup order and keeps unzoned homes", () => {
    const banks = zoneBanks(homes)
    expect(banks.map((b) => b.name)).toEqual(["North", "Houston", "West", "South", "Zone not reported"])
    expect(banks.reduce((n, b) => n + b.homes.length, 0)).toBe(homes.length)
    expect(banks[0].note).toBe("1 under floor")
    expect(banks[2].note).toBe("2 not answering, 0 under floor")
    expect(zoneBanks(homes.filter((h) => h.zone !== null)).map((b) => b.name)).toEqual(["North", "Houston", "West", "South"])
  })

  it("finds a home by full id, by number and by part", () => {
    expect(findHome(homes, "home-004")?.id).toBe("home-004")
    expect(findHome(homes, "  HOME-004 ")?.id).toBe("home-004")
    expect(findHome(homes, "7")?.id).toBe("home-007")
    expect(findHome(homes, "007")?.id).toBe("home-007")
    expect(findHome(homes, "")).toBeNull()
    expect(findHome(homes, "home-999")).toBeNull()
  })

  it("links a home into Replay by zone and id", () => {
    expect(replayHref(byId("home-002"))).toBe("/?zone=North&home=home-002")
    expect(replayHref(byId("home-007"))).toBe("/?home=home-007")
  })

  it("names the floor only when the homes report one", () => {
    expect(floorLegend(fromScenarioHomes([
      { id: "a", zone: "North", soc_pct: 50, kw: 0, state: "holding", status: "live", floor_pct: 60 },
      { id: "b", zone: "North", soc_pct: 50, kw: 0, state: "holding", status: "live", floor_pct: 60 },
    ]))).toBe("Backup floor, 60% now")
    expect(floorLegend(homes)).toBe("Backup floor, 30% to 60% now")
    expect(floorLegend([byId("home-006")])).toBe("Backup floor, not reported")
  })
})

describe("FleetGridPage", () => {
  const base: FleetGridPageProps = {
    source: "live", homes, loading: false, error: null, sourceNote: "Live homes", filter: "all", selectedId: null,
    foundId: null, focusZone: null, query: "",
    onSource: () => {}, onFilter: () => {}, onSelect: () => {}, onQuery: () => {}, onFind: () => {},
  }
  const render = (over: Partial<FleetGridPageProps>) => renderToStaticMarkup(createElement(FleetGridPage, { ...base, ...over }))

  it("shows the filters with counts and the note", () => {
    const html = render({})
    for (const label of ["All 8", "Live 5", "Stale 1", "Offline 1", "Under floor 1"]) expect(html).toContain(label)
    expect(html).toContain("Batteries are simulated. The fill is each battery&#x27;s real charge from the engine; the dashed line is the floor it keeps for backup.")
    expect(html).toContain("How to read a battery")
    expect(html).toContain("8 homes")
  })

  it("draws the Base cell with the mockup geometry", () => {
    const html = render({})
    expect(html).toContain('width="36" height="60" viewBox="0 0 36 60"')
    expect(html).toContain('rx="8"')
    expect(html).toContain('stroke-width="2.2"')
    expect(html).toContain('rx="4.5"')
    expect(html).toContain(">BASE</text>")
    expect(html).toContain('paint-order="stroke"')
  })

  it("highlights the ?zone= bank", () => {
    const html = render({ focusZone: "West" })
    expect(html).toMatch(/class="fg-bank is-focus"[^>]*aria-label="West zone"/)
    expect(html).not.toMatch(/class="fg-bank is-focus"[^>]*aria-label="North zone"/)
  })

  it("shows a skeleton while loading, never No homes", () => {
    const html = render({ homes: null, loading: true })
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain("No homes")
  })

  it("says so plainly on an error and on an empty load", () => {
    expect(render({ homes: null, error: "http 500" })).toContain("Could not load homes: http 500")
    expect(render({ homes: [] })).toContain("No homes")
  })

  it("opens the detail panel with the Replay link and Not reported fallbacks", () => {
    const html = render({ selectedId: "home-006" })
    expect(html).toContain('aria-label="Home detail"')
    expect(html).toContain('href="/?zone=Houston&amp;home=home-006"')
    expect(html).toContain("Open in Replay")
    expect(html).toContain("Not reported")
    const cell = render({}).split('aria-label="home-006')[1].split("</button>")[0]
    // No fill rect and no floor line for a home that reports neither.
    expect(cell.match(/<rect/g)).toHaveLength(2)
    expect(cell).not.toContain("<line")
  })

  it("marks the found home", () => {
    expect(render({ foundId: "home-003" })).toMatch(/class="fg-tile[^"]*\bhit\b[^"]*"[^>]*aria-label="home-003/)
  })
})

describe("URL zone and source notes", () => {
  it("reads a known zone from ?zone= and ignores anything else", () => {
    expect(focusZoneFromSearch("?zone=North")).toBe("North")
    expect(focusZoneFromSearch("?zone=Houston&home=home-004")).toBe("Houston")
    expect(focusZoneFromSearch("?zone=Mars")).toBeNull()
    expect(focusZoneFromSearch("")).toBeNull()
  })

  it("says where the homes came from", () => {
    expect(liveSourceNote(3)).toBe("Live homes from the local API (GET /v1/homes).")
    expect(liveSourceNote(200)).toBe("Live homes from the local API (GET /v1/homes), the first 200 only.")
    expect(scenarioSourceNote({ scenario: { name: "Faults at the peak" }, tick_index: 12, tick_count: 181, status: "playing" }))
      .toBe("Scenario: Faults at the peak, tick 12 of 181, playing.")
    expect(scenarioSourceNote({ scenario: null, tick_index: 0, tick_count: 0, status: "idle" })).toBe("Scenario: none started yet.")
  })
})

describe("fix round 1", () => {
  const flow = (id: string, state: string, soc = 70, floor = 30): FlowHome =>
    ({ id, zone: "North", soc_pct: soc, kw: 0, state, status: "live", floor_pct: floor }) as FlowHome

  it("gives islanded and reserved their own words and colours, never Holding", () => {
    const [isl, res] = fromScenarioHomes([flow("home-1", "islanded"), flow("home-2", "reserved")])
    expect(isl.action).toBe("islanded")
    expect(shortState(isl)).toBe("Islanded")
    expect(nowText(isl)).toBe("Islanded: backing up its own home")
    expect(cellLook(isl).fill).toBe("var(--rg-islanded)")
    expect(cellLook(isl).fill).not.toBe("var(--rg-lost)")
    expect(res.action).toBe("reserved")
    expect(shortState(res)).toBe("Reserved")
    expect(nowText(res)).toBe("Reserved for backup")
    expect(cellLook(res).fill).toBe("var(--rg-fleet-reserved)")
    expect(cellLook(res).fill).not.toBe(cellLook(fromScenarioHomes([{ ...flow("c", "charging"), kw: -2 }])[0]).fill)
  })

  it("maps at_floor, below_floor and holding to holding, with the under-floor rule", () => {
    const [at, below, hold] = fromScenarioHomes([flow("a", "at_floor", 30, 30), flow("b", "below_floor", 20, 30), flow("c", "holding")])
    expect([at.action, below.action, hold.action]).toEqual(["holding", "holding", "holding"])
    expect(nowText(below)).toBe("Under its floor, holding")
    expect(cellLook(below).fill).toBe("var(--rg-fleet-under)")
    expect(nowText(at)).toBe("Holding")
  })

  it("says order not confirmed for unconfirmed and Not reported for an unknown state", () => {
    const [unc, odd] = fromScenarioHomes([flow("u", "unconfirmed"), flow("x", "levitating")])
    expect(unc.action).toBe("unconfirmed")
    expect(nowText(unc)).toBe("Order not confirmed")
    expect(cellLook(unc).fill).toBe("var(--rg-not-counted)")
    expect(odd.action).toBeNull()
    expect(shortState(odd)).toBe(NOT_REPORTED)
    expect(nowText(odd)).toBe(NOT_REPORTED)
    expect(cellLook(odd).fill).toBe("var(--rg-not-counted)")
  })

  it("uses a neutral fill for a live home whose floor is not reported", () => {
    const [h] = fromScenarioHomes([{ ...flow("n", "holding"), floor_pct: null as unknown as number }])
    expect(h.floorPct).toBeNull()
    expect(cellLook(h).fill).toBe("var(--rg-not-counted)")
    const [s] = fromScenarioHomes([{ ...flow("s", "selling"), floor_pct: null as unknown as number }])
    expect(cellLook(s).fill).toBe("var(--rg-order-way)")
  })

  it("names homes that are not live, stale or offline", () => {
    expect(otherNote(homes)).toBe("1 unconfirmed, shown under All")
    expect(otherNote(homes.filter((h) => h.status !== "other"))).toBeNull()
  })

  it("shows the server's words on an error", () => {
    expect(errorText(500, { brief: "homes table missing" })).toBe("http 500: homes table missing")
    expect(errorText(422, { detail: "limit too big" })).toBe("http 422: limit too big")
    expect(errorText(502, null)).toBe("http 502")
    expect(errorText(422, { detail: [{ msg: "x" }] })).toBe("http 422")
  })

  it("shows the unconfirmed note next to the filters", () => {
    const html = renderToStaticMarkup(createElement(FleetGridPage, {
      source: "live", homes, loading: false, error: null, sourceNote: "", filter: "all", selectedId: null, foundId: null,
      focusZone: null, query: "", onSource: () => {}, onFilter: () => {}, onSelect: () => {}, onQuery: () => {}, onFind: () => {},
    }))
    expect(html).toContain("1 unconfirmed, shown under All")
  })

  it("returns focus to the tile when the detail panel closes", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    const props = {
      source: "live" as const, homes, loading: false, error: null, sourceNote: "", filter: "all" as const, foundId: null,
      focusZone: null, query: "", onSource: () => {}, onFilter: () => {}, onSelect: () => {}, onQuery: () => {}, onFind: () => {},
    }
    act(() => root.render(createElement(FleetGridPage, { ...props, selectedId: "home-002" })))
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Home detail")
    act(() => root.render(createElement(FleetGridPage, { ...props, selectedId: null })))
    expect(document.activeElement?.getAttribute("data-home")).toBe("home-002")
    act(() => root.unmount())
    host.remove()
  })
})
