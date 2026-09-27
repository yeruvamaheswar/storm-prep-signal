import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { SessionState } from "../src/features/flow/types"
import { alertCounties, countyGeos, rainFips, zoneHasRain, type AlertLike, type ProvenanceLike } from "../src/features/replay/alertWeather"
import { DayBar } from "../src/features/replay/DayBar"
import {
  DAY_STOPS, DEFAULT_DAY_SPEED, PRICE_SPIKE_USD, advanceDayHead, dayMarks, dayPaceLabel, dayPlayheadMs, dayStops, dayWindow,
  hourLabels, initialDayHead, observedSecondsPerTick, paceReadout, posOf, type DayAlert, type DayHead, type DayHistoryPoint,
} from "../src/features/replay/dayModel"
import { daylight, nextSunriseMs, solarElevationDeg } from "../src/features/replay/sun"
import rosterGeo from "../../geo/tx-roster-counties.json"
import { beryl, faults, heatherFreeze, operatorHold, priceSpike, stormHigh, stormNight } from "./fixtures/day14"

const ALL_SPEEDS = [2.4, 4.8, 12, 15, 30, 60, 150, 288, 300, 600, 720, 1440]
const OLD_SPEEDS = [2.4, 4.8, 12, 15, 30, 60, 150, 300, 600]

const hist = (points: unknown) => points as DayHistoryPoint[]
const alertsOf = (alerts: unknown) => alerts as DayAlert[]
const wxAlerts = (alerts: unknown) => alerts as AlertLike[]
const prov = (p: unknown) => p as ProvenanceLike

function session(over: Record<string, unknown> = {}): SessionState {
  return {
    status: "paused", error: null, updated_at: "", scenario: null, seed: 1, speed: 1440, speeds: ALL_SPEEDS,
    step_seconds: 300 / 1440, tick_minutes: 5, tick_index: 3, tick_count: 10, start: { base_floor_pct: 30 }, tick: null, homes: [],
    orders: {}, zones: {}, charging_mw: 0, provenance: null, alerts: [], grid_down_zones: [], history: [], totals: null, log: [],
    honest_limits: [], ...over,
  } as unknown as SessionState
}

function berylSession(over: Record<string, unknown> = {}): SessionState {
  return session({
    scenario: { id: "beryl-landfall", name: "Beryl", alerts: [], first_ts: beryl.first_ts, last_ts: beryl.last_ts },
    tick_index: 22, tick_count: beryl.tick_count, tick: beryl.tick22, history: beryl.history,
    alerts: beryl.alerts, provenance: beryl.provenance22, counties: beryl.counties, ...over,
  })
}

const at = (ts: string) => Date.parse(ts)
const MIN = 60_000
const clock = (ts: string) => ts.slice(11, 16)

describe("sun.ts against the NOAA Solar Calculator", () => {
  // Reference values from NOAA's own calculator code (gml.noaa.gov/grad/solcalc/main.js, calcAzEl with refraction and
  // calcSunriseSet), run 2026-09-27 for these places and times. sun.ts uses the NOAA General Solar Position equations.
  it("gives the solar elevation within half a degree", () => {
    expect(Math.abs(solarElevationDeg(at("2024-07-08T12:00:00-05:00"), 29.76, -95.37) - 69.22)).toBeLessThan(0.5)
    expect(Math.abs(solarElevationDeg(at("2026-09-22T17:30:00-05:00"), 32.0, -102.08) - 27.34)).toBeLessThan(0.5)
    expect(Math.abs(solarElevationDeg(at("2024-01-15T07:00:00-06:00"), 32.78, -96.8) - -6.55)).toBeLessThan(0.5)
  })

  it("finds sunrise within three minutes", () => {
    // NOAA: Houston 2024-07-08 06:27.9 CDT; Dallas 2024-01-15 07:29.8 CST.
    const houston = nextSunriseMs(at("2024-07-08T00:00:00-05:00"), 29.76, -95.37)
    expect(Math.abs((houston ?? 0) - at("2024-07-08T06:27:55-05:00"))).toBeLessThan(3 * MIN)
    const dallas = nextSunriseMs(at("2024-01-15T00:00:00-06:00"), 32.78, -96.8)
    expect(Math.abs((dallas ?? 0) - at("2024-01-15T07:29:47-06:00"))).toBeLessThan(3 * MIN)
  })

  it("names day, twilight and night by the elevation", () => {
    expect(daylight(6)).toBe("day")
    expect(daylight(5.9)).toBe("twilight")
    expect(daylight(-6)).toBe("twilight")
    expect(daylight(-6.1)).toBe("night")
    expect(daylight(69)).toBe("day")
  })

  it("puts Beryl's 22:05 CDT tick in the night over Houston", () => {
    expect(daylight(solarElevationDeg(at(beryl.tick2.ts), 29.76, -95.37))).toBe("night")
  })
})

describe("dayWindow and hourLabels", () => {
  it("spans the tape's first and last ts across midnight (CDT)", () => {
    const w = dayWindow(session({ scenario: { first_ts: stormNight.first_ts, last_ts: stormNight.last_ts } }))
    expect(w).not.toBeNull()
    expect(w?.startMs).toBe(at("2026-09-22T16:00:00-05:00"))
    expect(w?.endMs).toBe(at("2026-09-23T04:00:00-05:00"))
    expect(w?.estimatedEnd).toBe(false)
    const labels = hourLabels(w!)
    expect(labels.map((label) => label.text)).toEqual(["16:00 CDT", "18:00", "20:00", "22:00", "00:00", "02:00", "04:00"])
    expect(labels[0].pos).toBe(0)
    expect(labels.at(-1)?.pos).toBe(1)
    expect(posOf(w!, at("2026-09-22T22:00:00-05:00"))).toBeCloseTo(0.5, 9)
  })

  it("reads CST from a winter tape", () => {
    const w = dayWindow(session({ scenario: { first_ts: heatherFreeze.first_ts, last_ts: heatherFreeze.last_ts } }))
    expect(hourLabels(w!).map((label) => label.text)).toEqual(["07:00 CST", "09:00", "11:00", "13:00", "15:00", "17:00", "19:00"])
  })

  it("estimates the end from the tick count when the worker does not report the window", () => {
    const w = dayWindow(session({ history: operatorHold.history, tick_count: 61, tick_minutes: 5 }))
    expect(w?.startMs).toBe(at("2026-09-17T16:30:00-05:00"))
    expect(w?.endMs).toBe(at("2026-09-17T21:30:00-05:00"))
    expect(w?.estimatedEnd).toBe(true)
  })

  it("is null when nothing reports the window", () => {
    expect(dayWindow(session())).toBeNull()
    expect(dayWindow(null)).toBeNull()
  })

  it("clamps positions to the bar", () => {
    const w = dayWindow(session({ scenario: { first_ts: stormNight.first_ts, last_ts: stormNight.last_ts } }))!
    expect(posOf(w, at("2026-09-22T10:00:00-05:00"))).toBe(0)
    expect(posOf(w, at("2026-09-23T10:00:00-05:00"))).toBe(1)
  })
})

describe("dayMarks from real engine history", () => {
  it("gives operator-hold one HOLD from 16:45 to 18:10", () => {
    const holds = dayMarks(hist(operatorHold.history), []).filter((mark) => mark.kind === "hold")
    expect(holds).toHaveLength(1)
    expect([clock(holds[0].startTs), clock(holds[0].endTs)]).toEqual(["16:45", "18:10"])
    expect([holds[0].firstTick, holds[0].lastTick]).toEqual([4, 21])
    expect(holds[0].label).toContain("HOLD")
  })

  it("names the faults overlays by their own event keys, and never reads timed_out", () => {
    const history = hist(faults.history)
    expect(history.some((point) => (point.reasons ?? []).some((reason) => reason.startsWith("timed_out")))).toBe(true)
    const marks = dayMarks(history, []).filter((mark) => mark.kind === "fault")
    const shown = marks.map((mark) => [mark.label, clock(mark.startTs), clock(mark.endTs), mark.point])
    expect(shown).toEqual([
      ["Overlay: lossy network", "19:00", "20:25", false],
      ["Overlay: homes crash", "19:30", "19:30", true],
      ["Overlay: misreported charge", "20:00", "20:25", false],
      ["Overlay: homes back live", "21:00", "21:00", true],
    ])
    expect(dayMarks(history, []).some((mark) => /timed/i.test(mark.label))).toBe(false)
  })

  it("marks the price spike, the fleet selling on the call, and the missed call on price-spike", () => {
    const marks = dayMarks(hist(priceSpike.history), alertsOf(priceSpike.alerts))
    const price = marks.filter((mark) => mark.kind === "price")
    expect(price.map((mark) => [clock(mark.startTs), clock(mark.endTs)])).toEqual([["17:45", "21:10"]])
    expect(price[0].label).toContain(`$${PRICE_SPIKE_USD}/MWh`)
    expect(price[0].label).toContain("$1016.32/MWh")
    expect(price[0].label).toContain("recorded:ERCOT NP6-905-CD LZ_NORTH")
    const sold = marks.filter((mark) => mark.kind === "call")
    expect(sold.map((mark) => [mark.label, clock(mark.startTs), clock(mark.endTs)])).toEqual([
      ["Fleet sold on the call", "17:45", "19:30"],
      ["Fleet sold on the call", "20:05", "20:40"],
    ])
    const missed = marks.filter((mark) => mark.kind === "missed")
    expect(missed.map((mark) => [clock(mark.startTs), clock(mark.endTs)])).toEqual([["18:00", "22:00"]])
    expect(missed[0].label).toContain("Call missed")
    // The Heat Advisory (post-#50) is an alert mark from tick 1 to its archived expiry at 20:00.
    const alert = marks.filter((mark) => mark.kind === "alert")
    expect(alert.map((mark) => [mark.label, clock(mark.startTs), clock(mark.endTs)])).toEqual([["NWS Heat Advisory", "17:45", "20:00"]])
    // events carry only weather_counties, so homes_dead in the reasons is not read as a fault.
    expect(marks.filter((mark) => mark.kind === "fault")).toEqual([])
  })

  it("starts the Beryl alert mark at sent_at_tick and runs it to the last tick played", () => {
    const alerts = alertsOf(beryl.alerts)
    expect(alerts[0].sent_at_tick).toBe(2)
    const marks = dayMarks(hist(beryl.history), alerts).filter((mark) => mark.kind === "alert")
    expect(marks).toHaveLength(1)
    expect(marks[0].firstTick).toBe(2)
    expect(marks[0].startTs).toBe("2024-07-07T22:05:00-05:00")
    expect(marks[0].endTs).toBe("2024-07-07T23:45:00-05:00")
    expect(marks[0].label).toContain("Tropical Storm Warning")
  })

  it("shows no alert mark before the alert's first tick has played", () => {
    const alerts = alertsOf(beryl.alerts)
    expect(dayMarks(hist(beryl.history).slice(0, 1), alerts).filter((mark) => mark.kind === "alert")).toEqual([])
  })

  it("ends the flash flood alert at its archived expiry", () => {
    const alerts = [{ ...alertsOf(stormNight.alerts)[0], sent_at_tick: 1 }]
    const history = Array.from({ length: 22 }, (_, k) => ({
      tick: k + 1, ts: new Date(at("2026-09-22T16:00:00-05:00") + k * 5 * MIN).toISOString().replace(".000Z", "+00:00"),
      target_mw: 0.2, delivered_mw: 0, charging_mw: 0,
    }))
    const mark = dayMarks(hist(history), alerts).find((m) => m.kind === "alert")
    expect(mark?.endMs).toBe(at("2026-09-22T17:30:00-05:00"))
  })

  it("gives no mark for a field that is missing", () => {
    const bare = hist(priceSpike.history).map((point) => ({
      tick: point.tick, ts: point.ts, target_mw: point.target_mw, delivered_mw: point.delivered_mw, charging_mw: point.charging_mw,
    }))
    expect(dayMarks(hist(bare), [])).toEqual([])
    // An alert with no sent_at_tick gives no mark.
    expect(dayMarks(hist(priceSpike.history), [{ event: "Heat Advisory", sent_at_tick: null }]).filter((m) => m.kind === "alert")).toEqual([])
    // An older worker with no events field: the engine's own homes_dead count is the fallback, never timed_out.
    const older = hist([
      { tick: 1, ts: "2026-09-02T19:00:00-05:00", target_mw: 0.2, delivered_mw: 0.2, charging_mw: 0, reasons: ["timed_out:4"] },
      { tick: 2, ts: "2026-09-02T19:05:00-05:00", target_mw: 0.2, delivered_mw: 0.2, charging_mw: 0, reasons: ["homes_dead:5", "timed_out:4"] },
    ])
    const fallback = dayMarks(older, [])
    expect(fallback.map((mark) => [mark.kind, mark.label, mark.firstTick])).toEqual([["fault", "Homes dead: 5 (engine reason)", 2]])
  })
})

describe("alertCounties (keys of weather_counties, events from named_counties)", () => {
  it("gives nothing for storm-rule-high: the storm rule is not weather over a county", () => {
    expect(alertCounties(prov(stormHigh.provenance26), wxAlerts(stormHigh.alerts))).toEqual([])
  })

  it("gives the Heather freeze counties no map effect", () => {
    const counties = alertCounties(prov(heatherFreeze.provenance2), wxAlerts(heatherFreeze.alerts))
    expect(counties?.length).toBe(9)
    expect(counties?.every((county) => county.effect === "none")).toBe(true)
    expect(counties?.every((county) => county.events.join() === "Hard Freeze Warning")).toBe(true)
    expect(rainFips(counties)).toEqual([])
  })

  it("gives the price-spike Heat Advisory counties no map effect", () => {
    const counties = alertCounties(prov(priceSpike.provenance2), wxAlerts(priceSpike.alerts))
    expect(counties?.map((county) => county.fips)).toEqual(["48085", "48113", "48121", "48439"])
    expect(rainFips(counties)).toEqual([])
  })

  it("rains over Harris only for Beryl", () => {
    const counties = alertCounties(prov(beryl.provenance2), wxAlerts(beryl.alerts))
    expect(counties?.map((county) => [county.fips, county.effect])).toEqual([["48201", "rain"]])
    expect(counties?.[0].events).toEqual(["Tropical Storm Warning"])
  })

  it("rains over Ector and Midland until the flash flood warning expires at 17:30", () => {
    const alerts = wxAlerts(stormNight.alerts)
    expect(rainFips(alertCounties(prov(stormNight.provenance19), alerts))).toEqual(["48135", "48329"])
    expect(alertCounties(prov(stormNight.provenance20), alerts)).toEqual([])
  })

  it("reads the event from the alerts that name the county, never from the weather_counties value", () => {
    // The value says rain, but no active alert names the county: no event, no rain.
    const counties = alertCounties({ tick: 5, ts: "2026-09-22T16:20:00-05:00", events: { weather_counties: { "48201": "Tropical Storm Warning" } } }, [])
    expect(counties).toEqual([{ fips: "48201", effect: "none", events: [] }])
  })

  it("does not rain from an alert that has expired by this tick, even if it names an applied county", () => {
    const flood = wxAlerts(stormNight.alerts)[0]
    const freeze: AlertLike = { event: "Hard Freeze Warning", sent_at_tick: 1, named_counties: [{ fips: "48329" }] }
    const counties = alertCounties(
      { tick: 20, ts: "2026-09-22T17:35:00-05:00", events: { weather_counties: { "48329": "Hard Freeze Warning" } } }, [flood, freeze])
    expect(counties).toEqual([{ fips: "48329", effect: "none", events: ["Hard Freeze Warning"] }])
  })

  it("is null when the tick's provenance is not reported", () => {
    expect(alertCounties(null, [])).toBeNull()
    expect(rainFips(null)).toEqual([])
  })
})

describe("roster county geometry", () => {
  const geos = countyGeos(rosterGeo)

  it("has the 17 roster counties, labeled simplified and sourced", () => {
    expect(geos).toHaveLength(17)
    expect(rosterGeo.label).toBe("simplified")
    expect(rosterGeo.source).toMatch(/census\.gov/)
    expect(geos.find((geo) => geo.fips === "48201")).toMatchObject({ zone: "Houston", name: "Harris" })
    expect(geos.every((geo) => geo.ring.length >= 4)).toBe(true)
  })

  it("finds the rain zone by the roster", () => {
    const roster = geos.map(({ fips, zone }) => ({ fips, zone }))
    expect(zoneHasRain("Houston", ["48201"], roster)).toBe(true)
    expect(zoneHasRain("North", ["48201"], roster)).toBe(false)
    expect(zoneHasRain("West", [], roster)).toBe(false)
  })
})

describe("dayPlayheadMs", () => {
  const ts = "2026-09-22T16:00:00-05:00"
  const step = 300 / 1440
  const obs = (over: Partial<Parameters<typeof advanceDayHead>[1]> = {}) => ({
    tickIndex: 1, tsMs: at(ts), playing: true, stepSeconds: step, tickMinutes: 5, tickLeft: step, nowMs: 1000, ...over,
  })

  it("glides from the tick's ts toward the next tick over one step", () => {
    const head = advanceDayHead(initialDayHead(), obs())
    expect(dayPlayheadMs(head, 1000)).toBe(at(ts))
    expect(dayPlayheadMs(head, 1000 + (step * 1000) / 2)).toBeCloseTo(at(ts) + 2.5 * MIN, 3)
  })

  it("never passes the next tick", () => {
    const head = advanceDayHead(initialDayHead(), obs())
    expect(dayPlayheadMs(head, 1000 + 60_000)).toBe(at(ts) + 5 * MIN)
  })

  it("rests exactly at the tick's ts when paused or finished", () => {
    const paused = advanceDayHead(initialDayHead(), obs({ playing: false, tickLeft: 0.1 }))
    expect(dayPlayheadMs(paused, 50_000)).toBe(at(ts))
    const playing = advanceDayHead(initialDayHead(), obs())
    const stopped = advanceDayHead(playing, obs({ playing: false, nowMs: 1100 }))
    expect(dayPlayheadMs(stopped, 9_000)).toBe(at(ts))
  })

  it("starts mid-tick where the worker's time left puts it", () => {
    const head = advanceDayHead(initialDayHead(), obs({ tickLeft: step / 2 }))
    expect(dayPlayheadMs(head, 1000)).toBeCloseTo(at(ts) + 2.5 * MIN, 3)
  })

  it("never goes backwards while playing, across polls, speed changes and new ticks", () => {
    let head: DayHead = initialDayHead()
    let last = -Infinity
    const seen: number[] = []
    for (let k = 0; k < 40; k += 1) {
      const nowMs = 1000 + k * 60
      const tickIndex = 1 + Math.floor((k * 60) / (step * 1000))
      const tickTs = at(ts) + (tickIndex - 1) * 5 * MIN
      const stepSeconds = k < 20 ? step : step * 2
      head = advanceDayHead(head, obs({ tickIndex, tsMs: tickTs, nowMs, stepSeconds, tickLeft: stepSeconds }))
      const ms = dayPlayheadMs(head, nowMs + 30)!
      seen.push(ms)
      expect(ms).toBeGreaterThanOrEqual(last)
      last = ms
    }
    expect(seen.at(-1)!).toBeGreaterThan(seen[0])
  })

  it("is null with no tick", () => {
    expect(dayPlayheadMs(initialDayHead(), 0)).toBeNull()
  })
})

describe("Day view pace", () => {
  it("labels the presets as minutes per scenario day (1, 2 and 5 min; default 1 min)", () => {
    expect(DAY_STOPS.map((stop) => stop.x)).toEqual([288, 720, 1440])
    expect(DAY_STOPS.map((stop) => dayPaceLabel(stop.x))).toEqual(["5 min per day", "2 min per day", "1 min per day"])
    expect(DEFAULT_DAY_SPEED).toBe(1440)
    expect(dayPaceLabel(600)).toBe("2.4 min per day")
    expect(dayPaceLabel(12)).toBe("2 h per day")
  })

  it("offers only the day stops the session offers, and without them the fastest real speed", () => {
    expect(dayStops(ALL_SPEEDS).map((stop) => stop.x)).toEqual([288, 720, 1440])
    expect(dayStops([12, 720]).map((stop) => stop.x)).toEqual([720])
    // A worker without the Day view speeds: its fastest speed, labeled by its real pace.
    expect(dayStops(OLD_SPEEDS).map((stop) => [stop.x, dayPaceLabel(stop.x)])).toEqual([[600, "2.4 min per day"]])
    expect(dayStops(undefined)).toEqual([])
  })

  it("measures the pace from tick arrivals", () => {
    expect(observedSecondsPerTick([])).toBeNull()
    expect(observedSecondsPerTick([{ tickIndex: 1, atMs: 0 }, { tickIndex: 2, atMs: 250 }])).toBeNull()
    const arrivals = [{ tickIndex: 10, atMs: 0 }, { tickIndex: 14, atMs: 1000 }, { tickIndex: 22, atMs: 3000 }]
    expect(observedSecondsPerTick(arrivals)).toBeCloseTo(0.25, 9)
  })

  it("reports the real pace only when the worker is more than 15% behind", () => {
    const asked = 300 / 1440
    expect(paceReadout(1440, asked * 1.1, 5)).toBeNull()
    expect(paceReadout(1440, asked * 1.15, 5)).toBeNull()
    expect(paceReadout(1440, 0.25, 5)).toBe("Asked 1 min per day; the worker is playing about 1.2 min per day")
    expect(paceReadout(1440, null, 5)).toBeNull()
  })
})

describe("DayBar (unwired component)", () => {
  const bar = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(DayBar, {
    state: berylSession(), unavailable: null, onSend: () => {}, ...props,
  } as never))

  it("shows the tick, the window's hours and the marks that have played, not the order window", () => {
    const html = bar({ playheadMs: at("2024-07-07T23:45:00-05:00") })
    expect(html).not.toContain("0:00 send")
    expect(html).not.toContain("2:00 books close")
    expect(html).toContain("Tick 22 of 193 · Jul 7, 2024 23:45 CDT")
    expect(html).toContain("22:00 CDT")
    // Marks name themselves; they are not seek buttons.
    expect(html).toMatch(/aria-label="NWS Tropical Storm Warning[^"]*"/)
    expect(html).not.toMatch(/<button[^>]*replay-day-mark/)
  })

  it("offers the pace presets with the session's speed pressed", () => {
    const html = bar()
    expect(html).toMatch(/aria-pressed="true"[^>]*>1 min per day</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>2 min per day</)
    expect(html).toMatch(/aria-pressed="false"[^>]*>5 min per day</)
    expect(html).not.toContain("4.8")
  })

  it("says why the presets are off", () => {
    expect(bar({ unavailable: "Speeds not reported" })).toContain("Speeds not reported")
    expect(bar({ unavailable: "Speeds not reported" })).not.toContain("min per day</button>")
  })

  it("says so when the window is not reported", () => {
    expect(bar({ state: session({ tick: beryl.tick22 }) })).toContain("Scenario window not reported")
  })

  it("flags an estimated end", () => {
    const html = bar({ state: berylSession({ scenario: { id: "beryl-landfall", alerts: [] } }) })
    expect(html).toContain("End estimated from the tick count")
  })

  it("shows the honest pace only while playing and more than 15% behind", () => {
    expect(bar({ state: berylSession({ status: "playing" }), observedStepSeconds: 0.25 }))
      .toContain("Asked 1 min per day; the worker is playing about 1.2 min per day")
    expect(bar({ state: berylSession({ status: "playing" }), observedStepSeconds: 0.21 })).not.toContain("the worker is playing")
    expect(bar({ state: berylSession({ status: "paused" }), observedStepSeconds: 0.25 })).not.toContain("the worker is playing")
  })

  it("states the price threshold it uses in the legend", () => {
    expect(bar()).toContain(`$${PRICE_SPIKE_USD}/MWh`)
  })
})
