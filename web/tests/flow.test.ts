import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { OPERATOR_ID, sendRequest } from "../src/features/flow/api"
import { DataPanel } from "../src/features/flow/DataPanel"
import {
  alertCountyRows,
  chargeSpeedCaption,
  compareWithArchive,
  contributionParts,
  countyFloorNote,
  countyGroups,
  currentWeatherStep,
  deliveryShare,
  flowDirection,
  flowStroke,
  fmtScenarioTime,
  jevFloorText,
  weatherStepRequests,
  zoneFloorText,
  zoneShapes,
} from "../src/features/flow/flowMath"
import { WeatherSteps } from "../src/features/flow/FlowControls"
import { GridFlow } from "../src/features/flow/GridFlow"
import type {
  ActiveAlert,
  FlowCounty,
  FlowHome,
  FlowTick,
  FlowZoneRow,
  JevReading,
  Provenance,
  SessionState,
} from "../src/features/flow/types"
import { ZoneBatteries } from "../src/features/flow/ZoneBatteries"
import { ZoneContribution } from "../src/features/flow/ZoneContribution"
import { isFleetPath, isFlowPath } from "../src/pages/route"
import geo from "../../geo/ercot-load-zones.json"

function zoneRow(overrides: Partial<FlowZoneRow> = {}): FlowZoneRow {
  return {
    selling_mw: 0.05, charging_mw: 0, reserve_pct: 30, reason: "normal", price_usd_mwh: 151.69,
    grid_down: false, homes: 25, states: {}, soc_mwh: 0.3, ...overrides,
  }
}

const provenance = {
  tick: 75, ts: "2024-01-15T13:10:00-06:00",
  posting: { report: "NP3-233-CD", table: "hourly_outages", file: "f.json", posted_at: "2024-01-15T13:03:35", rows: 168 },
  rating: { level: "HIGH", peak_mw: 1, peak_hour: 8, trigger_mw: 1, baseline_mw: 1, margin_mw: 0, driving_zone: "North" },
  zone_prices: { label: "recorded ERCOT NP6-905-CD", zones: { Houston: 102.46, North: 102.5, South: 105.4, West: 102.52 } },
} as unknown as Provenance

describe("zone contribution", () => {
  it("groups every home by what it gives the grid, summing to the zone's homes", () => {
    const parts = contributionParts(zoneRow({
      states: { selling: 8, charging: 3, reserved: 4, at_floor: 2, below_floor: 3, holding: 2, stale: 1, dead: 1, islanded: 1 },
    }))
    expect(parts).toEqual({ selling: 8, charging: 3, reserved: 9, idle: 4, down: 1 })
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(25)
  })

  it("gives each zone's share of confirmed delivery, and null when nothing sold", () => {
    const zones = { Houston: zoneRow({ selling_mw: 0.3 }), North: zoneRow({ selling_mw: 0.1 }), West: zoneRow({ selling_mw: 0 }) }
    expect(deliveryShare("Houston", zones)).toBeCloseTo(0.75)
    expect(deliveryShare("West", zones)).toBe(0)
    expect(deliveryShare("Houston", { Houston: zoneRow({ selling_mw: 0 }) })).toBeNull()
  })

  it("labels every MW figure on the bars", () => {
    const html = renderToStaticMarkup(createElement(ZoneContribution, {
      zones: { Houston: zoneRow({ selling_mw: 0.12, charging_mw: 0.04, states: { selling: 20, charging: 5 } }) },
    }))
    expect(html).toContain("sell 0.120 MW confirmed")
    expect(html).toContain("100% of fleet")
    expect(html).toContain("charge 0.040 MW")
    expect(html).toContain("width:80%")
  })
})

describe("data panel overlays", () => {
  function panelState(overlay: string | undefined, gridDown: string[]): SessionState {
    return {
      scenario: null, tick: null, start: {}, alerts: [], grid_down_zones: gridDown, honest_limits: [], log: [],
      provenance: {
        ...provenance, posting: null, rating: null,
        target: { mw: 0.2, label: "synthetic:price-shaped" }, baseline: {},
        archive_rows: overlay ? { overlay } : {},
      },
    } as unknown as SessionState
  }
  const overlays = (html: string) => html.slice(html.indexOf("Overlays (hand-placed)"), html.indexOf("Honest limits"))

  it("names a hand-placed tape overlay in the Overlays section, not only in the archive rows", () => {
    const text = "overlay (hand-placed, not archive): the builder withheld NP3-233-CD postings for this tick"
    const html = renderToStaticMarkup(createElement(DataPanel, { state: panelState(text, []), verify: null }))
    expect(overlays(html)).toContain(text)
    expect(overlays(html)).not.toContain("None this tick")
  })

  it("says none only when the tick has no overlay and no grid down", () => {
    const none = renderToStaticMarkup(createElement(DataPanel, { state: panelState(undefined, []), verify: null }))
    expect(overlays(none)).toContain("None this tick")
    const down = renderToStaticMarkup(createElement(DataPanel, { state: panelState(undefined, ["Houston"]), verify: null }))
    expect(overlays(down)).toContain("Grid down in Houston")
    expect(overlays(down)).not.toContain("None this tick")
  })
})

describe("flow route", () => {
  it("owns /flow without taking /fleet", () => {
    expect(isFlowPath("/flow")).toBe(true)
    expect(isFlowPath("/flow/")).toBe(true)
    expect(isFlowPath("/fleet")).toBe(false)
    expect(isFleetPath("/flow")).toBe(false)
    expect(isFlowPath("/")).toBe(false)
  })
})

describe("flow math", () => {
  it("reads direction from net selling minus charging, and grid down wins", () => {
    expect(flowDirection(zoneRow())).toBe("export")
    expect(flowDirection(zoneRow({ selling_mw: 0, charging_mw: 0.02 }))).toBe("import")
    expect(flowDirection(zoneRow({ selling_mw: 0 }))).toBe("idle")
    expect(flowDirection(zoneRow({ grid_down: true }))).toBe("down")
    expect(flowDirection(undefined)).toBe("idle")
  })

  it("draws more MW thicker and faster, capped at the zone pack limit", () => {
    const low = flowStroke(0.01, 0.285)
    const high = flowStroke(0.2, 0.285)
    expect(high.width).toBeGreaterThan(low.width)
    expect(high.seconds).toBeLessThan(low.seconds)
    expect(flowStroke(5, 0.285)).toEqual(flowStroke(0.285, 0.285))
  })

  it("keeps the tape's own clock and zone", () => {
    expect(fmtScenarioTime("2024-01-15T13:35:00-06:00")).toBe("Jan 15, 2024 13:35 CST")
    expect(fmtScenarioTime("2024-07-08T04:00:00-05:00")).toBe("Jul 8, 2024 04:00 CDT")
  })

  it("compares a home pack with a Supercharger honestly", () => {
    const caption = chargeSpeedCaption(25, 11.4)
    expect(caption).toContain("2 h 12 min")
    expect(caption).toContain("250 kW Supercharger")
    expect(caption).toContain("6 min")
  })

  it("projects the four load zones from the served GeoJSON", () => {
    const shapes = zoneShapes(geo)
    expect(shapes.map((s) => s.zone).sort()).toEqual(["Houston", "North", "South", "West"])
    for (const shape of shapes) {
      expect(shape.path.startsWith("M")).toBe(true)
      expect(shape.centroid[1]).toBeGreaterThan(120)
    }
  })
})

describe("verify against Supabase", () => {
  // Rows read from Supabase for Heather at 13:10 CT (posting 13:03:35, interval ending 13:15).
  const archive = {
    posted_at: "2024-01-15T13:03:35",
    interval_ending: "2024-01-15T13:15:00",
    zone_prices: { Houston: 102.46, North: 102.5, South: 105.4, West: 102.52 },
  }

  it("passes when the posting stamp and every zone price agree", () => {
    const result = compareWithArchive(provenance, archive)
    expect(result.ok).toBe(true)
    expect(result.lines.filter((line) => line.includes("matches"))).toHaveLength(5)
  })

  it("fails loudly on a mismatch or an unreadable archive", () => {
    expect(compareWithArchive(provenance, { ...archive, zone_prices: { ...archive.zone_prices, North: 237.08 } }).ok).toBe(false)
    expect(compareWithArchive(provenance, { ...archive, posted_at: "2024-01-15T12:03:22" }).ok).toBe(false)
    const refused = compareWithArchive(provenance, { error: "archive_unavailable", brief: "Supabase archive: no_config." })
    expect(refused).toEqual({ ok: false, lines: ["Supabase archive: no_config."] })
  })
})

describe("flow requests", () => {
  it("posts to the scenario route with the operator header", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }))
    await sendRequest(fetchFn as unknown as typeof fetch, "", { kind: "alert", body: { alert_id: "heather-harris-wsw" } })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/v1/scenario/alert")
    expect((init.headers as Record<string, string>)["X-Operator-Id"]).toBe(OPERATOR_ID)
  })

  it("surfaces the API brief on refusal", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ brief: "unknown alert" }), { status: 409 }))
    await expect(sendRequest(fetchFn as unknown as typeof fetch, "", { kind: "alert", body: { alert_id: "x" } }))
      .rejects.toThrow("unknown alert")
  })
})

describe("flow views", () => {
  it("animates an exporting zone toward the grid and marks a down zone", () => {
    const html = renderToStaticMarkup(createElement(GridFlow, {
      shapes: zoneShapes(geo),
      zones: { North: zoneRow(), Houston: zoneRow({ grid_down: true }) },
      tick: null, chargingMw: 0, packKw: 11.4, selectedZone: null, onSelect: () => {},
    }))
    expect(html).toContain("flow-line flow-export")
    expect(html).toContain("flow-line flow-down")
    expect(html).toContain("grid down")
  })

  it("names a drained battery as at floor, not holding", () => {
    const homes: FlowHome[] = [
      { id: "h1", zone: "North", soc_pct: 30, kw: 0, state: "at_floor", status: "online", floor_pct: 30 },
      { id: "h2", zone: "North", soc_pct: 80, kw: 3.1, state: "selling", status: "online", floor_pct: 30 },
    ]
    const html = renderToStaticMarkup(createElement(ZoneBatteries, {
      zone: "North", row: zoneRow(), homes, counties: [], alerts: [], stepSeconds: 1, pack: { kwh: 25, kw: 11.4 }, onClose: () => {},
    }))
    expect(html).toContain("At floor, nothing left to sell")
    expect(html).toContain("Selling to grid")
    expect(html).not.toContain(">Holding<")
  })
})

describe("weather step (grid-down overlay)", () => {
  const beryl = { id: "beryl-hurricane-warning", event: "Hurricane Warning", zones: ["Houston"] }
  const sent: ActiveAlert = { ...beryl, sent_at_tick: 3, jev: null }
  function stepState(alerts: ActiveAlert[], down: string[]) {
    return {
      alerts, grid_down_zones: down,
      scenario: { id: "beryl", name: "Hurricane Beryl", alerts: [beryl], grid_down_overlay: true },
    } as unknown as SessionState
  }

  it("reads the step from the worker's state", () => {
    expect(currentWeatherStep(stepState([], []))).toBe("none")
    expect(currentWeatherStep(stepState([sent], []))).toBe("alert")
    expect(currentWeatherStep(stepState([sent], ["Houston"]))).toBe("alert_grid_down")
  })

  it("sends the alert and the grid-down overlay for the alert's zones, with the existing requests", () => {
    expect(weatherStepRequests("alert_grid_down", stepState([], []), beryl.id)).toEqual({
      requests: [
        { kind: "alert", body: { alert_id: beryl.id } },
        { kind: "grid-down", body: { zone: "Houston", down: true } },
      ],
    })
    expect(weatherStepRequests("alert", stepState([sent], ["Houston"]), beryl.id)).toEqual({
      requests: [{ kind: "grid-down", body: { zone: "Houston", down: false } }],
    })
  })

  it("cannot take back a sent alert", () => {
    expect(weatherStepRequests("none", stepState([sent], []), beryl.id)).toHaveProperty("blocked")
    expect(weatherStepRequests("none", stepState([], []), beryl.id)).toEqual({ requests: [] })
  })

  it("says the grid-down line is an operator overlay", () => {
    const html = renderToStaticMarkup(createElement(WeatherSteps, {
      state: stepState([sent], ["Houston"]), alertId: beryl.id, onSend: () => {},
    }))
    expect(html).toContain("Alert + grid down")
    expect(html).toContain("operator overlay, not archive data")
    expect(html).toContain("Down now: Houston")
  })

  it("shows islanded batteries with the overlay banner in a down zone", () => {
    const homes: FlowHome[] = [
      { id: "home-004", zone: "Houston", soc_pct: 70, kw: 0, state: "islanded", status: "live", floor_pct: 30 },
    ]
    const html = renderToStaticMarkup(createElement(ZoneBatteries, {
      zone: "Houston", row: zoneRow({ grid_down: true, selling_mw: 0 }), homes, counties: [], alerts: [], stepSeconds: 1, pack: null, onClose: () => {},
    }))
    expect(html).toContain("Grid down, backing up home")
    expect(html).toContain("they neither sell nor charge")
  })
})

describe("JEV county floor gate", () => {
  const counties: FlowCounty[] = [
    { zone: "Houston", fips: "48201", name: "Harris" },
    { zone: "Houston", fips: "48157", name: "Fort Bend" },
    { zone: "Houston", fips: "48039", name: "Brazoria" },
    { zone: "Houston", fips: "48167", name: "Galveston" },
  ]
  function reading(probability: number): JevReading {
    return {
      question: "q", answer: probability >= 0.5 ? "yes" : "no", probability, model: "jev-1.13.0",
      called_at: "2026-09-27T00:54:29+00:00", latency_ms: 247, input_label: "archived NWS alert",
    }
  }
  function home(id: string, county: string, countyName: string, floor: number, floorReason: string): FlowHome {
    return {
      id, name: `Houston-${countyName.replace(/ /g, "")}-${id.slice(-3)}`, zone: "Houston", county, county_name: countyName,
      floor_reason: floorReason, soc_pct: 70, kw: 0, state: "holding", status: "live", floor_pct: floor,
    }
  }
  // Listed out of roster order on purpose.
  const homes = [
    home("home-005", "48167", "Galveston", 60, "weather_alert_no_jev"),
    home("home-002", "48157", "Fort Bend", 60, "weather_alert_jev_yes"),
    home("home-001", "48201", "Harris", 30, "jev_no"),
    home("home-006", "48201", "Harris", 30, "jev_no"),
  ]
  const freeze: ActiveAlert = {
    id: "heather-harris-hard-freeze-warning", event: "Hard Freeze Warning", zones: ["Houston"], sent_at_tick: 2,
    jev: reading(0.07),
    jev_by_county: {
      "48201": { county_name: "Harris", zone: "Houston", reading: reading(0.07), decision: "keep_base" },
      "48157": { county_name: "Fort Bend", zone: "Houston", reading: reading(0.74), decision: "raise" },
      "48167": { county_name: "Galveston", zone: "Houston", reading: null, decision: "raise_no_reading" },
    },
  }

  it("groups a zone's homes by county in roster order", () => {
    const groups = countyGroups(homes, counties)
    expect(groups.map((g) => g.name)).toEqual(["Harris", "Fort Bend", "Galveston"])
    expect(groups[0].homes.map((h) => h.id)).toEqual(["home-001", "home-006"])
  })

  it("keeps an older worker's homes (no county) in one unnamed group", () => {
    const old: FlowHome[] = [{ id: "home-001", zone: "Houston", soc_pct: 50, kw: 0, state: "holding", status: "live", floor_pct: 30 }]
    expect(countyGroups(old, [])).toEqual([{ fips: "", name: "", homes: old }])
  })

  it("says in plain words why each county's floor sits where it does", () => {
    const [harris, fortBend, galveston] = countyGroups(homes, counties)
    expect(countyFloorNote(fortBend, "weather_alert", [freeze])).toBe("JEV yes 0.74 · floor 60%")
    expect(countyFloorNote(harris, "weather_alert", [freeze])).toBe("JEV no 0.07 · floor 30%")
    expect(countyFloorNote(galveston, "weather_alert", [freeze])).toBe("no JEV reading · floor 60% (fail safe)")
  })

  it("says a county the alert skipped keeps the base floor (Beryl names only Harris)", () => {
    const skipped = countyGroups([home("home-003", "48039", "Brazoria", 30, "not_in_alert")], counties)[0]
    expect(countyFloorNote(skipped, "weather_alert", [freeze])).toBe("floor 30% · County not named by the alert (base floor)")
  })

  it("shows the zone floor as a range when JEV kept some counties at base", () => {
    expect(zoneFloorText(zoneRow({ reason: "weather_alert", reserve_pct: 60 }), homes))
      .toBe("floor 30–60% by county (NWS weather alert)")
    expect(zoneFloorText(zoneRow({ reason: "storm_risk_high", reserve_pct: 60 }), homes.map((h) => ({ ...h, floor_pct: 60 }))))
      .toBe("floor 60% (ERCOT outage rule HIGH)")
  })

  it("lets ERCOT HIGH outrank a county's JEV no", () => {
    const [harris] = countyGroups(homes.map((h) => ({ ...h, floor_pct: 60 })), counties)
    expect(countyFloorNote(harris, "storm_risk_high", [freeze])).toBe("floor 60% · ERCOT outage rule HIGH")
  })

  it("lists an alert's counties in roster order, not numeric FIPS order", () => {
    expect(alertCountyRows(freeze, counties).map((r) => r.fips)).toEqual(["48201", "48157", "48167"])
    expect(alertCountyRows({ ...freeze, jev_by_county: undefined }, counties)).toEqual([])
  })

  it("names the floor each JEV decision gave", () => {
    expect(jevFloorText("raise", 60)).toBe("60%")
    expect(jevFloorText("keep_base", 30)).toBe("30%")
    expect(jevFloorText("raise_no_reading", 60)).toBe("60% (fail safe)")
    expect(jevFloorText("raise_no_reading", undefined)).toBe("storm reserve (fail safe)")
  })

  it("shows county headers and display names in the zone drill-in", () => {
    const html = renderToStaticMarkup(createElement(ZoneBatteries, {
      zone: "Houston", row: zoneRow({ reason: "weather_alert", reserve_pct: 60 }), homes, counties, alerts: [freeze],
      stepSeconds: 1, pack: null, onClose: () => {},
    }))
    expect(html).toContain("<h3>Fort Bend</h3>")
    expect(html).toContain("48157 · JEV yes 0.74 · floor 60%")
    expect(html).toContain('title="Houston-FortBend-002: ')
    expect(html.indexOf("<h3>Harris</h3>")).toBeLessThan(html.indexOf("<h3>Fort Bend</h3>"))
  })

  it("shows the per-county JEV table and the gate rule, not shadow-only copy", () => {
    const tick = { zone_reserve_pct: {}, zone_reasons: {}, reasons: [], county_reserve_pct: { "48201": 30, "48157": 60, "48167": 60 } }
    const state = {
      scenario: null, start: {}, alerts: [freeze], counties, grid_down_zones: [], honest_limits: [], log: [],
      provenance: null, tick: tick as unknown as FlowTick,
    } as unknown as SessionState
    const html = renderToStaticMarkup(createElement(DataPanel, { state, verify: null }))
    expect(html).toContain("<td>Harris</td><td>48201</td><td>0.07</td><td>30%</td>")
    expect(html).toContain("<td>Fort Bend</td><td>48157</td><td>0.74</td><td>60%</td>")
    expect(html).toContain("<td>Galveston</td><td>48167</td><td>no reading</td><td>60% (fail safe)</td>")
    expect(html).toContain("JEV gates the alert floor per county")
    expect(html).not.toContain("shadow only")
    expect(html).not.toContain("never dispatches")
  })
})
