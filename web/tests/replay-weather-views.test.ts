import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { FlowHome, FlowTick } from "../src/features/flow/types"
import { MapStage } from "../src/features/replay/MapStage"
import { ReplayPage } from "../src/features/replay/ReplayPage"
import { ZoneBoard } from "../src/features/replay/ZoneBoard"

// Real engine ticks (server/engine/scenario.py Session, base floor 30%); see replay-weather.test.ts.
// beryl-landfall tick 2 after the Beryl alert (JEV yes for Harris; merged engine with #47, seed 42).
const alertTick = {
  tick: 2, risk_level: "LOW", reasons: ["charging", "reserve_refill", "homes_stale:1"],
  zone_reserve_pct: { Houston: 60, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "weather_alert", North: "normal", South: "normal", West: "normal" },
  grid_down_zones: [],
} as unknown as FlowTick
const gridDownTick = {
  tick: 3, risk_level: "LOW", reasons: ["charging", "homes_stale:1", "grid_down:Houston"],
  zone_reserve_pct: { Houston: 30, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  grid_down_zones: ["Houston"],
} as unknown as FlowTick
const calmTick = {
  tick: 1, risk_level: "LOW", reasons: [],
  zone_reserve_pct: { Houston: 30, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  grid_down_zones: [],
} as unknown as FlowTick
// feed-failure tick 73: no ERCOT signal, every zone at the 60% storm floor with reason signal_unavailable.
const signalMissingTick = {
  tick: 73, risk_level: null, reasons: ["homes_stale:1", "timed_out:6", "duplicates_ignored:6", "over_delivery:6"],
  zone_reserve_pct: { Houston: 60, North: 60, South: 60, West: 60 },
  zone_reasons: { Houston: "signal_unavailable", North: "signal_unavailable", South: "signal_unavailable", West: "signal_unavailable" },
  grid_down_zones: [],
} as unknown as FlowTick

const homes: FlowHome[] = ["West", "North", "South", "Houston"].flatMap((zone, z) =>
  Array.from({ length: 3 }, (_, k) => ({
    id: `home-${String(z * 10 + k).padStart(3, "0")}`, zone, soc_pct: 50, kw: 0, state: "holding", status: "live", floor_pct: 30,
  }) as FlowHome))

type W = { floorRaised: boolean; weather: boolean; gridDown: boolean }
const NONE: W = { floorRaised: false, weather: false, gridDown: false }

function board(weather: W | undefined): string {
  return renderToStaticMarkup(createElement(ZoneBoard, {
    zone: "Houston", homes, tSeconds: 0, lens: "send", openHome: null, onHome: () => {}, onBack: () => {}, weather,
  }))
}

describe("zone board weather", () => {
  it("dims the scene and lights the windows only when the zone has weather", () => {
    const raised = board({ floorRaised: true, weather: true, gridDown: false })
    expect(raised).toContain("zone-scene is-weather")
    expect(raised).toContain("var(--rg-window-lit)")
    expect(raised).not.toContain("#9AA8A3")

    const calm = board(NONE)
    expect(calm).not.toContain("is-weather")
    expect(calm).not.toContain("var(--rg-window-lit)")
    expect(calm).toContain("#9AA8A3")

    expect(board(undefined)).not.toContain("is-weather")

    // A floor raised only because the ERCOT signal is missing: no dim, no lit windows.
    const feedDown = board({ floorRaised: true, weather: false, gridDown: false })
    expect(feedDown).not.toContain("is-weather")
    expect(feedDown).not.toContain("var(--rg-window-lit)")
  })

  it("tints an islanded zone and says so", () => {
    const down = board({ ...NONE, gridDown: true })
    expect(down).toContain("is-islanded")
    expect(down).toContain("Islanded: backing up its own homes")
    const up = board(NONE)
    expect(up).not.toContain("is-islanded")
    expect(up).not.toContain("Islanded")
  })

  it("gets the zone's weather from the playhead's tick through the replay page", () => {
    const state = (tick: FlowTick) => ({
      status: "paused", error: null, updated_at: "", scenario: null, seed: 1, speed: 1, speeds: [1], step_seconds: 120, tick_minutes: 5,
      tick_index: 3, tick_count: 10, start: { base_floor_pct: 30 }, tick, homes, orders: {}, zones: {}, charging_mw: 0,
      provenance: null, alerts: [], grid_down_zones: [], history: [], totals: null, log: [], honest_limits: [],
    })
    const page = (tick: FlowTick, zone: string) => renderToStaticMarkup(createElement(ReplayPage, {
      scenarios: null, state: state(tick) as never, nowMs: 0, selectedZone: zone,
    }))
    expect(page(alertTick, "Houston")).toContain("zone-scene is-weather")
    expect(page(alertTick, "North")).not.toContain("is-weather")
    expect(page(gridDownTick, "Houston")).toContain("Islanded: backing up its own homes")
    expect(page(gridDownTick, "North")).not.toContain("Islanded")
    expect(page(signalMissingTick, "Houston")).not.toContain("is-weather")
    expect(page(signalMissingTick, "Houston")).not.toContain("var(--rg-window-lit)")
  })
})

// Leaflet loads with a dynamic import, which can be slow while the whole suite runs in parallel.
describe("map weather", { timeout: 20_000 }, () => {
  let host: HTMLDivElement
  let root: Root

  beforeAll(() => {
    // jsdom has no layout and no SVGSVGElement.createSVGRect; give Leaflet a size and its SVG renderer.
    const proto = window.SVGSVGElement?.prototype as unknown as { createSVGRect?: () => unknown } | undefined
    if (proto && !proto.createSVGRect) proto.createSVGRect = () => ({ x: 0, y: 0, width: 0, height: 0 })
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 1440 } })
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return 836 } })
  })
  afterAll(() => {
    // Back to jsdom's own (inherited) getters.
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
  })

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

  async function mount(tick: FlowTick | null) {
    await act(async () => {
      root.render(createElement(MapStage, {
        zones: {}, homes, tick, baseFloorPct: 30, tSeconds: 0, lens: "send", notice: null, onZone: () => {},
      }))
    })
    // Leaflet loads with a dynamic import; let it settle and project.
    for (let i = 0; i < 400 && !host.querySelector(".replay-chip"); i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
    expect(host.querySelector(".replay-chip")).not.toBeNull()
  }

  it("draws clouds and rain only over the alerted zone", async () => {
    await mount(alertTick)
    const clouds = [...host.querySelectorAll<SVGGElement>(".replay-wx-clouds")].map((el) => el.dataset.zone)
    const rain = [...host.querySelectorAll<HTMLElement>(".replay-wx-rain")].map((el) => el.dataset.zone)
    expect(clouds).toEqual(["Houston"])
    expect(rain).toEqual(["Houston"])
    expect(host.querySelectorAll(".replay-wx-clouds ellipse").length).toBeGreaterThan(0)
    const box = host.querySelector<HTMLElement>(".replay-wx-rain")
    expect(box?.style.clipPath).toMatch(/^polygon\(/)
  })

  it("draws no weather on a calm tick", async () => {
    await mount(calmTick)
    expect(host.querySelector(".replay-wx-clouds")).toBeNull()
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
  })

  it("draws no weather with no tick (a fresh root, projected before asserting)", async () => {
    await mount(null)
    expect(host.querySelector(".replay-wx")).not.toBeNull()
    expect(host.querySelector(".replay-wx-clouds")).toBeNull()
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
  })

  it("keeps the amber raised floor but draws no weather when the ERCOT signal is missing", async () => {
    await mount(signalMissingTick)
    expect(host.querySelector(".replay-wx")).not.toBeNull()
    expect(host.querySelector(".replay-wx-clouds")).toBeNull()
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
    const zones = [...host.querySelectorAll(".replay-zone")]
    expect(zones).toHaveLength(4)
    expect(zones.every((el) => el.classList.contains("is-raised"))).toBe(true)
  })

  it("tints an islanded zone and names it on its chip", async () => {
    await mount(gridDownTick)
    const chips = [...host.querySelectorAll<HTMLButtonElement>(".replay-chip")]
    const houston = chips.find((chip) => chip.textContent?.startsWith("Houston"))
    expect(houston?.textContent).toContain("Islanded: backing up its own homes")
    expect(chips.filter((chip) => chip.textContent?.includes("Islanded"))).toHaveLength(1)
    const tints = [...host.querySelectorAll<HTMLElement>(".replay-wx-islanded")].map((el) => el.dataset.zone)
    expect(tints).toEqual(["Houston"])
    expect(host.querySelector(".replay-wx-rain")).toBeNull()
  })
})
