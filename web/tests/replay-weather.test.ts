import { describe, expect, it } from "vitest"
import type { FlowTick, FlowZoneRow } from "../src/features/flow/types"
import {
  ISLANDED_TEXT, clipPolygon, cloudBlobs, fleetWeather, isWeatherReason, ringBox, zoneWeather,
} from "../src/features/replay/weatherModel"
import {
  FLOOR_RAISING_REASONS, SIGNAL_MISSING_REASON, WEATHER_REASONS, isFloorRaisingReason,
} from "../src/features/replay/reasonCodes"

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
// beryl-landfall tick 2, after the Beryl tropical storm warning was sent at tick 1 (merged engine with #47, seed 42,
// HOME_MAX_KW=11.4, HOME_KWH=25): JEV said yes for Harris, so only Houston rises. Since #47 the zone floor is its highest
// county floor. (This was a heather-thaw freeze-alert tick; since #47 JEV says no to that alert and Houston stays at 30%.)
const alertTick: TickPart = {
  tick: 2, risk_level: "LOW", reasons: ["charging", "reserve_refill", "homes_stale:1"],
  zone_reserve_pct: { Houston: 60, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "weather_alert", North: "normal", South: "normal", West: "normal" },
  grid_down_zones: [],
}
type CountyTickPart = TickPart & Pick<FlowTick, "county_reserve_pct" | "county_reasons">
// heather tick 2, after both hard-freeze warnings (Harris and Dallas) were sent at tick 1 (same run settings): JEV said no
// for all nine named counties, so every zone keeps the 30% base floor with reason normal.
const jevNoTick: CountyTickPart = {
  tick: 2, risk_level: "LOW", reasons: ["reserve_refill", "homes_stale:2"],
  zone_reserve_pct: { Houston: 30, North: 30, South: 30, West: 30 },
  zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" },
  county_reserve_pct: { 48201: 30, 48157: 30, 48039: 30, 48167: 30, 48339: 30, 48113: 30, 48439: 30, 48085: 30, 48121: 30 },
  county_reasons: {
    48201: "jev_no", 48157: "jev_no", 48039: "jev_no", 48167: "jev_no", 48339: "jev_no",
    48113: "jev_no", 48439: "jev_no", 48085: "jev_no", 48121: "jev_no",
  },
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

// feed-failure tick 73 (2026-09-12 18:00 CT): no NP3-233-CD signal, so the engine fails safe and every zone
// keeps the 60% storm floor with reason signal_unavailable (server/engine/policy.py). A missing feed is not weather.
const signalMissingTick: TickPart = {
  tick: 73, risk_level: null, reasons: ["homes_stale:1", "timed_out:6", "duplicates_ignored:6", "over_delivery:6"],
  zone_reserve_pct: { Houston: 60, North: 60, South: 60, West: 60 },
  zone_reasons: { Houston: "signal_unavailable", North: "signal_unavailable", South: "signal_unavailable", West: "signal_unavailable" },
  grid_down_zones: [],
}
const signalMissingRows: Record<string, RowPart> = Object.fromEntries(
  ["Houston", "North", "South", "West"].map((zone) => [zone, { reserve_pct: 60, reason: "signal_unavailable", grid_down: false }]),
)

const ZONES = ["West", "North", "South", "Houston"] as const
const CALM = { floorRaised: false, weather: false, gridDown: false }

describe("reason codes", () => {
  it("treats the storm rule and weather alerts as weather, and normal or a missing signal as not", () => {
    expect(isWeatherReason("storm_risk_high")).toBe(true)
    expect(isWeatherReason("weather_alert")).toBe(true)
    expect(isWeatherReason("weather_alert:North")).toBe(true)
    expect(isWeatherReason("signal_unavailable")).toBe(false)
    expect(isWeatherReason("storm_reserve")).toBe(false)
    expect(isWeatherReason("some_alert")).toBe(false)
    expect(isWeatherReason("normal")).toBe(false)
    expect(isWeatherReason("")).toBe(false)
    expect(isWeatherReason(undefined)).toBe(false)
  })

  it("keeps the promise panel's floor-raising codes and the weather codes in one module", () => {
    expect([...FLOOR_RAISING_REASONS]).toEqual(["storm_reserve", "signal_unavailable", "weather_alert"])
    expect([...WEATHER_REASONS]).toEqual(["storm_risk_high", "weather_alert"])
    expect(SIGNAL_MISSING_REASON).toBe("signal_unavailable")
    expect(isFloorRaisingReason("signal_unavailable")).toBe(true)
    expect(isFloorRaisingReason("weather_alert:North")).toBe(true)
    expect(isFloorRaisingReason("normal")).toBe(false)
  })
})

describe("zone weather at the playhead's tick", () => {
  it("raises every zone and shows weather on a HIGH risk tick", () => {
    const weather = fleetWeather(ZONES, riskTick as never, {}, 30)
    for (const zone of ZONES) expect(weather[zone]).toEqual({ floorRaised: true, weather: true, gridDown: false })
  })

  it("shows weather only over the alerted zone on a weather-alert tick", () => {
    const weather = fleetWeather(ZONES, alertTick as never, {}, 30)
    expect(weather.Houston).toEqual({ floorRaised: true, weather: true, gridDown: false })
    expect(weather.North).toEqual(CALM)
    expect(weather.South).toEqual(CALM)
    expect(weather.West).toEqual(CALM)
  })

  it("keeps the raised floor but shows no weather when the ERCOT signal is missing", () => {
    const weather = fleetWeather(ZONES, signalMissingTick as never, signalMissingRows as never, 30)
    for (const zone of ZONES) expect(weather[zone]).toEqual({ floorRaised: true, weather: false, gridDown: false })
    // The zone rows alone (no tick) say the same.
    expect(zoneWeather("North", null, signalMissingRows.North as never, 30)).toEqual({ floorRaised: true, weather: false, gridDown: false })
  })

  it("shows no weather where JEV said no to the alert: the base floor was kept (#47)", () => {
    const weather = fleetWeather(ZONES, jevNoTick as never, {}, 30)
    for (const zone of ZONES) expect(weather[zone]).toEqual(CALM)
    expect(zoneWeather("Houston", jevNoTick as never, undefined, 30)).toMatchObject({ weather: false, floorRaised: false })
  })

  it("raises nothing on a calm tick", () => {
    const weather = fleetWeather(ZONES, calmTick as never, {}, 30)
    for (const zone of ZONES) expect(weather[zone]).toEqual(CALM)
  })

  it("reads the base floor from the data, never a fixed 30", () => {
    // Same 60% floors, but a fleet whose base floor is 60: no floor is above base and the reason is normal.
    const tick = { ...alertTick, zone_reasons: { Houston: "normal", North: "normal", South: "normal", West: "normal" } }
    expect(zoneWeather("Houston", tick as never, undefined, 60)).toEqual(CALM)
    expect(zoneWeather("Houston", tick as never, undefined, 30)).toEqual({ floorRaised: true, weather: true, gridDown: false })
  })

  it("shows weather for a weather reason even when the base floor is missing", () => {
    expect(zoneWeather("Houston", alertTick as never, undefined, undefined)).toEqual({ floorRaised: false, weather: true, gridDown: false })
    expect(zoneWeather("North", alertTick as never, undefined, undefined)).toEqual(CALM)
  })

  it("marks only the reported grid-down zone as islanded", () => {
    const weather = fleetWeather(ZONES, gridDownTick as never, gridDownRows as never, 30)
    expect(weather.Houston).toEqual({ floorRaised: false, weather: false, gridDown: true })
    expect(weather.North.gridDown).toBe(false)
  })

  it("falls back to the zone rows of the same tick when the tick has no grid-down list", () => {
    const { grid_down_zones: _omit, ...noList } = gridDownTick
    expect(zoneWeather("Houston", noList as never, gridDownRows.Houston as never, 30).gridDown).toBe(true)
    expect(zoneWeather("North", noList as never, gridDownRows.North as never, 30).gridDown).toBe(false)
  })

  it("shows nothing when the data is missing", () => {
    const weather = fleetWeather(ZONES, null, {}, undefined)
    for (const zone of ZONES) expect(weather[zone]).toEqual(CALM)
    expect(zoneWeather("Houston", { zone_reserve_pct: {}, zone_reasons: {} } as never, undefined, 30)).toEqual(CALM)
  })

  it("uses the zone row when the tick has no floor for that zone", () => {
    const row = { reserve_pct: 60, reason: "weather_alert", grid_down: false }
    expect(zoneWeather("Houston", null, row as never, 30)).toEqual({ floorRaised: true, weather: true, gridDown: false })
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
