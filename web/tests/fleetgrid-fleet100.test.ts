// Task 13: one 100-home demo fleet on the Fleet page, an honest source note, the default source,
// and item 7: the 4 regions, each with its own "Split by county" control. Fixtures are real engine output.
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FlowHome } from "../src/features/flow/types"
import { FleetGridPage, type FleetGridPageProps } from "../src/features/fleetgrid/FleetGridPage"
import { FleetGridRoot } from "../src/features/fleetgrid/FleetGridRoot"
import {
  bankTitle, countyGroups, countyTitle, defaultSource, fleetLabel, fromLiveRows, fromScenarioHomes, liveFleetNote,
  readHomesSource, readSplit, scenarioFleetNote, splitSearch, tileAria, toggleSplit, zoneBanks, type CountyRosterRow,
} from "../src/features/fleetgrid/fleetModel"
import { liveCounties, liveHeaders, liveRows, scenarioCounties, scenarioHomes } from "./fixtures/fleet100"

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })
const scenario = fromScenarioHomes(scenarioHomes as FlowHome[])
const live = fromLiveRows(liveRows)

describe("fleet size and source notes", () => {
  it("names the demo fleet from the data, never a fixed 100", () => {
    expect(fleetLabel(100)).toBe("100-home demo fleet")
    expect(fleetLabel(37)).toBe("37-home demo fleet")
  })

  it("reads the /v1/homes source headers", () => {
    expect(readHomesSource(headers(liveHeaders))).toEqual({ source: "supabase", fleetSize: 100, total: 100 })
    expect(readHomesSource(headers({ "x-homes-source": "fixture", "x-fleet-size": "100" })))
      .toEqual({ source: "fixture", fleetSize: 100, total: null })
    expect(readHomesSource(headers({}))).toEqual({ source: null, fleetSize: null, total: null })
    expect(readHomesSource(headers({ "x-homes-source": "mars", "x-fleet-size": "lots" })))
      .toEqual({ source: null, fleetSize: null, total: null })
  })

  it("says Supabase rows are the live fleet, N of FLEET_SIZE", () => {
    expect(liveFleetNote({ source: "supabase", fleetSize: 100, total: 100 }, 100))
      .toBe("100-home demo fleet. Live fleet from Supabase: 100 of 100 homes.")
    expect(liveFleetNote({ source: "supabase", fleetSize: 100, total: 40 }, 40))
      .toBe("100-home demo fleet. Live fleet from Supabase: 40 of 100 homes.")
    // No total header: count what came back.
    expect(liveFleetNote({ source: "supabase", fleetSize: 100, total: null }, 98))
      .toBe("100-home demo fleet. Live fleet from Supabase: 98 of 100 homes.")
  })

  it("says only the first 200 are shown when the page is full (fix 1, M3)", () => {
    // FLEET_SIZE 500: the table has all 500, GET /v1/homes?limit=200 returns 200 of them.
    expect(liveFleetNote({ source: "supabase", fleetSize: 500, total: 500 }, 200))
      .toBe("500-home demo fleet. Live fleet from Supabase: 500 of 500 homes, the first 200 shown.")
    expect(liveFleetNote({ source: "supabase", fleetSize: 500, total: null }, 200))
      .toBe("500-home demo fleet. Live fleet from Supabase: the first 200 homes shown.")
    // Exactly 200 homes, all shown: nothing is hidden, so no caveat.
    expect(liveFleetNote({ source: "supabase", fleetSize: 200, total: 200 }, 200))
      .toBe("200-home demo fleet. Live fleet from Supabase: 200 of 200 homes.")
  })

  it("never calls the fixture fallback live", () => {
    const note = liveFleetNote({ source: "fixture", fleetSize: 100, total: null }, 3)
    expect(note).toBe("3 sample rows (no Supabase connection), not live data.")
    expect(note).not.toMatch(/Live homes/)
    expect(liveFleetNote({ source: "fixture", fleetSize: 100, total: null }, 1))
      .toBe("1 sample row (no Supabase connection), not live data.")
  })

  it("keeps the old note for a server that sends no source header", () => {
    expect(liveFleetNote({ source: null, fleetSize: null, total: null }, 3)).toBe("Live homes from the local API (GET /v1/homes).")
  })

  it("names the scenario fleet by its home count", () => {
    const state = { scenario: { name: "Heather" }, tick_index: 1, tick_count: 181, status: "paused" }
    expect(scenarioFleetNote(state, scenario.length)).toBe("100-home demo fleet. Scenario: Heather, tick 1 of 181, paused.")
    expect(scenarioFleetNote({ scenario: null, tick_index: 0, tick_count: 0, status: "idle" }, 0)).toBe("Scenario: none started yet.")
  })
})

describe("default source", () => {
  it("opens on Scenario when the worker answers, otherwise Live", () => {
    expect(defaultSource({ status: "paused", homes: [] })).toBe("scenario")
    expect(defaultSource({ status: "idle", homes: [] })).toBe("scenario")
    expect(defaultSource({ status: "worker_not_running", brief: "no worker" })).toBe("live")
    expect(defaultSource(null)).toBe("live")
    expect(defaultSource("nope")).toBe("live")
  })
})

describe("counties (item 7)", () => {
  it("reads the county from live rows and scenario homes", () => {
    const h = live.find((x) => x.id === "home-005")!
    expect(h.county).toBe("48029")
    expect(h.countyName).toBe("Bexar")
    const s = scenario.find((x) => x.id === "home-001")!
    expect(s.county).toBe("48201")
    expect(s.countyName).toBe("Harris")
  })

  it("groups a region's homes under every roster county, in roster order", () => {
    const houston = scenario.filter((h) => h.zone === "Houston")
    const groups = countyGroups("Houston", houston, scenarioCounties)
    expect(groups.map((g) => g.name)).toEqual(["Harris", "Fort Bend", "Brazoria", "Galveston", "Montgomery"])
    expect(groups.map((g) => g.fips)).toEqual(["48201", "48157", "48039", "48167", "48339"])
    for (const g of groups) expect(g.homes.every((h) => h.county === g.fips)).toBe(true)
  })

  it("shows a roster county with no homes as 0 homes", () => {
    const roster: CountyRosterRow[] = [...scenarioCounties, { zone: "West", fips: "48999", name: "Nowhere" }]
    const west = countyGroups("West", scenario.filter((h) => h.zone === "West"), roster)
    const empty = west.find((g) => g.fips === "48999")!
    expect(empty.homes).toHaveLength(0)
    expect(countyTitle(empty)).toBe("Nowhere County (48999) · 0 homes")
    expect(countyTitle(west[0])).toBe("Midland County (48329) · 7 homes")
  })

  it("keeps a home with no county in its own group so the counts add up", () => {
    const [noCounty] = fromLiveRows([{ home_id: "home-001", status: "live", zone: "South", capacity_kwh: 25, soc_kwh: 10, county: null }])
    const groups = countyGroups("South", [noCounty], liveCounties)
    const loose = groups.find((g) => g.fips === null)!
    expect(loose.name).toBe("County not reported")
    expect(loose.homes).toHaveLength(1)
    expect(countyTitle(loose)).toBe("County not reported · 1 home")
  })

  it("builds counties from the homes when there is no roster", () => {
    expect(zoneBanks(live).find((b) => b.zone === "South")!.counties.map((c) => c.name).sort())
      .toEqual(["Bexar", "Hidalgo", "Nueces", "Travis"])
  })

  it("names the county in each cell's label", () => {
    const h = scenario.find((x) => x.id === "home-001")!
    expect(tileAria(h)).toMatch(/^home-001, Harris County, /)
  })
})

// Oracle: the running worker's real 100-home split (coordinator, 2026-09-27). Counts come from the rows.
const ORACLE: Record<string, Array<[string, number]>> = {
  Houston: [["Harris", 5], ["Fort Bend", 5], ["Brazoria", 5], ["Galveston", 5], ["Montgomery", 5]],
  North: [["Dallas", 7], ["Tarrant", 6], ["Collin", 6], ["Denton", 6]],
  South: [["Nueces", 7], ["Bexar", 6], ["Travis", 6], ["Hidalgo", 6]],
  West: [["Midland", 7], ["Ector", 6], ["Tom Green", 6], ["Taylor", 6]],
}

describe("the 17-county split of the 100-home fleet", () => {
  for (const [label, homes, roster] of [
    ["scenario", scenario, scenarioCounties],
    ["live", live, liveCounties],
  ] as const) {
    it(`${label}: 4 regions of 25, 17 counties, the engine's even split`, () => {
      const banks = zoneBanks(homes, roster)
      expect(banks.map((b) => b.name)).toEqual(["North", "Houston", "West", "South"])
      let counties = 0
      for (const bank of banks) {
        expect(bank.homes).toHaveLength(25)
        expect(bank.counties.map((c) => [c.name, c.homes.length])).toEqual(ORACLE[bank.name])
        counties += bank.counties.length
      }
      expect(counties).toBe(17)
      expect(bankTitle(banks.find((b) => b.name === "Houston")!)).toBe("Houston · 25 homes · 5 counties")
      expect(bankTitle(banks.find((b) => b.name === "North")!)).toBe("North · 25 homes · 4 counties")
    })
  }
})

describe("split state in the URL", () => {
  it("reads ?split= as known regions only", () => {
    expect([...readSplit("?split=Houston,North")]).toEqual(["Houston", "North"])
    expect([...readSplit("?split=Mars,West")]).toEqual(["West"])
    expect(readSplit("").size).toBe(0)
  })

  it("toggles a region and writes the search, keeping other params", () => {
    const on = toggleSplit(new Set(), "Houston")
    expect([...on]).toEqual(["Houston"])
    expect(toggleSplit(on, "Houston").size).toBe(0)
    expect(splitSearch("?zone=West", new Set(["Houston", "North"]))).toBe("?zone=West&split=North%2CHouston")
    expect(splitSearch("?zone=West&split=Houston", new Set())).toBe("?zone=West")
  })
})

describe("FleetGridPage regions and the county split", () => {
  const props = (over: Partial<FleetGridPageProps>): FleetGridPageProps => ({
    source: "scenario", homes: scenario, loading: false, error: null, sourceNote: "100-home demo fleet. Scenario: Heather",
    filter: "all", selectedId: null, foundId: null, focusZone: null, query: "", counties: scenarioCounties,
    onSource: () => {}, onFilter: () => {}, onSelect: () => {}, onQuery: () => {}, onFind: () => {}, ...over,
  })
  const render = (over: Partial<FleetGridPageProps>) => renderToStaticMarkup(createElement(FleetGridPage, props(over)))
  const region = (html: string, zone: string) => html.split(`aria-label="${zone} zone"`)[1].split("</section>")[0]

  it("collapsed: 4 regions with a title and an off split control, no county blocks", () => {
    const html = render({})
    expect(html).toContain("100-home demo fleet")
    for (const zone of ["North", "Houston", "West", "South"]) expect(html).toContain(`aria-label="${zone} zone"`)
    expect(html).toContain("Houston · 25 homes · 5 counties")
    expect(html).toContain("West · 25 homes · 4 counties")
    expect(html.match(/aria-pressed="false"[^>]*>Split by county</g)).toHaveLength(4)
    expect(html).not.toContain("<h3")
    expect(region(html, "Houston").match(/data-home=/g)).toHaveLength(25)
  })

  it("split: only that region regroups into its county blocks, in roster order", () => {
    const html = render({ split: new Set(["Houston"]) })
    expect(html.match(/aria-pressed="true"[^>]*>Split by county</g)).toHaveLength(1)
    const titles = [...html.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((m) => m[1])
    expect(titles).toEqual([
      "Harris County (48201) · 5 homes", "Fort Bend County (48157) · 5 homes", "Brazoria County (48039) · 5 homes",
      "Galveston County (48167) · 5 homes", "Montgomery County (48339) · 5 homes",
    ])
    expect(html).toContain('aria-label="Harris County, Houston zone"')
    // West stays one block: its cells still name their county, but it has no county sections.
    expect(html).not.toContain('aria-label="Midland County, West zone"')
    expect(html).toContain("Midland County, ")
  })

  it("split all: 17 county blocks", () => {
    const html = render({ split: new Set(["North", "Houston", "West", "South"]) })
    expect(html.match(/<h3/g)).toHaveLength(17)
    expect(html).toContain("Dallas County (48113) · 7 homes")
  })

  it("the split control is a real button wired to its region", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    const seen: string[] = []
    act(() => root.render(createElement(FleetGridPage, props({ onSplit: (zone: string) => seen.push(zone) }))))
    const buttons = Array.from(host.querySelectorAll("button")).filter((b) => b.textContent === "Split by county")
    expect(buttons).toHaveLength(4)
    act(() => buttons[1].click())
    expect(seen).toEqual(["Houston"])
    act(() => root.unmount())
    host.remove()
  })

  it("offers no split when no home or roster names a county", () => {
    const [plain] = fromLiveRows([{ home_id: "home-001", status: "live", zone: "South", capacity_kwh: 25, soc_kwh: 10 }])
    const html = render({ source: "live", homes: [plain], counties: [] })
    expect(html).not.toContain("Split by county")
    expect(html).toContain('data-home="home-001"')
  })
})

describe("source buttons while the source is being picked (fix 1, M5)", () => {
  const sourceButtons = (host: HTMLElement) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[aria-label="Source"] button'))

  it("the page marks no source selected when it has none", () => {
    const host = document.createElement("div")
    host.innerHTML = renderToStaticMarkup(createElement(FleetGridPage, {
      source: null, homes: null, loading: true, error: null, sourceNote: "Choosing a source",
      filter: "all", selectedId: null, foundId: null, focusZone: null, query: "",
      onSource: () => {}, onFilter: () => {}, onSelect: () => {}, onQuery: () => {}, onFind: () => {},
    }))
    const buttons = sourceButtons(host)
    expect(buttons.map((b) => b.textContent)).toEqual(["Live", "Scenario"])
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false"])
    expect(buttons.some((b) => b.classList.contains("on"))).toBe(false)
  })

  it("FleetGridRoot shows Live and Scenario both unselected until the scenario check answers", async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const realFetch = globalThis.fetch
    // The scenario check never answers, so the source stays unpicked.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(FleetGridRoot)))
      const buttons = sourceButtons(host)
      expect(buttons).toHaveLength(2)
      expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false"])
      expect(host.textContent).toContain("Choosing a source")
    } finally {
      act(() => root.unmount())
      host.remove()
      globalThis.fetch = realFetch
    }
  })
})
