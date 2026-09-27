import { describe, expect, it } from "vitest"
import type { FlowTick, FlowZoneRow } from "../src/features/flow/types"
import {
  ISLANDED_TEXT, clipPolygon, cloudBlobs, fleetWeather, isWeatherReason, ringBox, zoneWeather,
} from "../src/features/replay/weatherModel"

type TickPart = Pick<FlowTick, "tick" | "risk_level" | "reasons" | "zone_reserve_pct" | "zone_reasons" | "grid_down_zones">
type RowPart = Pick<FlowZoneRow, "reserve_pct" | "reason" | "grid_down">

// Real engine ticks, played in-process through server/engine/scenario.py Session (seed 1, base floor 30%).
// storm-rule-high tick 26 (04:05 CT): the 04:00 NP3-233-CD posting rates HIGH, so every zone keeps 60%.
const riskTick: TickPart = {
  tick: 26, risk_level: "HIGH", reasons: ["storm_reserve", "homes_stale:1"],
  zone_reserve_pct: { Houston: 60, North: 60, South: 60, West: 60 },
  zone_reasons: { Houston: "storm_risk_high", North: "storm_risk_high", South: "storm_risk_high", West: "storm_risk_high" },
  grid_down_zones: [],
}
// heather-thaw tick 3, after the Harris hard-freeze warning was sent at tick 2: only Houston rises.
const alertTick: TickPart = {
  tick: 3, risk_level: "LOW", reasons: ["homes_stale:1", "timed_out:1", "duplicates_ignored:1", "over_delivery:1"],
  zone_reserve_pct: { Houston: 60, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "weather_alert", North: "normal", South: "normal", West: "normal" },
  grid_down_zones: [],
}
// storm-rule-high tick 1 (02:00 CT): LOW, every zone at the base floor.
const calmTick: TickPart = {
  tick: 1, risk_level: "LOW", reasons: [],
  zone_reserve_pct: { Houston: 30, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  grid_down_zones: [],
}
// beryl-landfall tick 3 with the grid-down overlay on Houston (sent before tick 2).
const gridDownTick: TickPart = {
  tick: 3, risk_level: "LOW", reasons: ["charging", "homes_stale:1", "grid_down:Houston"],
  zone_reserve_pct: { Houston: 30, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  grid_down_zones: ["Houston"],
}
const gridDownRows: Record<string, RowPart> = {
  Houston: { reserve_pct: 30, reason: "normal", grid_down: true },
  North: { reserve_pct: 30, reason: "normal", grid_down: false },
  South: { reserve_pct: 30, reason: "normal", grid_down: false },
  West: { reserve_pct: 30, reason: "normal", grid_down: false },
}

const ZONES = ["West", "North", "South", "Houston"] as const

describe("weather reason codes", () => {
  it("treats storm, weather and alert reasons as weather, and normal as calm", () => {
    expect(isWeatherReason("storm_risk_high")).toBe(true)
    expect(isWeatherReason("weather_alert")).toBe(true)
    expect(isWeatherReason("weather_alert:North")).toBe(true)
    expect(isWeatherReason("normal")).toBe(false)
    expect(isWeatherReason("")).toBe(false)
    expect(isWeatherReason(undefined)).toBe(false)
  })
})

describe("zone weather at the playhead's tick", () => {
  it("raises every zone on a HIGH risk tick", () => {
    const weather = fleetWeather(ZONES, riskTick as never, {}, 30)
    for (const zone of ZONES) expect(weather[zone]).toEqual({ raised: true, gridDown: false })
  })

  it("raises only the alerted zone on a weather-alert tick", () => {
    const weather = fleetWeather(ZONES, alertTick as never, {}, 30)
    expect(weather.Houston.raised).toBe(true)
    expect(weather.North.raised).toBe(false)
    expect(weather.South.raised).toBe(false)
    expect(weather.West.raised).toBe(false)
  })

  it("raises nothing on a calm tick", () => {
    const weather = fleetWeather(ZONES, calmTick as never, {}, 30)
    for (const zone of ZONES) expect(weather[zone]).toEqual({ raised: false, gridDown: false })
  })

  it("reads the base floor from the data, never a fixed 30", () => {
    // Same 60% floors, but a fleet whose base floor is 60: no floor is above base and the reason is normal.
    const tick = { ...alertTick, zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" } }
    expect(zoneWeather("Houston", tick as never, undefined, 60).raised).toBe(false)
    expect(zoneWeather("Houston", tick as never, undefined, 30).raised).toBe(true)
  })

  it("marks a raising reason even when the base floor is missing", () => {
    expect(zoneWeather("Houston", alertTick as never, undefined, undefined).raised).toBe(true)
    expect(zoneWeather("North", alertTick as never, undefined, undefined).raised).toBe(false)
  })

  it("marks only the reported grid-down zone as islanded", () => {
    const weather = fleetWeather(ZONES, gridDownTick as never, gridDownRows as never, 30)
    expect(weather.Houston).toEqual({ raised: false, gridDown: true })
    expect(weather.North.gridDown).toBe(false)
  })

  it("falls back to the zone rows of the same tick when the tick has no grid-down list", () => {
    const { grid_down_zones: _omit, ...noList } = gridDownTick
    expect(zoneWeather("Houston", noList as never, gridDownRows.Houston as never, 30).gridDown).toBe(true)
    expect(zoneWeather("North", noList as never, gridDownRows.North as never, 30).gridDown).toBe(false)
  })

  it("shows nothing when the data is missing", () => {
    const weather = fleetWeather(ZONES, null, {}, undefined)
    for (const zone of ZONES) expect(weather[zone]).toEqual({ raised: false, gridDown: false })
    expect(zoneWeather("Houston", { zone_reserve_pct: {}, zone_reasons: {} } as never, undefined, 30)).toEqual({ raised: false, gridDown: false })
  })

  it("uses the zone row when the tick has no floor for that zone", () => {
    const row = { reserve_pct: 60, reason: "weather_alert", grid_down: false }
    expect(zoneWeather("Houston", null, row as never, 30).raised).toBe(true)
  })

  it("names the islanded state in plain words", () => {
    expect(ISLANDED_TEXT).toBe("Islanded: backing up its own homes")
  })
})

describe("weather geometry from a zone's projected ring", () => {
  const ring: Array<[number, number]> = [[100, 50], [300, 50], [300, 250], [100, 250]]

  it("boxes the projected ring", () => {
    expect(ringBox(ring)).toEqual({ x: 100, y: 50, w: 200, h: 200 })
    expect(ringBox([])).toBeNull()
    expect(ringBox([[Number.NaN, 1]])).toBeNull()
  })

  it("places cloud blobs inside the zone's box, around its anchor", () => {
    const box = { x: 100, y: 50, w: 200, h: 200 }
    const blobs = cloudBlobs(box, [200, 150])
    expect(blobs.length).toBeGreaterThan(0)
    for (const blob of blobs) {
      expect(blob.cx).toBeGreaterThanOrEqual(box.x)
      expect(blob.cx).toBeLessThanOrEqual(box.x + box.w)
      expect(blob.cy).toBeGreaterThanOrEqual(box.y)
      expect(blob.cy).toBeLessThanOrEqual(box.y + box.h)
      expect(blob.rx).toBeGreaterThan(0)
      expect(blob.ry).toBeGreaterThan(0)
      expect(blob.rx).toBeLessThanOrEqual(box.w / 2)
    }
    expect(blobs[0]).toMatchObject({ cx: 200, cy: 150 })
  })

  it("clips the rain to the zone's shape, relative to its box", () => {
    expect(clipPolygon(ring, { x: 100, y: 50, w: 200, h: 200 })).toBe("polygon(0px 0px, 200px 0px, 200px 200px, 0px 200px)")
  })
})
