import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { createClient } from "../src/api/client"
import { parseHome } from "../src/domain/parse"
import { FleetPage } from "../src/features/fleet/FleetPage"
import { HomePage } from "../src/features/fleet/HomePage"
import { pageVirtualHomes, previewHomes } from "../src/features/fleet/preview-data"
import { FLEET_PAGE_LIMIT, fleetListHref, homesQuery, selectedZoneFromSearch } from "../src/features/fleet/query"
import { isFleetPath } from "../src/pages/route"
import type { FleetPageProps } from "../src/features/fleet/types"
import fixtureHomes from "../src/fixtures/console/homes.json"

const BASE = "http://ops.example/v1"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function page(overrides: Partial<FleetPageProps> = {}): string {
  return renderToStaticMarkup(
    createElement(FleetPage, {
      homes: previewHomes,
      statusFilter: "all",
      zoneFilter: "all",
      query: "",
      offset: 0,
      limit: FLEET_PAGE_LIMIT,
      hasMore: false,
      onFilter: () => undefined,
      onZone: () => undefined,
      onQuery: () => undefined,
      onPage: () => undefined,
      onOpenHome: () => undefined,
      ...overrides,
    }),
  )
}

describe("homes query", () => {
  it("always sends limit and offset and never asks for the bare list", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse([]))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: "op-14" })
    await client.homes()
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe(`${BASE}/homes?limit=50&offset=0`)
  })

  it("sends zone, status, q, limit, and offset", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse([]))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: "op-14" })
    await client.homes({ zone: "North", status: "dead", q: "home-014", limit: 25, offset: 50 })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${BASE}/homes?zone=North&status=dead&q=home-014&limit=25&offset=50`,
    )
  })

  it("caps limit at 200 so a caller cannot request 10k", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse([]))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: "op-14" })
    await client.homes({ limit: 10_000, offset: 0 })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=200")
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("limit=10000")
  })

  it("keeps only the requested page if the body is longer", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(fixtureHomes))
    const client = createClient({ fetch: fetchMock, baseUrl: BASE, operatorId: "op-14" })
    const rows = await client.homes({ limit: 1, offset: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.home_id).toBe("home-001")
    expect(rows[0]?.zone).toBeNull()
  })
})

describe("home zone", () => {
  it("adds zone when present and leaves older fixtures without one", () => {
    const fixture = fixtureHomes[0]
    expect(parseHome(fixture).zone).toBeNull()
    expect(parseHome({ ...fixture, zone: "Houston" }).zone).toBe("Houston")
  })
})

describe("home last reading", () => {
  it("adds charge_state and power_kw when present and leaves older fixtures without them", () => {
    const fixture = fixtureHomes[0]
    const parsed = parseHome(fixture)
    expect(parsed.charge_state).toBeNull()
    expect(parsed.power_kw).toBeNull()
    expect(
      parseHome({ ...fixture, charge_state: "DISCHARGING", power_kw: 2.5 }),
    ).toMatchObject({ charge_state: "DISCHARGING", power_kw: 2.5 })
    expect(parseHome({ ...fixture, charge_state: null, power_kw: null })).toMatchObject({
      charge_state: null,
      power_kw: null,
    })
  })
})

describe("wall selected zone", () => {
  it("defaults the fleet filter to the wall LZ when one is set", () => {
    expect(selectedZoneFromSearch("?zone=North")).toBe("North")
    expect(selectedZoneFromSearch("?event=heather")).toBeNull()
    expect(fleetListHref(null)).toBe("/fleet")
    expect(fleetListHref("North")).toBe("/fleet?zone=North")
    expect(isFleetPath("/fleet")).toBe(true)
    expect(isFleetPath("/fleet/")).toBe(true)
    expect(isFleetPath("/fleet.html")).toBe(true)
    expect(isFleetPath("/")).toBe(false)
    expect(homesQuery({ zone: "North", status: "all", q: "", offset: 0 })).toEqual({
      zone: "North",
      status: undefined,
      q: undefined,
      limit: 50,
      offset: 0,
    })
    const html = page({ zoneFilter: "North" })
    expect(html).toContain("aria-pressed=\"true\">North<")
    expect(html).toContain("Zone <span class=\"fleet-filter-value\">North</span>")
  })
})

describe("fleet list window", () => {
  it("shows zone and soc_kwh in a fixed-height table, one page only", () => {
    const html = page()
    expect(html).toContain("class=\"fleet-scroll\"")
    expect(html).toContain(">Zone<")
    expect(html).toContain(">North<")
    expect(html).toContain("16.4")
    expect(html).toContain("kWh")
    expect(html).toContain("Search home id")
    expect(html).toContain('href="/"')
    expect(html).toContain(">Wall<")
    const rows = pageVirtualHomes({ limit: FLEET_PAGE_LIMIT, offset: 0, total: 10_000 })
    expect(rows).toHaveLength(50)
    expect(rows.some((home) => home.home_id === "home-00051")).toBe(false)
    const windowed = page({ homes: rows, hasMore: true })
    expect(windowed.match(/class="fleet-row"/g)?.length).toBe(50)
    expect(windowed).toContain("Homes 1–50")
    expect(windowed).not.toContain("home-00051")
  })

  it("shows last charge state and power, or an em dash when missing", () => {
    const html = page()
    expect(html).toContain(">Charge state<")
    expect(html).toContain(">Power<")
    expect(html).toContain("DISCHARGING")
    expect(html).toContain("3.5")
    expect(html).toContain("kW")
    const blank = page({
      homes: [{ ...previewHomes[0], charge_state: null, power_kw: null }],
    })
    expect(blank).toContain("—")
    expect(blank).not.toContain("DISCHARGING")
  })
})

describe("home detail last reading", () => {
  it("shows charge state and power on the home page", () => {
    const html = renderToStaticMarkup(
      createElement(HomePage, { home: previewHomes[0], onBack: () => undefined }),
    )
    expect(html).toContain("Charge state")
    expect(html).toContain("DISCHARGING")
    expect(html).toContain("Power")
    expect(html).toContain("3.5")
  })
})
