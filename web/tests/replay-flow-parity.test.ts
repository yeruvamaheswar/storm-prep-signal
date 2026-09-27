import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FlowRequest } from "../src/features/flow/api"
import type { ActiveAlert, Provenance, ScenarioList, SessionState, StartSummary } from "../src/features/flow/types"
import { AboutDataDrawer } from "../src/features/replay/AboutDataDrawer"
import { AlertDetail } from "../src/features/replay/AlertDetail"
import { ScenarioRail } from "../src/features/replay/ScenarioRail"
import { SessionLog } from "../src/features/replay/SessionLog"
import { StartCharge } from "../src/features/replay/StartCharge"
import { ZoneShares } from "../src/features/replay/ZoneShares"

const start: StartSummary = {
  seed: 4242,
  range_pct: [5, 95],
  histogram: [3, 5, 8, 10, 12, 9, 7, 4, 1, 1],
  min_pct: 6.2,
  max_pct: 94.1,
  mean_pct: 48.3,
  below_base_floor: { North: 4, West: 2 },
  base_floor_pct: 20,
  homes: 60,
  pack: { kwh: 13.5, kw: 5 },
}

const alert: ActiveAlert = {
  id: "beryl-hurricane-warning",
  event: "Hurricane Warning",
  headline: "Hurricane Warning issued July 7",
  areaDesc: "Harris; Galveston",
  counties: ["48201", "48167"],
  onset: "2024-07-07T16:00:00-05:00",
  expires: "2024-07-08T19:00:00-05:00",
  source_url: "https://example.org/alert/1",
  source_label: "NWS archive",
  zones: ["Houston"],
  sent_at_tick: 3,
  jev: {
    question: "Is there a threat to the grid in Houston?",
    answer: "yes",
    probability: 0.87,
    model: "jev-system-one",
    called_at: "2026-09-20T10:00:00Z",
    latency_ms: 412,
    input_label: "archived NWS alert text",
  },
}

const provenance: Provenance = {
  tick: 3,
  ts: "2024-07-08T04:10:00-05:00",
  posting: { report: "NP3-233-CD", table: "public.ercot_postings", file: "tapes/risk/beryl-03.json", posted_at: "2024-07-08T04:00:47", rows: 168 },
  rating: { level: "HIGH", peak_mw: 81234, peak_hour: 17, trigger_mw: 79000.4, baseline_mw: 68696, margin_mw: 2234, driving_zone: "Houston" },
  price: { usd_mwh: 31.5, label: "LZ_HOUSTON real-time" },
  zone_prices: { label: "ERCOT real-time settlement point prices", zones: { West: 20, North: 25, South: 30, Houston: 31.5 } },
  target: { mw: 0.4, label: "practice ask" },
  baseline: { file: "tapes/baseline/beryl.json", postings: 720, from: "2024-06-01", to: "2024-06-30" },
  events: {},
  archive_rows: {
    posting: { id: 8822, report: "NP3-233-CD", posted_at: "2024-07-08T04:00:47", file_name: "np3-233.csv" },
    prices: [{ settlement_point: "LZ_HOUSTON", interval_ending: "2024-07-08T04:15:00-05:00", price_usd_mwh: 31.5 }],
    overlay: "Houston feed dropped by hand",
  },
}

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "paused",
    error: null,
    updated_at: "2026-09-26T10:00:00Z",
    scenario: {
      id: "beryl",
      name: "Beryl landfall",
      window: "Jul 7 to Jul 9, 2024",
      summary: "Hurricane Beryl hits Houston.",
      label: "archive replay",
      tape: "tapes/scenarios/beryl-landfall.json",
      baseline: "tapes/baseline/beryl.json",
      alerts: [
        { id: "beryl-hurricane-warning", event: "Hurricane Warning", areaDesc: "Harris; Galveston", zones: ["Houston"] },
        { id: "beryl-flood-watch", event: "Flood Watch", areaDesc: "Fort Bend", zones: ["Houston", "South"] },
      ],
      grid_down_overlay: true,
    },
    seed: 4242,
    speed: 60,
    speeds: [15, 60, 300],
    step_seconds: 5,
    tick_minutes: 5,
    tick_index: 3,
    tick_count: 20,
    start,
    tick: {
      tick: 3,
      ts: "2024-07-08T04:10:00-05:00",
      mode: "HOLD",
      target_mw: 0.4,
      target_label: "practice ask",
      delivered_mw: 0.25,
      missed_mw: 0.15,
      price_usd_mwh: 31.5,
      price_label: "LZ_HOUSTON",
      reserve_pct: 20,
      policy_reason: "normal",
      risk_level: "HIGH",
      intent: "sell",
      intent_reason: "price above floor",
      reasons: ["storm_risk_high", "network_loss"],
      breaches: 1,
      zone_reserve_pct: { West: 20, North: 20, South: 20, Houston: 60 },
      zone_reasons: { West: "normal", North: "normal", South: "normal", Houston: "storm_risk_high" },
      brief: "Houston floor raised to 60% on the ERCOT rule.",
    },
    homes: [],
    zones: {
      West: { selling_mw: 0.05, charging_mw: 0, reserve_pct: 20, reason: "normal", price_usd_mwh: 20, grid_down: false, homes: 15, states: {}, soc_mwh: 0.1 },
      North: { selling_mw: 0.15, charging_mw: 0.02, reserve_pct: 20, reason: "normal", price_usd_mwh: 25, grid_down: false, homes: 15, states: {}, soc_mwh: 0.1 },
      South: { selling_mw: 0.05, charging_mw: 0, reserve_pct: 20, reason: "normal", price_usd_mwh: 30, grid_down: false, homes: 15, states: {}, soc_mwh: 0.1 },
    },
    charging_mw: 0.02,
    provenance,
    alerts: [alert],
    grid_down_zones: ["Houston"],
    history: [],
    totals: null,
    log: [
      { at: "2026-09-26T09:59:00Z", text: "started Beryl landfall" },
      { at: "2026-09-26T09:59:01Z", text: "fleet seeded (seed 4242)" },
      { at: "2026-09-26T10:00:00Z", text: "refused alert: alert already sent" },
    ],
    honest_limits: ["Prices are archive rows."],
    ...overrides,
  }
}

const scenarios: ScenarioList = {
  scenarios: [
    { id: "beryl", name: "Beryl landfall", alerts: [], grid_down_overlay: true },
    { id: "calm", name: "Calm charge", alerts: [] },
  ],
  speeds: [15, 60, 300],
  default_speed: 60,
}

function drawer(state: SessionState): string {
  return renderToStaticMarkup(createElement(AboutDataDrawer, { state, onClose: () => {} }))
}

describe("About this data: scenario section (gap 2)", () => {
  it("shows the scenario window, label, tape, baseline and summary", () => {
    const html = drawer(session())
    expect(html).toContain("Scenario")
    expect(html).toContain("Jul 7 to Jul 9, 2024")
    expect(html).toContain("archive replay")
    expect(html).toContain("tapes/scenarios/beryl-landfall.json")
    expect(html).toContain("tapes/baseline/beryl.json")
    expect(html).toContain("Hurricane Beryl hits Houston.")
  })

  it("says not reported for missing scenario fields instead of inventing them", () => {
    const base = session()
    const html = drawer(session({ scenario: { ...base.scenario!, window: undefined, label: undefined, tape: undefined } }))
    expect(html).toMatch(/Window<\/dt><dd>Not reported/)
    expect(html).toMatch(/Label<\/dt><dd>Not reported/)
    expect(html).toMatch(/Tape<\/dt><dd>Not reported/)
  })
})

describe("Alert detail (gaps 10 and 11)", () => {
  it("shows area, counties, mapped zone, onset, sent tick and the source link", () => {
    const html = renderToStaticMarkup(createElement(AlertDetail, { alert }))
    expect(html).toContain("Harris; Galveston")
    expect(html).toContain("48201, 48167")
    expect(html).toContain("Houston")
    expect(html).toContain("Jul 7, 2024 16:00 CDT")
    expect(html).toMatch(/Sent at tick<\/dt><dd>3/)
    expect(html).toContain('href="https://example.org/alert/1"')
    expect(html).toContain("NWS archive")
  })

  it("shows the full JEV shadow reading and that rules decide the floor", () => {
    const html = renderToStaticMarkup(createElement(AlertDetail, { alert }))
    expect(html).toContain("Is there a threat to the grid in Houston?")
    expect(html).toContain("0.87 (yes)")
    expect(html).toContain("jev-system-one · 412 ms")
    expect(html).toContain("2026-09-20T10:00:00Z")
    expect(html).toContain("archived NWS alert text")
    expect(html).toContain("Rules decide the floor. JEV never dispatches")
  })

  it("marks missing alert fields as not reported and has no link without a source", () => {
    const bare: ActiveAlert = { id: "x", zones: [], sent_at_tick: null, jev: null }
    const html = renderToStaticMarkup(createElement(AlertDetail, { alert: bare }))
    expect(html).toMatch(/Area<\/dt><dd>Not reported/)
    expect(html).toMatch(/Counties \(FIPS\)<\/dt><dd>Not reported/)
    expect(html).toMatch(/Mapped to zone<\/dt><dd>Not reported/)
    expect(html).toMatch(/Source<\/dt><dd>Not reported/)
    expect(html).toContain("After the last tick")
    expect(html).not.toContain("<a ")
    expect(html).toContain("No recorded JEV reading")
  })

  it("is what the drawer shows for each sent alert", () => {
    const html = drawer(session())
    expect(html).toContain("jev-system-one · 412 ms")
    expect(html).toContain("48201, 48167")
  })
})

describe("About this data: provenance rows (gap 13)", () => {
  it("shows the posting table, rows, Supabase id, rule reading, price rows, grid ask and baseline range", () => {
    const html = drawer(session())
    expect(html).toContain("public.ercot_postings")
    expect(html).toMatch(/Rows<\/dt><dd>168/)
    expect(html).toContain("ercot_postings.id 8822 · np3-233.csv")
    expect(html).toContain("HIGH: peak 81,234 MW at HE17 vs trigger 79,000 MW (typical 68,696 MW)")
    expect(html).toContain("ERCOT real-time settlement point prices")
    expect(html).toContain("LZ_HOUSTON 2024-07-08T04:15:00-05:00")
    expect(html).toContain("0.400 MW · practice ask")
    expect(html).toContain("720 postings, 2024-06-01 to 2024-06-30")
  })

  it("says the outage report is missing and the engine fails safe when no posting is on the tick", () => {
    const html = drawer(session({ provenance: { ...provenance, posting: null, rating: null, archive_rows: null, baseline: { file: "b.json" } } }))
    expect(html).toContain("None on this tick: risk unknown, fail safe")
    expect(html).not.toContain("ercot_postings.id")
    expect(html).toMatch(/Baseline postings<\/dt><dd>Not reported/)
  })
})

describe("Starting charge (gap 15)", () => {
  it("labels each bin, colours bins under the base floor and lists the start stats", () => {
    const html = renderToStaticMarkup(createElement(StartCharge, { start }))
    expect(html).toContain("replay-hist-label")
    expect(html).toContain(">0<")
    expect(html).toContain(">90<")
    expect((html.match(/is-under/g) ?? []).length).toBe(2)
    expect(html).toMatch(/Seed<\/dt><dd>4242/)
    expect(html).toContain("uniform 5 to 95% of 13.5 kWh")
    expect(html).toContain("6.2% to 94.1% (mean 48.3%)")
    expect(html).toContain("Under 20% floor")
    expect(html).toContain("West 2 · North 4 · South 0 · Houston 0")
    expect(html).toContain("13.5 kWh · 5 kW (example, not Base specs)")
    expect(html).toContain("Empty to full at 5 kW")
  })

  it("is shown in the drawer", () => {
    expect(drawer(session())).toContain("uniform 5 to 95% of 13.5 kWh")
  })
})

describe("About this data: overlays (gap 16)", () => {
  it("names the tape overlay and grid-down zones as hand-placed", () => {
    const html = drawer(session())
    expect(html).toContain("Overlays (hand-placed)")
    expect(html).toContain("Tick 3: Houston feed dropped by hand")
    expect(html).toContain("Grid down in Houston. Operator overlay, not an archive row.")
  })

  it("says none when there is no overlay", () => {
    const html = drawer(session({ grid_down_zones: [], provenance: { ...provenance, archive_rows: null } }))
    expect(html).toContain("None this tick.")
  })
})

describe("About this data: engine decision (gap 17)", () => {
  it("shows per-zone floors, intent, mode in words, the reasons list, breaches and the brief", () => {
    const html = drawer(session())
    expect(html).toContain("Engine decision this tick")
    expect(html).toMatch(/Houston floor<\/dt><dd>60% · ERCOT outage rule HIGH/)
    expect(html).toContain("sell (price above floor)")
    expect(html).toContain("Hold: the operator paused selling")
    expect(html).toContain("Storm risk high, Network loss")
    expect(html).toMatch(/Breaches<\/dt><dd>1/)
    expect(html).toContain("Houston floor raised to 60% on the ERCOT rule.")
  })

  it("shows an unknown mode code as it came and says no tick yet without one", () => {
    const base = session()
    expect(drawer(session({ tick: { ...base.tick!, mode: "AUTO", reasons: [] } }))).toContain("Automatic")
    expect(drawer(session({ tick: { ...base.tick!, mode: "DRILL" } }))).toMatch(/Mode<\/dt><dd>DRILL/)
    expect(drawer(session({ tick: { ...base.tick!, reasons: [] } }))).toMatch(/Reasons<\/dt><dd>None/)
    expect(drawer(session({ tick: null }))).toContain("No tick played yet.")
  })
})

describe("Session log (gap 18)", () => {
  it("lists the worker's log newest first", () => {
    const html = renderToStaticMarkup(createElement(SessionLog, { log: session().log }))
    const refused = html.indexOf("refused alert")
    const started = html.indexOf("started Beryl landfall")
    expect(refused).toBeGreaterThan(-1)
    expect(started).toBeGreaterThan(refused)
  })

  it("shows each line's worker time as a short UTC clock and keeps the full stamp for machines", () => {
    const html = renderToStaticMarkup(createElement(SessionLog, { log: session().log }))
    expect(html).toContain('dateTime="2026-09-26T10:00:00Z"')
    expect(html).toContain(">Sep 26 10:00:00 UTC<")
    const odd = renderToStaticMarkup(createElement(SessionLog, { log: [{ at: "2026-09-27T05:25:48+00:00", text: "a" }, { at: "later", text: "b" }] }))
    expect(odd).toContain(">Sep 27 05:25:48 UTC<")
    expect(odd).toContain(">later<")
  })

  it("says nothing is logged when the log is empty, and is in the drawer", () => {
    expect(renderToStaticMarkup(createElement(SessionLog, { log: [] }))).toContain("Nothing logged yet.")
    expect(drawer(session())).toContain("fleet seeded (seed 4242)")
  })
})

describe("Zone shares (gap 20)", () => {
  it("shows each zone's confirmed sale, share of fleet and charging", () => {
    const html = renderToStaticMarkup(createElement(ZoneShares, { zones: session().zones }))
    expect(html).toContain("0.150 MW sold")
    expect(html).toContain("60% of fleet")
    expect(html).toContain("0.020 MW charging")
    expect(html).toMatch(/Houston[\s\S]*Not reported/)
  })

  it("says no share when the fleet sold nothing, and is in the drawer", () => {
    const zones = { West: { ...session().zones.West!, selling_mw: 0 } }
    expect(renderToStaticMarkup(createElement(ZoneShares, { zones }))).toContain("No confirmed sale this tick")
    expect(drawer(session())).toContain("60% of fleet")
  })
})

describe("Scenario rail parity (gaps 3, 7, 8, 23)", () => {
  let host: HTMLDivElement
  let root: Root
  let sent: FlowRequest[]

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
    sent = []
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function render(state: SessionState | null) {
    act(() => root.render(createElement(ScenarioRail, {
      scenarios, state, lens: "send", onLens: () => {}, onSend: (request: FlowRequest) => { sent.push(request) },
    })))
  }

  function button(text: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text)
    if (!found) throw new Error(`no button ${text}`)
    return found
  }

  function typeSeed(value: string) {
    const input = host.querySelector<HTMLInputElement>("input[name='seed']")!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    act(() => {
      setter.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }

  it("sends the typed seed with start and with reshuffle, and shows the session seed", () => {
    render(session())
    expect(host.textContent).toContain("Seed in use: 4242")
    typeSeed("77")
    const calm = [...host.querySelectorAll<HTMLButtonElement>(".replay-scenario")].find((b) => b.querySelector(".title")?.textContent === "Calm charge")!
    act(() => calm.click())
    act(() => button("Reshuffle batteries").click())
    expect(sent).toEqual([
      { kind: "start", body: { scenario: "calm", seed: 77 } },
      { kind: "reset", body: { seed: 77 } },
    ])
  })

  it("leaves the seed out when blank so the worker picks one, and disables reshuffle without a scenario", () => {
    render(session())
    act(() => button("Reshuffle batteries").click())
    expect(sent).toEqual([{ kind: "reset", body: {} }])
    render(null)
    expect(button("Reshuffle batteries").disabled).toBe(true)
    expect(host.textContent).not.toContain("Seed in use")
  })

  it("lets the user pick which archived alert the weather step sends", () => {
    render(session({ alerts: [], grid_down_zones: [] }))
    const select = host.querySelector<HTMLSelectElement>("select[name='alert']")!
    expect(select.options.length).toBe(2)
    act(() => {
      select.value = "beryl-flood-watch"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    act(() => button("Alert").click())
    expect(sent).toEqual([{ kind: "alert", body: { alert_id: "beryl-flood-watch" } }])
  })

  it("marks sent alerts and can send a second archived alert", () => {
    render(session({ grid_down_zones: [] }))
    const select = host.querySelector<HTMLSelectElement>("select[name='alert']")!
    const sentOption = [...select.options].find((o) => o.value === "beryl-hurricane-warning")!
    expect(sentOption.disabled).toBe(true)
    expect(sentOption.textContent).toContain("(sent)")
    expect(select.value).toBe("beryl-flood-watch")
    act(() => button("Send this alert").click())
    expect(sent).toEqual([{ kind: "alert", body: { alert_id: "beryl-flood-watch" } }])
  })

  it("offers grid down only when the scenario has the overlay, with the overlay note and down zones", () => {
    render(session())
    expect(host.textContent).toContain("Alert + grid down")
    expect(host.textContent).toContain("Grid down is an operator overlay, not archive data.")
    expect(host.textContent).toContain("Down now: Houston.")
    const base = session()
    render(session({ scenario: { ...base.scenario!, grid_down_overlay: false }, grid_down_zones: [] }))
    expect(host.textContent).toContain("Alert")
    expect(host.textContent).not.toContain("Alert + grid down")
    expect(host.textContent).not.toContain("operator overlay")
  })

  it("shows the worker's tick error", () => {
    render(session({ status: "error", error: "tape row 4 unreadable" }))
    const alertBox = host.querySelector("[role='alert']")
    expect(alertBox?.textContent).toContain("Tick failed: tape row 4 unreadable")
    render(session())
    expect(host.querySelector("[role='alert']")).toBeNull()
  })
})
